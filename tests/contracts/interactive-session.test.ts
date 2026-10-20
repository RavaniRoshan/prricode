/**
 * Contract test for the **interactive session host**.
 *
 * Evidence: the `CC-014b` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`,
 * and `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.4 (Agent loop and tool
 * dispatch), §2.5 (Permissions), §2.6 (Sessions, persistence, and resumption)
 * and §2.10 (The command-line surface).
 *
 * ## What this test pins
 *
 *   - the host **mounts the app**, and the app is a **view** of the host's
 *     state: the props the host hands it are what the test reads;
 *   - a submitted line **runs a turn**, and the turn's **records** reach the
 *     app's `events`;
 *   - a tool call that needs approval **raises the app's approval prompt**,
 *     with the **tool's name** and the **decision's reason**, and the user's
 *     answer **decides the call**: an approval runs it, a denial refuses it;
 *   - the host **re-renders while the turn is in flight** — the prompt is on
 *     the app before the turn has finished, so the bridge cannot deadlock;
 *   - a line beginning with `/provider` or `/catalog` **runs the manager**, and
 *     any other line is a **prompt**;
 *   - the command **defaults the seam**: an interactive run mounts the app
 *     without the caller supplying a `runInteractive` of its own;
 *   - the **fallback**: without a terminal the host refuses rather than
 *     mounting, and it says why.
 *
 * ## How the test drives the host
 *
 * The app is mounted through a **seam**: the host asks a `MountApp` to mount
 * it, and the test supplies a fake that records every set of props the host
 * gave the app. The test therefore needs **no terminal**, and every part of the
 * host's behaviour — the mount, the turn, the records, the approval — is
 * observable.
 *
 * The runtime is the **real** one (`createAgentRuntime`) over a fake driver and
 * a fake tool, so the approval bridge is exercised through the real tool
 * runner rather than through a stand-in for it.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PassThrough, Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { TURN_SOURCE } from '../../src/agent/context.js';
import { createAgentRuntime } from '../../src/agent/loop.js';
import { parseArgs, type ParsedRunArgs } from '../../src/cli/args.js';
import {
  createCommandSession,
  runCommand,
  type CommandSession,
  type SessionFactory,
} from '../../src/cli/command.js';
import {
  runInteractiveSession,
  WORKING_STATUS,
  type InteractiveContext,
  type MountApp,
  type MountedApp,
} from '../../src/cli/interactive.js';
import { EXIT_FAILURE, EXIT_SUCCESS } from '../../src/cli/output.js';
import { createHookRegistry } from '../../src/extensions/hooks/registry.js';
import type { PermissionDecision, ToolContext } from '../../src/permissions/decision.js';
import type {
  ProviderDriver,
  ProviderEvent,
  ProviderRequest,
} from '../../src/provider/drivers/types.js';
import { createSessionStore, type SessionStore } from '../../src/session/store.js';
import { createToolRegistry, type ToolDefinition } from '../../src/tools/registry.js';
import type { AppProps, PendingApproval } from '../../src/ui/app.js';

/* -------------------------------------------------------------------------- */
/* The fixtures                                                                */
/* -------------------------------------------------------------------------- */

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cc014b-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The fake mount: it records every set of props the host gave the app.
 *
 * The fake is the **seam** the plan asks for: the host's app-mounting is
 * injectable, so the test needs no terminal and can read the state the app was
 * rendered with.
 */
class FakeApp implements MountedApp {
  /** Every set of props the host rendered, in order. */
  readonly frames: AppProps[] = [];
  /** Every text the host wrote above the app. */
  readonly outputs: string[] = [];
  /** Whether the host tore the app down. */
  torn = false;

  private readonly waiters: { predicate: (props: AppProps) => boolean; resolve: (props: AppProps) => void }[] =
    [];

  update(props: AppProps): void {
    this.frames.push(props);
    this.settle();
  }

  output(text: string): void {
    this.outputs.push(text);
  }

  unmount(): void {
    this.torn = true;
  }

  /** The most recent frame. */
  get latest(): AppProps {
    const frame = this.frames[this.frames.length - 1];
    if (frame === undefined) throw new Error('the app was never mounted');
    return frame;
  }

  /**
   * Resolve when a frame matches.
   *
   * A frame that **already** matches wins: the test asks for what it wants to
   * see, and the host may well have rendered it before the test asked.
   */
  waitFor(predicate: (props: AppProps) => boolean): Promise<AppProps> {
    for (const frame of this.frames) {
      if (predicate(frame)) return Promise.resolve(frame);
    }
    return new Promise<AppProps>((resolve) => {
      this.waiters.push({ predicate, resolve });
    });
  }

  /** Resolve when the app was mounted. */
  mounted(): Promise<AppProps> {
    return this.waitFor(() => true);
  }

  private settle(): void {
    const frame = this.frames[this.frames.length - 1];
    if (frame === undefined) return;
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(frame)) continue;
      const index = this.waiters.indexOf(waiter);
      if (index >= 0) this.waiters.splice(index, 1);
      waiter.resolve(frame);
    }
  }
}

/** A driver that carries the transport and records the requests it was given. */
interface FakeDriver extends ProviderDriver {
  readonly [TURN_SOURCE]: true;
  send(request: ProviderRequest, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
  readonly requests: ProviderRequest[];
}

function fakeDriver(rounds: ProviderEvent[][], wait?: Promise<void>): FakeDriver {
  const requests: ProviderRequest[] = [];
  return {
    route: 'firstParty',
    requests,
    [TURN_SOURCE]: true,
    async *send(request: ProviderRequest): AsyncIterable<ProviderEvent> {
      const index = requests.length;
      requests.push(request);
      if (index === 0 && wait !== undefined) await wait;
      for (const event of rounds[index] ?? []) yield event;
    },
    buildUrl: () => 'https://api.anthropic.com/v1/messages',
    buildHeaders: () => ({}),
    buildBody: (request: ProviderRequest) => ({ body: request, headers: {} }),
    parseStream: () => ({ events: [], state: {} }),
    parseNonStreaming: () => ({ events: [] }),
    classifyError: (status: number) => ({ message: `HTTP ${status}`, retryable: false }),
    calculateNonstreamingTimeout: () => 1_000,
    betaFlagsFor: (flags: string[]) => flags,
  };
}

/** A tool whose own check asks for approval. */
function askingTool(onExecute: () => void): ToolDefinition {
  const decision: PermissionDecision = {
    behavior: 'ask',
    source: 'unknown',
    reasonType: 'other',
    reason: 'The Echo tool needs approval.',
  };
  return {
    name: 'Echo',
    description: 'the Echo tool',
    inputSchema: { type: 'object', properties: {} },
    mutatesFiles: false,
    checkPermissions: async (): Promise<PermissionDecision> => decision,
    validateInput: async () => ({ ok: true }),
    recheckPermission: async () => ({ decision }),
    execute: async () => {
      onExecute();
      return 'echoed';
    },
  };
}

/** The events of a turn that calls one tool. */
function toolTurn(id: string, name: string, input: unknown): ProviderEvent[] {
  return [
    { type: 'message_start', messageId: 'msg_01', model: 'test-model' },
    { type: 'tool_use', id, name, input },
    { type: 'message_stop', stopReason: 'tool_use' },
  ];
}

/** The events of a turn that ends with a sentence. */
function finalTurn(text: string): ProviderEvent[] {
  return [
    { type: 'message_start', messageId: 'msg_02', model: 'test-model' },
    { type: 'text_delta', text },
    { type: 'message_stop', stopReason: 'end_turn' },
  ];
}

/** The parsed arguments of an interactive run. */
function interactiveArgs(): ParsedRunArgs {
  const parsed = parseArgs([], { isTTY: true });
  if (parsed.kind !== 'run') throw new Error('the parse did not produce a run');
  return parsed;
}

/**
 * Wait until a predicate holds.
 *
 * The host's own steps are awaited by the test through the app's props; the
 * steps that go through **Ink** — the frame on the terminal — are not, so the
 * test waits for them.
 */
async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`the wait for ${what} timed out`);
}

/** A stream that collects what is written to it, and looks like a terminal. */
function terminalStdout(): {
  stream: NodeJS.WritableStream & { isTTY: boolean; columns: number; rows: number };
  text: () => string;
} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      callback();
    },
  }) as unknown as NodeJS.WritableStream & { isTTY: boolean; columns: number; rows: number };
  stream.isTTY = true;
  stream.columns = 80;
  stream.rows = 24;
  return { stream, text: () => chunks.join('') };
}

/**
 * A standard input that looks like a terminal.
 *
 * Ink only reads the input of a stream that is a terminal and can be put into
 * raw mode, so the fake carries both.
 */
function terminalStdin(): PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => unknown;
} {
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => unknown;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  return stdin;
}

/** The harness the host runs in. */
interface Harness {
  /** The fake app. */
  app: FakeApp;
  /** The driver the fake requests are recorded on. */
  driver: FakeDriver;
  /** The store the session's records live in. */
  store: SessionStore;
  /** The configuration directory. */
  configDir: string;
  /** The working directory. */
  cwd: string;
  /** The prompts that reached the model. */
  prompts: () => string[];
  /** The context the host runs with. */
  context: (overrides?: Partial<InteractiveContext>) => InteractiveContext;
}

/**
 * Build the harness.
 *
 * The session factory is the **production wiring** the host relies on: the
 * host hands its approval bridge to the factory through the session context,
 * and the factory hands it to the runtime. The real `createCommandSession`
 * does the same, and the last test uses it.
 */
function harness(options: {
  rounds?: ProviderEvent[][];
  /** The first round waits for this promise. */
  wait?: Promise<void>;
  tool?: ToolDefinition;
  configDir?: string;
  cwd?: string;
} = {}): Harness {
  const configDir = options.configDir ?? makeRoot();
  const cwd = options.cwd ?? makeRoot();
  const store = createSessionStore({ configDir });
  const driver = fakeDriver(options.rounds ?? [], options.wait);
  const app = new FakeApp();

  const factory: SessionFactory = async (context): Promise<CommandSession> => {
    const registry = createToolRegistry();
    if (options.tool !== undefined) registry.register(options.tool);
    const runtime = createAgentRuntime({
      driver,
      registry,
      store: context.store,
      permission: async () => ({
        behavior: 'allow',
        source: 'unknown',
        reasonType: 'other',
      }),
      // **The bridge**: the host's approval seam, handed to the runtime the
      // way `createCommandSession` hands it to the runtime.
      approveAsk: context.approveAsk,
      cwd: context.cwd,
    });
    return { sessionId: context.sessionId, runtime, mode: 'default' };
  };

  return {
    app,
    driver,
    store,
    configDir,
    cwd,
    prompts: () => driver.requests.map((request) => promptOf(request)),
    context: (overrides = {}) => ({
      session: {
        parsed: interactiveArgs(),
        sessionId: 'session-under-test',
        cwd,
        configDir,
        env: {},
        hooks: createHookRegistry(),
        store,
      },
      createSession: factory,
      model: 'test-model',
      isTTY: true,
      mountApp: ((props: AppProps) => {
        app.update(props);
        return app;
      }) satisfies MountApp,
      ...overrides,
    }),
  };
}

/** The text of the last user message of a request. */
function promptOf(request: ProviderRequest): string {
  const last = request.messages[request.messages.length - 1];
  if (last === undefined) return '';
  if (typeof last.content === 'string') return last.content;
  const parts: string[] = [];
  for (const block of last.content) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('');
}

/* -------------------------------------------------------------------------- */
/* The host                                                                    */
/* -------------------------------------------------------------------------- */

describe('the interactive session host', () => {
  it('mounts the app, runs a turn, and shows the turn\'s records', async () => {
    const test = harness({ rounds: [[...finalTurn('Hello there.')]] });
    const controller = new AbortController();

    const host = runInteractiveSession(interactiveArgs(), test.context({ signal: controller.signal }));

    // The app is mounted: the host hands it the state it owns.
    const mounted = await test.app.mounted();
    expect(mounted.events).toEqual([]);
    expect(mounted.input).toBe('');

    // A submitted line runs a turn.
    test.app.latest.onSubmit?.('what is the weather?');

    const shown = await test.app.waitFor((props) =>
      props.events.some((event) => event.t === 'assistant_message'),
    );
    const assistant = shown.events.find((event) => event.t === 'assistant_message');
    expect(assistant).toMatchObject({ t: 'assistant_message', text: 'Hello there.' });
    const prompt = shown.events.find((event) => event.t === 'user_message');
    expect(prompt).toMatchObject({ t: 'user_message', text: 'what is the weather?' });

    controller.abort();
    expect(await host).toBe(EXIT_SUCCESS);
  });

  it('clears the line it was given and shows the line the user types', async () => {
    const test = harness();
    const controller = new AbortController();

    const host = runInteractiveSession(interactiveArgs(), test.context({ signal: controller.signal }));
    await test.app.mounted();

    test.app.latest.onInputChange?.('half a line');
    await test.app.waitFor((props) => props.input === 'half a line');

    controller.abort();
    await host;
  });

  it('refuses to start when the app cannot mount', async () => {
    const test = harness();
    const stderr: string[] = [];

    const code = await runInteractiveSession(
      interactiveArgs(),
      test.context({ isTTY: false, stderr: { write: (chunk: string) => stderr.push(chunk) } }),
    );

    expect(code).toBe(EXIT_FAILURE);
    expect(stderr.join('')).toContain('terminal');
    // The app was never mounted.
    expect(test.app.frames).toEqual([]);
  });

  it("refuses a line submitted while a turn is running", async () => {
    // The host runs **one turn at a time**: two turns on one session at once
    // would interleave their records in the transcript.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const test = harness({ rounds: [[...finalTurn('Hello there.')]], wait: gate });
    const controller = new AbortController();

    const host = runInteractiveSession(interactiveArgs(), test.context({ signal: controller.signal }));
    await test.app.mounted();

    // The first line starts a turn that waits.
    test.app.latest.onSubmit?.('the first line');
    await test.app.waitFor((props) => props.status === WORKING_STATUS);
    await waitUntil(() => test.prompts().length === 1, 'the provider request');

    // The second line is refused while the turn runs.
    test.app.latest.onSubmit?.('the second line');
    await test.app.waitFor((props) => props.status !== WORKING_STATUS);
    expect(test.app.latest.status).toContain('working');

    // The second line never reached the model.
    expect(test.prompts()).toEqual(['the first line']);

    release?.();
    await test.app.waitFor((props) => props.events.some((event) => event.t === 'assistant_message'));

    controller.abort();
    await host;
  });

  it("mounts this implementation's own app when the caller supplies no seam", async () => {
    // The **real** app, through the real mount: the terminal UI is loaded on
    // demand, the line the user types reaches the app, and the answer reaches
    // the terminal.
    const test = harness({ rounds: [[...finalTurn('Hello there.')]] });
    const controller = new AbortController();
    const out = terminalStdout();
    const stdin = terminalStdin();
    const err = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    const host = runInteractiveSession(
      interactiveArgs(),
      test.context({
        signal: controller.signal,
        isTTY: true,
        // The **real** mount: no seam at all.
        mountApp: undefined,
        renderOptions: {
          stdout: out.stream,
          stdin,
          stderr: err,
          debug: true,
          patchConsole: false,
        },
      }),
    );

    // The line the user types is echoed by the app.
    stdin.write('hello there');
    await waitUntil(() => out.text().includes('hello there'), "the app's echo");

    // The line the user submits runs a turn, and the answer reaches the
    // terminal. A terminal's **Enter** is a carriage return.
    stdin.write('\r');
    await waitUntil(() => out.text().includes('Hello there.'), "the app's answer");

    controller.abort();
    expect(await host).toBe(EXIT_SUCCESS);
  });
});

/* -------------------------------------------------------------------------- */
/* The approval bridge                                                         */
/* -------------------------------------------------------------------------- */

describe('the approval bridge', () => {
  it('raises the prompt with the tool\'s name and the reason, and the answer runs the call', async () => {
    let executed = 0;
    const test = harness({
      rounds: [[...toolTurn('call-1', 'Echo', { text: 'hi' })]],
      tool: askingTool(() => {
        executed += 1;
      }),
    });
    const controller = new AbortController();

    const host = runInteractiveSession(interactiveArgs(), test.context({ signal: controller.signal }));
    await test.app.mounted();

    test.app.latest.onSubmit?.('echo hi');

    // The prompt is raised **while the turn is in flight**: the turn has not
    // finished, and the app already carries the question.
    const raised = await test.app.waitFor((props) => props.approval !== undefined);
    const approval = raised.approval as PendingApproval;
    expect(approval.toolName).toBe('Echo');
    expect(approval.decision.behavior).toBe('ask');
    expect(approval.decision.reason).toBe('The Echo tool needs approval.');

    // The turn is still waiting: nothing has run yet.
    expect(executed).toBe(0);

    // The user's answer decides the call.
    test.app.latest.onApproval?.('yes');
    await test.app.waitFor((props) =>
      props.events.some((event) => event.t === 'tool_result'),
    );

    expect(executed).toBe(1);
    // The prompt is gone once it is answered.
    expect(test.app.latest.approval).toBeUndefined();

    controller.abort();
    expect(await host).toBe(EXIT_SUCCESS);
  });

  it('refuses the call when the user denies it', async () => {
    let executed = 0;
    const test = harness({
      rounds: [[...toolTurn('call-1', 'Echo', { text: 'hi' })]],
      tool: askingTool(() => {
        executed += 1;
      }),
    });
    const controller = new AbortController();

    const host = runInteractiveSession(interactiveArgs(), test.context({ signal: controller.signal }));
    await test.app.mounted();

    test.app.latest.onSubmit?.('echo hi');
    await test.app.waitFor((props) => props.approval !== undefined);

    test.app.latest.onApproval?.('no');
    const refused = await test.app.waitFor((props) =>
      props.events.some((event) => event.t === 'tool_result'),
    );

    // A denial is a denial: the call did not run.
    expect(executed).toBe(0);
    const result = refused.events.find((event) => event.t === 'tool_result');
    expect(result).toMatchObject({ t: 'tool_result' });
    if (result?.t !== 'tool_result') throw new Error('the tool result is missing');
    expect(result.envelope.isError).toBe(true);

    controller.abort();
    await host;
  });

  it("keeps the rule the 'don't ask again' answer promises", async () => {
    let executed = 0;
    const test = harness({
      rounds: [[...toolTurn('call-1', 'Echo', { file_path: '/work/a.txt' })]],
      tool: askingTool(() => {
        executed += 1;
      }),
    });
    const controller = new AbortController();

    const host = runInteractiveSession(interactiveArgs(), test.context({ signal: controller.signal }));
    await test.app.mounted();

    test.app.latest.onSubmit?.('write the file');
    await test.app.waitFor((props) => props.approval !== undefined);
    test.app.latest.onApproval?.('yes-always');
    await test.app.waitFor((props) =>
      props.events.some((event) => event.t === 'tool_result'),
    );

    expect(executed).toBe(1);

    // The rule is the permission layer's own, and it is kept in the
    // repository's local settings file.
    const settings = JSON.parse(
      readFileSync(path.join(test.cwd, '.claude', 'settings.local.json'), 'utf8'),
    ) as { permissions: { allow: string[] } };
    expect(settings.permissions.allow).toContain('Echo(/work/a.txt)');

    controller.abort();
    await host;
  });
});

/* -------------------------------------------------------------------------- */
/* The slash command                                                           */
/* -------------------------------------------------------------------------- */

describe('the slash command', () => {
  it('runs the manager for a /provider line and sends any other line to the model', async () => {
    const test = harness({ rounds: [[...finalTurn('Hello there.')]] });
    // The manager's state: one connection the listing can name.
    writeFileSync(
      path.join(test.configDir, 'providers.json'),
      JSON.stringify({
        version: 1,
        connections: [
          {
            id: 'prod',
            name: 'Production',
            route: 'firstParty',
            credential: { kind: 'env', name: 'PROD_KEY' },
            catalogSource: 'builtin',
            enabled: true,
          },
        ],
        catalogs: [],
      }),
    );
    const controller = new AbortController();

    const host = runInteractiveSession(interactiveArgs(), test.context({ signal: controller.signal }));
    await test.app.mounted();

    // A manager line runs the manager: it does **not** reach the model.
    test.app.latest.onSubmit?.('/provider list');
    await test.app.waitFor(() => test.app.outputs.length > 0);
    expect(test.app.outputs.join('\n')).toContain('prod');
    expect(test.prompts()).toEqual([]);

    // Any other line is a prompt.
    test.app.latest.onSubmit?.('/help');
    await test.app.waitFor((props) =>
      props.events.some((event) => event.t === 'assistant_message'),
    );
    expect(test.prompts()).toEqual(['/help']);

    controller.abort();
    await host;
  });
});

/* -------------------------------------------------------------------------- */
/* The seam the command defaults                                                */
/* -------------------------------------------------------------------------- */

describe('the command\'s default seam', () => {
  it('mounts the app for an interactive run without a caller-supplied seam', async () => {
    const test = harness({ rounds: [[...finalTurn('Hello there.')]] });
    const controller = new AbortController();

    const running = runCommand(interactiveArgs(), {
      cwd: test.cwd,
      configDir: test.configDir,
      env: {},
      isTTY: true,
      stdout: { write: () => true },
      stderr: { write: () => true },
      createSession: async (context) => {
        const registry = createToolRegistry();
        const runtime = createAgentRuntime({
          driver: test.driver,
          registry,
          store: context.store,
          permission: async () => ({
            behavior: 'allow',
            source: 'unknown',
            reasonType: 'other',
          }),
          approveAsk: context.approveAsk,
          cwd: context.cwd,
        });
        return { sessionId: context.sessionId, runtime, mode: 'default' };
      },
      mountApp: ((props: AppProps) => {
        test.app.update(props);
        return test.app;
      }) satisfies MountApp,
      signal: controller.signal,
    });

    await test.app.mounted();
    test.app.latest.onSubmit?.('hello');
    await test.app.waitFor((props) =>
      props.events.some((event) => event.t === 'assistant_message'),
    );

    controller.abort();
    expect(await running).toBe(EXIT_SUCCESS);
  });

  it('uses the caller\'s own seam when one is supplied', async () => {
    const test = harness();
    let seen: ParsedRunArgs | undefined;

    const code = await runCommand(interactiveArgs(), {
      cwd: test.cwd,
      configDir: test.configDir,
      env: {},
      isTTY: true,
      stdout: { write: () => true },
      stderr: { write: () => true },
      runInteractive: async (parsed) => {
        seen = parsed;
        return EXIT_SUCCESS;
      },
    });

    expect(code).toBe(EXIT_SUCCESS);
    expect(seen?.kind).toBe('run');
    // The app was never mounted: the caller's seam ran instead.
    expect(test.app.frames).toEqual([]);
  });

  it('builds the same session the headless path builds', async () => {
    // The production factory: the host's approval bridge reaches the runtime
    // through the session context, exactly as the headless path's session does.
    const test = harness();
    const session = await createCommandSession({
      parsed: interactiveArgs(),
      sessionId: 'session-under-test',
      cwd: test.cwd,
      configDir: test.configDir,
      env: {},
      hooks: { for: () => [] } as never,
      store: test.store,
    });

    expect(session.sessionId).toBe('session-under-test');
    expect(session.mode).toBe('auto');
  });
});

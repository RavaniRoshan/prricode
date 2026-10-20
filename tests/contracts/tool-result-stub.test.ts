/**
 * Contract test for the **within-turn** tool-result stub.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.6 (Sessions,
 * persistence, and resumption) and §2.4 (Agent loop and tool dispatch), and the
 * `CC-009c` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## What this test pins
 *
 * The content-replacement mechanism exists so that an oversized tool result
 * does **not** come back into the **context**. The `CC-009b` fix round closed
 * the gap on the two **projection** paths — the between-turns load and the
 * cross-turn projection — but the **within-turn** push in `src/agent/loop.ts`
 * still carried the raw envelope, so a 256 KiB+ tool result reached the model
 * **in the turn the tool ran**, which is the turn it matters most in.
 *
 * The test therefore pins:
 *
 *   1. The **within-turn** request carries the **stub**, never the payload, for
 *      a tool result that is over the limit.
 *   2. The **payload is still in the transcript**: the transcript keeps the
 *      data, and a content-replacement record stands beside it.
 *   3. A tool result that is **under** the limit is carried as it is.
 *   4. The **three paths agree**: the within-turn block, the between-turns
 *      load and the cross-turn projection produce the **same** stubbed
 *      content, and none of them carries the payload.
 *   5. There is **one** stub rule: `contentReplacementStub` is defined once,
 *      the store's content-replacement record uses it, and the within-turn push
 *      uses it too.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { TURN_SOURCE, conversationFromEvents } from '../../src/agent/context.js';
import { createAgentRuntime, type AgentRuntime } from '../../src/agent/loop.js';
import type { PermissionDecision } from '../../src/permissions/decision.js';
import type {
  ProviderDriver,
  ProviderEvent,
  ProviderMessage,
  ProviderRequest,
} from '../../src/provider/drivers/types.js';
import type { SessionEvent, ToolResultStub } from '../../src/session/event.js';
import {
  DEFAULT_MAX_TOOL_RESULT_BYTES,
  contentReplacementStub,
  createSessionStore,
  serializedSize,
  type SessionStore,
} from '../../src/session/store.js';
import { contextToProviderMessages, resumeEvents } from '../../src/session/resume.js';
import { createToolRegistry, type ToolDefinition } from '../../src/tools/registry.js';

/* -------------------------------------------------------------------------- */
/* The fixtures                                                                */
/* -------------------------------------------------------------------------- */

const CWD = '/work/project';
const SESSION_ID = 'session-01';

/** The payload of an oversized tool result: 4096 bytes of `x`. */
const PAYLOAD = 'x'.repeat(4096);

/** The limit the harness's store is built with. */
const LIMIT = 128;

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cc009c-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

/** A fake driver that also carries the transport. */
interface FakeDriver extends ProviderDriver {
  /** The marker that declares the driver the turn's transport. */
  readonly [TURN_SOURCE]: true;
  /** The transport seam: the driver sends the request. */
  send(request: ProviderRequest, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
  /** The requests the driver was given. */
  readonly requests: ProviderRequest[];
}

function fakeDriver(rounds: ProviderEvent[][]): FakeDriver {
  const requests: ProviderRequest[] = [];

  return {
    route: 'firstParty',
    requests,
    [TURN_SOURCE]: true,
    async *send(request: ProviderRequest): AsyncIterable<ProviderEvent> {
      const index = requests.length;
      requests.push(request);
      const round = rounds[index];
      if (round === undefined) return;
      for (const event of round) yield event;
    },
    buildUrl: () => 'https://api.anthropic.com/v1/messages',
    buildHeaders: () => ({}),
    buildBody: (req: ProviderRequest) => ({ body: req, headers: {} }),
    parseStream: () => ({ events: [], state: {} }),
    parseNonStreaming: () => ({ events: [] }),
    classifyError: (status: number) => ({ message: `HTTP ${status}`, retryable: false }),
    calculateNonstreamingTimeout: () => 1_000,
    betaFlagsFor: (flags: string[]) => flags,
  };
}

/** A tool that returns a fixed output. */
function fakeTool(name: string, output: unknown): ToolDefinition {
  return {
    name,
    description: `the ${name} tool`,
    inputSchema: { type: 'object', properties: {} },
    mutatesFiles: false,
    checkPermissions: async (): Promise<PermissionDecision | undefined> => undefined,
    validateInput: async () => ({ ok: true }),
    recheckPermission: async () => ({ decision: undefined }),
    execute: async () => output,
  };
}

const allowAll = async (): Promise<PermissionDecision> => ({
  behavior: 'allow',
  source: 'unknown',
  reasonType: 'other',
});

/** The harness under test. */
interface Harness {
  /** The runtime the turn runs on. */
  runtime: AgentRuntime;
  /** The store the turn's records are appended to. */
  store: SessionStore;
  /** The driver the requests are recorded by. */
  driver: FakeDriver;
}

function harness(options: { output: unknown; limit?: number }): Harness {
  const store = createSessionStore({
    configDir: makeRoot(),
    maxToolResultBytes: options.limit ?? LIMIT,
  });
  const registry = createToolRegistry();
  registry.register(fakeTool('Read', options.output));

  const driver = fakeDriver([
    [
      { type: 'message_start', messageId: 'msg_01', model: 'test-model' },
      { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { path: 'a.txt' } },
      { type: 'message_stop', stopReason: 'tool_use' },
    ],
    [
      { type: 'message_start', messageId: 'msg_02', model: 'test-model' },
      { type: 'message_stop', stopReason: 'end_turn' },
    ],
  ]);

  const runtime = createAgentRuntime({
    driver,
    registry,
    store,
    permission: allowAll,
    cwd: CWD,
  });

  return { runtime, store, driver };
}

/** The turn the harness runs. */
const turn = { prompt: 'read the file', sessionId: SESSION_ID, model: 'test-model' };

/* -------------------------------------------------------------------------- */
/* Reading the results                                                         */
/* -------------------------------------------------------------------------- */

/** The tool-result blocks of a set of provider messages. */
function toolResultBlocks(messages: ProviderMessage[]): {
  toolUseId: string;
  content: unknown;
  isError: boolean;
}[] {
  const blocks: { toolUseId: string; content: unknown; isError: boolean }[] = [];
  for (const message of messages) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      blocks.push({
        toolUseId: block.tool_use_id,
        content: block.content,
        isError: block.is_error === true,
      });
    }
  }
  return blocks;
}

/** The one tool-result block of a set of provider messages. */
function onlyToolResult(messages: ProviderMessage[]): {
  toolUseId: string;
  content: unknown;
  isError: boolean;
} {
  const blocks = toolResultBlocks(messages);
  expect(blocks).toHaveLength(1);
  const block = blocks[0];
  if (block === undefined) throw new Error('expected exactly one tool_result block');
  return block;
}

/** The records of the harness's transcript. */
async function transcriptOf(store: SessionStore): Promise<SessionEvent[]> {
  const handle = await store.create({ cwd: CWD, sessionId: SESSION_ID });
  const events: SessionEvent[] = [];
  for await (const event of store.read(handle)) events.push(event);
  return events;
}

/** The raw text of the harness's transcript. */
async function rawTranscriptOf(store: SessionStore): Promise<string> {
  const summaries = await store.list({ cwd: CWD });
  const filePath = summaries[0]?.path;
  if (filePath === undefined) throw new Error('expected a transcript');
  return readFileSync(filePath, 'utf8');
}

/* -------------------------------------------------------------------------- */
/* Reading the source tree                                                     */
/* -------------------------------------------------------------------------- */

/** Every TypeScript file under a directory. */
function sourceFilesUnder(directory: URL): string[] {
  const root = fileURLToPath(directory);
  const files: string[] = [];
  for (const relative of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    if (!relative.endsWith('.ts')) continue;
    files.push(path.join(root, relative));
  }
  return files;
}

/* -------------------------------------------------------------------------- */
/* The tests                                                                   */
/* -------------------------------------------------------------------------- */

describe('the within-turn tool result', () => {
  it('carries the stub, never the payload, when the result is over the limit', async () => {
    const { runtime, driver } = harness({ output: PAYLOAD });

    const result = await runtime.runTurn(turn);
    expect(result.stopReason).toBe('end_turn');

    // The second request is the one that carries the tool result.
    expect(driver.requests).toHaveLength(2);
    const second = driver.requests[1];
    if (second === undefined) throw new Error('expected a second request');

    const block = onlyToolResult(second.messages);
    expect(block.toolUseId).toBe('toolu_01');
    expect(block.isError).toBe(false);

    const content = block.content;
    expect(typeof content).toBe('string');
    if (typeof content !== 'string') throw new Error('expected a string content');
    expect(content).toBe(JSON.stringify(contentReplacementStub(PAYLOAD, LIMIT)));
    // The payload does not reach the model — not in the block, and not
    // anywhere in the request.
    expect(content).not.toContain(PAYLOAD);
    expect(JSON.stringify(second.messages)).not.toContain(PAYLOAD);
  });

  it('keeps the payload in the transcript, with a content-replacement record beside it', async () => {
    const { runtime, store } = harness({ output: PAYLOAD });

    await runtime.runTurn(turn);

    // The transcript keeps the data: the file holds the payload verbatim.
    const raw = await rawTranscriptOf(store);
    expect(raw).toContain(PAYLOAD);

    const events = await transcriptOf(store);
    const result = events.find((event) => event.t === 'tool_result');
    expect(result?.t === 'tool_result' ? result.envelope.content : undefined).toBe(PAYLOAD);

    const replacement = events.find((event) => event.t === 'content_replacement');
    expect(replacement?.t).toBe('content_replacement');
    if (replacement?.t !== 'content_replacement') {
      throw new Error('expected a content_replacement record');
    }
    expect(replacement.targetId).toBe(result?.id);
    expect(replacement.replacement).toEqual(contentReplacementStub(PAYLOAD, LIMIT));
  });

  it('carries a result that is under the limit as it is', async () => {
    const { runtime, driver } = harness({ output: 'the output' });

    await runtime.runTurn(turn);

    const second = driver.requests[1];
    if (second === undefined) throw new Error('expected a second request');
    const block = onlyToolResult(second.messages);
    expect(block.content).toBe('the output');
  });

  it("is stubbed by the store's own limit", async () => {
    const { runtime, driver, store } = harness({ output: PAYLOAD, limit: LIMIT });

    await runtime.runTurn(turn);

    // The store owns the limit, and it publishes it: the within-turn path and
    // the store's own content-replacement record must agree on it.
    expect(store.maxToolResultBytes).toBe(LIMIT);

    const second = driver.requests[1];
    if (second === undefined) throw new Error('expected a second request');
    const block = onlyToolResult(second.messages);
    expect(block.content).toBe(JSON.stringify(contentReplacementStub(PAYLOAD, LIMIT)));
  });
});

describe('the three paths agree', () => {
  it('the within-turn block, the between-turns load and the cross-turn projection agree', async () => {
    const { runtime, driver, store } = harness({ output: PAYLOAD });

    await runtime.runTurn(turn);

    const second = driver.requests[1];
    if (second === undefined) throw new Error('expected a second request');
    const withinTurn = onlyToolResult(second.messages);

    const events = await transcriptOf(store);
    const betweenTurns = onlyToolResult(conversationFromEvents(events));
    const crossTurn = onlyToolResult(
      contextToProviderMessages(resumeEvents(events).context),
    );

    expect(withinTurn.content).toBe(betweenTurns.content);
    expect(withinTurn.content).toBe(crossTurn.content);
    expect(withinTurn.toolUseId).toBe(betweenTurns.toolUseId);
    expect(withinTurn.toolUseId).toBe(crossTurn.toolUseId);
  });

  it('none of the three paths carries the payload', async () => {
    const { runtime, driver, store } = harness({ output: PAYLOAD });

    await runtime.runTurn(turn);

    const second = driver.requests[1];
    if (second === undefined) throw new Error('expected a second request');
    const events = await transcriptOf(store);

    const contents = [
      onlyToolResult(second.messages).content,
      onlyToolResult(conversationFromEvents(events)).content,
      onlyToolResult(contextToProviderMessages(resumeEvents(events).context)).content,
    ];

    for (const content of contents) {
      expect(typeof content).toBe('string');
      expect(String(content)).not.toContain(PAYLOAD);
    }
  });
});

describe('the stub rule', () => {
  it('returns no stub for a content that is under the limit', () => {
    expect(contentReplacementStub('small', LIMIT)).toBeUndefined();
    expect(contentReplacementStub(undefined, LIMIT)).toBeUndefined();
  });

  it('returns the stub for a content that is over the limit', () => {
    const stub = contentReplacementStub(PAYLOAD, LIMIT);

    expect(stub).toBeDefined();
    expect(stub?.type).toBe('tool_result_stub');
    expect(stub?.originalBytes).toBe(serializedSize(PAYLOAD));
    expect(stub?.message).toContain(String(serializedSize(PAYLOAD)));
  });

  it('uses the default limit when the caller names none', () => {
    expect(DEFAULT_MAX_TOOL_RESULT_BYTES).toBe(256 * 1024);
    expect(contentReplacementStub('small')).toBeUndefined();
    // A content at the default limit is over it once it is serialized: the
    // quotes the serialization adds count towards the size.
    expect(contentReplacementStub('x'.repeat(DEFAULT_MAX_TOOL_RESULT_BYTES))).toBeDefined();
  });

  it('is defined exactly once in the whole source tree', () => {
    const definition = /function\s+contentReplacementStub\s*\(/g;

    const definitions: string[] = [];
    for (const file of sourceFilesUnder(new URL('../../src/', import.meta.url))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(definition)) {
        definitions.push(`${file}: ${match[0]}`);
      }
    }

    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toContain('src/session/store.ts');
  });

  it('is reached by the agent module through the session module', () => {
    const agentSource = readFileSync(
      new URL('../../src/agent/loop.ts', import.meta.url),
      'utf8',
    );

    // The agent module holds no stub rule of its own: it reaches the session
    // module's by import.
    expect(agentSource).toMatch(
      /import\s*\{[^}]*\bcontentReplacementStub\b[^}]*\}\s*from\s*'\.\.\/session\/store\.js'/,
    );
    expect(agentSource).not.toMatch(/function\s+contentReplacementStub\b/);
  });

  it('stubs a content that cannot be serialized', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const stub = contentReplacementStub(circular, LIMIT);
    expect(stub?.type).toBe('tool_result_stub');
    expect(stub?.originalBytes).toBe(0);
    expect(stub?.message).toContain('of an unknown size');
  });
});

describe('the stub is labelled a implementation choice', () => {
  it('the store says the wire form is a implementation choice', () => {
    const source = readFileSync(
      new URL('../../src/session/store.ts', import.meta.url),
      'utf8',
    );

    // The label sits with the stub rule itself.
    const at = source.indexOf('export function contentReplacementStub');
    expect(at).toBeGreaterThan(-1);
    const header = source.slice(Math.max(0, at - 2000), at);
    expect(header).toMatch(/implementation choice/i);
  });

  it('the event module says the wire form is a implementation choice', () => {
    const source = readFileSync(
      new URL('../../src/session/event.ts', import.meta.url),
      'utf8',
    );

    const at = source.indexOf('export interface ToolResultStub');
    expect(at).toBeGreaterThan(-1);
    const header = source.slice(Math.max(0, at - 2000), at);
    expect(header).toMatch(/implementation choice/i);
  });

  it('the stub carries the size of the content it replaced', () => {
    const stub: ToolResultStub | undefined = contentReplacementStub(PAYLOAD, LIMIT);
    expect(stub?.originalBytes).toBe(serializedSize(PAYLOAD));
  });
});

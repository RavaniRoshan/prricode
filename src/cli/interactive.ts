/**
 * The interactive session host.
 *
 * Evidence: the `CC-014b` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`,
 * and `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.4 (Agent loop and tool
 * dispatch), §2.5 (Permissions), §2.6 (Sessions, persistence, and resumption)
 * and §2.10 (The command-line surface).
 *
 * ## What this module is
 *
 * The **host**: the thing that owns the state the Ink application renders.
 *
 * The app is **controlled** — it takes `events`, `input`, `approval` and
 * `status` as props and calls back — so the host is a small state machine over
 * the session, and the Ink instance is a **view** of it. The host holds four
 * things:
 *
 *   - the session's **records**, which the app renders as the conversation;
 *   - the **typed line**, which the app echoes;
 *   - the **pending approval**, which the app turns into a question;
 *   - the **status line**, which says what the session is doing.
 *
 * ## The turn runs while the app is mounted
 *
 * A submitted line runs a turn **through the agent runtime**
 * (`src/agent/loop.ts`) — the same runtime the headless path runs, built by
 * the same session factory (`createCommandSession` in `src/cli/command.ts`).
 * The host does not implement a second turn loop and does not interpret the
 * records: the runtime's `TurnResult.events` **are** the records the turn
 * appended, and the host puts them in the app's `events`.
 *
 * The host therefore has to be able to **re-render while a turn is in
 * flight**. That is the case that matters: the runtime asks the user for
 * approval **mid-turn** and waits for the answer, so the prompt has to be on
 * the screen while the turn is waiting for it.
 *
 * ## The approval bridge
 *
 * The bridge is the runtime's `approveAsk` seam
 * (`AgentRuntimeDeps.approveAsk`). The host hands the seam to the session
 * factory through the session context, and the factory hands it to the
 * runtime; the runtime hands it to the tool runner, and the runner calls it
 * when a call needs the user's decision.
 *
 * The bridge is a **promise**:
 *
 *   - the runtime calls it, and the call **suspends** there;
 *   - the host puts the question in the app's `approval` prop and **renders
 *     the app again** — the turn is still in flight, and the question is on
 *     the screen;
 *   - the user answers, and the app's `onApproval` callback **resolves** the
 *     promise;
 *   - the runtime continues with the answer, and the call runs or is refused.
 *
 * The host never awaits the turn from the app's input callback: the callback
 * starts the turn and returns, so the app stays responsive and the answer can
 * arrive. That is what keeps the bridge from deadlocking.
 *
 * ## The slash command
 *
 * A line that begins with `/provider` or `/catalog` runs the **manager**
 * instead of the model. The manager's own helpers (`isManagerCommand`,
 * `runManagerText` and `loadManagerState`, in `src/cli/commands/manager.ts`)
 * already exist and are tested; the host calls them and does not re-implement
 * them. Every other line is a **prompt**.
 *
 * ## The headless path is the reference
 *
 * The host does not fork the headless path: the command builds the store,
 * resolves the session, builds the hooks and hands them to the host, and the
 * host builds the session **through the same factory** the headless path uses.
 * The rules, the mode, the tools and the two hook seams are therefore the same
 * in both paths, and they cannot drift.
 *
 * ## What is observed and what is a implementation choice
 *
 * The audit observes that "headless mode is forced by a non-TTY stdout"
 * (§2.10), and it observes the permission vocabulary, the session format and
 * the turn cycle. The target's **terminal UI** was read out of the extracted
 * bundle by the `CC-022` milestone, and the surfaces it establishes — the
 * composer's glyph, the transcript's rows, the approval dialog, the
 * keybindings, the markdown rules and the two gestures — are the target's
 * (see `src/ui/` and `docs/compatibility/tool-surface.md`). What the audit
 * itself observes **nothing** about is still a **implementation choice**, and
 * each is marked at the place it is made:
 *
 *   - the **status line's wording**, apart from the verb a turn runs under,
 *     which is the target's own (`Working`);
 *   - the **wording** of the approval answers' reasons;
 *   - the **"don't ask again"** affordance's persistence (the target's
 *     *behaviour* — one rule per sub-command that needs approval, capped at
 *     five rules, in the repository's `.claude/settings.local.json` — is
 *     observed, per the plan's global constraints; this implementation's *writing* of it
 *     is this milestone's own work);
 *   - the **manager's output** being written above the app rather than into
 *     the conversation;
 *   - the **trimming** of the line the user submits, and the **refusal** of a
 *     line submitted while a turn is running;
 *   - the **end of the session**: the host ends when the abort signal fires
 *     or when the app is torn down (the terminal's own `Ctrl+C`, which the
 *     app's own two-press gesture — `Press ctrl+c again to exit` — ends);
 *   - the **terminal UI being loaded on demand** — the two modules are behind
 *     literal dynamic specifiers, so the bundler follows them and the packaged
 *     artifact **does** carry the UI, but the modules are only *evaluated* when
 *     an interactive session actually starts.
 *
 * The refusal the command used to print — "The interactive terminal UI is not
 * implemented in this implementation yet" — is **no longer true** and is not printed
 * again. The host refuses only when the app **cannot mount** (there is no
 * terminal), and it says why.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RenderOptions } from 'ink';

import type { TurnResult } from '../agent/loop.js';
import type { PermissionDecision, ToolContext } from '../permissions/decision.js';
import { PERSISTED_RULES_SETTINGS_PATH, persistentAllowRules } from '../permissions/decision.js';
import type { SessionEvent } from '../session/event.js';
import type { AppProps, PendingApproval } from '../ui/app.js';
import type { ApprovalChoice } from '../ui/render/prompts.js';

import type { ParsedRunArgs } from './args.js';
import { isManagerCommand, loadManagerState, runManagerText } from './commands/manager.js';
import { resolveModel, type CommandSession, type SessionContext, type SessionFactory } from './command.js';
import { EXIT_FAILURE, EXIT_SUCCESS, type OutputSink } from './output.js';

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The app the host mounted.
 *
 * The Ink instance is behind this record, so the host never touches Ink
 * directly and a caller can mount the app **without a terminal**: the seam is
 * what makes the host observable.
 */
export interface MountedApp {
  /** Render the app again, with new props. */
  update(props: AppProps): void;
  /** Write text above the app. */
  output(text: string): void;
  /** Tear the app down. */
  unmount(): void;
  /**
   * Resolves when the app is torn down from the terminal.
   *
   * It is **optional**: a caller that mounts the app itself — a test double, or
   * a caller that never tears the app down — need not provide one, and the
   * session then ends with the abort signal alone.
   */
  done?: Promise<void>;
}

/**
 * The seam that mounts the app.
 *
 * The host asks for the app; it does not mount it. The **default** mounts the
 * implementation's own app (`src/ui/app.ts`) with this implementation's own render options.
 */
export type MountApp = (props: AppProps) => MountedApp;

/** The context an interactive session runs with. */
export interface InteractiveContext {
  /**
   * The context the session is built with.
   *
   * It is the **headless path's own** context: the command builds it once and
   * hands it to both paths, so the rules, the mode, the tools and the two hook
   * seams are the same in a print run and in an interactive session.
   */
  session: SessionContext;
  /**
   * The factory that builds the session — and the runtime — the host drives.
   *
   * It is the **same** factory the headless path uses, and the host hands it
   * the approval bridge through the session context.
   */
  createSession: SessionFactory;
  /**
   * The model the turns run on, when the arguments do not name one.
   *
   * The arguments win over it, and this implementation's own default is the last resort.
   */
  model?: string;
  /** The signal that stops the session. */
  signal?: AbortSignal;
  /**
   * Whether the app can mount.
   *
   * It defaults to the process's standard output, and a caller that supplies
   * its own `mountApp` **owns** the answer: the seam exists so that the app
   * can be mounted without a terminal, so the check does not apply to it.
   */
  isTTY?: boolean;
  /** The seam that mounts the app. */
  mountApp?: MountApp;
  /** The render options the default mount uses. */
  renderOptions?: RenderOptions;
  /** The stream the failures go to. */
  stderr?: OutputSink;
}

/* -------------------------------------------------------------------------- */
/* The messages                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The refusal the host prints when the app cannot mount.
 *
 * **Implementation choice** (the wording). The *behaviour* is the plan's: the
 * interactive path is the default, and the refusal is the **fallback** for a
 * run with no terminal.
 */
export const NO_TERMINAL_MESSAGE =
  'The interactive terminal UI needs a terminal: the standard output is not a TTY, so the app cannot mount.';

/**
 * The refusal the host prints when the terminal UI cannot be loaded.
 *
 * **Implementation choice** (the wording). The case is a host on which the
 * terminal UI cannot be loaded at all.
 */
export const UI_UNAVAILABLE_MESSAGE =
  'The interactive terminal UI could not be loaded, so the session cannot start:';

/**
 * The status line a turn runs under.
 *
 * The target's default spinner verb (`chunk-tysd0s74.js:21854`): `Working`.
 */
export const WORKING_STATUS = 'Working';

/**
 * The name of the manager's state file, under the configuration directory.
 *
 * It is the command's own name for the file, so the two cannot drift: the
 * command writes it and the host reads it.
 */
export const PROVIDER_STATE_FILE = 'providers.json';

/* -------------------------------------------------------------------------- */
/* The state                                                                   */
/* -------------------------------------------------------------------------- */

/** The state the app is rendered with. */
interface HostState {
  /** The session's records, in the order they happened. */
  events: SessionEvent[];
  /** The text the user has typed. */
  input: string;
  /** The approval the user is being asked about. */
  approval: PendingApproval | undefined;
  /** The status line's text. */
  status: string | undefined;
  /** A notice the last action produced, shown beside the status. */
  notice: string | undefined;
}

/** A question the runtime is waiting for. */
interface PendingAnswer {
  /** The promise the user's answer resolves. */
  resolve: (decision: PermissionDecision | undefined) => void;
  /** The call the question is about. */
  tool: ToolContext;
  /** The decision the question is about. */
  decision: PermissionDecision;
}

/* -------------------------------------------------------------------------- */
/* The host                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Run an interactive session.
 *
 * The session mounts the app, runs a turn for every line the user submits,
 * answers the approval questions the runtime asks, and ends when the abort
 * signal fires or when the app is torn down.
 *
 * @returns the exit code the run ends with.
 */
export async function runInteractiveSession(
  parsed: ParsedRunArgs,
  context: InteractiveContext,
): Promise<number> {
  const stderr = context.stderr ?? process.stderr;

  // The app cannot mount without a terminal, and a run with no terminal has
  // nothing to show: the refusal is the **fallback**, not the default.
  if (!canMount(context)) {
    stderr.write(`${NO_TERMINAL_MESSAGE}\n`);
    return EXIT_FAILURE;
  }

  const signal = context.signal;
  // The model: the **same** resolution the headless path uses, so the two
  // cannot drift apart.
  const model = resolveModel(parsed, context);
  const state: HostState = {
    events: [],
    input: '',
    approval: undefined,
    status: undefined,
    notice: undefined,
  };

  /** The mounted app. */
  let app: MountedApp | undefined;
  /** The question the runtime is waiting for. */
  let pending: PendingAnswer | undefined;
  /** Whether a turn is running. */
  let turning = false;

  /** Render the app with the state the host owns. */
  const render = (): void => {
    app?.update(props());
  };

  /** The props the app is rendered with. */
  const props = (): AppProps => ({
    events: state.events,
    input: state.input,
    approval: state.approval,
    status: state.status,
    // The app draws the target's spinner while a turn runs (§5.2), and it
    // needs to know that a turn **is** running.
    busy: turning,
    notice: state.notice,
    onInputChange: (text: string) => {
      state.input = text;
      render();
    },
    onSubmit: (text: string) => {
      // The turn runs **beside** the app, never inside the input callback: the
      // callback has to return so that the approval question can be answered.
      void submit(text).catch((error: unknown) => {
        state.status = `The line failed: ${messageOf(error)}`;
        render();
      });
    },
    onApproval: (choice: ApprovalChoice) => {
      answer(choice);
    },
  });

  /**
   * The approval bridge.
   *
   * The runtime calls it when a call needs the user's decision, and the call
   * suspends there. The host puts the question on the screen and waits for the
   * answer.
   */
  const approveAsk = async (
    ctx: ToolContext,
    decision: PermissionDecision,
  ): Promise<PermissionDecision | undefined> => {
    if (signal?.aborted === true) return undefined;

    // The question is a promise. It is created **before** the app is rendered
    // again, so an answer can never arrive before there is one to answer.
    const answerPromise = new Promise<PermissionDecision | undefined>((resolve) => {
      pending = { resolve, tool: ctx, decision };
    });

    state.approval = { decision, toolName: ctx.toolName };
    render();

    const resolved = await answerPromise;
    state.approval = undefined;
    render();
    return resolved;
  };

  /** The session the turns run in. */
  let session: CommandSession;
  try {
    // The session is the **headless path's own** session, with the approval
    // bridge added: the rules, the mode, the tools and the two hook seams are
    // the same in both paths.
    session = await context.createSession({ ...context.session, approveAsk });
  } catch (error) {
    stderr.write(`The interactive session could not be opened: ${messageOf(error)}\n`);
    return EXIT_FAILURE;
  }

  // The conversation the app opens with: the session's own records.
  state.events = await readSessionRecords(context);

  // The mount. The seam is what makes the host observable without a terminal.
  let mount = context.mountApp;
  if (mount === undefined) {
    try {
      mount = await defaultMount(context.renderOptions);
    } catch (error) {
      stderr.write(`${UI_UNAVAILABLE_MESSAGE} ${messageOf(error)}\n`);
      return EXIT_FAILURE;
    }
  }
  app = mount(props());

  /**
   * A submitted line.
   *
   * A manager line runs the manager; every other line is a prompt.
   *
   * The line is **trimmed** before it is used. **Implementation choice**: the audit
   * records nothing about how the target reads a typed line, and a line of
   * nothing but spaces is no line at all.
   *
   * **One turn at a time.** A line submitted while a turn is running is
   * **refused**, and the status says so. **Implementation choice**: the audit records
   * nothing about the target's input during a turn, and two turns on one
   * session at once would interleave their records in the transcript.
   */
  async function submit(text: string): Promise<void> {
    const line = text.trim();
    state.input = '';
    if (turning) {
      state.status = 'The session is working: the line was not sent.';
      render();
      return;
    }
    render();
    if (line === '') return;
    if (isManagerCommand(line)) {
      await runManager(line);
      return;
    }
    await runTurn(line);
  }

  /** Run a turn and show what it produced. */
  async function runTurn(prompt: string): Promise<void> {
    turning = true;
    state.status = WORKING_STATUS;
    state.notice = undefined;
    render();

    let turn: TurnResult;
    try {
      turn = await session.runtime.runTurn(
        { prompt, sessionId: session.sessionId, model },
        signal,
      );
    } catch (error) {
      state.status = `The turn failed: ${messageOf(error)}`;
      render();
      turning = false;
      return;
    }

    // The turn's records are the runtime's own: the host does not read the
    // transcript again to find them.
    state.events = [...state.events, ...turn.events];
    state.status = statusOf(turn);
    turning = false;
    render();
  }

  /** Run the manager for a slash command. */
  async function runManager(line: string): Promise<void> {
    // The manager is work too: a line submitted while it runs is refused, the
    // same rule the model path follows.
    turning = true;
    const statePath = path.join(context.session.configDir, PROVIDER_STATE_FILE);
    try {
      const { registry, catalogs } = await loadManagerState(statePath);
      const result = await runManagerText(line, registry, {
        env: context.session.env,
        statePath,
        catalogs,
      });
      if (result === undefined) return;
      if (result.stdout !== '') app?.output(withoutTrailingNewline(result.stdout));
      if (result.stderr !== '') app?.output(withoutTrailingNewline(result.stderr));
      state.status = result.exitCode === 0 ? 'The command finished.' : 'The command failed.';
    } catch (error) {
      state.status = `The command failed: ${messageOf(error)}`;
    }
    turning = false;
    render();
  }

  /**
   * The user's answer to the approval question.
   *
   * The answer resolves the promise the runtime is waiting on, so the call is
   * decided by the answer and by nothing else.
   */
  function answer(choice: ApprovalChoice): void {
    const waiting = pending;
    if (waiting === undefined) return;
    pending = undefined;

    if (choice !== 'yes-always') {
      waiting.resolve(decisionFor(choice));
      return;
    }

    // The rule is written **before** the call is allowed, so that the promise
    // the choice's label makes is true by the time the call runs. A file that
    // cannot be written is a notice, not a reason to hold the turn.
    void persistAllowRules(context.session.cwd, waiting).then(
      (notice) => {
        if (notice !== undefined) state.notice = notice;
        waiting.resolve(decisionFor(choice));
      },
      () => {
        waiting.resolve(decisionFor(choice));
      },
    );
  }

  // The session ends when the abort signal fires or when the app is torn down.
  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      // A pending question is **refused** when the session stops: the turn
      // must not wait for an answer that will never come.
      const waiting = pending;
      pending = undefined;
      waiting?.resolve(undefined);
      finish();
    };
    const finish = (): void => {
      // The listener is removed whichever way the session ends, so a signal
      // that outlives the session does not keep the host alive.
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const done = app?.done;
    if (done !== undefined) {
      void done.then(
        () => {
          // The app is torn down while a question is pending — the terminal's
          // own `Ctrl+C` does exactly that. The pending question must be
          // **refused**, or the turn waits for an answer that can never come
          // and the transcript ends with a tool call that has no result.
          const waiting = pending;
          pending = undefined;
          waiting?.resolve(undefined);
          finish();
        },
        () => {
          const waiting = pending;
          pending = undefined;
          waiting?.resolve(undefined);
          finish();
        },
      );
    }
  });

  // The app is torn down before the host returns, so the terminal is handed
  // back the way the app found it.
  const mounted = app;
  app = undefined;
  mounted?.unmount();

  return EXIT_SUCCESS;
}

/* -------------------------------------------------------------------------- */
/* The session                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The session's records, read back through the store.
 *
 * The **store** is the source, not the file: a store that filters records —
 * the one a `--resume` at a message builds — is honoured, so the app opens
 * with the conversation the model sees.
 */
async function readSessionRecords(context: InteractiveContext): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  try {
    const handle = await context.session.store.create({
      cwd: context.session.cwd,
      sessionId: context.session.sessionId,
    });
    for await (const event of context.session.store.read(handle)) events.push(event);
  } catch {
    // A session that cannot be read opens empty. The turn reports the failure
    // in its own words, and the app still mounts.
  }
  return events;
}

/* -------------------------------------------------------------------------- */
/* The approval answers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The decision an answer produces.
 *
 * The **sources** are the permission layer's own vocabulary: a temporary
 * approval is `user_temporary`, a permanent one is `user_permanent`, and a
 * rejection is `user_reject`. The reason text is a **implementation choice**.
 */
function decisionFor(choice: ApprovalChoice): PermissionDecision {
  switch (choice) {
    case 'yes':
      return {
        behavior: 'allow',
        source: 'user_temporary',
        reasonType: 'other',
        reason: 'The user approved this call.',
      };
    case 'yes-always':
      return {
        behavior: 'allow',
        source: 'user_permanent',
        reasonType: 'other',
        reason: 'The user approved this call and asked not to be asked again.',
      };
    case 'no':
    default:
      return {
        behavior: 'deny',
        source: 'user_reject',
        reasonType: 'other',
        reason: 'The user rejected this call.',
      };
  }
}

/**
 * The rules the "don't ask again" answer persists.
 *
 * The **rules** are the permission layer's own (`persistentAllowRules`): one
 * rule per sub-command that needs approval, capped at five. The **write** is
 * this milestone's own work, and it writes the repository's
 * `.claude/settings.local.json` — the file the plan's global constraints name.
 *
 * @returns the notice to show when the rule could not be kept, and nothing
 *   when it was.
 */
async function persistAllowRules(cwd: string, waiting: PendingAnswer): Promise<string | undefined> {
  try {
    const rules = persistentAllowRules(waiting.tool, waiting.decision);
    if (rules.length === 0) return undefined;
    await writeAllowRules(cwd, rules);
    return undefined;
  } catch (error) {
    return `The rule was not kept: ${messageOf(error)}`;
  }
}

/**
 * Add rules to the repository's local settings file.
 *
 * The file is **read first** and only the `permissions.allow` list is
 * extended, so nothing else in it is lost. A file that is not a settings
 * document is **left alone**: writing over it would throw the user's settings
 * away.
 */
async function writeAllowRules(cwd: string, rules: readonly string[]): Promise<void> {
  const file = path.join(cwd, PERSISTED_RULES_SETTINGS_PATH);
  const document = await readLocalSettings(file);
  const permissions = ownObject(document, 'permissions');
  if (permissions === undefined) {
    throw new Error(`the settings file ${file} has a 'permissions' member that is not an object`);
  }
  const allow = ownStringList(permissions, 'allow');
  const next = [...allow];
  for (const rule of rules) {
    if (next.includes(rule)) continue;
    next.push(rule);
  }
  permissions['allow'] = next;
  document['permissions'] = permissions;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

/**
 * The local settings file, read as a document.
 *
 * A file that is **not there** is an empty document. A file that is there and
 * cannot be read as a document is an **error**: the caller leaves it alone.
 */
async function readLocalSettings(file: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`the settings file ${file} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`the settings file ${file} is not a settings document`);
  }
  return parsed as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* The mount                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The React module the app is drawn with.
 */
type ReactModule = typeof import('react');

/**
 * The terminal UI module.
 */
type UiModule = typeof import('../ui/app.js');

/**
 * Load the terminal UI.
 *
 * The two modules are loaded **on demand**: the mount is the only thing that
 * needs them, and a headless run must not pay for them. The specifiers are
 * **literal**, so the bundler follows them and the **packaged binary carries
 * the terminal UI** — a dynamic import with a literal specifier is bundled,
 * but the module is only *evaluated* when the promise is awaited.
 */
async function loadUi(): Promise<{ react: ReactModule; ui: UiModule }> {
  const react = (await import('react')) as ReactModule;
  const ui = (await import('../ui/app.js')) as UiModule;
  return { react, ui };
}

/**
 * The default mount: this implementation's own app, with this implementation's own options.
 *
 * The app is re-rendered with `createElement(App, props)`, so the app stays
 * **controlled**: the host's state is the only copy of the truth.
 */
async function defaultMount(overrides: RenderOptions = {}): Promise<MountApp> {
  const { react, ui } = await loadUi();
  return (props: AppProps): MountedApp => {
    const instance = ui.renderApp(props, overrides);
    return {
      update: (next: AppProps) => {
        instance.rerender(react.createElement(ui.App, next));
      },
      output: (text: string) => {
        // Ink patches the console by default, so the text is written **above**
        // the app rather than into the middle of its frame.
        console.log(text);
      },
      unmount: () => {
        instance.unmount();
      },
      done: instance.waitUntilExit().then(
        () => undefined,
        () => undefined,
      ),
    };
  };
}

/**
 * Whether the app can mount.
 *
 * The **seam** owns the answer when the caller supplied one: the whole point
 * of the seam is that the app can be mounted without a terminal.
 */
function canMount(context: InteractiveContext): boolean {
  if (context.isTTY !== undefined) return context.isTTY;
  if (context.mountApp !== undefined) return true;
  return process.stdout.isTTY === true;
}

/* -------------------------------------------------------------------------- */
/* The helpers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The status a finished turn leaves behind.
 *
 * **Implementation choice** (the wording).
 */
function statusOf(turn: TurnResult): string {
  switch (turn.stopReason) {
    case 'end_turn':
      return 'The turn finished.';
    case 'max_tokens':
      return 'The turn stopped at the output limit.';
    case 'tool_use':
      return 'The turn stopped with a tool call.';
    case 'aborted':
      return 'The turn was aborted.';
    case 'error':
    default:
      return turn.message ?? 'The turn failed.';
  }
}

/** The text without its trailing newline. */
function withoutTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/** The message of a thrown value. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * An own member of a document, when it is an object.
 *
 * The lookup is **own-property** on purpose: a member name is data, and
 * `Object.prototype` carries members called `constructor`, `toString` and
 * `__proto__`.
 */
function ownObject(document: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  if (!Object.hasOwn(document, key)) return {};
  const value = document[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** An own member of a document, when it is a list of strings. */
function ownStringList(document: Record<string, unknown>, key: string): string[] {
  if (!Object.hasOwn(document, key)) return [];
  const value = document[key];
  if (!Array.isArray(value)) return [];
  const entries: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') continue;
    entries.push(entry);
  }
  return entries;
}

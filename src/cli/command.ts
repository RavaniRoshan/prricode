/**
 * The command: the dispatcher, the session assembly, and the two seams the
 * `CC-007c` review found missing.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.10 (The command-line
 * surface), §2.5 (Permissions) and §2.6 (Sessions, persistence, and resumption),
 * and the `CC-014` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## The seams this task owns
 *
 * The `CC-007c` review found that **nothing in production supplied either
 * seam**: `createBuiltinTools`/`registerBuiltinTools` had no production caller,
 * and no file outside `src/permissions`, `src/extensions/hooks` and
 * `src/tools/builtins/shared.ts` mentioned `preToolUseHook`. The seam was wired
 * through `BuiltinToolDeps` but never fed.
 *
 * **This task is where that wiring belongs**, and it is in
 * {@link hookSeamsOf} and in {@link createCommandSession}:
 *
 * ```ts
 * const seams = hookSeamsOf(hooks);
 * const deps: BuiltinToolDeps = {
 *   rules,
 *   mode,
 *   cwd,
 *   hook: seams.permissionRequest,
 *   preToolUseHook: seams.preToolUse,
 * };
 * ```
 *
 * The **agent runtime** carries the same seam through its own
 * `permissionOptions()`, and this module supplies it there too: the runtime's
 * permission service is called with the options this module builds, so the
 * runtime's own check consults the `PreToolUse` hooks as well. The runtime's
 * **default** options cannot carry the seam — the runtime knows nothing of the
 * hook registry — so the default path needs the change that is reported to the
 * orchestrator.
 *
 * ## The session's own errors
 *
 * The messages the target prints for a failed session lookup and a failed
 * continue are the **target's**, and this implementation produces them by calling the
 * session module's own functions — `resumeSession` and `continueSession` — and
 * reporting the message they carry. The telemetry is theirs as well: the
 * session module emits `tengu_session_resumed`, `tengu_resume_print` and
 * `tengu_continue`, and this module only supplies the sink.
 *
 * ## What is a implementation choice
 *
 *   - the **default model** of a run;
 *   - the **version** the `--version` command prints — this implementation's own, never
 *     the target's;
 *   - the **help text**;
 *   - the fact that the **subcommands** are recognised but not implemented: the
 *     audit records their names and not their behaviour, and this implementation has no
 *     live-session model to attach to;
 *   - the **background mode**, which this implementation does not run.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { AgentRuntime, TurnResult } from '../agent/loop.js';
import { createAgentRuntime } from '../agent/loop.js';
import type { ProviderTurnSource } from '../agent/context.js';
import { streamingSourceOf } from '../agent/context.js';
import { loadSettings } from '../config/loader.js';
import type { HookRegistry } from '../extensions/hooks/registry.js';
import { createHookRegistry } from '../extensions/hooks/registry.js';
import { createHookApproval, createPreToolUseApproval } from '../extensions/hooks/runner.js';
import type { RunHooksOptions } from '../extensions/hooks/runner.js';
import {
  RESTRICT_PERSONAL_CONFIG_ENV,
  checkPermission,
  permissionsFromSettings,
  resolveStartMode,
  type PermissionDecision,
  type PermissionMode,
  type ToolContext,
} from '../permissions/decision.js';
import { createPermissionRequestHook, createPreToolUseHook } from '../permissions/prompts.js';
import type { RuleSet } from '../permissions/rules.js';
import { driverFor } from '../provider/drivers/index.js';
import type { ProviderDriver } from '../provider/drivers/types.js';
import { resolveBaseUrl, selectRoute } from '../provider/routes.js';
import { sendProviderRequest } from '../provider/transport/index.js';
import { continueSession, resumeAtMessage, resumeSession } from '../session/resume.js';
import type { SessionEvent } from '../session/event.js';
import {
  createSessionStore,
  defaultConfigDir,
  readAllSessionEvents,
  sessionFilePath,
  type SessionStore,
} from '../session/store.js';
import { createBuiltinTools, registerBuiltinTools } from '../tools/builtins/index.js';
import type { BuiltinToolDeps } from '../tools/builtins/shared.js';
import { createToolRegistry } from '../tools/registry.js';

import type { ParsedArgs, ParsedCommandArgs, ParsedRunArgs } from './args.js';
import { runHeadless } from './headless.js';
import {
  EXIT_FAILURE,
  EXIT_SUCCESS,
  EXIT_USAGE,
  writeHeadlessOutput,
  type OutputSink,
} from './output.js';

/* -------------------------------------------------------------------------- */
/* The constants                                                               */
/* -------------------------------------------------------------------------- */

/**
 * This implementation's version.
 *
 * **Implementation choice.** It tracks the `version` of `package.json`. It is the
 * implementation's own version and never the target's: this implementation does not claim to be
 * the reference agent.
 */
export const CLI_VERSION = '0.1.0';

/**
 * The model a run uses when the flags do not name one.
 *
 * **Implementation choice.** The audit does not record the target's default model.
 */
export const DEFAULT_MODEL = 'claude-sonnet-4-5';

/**
 * The help text.
 *
 * **Implementation choice.** The audit records the flag names it observed and no help
 * text, so the text below is this implementation's own.
 */
export const HELP_TEXT = `Usage: agent [options] [prompt]

Options:
  -p, --print                 run in print mode and write the answer to stdout
  -c, --continue              continue the newest session
  -r, --resume <id|title>     resume a session by its id or its exact title
      --resume-session-at <uuid>
                              resume at a message
      --output-format <fmt>   text (the default), json or stream-json
      --input-format <fmt>    text (the default) or stream-json
      --model <id>            the model the run uses
      --name <name>           the name of the session
      --session-id <id>       the id of the session
      --permission-mode <mode>
                              default, manual, acceptEdits, bypassPermissions,
                              plan, auto or dontAsk
      --allowedTools <tool…>  the tools that need no approval
      --disallowedTools <tool…>
                              the tools that are refused
      --tools <tool…>         the tools the session offers
      --add-dir <dir…>        the directories the session may write in
      --mcp-config <file…>    the MCP configuration files
      --betas <beta…>         the beta flags the request carries
      --file <file…>          the files the session starts with
      --channels <channel…>   the channels the session uses
      --init-only             set the session up and stop
      --no-session-persistence
                              do not persist the session
      --fork-session          load a copy of the session that is resumed
      --dangerously-skip-permissions
                              start in bypassPermissions mode
      --verbose               write more about what the run does
  -h, --help                  write this help and stop
  -v, --version               write the version and stop

Commands:
  attach, logs, stop, kill, respawn, rm

The multi-provider manager (an extension, not part of the reference agent) is reached
through the /provider command.
`;

/* -------------------------------------------------------------------------- */
/* The options                                                                 */
/* -------------------------------------------------------------------------- */

/** The context a session is built with. */
export interface SessionContext {
  /** The arguments of the run. */
  parsed: ParsedRunArgs;
  /** The session id the run uses. */
  sessionId: string;
  /** The working directory. */
  cwd: string;
  /** The configuration directory. */
  configDir: string;
  /** The environment. */
  env: NodeJS.ProcessEnv;
  /** The hook registry the session's seams consult. */
  hooks: HookRegistry;
  /** The store the session's records live in. */
  store: SessionStore;
  /**
   * The records a resume at a message discarded.
   *
   * They are **not** deleted — the transcript is append-only — but the run does
   * not read them, so the conversation the model sees starts at the message the
   * resume named.
   */
  discarded?: readonly string[];
  /**
   * The credential the provider layer resolved.
   *
   * The CLI never resolves a secret itself: the provider layer's
   * `resolveConnectionCredential` is the only path to one.
   */
  credential?: string;
  /**
   * The driver the run's requests are built with.
   *
   * It defaults to the driver of the route the environment selects.
   */
  driver?: ProviderDriver;
  /** The options the hook runner runs with. */
  hookOptions?: RunHooksOptions;
}

/** The session a run uses. */
export interface CommandSession {
  /** The session id. */
  sessionId: string;
  /** The runtime that runs the turn. */
  runtime: AgentRuntime;
}

/** The factory that builds the session a run uses. */
export type SessionFactory = (context: SessionContext) => Promise<CommandSession>;

/** The options a command runs with. */
export interface CommandOptions {
  /** The working directory. Defaults to the process's. */
  cwd?: string;
  /** The configuration directory. Defaults to `~/.claude`. */
  configDir?: string;
  /** The environment. Defaults to the process's. */
  env?: NodeJS.ProcessEnv;
  /** Whether stdout is a terminal. Defaults to the process's. */
  isTTY?: boolean;
  /** The stream the output goes to. Defaults to the process's stdout. */
  stdout?: OutputSink;
  /** The stream the failures go to. Defaults to the process's stderr. */
  stderr?: OutputSink;
  /**
   * The prompt, when the arguments did not carry one.
   *
   * It reads the standard input by default. The headless mode takes the prompt
   * from the positional argument or from the standard input, so a run that has
   * neither has nothing to do.
   */
  readPrompt?: () => Promise<string>;
  /** The hook registry the session's seams consult. */
  hooks?: HookRegistry;
  /** The options the hook runner runs with. */
  hookOptions?: RunHooksOptions;
  /** The session factory. Defaults to {@link createCommandSession}. */
  createSession?: SessionFactory;
  /** The telemetry sink. */
  telemetry?: (event: unknown) => void;
  /** The clock. */
  now?: () => number;
  /** The model, when the arguments do not name one. */
  model?: string;
  /** The signal that stops the run. */
  signal?: AbortSignal;
  /**
   * The driver the run's requests are built with.
   *
   * It defaults to the driver of the route the environment selects. The member
   * exists so that the session's **production wiring** — the tools, the
   * permission service and the two seams — can be exercised without a network.
   */
  driver?: ProviderDriver;
  /**
   * The credential the provider layer resolved.
   *
   * The CLI **never resolves a secret**: the provider layer's
   * `resolveConnectionCredential` is the only path to one, and the connection
   * registry that owns the connections is the provider manager's surface. The
   * credential is therefore supplied here, already resolved.
   */
  credential?: string;
  /**
   * The interactive run.
   *
   * The interactive terminal UI is a later milestone's surface; the member is
   * the seam it plugs into.
   */
  runInteractive?: (parsed: ParsedRunArgs) => Promise<number>;
}

/* -------------------------------------------------------------------------- */
/* The seams                                                                   */
/* -------------------------------------------------------------------------- */

/** The two hook seams a session's permission checks consult. */
export interface HookSeams {
  /**
   * The `PreToolUse` seam.
   *
   * It is the seam the hooks module's `createPreToolUseApproval` plugs into:
   * the hook may deny the call, ask for the user's decision, approve it and
   * rewrite the tool input.
   */
  preToolUse: (ctx: ToolContext) => Promise<PermissionDecision | undefined>;
  /**
   * The `PermissionRequest` seam.
   *
   * It is the seam the hooks module's `createHookApproval` plugs into: the
   * hook may deny the call, approve it and rewrite the tool input.
   */
  permissionRequest: (ctx: ToolContext) => Promise<PermissionDecision | undefined>;
}

/**
 * Build the two seams from a hook registry.
 *
 * **This is the production wiring the `CC-007c` review found missing.** The
 * registry's `PreToolUse` hooks become the `preToolUseHook` member of the tool
 * dependencies and of the runtime's permission options, and its
 * `PermissionRequest` hooks become the `hook` member of both.
 */
export function hookSeamsOf(hooks: HookRegistry, options: RunHooksOptions = {}): HookSeams {
  return {
    preToolUse: createPreToolUseHook({
      approval: createPreToolUseApproval(hooks.for('PreToolUse'), options),
    }),
    permissionRequest: createPermissionRequestHook({
      approval: createHookApproval(hooks.for('PermissionRequest'), options),
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* The command                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Run a parsed command line.
 *
 * The exit code is the run's own: `0` when it finished, `1` when it failed, and
 * `2` when the arguments were wrong — the two codes the audit records ("`1` for
 * a failed session lookup and `2` for an argument error").
 */
export async function runCommand(parsed: ParsedArgs, options: CommandOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  switch (parsed.kind) {
    case 'error':
      stderr.write(`${parsed.message}\n`);
      return parsed.exitCode;
    case 'help':
      stdout.write(HELP_TEXT);
      return EXIT_SUCCESS;
    case 'version':
      stdout.write(`${CLI_VERSION}\n`);
      return EXIT_SUCCESS;
    case 'routine':
      stderr.write("The '--routine' command is not implemented here yet.\n");
      return EXIT_FAILURE;
    case 'command':
      return runSubcommand(parsed, { stdout, stderr, ...options });
    case 'run':
      return runRun(parsed, { stdout, stderr, ...options });
    default:
      return EXIT_USAGE;
  }
}

/* -------------------------------------------------------------------------- */
/* The subcommands                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What each subcommand would do.
 *
 * The audit records the six names and not their behaviour, and this implementation has no
 * live-session model to attach to, stop, kill or respawn. The command therefore
 * **recognises** them and says plainly that it does not implement them, rather
 * than pretending to.
 *
 * The table is a `Map`, so the subcommand's name is **data**: the lookup can
 * never resolve an inherited member of `Object.prototype`.
 */
const SUBCOMMAND_INTENT: ReadonlyMap<string, string> = new Map([
  ['attach', 'attach to a session that is already running'],
  ['logs', 'write the log of a session that is already running'],
  ['stop', 'stop the session that is running in the background'],
  ['kill', 'kill the session that is running in the background'],
  ['respawn', 'respawn the worker of a session'],
  ['rm', 'remove a session'],
]);

/** Run one of the target's subcommands. */
async function runSubcommand(
  parsed: ParsedCommandArgs,
  context: RunContext,
): Promise<number> {
  const intent = SUBCOMMAND_INTENT.get(parsed.command) ?? parsed.command;
  context.stderr.write(
    `The '${parsed.command}' command is not implemented here yet. It would ${intent}.\n`,
  );
  return EXIT_FAILURE;
}

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

/** The context a run carries. */
interface RunContext extends CommandOptions {
  /** The stream the output goes to. */
  stdout: OutputSink;
  /** The stream the failures go to. */
  stderr: OutputSink;
}

/** Run the parsed arguments. */
async function runRun(parsed: ParsedRunArgs, context: RunContext): Promise<number> {
  if (parsed.background) {
    context.stderr.write('The background mode is not implemented here yet.\n');
    return EXIT_FAILURE;
  }

  if (!parsed.headless) {
    // The interactive terminal UI is a later milestone's surface. The seam is
    // here so that it plugs in without this module changing.
    if (context.runInteractive !== undefined) return context.runInteractive(parsed);
    context.stderr.write('The interactive terminal UI is not implemented here yet.\n');
    return EXIT_FAILURE;
  }

  const cwd = context.cwd ?? process.cwd();
  const configDir = context.configDir ?? defaultConfigDir();
  const env = context.env ?? process.env;
  const store = createSessionStore({ configDir });

  // The session: continued, resumed, or new. The resolution runs **before** the
  // prompt is read, so a failed session lookup is reported with the target's own
  // message rather than with a complaint about a missing prompt.
  const resolved = await resolveSession(parsed, { store, cwd, configDir, context });
  if (resolved === undefined) return EXIT_FAILURE;

  const hooks = context.hooks ?? createHookRegistry();
  const factory = context.createSession ?? createCommandSession;
  const session = await factory({
    parsed,
    sessionId: resolved.sessionId,
    cwd,
    configDir,
    env,
    hooks,
    store: resolved.store,
    ...(resolved.discarded === undefined ? {} : { discarded: resolved.discarded }),
    ...(context.credential === undefined ? {} : { credential: context.credential }),
    ...(context.driver === undefined ? {} : { driver: context.driver }),
    ...(context.hookOptions === undefined ? {} : { hookOptions: context.hookOptions }),
  });

  // `--init-only` sets the session up and stops: no turn is made and no prompt
  // is read.
  if (parsed.initOnly) {
    await store.create({ cwd, sessionId: session.sessionId });
    return EXIT_SUCCESS;
  }

  // The prompt: the positional argument, or the standard input.
  let prompt = parsed.prompt;
  if (prompt === undefined) {
    const read = context.readPrompt ?? readStandardInput;
    prompt = await read();
    if (prompt.trim() === '') {
      context.stderr.write('Error: no prompt was given.\n');
      return EXIT_USAGE;
    }
  }

  const code = await writeHeadlessOutput({
    events: runHeadless({
      prompt,
      sessionId: session.sessionId,
      model: parsed.model ?? context.model ?? DEFAULT_MODEL,
      runtime: session.runtime,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...(context.now === undefined ? {} : { now: context.now }),
    }),
    format: parsed.outputFormat,
    stdout: context.stdout,
    stderr: context.stderr,
  });

  return code;
}

/* -------------------------------------------------------------------------- */
/* The session resolution                                                      */
/* -------------------------------------------------------------------------- */

/** What the resolution of a run's session produced. */
interface ResolvedSession {
  /** The session id the run uses. */
  sessionId: string;
  /** The store the run reads. */
  store: SessionStore;
  /** The records a resume at a message discarded. */
  discarded?: readonly string[];
}

/**
 * Resolve the session a run uses.
 *
 * A `--continue` and a `--resume` are the session module's own: this module
 * calls `continueSession` and `resumeSession`, so the **target's** messages and
 * the **target's** telemetry come from there and are not re-implemented here.
 */
async function resolveSession(
  parsed: ParsedRunArgs,
  options: {
    store: SessionStore;
    cwd: string;
    configDir: string;
    context: RunContext;
  },
): Promise<ResolvedSession | undefined> {
  const { store, cwd, configDir, context } = options;
  const telemetry = context.telemetry;

  if (parsed.continueSession) {
    const result = await continueSession({
      store,
      cwd,
      ...(telemetry === undefined ? {} : { onTelemetry: telemetry }),
    });
    if (result.status === 'failed') {
      const message = result.failure?.message ?? 'The previous session could not be continued.';
      context.stderr.write(`${message}\n`);
      return undefined;
    }
    return { sessionId: result.sessionId ?? newSessionId(), store };
  }

  if (parsed.resume !== undefined) {
    const result = await resumeSession({
      store,
      cwd,
      // The print path is the headless path, and the print path is what emits
      // the target's `tengu_resume_print` event.
      entrypoint: 'print',
      target: parsed.resume,
      ...(parsed.resumeSessionAt === undefined ? {} : { messageUuid: parsed.resumeSessionAt }),
      ...(parsed.forkSession ? { forkSession: true } : {}),
      ...(telemetry === undefined ? {} : { onTelemetry: telemetry, onPrintTelemetry: telemetry }),
    });
    if (result.status === 'failed') {
      const message = result.failure?.message ?? 'The session could not be resumed.';
      context.stderr.write(`${message}\n`);
      return undefined;
    }

    const sessionId = result.sessionId ?? newSessionId();
    const discarded = await discardedRecordsOf({
      store,
      cwd,
      configDir,
      sessionId,
      target: parsed.resume,
      messageUuid: parsed.resumeSessionAt,
    });
    if (discarded === undefined || discarded.length === 0) {
      return { sessionId, store };
    }
    return { sessionId, store: storeWithout(store, new Set(discarded)), discarded };
  }

  return { sessionId: parsed.sessionId ?? newSessionId(), store };
}

/**
 * The records a resume at a message discarded.
 *
 * The drop guard has already run — `resumeSession` refused the resume when the
 * guard refused it — so this only reads the transcript again to learn **which**
 * records the resume discarded. The transcript is append-only, so they are not
 * deleted: the run simply does not read them.
 */
async function discardedRecordsOf(options: {
  store: SessionStore;
  cwd: string;
  configDir: string;
  sessionId: string;
  target: string;
  messageUuid: string | undefined;
}): Promise<string[] | undefined> {
  const { cwd, configDir, sessionId, target, messageUuid } = options;
  if (messageUuid === undefined) return undefined;

  const filePath = transcriptPathOf(configDir, cwd, sessionId, target);
  if (filePath === undefined) return undefined;

  let events: SessionEvent[];
  try {
    events = await readAllSessionEvents(filePath);
  } catch {
    return undefined;
  }

  const at = resumeAtMessage(events, messageUuid);
  if (at.kind === 'refused') return undefined;
  return at.discardedEventIds;
}

/** The transcript of a session, when its path can be computed. */
function transcriptPathOf(
  configDir: string,
  cwd: string,
  sessionId: string,
  target: string,
): string | undefined {
  if (target.endsWith('.jsonl')) return path.resolve(target);
  try {
    return sessionFilePath(configDir, cwd, sessionId);
  } catch {
    return undefined;
  }
}

/**
 * A store that does not read the records it was told to leave out.
 *
 * The transcript stays append-only: the records are still there, and the run
 * simply does not read them. The filter is by **record id**, so it holds across
 * the turns of one run.
 */
function storeWithout(inner: SessionStore, discarded: ReadonlySet<string>): SessionStore {
  return {
    maxToolResultBytes: inner.maxToolResultBytes,
    create: (opts) => inner.create(opts),
    append: (handle, event) => inner.append(handle, event),
    read: (handle) => ({
      async *[Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
        for await (const record of inner.read(handle)) {
          if (discarded.has(record.id)) continue;
          yield record;
        }
      },
    }),
    list: (opts) => inner.list(opts),
  };
}

/* -------------------------------------------------------------------------- */
/* The session assembly                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Build the session a run uses.
 *
 * The session is the store, the tools, the permission service and the runtime
 * that ties them together. The **tools** are the built-in ones, built with the
 * session's rules, the session's mode and the session's **two seams** — the
 * wiring the `CC-007c` review found missing.
 *
 * The **mode** is the start mode: the `--permission-mode` flag beats
 * `permissions.defaultMode`, which beats the built-in default, and the built-in
 * default is `auto` for a terminal session and `default` for a headless one.
 */
export async function createCommandSession(context: SessionContext): Promise<CommandSession> {
  const { cwd, configDir, env, parsed } = context;

  const settings = loadSettings({
    cwd,
    configDir,
    restricted: env[RESTRICT_PERSONAL_CONFIG_ENV] !== undefined,
  });
  const permissions = permissionsFromSettings(settings, { cwd, configDir, env });

  const mode = startModeOf(parsed, permissions.defaultMode, !parsed.headless);
  const seams = hookSeamsOf(context.hooks, context.hookOptions ?? {});

  // **The command line's own rules.** `--allowedTools` and `--disallowedTools`
  // name the tools that need no approval and the tools that are refused, and
  // `--add-dir` names the directories the session may write in.
  //
  // **Implementation choice.** The audit records the flag names and not what they do to
  // the rule lists. This implementation reads them the obvious way: a tool name is a
  // rule that names the tool, and the rule precedence (deny → ask → allow)
  // decides the outcome, so a deny rule still beats an allowed tool.
  const rules = rulesWithFlags(permissions.rules, parsed);

  const deps: BuiltinToolDeps = {
    rules,
    mode,
    cwd,
    ...(rules.additionalDirs === undefined ? {} : { additionalDirs: rules.additionalDirs }),
    // **The two seams.** A `PreToolUse` hook's denial holds in every mode, and a
    // `PermissionRequest` hook's denial is a denial.
    hook: seams.permissionRequest,
    preToolUseHook: seams.preToolUse,
  };

  const registry = createToolRegistry();
  if (parsed.tools.length === 0) {
    registerBuiltinTools(registry, deps);
  } else {
    // **Implementation choice**: `--tools` names the tools the session offers, and the
    // tools it does not name are not offered at all.
    for (const tool of createBuiltinTools(deps)) {
      if (!parsed.tools.includes(tool.name)) continue;
      registry.register(tool);
    }
  }

  const driver = context.driver ?? driverFor(selectRoute(env));
  const baseUrl = resolveBaseUrl(selectRoute(env), env).baseUrl;

  const permissionOptions = {
    rules,
    mode,
    cwd,
    hook: seams.permissionRequest,
    preToolUseHook: seams.preToolUse,
    ...(permissions.gate === undefined ? {} : { hostGate: permissions.gate }),
  };

  const runtime = createAgentRuntime({
    driver,
    source:
      streamingSourceOf(driver) ??
      transportSourceOf(driver, {
        baseUrl,
        ...(context.credential === undefined ? {} : { credential: context.credential }),
      }),
    registry,
    store: context.store,
    permission: checkPermission,
    permissionOptions,
    cwd,
  });

  return { sessionId: context.sessionId, runtime };
}

/**
 * The rules a run's command line adds to the session's rules.
 *
 * **Implementation choice.** The audit records the flag names and not their effect on the
 * rule lists. This implementation reads them the obvious way:
 *
 *   - `--allowedTools` names the tools that need no approval;
 *   - `--disallowedTools` names the tools that are refused;
 *   - `--add-dir` names the directories `acceptEdits` may write in.
 *
 * The lists are **appended**, not replaced: a rule from a settings file and a
 * rule from the command line are both in force, and the precedence (deny → ask
 * → allow) decides the outcome.
 */
function rulesWithFlags(rules: RuleSet, parsed: ParsedRunArgs): RuleSet {
  const allow = [...rules.allow];
  const deny = [...rules.deny];
  const additionalDirs = [...(rules.additionalDirs ?? [])];

  for (const tool of parsed.allowedTools) {
    if (!allow.includes(tool)) allow.push(tool);
  }
  for (const tool of parsed.disallowedTools) {
    if (!deny.includes(tool)) deny.push(tool);
  }
  for (const directory of parsed.addDirs) {
    if (!additionalDirs.includes(directory)) additionalDirs.push(directory);
  }

  return { ...rules, allow, deny, additionalDirs };
}

/**
 * The mode a session starts in.
 *
 * The precedence is the target's: the `--permission-mode` flag beats
 * `permissions.defaultMode`, which beats the built-in default, and `auto` and
 * `bypassPermissions` written into a settings file are ignored — only the flag
 * may select them. The built-in default is `auto` for a terminal session and
 * `default` for a headless one.
 */
function startModeOf(
  parsed: ParsedRunArgs,
  settingsDefault: PermissionMode | undefined,
  interactive: boolean,
): PermissionMode {
  if (parsed.dangerouslySkipPermissions) return 'bypassPermissions';
  const flag = parsed.permissionMode as PermissionMode | undefined;
  return resolveStartMode({
    ...(flag === undefined ? {} : { flag }),
    ...(settingsDefault === undefined ? {} : { settingsDefault }),
    autoAvailable: true,
    autoDisabledByPolicy: false,
    hipaaConfigured: false,
    interactive,
  });
}

/* -------------------------------------------------------------------------- */
/* The transport                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The turn source a driver is used through.
 *
 * This implementation's drivers build the request and parse the response; the transport
 * sends it. The runtime wants an async iterable of provider events, so the
 * transport's result is yielded here.
 *
 * **A limitation, stated rather than hidden**: the transport collects the whole
 * response before it returns, so the events arrive in one batch rather than one
 * at a time. This implementation's turn is therefore not incrementally streamed.
 */
function transportSourceOf(
  driver: ProviderDriver,
  options: { baseUrl?: string; credential?: string },
): ProviderTurnSource {
  return {
    send(request, signal): AsyncIterable<never> {
      const source: AsyncIterable<never> = (async function* (): AsyncGenerator<never> {
        const result = await sendProviderRequest(
          {
            driver,
            ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
            ...(signal === undefined ? {} : { signal }),
          },
          request,
          options.credential,
        );
        for (const event of result.events) yield event as never;
      })();
      return source;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The helpers                                                                 */
/* -------------------------------------------------------------------------- */

/** A fresh session id. */
function newSessionId(): string {
  return randomUUID();
}

/** Read the standard input. */
async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The result of a turn, as the runtime's own.
 *
 * **Implementation choice.** The headless mode does not re-implement the turn, so the
 * type is re-exported for a caller that wants to name it.
 */
export type { TurnResult };

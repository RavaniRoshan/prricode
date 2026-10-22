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
 * The runtime's `AgentRuntimeDeps` also carries the two seams as its **own**
 * members, and this module supplies them there as well: the seam reaches the
 * runtime's service whichever of the two the runtime consults, and the
 * runtime's **default** path — the one a caller that supplies no
 * `permissionOptions` takes — is gated by them too.
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
 *   - the **background mode**, which this implementation does not run;
 *   - the **options this implementation recognises and does not implement**
 *     (`--sdk-url`, `--teleport`, `--max-turns`, `--system-prompt`,
 *     `--append-system-prompt`, `--verbose`, `--debug`, `--cloud`, `--remote`,
 *     `--environment`, `--betas`, `--file`, `--channels`, `--mcp-config` and
 *     `--dangerously-load-development-channels`). A flag this implementation accepts and
 *     then ignores is worse than one it refuses, so each of them is **refused
 *     by the run** with a message that names it — the same shape as the
 *     `--routine` command and the background mode;
 *   - the **settings file** `--settings` names: it is loaded as the
 *     **highest-precedence overlay** of the tiered settings;
 *   - the **stream-json input**: the standard input carries **JSON documents**,
 *     one per line, and their text is the prompt of this implementation's **one** turn.
 *     See `src/cli/headless.ts`;
 *   - the **start mode's three availability overrides**, which the CLI — the
 *     only production caller of `resolveStartMode` — now threads. See
 *     {@link startModeOf}.
 *   - the **active connection** a run uses: the connection table is this
 *     implementation's own product surface, and a run that ignored the active
 *     connection would make the manager inert. The connection's route, base URL
 *     and credential are the run's, and a connection that cannot be resolved is
 *     **reported** rather than silently ignored. See {@link resolveRunConnection}.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { join } from 'node:path';

import type { AgentRuntime } from '../agent/loop.js';
import { createAgentRuntime } from '../agent/loop.js';
import type { ProviderTurnSource } from '../agent/context.js';
import { streamingSourceOf } from '../agent/context.js';
import { loadManagerState, providerManagerCommand } from './commands/manager.js';
import { resolveActiveConnection } from './commands/provider.js';
import { PROVIDER_EXTENSION_NOTICE } from './commands/shared.js';
import { loadSettings } from '../config/loader.js';
import { parseSettingsDocument } from '../config/schema.js';
import type { SettingsSource, SettingsTier } from '../config/tiers.js';
import { TIER_PRECEDENCE, documentOf, mergeSettingsValue } from '../config/tiers.js';
import type { HookRegistry } from '../extensions/hooks/registry.js';
import { createHookRegistry } from '../extensions/hooks/registry.js';
import { createHookApproval, createPreToolUseApproval } from '../extensions/hooks/runner.js';
import type { RunHooksOptions } from '../extensions/hooks/runner.js';
import {
  RESTRICT_PERSONAL_CONFIG_ENV,
  checkPermission,
  isPersonalConfigRestricted,
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
import { resolveBaseUrl, selectRoute, type ProviderRoute } from '../provider/routes.js';
import {
  activeConnectionOf,
  resolveConnectionCredential,
  resolveConnectionEndpoint,
} from '../provider/registry.js';
import { sendProviderRequest } from '../provider/transport/index.js';
import { continueSession, resumeAtMessage, resumeSession } from '../session/resume.js';
import { TelemetryEmitter, propertiesOf } from '../telemetry/emitter.js';
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

import type { ParsedArgs, ParsedCommandArgs, ParsedManagerArgs, ParsedRunArgs } from './args.js';
import type { CloudTarget, CliCommand } from './args.js';
import {
  BOOLEAN_FLAG_NAMES,
  CLI_COMMAND_GROUPS,
  CLI_COMMAND_TREE,
  COMMAND_TOKEN_NAMES,
  DEFAULT_MODEL,
  FLAG_ARGUMENT_HINTS,
  OPTIONAL_VALUE_FLAG_NAMES,
  REPEATABLE_FLAG_NAMES,
  SHORT_FLAG_ALIASES,
  SESSION_SUBCOMMAND_NAMES,
  VALUE_FLAG_NAMES,
  cliCommandOf,
  findSessionIdInPath,
  isSessionId,
} from './args.js';
import { readStreamJsonInput, runHeadless } from './headless.js';
import { PROVIDER_STATE_FILE, runInteractiveSession } from './interactive.js';
import type { InteractiveContext, MountApp } from './interactive.js';
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
 * **Implementation choice.** It is the `version` of `package.json`, and the contract
 * test keeps the two in step: the version the `--version` command prints is the
 * package's version. It is this implementation's own version and never the target's: the
 * implementation does not claim to be the reference agent.
 */
export const CLI_VERSION = '0.1.0';

/**
 * The model a run uses when the flags do not name one.
 *
 * **Implementation choice.** The audit does not record the target's default model.
 *
 * The constant itself lives on the **command-line surface**
 * (`src/cli/args.ts`), because the interactive host resolves its model the
 * same way this module does, and the two must not drift.
 */
export { DEFAULT_MODEL };

/**
 * The width of the usage column of the help.
 *
 * It is declared **before** the help text is built: the help is a module-level
 * constant, and a `const` declared after it would not be initialised yet.
 */
const COMMAND_COLUMN = 34;

/**
 * The help text.
 *
 * **Implementation choice.** The audit records the flag names and no help
 * text, so the text below is this implementation's own. Its **shape** is the
 * target's: the target's own `--help` lists every flag of its vocabulary —
 * including the flags the build has no behaviour for — and lists the commands
 * it registers.
 *
 * The flag list is **generated** from the vocabulary the parser knows, so the
 * help and the parser cannot drift apart.
 */
export const HELP_TEXT = buildHelpText();

/**
 * Build the help text.
 *
 * The flags are listed by the four shapes the target's parser knows, and the
 * commands are the target's command tree.
 */
function buildHelpText(): string {
  const lines: string[] = [];
  lines.push('Usage: prricode [options] [prompt]');
  lines.push('       prricode <command> [options] [arguments]');
  lines.push('');

  lines.push('Options:');
  lines.push('  Flags that take a value:');
  for (const line of flagLines(VALUE_FLAG_NAMES)) lines.push(`    ${line}`);
  lines.push('  Flags that take a value and may be repeated');
  lines.push('  (every following non-flag token belongs to the flag):');
  for (const line of flagLines(REPEATABLE_FLAG_NAMES)) lines.push(`    ${line}`);
  lines.push('  Flags that take an optional value');
  lines.push('  (the next token, when it does not look like a flag):');
  for (const line of flagLines(OPTIONAL_VALUE_FLAG_NAMES)) lines.push(`    ${line}`);
  lines.push('  Flags that take no value:');
  for (const line of flagLines(BOOLEAN_FLAG_NAMES)) lines.push(`    ${line}`);
  lines.push('  Tokens that are commands, not flags:');
  for (const token of COMMAND_TOKEN_NAMES) {
    lines.push(`    ${token}`);
  }
  lines.push('');

  lines.push('Commands:');
  for (const line of commandLines(CLI_COMMAND_GROUPS, 1)) lines.push(`  ${line}`);
  lines.push('');

  lines.push(`${PROVIDER_EXTENSION_NOTICE} It is reached through the /provider command.`);
  lines.push('');
  return lines.join('\n');
}

/**
 * The lines a list of flags is listed by.
 *
 * The target declares `-n, --name <name>`: the two spellings are **one** flag,
 * and the vocabulary carries both because the target's scanner must know both.
 * The help shows such a flag **once**, with both spellings.
 */
function flagLines(names: readonly string[]): string[] {
  const set = new Set(names);
  const lines: string[] = [];
  for (const name of names) {
    const long = SHORT_FLAG_ALIASES.get(name);
    if (long !== undefined && set.has(long)) continue;
    lines.push(flagLine(name));
  }
  return lines;
}

/**
 * The line a flag is listed by.
 *
 * The short form comes first when the target declares one, and the argument
 * hint is the target's own.
 */
function flagLine(flag: string): string {
  const short = shortFormOf(flag);
  const hint = flagHintOf(flag);
  const name = short === undefined ? flag : `${short}, ${flag}`;
  return hint === undefined ? name : `${name} ${hint}`;
}

/** The short form of a flag, when the target declares one. */
function shortFormOf(flag: string): string | undefined {
  for (const [short, long] of SHORT_FLAG_ALIASES) {
    if (long === flag) return short;
  }
  return undefined;
}

/** The argument hint of a flag, when the target declares one. */
function flagHintOf(flag: string): string | undefined {
  const hint = FLAG_ARGUMENT_HINTS.get(flag);
  return hint;
}

/**
 * The lines the command tree is listed by.
 *
 * The root-level entries come first, in the order the tree holds them, and
 * each entry's own commands follow it, indented one level.
 */
function commandLines(groups: readonly CliCommand[], depth: number): string[] {
  const lines: string[] = [];
  const roots = CLI_COMMAND_TREE.filter((entry) => entry.path.length === 1);
  const ordered = [
    ...groups.filter((group) => group.path.length === 1),
    ...roots.filter((entry) => entry.kind === 'command'),
  ];
  for (const entry of ordered) {
    lines.push(commandLine(entry, depth));
    const children = CLI_COMMAND_TREE.filter(
      (child) => child.path.slice(0, -1).join(' ') === entry.path.join(' '),
    );
    for (const child of children) {
      lines.push(commandLine(child, depth + 1));
      const grandchildren = CLI_COMMAND_TREE.filter(
        (grandchild) => grandchild.path.slice(0, -1).join(' ') === child.path.join(' '),
      );
      for (const grandchild of grandchildren) {
        lines.push(commandLine(grandchild, depth + 2));
      }
    }
  }
  return lines;
}

/**
 * The line a command is listed by.
 *
 * The usage comes first, then the target's own description. A description
 * that carries line breaks is written on one line: the help is a list.
 */
function commandLine(entry: CliCommand, depth: number): string {
  const usage = entry.usage.padEnd(COMMAND_COLUMN);
  return `${'  '.repeat(depth)}${usage}  ${oneLine(entry.description)}`;
}

/** A description on one line. */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ');
}

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
   * The provider route the run's requests go to.
   *
   * It is the **active connection's** route when there is one, and the route
   * the environment selects when there is not.
   */
  route?: ProviderRoute;
  /**
   * The base URL the run's requests go to.
   *
   * It is the **active connection's** base URL when there is one, and the
   * route's own base URL when there is not.
   */
  baseUrl?: string;
  /**
   * The driver the run's requests are built with.
   *
   * It defaults to the driver of the route the environment selects.
   */
  driver?: ProviderDriver;
  /** The options the hook runner runs with. */
  hookOptions?: RunHooksOptions;
  /**
   * The settings document the `--settings` flag named.
   *
   * It is loaded by the run and handed to the settings loader as the
   * highest-precedence overlay, so the rules and the default mode it carries are
   * in force.
   */
  settingsDocument?: Record<string, unknown>;
  /**
   * The prompt a call that needs approval is put to.
   *
   * The runtime has no user interface of its own, so a call that no rule
   * covers is **refused** unless the caller supplies this seam. The
   * **interactive host** supplies it: the host is the only surface that has a
   * user to ask, and it hands the seam the question and receives the answer.
   *
   * A headless run supplies none, and its calls are refused the way the
   * runtime documents.
   */
  approveAsk?: (ctx: ToolContext, decision: PermissionDecision) => Promise<PermissionDecision | undefined>;
}

/** The session a run uses. */
export interface CommandSession {
  /** The session id. */
  sessionId: string;
  /** The runtime that runs the turn. */
  runtime: AgentRuntime;
  /**
   * The permission mode the session starts in.
   *
   * The member makes the start mode **observable**: a caller — and a test — can
   * see which mode the rules and the settings resolved to.
   */
  mode: PermissionMode;
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
   *
   * **An active connection wins over this member.** The manager's connections
   * are the point of the manager, so a run uses the active one; this member is
   * the seam a programmatic caller uses when the session has **no** connection.
   */
  credential?: string;
  /**
   * The provider route the run's requests go to.
   *
   * It defaults to the route the environment selects, and the **active
   * connection's** route wins over it.
   */
  route?: ProviderRoute;
  /**
   * The base URL the run's requests go to.
   *
   * It defaults to the route's own base URL, and the **active connection's**
   * base URL wins over it.
   */
  baseUrl?: string;
  /**
   * The interactive run.
   *
   * The interactive terminal UI is the **default**: an interactive run mounts
   * the app and drives the session through it. The member is the seam a caller
   * plugs its own host into, and the context it receives is the one the
   * command built — the same session context the headless path builds.
   */
  runInteractive?: (parsed: ParsedRunArgs, context: InteractiveContext) => Promise<number>;
  /**
   * The seam that mounts the app.
   *
   * It is the host's own seam, carried here so that the interactive run can be
   * mounted **without a terminal** — which is what makes the host observable.
   */
  mountApp?: MountApp;
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
    case 'manager':
      return runManagerCommand(parsed, { ...options, stdout, stderr });
    case 'command':
      // The resolved sinks come **last**: an own `stdout: undefined` in the
      // options must not clobber the default.
      return runSubcommand(parsed, { ...options, stdout, stderr });
    case 'run':
      return runRun(parsed, { ...options, stdout, stderr });
    default:
      return EXIT_USAGE;
  }
}

/**
 * Run the multi-provider manager.
 *
 * **Project extension.** The target has no provider manager. The manager's own
 * state — the connections and the catalogs — lives in one file under the
 * configuration directory, so a `provider add` in one invocation is visible to
 * the next one.
 */
async function runManagerCommand(
  parsed: ParsedManagerArgs,
  options: CommandOptions & { stdout: OutputSink; stderr: OutputSink },
): Promise<number> {
  const { stdout, stderr } = options;
  const configDir = options.configDir ?? defaultConfigDir(options.env ?? process.env);
  const statePath = join(configDir, PROVIDER_STATE_FILE);
  const { registry, catalogs } = await loadManagerState(statePath);
  // The surface the **parser** named is the surface that runs: the parser
  // consumed the `--provider` / `--catalog` token, so the command word has to
  // be put back for the manager's own dispatcher to see it. The **form** is
  // put back too, because the flag form's output is machine-readable and the
  // word form's is text.
  const lead = parsed.form === 'flag' ? `--${parsed.command}` : parsed.command;
  const result = await providerManagerCommand([lead, ...parsed.args], registry, {
    catalogs,
    statePath,
    env: options.env ?? process.env,
  });
  if (result.stdout.length > 0) stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  if (result.stderr.length > 0) stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  return result.exitCode;
}

/* -------------------------------------------------------------------------- */
/* The options this implementation does not implement                                     */
/* -------------------------------------------------------------------------- */

/**
 * The options this implementation recognises and does not implement.
 *
 * **Implementation choice.** The audit records the flag names and not what they do, and
 * this implementation does not implement them. A flag this implementation accepts and then ignores
 * is worse than one it refuses, so every one of them is **refused by the run**
 * with a message that names it — the same shape as the `--routine` command and
 * the background mode.
 *
 * The **parser** still knows every one of them: the parser's vocabulary is the
 * target's own — 85 value-taking flags, 45 boolean flags, 14 optional-value
 * flags, 10 command tokens and the three flags the target's scanner does not
 * count — and it parses each of them the way the target parses it.
 *
 * The table is a `Map`, so a flag name is **data**: a lookup can never resolve
 * an inherited member of `Object.prototype`.
 */
export const UNIMPLEMENTED_OPTIONS: ReadonlyMap<string, string> = new Map([
  ['--cloud', 'it names a cloud session, and this implementation has no cloud client'],
  ['--sdk-url', 'it names an SDK server, and this implementation has no SDK server'],
  ['--teleport', 'it moves a session to another machine, and this implementation cannot'],
  ['--max-turns', 'it caps the number of turns, and this implementation makes one turn'],
  ['--system-prompt', 'it replaces the system prompt, and this implementation has none'],
  ['--append-system-prompt', 'it appends to the system prompt, and this implementation has none'],
  ['--verbose', "it writes more about what the run does, and this implementation does not"],
  ['--debug', "it writes the run's debug trace, and this implementation does not"],
  ['--remote', 'it names a remote session, and this implementation has no remote client'],
  ['--environment', 'it names a cloud environment, and this implementation has no cloud client'],
  ['--betas', 'it names the beta flags of the request, and this implementation sends none'],
  ['--file', 'it names the files the session starts with, and this implementation starts with none'],
  ['--channels', 'it names the channels of the session, and this implementation has none'],
  ['--mcp-config', 'it names the MCP configuration files, and this implementation loads none'],
  [
    '--dangerously-load-development-channels',
    'it loads the development channels, and this implementation loads none',
  ],
  ['--name', 'it names the session, and this implementation has no name for one'],
  [
    '--no-session-persistence',
    'it keeps the session off the disk, and this implementation always writes the transcript',
  ],
  ['--forward-home-settings', 'it says whether this machine\'s settings go into a cloud session, and this implementation has no cloud client'],

  /* The rest of the target's value flags. */
  ['--prefill', 'it pre-fills the prompt input, and this implementation does not'],
  ['--prefill-b64', 'it pre-fills the prompt input, and this implementation does not'],
  ['--deep-link-repo', 'it names a deep-link repository, and this implementation has no deep links'],
  ['--deep-link-last-fetch', 'it names a deep-link fetch time, and this implementation has no deep links'],
  ['--deep-link-cwd-b64', 'it names a deep-link working directory, and this implementation has no deep links'],
  ['--handle-uri', 'it handles a URI argument, and this implementation has no URI handler'],
  ['--managed-settings', 'it names managed settings, and this implementation has no managed settings tier'],
  ['--setting-sources', 'it names the settings tiers to load, and this implementation loads them all'],
  ['--client-data-url', 'it names a client data url, and this implementation has none'],
  ['--watch-artifact', 'it names an artifact to watch, and this implementation watches none'],
  [
    '--watch-artifact-no-autoreact',
    'it names an artifact to watch, and this implementation watches none',
  ],
  ['--team-name', 'it names a team, and this implementation has no teams'],
  ['--agent-id', 'it names a background agent, and this implementation has none'],
  ['--agent-name', 'it names a background agent, and this implementation has none'],
  ['--agent-color', 'it colours a background agent, and this implementation has none'],
  ['--parent-session-id', 'it names a parent session, and this implementation has no teammate sessions'],
  ['--agent-type', 'it names an agent type, and this implementation has no agent registry'],
  ['--agent', 'it names the agent, and this implementation has no agent registry'],
  ['--routine', 'it names a routine, and this implementation has no routines'],
  ['--effort', 'it sets the effort level, and this implementation has none'],
  ['--fast-mode', 'it turns fast mode on or off, and this implementation has no fast mode'],
  [
    '--inherit-permission-mode',
    'it inherits a permission mode, and this implementation has no teammate sessions',
  ],
  ['--proactivity', 'it sets the proactivity level, and this implementation has none'],
  ['--debug-file', 'it names a debug trace file, and this implementation writes no debug trace'],
  ['--system-prompt-file', 'it reads the system prompt from a file, and this implementation has none'],
  [
    '--append-system-prompt-file',
    'it appends a system prompt from a file, and this implementation has none',
  ],
  [
    '--system-prompt-snapshot',
    'it records the system prompt once, and this implementation has no system prompt',
  ],
  [
    '--append-subagent-system-prompt',
    'it appends to a subagent\'s system prompt, and this implementation has none',
  ],
  [
    '--append-subagent-system-prompt-file',
    'it appends to a subagent\'s system prompt, and this implementation has none',
  ],
  [
    '--plan-mode-instructions',
    'it sets the plan mode instructions, and this implementation has none',
  ],
  [
    '--permission-prompt-tool',
    'it names the tool that asks for permission, and this implementation asks in its own host',
  ],
  [
    '--permission-prompts',
    'it names where the permission prompts go, and this implementation asks in its own host',
  ],
  ['--json-schema', 'it constrains the answer to a schema, and this implementation does not'],
  ['--fallback-model', 'it names a fallback model, and this implementation has one model'],
  ['--advisor', 'it names an advisor model, and this implementation has none'],
  ['--agents', 'it names the agent definitions, and this implementation has no agent registry'],
  ['--plugin-dir', 'it names a plugin directory, and this implementation has no plugins'],
  ['--plugin-dir-no-mcp', 'it names a plugin directory, and this implementation has no plugins'],
  ['--plugin-url', 'it names a plugin url, and this implementation has no plugins'],
  [
    '--remote-control-session-name-prefix',
    'it names a remote control session prefix, and this implementation has no remote control',
  ],
  ['--exec', 'it runs a command instead of a prompt, and this implementation runs a prompt'],
  ['--thinking', 'it sets the thinking mode, and this implementation has no thinking mode'],
  ['--thinking-display', 'it sets the thinking display, and this implementation has none'],
  [
    '--max-thinking-tokens',
    'it caps the thinking tokens, and this implementation has no thinking budget',
  ],
  ['--max-budget-usd', "it caps the run's cost, and this implementation does not measure it"],
  ['--task-budget', 'it caps a task\'s tokens, and this implementation does not measure them'],
  [
    '--autocompact',
    'it sets the auto-compaction window, and this implementation compacts on demand',
  ],
  ['--rewind-files', 'it rewinds the files to a message, and this implementation cannot'],
  ['--resume-drops-turn', 'it drops a turn from a resume, and this implementation resumes whole sessions'],
  ['--workload', 'it names a workload, and this implementation has none'],
  ['--teammate-mode', 'it sets the teammate mode, and this implementation has no teammates'],
  [
    '--messaging-socket-path',
    'it names a messaging socket, and this implementation has none',
  ],
  ['--pool', 'it names a pool, and this implementation has none'],
  ['--ref', 'it names a git ref for a cloud session, and this implementation has no cloud client'],
  ['--on-branch', 'it names a branch for a cloud session, and this implementation has no cloud client'],
  ['--correlation-id', 'it names a correlation id, and this implementation sends none'],
  [
    '--project-config-root',
    'it names the project configuration root, and this implementation resolves it from the working directory',
  ],
  [
    '--attach-serve',
    'it attaches a serve-only helper to a cloud session, and this implementation has no cloud client',
  ],

  /* The target's optional-value flags this implementation does not act on. */
  ['--from-pr', 'it resumes a pull request, and this implementation has no pull request surface'],
  ['--worktree', 'it names a worktree, and this implementation has no worktrees'],
  ['--project', 'it names a project, and this implementation has no cloud projects'],
  [
    '--remote-control',
    'it names a remote control session, and this implementation has no remote control',
  ],
  ['--rc', 'it names a remote control session, and this implementation has no remote control'],
  [
    '--prompt-suggestions',
    'it turns prompt suggestions on or off, and this implementation has none',
  ],

  /* The target's boolean flags this implementation does not act on. */
  [
    '--debug-to-stderr',
    "it writes the run's debug trace to stderr, and this implementation writes no debug trace",
  ],
  ['--bare', 'it starts the session without the project context, and this implementation does not'],
  ['--safe-mode', 'it restricts the session, and this implementation has no safe mode'],
  ['--init', 'it runs the setup hooks with the init trigger, and this implementation has no setup hooks'],
  [
    '--maintenance',
    'it runs the setup hooks with the maintenance trigger, and this implementation has no setup hooks',
  ],
  [
    '--include-hook-events',
    "it writes the hook events to the output stream, and this implementation's output stream carries none",
  ],
  [
    '--include-partial-messages',
    "it writes the partial messages to the output stream, and this implementation's output stream carries none",
  ],
  [
    '--forward-subagent-text',
    'it forwards the subagent text to the output stream, and this implementation has no subagent output',
  ],
  ['--session-mirror', 'it mirrors the transcript to stdout, and this implementation does not'],
  ['--await-claim', 'it waits for a session claim, and this implementation has no background sessions'],
  [
    '--await-initialize',
    'it waits for the session initialization, and this implementation has no background sessions',
  ],
  [
    '--allow-dangerously-skip-permissions',
    'it makes the bypass mode available, and this implementation\'s modes are fixed',
  ],
  [
    '--replay-user-messages',
    'it replays the user messages to stdout, and this implementation does not',
  ],
  [
    '--host-auth-is-org-sign-in',
    "it says the host's sign-in is an organisation sign-in, and this implementation has no host sign-in",
  ],
  [
    '--enable-auth-status',
    'it reports the authentication status, and this implementation has no account sign-in',
  ],
  [
    '--restricted',
    'it starts the session in restricted mode, and this implementation restricts through the settings instead',
  ],
  [
    '--allow-other-models',
    'it offers the models this version does not know, and this implementation knows its own',
  ],
  [
    '--exclude-dynamic-system-prompt-sections',
    'it drops the dynamic system prompt sections, and this implementation has no system prompt',
  ],
  [
    '--include-unsupported-models',
    'it offers the unsupported models, and this implementation knows its own',
  ],
  ['--deep-link-origin', 'it names a deep-link origin, and this implementation has no deep links'],
  ['--reply-on-resume', 'it replies on a resume, and this implementation resumes silently'],
  ['--ide', 'it opens the IDE integration, and this implementation has no IDE integration'],
  ['--desktop', 'it continues in the desktop app, and this implementation has no desktop app'],
  [
    '--strict-mcp-config',
    'it uses only the MCP servers the command line names, and this implementation loads none',
  ],
  [
    '--disable-slash-commands',
    'it disables the slash commands, and this implementation always registers them',
  ],
  ['--chrome', 'it opens the browser integration, and this implementation has none'],
  ['--no-chrome', 'it opens the browser integration, and this implementation has none'],
  ['--tmux', 'it runs the session in tmux, and this implementation does not'],
  [
    '--enable-auto-mode',
    'it enables the auto mode, and this implementation\'s auto mode is chosen by the start mode',
  ],
  ['--brief', 'it asks for a brief answer, and this implementation has no brief mode'],
  ['--ax-screen-reader', 'it drives the screen reader, and this implementation does not'],
  ['--plan-mode-required', 'it requires the plan mode, and this implementation does not'],
  ['--hard-fail', 'it fails the run on the first error, and this implementation does not'],
]);

/**
 * The option the run refuses, when it names one this implementation does not implement.
 */
function unimplementedOptionOf(parsed: ParsedRunArgs): string | undefined {
  for (const [name, reason] of UNIMPLEMENTED_OPTIONS) {
    if (!parsed.flags.has(name)) continue;
    if (name === '--cloud' && parsed.cloudTarget !== undefined) {
      return `The '--cloud' option is not implemented here yet: it names ${describeCloudTarget(parsed.cloudTarget)}, and this implementation has no cloud client.`;
    }
    return `The '${name}' option is not implemented here yet: ${reason}.`;
  }
  return undefined;
}

/**
 * How a cloud target is described.
 *
 * The three shapes the audit records — a **session id**, a **cloud session
 * ref** and a **URI argument** — are named, so that the message says what the
 * implementation was handed.
 */
function describeCloudTarget(target: CloudTarget): string {
  switch (target.kind) {
    case 'session-id':
      return 'a session id';
    case 'cloud-ref':
      return 'a cloud session ref';
    case 'uri':
      return 'a URI argument';
    default:
      return 'a cloud session';
  }
}

/* -------------------------------------------------------------------------- */
/* The commands                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The capability each command needs and this implementation does not have.
 *
 * **Implementation choice.** The target's own tree says what each command
 * **does**; it does not say what a clone must have to do it. The capability is
 * what this implementation would need, and the refusal names it — the same
 * shape the in-session slash commands use.
 *
 * The key is the command's **path**: the group a command lives in when the
 * command has no entry of its own.
 *
 * The table is a `Map`, so a path is **data**: the lookup can never resolve an
 * inherited member of `Object.prototype`.
 */
const COMMAND_CAPABILITIES: ReadonlyMap<string, string> = new Map([
  /* The groups. */
  ['plugin', 'this implementation has no plugin manager'],
  ['mcp', 'this implementation has no MCP server configuration surface'],
  ['auth', 'this implementation has no account sign-in'],
  ['auto-mode', 'this implementation has no auto mode classifier configuration'],
  ['sandbox', 'this implementation has no Windows sandbox installer'],
  ['project', 'this implementation has no project state purge'],

  /* The root-level commands. */
  ['gateway', 'this implementation has no enterprise gateway'],
  ['setup-token', 'this implementation has no long-lived token setup'],
  ['agents', 'this implementation has no background agent registry'],
  ['ultrareview', 'this implementation has no cloud-hosted review'],
  ['remote-control', 'this implementation has no remote control session'],
  ['doctor', 'this implementation has no installation doctor'],
  ['apply-project-settings', 'this implementation has no cloud settings acceptance'],
  ['update', 'this implementation has no autoupdater'],
  ['install', 'this implementation has no native build installer'],
  ['import', 'this implementation has no agent configuration importer'],
  ['import-conversations', 'this implementation has no conversation importer'],
  ['purge', 'this implementation has no project state purge'],

  /* The hidden editor commands. */
  ['edit-hook', 'this implementation has no editor bridge'],
  ['edit-permission-rules', 'this implementation has no editor bridge'],
  ['edit-memory-settings', 'this implementation has no editor bridge'],
  ['edit-skill-overrides', 'this implementation has no editor bridge'],
  ['edit-sandbox-settings', 'this implementation has no editor bridge'],
  ['design-login', 'this implementation has no editor bridge'],
  ['edit-chrome-settings', 'this implementation has no editor bridge'],
  ['drop-worktree-registrations', 'this implementation has no editor bridge'],

  /* The session-management subcommands. */
  ['attach', 'this implementation has no live background session to attach to'],
  ['logs', 'this implementation has no live background session to read the log of'],
  ['stop', 'this implementation has no live background session to stop'],
  ['kill', 'this implementation has no live background session to kill'],
  ['respawn', 'this implementation has no live background session to respawn'],
  ['rm', 'this implementation has no session store that removes a session'],
]);

/**
 * The capability a command needs.
 *
 * A command's own entry wins; otherwise the **group** it lives in decides, and
 * otherwise the command is refused without naming one.
 */
function capabilityOf(path: readonly string[]): string | undefined {
  const own = COMMAND_CAPABILITIES.get(path.join(' '));
  if (own !== undefined) return own;
  for (let depth = path.length - 1; depth > 0; depth -= 1) {
    const group = COMMAND_CAPABILITIES.get(path.slice(0, depth).join(' '));
    if (group !== undefined) return group;
  }
  return undefined;
}

/**
 * Run one of the target's commands.
 *
 * The command is resolved through the **command tree**, so the path the user
 * typed decides what runs. A **group** with no command of its own writes the
 * group's help; a command this implementation does not have writes a refusal
 * that names the capability it would need.
 */
async function runSubcommand(
  parsed: ParsedCommandArgs,
  context: RunContext,
): Promise<number> {
  const entry = cliCommandOf(parsed.path);

  if (entry === undefined) {
    context.stderr.write(`Error: unknown command '${parsed.path.join(' ')}'.\n`);
    return EXIT_USAGE;
  }

  if (entry.kind === 'group') {
    // **Implementation choice.** The target's own dispatcher writes the group's
    // help to the error stream and exits with `1` when the group is named with
    // no command of its own. The wording is this implementation's own.
    const unknown = parsed.args[0];
    if (unknown !== undefined) {
      context.stderr.write(`Error: unknown command '${unknown}' for '${entry.usage}'.\n`);
      return EXIT_USAGE;
    }
    context.stderr.write(groupHelpOf(entry));
    return EXIT_FAILURE;
  }

  const capability = capabilityOf(entry.path);
  if (capability === undefined) {
    context.stderr.write(
      `The '${entry.usage}' command is not implemented here yet.\n`,
    );
    return EXIT_FAILURE;
  }
  context.stderr.write(
    `The '${entry.usage}' command is not implemented here yet: ${capability}.\n`,
  );
  return EXIT_FAILURE;
}

/**
 * The help of a group.
 *
 * The group, its own commands and their own commands — the tree the target
 * registers under that group.
 */
function groupHelpOf(group: CliCommand): string {
  const lines: string[] = [];
  lines.push(`Usage: prricode ${group.usage} <command> [options]`);
  lines.push('');
  lines.push(group.description);
  lines.push('');
  const children = CLI_COMMAND_TREE.filter(
    (entry) => entry.path.slice(0, -1).join(' ') === group.path.join(' '),
  );
  for (const child of children) {
    lines.push(commandLine(child, 1));
    const grandchildren = CLI_COMMAND_TREE.filter(
      (entry) => entry.path.slice(0, -1).join(' ') === child.path.join(' '),
    );
    for (const grandchild of grandchildren) {
      lines.push(commandLine(grandchild, 2));
    }
  }
  lines.push('');
  return lines.join('\n');
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

/**
 * The active connection of a run, and what it resolved to.
 *
 * **Project extension.** The target has no user-managed registry of provider
 * connections: its route selector yields exactly one active route from
 * environment flags, and the credential comes from the environment. The
 * connection below is this implementation's own product surface, and a run
 * that uses it is a run of this implementation — not a claim about the target.
 */
interface RunConnection {
  /** The route the run's requests go to. */
  route: ProviderRoute;
  /** The base URL the run's requests go to. */
  baseUrl: string;
  /** The credential the run's requests carry. */
  credential: string;
}

/**
 * Resolve the active connection of a run.
 *
 * `undefined` when the connection registry has **no** enabled connection: a
 * run with no connection is exactly a run with no connection, and the route the
 * environment selects is the one it uses.
 *
 * A connection that **cannot** be resolved is an error, and the error names
 * the connection: the user is told *which* entry is broken rather than being
 * told that "something" is. The credential itself is never in the message.
 *
 * **The secret comes from one place only.** `resolveConnectionCredential` is
 * this implementation's single path from a reference to a value, and it runs
 * the untrusted-endpoint guard first, so a secret can never reach a
 * user-supplied host by accident.
 */
async function resolveRunConnection(
  configDir: string,
  env: NodeJS.ProcessEnv,
): Promise<RunConnection | undefined> {
  const statePath = join(configDir, PROVIDER_STATE_FILE);
  const { registry } = await loadManagerState(statePath);
  const active = activeConnectionOf(registry);
  if (active === undefined) return undefined;

  // The manager's own check: an active connection whose credential cannot be
  // resolved is not usable, and the refusal names the connection and the
  // reason.
  await resolveActiveConnection(registry, { env });

  const resolved = await resolveConnectionCredential(active, env);
  if (!resolved.present || resolved.value === undefined) {
    throw new Error(`the active provider connection "${active.id}" has no usable credential`);
  }

  const endpoint = resolveConnectionEndpoint(active, env);
  return {
    route: active.route,
    baseUrl: endpoint.baseUrl,
    credential: resolved.value,
  };
}

/** Run the parsed arguments. */
async function runRun(parsed: ParsedRunArgs, context: RunContext): Promise<number> {
  if (parsed.background) {
    context.stderr.write('The background mode is not implemented here yet.\n');
    return EXIT_FAILURE;
  }

  // The options this implementation recognises and does not implement. They are refused
  // **before** anything is set up, so that a flag this implementation cannot honour never
  // reaches a provider request.
  const unimplemented = unimplementedOptionOf(parsed);
  if (unimplemented !== undefined) {
    context.stderr.write(`${unimplemented}\n`);
    return EXIT_FAILURE;
  }

  const cwd = context.cwd ?? process.cwd();
  const env = context.env ?? process.env;
  // The configuration root honours `CLAUDE_CONFIG_DIR`, the way the target's
  // does — the variable is the target's, so it keeps the target's name.
  const configDir = context.configDir ?? defaultConfigDir(env);
  const store = createSessionStore({ configDir });

  // The settings file the `--settings` flag named. It is loaded **before** the
  // session, because the session's rules and its start mode come from it.
  const settingsFile = loadSettingsFileOf(parsed.settingsFile);
  if (settingsFile.kind === 'error') {
    context.stderr.write(`${settingsFile.message}\n`);
    return EXIT_USAGE;
  }

  // The session: continued, resumed, or new. The resolution runs **before** the
  // prompt is read, so a failed session lookup is reported with the target's own
  // message rather than with a complaint about a missing prompt.
  const resolved = await resolveSession(parsed, { store, cwd, configDir, context, env });
  if (resolved === undefined) return EXIT_FAILURE;

  // **The active connection.** The provider manager exists so that a run can
  // talk to a configured endpoint with a configured credential, and a run that
  // ignores the active connection makes the manager inert. The connection's
  // **route**, **base URL** and **credential** are therefore the run's.
  //
  // A registry with **no** enabled connection leaves the run exactly as it was
  // — the route the environment selects, and no credential — and a connection
  // that **cannot** be resolved is **reported**, never silently ignored.
  let connection: RunConnection | undefined;
  try {
    connection = await resolveRunConnection(configDir, env);
  } catch (error) {
    context.stderr.write(`${messageOf(error)}\n`);
    return EXIT_FAILURE;
  }

  const hooks = context.hooks ?? createHookRegistry();
  const factory = context.createSession ?? createCommandSession;

  // **The session's context.** It is built **once**, here, and both paths use
  // it: the headless run and the interactive session therefore get the same
  // rules, the same mode, the same tools and the same two hook seams, and the
  // two cannot drift.
  const sessionContext: SessionContext = {
    parsed,
    sessionId: resolved.sessionId,
    cwd,
    configDir,
    env,
    hooks,
    store: resolved.store,
    ...(resolved.discarded === undefined ? {} : { discarded: resolved.discarded }),
    // The **active connection** wins over the programmatic seam: the manager's
    // connections are the user's own configuration, and a run that ignored them
    // would make the manager inert.
    ...(connection === undefined
      ? {
          ...(context.credential === undefined ? {} : { credential: context.credential }),
          ...(context.route === undefined ? {} : { route: context.route }),
          ...(context.baseUrl === undefined ? {} : { baseUrl: context.baseUrl }),
        }
      : {
          credential: connection.credential,
          route: connection.route,
          baseUrl: connection.baseUrl,
        }),
    ...(context.driver === undefined ? {} : { driver: context.driver }),
    ...(context.hookOptions === undefined ? {} : { hookOptions: context.hookOptions }),
    ...(settingsFile.kind === 'ok' ? { settingsDocument: settingsFile.document } : {}),
  };

  if (!parsed.headless) {
    // **The interactive run.** The host owns the state, mounts the app and
    // drives the session through it. The refusal is the **fallback**: the host
    // refuses only when the app cannot mount, and the command's own seam — a
    // caller that supplies one — wins over the host.
    const runInteractive = context.runInteractive ?? runInteractiveSession;
    return runInteractive(parsed, {
      session: sessionContext,
      createSession: factory,
      ...(context.model === undefined ? {} : { model: context.model }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...(context.isTTY === undefined ? {} : { isTTY: context.isTTY }),
      ...(context.mountApp === undefined ? {} : { mountApp: context.mountApp }),
      stderr: context.stderr,
    });
  }

  const session = await factory(sessionContext);

  // `--init-only` sets the session up and stops: no turn is made and no prompt
  // is read.
  if (parsed.initOnly) {
    await store.create({ cwd, sessionId: session.sessionId });
    return EXIT_SUCCESS;
  }

  // The prompt: the positional argument, or the standard input.
  //
  // The `stream-json` input format decides where the prompt comes from: the
  // standard input carries **JSON documents**, and their text is the prompt.
  // **Implementation choice**: the stream-json input wins over a positional argument, and
  // this implementation's one turn carries the text of every document.
  let prompt = parsed.prompt;
  if (parsed.inputFormat === 'stream-json') {
    const read = context.readPrompt ?? readStandardInput;
    const stream = readStreamJsonInput(await read());
    if (stream.kind === 'invalid') {
      context.stderr.write(`${stream.message}\n`);
      return EXIT_USAGE;
    }
    prompt = stream.prompt;
    if (prompt.trim() === '') {
      context.stderr.write('Error: no prompt was given.\n');
      return EXIT_USAGE;
    }
  } else if (prompt === undefined) {
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
      model: resolveModel(parsed, context),
      runtime: session.runtime,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...(context.now === undefined ? {} : { now: context.now }),
      ...(context.telemetry === undefined ? {} : { telemetry: context.telemetry }),
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
 *
 * The telemetry the run delivers is the **target's model**: an event name and
 * a metadata object. The run's own seam — the `telemetry` option — receives
 * the record the session module raised, so a caller sees the same flat shape
 * it always did, and the emitter's guard and its traffic mode apply in
 * between.
 */
async function resolveSession(
  parsed: ParsedRunArgs,
  options: {
    store: SessionStore;
    cwd: string;
    configDir: string;
    context: RunContext;
    env: NodeJS.ProcessEnv;
  },
): Promise<ResolvedSession | undefined> {
  const { store, cwd, configDir, context, env } = options;
  const emitter = new TelemetryEmitter(env);
  const deliver = context.telemetry;
  if (deliver !== undefined) {
    emitter.attachSink({
      logEvent: (name, properties) => {
        deliver({ name, ...properties });
      },
    });
  }
  const telemetry =
    deliver === undefined
      ? undefined
      : (event: unknown) => {
          const record = event as Record<string, unknown> & { name: string };
          emitter.logEvent(record.name, propertiesOf(record));
        };

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
    // **Observed** (audit §2.10): "A **session id** matches
    // `/^(?:session|cse)_[A-Za-z0-9_]+$/`; a path is scanned for such a
    // segment." A `--resume` that names a **path** therefore names the session
    // the path holds.
    const target = resumeTargetOf(parsed.resume);
    const result = await resumeSession({
      store,
      cwd,
      // The print path is the headless path, and the print path is what emits
      // the target's `tengu_resume_print` event.
      entrypoint: 'print',
      target,
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
 * The session a `--resume` names.
 *
 * **Observed** (audit §2.10): a **session id** matches
 * `/^(?:session|cse)_[A-Za-z0-9_]+$/`, and "a path is scanned for such a
 * segment". So a `--resume` that names a **path** names the session the path
 * holds: `agent --resume /x/session_abc123` resumes `session_abc123`.
 *
 * A path to a **transcript** (`…/session_abc123.jsonl`) is left alone: the
 * session module reads that file directly, and it does so whether or not the
 * session is in the store.
 */
function resumeTargetOf(value: string): string {
  if (isSessionId(value)) return value;
  if (value.endsWith('.jsonl')) return value;
  return findSessionIdInPath(value) ?? value;
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
 *
 * The CLI is the **only** production caller of `resolveStartMode`, so the
 * plan's global constraint — that the built-in default is subject to **three**
 * availability overrides — binds **here**. They are threaded from the merged
 * settings document; see {@link startModeAvailabilityOf}.
 */
export async function createCommandSession(context: SessionContext): Promise<CommandSession> {
  const { cwd, configDir, env, parsed } = context;

  const settings = loadSettings({
    cwd,
    configDir,
    // The restriction is read with the target's **boolean** rule, the rule
    // `isPersonalConfigRestricted` owns.
    restricted: isPersonalConfigRestricted(env),
    // **Implementation choice**: the settings file `--settings` named is the
    // highest-precedence overlay of the tiered settings.
    ...(context.settingsDocument === undefined ? {} : { flagSettings: context.settingsDocument }),
  });
  const permissions = permissionsFromSettings(settings, { cwd, configDir, env });

  const mode = startModeOf(
    parsed,
    permissions.defaultMode,
    !parsed.headless,
    startModeAvailabilityOf(settings.tiers),
  );
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
    // **The sandbox policy.** The settings document the loader merged carries
    // it, and the `Bash` tool routes its command through the sandbox with it.
    // Without this line every command runs unconfined on the host.
    //
    // The policy is **required** on the loader's result, so a configured
    // session always has one. A platform the sandbox does not support, or a
    // sandbox the user switched off, runs the command **unconfined** and says
    // so; only a missing backend with `failIfUnavailable` refuses it.
    sandboxPolicy: settings.sandboxPolicy,
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

  // The **route** and the **base URL** the run's requests go to. They are the
  // **active connection's** when the session has one, and the ones the
  // environment selects when it has not.
  const route = context.route ?? selectRoute(env);
  const driver = context.driver ?? driverFor(route);
  const baseUrl = context.baseUrl ?? resolveBaseUrl(route, env).baseUrl;

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
    // **The two seams, as the runtime's own dependencies.** The runtime's
    // default permission options carry the seam members, and this module hands
    // it the same two seams here: the seam reaches the runtime's service
    // whichever of the two the runtime consults, and the runtime's **default**
    // path — the one a caller that supplies no `permissionOptions` takes — is
    // gated by them too.
    preToolUseHook: seams.preToolUse,
    hook: seams.permissionRequest,
    cwd,
    // **The approval seam.** The interactive host supplies it, and the host is
    // the only surface that has a user to ask: the seam is how a call that no
    // rule covers reaches the app's approval prompt, and how the user's answer
    // reaches the call. A headless run supplies none, and its calls are
    // refused rather than run.
    ...(context.approveAsk === undefined ? {} : { approveAsk: context.approveAsk }),
  });

  return { sessionId: context.sessionId, runtime, mode };
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
 * The availability signals the built-in start mode is subject to.
 *
 * **The plan's global constraint** names three of them: `disableAutoMode:
 * "disable"` in a settings file, a HIPAA-configured session, and a session
 * where auto mode is unavailable.
 */
export interface StartModeAvailability {
  /** Whether a policy disabled auto mode (`disableAutoMode: "disable"`). */
  autoDisabledByPolicy: boolean;
  /** Whether the session is HIPAA-configured. */
  hipaaConfigured: boolean;
  /** Whether auto mode is available for this session at all. */
  autoAvailable: boolean;
}

/**
 * Whether auto mode is available.
 *
 * **Reported, not hidden.** This implementation has **no** availability probe for the auto
 * mode: the mode exists in the permission layer — where it fails closed when no
 * classifier is supplied — and nothing in the CLI can say that the mode is
 * unavailable. The signal is therefore the constant `true`, and this third
 * override never fires. The compatibility matrix records it.
 */
const AUTO_MODE_AVAILABLE = true;

/**
 * The availability signals the settings document carries.
 *
 * **Implementation choice.** The plan names the three overrides but not the keys two of
 * them live under, so this implementation reads:
 *
 *   - `disableAutoMode` — the **merged** settings document's top-level member.
 *     The value `"disable"` disables auto mode; any other value does not.
 *   - `hipaa` — the merged document's top-level member. `true`, or an object
 *     whose `enabled` member is `true`, marks a HIPAA-configured session. **The
 *     key is this implementation's own**: the audit names the override and not where it
 *     lives.
 *   - the auto mode's **availability** — the constant {@link AUTO_MODE_AVAILABLE}.
 *
 * The merge is the settings loader's own: the tiers are folded from the lowest
 * precedence to the highest, so the **highest** tier that defines the key wins.
 */
export function startModeAvailabilityOf(
  tiers: ReadonlyMap<SettingsSource, SettingsTier>,
): StartModeAvailability {
  const disableAutoMode = mergedTopLevelKey(tiers, 'disableAutoMode');
  const hipaa = mergedTopLevelKey(tiers, 'hipaa');
  return {
    autoDisabledByPolicy: disableAutoMode === 'disable',
    hipaaConfigured: hipaaConfiguredOf(hipaa),
    autoAvailable: AUTO_MODE_AVAILABLE,
  };
}

/**
 * The value a **top-level** key has in the merged settings document.
 *
 * The tiers are read in the loader's own precedence order (`TIER_PRECEDENCE`,
 * highest first), and the **first** tier that defines the key wins — the rule
 * the loader's own block-wise merge follows for a key that is not a block.
 *
 * The lookup is an **own-property** check, so a key that names an inherited
 * member of `Object.prototype` is reported as absent rather than resolving to
 * the inherited member.
 */
/**
 * The model a run uses.
 *
 * The arguments win over the caller's, and this implementation's own default is
 * the last resort. **One** resolution, so the headless and the interactive
 * paths cannot drift apart.
 */
export function resolveModel(
  parsed: { model?: string | undefined },
  context: { model?: string | undefined },
): string {
  return parsed.model ?? context.model ?? DEFAULT_MODEL;
}

function mergedTopLevelKey(
  tiers: ReadonlyMap<SettingsSource, SettingsTier>,
  key: string,
): unknown {
  // Fold from the **lowest** tier upwards — the order the target composes its
  // effective settings in — and let the per-key value rule decide what the
  // value becomes. An array setting two tiers define is the **concatenation**
  // of both, and the two named object keys are shallow-merged one level; every
  // other value is the higher tier's, whole.
  let value: unknown;
  let found = false;
  for (const source of [...TIER_PRECEDENCE].reverse()) {
    const tier = tiers.get(source);
    if (tier === undefined) continue;
    const document = documentOf(tier);
    if (typeof document !== 'object' || document === null) continue;
    const record = document as Record<string, unknown>;
    if (!Object.hasOwn(record, key)) continue;
    value = found ? mergeSettingsValue(value, record[key], key) : record[key];
    found = true;
  }
  return found ? value : undefined;
}

/** Whether a `hipaa` settings member marks a HIPAA-configured session. */
function hipaaConfiguredOf(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, 'enabled')) return false;
  return record['enabled'] === true;
}

/**
 * The mode a session starts in.
 *
 * The precedence is the target's: the `--permission-mode` flag beats
 * `permissions.defaultMode`, which beats the built-in default, and `auto` and
 * `bypassPermissions` written into a settings file are ignored — only the flag
 * may select them. The built-in default is `auto` for a terminal session and
 * `default` for a headless one, subject to the three availability overrides.
 */
export function startModeOf(
  parsed: ParsedRunArgs,
  settingsDefault: PermissionMode | undefined,
  interactive: boolean,
  availability: StartModeAvailability,
): PermissionMode {
  if (parsed.dangerouslySkipPermissions) return 'bypassPermissions';
  const flag = parsed.permissionMode as PermissionMode | undefined;
  return resolveStartMode({
    ...(flag === undefined ? {} : { flag }),
    ...(settingsDefault === undefined ? {} : { settingsDefault }),
    autoAvailable: availability.autoAvailable,
    autoDisabledByPolicy: availability.autoDisabledByPolicy,
    hipaaConfigured: availability.hipaaConfigured,
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
/* The settings file                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The outcome of loading the settings file `--settings` named.
 *
 * The two cases are: the file was read and it is a settings document, or the
 * file could not be used. The second is an **argument error**: the command line
 * named a file the run cannot honour, and the run says so rather than quietly
 * using a different configuration.
 */
export type SettingsFileLoad =
  /** The file was read. */
  | { kind: 'ok'; document: Record<string, unknown> }
  /** The file could not be read. */
  | { kind: 'error'; message: string };

/**
 * Load the settings file `--settings` named.
 *
 * **Implementation choice.** The audit records the flag name and not what it does. The
 * implementation reads the file, validates it against the settings schema and hands it
 * to the settings loader as the **highest-precedence overlay** of the tiered
 * settings — so the rules, the default mode and the start-mode overrides it
 * carries are in force.
 */
export function loadSettingsFileOf(filePath: string | undefined): SettingsFileLoad {
  if (filePath === undefined) return { kind: 'ok', document: {} };

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    return {
      kind: 'error',
      message: `Error: --settings ${filePath} could not be read: ${messageOf(error)}.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'error', message: `Error: --settings ${filePath} is not valid JSON.` };
  }

  const result = parseSettingsDocument(parsed);
  if (!result.ok) {
    return {
      kind: 'error',
      message: `Error: --settings ${filePath} failed validation: ${result.issues.join('; ')}.`,
    };
  }

  return { kind: 'ok', document: result.value };
}

/* -------------------------------------------------------------------------- */
/* The helpers                                                                 */
/* -------------------------------------------------------------------------- */

/** The message of a thrown value. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'an unknown error';
}

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

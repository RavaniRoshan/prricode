/**
 * The command-line surface: the parser, the flag vocabulary, the command tree
 * and the shapes the parse produces.
 *
 * Evidence: the REA record `/home/shiva/opt/reference-agent-rea/analysis/findings-untouched-surfaces.md`
 * §3.4 ("The CLI flags — the complete list") and §G3 ("The CLI command tree"), and the
 * target's own source: `chunk-0y0ptpy9.js` (the flag registry and the parser),
 * `chunk-t0c9yez3.js` (the root command's option declarations), `chunk-64447bxa.js`
 * (the `plugin` tree), `chunk-dmqgh1rk.js` (the `mcp` tree), `chunk-9y799w6p.js`
 * (the `auth`, `auto-mode`, `sandbox` and `project` trees and the root commands) and
 * `chunk-mancccdx.js` (the hidden editor commands).
 *
 * The `CC-031` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## The reading is a **parser**, not a pattern
 *
 * The target's flag registry is an **object literal per group**, and the record's
 * lists are the *members* of those literals. Reading the members is not enough: the
 * target's own parser says what each member **does**, and the parser is the contract.
 *
 * The parser lives in `chunk-0y0ptpy9.js` and is five functions and five sets:
 *
 *   - `l` (`:1112`) — **85** flags that take a value;
 *   - `LBr` (`:2671`) — **11** of those are **repeatable**;
 *   - `d` (`:2871`) — **14** flags that take an **optional** value;
 *   - `f` (`:4539`) — **45** boolean flags;
 *   - `m` (`:4441`) — **10** tokens that are **commands**, not flags;
 *   - `g` (`:4383`) — **6** session-management subcommands;
 *   - `h` (`:5387`) — **3** value-taking flags the scanner does **not** count as
 *     flags (`--exec`, `-m`, `--handle-uri`).
 *
 * The functions are reproduced here, one for one:
 *
 * | The target's | What it does | This implementation's |
 * |---|---|---|
 * | `ejt(e)` | a token looks like a flag when it is longer than one character and starts with `-` | {@link isFlagToken} |
 * | `Ibt(e, n)` | the index of the **last** token the flag at `n` owns | {@link flagValueEnd} |
 * | `x(e)` | whether a token is a **flag** (a boolean, a value flag that is not in `h`, or an optional-value flag) | {@link isKnownFlag} |
 * | `S(e)` | whether a token is a **command token** | {@link isCommandToken} |
 * | `c(e)` | the index of the first token that is not a flag | {@link firstPositionalIndex} |
 * | `Bjo(e)` | the index of the session-management subcommand, or `-1` | {@link sessionSubcommandIndex} |
 *
 * ### The three shapes a flag can have
 *
 * `Ibt` is the whole of the consumption rule, and it is **commander's** rule:
 *
 *   - a **value** flag owns the **next** token, whether or not that token looks like
 *     a flag — `--model --print` gives `--print` to `--model`;
 *   - a **repeatable** value flag owns the next token **and** every token after it
 *     that does not look like a flag — `--tools Read Write` names two tools, and the
 *     first token after the flag is owned **whatever it looks like**;
 *   - an **optional-value** flag owns the next token only when that token does not
 *     look like a flag — `--resume session_abc` names a session and `--resume --print`
 *     names none;
 *   - a **boolean** flag owns **nothing**.
 *
 * The audit's summary — "a boolean consumes the next non-flag token" — is the audit's
 * reading of the *optional-value* set, and this implementation applies it to the
 * **fourteen** flags the target puts in that set. The boolean set consumes nothing,
 * which is what the target's own root command declares (`-p, --print`,
 * `-c, --continue`, `--verbose`, … carry no argument).
 *
 * ### The three flags the scanner does not count
 *
 * `h` holds `--exec`, `-m` and `--handle-uri`. They **take a value** — `Ibt` consumes
 * it — but `x()` excludes them, so the session-subcommand scanner does not treat them
 * as flags. The exclusion is reproduced here: {@link isKnownFlag} returns `false` for
 * them.
 *
 * ## What is an implementation choice
 *
 *   - the **short flag cluster** is expanded only when **every** letter is a known
 *     short flag, and is otherwise an **unknown option**. The target does not expand
 *     clusters at all — the target's own `S()` treats a cluster as a *command token* —
 *     and the expansion is this implementation's own, kept because the `CC-014`
 *     contract test pins it;
 *   - **`-d2e`** is the one flag of the target's boolean set that this implementation
 *     refuses **at the parse level**. The target's boolean set carries it, so the
 *     vocabulary table carries it too, but the `CC-014` contract test pins that
 *     `-d2e` is an error, and this implementation has no debug trace to write;
 *   - **`--print=<value>`** names the prompt. The target declares `--print` as a
 *     boolean and takes the prompt from the positional argument; this implementation's
 *     own extension is kept because the `CC-014` contract test pins it;
 *   - the **bare subcommand** is a command when it comes **first**. The target's
 *     dispatcher is commander's, and a command's name is always its first argument;
 *   - the **messages** the target does not record are this implementation's own. Every
 *     message the target records is reproduced **verbatim**, and each one is marked as
 *     such at the place it is produced;
 *   - the **flags this implementation does not act on** are refused by the **run**
 *     with a message that names them. The parser knows every one of them, and parses
 *     each one the way the target parses it. `src/cli/command.ts` holds the list.
 */

import { isInputFormat, isOutputFormat } from './output.js';
import type { InputFormat, OutputFormat } from './output.js';

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The session-management subcommands.
 *
 * **REA observed** (`chunk-0y0ptpy9.js:4383`, the set `g`): the target's own six
 * names.
 */
export const SESSION_SUBCOMMAND_NAMES: readonly string[] = [
  'attach',
  'logs',
  'stop',
  'kill',
  'respawn',
  'rm',
];

/**
 * The subcommands the target has.
 *
 * **REA observed** (audit §2.10): "The **subcommands** are `attach`, `logs`, `stop`,
 * `kill`, `respawn`, `rm`."
 *
 * The name is kept for the `CC-014` contract test; the six names are the target's
 * **session-management** subcommands, and they are a group of their own in the
 * command tree — {@link CLI_COMMAND_TREE}.
 */
export const SUBCOMMANDS = SESSION_SUBCOMMAND_NAMES;

/** One of the six session-management subcommands. */
export type Subcommand = (typeof SESSION_SUBCOMMAND_NAMES)[number];

/**
 * The shape of a session id, exactly as the target's pattern has it.
 *
 * **REA observed** (audit §2.10): "A **session id** matches
 * `/^(?:session|cse)_[A-Za-z0-9_]+$/`; a path is scanned for such a segment."
 */
export const SESSION_ID_PATTERN = /^(?:session|cse)_[A-Za-z0-9_]+$/;

/**
 * The shape of a cloud session ref.
 *
 * **REA observed** (audit §2.10): "A **cloud session ref** is an 8-hex-digit id
 * (`/^[a-f0-9]{8}$/`)."
 */
export const CLOUD_SESSION_REF_PATTERN = /^[a-f0-9]{8}$/;

/** Whether a value is a session id. */
export function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

/** Whether a value is a cloud session ref. */
export function isCloudSessionRef(value: string): boolean {
  return CLOUD_SESSION_REF_PATTERN.test(value);
}

/**
 * Whether a value is one of the target's URI arguments.
 *
 * **REA observed** (audit §2.10): "A **URI** argument starts with `cc://` or
 * `cc+unix://`."
 */
export function isUriArgument(value: string): boolean {
  return value.startsWith('cc://') || value.startsWith('cc+unix://');
}

/**
 * The session id a path names, when it names one.
 *
 * **REA observed** (audit §2.10): "a path is scanned for such a segment". The scan
 * is over the path's **segments**, so a directory whose name happens to look like
 * a session id is the segment that is found — this implementation takes the **last**
 * such segment, because a transcript's file name is the session it holds.
 */
export function findSessionIdInPath(value: string): string | undefined {
  const segments = value.split(/[/\\]/);
  let found: string | undefined;
  for (const segment of segments) {
    const name = segment.endsWith('.jsonl') ? segment.slice(0, -'.jsonl'.length) : segment;
    if (!SESSION_ID_PATTERN.test(name)) continue;
    found = name;
  }
  return found;
}

/**
 * The cloud session a `--cloud` value names.
 *
 * **Implementation choice.** The audit records the three shapes the target knows — a
 * **session id**, a **cloud session ref** and a **URI argument** — and the
 * message `--cloud <session_id|url>`, but it does not say how a value that is
 * none of the three is read. This implementation classifies the value it is given, so
 * that the run can say which shape it was handed.
 */
export type CloudTarget =
  /** A **session id**, `session_…` or `cse_…`. */
  | { kind: 'session-id'; value: string }
  /** A **cloud session ref**: eight hex digits. */
  | { kind: 'cloud-ref'; value: string }
  /** A **URI argument**: `cc://…` or `cc+unix://…`. */
  | { kind: 'uri'; value: string }
  /** Anything else — a url, or a value this implementation does not recognise. */
  | { kind: 'other'; value: string };

/**
 * The cloud session a `--cloud` value names.
 *
 * The three shapes the audit records are recognised; anything else is `other`.
 */
export function cloudTargetOf(value: string): CloudTarget {
  if (isSessionId(value)) return { kind: 'session-id', value };
  if (isCloudSessionRef(value)) return { kind: 'cloud-ref', value };
  if (isUriArgument(value)) return { kind: 'uri', value };
  return { kind: 'other', value };
}

/**
 * Whether a **headless cloud client** is enabled.
 *
 * **Implementation choice.** The target's `--attach-serve` rule needs "an enabled
 * headless cloud client", and this implementation has **no** cloud client at all: the
 * cloud is a later milestone's surface. The flag therefore never satisfies the
 * rule, and this implementation refuses `--attach-serve` with the target's message rather
 * than accepting it and doing nothing.
 */
export const HEADLESS_CLOUD_CLIENT_ENABLED = false;

/**
 * The model a run uses when the flags do not name one.
 *
 * **Implementation choice.** The audit does not record the target's default model.
 *
 * It lives here, on the **command-line surface**, because it is a command
 * line's default: the interactive host resolves its model the same way the
 * headless path does, and the two must not drift. `src/cli/command.ts`
 * re-exports it, so the name is the same everywhere.
 */
export const DEFAULT_MODEL = 'claude-sonnet-4-5';

/* -------------------------------------------------------------------------- */
/* The flag vocabulary                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The **85** flags that take a value.
 *
 * **REA observed** (`chunk-0y0ptpy9.js:1112`, the set `l`). The list is the target's
 * own, in the target's own order.
 */
export const VALUE_FLAG_NAMES: readonly string[] = [
  '--prefill',
  '--prefill-b64',
  '--deep-link-repo',
  '--deep-link-last-fetch',
  '--deep-link-cwd-b64',
  '--handle-uri',
  '--settings',
  '--managed-settings',
  '--setting-sources',
  '--client-data-url',
  '--watch-artifact',
  '--watch-artifact-no-autoreact',
  '--team-name',
  '--agent-id',
  '--agent-name',
  '--agent-color',
  '--parent-session-id',
  '--agent-type',
  '--model',
  '--agent',
  '--routine',
  '--effort',
  '--fast-mode',
  '--permission-mode',
  '--inherit-permission-mode',
  '--proactivity',
  '--debug-file',
  '--system-prompt',
  '--system-prompt-file',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--system-prompt-snapshot',
  '--append-subagent-system-prompt',
  '--append-subagent-system-prompt-file',
  '--plan-mode-instructions',
  '--permission-prompt-tool',
  '--permission-prompts',
  '--json-schema',
  '--fallback-model',
  '--advisor',
  '--agents',
  '--name',
  '-n',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--tools',
  '--add-dir',
  '--mcp-config',
  '--betas',
  '--file',
  '--channels',
  '--dangerously-load-development-channels',
  '--plugin-dir',
  '--plugin-dir-no-mcp',
  '--plugin-url',
  '--remote-control-session-name-prefix',
  '--exec',
  '-m',
  '--sdk-url',
  '--thinking',
  '--thinking-display',
  '--max-thinking-tokens',
  '--max-turns',
  '--max-budget-usd',
  '--task-budget',
  '--autocompact',
  '--rewind-files',
  '--resume-session-at',
  '--resume-drops-turn',
  '--workload',
  '--output-format',
  '--input-format',
  '--teammate-mode',
  '--messaging-socket-path',
  '--session-id',
  '--environment',
  '--pool',
  '--ref',
  '--on-branch',
  '--correlation-id',
  '--forward-home-settings',
  '--project-config-root',
  '--attach-serve',
];

/**
 * The **11** value-taking flags that are **repeatable**.
 *
 * **REA observed** (`chunk-0y0ptpy9.js:2671`, the set `LBr`). Each of them owns the
 * next token and every token after it that does not look like a flag.
 */
export const REPEATABLE_FLAG_NAMES: readonly string[] = [
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--tools',
  '--add-dir',
  '--mcp-config',
  '--betas',
  '--file',
  '--channels',
  '--dangerously-load-development-channels',
];

/**
 * The **14** flags that take an **optional** value.
 *
 * **REA observed** (`chunk-0y0ptpy9.js:2871`, the set `d`). Each of them owns the
 * next token only when that token does not look like a flag.
 */
export const OPTIONAL_VALUE_FLAG_NAMES: readonly string[] = [
  '-d',
  '--debug',
  '-r',
  '--resume',
  '--from-pr',
  '-w',
  '--worktree',
  '--teleport',
  '--cloud',
  '--remote',
  '--project',
  '--remote-control',
  '--rc',
  '--prompt-suggestions',
];

/**
 * The **45** boolean flags.
 *
 * **REA observed** (`chunk-0y0ptpy9.js:4539`, the set `f`). A flag of this set owns
 * **nothing**: it is either given or it is not.
 */
export const BOOLEAN_FLAG_NAMES: readonly string[] = [
  '-d2e',
  '--debug-to-stderr',
  '--verbose',
  '-p',
  '--print',
  '--bare',
  '--safe-mode',
  '--init',
  '--init-only',
  '--maintenance',
  '--include-hook-events',
  '--include-partial-messages',
  '--forward-subagent-text',
  '--session-mirror',
  '--await-claim',
  '--await-initialize',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--replay-user-messages',
  '--host-auth-is-org-sign-in',
  '--enable-auth-status',
  '--restricted',
  '--allow-other-models',
  '--exclude-dynamic-system-prompt-sections',
  '--include-unsupported-models',
  '-c',
  '--continue',
  '--fork-session',
  '--deep-link-origin',
  '--no-session-persistence',
  '--reply-on-resume',
  '--ide',
  '--desktop',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--chrome',
  '--no-chrome',
  '--tmux',
  '--enable-auto-mode',
  '--bg',
  '--background',
  '--brief',
  '--ax-screen-reader',
  '--plan-mode-required',
  '--hard-fail',
];

/**
 * The **10** tokens that are **commands**, not flags.
 *
 * **REA observed** (`chunk-0y0ptpy9.js:4441`, the set `m`).
 */
export const COMMAND_TOKEN_NAMES: readonly string[] = [
  '-p',
  '--print',
  '--bg',
  '--background',
  '--routine',
  '-h',
  '--help',
  '-v',
  '-V',
  '--version',
];

/**
 * The **3** value-taking flags the target's scanner does **not** count as flags.
 *
 * **REA observed** (`chunk-0y0ptpy9.js:5387`, the set `h`): `--exec`, `-m` and
 * `--handle-uri`. `Ibt` consumes their value and `x()` excludes them, so the
 * session-subcommand scanner does not treat them as flags.
 */
export const NON_FLAG_VALUE_FLAG_NAMES: readonly string[] = ['--exec', '-m', '--handle-uri'];

/**
 * The argument hint of every flag the target declares.
 *
 * **REA observed** (`chunk-t0c9yez3.js`, the root command's option declarations, and
 * `chunk-081t8575.js:75750` for the `-m` alias of `--model`). The hint is the
 * target's own — `--model <model>`, `--allowedTools, --allowed-tools <tools...>`,
 * `-r, --resume [value]` — and it is **data**: the shape of the value a flag takes.
 */
export const FLAG_ARGUMENT_HINTS: ReadonlyMap<string, string | undefined> = new Map([
  ['--add-dir', '<directories...>'],
  ['--advisor', '<model>'],
  ['--agent', '<agent>'],
  ['--agent-color', '<color>'],
  ['--agent-id', '<id>'],
  ['--agent-name', '<name>'],
  ['--agent-type', '<type>'],
  ['--agents', '<json-or-file>'],
  ['--allow-dangerously-skip-permissions', undefined],
  ['--allow-other-models', undefined],
  ['--allowed-tools', '<tools...>'],
  ['--allowedTools', '<tools...>'],
  ['--append-subagent-system-prompt', '<prompt>'],
  ['--append-subagent-system-prompt-file', '<file>'],
  ['--append-system-prompt', '<prompt>'],
  ['--append-system-prompt-file', '<file>'],
  ['--attach-serve', '<session_id>'],
  ['--autocompact', '<auto|tokens>'],
  ['--await-claim', undefined],
  ['--await-initialize', undefined],
  ['--ax-screen-reader', undefined],
  ['--background', undefined],
  ['--bare', undefined],
  ['--betas', '<betas...>'],
  ['--bg', undefined],
  ['--brief', undefined],
  ['--channels', '<servers...>'],
  ['--chrome', undefined],
  ['--client-data-url', '<url>'],
  ['--cloud', '[description|session_id|url]'],
  ['--continue', undefined],
  ['--correlation-id', '<id>'],
  ['--dangerously-load-development-channels', '<servers...>'],
  ['--dangerously-skip-permissions', undefined],
  ['--debug', '[filter]'],
  ['--debug-file', '<path>'],
  ['--debug-to-stderr', undefined],
  ['--deep-link-cwd-b64', '<b64>'],
  ['--deep-link-last-fetch', '<ms>'],
  ['--deep-link-origin', undefined],
  ['--deep-link-repo', '<slug>'],
  ['--desktop', undefined],
  ['--disable-slash-commands', undefined],
  ['--disallowed-tools', '<tools...>'],
  ['--disallowedTools', '<tools...>'],
  ['--effort', '<level>'],
  ['--enable-auth-status', undefined],
  ['--enable-auto-mode', undefined],
  ['--environment', '<environment_id>'],
  ['--exclude-dynamic-system-prompt-sections', undefined],
  ['--exec', '<command>'],
  ['--fallback-model', '<model>'],
  ['--fast-mode', '<on|off>'],
  ['--file', '<specs...>'],
  ['--fork-session', undefined],
  ['--forward-home-settings', '<true|false>'],
  ['--forward-subagent-text', undefined],
  ['--from-pr', '[value]'],
  ['--handle-uri', '<uri>'],
  ['--hard-fail', undefined],
  ['--host-auth-is-org-sign-in', undefined],
  ['--ide', undefined],
  ['--include-hook-events', undefined],
  ['--include-partial-messages', undefined],
  ['--include-unsupported-models', undefined],
  ['--inherit-permission-mode', '<mode>'],
  ['--init', undefined],
  ['--init-only', undefined],
  ['--input-format', '<format>'],
  ['--json-schema', '<schema>'],
  ['--maintenance', undefined],
  ['--managed-settings', '<json>'],
  ['--max-budget-usd', '<amount>'],
  ['--max-thinking-tokens', '<tokens>'],
  ['--max-turns', '<turns>'],
  ['--mcp-config', '<configs...>'],
  ['--messaging-socket-path', '<path>'],
  ['--model', '<model>'],
  ['--name', '<name>'],
  ['--no-chrome', undefined],
  ['--no-session-persistence', undefined],
  ['--on-branch', '<branch>'],
  ['--output-format', '<format>'],
  ['--parent-session-id', '<id>'],
  ['--permission-mode', '<mode>'],
  ['--permission-prompt-tool', '<tool>'],
  ['--permission-prompts', '<target>'],
  ['--plan-mode-instructions', '<instructions>'],
  ['--plan-mode-required', undefined],
  ['--plugin-dir', '<path>'],
  ['--plugin-dir-no-mcp', '<path>'],
  ['--plugin-url', '<url>'],
  ['--pool', '<pool_id>'],
  ['--prefill', '<text>'],
  ['--prefill-b64', '<b64>'],
  ['--print', undefined],
  ['--proactivity', '<level>'],
  ['--project', '<name>'],
  ['--project-config-root', '<dir>'],
  ['--prompt-suggestions', '[value]'],
  ['--rc', '[name]'],
  ['--ref', '<ref>'],
  ['--remote', '[description|session_id|url]'],
  ['--remote-control', '[name]'],
  ['--remote-control-session-name-prefix', '<prefix>'],
  ['--replay-user-messages', undefined],
  ['--reply-on-resume', undefined],
  ['--restricted', undefined],
  ['--resume', '[value]'],
  ['--resume-drops-turn', '<message id>'],
  ['--resume-session-at', '<message id>'],
  ['--rewind-files', '<user-message-id>'],
  ['--routine', '<name>'],
  ['--safe-mode', undefined],
  ['--sdk-url', '<url>'],
  ['--session-id', '<uuid>'],
  ['--session-mirror', undefined],
  ['--setting-sources', '<sources>'],
  ['--settings', '<file-or-json>'],
  ['--strict-mcp-config', undefined],
  ['--system-prompt', '<prompt>'],
  ['--system-prompt-file', '<file>'],
  ['--system-prompt-snapshot', '<on|off>'],
  ['--task-budget', '<tokens>'],
  ['--team-name', '<name>'],
  ['--teammate-mode', '<mode>'],
  ['--teleport', '[session]'],
  ['--thinking', '<mode>'],
  ['--thinking-display', '<display>'],
  ['--tmux', undefined],
  ['--tools', '<tools...>'],
  ['--verbose', undefined],
  ['--watch-artifact', '<artifact>'],
  ['--watch-artifact-no-autoreact', '<artifact>'],
  ['--workload', '<tag>'],
  ['--worktree', '[name]'],
  ['-c', undefined],
  ['-d', '[filter]'],
  ['-d2e', undefined],
  ['-m', '<model>'],
  ['-n', '<name>'],
  ['-p', undefined],
  ['-r', '[value]'],
  ['-w', '[name]'],
]);


/**
 * The short forms the target's own root command declares.
 *
 * **REA observed** (`chunk-t0c9yez3.js`, the option declarations; and
 * `chunk-081t8575.js:75750`, where the target registers `--model` with the alias
 * `-m`, and `chunk-5pwj97my.js`, where it registers `--name` with the alias `-n`).
 *
 * The table is a `Map`, so a short flag is **data**: a lookup can never resolve an
 * inherited member of `Object.prototype`.
 */
export const SHORT_FLAG_ALIASES: ReadonlyMap<string, string> = new Map([
  ['-p', '--print'],
  ['-c', '--continue'],
  ['-d', '--debug'],
  ['-r', '--resume'],
  ['-w', '--worktree'],
  ['-n', '--name'],
  ['-m', '--model'],
  ['-h', '--help'],
  ['-v', '--version'],
  ['-V', '--version'],
]);

/**
 * The kind of command the parser knows.
 */
type CommandKind = 'print' | 'background' | 'routine' | 'help' | 'version';

/**
 * The tokens that are **commands**, not flags, and what they mean.
 *
 * **REA observed** (`chunk-0y0ptpy9.js:4441`, the set `m`).
 *
 * The table is a `Map`, so a command token is **data**.
 */
const COMMAND_TOKENS: ReadonlyMap<string, CommandKind> = new Map([
  ['-p', 'print'],
  ['--print', 'print'],
  ['--bg', 'background'],
  ['--background', 'background'],
  ['--routine', 'routine'],
  ['-h', 'help'],
  ['--help', 'help'],
  ['-v', 'version'],
  ['-V', 'version'],
  ['--version', 'version'],
]);

/** The value-taking flags, as a lookup set. */
const VALUE_FLAG_SET: ReadonlySet<string> = new Set(VALUE_FLAG_NAMES);
/** The repeatable flags, as a lookup set. */
const REPEATABLE_FLAG_SET: ReadonlySet<string> = new Set(REPEATABLE_FLAG_NAMES);
/** The optional-value flags, as a lookup set. */
const OPTIONAL_VALUE_FLAG_SET: ReadonlySet<string> = new Set(OPTIONAL_VALUE_FLAG_NAMES);
/** The boolean flags, as a lookup set. */
const BOOLEAN_FLAG_SET: ReadonlySet<string> = new Set(BOOLEAN_FLAG_NAMES);
/** The command tokens, as a lookup set. */
const COMMAND_TOKEN_SET: ReadonlySet<string> = new Set(COMMAND_TOKEN_NAMES);
/** The flags the scanner does not count as flags, as a lookup set. */
const NON_FLAG_VALUE_FLAG_SET: ReadonlySet<string> = new Set(NON_FLAG_VALUE_FLAG_NAMES);

/**
 * The shape of a short flag cluster.
 *
 * The target's own pattern is `/^-[A-Za-z]{2,}$/`; this implementation widens the
 * class to `[A-Za-z0-9]` so that the target's own example (`-d2e`) is one token.
 * A token that starts with `--` is never a cluster: the second character is not in
 * the class.
 */
const SHORT_CLUSTER_PATTERN = /^-[A-Za-z0-9]{2,}$/;

/**
 * The one flag of the target's boolean set that this implementation refuses
 * **as an unknown option**.
 *
 * **Implementation choice, and a recorded divergence.** The target's root
 * command declares `-d2e, --debug-to-stderr`: `-d2e` is a **short form**, not a
 * cluster, and the target's own scanner counts it as a flag. This
 * implementation's **vocabulary** carries it, among the target's forty-five
 * boolean flags, and the target's own scanner — {@link isKnownFlag} — counts
 * it too.
 *
 * The **parser** does not: the `CC-014` contract test and the compatibility
 * scenario `F-01` both pin the message `Error: unknown option '-d2e'.` for it.
 * The parser therefore leaves it out of the boolean set it acts on, and the
 * **short flag cluster** rule refuses it — the rule that keeps the cluster one
 * token instead of splitting it into a flag and a value.
 */
const PARSER_EXCLUDED_BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['-d2e']);

/** The boolean flags the **parser** acts on. */
const PARSER_BOOLEAN_FLAGS: ReadonlySet<string> = new Set(
  BOOLEAN_FLAG_NAMES.filter((name) => !PARSER_EXCLUDED_BOOLEAN_FLAGS.has(name)),
);

/**
 * The one value flag this implementation gives the **optional-value** behaviour.
 *
 * **Implementation choice, and a recorded divergence.** The target declares
 * `--attach-serve <session_id>`, so its own parser gives the flag a
 * **required** value: `prricode --attach-serve --print` gives `--print` to
 * `--attach-serve`, and `prricode --attach-serve` alone is a missing-argument
 * error.
 *
 * The `CC-014` contract test pins two things that the target's own declaration
 * contradicts: that a line which gives the flag **without** a session id
 * reports the target's `--attach-serve` message, and that the flag does **not**
 * swallow the `--print` that follows it. The pinned behaviour wins, so the
 * parser consumes the next token only when that token does **not** look like a
 * flag — the rule the target applies to its fourteen **optional-value** flags.
 *
 * The vocabulary table still carries `--attach-serve` among the **85** value
 * flags, because that is where the target puts it.
 */
const OPTIONAL_VALUE_EXCEPTIONS: ReadonlySet<string> = new Set(['--attach-serve']);

/* -------------------------------------------------------------------------- */
/* The parser's own primitives                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Whether a token looks like a flag.
 *
 * The target's `ejt` (`chunk-0y0ptpy9.js`): a token is a flag when it has more than
 * one character and starts with `-`. A lone `-` is therefore a positional.
 */
export function isFlagToken(token: string): boolean {
  return token.length > 1 && token.startsWith('-');
}

/** The session-management subcommand names, as a lookup set. */
const SESSION_SUBCOMMAND_SET: ReadonlySet<string> = new Set(SESSION_SUBCOMMAND_NAMES);

/**
 * Whether a token is a **flag** the target's scanner counts.
 *
 * The target's `x` (`chunk-0y0ptpy9.js`): a boolean flag is a flag; a value-taking
 * flag is a flag **unless** it is one of the three the scanner does not count
 * (`--exec`, `-m`, `--handle-uri`); an optional-value flag is a flag. The `--flag=value`
 * form is read by the name **before** the `=`, and a boolean flag is matched whole, so
 * `--verbose=x` is **not** a flag — the target's own root command declares `--verbose`
 * without an argument.
 */
export function isKnownFlag(token: string): boolean {
  if (BOOLEAN_FLAG_SET.has(token)) return true;
  const equals = token.indexOf('=');
  const name = equals === -1 ? token : token.slice(0, equals);
  if (VALUE_FLAG_SET.has(name)) return !NON_FLAG_VALUE_FLAG_SET.has(name);
  return OPTIONAL_VALUE_FLAG_SET.has(name);
}

/**
 * Whether a token is a **command token**.
 *
 * The target's `S` (`chunk-0y0ptpy9.js`): one of the ten command tokens, a token
 * that starts with `--routine=`, or a short flag cluster.
 */
export function isCommandToken(token: string): boolean {
  if (COMMAND_TOKEN_SET.has(token)) return true;
  if (token.startsWith('--routine=')) return true;
  return /^-[A-Za-z]{2,}$/.test(token);
}

/**
 * The index of the **last** token the flag at `index` owns.
 *
 * The target's `Ibt` (`chunk-0y0ptpy9.js`):
 *
 *   - an **optional-value** flag owns the next token only when that token does not
 *     look like a flag;
 *   - a **value** flag owns the next token, whether or not it looks like a flag;
 *   - a **repeatable** value flag owns the next token **and** every token after it
 *     that does not look like a flag;
 *   - anything else owns nothing.
 *
 * The index is the index of the **last** owned token, and `-1` when the flag owns
 * nothing.
 */
export function flagValueEnd(argv: readonly string[], index: number): number {
  const token = argv[index];
  if (token === undefined) return -1;
  if (OPTIONAL_VALUE_FLAG_SET.has(token)) {
    const next = argv[index + 1];
    return next !== undefined && !isFlagToken(next) ? index + 1 : index;
  }
  if (!VALUE_FLAG_SET.has(token)) return index;
  let last = index + 1;
  if (REPEATABLE_FLAG_SET.has(token)) {
    while (last + 1 < argv.length && !isFlagToken(argv[last + 1] as string)) last += 1;
  }
  return last;
}

/**
 * The index of the first token that is **not** a flag.
 *
 * The target's `c` (`chunk-0y0ptpy9.js`): the scan stops at `--`, and the token
 * after `--` is the first positional; `-1` when there is none.
 */
export function firstPositionalIndex(argv: readonly string[]): number {
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] as string;
    if (token === '--') return index + 1 < argv.length ? index + 1 : -1;
    if (!isFlagToken(token)) return index;
    index = flagValueEnd(argv, index) + 1;
  }
  return -1;
}

/**
 * The index of the session-management subcommand, or `-1`.
 *
 * The target's `Bjo` (`chunk-0y0ptpy9.js`): the first token that is not a flag
 * must be one of the six session-management names. When it is the **first**
 * token of the line the target answers `0` there and then; otherwise the
 * subcommand must be followed by an eight-hex-digit session reference (or
 * `--all` after `respawn`), and every token before it must be a **flag** — a
 * token the scanner does not count as a flag (`--exec`, `-m`, `--handle-uri`)
 * or a command token disqualifies the line.
 */
export function sessionSubcommandIndex(argv: readonly string[]): number {
  const index = firstPositionalIndex(argv);
  if (index === -1) return -1;
  const name = argv[index] as string;
  if (!SESSION_SUBCOMMAND_SET.has(name)) return -1;
  if (index === 0) return 0;
  const reference = argv[index + 1];
  if (reference === undefined) return -1;
  if (!CLOUD_SESSION_REF_PATTERN.test(reference) && !(name === 'respawn' && reference === '--all')) {
    return -1;
  }
  for (let before = 0; before < index; before = flagValueEnd(argv, before) + 1) {
    const token = argv[before] as string;
    if (isCommandToken(token)) return -1;
    if (!isKnownFlag(token)) return -1;
  }
  return index;
}

/* -------------------------------------------------------------------------- */
/* The command tree                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One entry of the target's command tree.
 *
 * The tree is a list of **paths**: `['plugin']` is the `plugin` group,
 * `['plugin', 'init']` is its `init` command, and `['mcp', 'xaa', 'setup']` is the
 * `setup` command of the `xaa` group of the `mcp` group.
 */
export interface CliCommand {
  /** The path of the command, from the root down. */
  readonly path: readonly string[];
  /** Whether the entry is a **group** (it holds other commands) or a **command**. */
  readonly kind: 'group' | 'command';
  /** The usage string the target prints, e.g. `plugin init <name>`. */
  readonly usage: string;
  /** The description the target prints. */
  readonly description: string;
  /** The other names the command answers to. */
  readonly aliases: readonly string[];
  /** Whether the target hides the command from its help. */
  readonly hidden: boolean;
  /** The target's own source file. */
  readonly source: string;
  /** The byte offset of the command's definition in that file. */
  readonly offset: number;
}

/**
 * The target's command tree.
 *
 * **REA observed** — the record's §G3 table, read against the target's own source:
 * `chunk-64447bxa.js` (the `plugin` tree and the `hk` registry of its descriptions at
 * `chunk-kctf5bfr.js:693`), `chunk-dmqgh1rk.js` (the `mcp` tree), `chunk-9y799w6p.js`
 * (the `auth`, `auto-mode`, `sandbox` and `project` trees and the root commands) and
 * `chunk-mancccdx.js` (the hidden editor commands).
 *
 * The **data** is the target's: the paths, the usage strings, the descriptions, the
 * aliases and the hidden flag. The target's **product name** is not: where the
 * target's own text names its product, this implementation says **PRRICODE**.
 */
export const CLI_COMMAND_TREE: readonly CliCommand[] = [
  /* The `plugin` group — chunk-64447bxa.js:16382. */
  {
    path: ['plugin'],
    kind: 'group',
    usage: 'plugin',
    description: 'Manage PRRICODE plugins',
    aliases: ['plugins'],
    hidden: false,
    source: 'chunk-64447bxa.js',
    offset: 16382,
  },
  {
    path: ['plugin', 'init'],
    kind: 'command',
    usage: 'plugin init <name>',
    description:
      'Scaffold a new plugin at ~/.claude/skills/<name>/ (auto-loads next session as <name>@skills-dir)',
    aliases: ['new'],
    hidden: false,
    source: 'chunk-64447bxa.js',
    offset: 16669,
  },
  {
    path: ['plugin', 'validate'],
    kind: 'command',
    usage: 'plugin validate <path>',
    description:
      'Validate a plugin or marketplace manifest, or the skills, agents, and commands in a directory',
    aliases: [],
    hidden: false,
    source: 'chunk-64447bxa.js',
    offset: 17288,
  },
  {
    path: ['plugin', 'tag'],
    kind: 'command',
    usage: 'plugin tag [path]',
    description:
      'Create a {name}--v{version} git tag for a plugin release, validating that plugin.json and any enclosing marketplace entry agree',
    aliases: [],
    hidden: false,
    source: 'chunk-64447bxa.js',
    offset: 17778,
  },
  {
    path: ['plugin', 'list'],
    kind: 'command',
    usage: 'plugin list',
    description: 'List installed plugins',
    aliases: [],
    hidden: false,
    source: 'chunk-64447bxa.js',
    offset: 18371,
  },
  {
    path: ['plugin', 'eval'],
    kind: 'command',
    usage: 'plugin eval [target]',
    description:
      "Run eval cases (<eval dir>/**/case.yaml or prompt.md + graders/*.md; the eval dir is evals/ unless --eval-dir or the manifest says otherwise) against a plugin and report scored results. Target is a path, a plugin name, or a `plugin@marketplace` id — installed and skills-dir plugins both resolve (and add a no-plugin baseline arm). It loads the plugin and runs its eval suite (prompts, graders; scaffold scripts and real MCP servers only when you opt in) on your machine, as you: only evaluate plugins you trust — the run's sandboxing limits what a malicious plugin can reach but is not a guarantee, and a bundled suite passing is not a security vetting. The first run in an untrusted plugin directory asks you to confirm (--trust-plugin answers for CI)",
    aliases: [],
    hidden: false,
    source: 'chunk-64447bxa.js',
    offset: 19085,
  },
  {
    path: ['plugin', 'eval', 'init'],
    kind: 'command',
    usage: 'plugin eval init [name]',
    description:
      'Author an eval suite under the eval dir (evals/ unless --eval-dir or the manifest says otherwise) via an interview that sources inputs and designs graders. Use --bare <name> for a blank single-case template.',
    aliases: [],
    hidden: false,
    source: 'chunk-64447bxa.js',
    offset: 23408,
  },
  {
    path: ['plugin', 'test'],
    kind: 'command',
    usage: 'plugin test [dir]',
    description: "Run a mod's tests",
    aliases: [],
    hidden: true,
    source: 'chunk-64447bxa.js',
    offset: 24175,
  },
  {
    path: ['plugin', 'details'],
    kind: 'command',
    usage: 'plugin details <name>',
    description: "Show a plugin's component inventory and projected token cost",
    aliases: [],
    hidden: false,
    source: 'chunk-64447bxa.js',
    offset: 24806,
  },
  {
    path: ['plugin', 'marketplace'],
    kind: 'group',
    usage: 'plugin marketplace',
    description: 'Manage PRRICODE marketplaces',
    aliases: [],
    hidden: false,
    source: 'chunk-64447bxa.js',
    offset: 25087,
  },
  {
    path: ['plugin', 'marketplace', 'add'],
    kind: 'command',
    usage: 'plugin marketplace add <source>',
    description: 'Add a marketplace from a URL, path, or GitHub repo',
    aliases: [],
    hidden: false,
    source: 'chunk-64447bxa.js',
    offset: 25180,
  },
  {
    path: ['plugin', 'marketplace', 'list'],
    kind: 'command',
    usage: 'plugin marketplace list',
    description: 'List all configured marketplaces',
    aliases: [],
    hidden: false,
    source: 'chunk-64447bxa.js',
    offset: 26599,
  },
  {
    path: ['plugin', 'marketplace', 'remove'],
    kind: 'command',
    usage: 'plugin marketplace remove <name>',
    description: 'Remove a configured marketplace',
    aliases: ['rm'],
    hidden: false,
    source: 'chunk-64447bxa.js',
    offset: 26900,
  },
  {
    path: ['plugin', 'marketplace', 'update'],
    kind: 'command',
    usage: 'plugin marketplace update [name]',
    description: 'Update marketplace(s) from their source - updates all if no name specified',
    aliases: [],
    hidden: false,
    source: 'chunk-64447bxa.js',
    offset: 27489,
  },
  {
    path: ['plugin', 'install'],
    kind: 'command',
    usage: 'plugin install <plugin>',
    description:
      'Install a plugin from available marketplaces (use plugin@marketplace for specific marketplace)',
    aliases: ['i'],
    hidden: false,
    source: 'chunk-64447bxa.js',
    offset: 27903,
  },
  {
    path: ['plugin', 'uninstall'],
    kind: 'command',
    usage: 'plugin uninstall <plugin>',
    description: 'Uninstall an installed plugin',
    aliases: ['remove', 'rm'],
    hidden: false,
    source: 'chunk-64447bxa.js',
    offset: 30601,
  },
  {
    path: ['plugin', 'prune'],
    kind: 'command',
    usage: 'plugin prune',
    description: 'Remove auto-installed dependencies that are no longer needed',
    aliases: ['autoremove'],
    hidden: false,
    source: 'chunk-64447bxa.js',
    offset: 31451,
  },
  {
    path: ['plugin', 'enable'],
    kind: 'command',
    usage: 'plugin enable <plugin>',
    description: 'Enable a disabled plugin',
    aliases: [],
    hidden: false,
    source: 'chunk-64447bxa.js',
    offset: 31968,
  },
  {
    path: ['plugin', 'disable'],
    kind: 'command',
    usage: 'plugin disable [plugin]',
    description: 'Disable an enabled plugin',
    aliases: [],
    hidden: false,
    source: 'chunk-64447bxa.js',
    offset: 32434,
  },
  {
    path: ['plugin', 'update'],
    kind: 'command',
    usage: 'plugin update <plugin>',
    description: 'Update a plugin to the latest version (restart required to apply)',
    aliases: [],
    hidden: false,
    source: 'chunk-64447bxa.js',
    offset: 32953,
  },
  {
    path: ['plugin', 'configure'],
    kind: 'command',
    usage: 'plugin configure <plugin>',
    description:
      "Show a plugin's options and which are unset, or save values from stdin with --values-stdin",
    aliases: [],
    hidden: false,
    source: 'chunk-64447bxa.js',
    offset: 34171,
  },

  /* The `mcp` group — chunk-dmqgh1rk.js:19834. */
  {
    path: ['mcp'],
    kind: 'group',
    usage: 'mcp',
    description: 'Configure and manage MCP servers',
    aliases: [],
    hidden: false,
    source: 'chunk-dmqgh1rk.js',
    offset: 19834,
  },
  {
    path: ['mcp', 'add'],
    kind: 'command',
    usage: 'mcp add <name> <commandOrUrl> [args...]',
    description:
      'Add an MCP server to PRRICODE.\n\nExamples:\n  # Add HTTP server:\n  prricode mcp add --transport http sentry https://mcp.sentry.dev/mcp\n\n  # Add HTTP server with headers:\n  prricode mcp add --transport http corridor https://app.corridor.dev/api/mcp --header "Authorization: Bearer ..."\n\n  # Add stdio server with environment variables:\n  prricode mcp add my-server -e API_KEY=xxx -- npx my-mcp-server\n\n  # Add stdio server with subprocess flags:\n  prricode mcp add my-server -- my-command --some-flag arg1',
    aliases: [],
    hidden: false,
    source: 'chunk-dmqgh1rk.js',
    offset: 10959,
  },
  {
    path: ['mcp', 'add-json'],
    kind: 'command',
    usage: 'mcp add-json <name> <json>',
    description: 'Add an MCP server (stdio, SSE, HTTP, or WebSocket) with a JSON string',
    aliases: [],
    hidden: false,
    source: 'chunk-dmqgh1rk.js',
    offset: 22953,
  },
  {
    path: ['mcp', 'add-from-claude-desktop'],
    kind: 'command',
    usage: 'mcp add-from-claude-desktop',
    description: 'Import MCP servers from PRRICODE Desktop (Mac and WSL only)',
    aliases: [],
    hidden: false,
    source: 'chunk-dmqgh1rk.js',
    offset: 23455,
  },
  {
    path: ['mcp', 'remove'],
    kind: 'command',
    usage: 'mcp remove <name>',
    description: 'Remove an MCP server',
    aliases: [],
    hidden: false,
    source: 'chunk-dmqgh1rk.js',
    offset: 20925,
  },
  {
    path: ['mcp', 'list'],
    kind: 'command',
    usage: 'mcp list',
    description:
      'List configured MCP servers. Unapproved .mcp.json servers are shown as ⏸ Pending approval and not connected to; approved servers are health-checked unless disabled for this project.',
    aliases: [],
    hidden: false,
    source: 'chunk-dmqgh1rk.js',
    offset: 21324,
  },
  {
    path: ['mcp', 'get'],
    kind: 'command',
    usage: 'mcp get <name>',
    description:
      'Get details about an MCP server. Unapproved .mcp.json servers are shown as ⏸ Pending approval and not connected to; approved servers are health-checked unless disabled for this project.',
    aliases: [],
    hidden: false,
    source: 'chunk-dmqgh1rk.js',
    offset: 21777,
  },
  {
    path: ['mcp', 'login'],
    kind: 'command',
    usage: 'mcp login <name>',
    description: 'Authenticate with an MCP server (HTTP, SSE, or claude.ai connector)',
    aliases: [],
    hidden: false,
    source: 'chunk-dmqgh1rk.js',
    offset: 22243,
  },
  {
    path: ['mcp', 'logout'],
    kind: 'command',
    usage: 'mcp logout <name>',
    description: 'Clear stored OAuth credentials for an MCP server',
    aliases: [],
    hidden: false,
    source: 'chunk-dmqgh1rk.js',
    offset: 22688,
  },
  {
    path: ['mcp', 'reset-project-choices'],
    kind: 'command',
    usage: 'mcp reset-project-choices',
    description:
      'Reset all approved and rejected project-scoped (.mcp.json) servers within this project',
    aliases: [],
    hidden: false,
    source: 'chunk-dmqgh1rk.js',
    offset: 23757,
  },
  {
    path: ['mcp', 'serve'],
    kind: 'command',
    usage: 'mcp serve',
    description: 'Start the PRRICODE MCP server',
    aliases: [],
    hidden: false,
    source: 'chunk-dmqgh1rk.js',
    offset: 19948,
  },
  {
    path: ['mcp', 'xaa'],
    kind: 'group',
    usage: 'mcp xaa',
    description: 'Manage the XAA (SEP-990) IdP connection',
    aliases: [],
    hidden: false,
    source: 'chunk-dmqgh1rk.js',
    offset: 15447,
  },
  {
    path: ['mcp', 'xaa', 'setup'],
    kind: 'command',
    usage: 'mcp xaa setup',
    description: 'Configure the IdP connection (one-time setup for all XAA-enabled servers)',
    aliases: [],
    hidden: false,
    source: 'chunk-dmqgh1rk.js',
    offset: 15519,
  },
  {
    path: ['mcp', 'xaa', 'login'],
    kind: 'command',
    usage: 'mcp xaa login',
    description:
      'Cache an IdP id_token so XAA-enabled MCP servers authenticate silently. Default: run the OIDC browser login. With --id-token: write a pre-obtained JWT directly (used by conformance/e2e tests where the mock IdP does not serve /authorize).',
    aliases: [],
    hidden: false,
    source: 'chunk-dmqgh1rk.js',
    offset: 17310,
  },
  {
    path: ['mcp', 'xaa', 'show'],
    kind: 'command',
    usage: 'mcp xaa show',
    description: 'Show the current IdP connection config',
    aliases: [],
    hidden: false,
    source: 'chunk-dmqgh1rk.js',
    offset: 18798,
  },
  {
    path: ['mcp', 'xaa', 'clear'],
    kind: 'command',
    usage: 'mcp xaa clear',
    description: 'Clear the IdP connection config and cached id_token',
    aliases: [],
    hidden: false,
    source: 'chunk-dmqgh1rk.js',
    offset: 19460,
  },

  /* The `auth` group — chunk-9y799w6p.js:34608. */
  {
    path: ['auth'],
    kind: 'group',
    usage: 'auth',
    description: 'Manage authentication',
    aliases: [],
    hidden: false,
    source: 'chunk-9y799w6p.js',
    offset: 34608,
  },
  {
    path: ['auth', 'login'],
    kind: 'command',
    usage: 'auth login',
    description: 'Sign in to your Anthropic account',
    aliases: [],
    hidden: false,
    source: 'chunk-9y799w6p.js',
    offset: 34685,
  },
  {
    path: ['auth', 'status'],
    kind: 'command',
    usage: 'auth status',
    description: 'Show authentication status',
    aliases: [],
    hidden: false,
    source: 'chunk-9y799w6p.js',
    offset: 35187,
  },
  {
    path: ['auth', 'logout'],
    kind: 'command',
    usage: 'auth logout',
    description: 'Log out from your Anthropic account',
    aliases: [],
    hidden: false,
    source: 'chunk-9y799w6p.js',
    offset: 35574,
  },

  /* The `auto-mode` group — chunk-9y799w6p.js:39124. */
  {
    path: ['auto-mode'],
    kind: 'group',
    usage: 'auto-mode',
    description: 'Inspect or reset auto mode classifier configuration',
    aliases: [],
    hidden: false,
    source: 'chunk-9y799w6p.js',
    offset: 39124,
  },
  {
    path: ['auto-mode', 'defaults'],
    kind: 'command',
    usage: 'auto-mode defaults',
    description:
      'Print the default auto mode environment, allow, soft_deny, and hard_deny rules as JSON',
    aliases: [],
    hidden: false,
    source: 'chunk-9y799w6p.js',
    offset: 39214,
  },
  {
    path: ['auto-mode', 'config'],
    kind: 'command',
    usage: 'auto-mode config',
    description:
      'Print the effective auto mode config as JSON: your settings where set, defaults otherwise',
    aliases: [],
    hidden: false,
    source: 'chunk-9y799w6p.js',
    offset: 39695,
  },
  {
    path: ['auto-mode', 'reset'],
    kind: 'command',
    usage: 'auto-mode reset',
    description:
      'Reset auto mode configuration to the shipped defaults by removing the autoMode section from your user settings file',
    aliases: [],
    hidden: false,
    source: 'chunk-9y799w6p.js',
    offset: 40064,
  },
  {
    path: ['auto-mode', 'critique'],
    kind: 'command',
    usage: 'auto-mode critique',
    description: 'Get AI feedback on your custom auto mode rules',
    aliases: [],
    hidden: false,
    source: 'chunk-9y799w6p.js',
    offset: 40453,
  },

  /* The hidden `sandbox` group — chunk-9y799w6p.js:42028. */
  {
    path: ['sandbox'],
    kind: 'group',
    usage: 'sandbox',
    description: 'Install and inspect the Windows sandbox',
    aliases: [],
    hidden: true,
    source: 'chunk-9y799w6p.js',
    offset: 42028,
  },
  {
    path: ['sandbox', 'install'],
    kind: 'command',
    usage: 'sandbox install',
    description:
      'Install the Windows sandbox user and network filters. Self-elevates (one UAC prompt). Prints a JSON {status, message} result and exits 0 only when status is "ok".',
    aliases: [],
    hidden: true,
    source: 'chunk-9y799w6p.js',
    offset: 42069,
  },
  {
    path: ['sandbox', 'status'],
    kind: 'command',
    usage: 'sandbox status',
    description:
      'Print the effective sandbox posture (enabled, its source, strict mode, filesystem policy, Bash auto-allow) and the Windows install state as one JSON line.',
    aliases: [],
    hidden: true,
    source: 'chunk-9y799w6p.js',
    offset: 42363,
  },

  /* The hidden `project` group — chunk-9y799w6p.js:21667. The `purge` command is
     declared once and registered twice: visible at the root and hidden under the
     `project` group. */
  {
    path: ['project'],
    kind: 'group',
    usage: 'project',
    description: '`prricode project purge` is now `prricode purge`',
    aliases: [],
    hidden: true,
    source: 'chunk-9y799w6p.js',
    offset: 21667,
  },
  {
    path: ['project', 'purge'],
    kind: 'command',
    usage: 'project purge [path]',
    description:
      '`prricode project purge` is now `prricode purge`. Delete all PRRICODE state for a project (transcripts, tasks, file history, config entry)',
    aliases: [],
    hidden: true,
    source: 'chunk-9y799w6p.js',
    offset: 21776,
  },
  {
    path: ['purge'],
    kind: 'command',
    usage: 'purge [path]',
    description:
      'Delete all PRRICODE state for a project (transcripts, tasks, file history, config entry)',
    aliases: [],
    hidden: false,
    source: 'chunk-9y799w6p.js',
    offset: 21776,
  },

  /* The root commands — chunk-9y799w6p.js. */
  {
    path: ['gateway'],
    kind: 'command',
    usage: 'gateway',
    description: 'Run the enterprise auth/telemetry gateway',
    aliases: [],
    hidden: false,
    source: 'chunk-9y799w6p.js',
    offset: 33972,
  },
  {
    path: ['setup-token'],
    kind: 'command',
    usage: 'setup-token',
    description: 'Set up a long-lived authentication token (requires PRRICODE subscription)',
    aliases: [],
    hidden: false,
    source: 'chunk-9y799w6p.js',
    offset: 35913,
  },
  {
    path: ['agents'],
    kind: 'command',
    usage: 'agents',
    description: 'Manage background agents',
    aliases: [],
    hidden: false,
    source: 'chunk-9y799w6p.js',
    offset: 36231,
  },
  {
    path: ['ultrareview'],
    kind: 'command',
    usage: 'ultrareview [target]',
    description:
      'Run a cloud-hosted multi-agent code review of the current branch (or a PR number / base branch) and print the findings',
    aliases: [],
    hidden: false,
    source: 'chunk-9y799w6p.js',
    offset: 38379,
  },
  {
    path: ['remote-control'],
    kind: 'command',
    usage: 'remote-control',
    description: 'Control local sessions from claude.ai/code or the PRRICODE mobile app',
    aliases: ['rc'],
    hidden: true,
    source: 'chunk-9y799w6p.js',
    offset: 40856,
  },
  {
    path: ['doctor'],
    kind: 'command',
    usage: 'doctor',
    description:
      'Check the health of your PRRICODE installation. Reads settings files in the current directory without a trust prompt. For a full checkup that can also fix issues, run /doctor in a session.',
    aliases: [],
    hidden: false,
    source: 'chunk-9y799w6p.js',
    offset: 41274,
  },
  {
    path: ['apply-project-settings'],
    kind: 'command',
    usage: 'apply-project-settings',
    description:
      "Review how your PRRICODE settings (~/.claude/settings.json) and this folder's (.claude/settings.json, .claude/settings.local.json) differ from what you accepted for cloud sessions on this computer, and accept them. Needs a terminal.",
    aliases: [],
    hidden: true,
    source: 'chunk-9y799w6p.js',
    offset: 41592,
  },
  {
    path: ['update'],
    kind: 'command',
    usage: 'update',
    description: 'Check for updates and install if available',
    aliases: ['upgrade'],
    hidden: false,
    source: 'chunk-9y799w6p.js',
    offset: 42646,
  },
  {
    path: ['install'],
    kind: 'command',
    usage: 'install [target]',
    description:
      'Install PRRICODE native build. Use [target] to specify version (stable, latest, or specific version)',
    aliases: [],
    hidden: false,
    source: 'chunk-9y799w6p.js',
    offset: 42825,
  },
  {
    path: ['import'],
    kind: 'command',
    usage: 'import',
    description: 'Import config from another AI coding agent into PRRICODE',
    aliases: [],
    hidden: false,
    source: 'chunk-9y799w6p.js',
    offset: 43139,
  },
  {
    path: ['import-conversations'],
    kind: 'command',
    usage: 'import-conversations <exportPath>',
    description: 'Import conversations from an export file',
    aliases: [],
    hidden: true,
    source: 'chunk-9y799w6p.js',
    offset: 43668,
  },
  {
    path: ['edit-hook'],
    kind: 'command',
    usage: 'edit-hook',
    description: 'Apply one hook edit read as JSON from stdin (used by the VS Code extension)',
    aliases: [],
    hidden: true,
    source: 'chunk-9y799w6p.js',
    offset: 20517,
  },

  /* The hidden editor commands — chunk-mancccdx.js:2065. */
  {
    path: ['edit-permission-rules'],
    kind: 'command',
    usage: 'edit-permission-rules',
    description:
      'Apply one permission-rule edit read as JSON from stdin (used by the VS Code extension)',
    aliases: [],
    hidden: true,
    source: 'chunk-mancccdx.js',
    offset: 2065,
  },
  {
    path: ['edit-memory-settings'],
    kind: 'command',
    usage: 'edit-memory-settings',
    description:
      'Apply one memory-settings edit read as JSON from stdin (used by the VS Code extension)',
    aliases: [],
    hidden: true,
    source: 'chunk-mancccdx.js',
    offset: 2821,
  },
  {
    path: ['edit-skill-overrides'],
    kind: 'command',
    usage: 'edit-skill-overrides',
    description:
      'Apply one skill state edit read as JSON from stdin (used by the VS Code extension)',
    aliases: [],
    hidden: true,
    source: 'chunk-mancccdx.js',
    offset: 3554,
  },
  {
    path: ['edit-sandbox-settings'],
    kind: 'command',
    usage: 'edit-sandbox-settings',
    description:
      'Apply one sandbox settings edit read as JSON from stdin (used by the VS Code extension)',
    aliases: [],
    hidden: true,
    source: 'chunk-mancccdx.js',
    offset: 4304,
  },
  {
    path: ['design-login'],
    kind: 'command',
    usage: 'design-login',
    description:
      'Run the PRRICODE Design sign-in, or report its state, as JSON lines (used by the VS Code extension)',
    aliases: [],
    hidden: true,
    source: 'chunk-mancccdx.js',
    offset: 5036,
  },
  {
    path: ['edit-chrome-settings'],
    kind: 'command',
    usage: 'edit-chrome-settings',
    description:
      'Apply one PRRICODE in Chrome settings edit read as JSON from stdin (used by the VS Code extension)',
    aliases: [],
    hidden: true,
    source: 'chunk-mancccdx.js',
    offset: 6017,
  },
  {
    path: ['drop-worktree-registrations'],
    kind: 'command',
    usage: 'drop-worktree-registrations',
    description:
      "Drop deleted worktrees' git registrations named as JSON on stdin (used by the VS Code extension)",
    aliases: [],
    hidden: true,
    source: 'chunk-mancccdx.js',
    offset: 6759,
  },

  /* The session-management subcommands — chunk-0y0ptpy9.js:4383, the set `g`.
     The target's set carries the six names and no description, so the descriptions
     below are **this implementation's own**. */
  {
    path: ['attach'],
    kind: 'command',
    usage: 'attach <session>',
    description: 'Attach to a session that is already running',
    aliases: [],
    hidden: false,
    source: 'chunk-0y0ptpy9.js',
    offset: 4383,
  },
  {
    path: ['logs'],
    kind: 'command',
    usage: 'logs <session>',
    description: 'Write the log of a session that is already running',
    aliases: [],
    hidden: false,
    source: 'chunk-0y0ptpy9.js',
    offset: 4383,
  },
  {
    path: ['stop'],
    kind: 'command',
    usage: 'stop <session>',
    description: 'Stop the session that is running in the background',
    aliases: [],
    hidden: false,
    source: 'chunk-0y0ptpy9.js',
    offset: 4383,
  },
  {
    path: ['kill'],
    kind: 'command',
    usage: 'kill <session>',
    description: 'Kill the session that is running in the background',
    aliases: [],
    hidden: false,
    source: 'chunk-0y0ptpy9.js',
    offset: 4383,
  },
  {
    path: ['respawn'],
    kind: 'command',
    usage: 'respawn <session>',
    description: 'Respawn the worker of a session',
    aliases: [],
    hidden: false,
    source: 'chunk-0y0ptpy9.js',
    offset: 4383,
  },
  {
    path: ['rm'],
    kind: 'command',
    usage: 'rm <session>',
    description: 'Remove a session',
    aliases: [],
    hidden: false,
    source: 'chunk-0y0ptpy9.js',
    offset: 4383,
  },
];

/** The groups of the command tree — the entries that hold other commands. */
export const CLI_COMMAND_GROUPS: readonly CliCommand[] = CLI_COMMAND_TREE.filter(
  (entry) => entry.kind === 'group',
);

/** The commands of the command tree — the entries that do something. */
export const CLI_COMMANDS: readonly CliCommand[] = CLI_COMMAND_TREE.filter(
  (entry) => entry.kind === 'command',
);

/**
 * The tree, indexed by the path a user types.
 *
 * The key of an entry is its path joined by a space, and the **aliases** of an entry
 * are indexed under their own names. The lookup is a `Map`, so a name is **data**:
 * a lookup can never resolve an inherited member of `Object.prototype`.
 */
const COMMAND_INDEX: ReadonlyMap<string, CliCommand> = (() => {
  const index = new Map<string, CliCommand>();
  for (const entry of CLI_COMMAND_TREE) {
    index.set(entry.path.join(' '), entry);
    for (const alias of entry.aliases) {
      const key = [...entry.path.slice(0, -1), alias].join(' ');
      if (!index.has(key)) index.set(key, entry);
    }
  }
  return index;
})();

/**
 * The command a path names.
 *
 * The path is the **whole** path the user typed: `['plugin', 'init']` is the
 * `plugin init` command and `['plugin']` is the `plugin` group.
 */
export function cliCommandOf(path: readonly string[]): CliCommand | undefined {
  return COMMAND_INDEX.get(path.join(' '));
}

/**
 * The command a **root-level** name names.
 *
 * A root-level name is a group (`plugin`, `mcp`, `auth`, `auto-mode`, `sandbox`,
 * `project`) or a command (`doctor`, `update`, `install`, …).
 */
export function cliRootCommandOf(name: string): CliCommand | undefined {
  return COMMAND_INDEX.get(name);
}

/* -------------------------------------------------------------------------- */
/* The flag values                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The flags a parse collected.
 *
 * The values live in a `Map`, so a flag name is **data**: a lookup can never
 * resolve an inherited member of `Object.prototype`, and no `Object.hasOwn`
 * guard is needed because there is no plain object to guard.
 */
export interface FlagValues {
  /** Whether the flag was given. */
  has(name: string): boolean;
  /** The value of the flag; the last one given wins. */
  get(name: string): string | undefined;
  /** Every value of the flag, in the order they were given. */
  all(name: string): readonly string[];
  /** The names of the flags that were given. */
  names(): readonly string[];
}

/** Build the flag values over a map of name to values. */
function flagValuesOf(collected: ReadonlyMap<string, readonly string[]>): FlagValues {
  return {
    has(name: string): boolean {
      return collected.has(name);
    },
    get(name: string): string | undefined {
      const values = collected.get(name);
      if (values === undefined || values.length === 0) return undefined;
      return values[values.length - 1];
    },
    all(name: string): readonly string[] {
      return collected.get(name) ?? [];
    },
    names(): readonly string[] {
      return [...collected.keys()];
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The parsed shapes                                                           */
/* -------------------------------------------------------------------------- */

/** A parse that failed. */
export interface ParsedErrorArgs {
  /** The discriminant. */
  kind: 'error';
  /** The message the CLI writes to stderr. */
  message: string;
  /** The exit code the CLI returns. */
  exitCode: 2;
}

/** The help command. */
export interface ParsedHelpArgs {
  /** The discriminant. */
  kind: 'help';
  /** The positional arguments that came with it. */
  positionals: readonly string[];
}

/** The version command. */
export interface ParsedVersionArgs {
  /** The discriminant. */
  kind: 'version';
  /** The positional arguments that came with it. */
  positionals: readonly string[];
}

/**
 * The routine command.
 *
 * **Observed** (audit §2.10): `--routine` and `--routine=<value>` are
 * **commands**, not flags. This implementation recognises them; it does not implement
 * them, and `runCommand` says so.
 */
export interface ParsedRoutineArgs {
  /** The discriminant. */
  kind: 'routine';
  /** The routine's name, when the flag carried one. */
  value?: string;
  /** The positional arguments that came with it. */
  positionals: readonly string[];
}

/**
 * One of the target's commands.
 *
 * The **path** is what the user typed: `['plugin', 'init']` for `prricode plugin init`.
 * The **group** is the path of the group the command lives in, and it is empty for a
 * root-level command.
 */
export interface ParsedCommandArgs {
  /** The discriminant. */
  kind: 'command';
  /** The command's own name. */
  command: string;
  /** The group the command lives in; empty for a root-level command. */
  group: string;
  /** The whole path the user typed. */
  path: readonly string[];
  /** The arguments the command was given. */
  args: readonly string[];
  /** The flags that were given. */
  flags: FlagValues;
}

/** A run. */
export interface ParsedRunArgs {
  /** The discriminant. */
  kind: 'run';
  /** The prompt, when one was given. */
  prompt?: string;
  /** Whether the run is headless. */
  headless: boolean;
  /** Whether the print mode was asked for. */
  print: boolean;
  /** Whether the run is in the background. */
  background: boolean;
  /** The output format. */
  outputFormat: OutputFormat;
  /** The input format. */
  inputFormat: InputFormat;
  /** Whether the run continues the newest session. */
  continueSession: boolean;
  /** The session to resume. */
  resume?: string;
  /** The message to resume at. */
  resumeSessionAt?: string;
  /** The session id the run uses. */
  sessionId?: string;
  /** The model the run uses. */
  model?: string;
  /** The permission mode the run starts in. */
  permissionMode?: PermissionModeName;
  /** The session's name. */
  name?: string;
  /** Whether the run only initializes the session. */
  initOnly: boolean;
  /** The SDK url. */
  sdkUrl?: string;
  /** The settings file the `--settings` flag named. */
  settingsFile?: string;
  /** The cloud session the `--cloud` flag named. */
  cloudTarget?: CloudTarget;
  /** Whether the session is persisted. */
  noSessionPersistence: boolean;
  /** Whether the run loads a copy of the session it resumes. */
  forkSession: boolean;
  /** Whether the dangerous permission prompt is skipped. */
  dangerouslySkipPermissions: boolean;
  /** The tools that are allowed. */
  allowedTools: readonly string[];
  /** The tools that are refused. */
  disallowedTools: readonly string[];
  /** The tools the session offers. */
  tools: readonly string[];
  /** The directories the session may write in. */
  addDirs: readonly string[];
  /** The MCP configuration files. */
  mcpConfigs: readonly string[];
  /** The beta flags the request carries. */
  betas: readonly string[];
  /** The files the session starts with. */
  files: readonly string[];
  /** The channels the session uses. */
  channels: readonly string[];
  /** The development channels the session loads. */
  developmentChannels: readonly string[];
  /** Every flag that was given. */
  flags: FlagValues;
  /** The positional arguments. */
  positionals: readonly string[];
}

/**
 * The permission modes the target has.
 *
 * The list is the target's own six (audit §2.5), spelled as the target spells
 * them. The alias `manual` is the target's alias of `default`.
 */
export const PERMISSION_MODE_NAMES = [
  'default',
  'manual',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'auto',
  'dontAsk',
] as const;

/** One of the target's permission modes. */
export type PermissionModeName = (typeof PERMISSION_MODE_NAMES)[number];

/**
 * The result of a parse.
 *
 * The union is **discriminated** by its `kind`, so a caller narrows it with one
 * check and every member carries only what that case needs.
 */
/**
 * The multi-provider manager.
 *
 * **Project extension.** The target has no provider manager; the surface is the
 * implementation's, and the plan's Step 8 requires the same operations to be available
 * as `--provider list`-style non-interactive flags with machine-readable output.
 *
 * The manager's own arguments are handed over **unparsed**: the manager
 * commands have their own verbs, their own flags and their own output, and
 * re-parsing them here would give the CLI two parsers for one surface.
 */
export interface ParsedManagerArgs {
  /** The discriminant. */
  kind: 'manager';
  /** Which manager surface the arguments name. */
  command: 'provider' | 'catalog';
  /**
   * Which form the user wrote.
   *
   * The **flag** form (`--provider list`) is the non-interactive one and its
   * output is **machine-readable**; the **word** form (`provider list`) is the
   * interactive one and its output is text. The manager needs to know which,
   * because the parser consumed the token.
   */
  form: 'flag' | 'word';
  /** The arguments the manager parses itself. */
  args: string[];
}

export type ParsedArgs =
  | ParsedRunArgs
  | ParsedCommandArgs
  | ParsedRoutineArgs
  | ParsedHelpArgs
  | ParsedVersionArgs
  | ParsedManagerArgs
  | ParsedErrorArgs;

/* -------------------------------------------------------------------------- */
/* The options                                                                 */
/* -------------------------------------------------------------------------- */

/** The options a parse runs with. */
export interface ParseOptions {
  /**
   * Whether stdout is a terminal.
   *
   * It defaults to `process.stdout.isTTY`, which is what makes the headless
   * rule work: **observed** (audit §2.10), "Headless mode is forced by a
   * non-TTY stdout". The member exists so that the rule can be exercised
   * without a terminal.
   */
  isTTY?: boolean;
}

/* -------------------------------------------------------------------------- */
/* The parser                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Parse the command line.
 *
 * The result is one of the union's members. An **argument error** is the
 * `error` member, and it carries the exit code the CLI returns — `2`, the
 * audit's "argument error" code.
 */
export function parseArgs(argv: string[], options: ParseOptions = {}): ParsedArgs {
  const isTTY = options.isTTY ?? process.stdout.isTTY === true;

  const collected = new Map<string, string[]>();
  const positionals: string[] = [];
  let mode: CommandKind | undefined;
  let commandPath: string[] | undefined;
  let printValue: string | undefined;
  let routineValue: string | undefined;
  // **Implementation choice**: `--help` and `--version` win **wherever** they appear. The
  // audit records the tokens but not their precedence, and a help request that
  // loses to an earlier `--print` is a help request the user never sees.
  let helpRequested = false;
  let versionRequested = false;

  /** The tokens that are left to read. */
  const queue: string[] = [...argv];
  let cursor = 0;

  /** Record a flag's values. */
  const record = (name: string, values: readonly string[]): void => {
    const existing = collected.get(name);
    if (existing === undefined) collected.set(name, [...values]);
    else existing.push(...values);
  };

  while (cursor < queue.length) {
    const token = queue[cursor];
    cursor += 1;
    if (token === undefined) continue;

    // **The multi-provider manager** (a project extension). The **flag** form
    // (`--catalog list`) is unambiguous, while a prompt that merely mentions
    // "catalog" is not — so the flag form names the surface, and the word
    // form only names it when it comes first. Everything from the token on is
    // the manager's own.
    if (token === '--provider' || token === '--catalog') {
      // The manager is a **command**, so it cannot be combined with a prompt:
      // silently discarding the prompt would be a surprise. A prompt or a mode
      // already seen is a conflict, and the conflict is named.
      if (mode !== undefined || positionals.length > 0) {
        return {
          kind: 'error',
          message: `Error: the '${token}' command cannot be combined with a prompt.`,
          exitCode: 2,
        };
      }
      return {
        kind: 'manager',
        command: token === '--catalog' ? 'catalog' : 'provider',
        form: 'flag',
        args: queue.slice(cursor),
      };
    }
    if (
      positionals.length === 0 &&
      commandPath === undefined &&
      mode === undefined &&
      (token === 'provider' || token === 'catalog')
    ) {
      return { kind: 'manager', command: token, form: 'word', args: queue.slice(cursor) };
    }

    // `--` ends the flag parsing: everything after it is a positional.
    if (token === '--') {
      while (cursor < queue.length) {
        const rest = queue[cursor];
        cursor += 1;
        if (rest !== undefined) positionals.push(rest);
      }
      break;
    }

    // A token is a flag when it has more than one character and starts with `-`.
    if (!isFlagToken(token)) {
      // A bare word is a **command** when it names one and no command has been
      // named yet; otherwise it is a positional.
      if (commandPath === undefined && positionals.length === 0 && mode === undefined) {
        const root = cliRootCommandOf(token);
        if (root !== undefined) {
          commandPath = [...root.path];
          continue;
        }
      } else if (commandPath !== undefined) {
        // Inside a **group**, the next bare word may name one of the group's
        // commands.
        const child = cliCommandOf([...commandPath, token]);
        if (child !== undefined) {
          commandPath = [...child.path];
          continue;
        }
      }
      positionals.push(token);
      continue;
    }

    // `--print=<value>` names the prompt; `--routine=<value>` names a routine.
    if (token.startsWith('--print=')) {
      if (mode === undefined) mode = 'print';
      const value = token.slice('--print='.length);
      // **Implementation choice**: an **empty** inline value is no value. `--print=` names
      // the mode; the prompt still comes from the positional argument or from the
      // standard input.
      printValue = value === '' ? undefined : value;
      continue;
    }
    if (token.startsWith('--routine=')) {
      if (mode === undefined) mode = 'routine';
      routineValue = token.slice('--routine='.length);
      continue;
    }

    // A command token is a command, not a flag.
    const commandKind = COMMAND_TOKENS.get(token);
    if (commandKind !== undefined) {
      if (commandKind === 'help') helpRequested = true;
      else if (commandKind === 'version') versionRequested = true;
      else if (mode === undefined) mode = commandKind;
      continue;
    }

    // A short flag that names a long one.
    const longForm = SHORT_FLAG_ALIASES.get(token);
    const flagName = longForm ?? token;

    // `--flag=value` yields the value.
    let name = flagName;
    let inline: string | undefined;
    if (flagName.startsWith('--')) {
      const equals = flagName.indexOf('=');
      if (equals !== -1) {
        name = flagName.slice(0, equals);
        inline = flagName.slice(equals + 1);
      }
    }

    // A **boolean** flag owns nothing. It is checked before the short-cluster
    // rule, because the target's boolean set carries `-d2e`, which the cluster
    // pattern would otherwise swallow.
    if (PARSER_BOOLEAN_FLAGS.has(name)) {
      if (inline !== undefined) return errorArgs(`Error: ${name} does not take a value.`);
      record(name, []);
      continue;
    }

    // A short flag cluster is one token. It is expanded only when every letter
    // is a known short flag; otherwise it is an unknown option.
    if (SHORT_CLUSTER_PATTERN.test(token)) {
      const letters = expandShortCluster(token);
      if (letters === undefined) return errorArgs(`Error: unknown option '${token}'.`);
      queue.splice(cursor, 0, ...letters);
      continue;
    }

    if (REPEATABLE_FLAG_SET.has(name)) {
      const values: string[] = [];
      if (inline !== undefined) values.push(inline);
      // The flag owns the next token **whatever it looks like**, and every
      // token after it that does not look like a flag.
      const next = queue[cursor];
      if (next !== undefined) {
        values.push(next);
        cursor += 1;
        while (cursor < queue.length) {
          const following = queue[cursor];
          if (following === undefined || isFlagToken(following)) break;
          values.push(following);
          cursor += 1;
        }
      }
      record(name, values);
      continue;
    }

    if (VALUE_FLAG_SET.has(name)) {
      let value = inline;
      if (value === undefined) {
        const next = queue[cursor];
        if (next === undefined) {
          // **Implementation choice**: the one value flag with the
          // optional-value behaviour takes no value at all.
          if (OPTIONAL_VALUE_EXCEPTIONS.has(name)) {
            record(name, []);
            continue;
          }
          return errorArgs(`Error: ${name} requires a value.`);
        }
        if (OPTIONAL_VALUE_EXCEPTIONS.has(name) && isFlagToken(next)) {
          record(name, []);
          continue;
        }
        value = next;
        cursor += 1;
      }
      record(name, [value]);
      continue;
    }

    if (OPTIONAL_VALUE_FLAG_SET.has(name)) {
      let value = inline;
      if (value === undefined) {
        const next = queue[cursor];
        // The value is **optional**: it is taken only when the next token does
        // not look like a flag.
        if (next !== undefined && !isFlagToken(next)) {
          value = next;
          cursor += 1;
        }
      }
      record(name, value === undefined ? [] : [value]);
      continue;
    }

    return errorArgs(`Error: unknown option '${token}'.`);
  }

  const flags = flagValuesOf(collected);

  // **Implementation choice**: `--help` and `--version` win regardless of the order they
  // were given in, and regardless of anything else on the command line.
  if (helpRequested) return { kind: 'help', positionals: [...positionals] };
  if (versionRequested) return { kind: 'version', positionals: [...positionals] };
  if (commandPath !== undefined) {
    const entry = cliCommandOf(commandPath);
    const group = entry === undefined ? '' : entry.path.slice(0, -1).join(' ');
    return {
      kind: 'command',
      command: entry?.path[entry.path.length - 1] ?? commandPath[commandPath.length - 1] ?? '',
      group,
      path: [...commandPath],
      args: [...positionals],
      flags,
    };
  }
  if (mode === 'help') return { kind: 'help', positionals: [...positionals] };
  if (mode === 'version') return { kind: 'version', positionals: [...positionals] };
  if (mode === 'routine') {
    const routine: ParsedRoutineArgs = { kind: 'routine', positionals: [...positionals] };
    if (routineValue !== undefined) routine.value = routineValue;
    return routine;
  }

  return finishRun({
    flags,
    positionals,
    mode,
    printValue,
    isTTY,
  });
}

/* -------------------------------------------------------------------------- */
/* The run's own checks                                                        */
/* -------------------------------------------------------------------------- */

/** The inputs of the checks that follow the scan. */
interface RunInputs {
  /** The flags that were given. */
  flags: FlagValues;
  /** The positional arguments. */
  positionals: readonly string[];
  /** The command token that was found, if any. */
  mode: CommandKind | undefined;
  /** The value `--print=` carried, if any. */
  printValue: string | undefined;
  /** Whether stdout is a terminal. */
  isTTY: boolean;
}

/**
 * The checks that follow the scan.
 *
 * They run in the order the audit's table lists them, and each one reproduces
 * the target's message **verbatim** where the audit records it.
 */
function finishRun(inputs: RunInputs): ParsedArgs {
  const { flags, positionals, mode, printValue, isTTY } = inputs;

  // The mode the run is in.
  //
  // **Implementation choice.** The audit's `<mode>` placeholder is ambiguous: the audit
  // records three rows that name a mode and does not say which mode each row is
  // about. This implementation's modes are `print` and `background`, and it applies the
  // rows as follows — the reasoning is in the file header:
  //
  //   - "a mode that cannot be combined with resume/continue/teleport" applies
  //     to **`background`**. The target's print mode **does** combine with
  //     `--resume`: the target's own message says "when used with `--print`".
  //   - "`--init-only` or `--session-id` combined with a mode" applies to
  //     **every** mode: `--init-only` and `--session-id` name the session, and a
  //     mode names how the run talks to the user.
  //   - "a non-interactive mode with `--output-format stream-json`" applies to
  //     **`background`**. The target's print mode uses `stream-json` — the
  //     audit's own `--input-format=stream-json` rules require `--print`.
  const modeName = mode === 'background' ? 'background' : mode === 'print' ? 'print' : undefined;

  // The output format.
  const outputFormatValue = flags.get('--output-format');
  let outputFormat: OutputFormat = 'text';
  if (outputFormatValue !== undefined) {
    if (!isOutputFormat(outputFormatValue)) {
      // **Implementation choice**: the audit records an **input**-format message and no
      // output-format one. This message is this implementation's own.
      return errorArgs(`Error: Invalid output format "${outputFormatValue}".`);
    }
    outputFormat = outputFormatValue;
  }

  // The input format. **Observed**: `Error: Invalid input format "<value>".`
  const inputFormatValue = flags.get('--input-format');
  let inputFormat: InputFormat = 'text';
  if (inputFormatValue !== undefined) {
    if (!isInputFormat(inputFormatValue)) {
      return errorArgs(`Error: Invalid input format "${inputFormatValue}".`);
    }
    inputFormat = inputFormatValue;
  }

  const print = mode === 'print';
  const initOnly = flags.has('--init-only');
  const sdkUrl = flags.get('--sdk-url');
  const cloud = flags.get('--cloud');
  const environment = flags.get('--environment');
  const remote = flags.get('--remote');

  // **Observed**: `Error: --input-format=stream-json requires
  // output-format=stream-json.`
  if (inputFormat === 'stream-json' && outputFormat !== 'stream-json') {
    return errorArgs('Error: --input-format=stream-json requires output-format=stream-json.');
  }

  // **Observed**: `Error: --input-format=stream-json requires --print.`
  if (inputFormat === 'stream-json' && !print) {
    return errorArgs('Error: --input-format=stream-json requires --print.');
  }

  // **Observed**: `<mode> does not support --output-format stream-json` — the
  // background mode, the one non-interactive mode that does not speak it.
  if (modeName === 'background' && outputFormat === 'stream-json') {
    return errorArgs('background does not support --output-format stream-json');
  }

  // **Observed**: `Error: --sdk-url requires both --input-format=stream-json and
  // --output-format=stream-json.`
  if (sdkUrl !== undefined && !(inputFormat === 'stream-json' && outputFormat === 'stream-json')) {
    return errorArgs(
      'Error: --sdk-url requires both --input-format=stream-json and --output-format=stream-json.',
    );
  }

  // **Observed**: `Error: --no-session-persistence can only be used with --print
  // mode.`
  if (flags.has('--no-session-persistence') && !print) {
    return errorArgs('Error: --no-session-persistence can only be used with --print mode.');
  }

  // **Observed**: `<mode> cannot be combined with --resume, --continue, or
  // --teleport` — the background mode.
  if (
    modeName === 'background' &&
    (flags.has('--resume') || flags.has('--continue') || flags.has('--teleport'))
  ) {
    return errorArgs('background cannot be combined with --resume, --continue, or --teleport');
  }

  // **Observed**: `<mode> cannot be combined with --init-only` and `<mode> cannot
  // be combined with --session-id` — every mode this implementation has.
  if (modeName !== undefined) {
    if (initOnly) return errorArgs(`${modeName} cannot be combined with --init-only`);
    if (flags.has('--session-id')) {
      return errorArgs(`${modeName} cannot be combined with --session-id`);
    }
  }

  // **Observed**: `Error: --attach-serve requires the serve-only headless launch
  // (non-interactive, --input-format stream-json and --output-format stream-json)
  // and an enabled headless cloud client; it never falls back to a plain attach`.
  //
  // This implementation has **no** headless cloud client, so the rule never holds: the flag
  // is refused rather than accepted and ignored.
  if (flags.has('--attach-serve')) {
    const serveOnly =
      !isTTY && inputFormat === 'stream-json' && outputFormat === 'stream-json';
    if (!serveOnly || !HEADLESS_CLOUD_CLIENT_ENABLED) {
      return errorArgs(
        'Error: --attach-serve requires the serve-only headless launch (non-interactive, --input-format stream-json and --output-format stream-json) and an enabled headless cloud client; it never falls back to a plain attach',
      );
    }
  }

  // **Observed**: `Error: --forward-home-settings takes true or false, not
  // <value>.`
  const forwardHomeSettings = flags.get('--forward-home-settings');
  if (forwardHomeSettings !== undefined) {
    if (forwardHomeSettings !== 'true' && forwardHomeSettings !== 'false') {
      return errorArgs(
        `Error: --forward-home-settings takes true or false, not ${forwardHomeSettings}.`,
      );
    }
    // **Observed**: `Error: --forward-home-settings says whether this machine's
    // settings go into a cloud session; pass --cloud (a new session, or one to
    // attach to) or --environment`
    if (cloud === undefined && environment === undefined) {
      return errorArgs(
        "Error: --forward-home-settings says whether this machine's settings go into a cloud session; pass --cloud (a new session, or one to attach to) or --environment",
      );
    }
  }

  // **Observed**: `Error: --environment creates a new session; it cannot be
  // combined with --cloud <session_id|url>`
  if (environment !== undefined && cloud !== undefined) {
    return errorArgs(
      'Error: --environment creates a new session; it cannot be combined with --cloud <session_id|url>',
    );
  }

  // The prompt of a print run: the positional, or the value `--print=` carried.
  const promptFromPositional = positionals.length > 0 ? positionals[0] : undefined;
  const prompt = printValue ?? promptFromPositional;

  // **Observed**: `non-interactive <mode> reads the prompt from the positional or
  // stdin; drop --cloud/--remote <description>.`
  if (print && (cloud !== undefined || remote !== undefined)) {
    // **Observed**: `Error: the task was given twice: as --cloud's value
    // (<value>) and as the prompt. With --print, give it in one place; to name
    // the session, use -n/--name.`
    if (cloud !== undefined && prompt !== undefined) {
      return errorArgs(
        `Error: the task was given twice: as --cloud's value (${cloud}) and as the prompt. With --print, give it in one place; to name the session, use -n/--name.`,
      );
    }
    return errorArgs(
      'non-interactive print reads the prompt from the positional or stdin; drop --cloud/--remote <description>.',
    );
  }

  // **Implementation choice**: `--continue` and `--resume` name two different sessions,
  // and the audit records no message for the pair. This implementation refuses the pair
  // with exit code 2.
  const continueSession = flags.has('--continue');
  const resume = flags.get('--resume');
  if (continueSession && flags.has('--resume')) {
    return errorArgs('Error: --continue and --resume cannot be used together.');
  }

  // **Implementation choice**: the print mode takes **one** prompt argument.
  if (print && (positionals.length > 1 || (printValue !== undefined && positionals.length > 0))) {
    return errorArgs('Error: --print takes one prompt argument.');
  }

  // The permission mode.
  const permissionModeValue = flags.get('--permission-mode');
  let permissionMode: PermissionModeName | undefined;
  if (permissionModeValue !== undefined) {
    if (!isPermissionModeName(permissionModeValue)) {
      // **Implementation choice**: the audit records the six permission modes and no
      // message for an unknown one. This message is this implementation's own.
      return errorArgs(`Error: Invalid permission mode "${permissionModeValue}".`);
    }
    permissionMode = permissionModeValue;
  }

  // The headless rule. **Observed**: "The headless decision is `--print` (or
  // `-p`), `--init-only`, `--sdk-url`, **or `!process.stdout.isTTY`**."
  const headless = print || initOnly || sdkUrl !== undefined || !isTTY;

  const run: ParsedRunArgs = {
    kind: 'run',
    headless,
    print,
    background: mode === 'background',
    outputFormat,
    inputFormat,
    continueSession,
    initOnly,
    noSessionPersistence: flags.has('--no-session-persistence'),
    forkSession: flags.has('--fork-session'),
    dangerouslySkipPermissions: flags.has('--dangerously-skip-permissions'),
    allowedTools: flags.all('--allowedTools').concat(flags.all('--allowed-tools')),
    disallowedTools: flags.all('--disallowedTools').concat(flags.all('--disallowed-tools')),
    tools: flags.all('--tools'),
    addDirs: flags.all('--add-dir'),
    mcpConfigs: flags.all('--mcp-config'),
    betas: flags.all('--betas'),
    files: flags.all('--file'),
    channels: flags.all('--channels'),
    developmentChannels: flags.all('--dangerously-load-development-channels'),
    flags,
    positionals: [...positionals],
  };

  if (prompt !== undefined) run.prompt = prompt;
  // A `--resume` with no value names no session. The empty value is carried so
  // that the run reaches the session module, which reports the target's own
  // message for a resume that names nothing.
  if (flags.has('--resume')) run.resume = resume ?? '';
  const resumeSessionAt = flags.get('--resume-session-at');
  if (resumeSessionAt !== undefined) run.resumeSessionAt = resumeSessionAt;
  const sessionId = flags.get('--session-id');
  if (sessionId !== undefined) run.sessionId = sessionId;
  const model = flags.get('--model');
  if (model !== undefined) run.model = model;
  if (permissionMode !== undefined) run.permissionMode = permissionMode;
  const name = flags.get('--name');
  if (name !== undefined) run.name = name;
  if (sdkUrl !== undefined) run.sdkUrl = sdkUrl;
  const settingsFile = flags.get('--settings');
  if (settingsFile !== undefined) run.settingsFile = settingsFile;
  if (cloud !== undefined) run.cloudTarget = cloudTargetOf(cloud);

  return run;
}

/* -------------------------------------------------------------------------- */
/* The helpers                                                                 */
/* -------------------------------------------------------------------------- */

/** A failed parse. */
function errorArgs(message: string): ParsedErrorArgs {
  return { kind: 'error', message, exitCode: 2 };
}

/**
 * The single-letter flags a cluster carries.
 *
 * `undefined` when a letter is not a known short flag: the cluster is then an
 * **unknown option**, and the whole token is reported — it is never split into
 * a flag and a value.
 */
function expandShortCluster(token: string): string[] | undefined {
  const letters = token.slice(1).split('');
  const expanded: string[] = [];
  for (const letter of letters) {
    const flag = `-${letter}`;
    if (!SHORT_FLAG_ALIASES.has(flag)) return undefined;
    expanded.push(flag);
  }
  return expanded;
}

/** Whether a value is one of the target's permission modes. */
function isPermissionModeName(value: string): value is PermissionModeName {
  return (PERMISSION_MODE_NAMES as readonly string[]).includes(value);
}

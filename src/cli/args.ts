/**
 * The command-line surface: the parser, the flag vocabulary, and the shapes the
 * parse produces.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.10 (The command-line
 * surface) and the `CC-014` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## The parser's structure
 *
 * **Observed** (audit §2.10, "The parser's structure"): "The scanner walks `argv`
 * until `--` (which ends flag parsing). A token of the form `--flag=value` yields
 * that value; a token equal to a known flag consumes the next token as its value.
 * A token is a **flag** when it has more than one character and starts with `-`.
 * The parser keeps three sets:
 *
 *   - a set of flags that **take a value**;
 *   - a **repeatable** subset of those — `--allowedTools`, `--allowed-tools`,
 *     `--disallowedTools`, `--disallowed-tools`, `--tools`, `--add-dir`,
 *     `--mcp-config`, `--betas`, `--file`, `--channels`,
 *     `--dangerously-load-development-channels` — which consume **every**
 *     following non-flag token;
 *   - a set of **boolean** flags, which consume the next token only when it does
 *     **not** look like a flag — so `-r`/`--resume` takes an *optional* value."
 *
 * And: "A **short flag cluster** (`/^-[A-Za-z]{2,}$/`, e.g. `-d2e`) is a single
 * token, not two flags. A token that is one of `-p`, `--print`, `--bg`,
 * `--background`, `--routine`, `-h`, `--help`, `-v`, `-V`, `--version`, or that
 * starts with `--routine=`, is a **command**, not a flag."
 *
 * ## The headless rule
 *
 * **Observed** (audit §2.10): "Headless mode is forced by a non-TTY stdout. The
 * headless decision is `--print` (or `-p`), `--init-only`, `--sdk-url`, **or
 * `!process.stdout.isTTY`**."
 *
 * ## What is a implementation choice
 *
 * The audit records "only the flags this implementation's own surface needs", so the flag
 * table below is this implementation's own. The **rules** the parser applies to them are
 * the target's. Where the audit leaves a choice open, the choice is marked:
 *
 *   - the **short flag cluster** is expanded only when **every** letter is a
 *     known short flag, and is otherwise an **unknown option**. The audit's own
 *     example (`-d2e`) carries a digit, which the audit's pattern
 *     (`/^-[A-Za-z]{2,}$/`) does not match, so this implementation widens the pattern to
 *     `[A-Za-z0-9]` and treats such a token as **one** token — which is the
 *     property the audit states.
 *   - the **optional value** of `-r`/`--resume` is the only flag that takes one.
 *     The audit describes the boolean set as consuming the next non-flag token,
 *     but a **pure** boolean that swallowed the next token would take the
 *     prompt with it (`agent --continue "the prompt"`), so this implementation keeps the
 *     rest pure and applies the optional value to the flag the audit names.
 *     **This is a implementation choice, and a deliberate one**: the audit's rule is
 *     reproduced for the flag it names, and the rest of the boolean set is
 *     **pure**. `docs/compatibility/command-surface.md` records the divergence.
 *   - a **bare subcommand** is a command when it comes **first**. The audit names
 *     the six subcommands but not where they may appear, and a first token is
 *     the only placement that cannot swallow a prompt.
 *   - the **messages** the audit does not record are this implementation's own. Every
 *     message the audit records is reproduced **verbatim**, and each one is
 *     marked as such at the place it is produced.
 *
 * ## The audit's validation table
 *
 * The audit's table has **fourteen** rows. This implementation reproduces **all fourteen**
 * messages, and it says which **mode** each of the three `<mode>` rows applies
 * to — the audit's placeholder is ambiguous, and a rule that does not say which
 * mode it decides is not a rule:
 *
 *   - the row "a mode that cannot be combined with resume/continue/teleport" is
 *     applied to the **background** mode. It is **not** applied to `print`:
 *     the target's own `--resume` message says "when used with `--print`", so
 *     the target's print mode **does** combine with `--resume`.
 *   - the row "`--init-only` or `--session-id` combined with a mode" is applied
 *     to **every** mode this implementation has: `--init-only` and `--session-id` name
 *     the session, and a mode names how the run talks to the user.
 *   - the row "a non-interactive mode with `--output-format stream-json`" is
 *     applied to the **background** mode: the target's print mode uses
 *     `stream-json` (the audit's own `--input-format=stream-json` rules require
 *     `--print`), so the row is about another mode.
 *
 * ## The rules this implementation does not implement
 *
 * The **parser** knows every flag of the target's own vocabulary this implementation's
 * surface needs — including the ones this implementation does not implement: `--sdk-url`
 * (this implementation has no SDK server), `--teleport` (this implementation has no teleport) and
 * the cloud flags (`--cloud`, `--remote`, `--environment` — this implementation has no
 * cloud client). Those are **refused by the run**, not by the parser, so that
 * the parser's own validation messages — which the audit records — still fire
 * first. `src/cli/command.ts` holds the list.
 *
 * `--attach-serve` needs an **enabled headless cloud client**, which this implementation
 * does not have, so the target's message is produced whenever the flag is
 * given: the rule is implemented, and this implementation never satisfies it.
 *
 * `--settings <file>` **is** implemented: the file is read, validated against
 * the settings schema and loaded as the highest-precedence overlay of the
 * tiered settings.
 */

import { isInputFormat, isOutputFormat } from './output.js';
import type { InputFormat, OutputFormat } from './output.js';

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The subcommands the target has.
 *
 * **Observed** (audit §2.10): "The **subcommands** are `attach`, `logs`, `stop`,
 * `kill`, `respawn`, `rm`."
 */
export const SUBCOMMANDS = ['attach', 'logs', 'stop', 'kill', 'respawn', 'rm'] as const;

/** One of the six subcommands. */
export type Subcommand = (typeof SUBCOMMANDS)[number];

/**
 * The shape of a session id, exactly as the target's pattern has it.
 *
 * **Observed** (audit §2.10): "A **session id** matches
 * `/^(?:session|cse)_[A-Za-z0-9_]+$/`; a path is scanned for such a segment."
 */
export const SESSION_ID_PATTERN = /^(?:session|cse)_[A-Za-z0-9_]+$/;

/**
 * The shape of a cloud session ref.
 *
 * **Observed** (audit §2.10): "A **cloud session ref** is an 8-hex-digit id
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
 * **Observed** (audit §2.10): "A **URI** argument starts with `cc://` or
 * `cc+unix://`."
 */
export function isUriArgument(value: string): boolean {
  return value.startsWith('cc://') || value.startsWith('cc+unix://');
}

/**
 * The session id a path names, when it names one.
 *
 * **Observed** (audit §2.10): "a path is scanned for such a segment". The scan
 * is over the path's **segments**, so a directory whose name happens to look
 * like a session id is the segment that is found — this implementation takes the **last**
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

/* -------------------------------------------------------------------------- */
/* The flag tables                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The flags that take a value.
 *
 * A flag of this set consumes the **next** token as its value, whether or not
 * that token looks like a flag — the audit's rule for a known flag.
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--model',
  '--output-format',
  '--input-format',
  '--session-id',
  '--resume-session-at',
  '--permission-mode',
  '--name',
  '--sdk-url',
  '--cloud',
  '--environment',
  '--remote',
  '--forward-home-settings',
  '--max-turns',
  '--append-system-prompt',
  '--system-prompt',
  '--settings',
  '--teleport',
]);

/**
 * The repeatable flags.
 *
 * **Observed** (audit §2.10): the eleven names the audit lists. Each of them
 * consumes **every** following non-flag token, so `--allowedTools Read Write`
 * names two tools.
 */
const REPEATABLE_FLAGS: ReadonlySet<string> = new Set([
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
]);

/**
 * The flags that take an **optional** value.
 *
 * **Observed** (audit §2.10): "so `-r`/`--resume` takes an *optional* value". A
 * flag of this set consumes the next token only when that token does **not**
 * look like a flag.
 *
 * **A implementation choice, and a deliberate one.** The audit describes the **boolean**
 * set as consuming the next non-flag token, which would make every boolean in
 * the set swallow the prompt (`agent --continue "the prompt"`). This implementation
 * applies the optional value to the flag the audit **names** — `-r`/`--resume` —
 * and keeps the rest of the boolean set **pure**. The divergence is recorded in
 * the compatibility matrix.
 */
const OPTIONAL_VALUE_FLAGS: ReadonlySet<string> = new Set(['-r', '--resume']);

/**
 * The boolean flags.
 *
 * A flag of this set takes no value: it is either given or it is not.
 */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  '--continue',
  '--init-only',
  '--no-session-persistence',
  '--attach-serve',
  '--fork-session',
  '--verbose',
  '--debug',
  '--dangerously-skip-permissions',
]);

/**
 * The short flags this implementation knows.
 *
 * `-p` (print), `-h` (help), `-v`/`-V` (version) and `-r` (resume) are named by
 * the audit; `-n` (name) is named by the target's own message ("to name the
 * session, use `-n/--name`"). `-c` (continue) is the target's own short form of
 * `--continue` — the pair the target's boolean set carries beside `-r`/`--resume`
 * — and this implementation's help text advertises it, so the parser must know it.
 *
 * The table is a `Map`, so a short flag is **data**: a lookup can never resolve
 * an inherited member of `Object.prototype`.
 */
const SHORT_FLAGS: ReadonlyMap<string, string> = new Map([
  ['-p', '--print'],
  ['-h', '--help'],
  ['-v', '--version'],
  ['-V', '--version'],
  ['-r', '--resume'],
  ['-n', '--name'],
  ['-c', '--continue'],
]);

/**
 * The tokens that are **commands**, not flags.
 *
 * **Observed** (audit §2.10): "A token that is one of `-p`, `--print`, `--bg`,
 * `--background`, `--routine`, `-h`, `--help`, `-v`, `-V`, `--version` … is a
 * **command**, not a flag."
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

/** The kinds of command the parser knows. */
type CommandKind = 'print' | 'background' | 'routine' | 'help' | 'version';

/**
 * The shape of a short flag cluster.
 *
 * The audit's pattern is `/^-[A-Za-z]{2,}$/`; this implementation widens the class to
 * `[A-Za-z0-9]` so that the audit's own example (`-d2e`) is covered. A token
 * that starts with `--` is never a cluster: the second character is not in the
 * class.
 */
const SHORT_CLUSTER_PATTERN = /^-[A-Za-z0-9]{2,}$/;

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

/** One of the target's subcommands. */
export interface ParsedCommandArgs {
  /** The discriminant. */
  kind: 'command';
  /** The subcommand's name. */
  command: Subcommand;
  /** The subcommand's arguments. */
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
export type ParsedArgs =
  | ParsedRunArgs
  | ParsedCommandArgs
  | ParsedRoutineArgs
  | ParsedHelpArgs
  | ParsedVersionArgs
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
  let command: Subcommand | undefined;
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
      // A bare subcommand is a command when it comes first.
      if (
        positionals.length === 0 &&
        command === undefined &&
        mode === undefined &&
        isSubcommand(token)
      ) {
        command = token;
        continue;
      }
      positionals.push(token);
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
    const longForm = SHORT_FLAGS.get(token);
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

    if (REPEATABLE_FLAGS.has(name)) {
      const values: string[] = [];
      if (inline !== undefined) values.push(inline);
      // Every following **non-flag** token belongs to the flag.
      while (cursor < queue.length) {
        const next = queue[cursor];
        if (next === undefined) break;
        if (isFlagToken(next)) break;
        values.push(next);
        cursor += 1;
      }
      record(name, values);
      continue;
    }

    if (VALUE_FLAGS.has(name)) {
      let value = inline;
      if (value === undefined) {
        const next = queue[cursor];
        if (next === undefined) return errorArgs(`Error: ${name} requires a value.`);
        value = next;
        cursor += 1;
      }
      record(name, [value]);
      continue;
    }

    if (OPTIONAL_VALUE_FLAGS.has(name)) {
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

    if (BOOLEAN_FLAGS.has(name)) {
      if (inline !== undefined) return errorArgs(`Error: ${name} does not take a value.`);
      record(name, []);
      continue;
    }

    return errorArgs(`Error: unknown option '${token}'.`);
  }

  const flags = flagValuesOf(collected);

  // **Implementation choice**: `--help` and `--version` win regardless of the order they
  // were given in, and regardless of anything else on the command line.
  if (helpRequested) return { kind: 'help', positionals: [...positionals] };
  if (versionRequested) return { kind: 'version', positionals: [...positionals] };
  if (command !== undefined) {
    return { kind: 'command', command, args: [...positionals], flags };
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
 * Whether a token is a flag.
 *
 * **Observed** (audit §2.10): "A token is a **flag** when it has more than one
 * character and starts with `-`." A lone `-` is therefore a positional.
 */
function isFlagToken(token: string): boolean {
  return token.length > 1 && token.startsWith('-');
}

/** Whether a token is one of the six subcommands. */
function isSubcommand(token: string): token is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(token);
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
    if (!SHORT_FLAGS.has(flag)) return undefined;
    expanded.push(flag);
  }
  return expanded;
}

/** Whether a value is one of the target's permission modes. */
function isPermissionModeName(value: string): value is PermissionModeName {
  return (PERMISSION_MODE_NAMES as readonly string[]).includes(value);
}

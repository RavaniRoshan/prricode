/**
 * Contract test for the command-line surface: the argument parser, the headless
 * mode and the output contracts.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.10 (The command-line
 * surface) and the `CC-014` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * The test pins:
 *
 *   - the parser's **structure**: `--flag=value` yields the value, `--` ends the
 *     flag parsing, a token is a flag when it has more than one character and
 *     starts with `-`, and a **short flag cluster** is one token and not two
 *     flags;
 *   - the **repeatable** flags, which consume **every** following non-flag token,
 *     and the **optional value** of `-r`/`--resume`;
 *   - `--print`/`-p` taking **one** prompt argument, and `--continue` and
 *     `--resume` being mutually exclusive;
 *   - the **output format** and the **input format** being validated, and an
 *     **unknown flag** being an error with **exit code 2**;
 *   - the **headless rule**: `--print`, `--init-only`, `--sdk-url` or a
 *     **non-TTY stdout** force the headless mode;
 *   - the **subcommands** the target has;
 *   - the **session-id pattern** and the scan of a path for such a segment;
 *   - the target's **validation messages**, verbatim;
 *   - the headless **output contracts**: `--output-format json` writes **exactly
 *     one** JSON document and exits 0 on success and non-zero on a provider
 *     error, and `--output-format stream-json` writes one JSON object per event;
 *   - the **production wiring** of the `PreToolUse` and `PermissionRequest`
 *     seams into the tool dependencies — the connection the `CC-007c` review
 *     found missing — and that the two wirings are **discriminated**: deleting
 *     either half of the wiring fails a test;
 *   - the **flags this implementation refuses** — the ones it recognises and does not
 *     implement — and the **settings file** `--settings` names;
 *   - the **stream-json input**: the standard input carries JSON documents, and
 *     the model receives their **text**, not the raw blob;
 *   - the **start mode**: the `--permission-mode` flag, the settings' default
 *     mode, and the three availability overrides the plan names.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  parseArgs,
  BOOLEAN_FLAG_NAMES,
  CLI_COMMAND_GROUPS,
  CLI_COMMAND_TREE,
  CLI_COMMANDS,
  CLOUD_SESSION_REF_PATTERN,
  COMMAND_TOKEN_NAMES,
  FLAG_ARGUMENT_HINTS,
  NON_FLAG_VALUE_FLAG_NAMES,
  OPTIONAL_VALUE_FLAG_NAMES,
  REPEATABLE_FLAG_NAMES,
  SESSION_ID_PATTERN,
  SESSION_SUBCOMMAND_NAMES,
  SUBCOMMANDS,
  VALUE_FLAG_NAMES,
  cliCommandOf,
  cliRootCommandOf,
  findSessionIdInPath,
  firstPositionalIndex,
  isCloudSessionRef,
  isCommandToken,
  isKnownFlag,
  isSessionId,
  isUriArgument,
  sessionSubcommandIndex,
  type ParsedArgs,
  type ParsedRunArgs,
} from '../../src/cli/args.js';
import {
  readStreamJsonInput,
  runHeadless,
  type HeadlessEvent,
} from '../../src/cli/headless.js';
import {
  EXIT_FAILURE,
  EXIT_SUCCESS,
  EXIT_USAGE,
  OUTPUT_FORMATS,
  writeHeadlessOutput,
  type OutputSink,
} from '../../src/cli/output.js';
import { CLI_VERSION, HELP_TEXT, UNIMPLEMENTED_OPTIONS, createCommandSession, runCommand } from '../../src/cli/command.js';
import { providerManagerCommand } from '../../src/cli/commands/manager.js';
import { catalogStoreOfState } from '../../src/cli/commands/catalog.js';
import {
  SLASH_COMMAND_DEFINITIONS,
  SLASH_COMMANDS,
  TARGET_SLASH_COMMANDS,
  runSlashCommand,
  slashCommandOf,
  type SlashCommandContext,
} from '../../src/cli/commands/slash.js';
import { renderAutocompleteSuggestion, slashCommandSuggestions } from '../../src/ui/render/prompts.js';
import { createProviderRegistry } from '../../src/provider/registry.js';
import type { CommandSession } from '../../src/cli/command.js';
import { createSessionStore, sessionFilePath } from '../../src/session/store.js';
import { TURN_SOURCE } from '../../src/agent/context.js';
import type { StreamingProviderDriver } from '../../src/agent/context.js';
import type { AgentRuntime, TurnInput, TurnResult } from '../../src/agent/loop.js';
import { createHookRegistry } from '../../src/extensions/hooks/registry.js';
import type {
  ProviderDriver,
  ProviderEvent,
  ProviderRequest,
} from '../../src/provider/drivers/types.js';
import type { SessionEvent } from '../../src/session/event.js';

/* -------------------------------------------------------------------------- */
/* The helpers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read the JSON documents a stream of output carries.
 *
 * The documents are written **one per line**, so the reader splits on the line
 * breaks and parses each line. It is the reader a machine uses to check the
 * `json` format's contract — **exactly one** document — and to count the
 * `stream-json` format's objects.
 *
 * The helper lives in the **test**: it is the reader of the contract, not part
 * of the contract itself.
 */
function readJsonDocuments(text: string): unknown[] {
  const documents: unknown[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    documents.push(JSON.parse(trimmed));
  }
  return documents;
}

/**
 * The version the package declares.
 *
 * The CLI's own version is a literal, and the contract is that the two agree:
 * the version the `--version` command prints is the package's version.
 */
function packageVersion(): string {
  const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const document: unknown = JSON.parse(raw);
  if (typeof document !== 'object' || document === null) return '';
  const record = document as Record<string, unknown>;
  const version = record['version'];
  return typeof version === 'string' ? version : '';
}

/**
 * Run a function with the process's own streams captured.
 *
 * The capture is what lets a test exercise the path where the CLI falls back to
 * the process's own streams — and see that it wrote to them.
 */
async function captureProcessStreams<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string; stderr: string }> {
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const captured = { stdout: '', stderr: '' };
  const text = (chunk: string | Uint8Array): string =>
    typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured.stdout += text(chunk);
    return true;
  }) as unknown as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured.stderr += text(chunk);
    return true;
  }) as unknown as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, stdout: captured.stdout, stderr: captured.stderr };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

/** A sink that collects what is written to it. */
class CollectingSink implements OutputSink {
  /** The text that was written. */
  text = '';

  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

/** The run arguments of a parse, or a failure when the parse did not produce one. */
function runOf(parsed: ParsedArgs): ParsedRunArgs {
  if (parsed.kind !== 'run') {
    throw new Error(`expected a run, got '${parsed.kind}': ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

/**
 * The target's product name, spelled in pieces.
 *
 * The name itself must not appear anywhere in this repository — not in a
 * string, not in a comment — so the guard that keeps it out spells it in
 * pieces rather than writing it down.
 */
const TARGET_PRODUCT_NAME = ['Cla', 'ude'].join('');

/**
 * The context a slash command runs with.
 *
 * The context is the **seam** the commands are handed: the store, the paths,
 * the session's own facts, and the three session seams the session commands
 * call. The helper builds one that touches nothing outside a temporary
 * directory.
 */
function slashContext(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  const configDir = makeDirectory();
  return {
    store: createSessionStore({ configDir }),
    cwd: configDir,
    configDir,
    sessionId: 'session-under-test',
    model: 'claude-sonnet-4-5',
    version: '0.1.0',
    events: [],
    env: {},
    managerState: async () => ({
      registry: createProviderRegistry(),
      catalogs: catalogStoreOfState([]),
    }),
    managerOptions: () => ({}),
    ...overrides,
  };
}

/** The message of a failed parse. */
function errorOf(parsed: ParsedArgs): string {
  if (parsed.kind !== 'error') {
    throw new Error(`expected an error, got '${parsed.kind}': ${JSON.stringify(parsed)}`);
  }
  return parsed.message;
}

/** The temporary directories the test creates. */
const temporaryDirectories: string[] = [];

function makeDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'cc014-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* The parser                                                                  */
/* -------------------------------------------------------------------------- */

describe('the argument parser', () => {
  it('takes one prompt argument for --print', () => {
    const parsed = runOf(parseArgs(['--print', 'what is the weather?']));

    expect(parsed.print).toBe(true);
    expect(parsed.prompt).toBe('what is the weather?');
  });

  it('takes one prompt argument for -p', () => {
    const parsed = runOf(parseArgs(['-p', 'what is the weather?']));

    expect(parsed.print).toBe(true);
    expect(parsed.prompt).toBe('what is the weather?');
  });

  it('refuses a second prompt argument in print mode', () => {
    const parsed = parseArgs(['-p', 'one', 'two']);

    expect(parsed.kind).toBe('error');
    expect(errorOf(parsed)).toContain('one prompt argument');
    expect(parsed.kind === 'error' ? parsed.exitCode : 0).toBe(EXIT_USAGE);
  });

  it('refuses --continue together with --resume', () => {
    const parsed = parseArgs(['--continue', '--resume', 'session_abc']);

    expect(parsed.kind).toBe('error');
    expect(parsed.kind === 'error' ? parsed.exitCode : 0).toBe(EXIT_USAGE);
  });

  it('accepts the three output formats', () => {
    for (const format of OUTPUT_FORMATS) {
      const parsed = runOf(parseArgs(['-p', 'hello', '--output-format', format]));
      expect(parsed.outputFormat).toBe(format);
    }
  });

  it('refuses an unknown output format', () => {
    const parsed = parseArgs(['-p', 'hello', '--output-format', 'yaml']);

    expect(parsed.kind).toBe('error');
    expect(errorOf(parsed)).toBe('Error: Invalid output format "yaml".');
    expect(parsed.kind === 'error' ? parsed.exitCode : 0).toBe(EXIT_USAGE);
  });

  it('refuses an unknown input format with the target’s wording', () => {
    const parsed = parseArgs(['-p', 'hello', '--input-format', 'yaml']);

    expect(parsed.kind).toBe('error');
    expect(errorOf(parsed)).toBe('Error: Invalid input format "yaml".');
    expect(parsed.kind === 'error' ? parsed.exitCode : 0).toBe(EXIT_USAGE);
  });

  it('refuses an unknown flag with exit code 2', () => {
    const parsed = parseArgs(['--not-a-flag']);

    expect(parsed.kind).toBe('error');
    expect(parsed.kind === 'error' ? parsed.exitCode : 0).toBe(EXIT_USAGE);
    expect(errorOf(parsed)).toContain('--not-a-flag');
  });

  it('reads the value of --flag=value', () => {
    const parsed = runOf(parseArgs(['--output-format=json', '-p', 'hello']));

    expect(parsed.outputFormat).toBe('json');
  });

  it('ends the flag parsing at --', () => {
    const parsed = runOf(parseArgs(['-p', '--', '--not-a-flag']));

    // The token after `--` is a positional, not an unknown flag.
    expect(parsed.positionals).toEqual(['--not-a-flag']);
    expect(parsed.prompt).toBe('--not-a-flag');
  });

  it('does not read a flag after --', () => {
    const parsed = parseArgs(['--', '--not-a-flag']);

    expect(parsed.kind).toBe('run');
  });

  it('treats a short flag cluster as one token', () => {
    // `-d2e` is one token: it is not the flag `-d` with the value `2e`. The
    // implementation refuses it as an unknown option rather than splitting it.
    const parsed = parseArgs(['-d2e']);

    expect(parsed.kind).toBe('error');
    expect(errorOf(parsed)).toContain('-d2e');
  });

  it('expands a short flag cluster whose letters are all known flags', () => {
    const parsed = runOf(parseArgs(['-pr']));

    expect(parsed.print).toBe(true);
    // The `-r` of the cluster names no session: it is followed by nothing.
    expect(parsed.flags.has('--resume')).toBe(true);
    expect(parsed.resume).toBe('');
  });

  it('consumes every following non-flag token for a repeatable flag', () => {
    const parsed = runOf(parseArgs(['-p', 'hello', '--allowedTools', 'Read', 'Write']));

    expect(parsed.allowedTools).toEqual(['Read', 'Write']);
    expect(parsed.positionals).toEqual(['hello']);
  });

  it('keeps the optional value of --resume', () => {
    const parsed = runOf(parseArgs(['--resume', 'session_abc']));

    expect(parsed.resume).toBe('session_abc');
  });

  it('takes no value for --resume when the next token is a flag', () => {
    const parsed = runOf(parseArgs(['--resume', '--print']));

    // The flag was given, and it named no session: the run reaches the session
    // module, which reports the target's message for a resume that names
    // nothing.
    expect(parsed.flags.has('--resume')).toBe(true);
    expect(parsed.resume).toBe('');
    expect(parsed.print).toBe(true);
  });

  it('recognises the six subcommands', () => {
    expect([...SUBCOMMANDS]).toEqual(['attach', 'logs', 'stop', 'kill', 'respawn', 'rm']);
    for (const command of SUBCOMMANDS) {
      const parsed = parseArgs([command]);
      expect(parsed.kind).toBe('command');
      expect(parsed.kind === 'command' ? parsed.command : '').toBe(command);
    }
  });

  it('recognises the target’s session-id pattern', () => {
    expect(SESSION_ID_PATTERN.test('session_abc123')).toBe(true);
    expect(SESSION_ID_PATTERN.test('cse_abc123')).toBe(true);
    expect(SESSION_ID_PATTERN.test('session-abc123')).toBe(false);
    expect(isSessionId('cse_9f2')).toBe(true);
    expect(isSessionId('nope')).toBe(false);
  });

  it('scans a path for a session-id segment', () => {
    expect(findSessionIdInPath('/home/u/.claude/projects/x/session_abc123.jsonl')).toBe(
      'session_abc123',
    );
    expect(findSessionIdInPath('/home/u/.claude/projects/x/nothing.jsonl')).toBeUndefined();
  });

  it('knows the cloud session ref and the URI arguments', () => {
    expect(CLOUD_SESSION_REF_PATTERN.test('deadbeef')).toBe(true);
    expect(isCloudSessionRef('deadbeef')).toBe(true);
    expect(isCloudSessionRef('deadbee')).toBe(false);
    expect(isUriArgument('cc://session/1')).toBe(true);
    expect(isUriArgument('cc+unix:///tmp/socket')).toBe(true);
    expect(isUriArgument('https://example.test')).toBe(false);
  });

  it('takes -c as the short form of --continue', () => {
    const parsed = runOf(parseArgs(['-c']));

    expect(parsed.continueSession).toBe(true);
  });

  it('takes an empty --print= as no prompt at all', () => {
    // `--print=` names the mode; the prompt still comes from the positional
    // argument.
    const parsed = runOf(parseArgs(['--print=', 'what is the weather?']));

    expect(parsed.print).toBe(true);
    expect(parsed.prompt).toBe('what is the weather?');
  });

  it('keeps the prompt out of a boolean flag', () => {
    // **Implementation choice**: the audit describes the boolean set as consuming the next
    // non-flag token, which would take the prompt with it. This implementation applies the
    // optional value to `-r`/`--resume` — the flag the audit names — and keeps the
    // rest of the boolean set **pure**. The divergence is recorded in the
    // compatibility matrix.
    const parsed = runOf(parseArgs(['--continue', 'what is the weather?']));

    expect(parsed.continueSession).toBe(true);
    expect(parsed.prompt).toBe('what is the weather?');
  });
});

/* -------------------------------------------------------------------------- */
/* The help and the version                                                    */
/* -------------------------------------------------------------------------- */

describe('the help and the version', () => {
  it('writes the help whatever the order of the flags', () => {
    expect(parseArgs(['--help']).kind).toBe('help');
    expect(parseArgs(['--print', '--help']).kind).toBe('help');
    expect(parseArgs(['--help', '--print']).kind).toBe('help');
  });

  it('writes the version whatever the order of the flags', () => {
    expect(parseArgs(['--version']).kind).toBe('version');
    expect(parseArgs(['--print', '--version']).kind).toBe('version');
    expect(parseArgs(['--version', '--print']).kind).toBe('version');
  });

  it('writes the version the package declares', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();

    const code = await runCommand(parseArgs(['--version']), { stdout, stderr });

    expect(code).toBe(EXIT_SUCCESS);
    // The version the CLI prints is the package's version: the two cannot drift.
    expect(CLI_VERSION).toBe(packageVersion());
    expect(stdout.text.trim()).toBe(packageVersion());
  });
});

/* -------------------------------------------------------------------------- */
/* The headless rule                                                           */
/* -------------------------------------------------------------------------- */

describe('the headless rule', () => {
  it('forces the headless mode when stdout is not a terminal', () => {
    const parsed = runOf(parseArgs([], { isTTY: false }));

    expect(parsed.headless).toBe(true);
  });

  it('is not headless on a terminal when no headless flag was given', () => {
    const parsed = runOf(parseArgs([], { isTTY: true }));

    expect(parsed.headless).toBe(false);
  });

  it('forces the headless mode for --print, --init-only and --sdk-url', () => {
    expect(runOf(parseArgs(['--print'], { isTTY: true })).headless).toBe(true);
    expect(runOf(parseArgs(['--init-only'], { isTTY: true })).headless).toBe(true);
    expect(
      runOf(
        parseArgs(
          [
            '--print',
            '--sdk-url',
            'http://127.0.0.1:1',
            '--input-format',
            'stream-json',
            '--output-format',
            'stream-json',
          ],
          { isTTY: true },
        ),
      ).headless,
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The target’s validation messages                                            */
/* -------------------------------------------------------------------------- */

describe('the target’s validation messages', () => {
  it('reproduces the --input-format=stream-json output requirement', () => {
    const parsed = parseArgs(['-p', 'hello', '--input-format', 'stream-json']);

    expect(errorOf(parsed)).toBe(
      'Error: --input-format=stream-json requires output-format=stream-json.',
    );
  });

  it('reproduces the --input-format=stream-json print requirement', () => {
    const parsed = parseArgs([
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
    ]);

    expect(errorOf(parsed)).toBe('Error: --input-format=stream-json requires --print.');
  });

  it('reproduces the --sdk-url requirement', () => {
    const parsed = parseArgs(['-p', 'hello', '--sdk-url', 'http://127.0.0.1:1']);

    expect(errorOf(parsed)).toBe(
      'Error: --sdk-url requires both --input-format=stream-json and --output-format=stream-json.',
    );
  });

  it('reproduces the --no-session-persistence requirement', () => {
    const parsed = parseArgs(['--no-session-persistence']);

    expect(errorOf(parsed)).toBe(
      'Error: --no-session-persistence can only be used with --print mode.',
    );
  });

  it('reproduces the --forward-home-settings wording', () => {
    const parsed = parseArgs(['-p', 'hello', '--forward-home-settings', 'yes']);

    expect(errorOf(parsed)).toBe(
      'Error: --forward-home-settings takes true or false, not yes.',
    );
  });

  it('reproduces the --forward-home-settings cloud requirement', () => {
    const parsed = parseArgs(['-p', 'hello', '--forward-home-settings', 'true']);

    expect(errorOf(parsed)).toBe(
      'Error: --forward-home-settings says whether this machine\'s settings go into a cloud session; pass --cloud (a new session, or one to attach to) or --environment',
    );
  });

  it('reproduces the --environment and --cloud exclusion', () => {
    const parsed = parseArgs([
      '-p',
      'hello',
      '--environment',
      'prod',
      '--cloud',
      'session_abc',
    ]);

    expect(errorOf(parsed)).toBe(
      'Error: --environment creates a new session; it cannot be combined with --cloud <session_id|url>',
    );
  });

  it('reproduces the task-given-twice message', () => {
    const parsed = parseArgs(['-p', 'hello', '--cloud', 'describe the task']);

    expect(errorOf(parsed)).toBe(
      "Error: the task was given twice: as --cloud's value (describe the task) and as the prompt. With --print, give it in one place; to name the session, use -n/--name.",
    );
  });

  it('reproduces the non-interactive cloud description message', () => {
    const parsed = parseArgs(['-p', '--remote', 'describe the task']);

    expect(errorOf(parsed)).toBe(
      'non-interactive print reads the prompt from the positional or stdin; drop --cloud/--remote <description>.',
    );
  });

  it('reproduces the --attach-serve message', () => {
    const parsed = parseArgs(['--attach-serve']);

    expect(errorOf(parsed)).toBe(
      'Error: --attach-serve requires the serve-only headless launch (non-interactive, --input-format stream-json and --output-format stream-json) and an enabled headless cloud client; it never falls back to a plain attach',
    );
    expect(parsed.kind === 'error' ? parsed.exitCode : 0).toBe(EXIT_USAGE);
  });

  it('reproduces the --attach-serve message for the serve-only launch too', () => {
    // This implementation has **no** headless cloud client, so the rule never holds: the
    // flag is refused rather than accepted and ignored.
    const parsed = parseArgs(
      [
        '--attach-serve',
        '--print',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
      ],
      { isTTY: false },
    );

    expect(errorOf(parsed)).toBe(
      'Error: --attach-serve requires the serve-only headless launch (non-interactive, --input-format stream-json and --output-format stream-json) and an enabled headless cloud client; it never falls back to a plain attach',
    );
  });

  it('reproduces the mode and resume message', () => {
    const parsed = parseArgs(['--bg', '--resume', 'session_abc']);

    expect(errorOf(parsed)).toBe(
      'background cannot be combined with --resume, --continue, or --teleport',
    );
    expect(parsed.kind === 'error' ? parsed.exitCode : 0).toBe(EXIT_USAGE);
  });

  it('reproduces the mode and --init-only message', () => {
    const parsed = parseArgs(['--print', '--init-only']);

    expect(errorOf(parsed)).toBe('print cannot be combined with --init-only');
    expect(parsed.kind === 'error' ? parsed.exitCode : 0).toBe(EXIT_USAGE);
  });

  it('reproduces the mode and --session-id message', () => {
    const parsed = parseArgs(['--print', '--session-id', 'session_abc']);

    expect(errorOf(parsed)).toBe('print cannot be combined with --session-id');
    expect(parsed.kind === 'error' ? parsed.exitCode : 0).toBe(EXIT_USAGE);
  });

  it('reproduces the mode and stream-json output message', () => {
    const parsed = parseArgs(['--bg', '--output-format', 'stream-json']);

    expect(errorOf(parsed)).toBe('background does not support --output-format stream-json');
    expect(parsed.kind === 'error' ? parsed.exitCode : 0).toBe(EXIT_USAGE);
  });

  it('still resumes a print run', () => {
    // The target's own `--resume` message says "when used with --print", so the
    // print mode **does** combine with `--resume` — the mode rows are not about
    // it.
    const parsed = runOf(parseArgs(['--print', '--resume', 'session_abc']));

    expect(parsed.resume).toBe('session_abc');
  });
});

/* -------------------------------------------------------------------------- */
/* The headless run                                                            */
/* -------------------------------------------------------------------------- */

/** A runtime that replays a fixed list of records. */
function runtimeOf(events: SessionEvent[], result: Partial<TurnResult> = {}): AgentRuntime {
  return {
    async runTurn(_input: TurnInput): Promise<TurnResult> {
      return { events, stopReason: 'end_turn', ...result };
    },
  };
}

/** A record of an assistant message. */
function assistantRecord(text: string): SessionEvent {
  return { v: 1, ts: 0, id: 'rec-1', t: 'assistant_message', text };
}

/**
 * A driver that replays fixed rounds of provider events.
 *
 * It carries the `TURN_SOURCE` marker, so it **is** the turn's transport: the
 * session's own wiring — the tools, the permission service and the two seams —
 * is exercised without a network.
 *
 * The **requests** it is given are recorded, so a test can see what the runtime
 * asked the provider for.
 */
function fakeDriver(
  rounds: readonly (readonly ProviderEvent[])[],
  requests: ProviderRequest[] = [],
): StreamingProviderDriver {
  let index = 0;
  const driver: ProviderDriver = {
    route: 'firstParty',
    buildUrl: () => 'https://example.test/v1/messages',
    buildHeaders: () => ({ 'content-type': 'application/json' }),
    buildBody: () => ({ body: {}, headers: {} }),
    parseStream: () => ({ events: [], state: undefined }),
    parseNonStreaming: () => ({ events: [] }),
    classifyError: () => ({ message: 'the provider failed', retryable: false }),
    calculateNonstreamingTimeout: () => 600_000,
    betaFlagsFor: (flags: string[]) => flags,
  };
  return {
    ...driver,
    [TURN_SOURCE]: true,
    async *send(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
      requests.push(request);
      const round = rounds[index] ?? [];
      index += 1;
      for (const event of round) yield event;
    },
  };
}

/** The rounds a turn that runs the `Bash` tool takes. */
function bashRounds(): ProviderEvent[][] {
  return [
    [
      { type: 'message_start', messageId: 'msg-1', model: 'claude-sonnet-4-5' },
      {
        type: 'tool_use',
        id: 'toolu_bash',
        name: 'Bash',
        input: { command: 'printf hello' },
      },
      { type: 'message_stop', stopReason: 'tool_use' },
    ],
    [
      { type: 'message_start', messageId: 'msg-2', model: 'claude-sonnet-4-5' },
      { type: 'text_delta', text: 'the command is done' },
      { type: 'message_stop', stopReason: 'end_turn' },
    ],
  ];
}

/** The rounds a write turn takes. */
function writeRounds(target: string): ProviderEvent[][] {
  return [
    [
      { type: 'message_start', messageId: 'msg-1', model: 'claude-sonnet-4-5' },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Write',
        input: { file_path: target, content: 'written' },
      },
      { type: 'message_stop', stopReason: 'tool_use' },
    ],
    [
      { type: 'message_start', messageId: 'msg-2', model: 'claude-sonnet-4-5' },
      { type: 'text_delta', text: 'the write is done' },
      { type: 'message_stop', stopReason: 'end_turn' },
    ],
  ];
}

describe('the headless run', () => {
  it('turns the turn’s records into the headless events', async () => {
    const events: HeadlessEvent[] = [];
    const stream = runHeadless({
      prompt: 'hello',
      sessionId: 'session-1',
      model: 'claude-sonnet-4-5',
      runtime: runtimeOf([assistantRecord('hi there')]),
    });

    for await (const event of stream) events.push(event);

    expect(events[0]).toEqual({ type: 'text', text: 'hi there' });
    expect(events[events.length - 1]?.type).toBe('result');
  });

  it('writes exactly one JSON document and exits 0 on success', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();

    const code = await writeHeadlessOutput({
      events: runHeadless({
        prompt: 'hello',
        sessionId: 'session-1',
        model: 'claude-sonnet-4-5',
        runtime: runtimeOf([assistantRecord('hi there')]),
      }),
      format: 'json',
      stdout,
      stderr,
    });

    expect(code).toBe(EXIT_SUCCESS);
    expect(stderr.text).toBe('');
    // Exactly one document: the whole stdout parses as one JSON value.
    const documents = readJsonDocuments(stdout.text);
    expect(documents).toHaveLength(1);
    expect(JSON.parse(stdout.text)).toMatchObject({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'hi there',
      session_id: 'session-1',
    });
  });

  it('writes exactly one JSON document and exits non-zero on a provider error', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();

    const code = await writeHeadlessOutput({
      events: runHeadless({
        prompt: 'hello',
        sessionId: 'session-1',
        model: 'claude-sonnet-4-5',
        runtime: runtimeOf([], { stopReason: 'error', message: 'the provider failed' }),
      }),
      format: 'json',
      stdout,
      stderr,
    });

    expect(code).not.toBe(EXIT_SUCCESS);
    expect(code).toBe(EXIT_FAILURE);
    expect(readJsonDocuments(stdout.text)).toHaveLength(1);
    expect(JSON.parse(stdout.text)).toMatchObject({ is_error: true, subtype: 'error' });
  });

  it('writes one JSON object per event in stream-json', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();

    const code = await writeHeadlessOutput({
      events: runHeadless({
        prompt: 'hello',
        sessionId: 'session-1',
        model: 'claude-sonnet-4-5',
        runtime: runtimeOf([assistantRecord('hi there')]),
      }),
      format: 'stream-json',
      stdout,
      stderr,
    });

    expect(code).toBe(EXIT_SUCCESS);
    const documents = readJsonDocuments(stdout.text);
    // One object per event: the assistant's text and the result.
    expect(documents).toHaveLength(2);
    expect(documents[0]).toEqual({ type: 'text', text: 'hi there' });
    expect(documents[1]).toMatchObject({ type: 'result' });
  });

  it('writes the assistant’s text in text mode', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();

    const code = await writeHeadlessOutput({
      events: runHeadless({
        prompt: 'hello',
        sessionId: 'session-1',
        model: 'claude-sonnet-4-5',
        runtime: runtimeOf([assistantRecord('hi there')]),
      }),
      format: 'text',
      stdout,
      stderr,
    });

    expect(code).toBe(EXIT_SUCCESS);
    expect(stdout.text).toBe('hi there\n');
  });

  it('writes the provider’s own message to stderr when the text format fails', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();

    const code = await writeHeadlessOutput({
      events: runHeadless({
        prompt: 'hello',
        sessionId: 'session-1',
        model: 'claude-sonnet-4-5',
        runtime: runtimeOf([], { stopReason: 'error', message: 'the provider failed' }),
      }),
      format: 'text',
      stdout,
      stderr,
    });

    expect(code).toBe(EXIT_FAILURE);
    // The two formats must not disagree about the same failure: the message the
    // provider gave is the message the text format writes.
    expect(stderr.text).toBe('the provider failed\n');
    expect(stdout.text).toBe('');
  });

  it('fails when the event stream carries no result event', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();

    async function* events(): AsyncIterable<HeadlessEvent> {
      yield { type: 'text', text: 'partial' };
    }

    const code = await writeHeadlessOutput({ events: events(), format: 'json', stdout, stderr });

    // The document says the run failed, so the exit code says so too.
    expect(code).toBe(EXIT_FAILURE);
    expect(JSON.parse(stdout.text)).toMatchObject({ is_error: true, subtype: 'error' });
  });

  it('maps the tool call, the tool result and the provider event', async () => {
    const events: HeadlessEvent[] = [];
    const stream = runHeadless({
      prompt: 'hello',
      sessionId: 'session-1',
      model: 'claude-sonnet-4-5',
      runtime: runtimeOf([
        { v: 1, ts: 0, id: 'rec-1', t: 'tool_call', name: 'Write', input: { file_path: '/x' } },
        {
          v: 1,
          ts: 1,
          id: 'rec-2',
          t: 'tool_result',
          envelope: { toolUseId: 'toolu_1', content: 'written', isError: false },
        },
        {
          v: 1,
          ts: 2,
          id: 'rec-3',
          t: 'provider_event',
          event: { type: 'error', message: 'the provider failed', retryable: false },
        },
      ]),
    });

    for await (const event of stream) events.push(event);

    // Every event kind the turn produces has its own event.
    expect(events[0]).toEqual({
      type: 'tool_use',
      id: 'rec-1',
      name: 'Write',
      input: { file_path: '/x' },
    });
    expect(events[1]).toEqual({
      type: 'tool_result',
      id: 'toolu_1',
      content: 'written',
      is_error: false,
    });
    expect(events[2]).toEqual({ type: 'error', message: 'the provider failed' });
    expect(events[events.length - 1]?.type).toBe('result');
  });
});

/* -------------------------------------------------------------------------- */
/* The command                                                                 */
/* -------------------------------------------------------------------------- */

describe('the command', () => {
  it('returns the argument error’s exit code and writes the message to stderr', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();

    const code = await runCommand(parseArgs(['--not-a-flag']), { stdout, stderr });

    expect(code).toBe(EXIT_USAGE);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('--not-a-flag');
  });

  it('writes the help and returns 0', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();

    const code = await runCommand(parseArgs(['--help']), { stdout, stderr });

    expect(code).toBe(EXIT_SUCCESS);
    expect(stdout.text).toContain('--print');
    expect(stderr.text).toBe('');
  });

  it('runs the multi-provider manager and returns its exit code', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();
    const configDir = makeDirectory();

    const code = await runCommand(parseArgs(['--provider', 'list']), {
      stdout,
      stderr,
      configDir,
    });

    // An empty manager lists nothing and succeeds; the point is that the
    // surface is **reachable** from the command line at all.
    expect(code).toBe(EXIT_SUCCESS);
    expect(stdout.text.length).toBeGreaterThan(0);
    expect(stderr.text).toBe('');
  });

  it('refuses an unknown manager verb with a usage error', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();

    const code = await runCommand(parseArgs(['--provider', 'not-a-verb']), {
      stdout,
      stderr,
      configDir: makeDirectory(),
    });

    expect(code).toBe(EXIT_USAGE);
    expect(stderr.text).toContain('not-a-verb');
  });

  it('runs the catalog surface when the parser named the catalog', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();

    const code = await runCommand(parseArgs(['--catalog', 'list']), {
      stdout,
      stderr,
      configDir: makeDirectory(),
    });

    // The **catalog** surface, not the provider one. The parser already
    // consumed the `--catalog` token, so the command word has to be put back
    // for the manager's own dispatcher; without that the surface falls
    // through to the provider one and the two outputs differ.
    const direct = await providerManagerCommand(['catalog', 'list'], createProviderRegistry());
    expect(stdout.text + stderr.text).toBe(direct.stdout + direct.stderr);
    expect(stdout.text + stderr.text).not.toBe(
      (await providerManagerCommand(['provider', 'list'], createProviderRegistry())).stdout,
    );
    expect(code).toBe(direct.exitCode);
  });

  it('refuses the manager command when a prompt was given', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();

    const code = await runCommand(parseArgs(['--print', 'hello', '--provider', 'list']), {
      stdout,
      stderr,
    });

    expect(code).toBe(EXIT_USAGE);
    expect(stderr.text).toContain("the '--provider' command cannot be combined with a prompt");
    expect(stdout.text).toBe('');
  });

  it('writes machine-readable output for the manager\'s flag form', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();

    const code = await runCommand(parseArgs(['--provider', 'list']), {
      stdout,
      stderr,
      configDir: makeDirectory(),
    });

    expect(code).toBe(EXIT_SUCCESS);
    // The **flag** form is the non-interactive one, so its output is JSON.
    const document = JSON.parse(stdout.text) as { extension?: string };
    expect(document.extension).toMatch(/project extension/i);
  });

  it('refuses --forward-home-settings without a cloud target, with the target\'s message', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();

    // The **parser** refuses it first, with the target's own message: the
    // option says whether this machine's settings go into a *cloud* session.
    const code = await runCommand(parseArgs(['--print', 'hello', '--forward-home-settings', 'true']), {
      stdout,
      stderr,
    });

    expect(code).toBe(EXIT_USAGE);
    expect(stderr.text).toContain(
      'Error: --forward-home-settings says whether this machine\'s settings go into a cloud session',
    );
  });

  it('writes the version and returns 0', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();

    const code = await runCommand(parseArgs(['--version']), { stdout, stderr });

    expect(code).toBe(EXIT_SUCCESS);
    expect(stdout.text.trim().length).toBeGreaterThan(0);
  });

  it('runs the headless path and writes one JSON document', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();
    const configDir = makeDirectory();

    const code = await runCommand(parseArgs(['-p', 'hello', '--output-format', 'json']), {
      stdout,
      stderr,
      configDir,
      cwd: configDir,
      isTTY: false,
      createSession: async () => ({
        sessionId: 'session-1',
        runtime: runtimeOf([assistantRecord('hi there')]),
        mode: 'default',
      }),
    });

    expect(code).toBe(EXIT_SUCCESS);
    expect(readJsonDocuments(stdout.text)).toHaveLength(1);
    expect(JSON.parse(stdout.text)).toMatchObject({ result: 'hi there' });
  });

  it('reports a failed session lookup with the target’s message and exit code 1', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();
    const configDir = makeDirectory();

    const code = await runCommand(
      parseArgs(['-p', 'hello', '--resume', '11111111-1111-4111-8111-111111111111']),
      { stdout, stderr, configDir, cwd: configDir, isTTY: false },
    );

    expect(code).toBe(EXIT_FAILURE);
    expect(stderr.text).toContain(
      'No conversation found with session ID: 11111111-1111-4111-8111-111111111111',
    );
  });

  it('reports a resume that names nothing with the target’s message', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();
    const configDir = makeDirectory();

    const code = await runCommand(parseArgs(['-p', 'hello', '--resume']), {
      stdout,
      stderr,
      configDir,
      cwd: configDir,
      isTTY: false,
    });

    expect(code).toBe(EXIT_FAILURE);
    expect(stderr.text).toContain(
      'Error: --resume requires a valid session ID or session title when used with --print. Usage: prricode -p --resume <session-id|title>',
    );
  });

  it('reports that there is nothing to continue with the target’s message', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();
    const configDir = makeDirectory();

    const code = await runCommand(parseArgs(['-p', 'hello', '--continue']), {
      stdout,
      stderr,
      configDir,
      cwd: configDir,
      isTTY: false,
    });

    expect(code).toBe(EXIT_FAILURE);
    expect(stderr.text).toContain('No conversation found to continue');
  });

  it('continues a session that exists', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();
    const configDir = makeDirectory();
    const cwd = makeDirectory();

    // The first run creates the session the second one continues.
    const first = await runCommand(parseArgs(['-p', 'hello', '--output-format', 'json']), {
      stdout: new CollectingSink(),
      stderr: new CollectingSink(),
      configDir,
      cwd,
      isTTY: false,
      driver: fakeDriver([
        [
          { type: 'message_start', messageId: 'msg-1', model: 'claude-sonnet-4-5' },
          { type: 'text_delta', text: 'hi there' },
          { type: 'message_stop', stopReason: 'end_turn' },
        ],
      ]),
    });
    expect(first).toBe(EXIT_SUCCESS);

    const code = await runCommand(parseArgs(['-p', 'hello again', '--continue']), {
      stdout,
      stderr,
      configDir,
      cwd,
      isTTY: false,
      driver: fakeDriver([
        [
          { type: 'message_start', messageId: 'msg-2', model: 'claude-sonnet-4-5' },
          { type: 'text_delta', text: 'hi again' },
          { type: 'message_stop', stopReason: 'end_turn' },
        ],
      ]),
    });

    // The session existed, so the continuation succeeded.
    expect(code).toBe(EXIT_SUCCESS);
    expect(stderr.text).not.toContain('No conversation found to continue');
  });

  it('sets the session up and stops for --init-only', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();
    const configDir = makeDirectory();
    const cwd = makeDirectory();

    let readPrompt = false;
    const code = await runCommand(parseArgs(['--init-only'], { isTTY: true }), {
      stdout,
      stderr,
      configDir,
      cwd,
      isTTY: true,
      readPrompt: async () => {
        readPrompt = true;
        return 'the prompt';
      },
      createSession: async () => ({
        sessionId: 'session-1',
        mode: 'default',
        runtime: runtimeOf([]),
      }),
    });

    expect(code).toBe(EXIT_SUCCESS);
    // No turn was made and no prompt was read.
    expect(readPrompt).toBe(false);
    expect(existsSync(sessionFilePath(configDir, cwd, 'session-1'))).toBe(true);
  });

  it('keeps the default sinks when an explicit undefined is passed', async () => {
    const configDir = makeDirectory();

    // The resolved sinks come **last** in the spread, so an own `stdout:
    // undefined` cannot clobber the default and crash the run.
    const captured = await captureProcessStreams(async () =>
      runCommand(parseArgs(['-p', 'hello', '--output-format', 'json']), {
        stdout: undefined,
        stderr: undefined,
        configDir,
        cwd: configDir,
        isTTY: false,
        createSession: async () => ({
          sessionId: 'session-1',
          mode: 'default',
          runtime: runtimeOf([assistantRecord('hi there')]),
        }),
      }),
    );

    expect(captured.result).toBe(EXIT_SUCCESS);
    // The document went to the process's own stdout: the default was not
    // clobbered by the explicit `undefined`.
    expect(readJsonDocuments(captured.stdout)).toHaveLength(1);
  });

  it('sends the model the --model flag names', async () => {
    const requests: ProviderRequest[] = [];
    const configDir = makeDirectory();
    const cwd = makeDirectory();

    const code = await runCommand(parseArgs(['-p', 'hello', '--model', 'claude-opus-4-8']), {
      stdout: new CollectingSink(),
      stderr: new CollectingSink(),
      configDir,
      cwd,
      isTTY: false,
      driver: fakeDriver(
        [
          [
            { type: 'message_start', messageId: 'msg-1', model: 'claude-opus-4-8' },
            { type: 'text_delta', text: 'hi there' },
            { type: 'message_stop', stopReason: 'end_turn' },
          ],
        ],
        requests,
      ),
    });

    expect(code).toBe(EXIT_SUCCESS);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe('claude-opus-4-8');
  });

  it('refuses an unknown permission mode', () => {
    const parsed = parseArgs(['-p', 'hello', '--permission-mode', 'nonsense']);

    expect(errorOf(parsed)).toBe('Error: Invalid permission mode "nonsense".');
    expect(parsed.kind === 'error' ? parsed.exitCode : 0).toBe(EXIT_USAGE);
  });

  it('starts in the mode the --permission-mode flag names', async () => {
    const configDir = makeDirectory();
    const cwd = makeDirectory();
    const target = path.join(cwd, 'written.txt');

    // `bypassPermissions` approves a call no rule covers.
    const code = await runCommand(
      parseArgs([
        '-p',
        'write it',
        '--permission-mode',
        'bypassPermissions',
        '--output-format',
        'json',
      ]),
      {
        stdout: new CollectingSink(),
        stderr: new CollectingSink(),
        configDir,
        cwd,
        isTTY: false,
        driver: fakeDriver(writeRounds(target)),
      },
    );

    expect(code).toBe(EXIT_SUCCESS);
    expect(existsSync(target)).toBe(true);
  });

  it('refuses a tool the --disallowedTools flag names', async () => {
    const configDir = makeDirectory();
    const cwd = makeDirectory();
    const target = path.join(cwd, 'written.txt');

    // The settings allow `Write`; the command line refuses it.
    writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Write'] } }),
    );

    const code = await runCommand(
      parseArgs(['-p', 'write it', '--disallowedTools', 'Write', '--output-format', 'json']),
      {
        stdout: new CollectingSink(),
        stderr: new CollectingSink(),
        configDir,
        cwd,
        isTTY: false,
        driver: fakeDriver(writeRounds(target)),
      },
    );

    expect(code).toBe(EXIT_SUCCESS);
    // The deny rule beat the allow rule.
    expect(existsSync(target)).toBe(false);
  });

  it('writes into a directory the --add-dir flag names', async () => {
    const configDir = makeDirectory();
    const cwd = makeDirectory();
    const added = makeDirectory();
    const target = path.join(added, 'written.txt');

    // `acceptEdits` approves a write inside the working directory or inside an
    // **added** directory — and nothing else.
    const code = await runCommand(
      parseArgs([
        '-p',
        'write it',
        '--permission-mode',
        'acceptEdits',
        '--add-dir',
        added,
        '--output-format',
        'json',
      ]),
      {
        stdout: new CollectingSink(),
        stderr: new CollectingSink(),
        configDir,
        cwd,
        isTTY: false,
        driver: fakeDriver(writeRounds(target)),
      },
    );

    expect(code).toBe(EXIT_SUCCESS);
    expect(existsSync(target)).toBe(true);
  });

  it('writes one JSON object per event in stream-json through the command', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();
    const configDir = makeDirectory();

    const code = await runCommand(
      parseArgs(['-p', 'hello', '--output-format', 'stream-json']),
      {
        stdout,
        stderr,
        configDir,
        cwd: configDir,
        isTTY: false,
        createSession: async () => ({
          sessionId: 'session-1',
          mode: 'default',
          runtime: runtimeOf([assistantRecord('hi there')]),
        }),
      },
    );

    expect(code).toBe(EXIT_SUCCESS);
    const documents = readJsonDocuments(stdout.text);
    expect(documents).toHaveLength(2);
    expect(documents[0]).toEqual({ type: 'text', text: 'hi there' });
    expect(documents[1]).toMatchObject({ type: 'result' });
  });

  it('resumes the session a path names', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();
    const configDir = makeDirectory();

    // **Observed** (audit §2.10): "a path is scanned for such a segment". The
    // session the path names is the one the run looks for.
    const code = await runCommand(parseArgs(['-p', 'hello', '--resume', '/x/session_abc123']), {
      stdout,
      stderr,
      configDir,
      cwd: configDir,
      isTTY: false,
    });

    expect(code).toBe(EXIT_FAILURE);
    expect(stderr.text).toContain('session_abc123');
    expect(stderr.text).not.toContain('/x/session_abc123');
  });
});

/* -------------------------------------------------------------------------- */
/* The flags this implementation refuses                                                 */
/* -------------------------------------------------------------------------- */

describe('the flags this implementation refuses', () => {
  /** The flags this implementation recognises and does not implement, and their values. */
  const refused: readonly (readonly [string, readonly string[]])[] = [
    ['--teleport', ['--teleport', 'session_abc']],
    ['--max-turns', ['--max-turns', '3']],
    ['--system-prompt', ['--system-prompt', 'be brief']],
    ['--append-system-prompt', ['--append-system-prompt', 'be brief']],
    ['--verbose', ['--verbose']],
    ['--debug', ['--debug']],
    ['--cloud', ['--cloud', 'deadbeef']],
    ['--remote', ['--remote', 'a description']],
    ['--environment', ['--environment', 'prod']],
    ['--betas', ['--betas', 'a-beta']],
    ['--file', ['--file', 'README.md']],
    ['--channels', ['--channels', 'a-channel']],
    ['--mcp-config', ['--mcp-config', 'mcp.json']],
    ['--dangerously-load-development-channels', ['--dangerously-load-development-channels', 'dev']],
    ['--name', ['--name', 'the session']],
    // `--no-session-persistence` needs the print mode: the parser's own
    // message says so.
    ['--no-session-persistence', ['-p', 'hello', '--no-session-persistence']],
  ];

  for (const [name, argv] of refused) {
    it(`refuses ${name}`, async () => {
      const stdout = new CollectingSink();
      const stderr = new CollectingSink();
      const configDir = makeDirectory();

      const code = await runCommand(parseArgs([...argv], { isTTY: false }), {
        stdout,
        stderr,
        configDir,
        cwd: configDir,
        isTTY: false,
      });

      expect(code).toBe(EXIT_FAILURE);
      expect(stderr.text).toContain(`The '${name}' option is not implemented here yet`);
    });
  }

  it('refuses --sdk-url', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();
    const configDir = makeDirectory();

    const code = await runCommand(
      parseArgs(
        [
          '-p',
          'hello',
          '--sdk-url',
          'http://127.0.0.1:1',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
        ],
        { isTTY: false },
      ),
      {
        stdout,
        stderr,
        configDir,
        cwd: configDir,
        isTTY: false,
      },
    );

    expect(code).toBe(EXIT_FAILURE);
    expect(stderr.text).toContain(
      "The '--sdk-url' option is not implemented here yet",
    );
  });

  it('loads the settings file the --settings flag names', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();
    const configDir = makeDirectory();
    const cwd = makeDirectory();
    const settingsFile = path.join(configDir, 'extra.json');
    writeFileSync(settingsFile, JSON.stringify({ permissions: { allow: ['Write'] } }));
    const target = path.join(cwd, 'written.txt');

    const code = await runCommand(
      parseArgs(['-p', 'write it', '--settings', settingsFile, '--output-format', 'json']),
      {
        stdout,
        stderr,
        configDir,
        cwd,
        isTTY: false,
        driver: fakeDriver(writeRounds(target)),
      },
    );

    expect(code).toBe(EXIT_SUCCESS);
    // The settings file's own rule is in force: the write ran.
    expect(existsSync(target)).toBe(true);
  });

  it('refuses a settings file it cannot read', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();
    const configDir = makeDirectory();

    const code = await runCommand(
      parseArgs(['-p', 'hello', '--settings', path.join(configDir, 'missing.json')]),
      {
        stdout,
        stderr,
        configDir,
        cwd: configDir,
        isTTY: false,
      },
    );

    expect(code).toBe(EXIT_USAGE);
    expect(stderr.text).toContain('--settings');
  });
});

/* -------------------------------------------------------------------------- */
/* The stream-json input                                                       */
/* -------------------------------------------------------------------------- */

describe('the stream-json input', () => {
  it('reads the text the documents carry', () => {
    const read = readStreamJsonInput(
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}\n',
    );

    expect(read).toEqual({ kind: 'ok', prompt: 'hello' });
  });

  it('reads a document whose content is a string', () => {
    const read = readStreamJsonInput(
      '{"type":"user","message":{"role":"user","content":"hello"}}\n',
    );

    expect(read).toEqual({ kind: 'ok', prompt: 'hello' });
  });

  it('refuses a line that is not JSON', () => {
    const read = readStreamJsonInput('not json\n');

    expect(read.kind).toBe('invalid');
  });

  it('refuses a document that carries no text', () => {
    const read = readStreamJsonInput('{"type":"user","message":{"role":"user"}}\n');

    expect(read.kind).toBe('invalid');
  });

  it('runs the turn with the text the documents carry, not the raw blob', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();
    const configDir = makeDirectory();

    let seen: TurnInput | undefined;
    const code = await runCommand(
      parseArgs([
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
      ]),
      {
        stdout,
        stderr,
        configDir,
        cwd: configDir,
        isTTY: false,
        readPrompt: async () =>
          '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"the real prompt"}]}}\n',
        createSession: async () => ({
          sessionId: 'session-1',
          mode: 'default',
          runtime: {
            async runTurn(input: TurnInput): Promise<TurnResult> {
              seen = input;
              return { events: [assistantRecord('hi there')], stopReason: 'end_turn' };
            },
          },
        }),
      },
    );

    expect(code).toBe(EXIT_SUCCESS);
    // The model received the **text** of the document, not the JSONL blob.
    expect(seen?.prompt).toBe('the real prompt');
  });

  it('refuses an input it cannot read', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();
    const configDir = makeDirectory();

    const code = await runCommand(
      parseArgs([
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
      ]),
      {
        stdout,
        stderr,
        configDir,
        cwd: configDir,
        isTTY: false,
        readPrompt: async () => 'not json\n',
        createSession: async () => ({
          sessionId: 'session-1',
          mode: 'default',
          runtime: runtimeOf([]),
        }),
      },
    );

    expect(code).toBe(EXIT_USAGE);
    expect(stderr.text).toContain('the stream-json input carries a line that is not JSON');
  });
});

/* -------------------------------------------------------------------------- */
/* The start mode                                                              */
/* -------------------------------------------------------------------------- */

describe('the start mode', () => {
  /** Build the session a run uses, with the settings the directory carries. */
  async function sessionOf(configDir: string, cwd: string): Promise<CommandSession> {
    return createCommandSession({
      parsed: runOf(parseArgs([], { isTTY: true })),
      sessionId: 'session-1',
      cwd,
      configDir,
      env: {},
      hooks: createHookRegistry(),
      store: createSessionStore({ configDir }),
    });
  }

  it('starts an interactive session in auto mode', async () => {
    const configDir = makeDirectory();
    const cwd = makeDirectory();

    const session = await sessionOf(configDir, cwd);

    expect(session.mode).toBe('auto');
  });

  it('does not start in auto mode when a policy disables it', async () => {
    const configDir = makeDirectory();
    const cwd = makeDirectory();
    writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify({ disableAutoMode: 'disable' }),
    );

    const session = await sessionOf(configDir, cwd);

    // The override the plan names: `disableAutoMode: "disable"` in a settings
    // file takes the auto mode away.
    expect(session.mode).not.toBe('auto');
    expect(session.mode).toBe('default');
  });

  it('does not start in auto mode for a HIPAA-configured session', async () => {
    const configDir = makeDirectory();
    const cwd = makeDirectory();
    writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify({ hipaa: { enabled: true } }),
    );

    const session = await sessionOf(configDir, cwd);

    expect(session.mode).not.toBe('auto');
    expect(session.mode).toBe('default');
  });
});

/* -------------------------------------------------------------------------- */
/* The production wiring of the two seams                                      */
/* -------------------------------------------------------------------------- */

/**
 * The wiring the `CC-007c` review found missing.
 *
 * The review found that nothing in production supplied either seam: the built-in
 * tools had no production caller, and no file outside the permission, hook and
 * tool modules mentioned `preToolUseHook`. These tests run a **real** session —
 * the real tools, the real permission service and the real runtime — and show
 * that a `PreToolUse` hook and a `PermissionRequest` hook now reach it.
 */
describe('the production wiring of the two seams', () => {
  /** A configuration directory whose settings allow the `Write` tool. */
  function configurationAllowingWrite(): string {
    const configDir = makeDirectory();
    writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Write'] } }),
    );
    return configDir;
  }

  it('runs a tool call the rules allow when no hook is registered', async () => {
    const configDir = configurationAllowingWrite();
    const cwd = makeDirectory();
    const target = path.join(cwd, 'written.txt');

    const code = await runCommand(parseArgs(['-p', 'write it', '--output-format', 'json']), {
      stdout: new CollectingSink(),
      stderr: new CollectingSink(),
      configDir,
      cwd,
      isTTY: false,
      driver: fakeDriver(writeRounds(target)),
    });

    expect(code).toBe(EXIT_SUCCESS);
    // The write ran: the session's own tools are wired to the runtime.
    expect(existsSync(target)).toBe(true);
  });

  it('carries the loaded sandbox policy into the session the CLI builds', async () => {
    // The wiring the `Bash` tool's header names: the session the CLI builds
    // must carry the **loaded** sandbox policy, or every command takes the
    // no-policy branch and the sandbox protects nothing. The settings say the
    // sandbox is switched off, so the command runs **unconfined** — with the
    // **policy's** reason, which is what tells the two apart.
    const configDir = makeDirectory();
    writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash'] }, sandbox: { enabled: false } }),
    );
    const cwd = makeDirectory();
    const requests: ProviderRequest[] = [];

    const code = await runCommand(parseArgs(['-p', 'list the files', '--output-format', 'json']), {
      stdout: new CollectingSink(),
      stderr: new CollectingSink(),
      configDir,
      cwd,
      isTTY: false,
      driver: fakeDriver(bashRounds(), requests),
    });

    expect(code).toBe(EXIT_SUCCESS);
    // The tool result the model saw carries the **policy's** reason.
    const seen = JSON.stringify(requests);
    expect(seen).toContain('sandbox.enabled is false');
    // **Not** the no-policy reason, which is what a session without the
    // wiring would report.
    expect(seen).not.toContain('no sandbox policy is configured');
  });

  it('refuses a tool call a PreToolUse hook denies', async () => {
    const configDir = configurationAllowingWrite();
    const cwd = makeDirectory();
    const target = path.join(cwd, 'written.txt');

    const hooks = createHookRegistry();
    hooks.register({ event: 'PreToolUse', command: 'the hook refuses this call' });

    const code = await runCommand(parseArgs(['-p', 'write it', '--output-format', 'json']), {
      stdout: new CollectingSink(),
      stderr: new CollectingSink(),
      configDir,
      cwd,
      isTTY: false,
      hooks,
      hookOptions: {
        runCommand: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            hookSpecificOutput: {
              permissionDecision: 'deny',
              permissionDecisionReason: 'the hook refuses this call',
            },
          }),
          stderr: '',
        }),
      },
      driver: fakeDriver(writeRounds(target)),
    });

    expect(code).toBe(EXIT_SUCCESS);
    // The hook's denial held: the call did not run.
    expect(existsSync(target)).toBe(false);
  });

  it('refuses a tool call a PermissionRequest hook denies', async () => {
    const configDir = configurationAllowingWrite();
    const cwd = makeDirectory();
    const target = path.join(cwd, 'written.txt');

    const hooks = createHookRegistry();
    hooks.register({ event: 'PermissionRequest', command: 'the hook refuses this call' });

    const code = await runCommand(parseArgs(['-p', 'write it', '--output-format', 'json']), {
      stdout: new CollectingSink(),
      stderr: new CollectingSink(),
      configDir,
      cwd,
      isTTY: false,
      hooks,
      hookOptions: {
        runCommand: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            hookSpecificOutput: {
              permissionDecision: 'deny',
              permissionDecisionReason: 'the hook refuses this call',
            },
          }),
          stderr: '',
        }),
      },
      driver: fakeDriver(writeRounds(target)),
    });

    expect(code).toBe(EXIT_SUCCESS);
    expect(existsSync(target)).toBe(false);
  });

  it('refuses a call no rule covers when the command line allows nothing', async () => {
    // The generic prompt: a call that no rule covers needs an approval, and a
    // headless run has nobody to ask.
    const configDir = makeDirectory();
    const cwd = makeDirectory();
    const target = path.join(cwd, 'written.txt');

    const code = await runCommand(parseArgs(['-p', 'write it', '--output-format', 'json']), {
      stdout: new CollectingSink(),
      stderr: new CollectingSink(),
      configDir,
      cwd,
      isTTY: false,
      driver: fakeDriver(writeRounds(target)),
    });

    expect(code).toBe(EXIT_SUCCESS);
    expect(existsSync(target)).toBe(false);
  });

  it('runs a tool the command line allows', async () => {
    // `--allowedTools` names the tools that need no approval.
    const configDir = makeDirectory();
    const cwd = makeDirectory();
    const target = path.join(cwd, 'written.txt');

    const code = await runCommand(
      parseArgs(['-p', 'write it', '--allowedTools', 'Write', '--output-format', 'json']),
      {
        stdout: new CollectingSink(),
        stderr: new CollectingSink(),
        configDir,
        cwd,
        isTTY: false,
        driver: fakeDriver(writeRounds(target)),
      },
    );

    expect(code).toBe(EXIT_SUCCESS);
    expect(existsSync(target)).toBe(true);
  });

  it('does not offer the tools the command line leaves out', async () => {
    // `--tools` names the tools the session offers.
    const configDir = configurationAllowingWrite();
    const cwd = makeDirectory();
    const target = path.join(cwd, 'written.txt');

    const code = await runCommand(
      parseArgs(['-p', 'write it', '--tools', 'Read', '--output-format', 'json']),
      {
        stdout: new CollectingSink(),
        stderr: new CollectingSink(),
        configDir,
        cwd,
        isTTY: false,
        driver: fakeDriver(writeRounds(target)),
      },
    );

    expect(code).toBe(EXIT_SUCCESS);
    expect(existsSync(target)).toBe(false);
  });

  it('approves a call no rule covers when a PermissionRequest hook approves it', async () => {
    // **The tool-side wiring.** The tool's own check consults the
    // `PermissionRequest` seam, and the seam's approval replaces the generic
    // prompt the rules would produce. Without the tool-side wiring the tool's
    // own check would **ask**, and the ask would win over the runtime's
    // service's approval — so the call would be refused.
    const configDir = makeDirectory();
    const cwd = makeDirectory();
    const target = path.join(cwd, 'written.txt');

    const hooks = createHookRegistry();
    hooks.register({ event: 'PermissionRequest', command: 'the hook approves this call' });

    let calls = 0;
    const code = await runCommand(parseArgs(['-p', 'write it', '--output-format', 'json']), {
      stdout: new CollectingSink(),
      stderr: new CollectingSink(),
      configDir,
      cwd,
      isTTY: false,
      hooks,
      hookOptions: {
        runCommand: async () => {
          calls += 1;
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              hookSpecificOutput: {
                permissionDecision: 'allow',
                permissionDecisionReason: 'the hook approves this call',
              },
            }),
            stderr: '',
          };
        },
      },
      driver: fakeDriver(writeRounds(target)),
    });

    expect(code).toBe(EXIT_SUCCESS);
    // The hook ran, and its approval let the call through.
    expect(calls).toBeGreaterThan(0);
    expect(existsSync(target)).toBe(true);
  });

  it('consults the PermissionRequest seam in the tool’s check and in the runtime’s service', async () => {
    // **The runtime-side wiring.** The runtime's permission service is called
    // with the `permissionOptions` that carry the seam, so the hook is consulted
    // **twice** for one tool call: once by the tool's own check and once by the
    // runtime's service. Deleting either wiring leaves one call.
    const configDir = makeDirectory();
    const cwd = makeDirectory();
    const target = path.join(cwd, 'written.txt');

    const hooks = createHookRegistry();
    hooks.register({ event: 'PermissionRequest', command: 'the hook approves this call' });

    let calls = 0;
    const code = await runCommand(parseArgs(['-p', 'write it', '--output-format', 'json']), {
      stdout: new CollectingSink(),
      stderr: new CollectingSink(),
      configDir,
      cwd,
      isTTY: false,
      hooks,
      hookOptions: {
        runCommand: async () => {
          calls += 1;
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              hookSpecificOutput: {
                permissionDecision: 'allow',
                permissionDecisionReason: 'the hook approves this call',
              },
            }),
            stderr: '',
          };
        },
      },
      driver: fakeDriver(writeRounds(target)),
    });

    expect(code).toBe(EXIT_SUCCESS);
    expect(calls).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* The telemetry                                                               */
/* -------------------------------------------------------------------------- */

describe('the telemetry', () => {
  it('emits the target’s continue event through the session module', async () => {
    const events: { name?: string }[] = [];
    const configDir = makeDirectory();

    await runCommand(parseArgs(['-p', 'hello', '--continue']), {
      stdout: new CollectingSink(),
      stderr: new CollectingSink(),
      configDir,
      cwd: configDir,
      isTTY: false,
      telemetry: (event: unknown) => events.push(event as { name?: string }),
    });

    // The session module emits it; the CLI only supplies the sink.
    expect(events.some((event) => event.name === 'tengu_continue')).toBe(true);
  });

  it('emits the target’s resume events through the session module', async () => {
    const events: { name?: string; entrypoint?: string }[] = [];
    const configDir = makeDirectory();

    await runCommand(
      parseArgs(['-p', 'hello', '--resume', '11111111-1111-4111-8111-111111111111']),
      {
        stdout: new CollectingSink(),
        stderr: new CollectingSink(),
        configDir,
        cwd: configDir,
        isTTY: false,
        telemetry: (event: unknown) => events.push(event as { name?: string }),
      },
    );

    const names = events.map((event) => event.name);
    expect(names).toContain('tengu_session_resumed');
    expect(names).toContain('tengu_resume_print');
    const resumed = events.find((event) => event.name === 'tengu_session_resumed');
    expect(resumed?.entrypoint).toBe('print');
  });
});

/* -------------------------------------------------------------------------- */
/* The slash-command registry                                                  */
/* -------------------------------------------------------------------------- */

describe('the slash-command registry', () => {
  it('registers the target’s command names', () => {
    // The registry holds the target's own commands — the ones the target
    // registers in its registry region — and the two commands this
    // implementation owns, which are **not** the target's.
    expect(TARGET_SLASH_COMMANDS).toHaveLength(100);
    expect(SLASH_COMMANDS).toHaveLength(102);
    // The target registers a command twice when it has two forms, and the
    // registry keeps **every** definition.
    expect(SLASH_COMMAND_DEFINITIONS).toHaveLength(125);

    const names = TARGET_SLASH_COMMANDS.map((command) => command.name);
    for (const name of [
      'add-dir',
      'clear',
      'compact',
      'config',
      'context',
      'help',
      'model',
      'resume',
      'status',
      'usage',
      'version',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('reproduces a command’s description, aliases and argument hint', () => {
    const clear = slashCommandOf('clear');

    // The target's own words, its own aliases and its own hint.
    expect(clear?.description).toBe(
      'Start a new session with empty context; previous session stays on disk (resumable with /resume)',
    );
    expect(clear?.aliases).toEqual(['reset', 'new']);
    expect(clear?.argumentHint).toBe('[name]');
  });

  it('answers to an alias', () => {
    expect(slashCommandOf('cost')?.name).toBe('usage');
    expect(slashCommandOf('continue')?.name).toBe('resume');
    expect(slashCommandOf('allowed-tools')?.name).toBe('permissions');
  });

  it('names no command that the registry does not hold', () => {
    expect(slashCommandOf('not-a-command')).toBeUndefined();
    // A name that is a member of `Object.prototype` is not a command.
    expect(slashCommandOf('constructor')).toBeUndefined();
    expect(slashCommandOf('__proto__')).toBeUndefined();
  });

  it('records where the target puts each command', () => {
    // The offset is the byte offset of the command's definition in the
    // target's own source file.
    expect(slashCommandOf('help')?.offset).toBe(1684242);
    expect(slashCommandOf('clear')?.offset).toBe(1674623);
    expect(slashCommandOf('usage')?.offset).toBe(2176852);
  });

  it('never names the target’s product', () => {
    // The target's *data* keeps the target's names — `CLAUDE.md`, `.claude`,
    // `claude.ai` — but the target's **product name** never appears.
    for (const command of SLASH_COMMANDS) {
      expect(command.description).not.toContain(TARGET_PRODUCT_NAME);
    }
  });

  it('marks the two commands this implementation owns as extensions', () => {
    const provider = slashCommandOf('provider');
    const catalog = slashCommandOf('catalog');

    // The target registers neither, so they carry no offset.
    expect(provider?.extension).toBe(true);
    expect(catalog?.extension).toBe(true);
    expect(provider?.offset).toBeUndefined();
    expect(TARGET_SLASH_COMMANDS.map((command) => command.name)).not.toContain('provider');
  });

  it('runs the help command and lists the registry', async () => {
    const result = await runSlashCommand('/help', slashContext());

    expect(result?.exitCode).toBe(0);
    expect(result?.stdout).toContain('/clear');
    expect(result?.stdout).toContain('/provider');
    // The two commands this implementation owns say that they are its own.
    expect(result?.stdout).toMatch(/project extension/i);
  });

  it('runs a report and says what it cannot show', async () => {
    const result = await runSlashCommand('/usage', slashContext());

    expect(result?.exitCode).toBe(0);
    expect(result?.stdout).toContain('Records');
  });

  it('refuses a command whose capability is missing, and names the capability', async () => {
    const result = await runSlashCommand('/teleport', slashContext());

    expect(result?.exitCode).not.toBe(0);
    // The refusal names the **capability**, so the user learns what would
    // have to exist for the command to run.
    expect(result?.stderr).toContain('/teleport');
    expect(result?.stderr).toContain('cloud session');
  });

  it('refuses every command it does not run, and names a capability for each', async () => {
    const refusals = SLASH_COMMANDS.filter(
      (command) => !['help', 'version', 'model', 'status', 'usage', 'context', 'config', 'skill-doctor', 'skills', 'clear', 'compact', 'resume', 'provider', 'catalog'].includes(command.name),
    );

    expect(refusals.length).toBeGreaterThan(80);
    for (const command of refusals) {
      const result = await runSlashCommand(`/${command.name}`, slashContext());
      expect(result?.exitCode).not.toBe(0);
      expect(result?.stderr).toContain(`'/${command.name}'`);
      expect(result?.stderr).toContain('this implementation has no');
    }
  });

  it('sends a line that names no command back to the caller', async () => {
    // The caller sends such a line to the model, the way the target does.
    expect(await runSlashCommand('/not-a-command', slashContext())).toBeUndefined();
    expect(await runSlashCommand('hello there', slashContext())).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* The autocomplete overlay                                                    */
/* -------------------------------------------------------------------------- */

describe('the autocomplete overlay', () => {
  it('lists the registry’s commands for a bare slash', () => {
    const rows = slashCommandSuggestions('/');

    // The overlay’s list is the registry’s list.
    expect(rows.length).toBeGreaterThan(90);
    expect(rows.map((row) => row.displayText)).toContain('/clear');
    expect(rows.map((row) => row.displayText)).toContain('/help');
  });

  it('filters the list by what has been typed', () => {
    const rows = slashCommandSuggestions('/cl');

    expect(rows.map((row) => row.displayText)).toContain('/clear');
    expect(rows.map((row) => row.displayText)).not.toContain('/help');
  });

  it('shows the alias the user typed beside the command’s name', () => {
    const rows = slashCommandSuggestions('/cost');

    expect(rows.map((row) => row.displayText)).toEqual(['/usage (cost)']);
  });

  it('has no overlay outside a slash command', () => {
    expect(slashCommandSuggestions('hello')).toEqual([]);
    expect(slashCommandSuggestions('/clear now')).toEqual([]);
  });

  it('renders a row the way the target renders it', () => {
    const row = slashCommandSuggestions('/help')[0];

    expect(row).toBeDefined();
    expect(renderAutocompleteSuggestion(row!, true)).toBe(
      '❯ /help – Show help and available commands',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The complete flag vocabulary                                                */
/* -------------------------------------------------------------------------- */

describe('the complete flag vocabulary', () => {
  it('carries the target’s sets, at the target’s counts', () => {
    // **REA observed** (`chunk-0y0ptpy9.js`): the target's five sets and the
    // record's counts. The flag list is the contract.
    expect(VALUE_FLAG_NAMES).toHaveLength(85);
    expect(REPEATABLE_FLAG_NAMES).toHaveLength(11);
    expect(OPTIONAL_VALUE_FLAG_NAMES).toHaveLength(14);
    expect(BOOLEAN_FLAG_NAMES).toHaveLength(45);
    expect(COMMAND_TOKEN_NAMES).toHaveLength(10);
    expect(SESSION_SUBCOMMAND_NAMES).toHaveLength(6);
    expect(NON_FLAG_VALUE_FLAG_NAMES).toHaveLength(3);
  });

  it('carries the flags the record names', () => {
    // The record's §3.4 lists, and the target's own registry holds, these.
    for (const name of [
      '--prefill',
      '--deep-link-repo',
      '--handle-uri',
      '--settings',
      '--managed-settings',
      '--setting-sources',
      '--model',
      '--agent',
      '--routine',
      '--effort',
      '--permission-mode',
      '--system-prompt',
      '--append-system-prompt',
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
    ]) {
      expect(VALUE_FLAG_NAMES, `${name} is a value flag`).toContain(name);
    }

    for (const name of [
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
    ]) {
      expect(OPTIONAL_VALUE_FLAG_NAMES, `${name} is an optional-value flag`).toContain(name);
    }

    for (const name of [
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
    ]) {
      expect(BOOLEAN_FLAG_NAMES, `${name} is a boolean flag`).toContain(name);
    }

    expect(COMMAND_TOKEN_NAMES).toEqual([
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
    ]);
    expect(NON_FLAG_VALUE_FLAG_NAMES).toEqual(['--exec', '-m', '--handle-uri']);
  });

  it('keeps the three flag sets disjoint', () => {
    // The target's parser needs to know which shape a flag has, so the shapes
    // do not overlap.
    for (const name of VALUE_FLAG_NAMES) {
      expect(OPTIONAL_VALUE_FLAG_NAMES).not.toContain(name);
      expect(BOOLEAN_FLAG_NAMES).not.toContain(name);
    }
    for (const name of OPTIONAL_VALUE_FLAG_NAMES) {
      expect(BOOLEAN_FLAG_NAMES).not.toContain(name);
    }
  });

  it('carries the repeatable flags inside the value flags', () => {
    for (const name of REPEATABLE_FLAG_NAMES) {
      expect(VALUE_FLAG_NAMES).toContain(name);
    }
  });

  it('carries the four flags the command-token set shares with the boolean set', () => {
    // The target's own sets overlap here: `-p`, `--print`, `--bg` and
    // `--background` are **both** command tokens and boolean flags.
    expect(COMMAND_TOKEN_NAMES.filter((name) => BOOLEAN_FLAG_NAMES.includes(name))).toEqual([
      '-p',
      '--print',
      '--bg',
      '--background',
    ]);
  });

  it('carries the target’s argument hints', () => {
    // The hints are the target's own: they say what shape a flag's value has.
    expect(FLAG_ARGUMENT_HINTS.get('--model')).toBe('<model>');
    expect(FLAG_ARGUMENT_HINTS.get('--allowedTools')).toBe('<tools...>');
    expect(FLAG_ARGUMENT_HINTS.get('--mcp-config')).toBe('<configs...>');
    expect(FLAG_ARGUMENT_HINTS.get('--resume')).toBe('[value]');
    expect(FLAG_ARGUMENT_HINTS.get('--debug')).toBe('[filter]');
    expect(FLAG_ARGUMENT_HINTS.get('--teleport')).toBe('[session]');
    expect(FLAG_ARGUMENT_HINTS.get('--verbose')).toBeUndefined();
  });

  it('never names the target’s product', () => {
    // The flags are the target's **data**, and no flag name carries the
    // target's product name.
    for (const name of [
      ...VALUE_FLAG_NAMES,
      ...REPEATABLE_FLAG_NAMES,
      ...OPTIONAL_VALUE_FLAG_NAMES,
      ...BOOLEAN_FLAG_NAMES,
      ...COMMAND_TOKEN_NAMES,
    ]) {
      expect(name).not.toContain(TARGET_PRODUCT_NAME);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The target’s flag shapes                                                    */
/* -------------------------------------------------------------------------- */

describe('the target’s flag shapes', () => {
  it('gives a value flag the next token, even one that looks like a flag', () => {
    // The target's own parser: a known value flag owns the next token,
    // whether or not that token looks like a flag.
    const parsed = runOf(parseArgs(['--model', '--print']));

    expect(parsed.model).toBe('--print');
    // The token was the flag's **value**, so it is not the print mode.
    expect(parsed.print).toBe(false);
  });

  it('gives a repeatable flag the next token and every non-flag token after it', () => {
    const parsed = runOf(parseArgs(['--tools', 'Read', 'Write']));

    expect(parsed.tools).toEqual(['Read', 'Write']);
  });

  it('gives a repeatable flag a first token that looks like a flag', () => {
    // The target's own parser: the **first** token after a repeatable flag is
    // the flag's, whatever it looks like.
    const parsed = runOf(parseArgs(['--tools', '--print', 'Read']));

    expect(parsed.tools).toEqual(['--print', 'Read']);
    expect(parsed.print).toBe(false);
  });

  it('gives an optional-value flag the next token only when it does not look like a flag', () => {
    const named = runOf(parseArgs(['--resume', 'session_abc']));
    expect(named.resume).toBe('session_abc');

    const bare = runOf(parseArgs(['--resume', '--print']));
    expect(bare.flags.has('--resume')).toBe(true);
    expect(bare.resume).toBe('');
    expect(bare.print).toBe(true);
  });

  it('gives a boolean flag nothing', () => {
    const parsed = runOf(parseArgs(['--verbose', 'what is the weather?']));

    expect(parsed.flags.has('--verbose')).toBe(true);
    expect(parsed.prompt).toBe('what is the weather?');
  });

  it('counts the three flags the target’s scanner does not count', () => {
    // The target's `x()`: `--exec`, `-m` and `--handle-uri` take a value, and
    // the scanner does not count them as flags.
    expect(isKnownFlag('--exec')).toBe(false);
    expect(isKnownFlag('-m')).toBe(false);
    expect(isKnownFlag('--handle-uri')).toBe(false);

    expect(isKnownFlag('--model')).toBe(true);
    expect(isKnownFlag('--model=x')).toBe(true);
    expect(isKnownFlag('--verbose')).toBe(true);
    expect(isKnownFlag('--resume')).toBe(true);
    // A boolean flag is matched whole, so `--verbose=x` is not a flag.
    expect(isKnownFlag('--verbose=x')).toBe(false);
  });

  it('reproduces the target’s command-token test', () => {
    expect(isCommandToken('-p')).toBe(true);
    expect(isCommandToken('--version')).toBe(true);
    expect(isCommandToken('--routine=nightly')).toBe(true);
    expect(isCommandToken('-abc')).toBe(true);
    // `-d2e` carries a digit, so it is not a cluster.
    expect(isCommandToken('-d2e')).toBe(false);
    expect(isCommandToken('--model')).toBe(false);
  });

  it('reproduces the target’s first-positional rule', () => {
    expect(firstPositionalIndex(['--model', 'haiku', 'hello'])).toBe(2);
    expect(firstPositionalIndex(['--', '--not-a-flag'])).toBe(1);
    expect(firstPositionalIndex(['--model'])).toBe(-1);
    // The repeatable flag owns every non-flag token that follows it.
    expect(firstPositionalIndex(['--tools', 'Read', 'Write'])).toBe(-1);
  });

  it('reproduces the target’s session-subcommand rule', () => {
    expect(sessionSubcommandIndex(['attach', 'deadbeef'])).toBe(0);
    expect(sessionSubcommandIndex(['--model', 'haiku', 'attach', 'deadbeef'])).toBe(2);
    // The subcommand is the first token: the target answers `0` there and then.
    expect(sessionSubcommandIndex(['attach'])).toBe(0);
    // The reference is eight hex digits.
    expect(sessionSubcommandIndex(['--model', 'haiku', 'attach', 'nothex'])).toBe(-1);
    expect(sessionSubcommandIndex(['respawn', '--all'])).toBe(0);
    // A flag the scanner does not count disqualifies the line.
    expect(sessionSubcommandIndex(['--exec', 'x', 'attach', 'deadbeef'])).toBe(-1);
    // A command token disqualifies the line too.
    expect(sessionSubcommandIndex(['--print', 'attach', 'deadbeef'])).toBe(-1);
  });
});

/* -------------------------------------------------------------------------- */
/* The subcommand tree                                                         */
/* -------------------------------------------------------------------------- */

describe('the subcommand tree', () => {
  it('holds the target’s groups', () => {
    expect(CLI_COMMAND_GROUPS.map((group) => group.path.join(' '))).toEqual([
      'plugin',
      'plugin marketplace',
      'mcp',
      'mcp xaa',
      'auth',
      'auto-mode',
      'sandbox',
      'project',
    ]);
  });

  it('holds the target’s commands', () => {
    expect(CLI_COMMAND_TREE).toHaveLength(77);
    expect(CLI_COMMANDS).toHaveLength(69);

    // The record's §G3 table, read against the target's own source.
    for (const path of [
      'plugin init',
      'plugin validate',
      'plugin tag',
      'plugin list',
      'plugin eval',
      'plugin eval init',
      'plugin test',
      'plugin details',
      'plugin marketplace add',
      'plugin marketplace list',
      'plugin marketplace remove',
      'plugin marketplace update',
      'plugin install',
      'plugin uninstall',
      'plugin prune',
      'plugin enable',
      'plugin disable',
      'plugin update',
      'plugin configure',
      'mcp add',
      'mcp add-json',
      'mcp add-from-claude-desktop',
      'mcp remove',
      'mcp list',
      'mcp get',
      'mcp login',
      'mcp logout',
      'mcp reset-project-choices',
      'mcp serve',
      'mcp xaa setup',
      'mcp xaa login',
      'mcp xaa show',
      'mcp xaa clear',
      'auth login',
      'auth status',
      'auth logout',
      'auto-mode defaults',
      'auto-mode config',
      'auto-mode reset',
      'auto-mode critique',
      'sandbox install',
      'sandbox status',
      'project purge',
      'gateway',
      'setup-token',
      'agents',
      'ultrareview',
      'remote-control',
      'doctor',
      'update',
      'install',
      'import',
      'import-conversations',
      'edit-hook',
      'edit-permission-rules',
      'edit-memory-settings',
      'edit-skill-overrides',
      'edit-sandbox-settings',
      'design-login',
      'edit-chrome-settings',
      'drop-worktree-registrations',
      'attach',
      'logs',
      'stop',
      'kill',
      'respawn',
      'rm',
    ]) {
      expect(cliCommandOf(path.split(' ')), `${path} is a command`).toBeDefined();
    }
  });

  it('answers to the target’s aliases', () => {
    expect(cliRootCommandOf('plugins')?.path).toEqual(['plugin']);
    expect(cliCommandOf(['plugin', 'new'])?.path).toEqual(['plugin', 'init']);
    expect(cliCommandOf(['plugin', 'i'])?.path).toEqual(['plugin', 'install']);
    expect(cliCommandOf(['plugin', 'remove'])?.path).toEqual(['plugin', 'uninstall']);
    expect(cliCommandOf(['plugin', 'rm'])?.path).toEqual(['plugin', 'uninstall']);
    expect(cliCommandOf(['plugin', 'autoremove'])?.path).toEqual(['plugin', 'prune']);
    expect(cliCommandOf(['plugin', 'marketplace', 'rm'])?.path).toEqual([
      'plugin',
      'marketplace',
      'remove',
    ]);
    expect(cliRootCommandOf('rc')?.path).toEqual(['remote-control']);
    expect(cliRootCommandOf('upgrade')?.path).toEqual(['update']);
  });

  it('marks the target’s hidden commands', () => {
    const hidden = CLI_COMMAND_TREE.filter((entry) => entry.hidden).map((entry) =>
      entry.path.join(' '),
    );

    expect(hidden).toEqual([
      'plugin test',
      'sandbox',
      'sandbox install',
      'sandbox status',
      'project',
      'project purge',
      'remote-control',
      'apply-project-settings',
      'import-conversations',
      'edit-hook',
      'edit-permission-rules',
      'edit-memory-settings',
      'edit-skill-overrides',
      'edit-sandbox-settings',
      'design-login',
      'edit-chrome-settings',
      'drop-worktree-registrations',
    ]);
  });

  it('carries the target’s usage strings', () => {
    // The `plugin` group's usages are the target's own registry
    // (`chunk-kctf5bfr.js:693`); the rest are the target's own declarations.
    expect(cliCommandOf(['plugin', 'init'])?.usage).toBe('plugin init <name>');
    expect(cliCommandOf(['plugin', 'marketplace', 'add'])?.usage).toBe(
      'plugin marketplace add <source>',
    );
    expect(cliCommandOf(['mcp', 'add'])?.usage).toBe('mcp add <name> <commandOrUrl> [args...]');
    expect(cliCommandOf(['mcp', 'xaa', 'setup'])?.usage).toBe('mcp xaa setup');
    expect(cliCommandOf(['ultrareview'])?.usage).toBe('ultrareview [target]');
    expect(cliCommandOf(['import-conversations'])?.usage).toBe(
      'import-conversations <exportPath>',
    );
  });

  it('records where the target puts each command', () => {
    expect(cliCommandOf(['plugin', 'init'])?.offset).toBe(16669);
    expect(cliCommandOf(['plugin', 'configure'])?.offset).toBe(34171);
    expect(cliCommandOf(['mcp', 'xaa', 'setup'])?.offset).toBe(15519);
    expect(cliRootCommandOf('doctor')?.offset).toBe(41274);
    expect(cliRootCommandOf('edit-hook')?.source).toBe('chunk-9y799w6p.js');
    expect(cliRootCommandOf('edit-chrome-settings')?.source).toBe('chunk-mancccdx.js');
  });

  it('never names the target’s product', () => {
    // The tree reproduces the target's **data** — the paths, the usages, the
    // descriptions — and not the target's product name.
    for (const entry of CLI_COMMAND_TREE) {
      expect(entry.description).not.toContain(TARGET_PRODUCT_NAME);
      expect(entry.usage).not.toContain(TARGET_PRODUCT_NAME);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The command dispatch                                                        */
/* -------------------------------------------------------------------------- */

describe('the command dispatch', () => {
  it('resolves a group and its command', () => {
    const parsed = parseArgs(['plugin', 'init', 'my-plugin']);

    expect(parsed.kind).toBe('command');
    if (parsed.kind !== 'command') return;
    expect(parsed.path).toEqual(['plugin', 'init']);
    expect(parsed.command).toBe('init');
    expect(parsed.group).toBe('plugin');
    expect(parsed.args).toEqual(['my-plugin']);
  });

  it('resolves a nested group and its command', () => {
    const parsed = parseArgs(['mcp', 'xaa', 'setup']);

    expect(parsed.kind).toBe('command');
    if (parsed.kind !== 'command') return;
    expect(parsed.path).toEqual(['mcp', 'xaa', 'setup']);
    expect(parsed.group).toBe('mcp xaa');
  });

  it('answers to a group alias', () => {
    const parsed = parseArgs(['plugins', 'list']);

    expect(parsed.kind).toBe('command');
    if (parsed.kind !== 'command') return;
    expect(parsed.path).toEqual(['plugin', 'list']);
  });

  it('writes the group’s help when the group is named with no command', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();

    const code = await runCommand(parseArgs(['plugin']), { stdout, stderr });

    expect(code).toBe(EXIT_FAILURE);
    expect(stderr.text).toContain('plugin init <name>');
    expect(stderr.text).toContain('plugin marketplace add <source>');
    expect(stdout.text).toBe('');
  });

  it('refuses an unknown command of a known group', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();

    const code = await runCommand(parseArgs(['plugin', 'frobnicate']), { stdout, stderr });

    expect(code).toBe(EXIT_USAGE);
    expect(stderr.text).toContain("unknown command 'frobnicate'");
  });

  it('refuses every command of the tree, and names a capability', async () => {
    for (const entry of CLI_COMMANDS) {
      const stdout = new CollectingSink();
      const stderr = new CollectingSink();

      const code = await runCommand(parseArgs([...entry.path]), { stdout, stderr });

      expect(code, `${entry.usage} is refused`).toBe(EXIT_FAILURE);
      expect(stderr.text).toContain(`'${entry.usage}'`);
      expect(stderr.text).toContain('this implementation has no');
    }
  });

  it('lists the whole flag vocabulary and the command tree in the help', () => {
    expect(HELP_TEXT).toContain('--prefill <text>');
    expect(HELP_TEXT).toContain('-m, --model <model>');
    expect(HELP_TEXT).toContain('-r, --resume [value]');
    expect(HELP_TEXT).toContain('plugin init <name>');
    expect(HELP_TEXT).toContain('mcp xaa setup');
    expect(HELP_TEXT).toContain('doctor');
  });
});

/* -------------------------------------------------------------------------- */
/* The flags the run refuses                                                   */
/* -------------------------------------------------------------------------- */

describe('the flags the run refuses', () => {
  it('refuses every flag of the target’s vocabulary that the run does not act on', () => {
    // **Implementation choice.** A flag this implementation accepts and then
    // ignores is worse than one it refuses, so every flag of the target's
    // vocabulary is either **acted on** or **refused** — there is no third
    // case.
    const acted = new Set([
      '--model',
      '--settings',
      '--allowedTools',
      '--allowed-tools',
      '--disallowedTools',
      '--disallowed-tools',
      '--tools',
      '--add-dir',
      '--output-format',
      '--input-format',
      '--session-id',
      '--resume-session-at',
      '--permission-mode',
      '--continue',
      '--resume',
      '--fork-session',
      '--init-only',
      '--dangerously-skip-permissions',
      '--print',
      // The short forms the target declares for the flags above.
      '-m',
      '-n',
      '-c',
      '-r',
      '-p',
      // The short forms the target declares for the flags the run refuses:
      // `-d` is `--debug` and `-w` is `--worktree`.
      '-d',
      '-w',
      // The flag the **parser** refuses as an unknown option.
      '-d2e',
      // The two the **commands** refuse.
      '--bg',
      '--background',
      '--routine',
    ]);

    const known = [
      ...VALUE_FLAG_NAMES,
      ...OPTIONAL_VALUE_FLAG_NAMES,
      ...BOOLEAN_FLAG_NAMES,
    ];
    for (const name of known) {
      if (acted.has(name)) continue;
      expect(
        UNIMPLEMENTED_OPTIONS.has(name),
        `${name} is neither acted on nor refused`,
      ).toBe(true);
    }
    for (const name of UNIMPLEMENTED_OPTIONS.keys()) {
      expect(known, `${name} is refused but is not a flag of the target`).toContain(name);
    }
  });
});

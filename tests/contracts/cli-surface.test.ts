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
 *     found missing.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  parseArgs,
  CLOUD_SESSION_REF_PATTERN,
  SESSION_ID_PATTERN,
  SUBCOMMANDS,
  findSessionIdInPath,
  isCloudSessionRef,
  isSessionId,
  isUriArgument,
  type ParsedArgs,
  type ParsedRunArgs,
} from '../../src/cli/args.js';
import {
  runHeadless,
  type HeadlessEvent,
} from '../../src/cli/headless.js';
import {
  EXIT_FAILURE,
  EXIT_SUCCESS,
  EXIT_USAGE,
  OUTPUT_FORMATS,
  readJsonDocuments,
  writeHeadlessOutput,
  type OutputSink,
} from '../../src/cli/output.js';
import { runCommand } from '../../src/cli/command.js';
import { TURN_SOURCE } from '../../src/agent/context.js';
import type { StreamingProviderDriver } from '../../src/agent/context.js';
import type { AgentRuntime, TurnInput, TurnResult } from '../../src/agent/loop.js';
import { createHookRegistry } from '../../src/extensions/hooks/registry.js';
import type { ProviderDriver, ProviderEvent } from '../../src/provider/drivers/types.js';
import type { SessionEvent } from '../../src/session/event.js';

/* -------------------------------------------------------------------------- */
/* The helpers                                                                 */
/* -------------------------------------------------------------------------- */

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
 */
function fakeDriver(rounds: readonly (readonly ProviderEvent[])[]): StreamingProviderDriver {
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
    async *send(): AsyncGenerator<ProviderEvent> {
      const round = rounds[index] ?? [];
      index += 1;
      for (const event of round) yield event;
    },
  };
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
      'Error: --resume requires a valid session ID or session title when used with --print. Usage: agent -p --resume <session-id|title>',
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

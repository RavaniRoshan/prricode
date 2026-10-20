/**
 * Contract test for the documents a headless run writes.
 *
 * Evidence: the reading of the target's own source recorded in
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-permissions-and-headless.md`
 * §2. Every claim that test pins carries a file and a byte offset there:
 *
 *   - the **result document** is the target's own — the member set, the member
 *     **order** and the nested shapes (`chunk-pj5cyqhw.js:300922` for the success
 *     variant, `:326977` for the error variant, `:178563` for the `usage` object,
 *     `:288789` for a `permission_denials` entry, and `:171561` for the builder
 *     that fixes the order);
 *   - the `json` format writes **exactly one** document — the result document
 *     (`chunk-e7w77ts3.js:529318`);
 *   - the `stream-json` format writes **one document per line**, one per
 *     message, and the **last** document is the result document
 *     (`chunk-btsgvmny.js:29557`);
 *   - the `text` format writes the result document's `result` text, plus a
 *     newline (`chunk-e7w77ts3.js:445913`).
 *
 * The test pins the **shape** of what a run writes. The two places where this
 * implementation knowingly differs from the target are named here and in
 * `docs/compatibility/command-surface.md`:
 *
 *   1. the error variant's `subtype` is `error` here and one of
 *      `error_during_execution`, `error_max_turns`, `error_max_budget_usd` and
 *      `error_max_structured_output_retries` in the target;
 *   2. a run that produced no result document writes a document here, while the
 *      target writes nothing to stdout and the error to stderr.
 *
 * Both are pinned by `tests/contracts/cli-surface.test.ts`, a contract test
 * this milestone does not own.
 */

import { describe, expect, it } from 'vitest';

import { TURN_SOURCE, type StreamingProviderDriver } from '../../src/agent/context.js';
import { createAgentRuntime, type AgentRuntime, type TurnInput, type TurnResult } from '../../src/agent/loop.js';
import {
  ZERO_USAGE,
  buildResultDocument,
  denialsOf,
  runHeadless,
  usageOf,
  type HeadlessUsage,
  type PermissionDenial,
  type ResultDocument,
} from '../../src/cli/headless.js';
import { EXIT_FAILURE, EXIT_SUCCESS, writeHeadlessOutput, type OutputSink } from '../../src/cli/output.js';
import type {
  ProviderDriver,
  ProviderEvent,
  ProviderRequest,
} from '../../src/provider/drivers/types.js';
import type { SessionEvent } from '../../src/session/event.js';
import { createSessionStore } from '../../src/session/store.js';
import { createToolRegistry } from '../../src/tools/registry.js';

/* -------------------------------------------------------------------------- */
/* The helpers                                                                 */
/* -------------------------------------------------------------------------- */

/** A sink that collects what was written to it. */
class CollectingSink implements OutputSink {
  text = '';

  write(chunk: string): unknown {
    this.text += chunk;
    return true;
  }
}

/** The JSON documents a stream carries, one per line. */
function readJsonDocuments(text: string): unknown[] {
  const documents: unknown[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    documents.push(JSON.parse(trimmed));
  }
  return documents;
}

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

/** The member names of a document, in the order they are written. */
function memberNames(document: unknown): string[] {
  if (typeof document !== 'object' || document === null) return [];
  return Object.keys(document);
}

/**
 * A driver that replays fixed rounds of provider events.
 *
 * It carries the `TURN_SOURCE` marker, so it **is** the turn's transport: the
 * runtime's own wiring runs without a network.
 */
function fakeDriver(rounds: readonly (readonly ProviderEvent[])[]): StreamingProviderDriver {
  let index = 0;
  return {
    route: 'firstParty',
    [TURN_SOURCE]: true,
    async *send(_request: ProviderRequest): AsyncGenerator<ProviderEvent> {
      const round = rounds[index] ?? [];
      index += 1;
      for (const event of round) yield event;
    },
    buildUrl: () => 'https://example.test/v1/messages',
    buildHeaders: () => ({}),
    buildBody: () => ({ body: {}, headers: {} }),
    parseStream: () => ({ events: [], state: undefined }),
    parseNonStreaming: () => ({ events: [] }),
    classifyError: () => ({ message: 'the provider failed', retryable: false }),
    calculateNonstreamingTimeout: () => 600_000,
    betaFlagsFor: (flags: string[]) => flags,
  };
}

/* -------------------------------------------------------------------------- */
/* The result document                                                         */
/* -------------------------------------------------------------------------- */

describe('the result document', () => {
  it('carries the target\'s members, in the target\'s order', () => {
    const document = buildResultDocument({
      isError: false,
      result: 'hi there',
      stopReason: 'end_turn',
      sessionId: 'session-1',
      durationMs: 12,
      numTurns: 1,
      usage: usageOf(undefined),
      permissionDenials: [],
      uuid: 'uuid-1',
    });

    // The target builds the document by spreading the **common** members, then
    // the **variant** members, then `type`, `duration_ms` and `uuid`
    // (`chunk-pj5cyqhw.js:171561`), and the common block is
    // `is_error, duration_api_ms, num_turns, stop_reason, session_id,
    // total_cost_usd, usage, modelUsage, permission_denials`
    // (`chunk-e7w77ts3.js:353540`).
    expect(memberNames(document)).toEqual([
      'is_error',
      'duration_api_ms',
      'num_turns',
      'stop_reason',
      'session_id',
      'total_cost_usd',
      'usage',
      'modelUsage',
      'permission_denials',
      'subtype',
      'result',
      'type',
      'duration_ms',
      'uuid',
    ]);
  });

  it('carries the target\'s nested shapes', () => {
    const document = buildResultDocument({
      isError: false,
      result: 'hi there',
      stopReason: 'end_turn',
      sessionId: 'session-1',
      durationMs: 12,
      numTurns: 1,
      usage: usageOf({
        inputTokens: 10,
        outputTokens: 4,
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 6,
      }),
      permissionDenials: denialsOf([
        { toolName: 'Bash', toolUseId: 'toolu_1', input: { command: 'rm -rf /' } },
      ]),
      uuid: 'uuid-1',
    });

    // The `usage` object is the target's own zeroed object with the token
    // counts filled in (`chunk-05nax923.js:11`).
    expect(document.usage).toEqual({
      output_tokens_details: { thinking_tokens: 0 },
      input_tokens: 10,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 6,
      output_tokens: 4,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: 'standard',
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      inference_geo: '',
      iterations: [],
      speed: 'standard',
      fallback_credit: null,
    });

    // The `permission_denials` entry is the target's own shape
    // (`chunk-pj5cyqhw.js:288789`).
    expect(document.permission_denials).toEqual([
      { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'rm -rf /' } },
    ]);

    expect(document.modelUsage).toEqual({});
    expect(document.total_cost_usd).toBe(0);
  });

  it('carries the failure as the target\'s `errors` array', () => {
    const document = buildResultDocument({
      isError: true,
      result: '',
      errors: ['the provider failed'],
      stopReason: null,
      sessionId: 'session-1',
      durationMs: 12,
      numTurns: 0,
      usage: usageOf(undefined),
      permissionDenials: [],
      uuid: 'uuid-1',
    });

    expect(document.subtype).toBe('error');
    expect(document.is_error).toBe(true);
    expect(document.errors).toEqual(['the provider failed']);
    expect(document.stop_reason).toBeNull();
  });

  it('zeroes the usage the target zeroes', () => {
    const usage: HeadlessUsage = usageOf(undefined);

    expect(usage).toEqual(ZERO_USAGE);
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(0);
    expect(usage.service_tier).toBe('standard');
  });

  it('maps a denial whose input is not a record onto an empty input', () => {
    const denials: PermissionDenial[] = denialsOf([
      { toolName: 'Bash', toolUseId: 'toolu_1', input: 'not a record' },
    ]);

    expect(denials).toEqual([{ tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: {} }]);
  });
});

/* -------------------------------------------------------------------------- */
/* The three formats                                                           */
/* -------------------------------------------------------------------------- */

describe('the headless output formats', () => {
  it('writes exactly one document in the json format, and it is the result document', async () => {
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

    const document = documents[0] as ResultDocument;
    expect(document.type).toBe('result');
    expect(document.subtype).toBe('success');
    expect(document.is_error).toBe(false);
    expect(document.result).toBe('hi there');
    expect(document.session_id).toBe('session-1');
    expect(document.num_turns).toBe(0);
    expect(document.stop_reason).toBeNull();
    expect(document.permission_denials).toEqual([]);
    expect(typeof document.uuid).toBe('string');
    expect(document.uuid.length).toBeGreaterThan(0);
  });

  it('writes one document per line in the stream-json format, and the last is the result document', async () => {
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
    expect(documents).toHaveLength(2);

    // The **last** document is the target's result document.
    const last = documents[documents.length - 1] as ResultDocument;
    expect(last.type).toBe('result');
    expect(last.subtype).toBe('success');
    expect(last.result).toBe('hi there');
    expect(last.session_id).toBe('session-1');
    expect(memberNames(last)).toContain('permission_denials');
  });

  it('writes the result\'s text in the text format', async () => {
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
    expect(stderr.text).toBe('');
  });

  it('carries the turn\'s own accounting into the document', async () => {
    const stdout = new CollectingSink();

    await writeHeadlessOutput({
      events: runHeadless({
        prompt: 'hello',
        sessionId: 'session-1',
        model: 'claude-sonnet-4-5',
        runtime: runtimeOf([assistantRecord('hi there')], {
          numTurns: 3,
          usage: {
            inputTokens: 11,
            outputTokens: 5,
            cacheCreationInputTokens: 1,
            cacheReadInputTokens: 2,
          },
          permissionDenials: [
            { toolName: 'Bash', toolUseId: 'toolu_9', input: { command: 'rm -rf /' } },
          ],
        }),
      }),
      format: 'json',
      stdout,
      stderr: new CollectingSink(),
    });

    const document = JSON.parse(stdout.text) as ResultDocument;
    expect(document.num_turns).toBe(3);
    expect(document.usage.input_tokens).toBe(11);
    expect(document.usage.output_tokens).toBe(5);
    expect(document.usage.cache_creation_input_tokens).toBe(1);
    expect(document.usage.cache_read_input_tokens).toBe(2);
    expect(document.permission_denials).toEqual([
      { tool_name: 'Bash', tool_use_id: 'toolu_9', tool_input: { command: 'rm -rf /' } },
    ]);
  });

  it('carries the provider\'s own stop reason, and null when it reported none', async () => {
    const withReason = new CollectingSink();
    await writeHeadlessOutput({
      events: runHeadless({
        prompt: 'hello',
        sessionId: 'session-1',
        model: 'claude-sonnet-4-5',
        runtime: runtimeOf([assistantRecord('hi there')], {
          stopReason: 'end_turn',
          providerStopReason: 'stop_sequence',
        }),
      }),
      format: 'json',
      stdout: withReason,
      stderr: new CollectingSink(),
    });

    expect((JSON.parse(withReason.text) as ResultDocument).stop_reason).toBe('stop_sequence');
  });

  it('writes the failure\'s message to stderr in the text format', async () => {
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
    expect(stderr.text).toBe('the provider failed\n');
  });
});

/* -------------------------------------------------------------------------- */
/* The runtime's own accounting                                                */
/* -------------------------------------------------------------------------- */

describe('the accounting the runtime hands the document', () => {
  it('counts the provider rounds and sums their usage', async () => {
    const store = createSessionStore({ configDir: '/tmp/prricode-headless-output' });
    const runtime = createAgentRuntime({
      driver: fakeDriver([
        [
          {
            type: 'message_start',
            messageId: 'msg-1',
            model: 'claude-sonnet-4-5',
            usage: { inputTokens: 10, outputTokens: 2 },
          },
          { type: 'text_delta', text: 'one' },
          {
            type: 'message_stop',
            stopReason: 'end_turn',
            usage: { inputTokens: 10, outputTokens: 2 },
          },
        ],
      ]),
      registry: createToolRegistry(),
      store,
      permission: async () => ({
        behavior: 'allow' as const,
        source: 'unknown' as const,
        reasonType: 'other' as const,
      }),
      cwd: '/work',
    });

    const stdout = new CollectingSink();
    await writeHeadlessOutput({
      events: runHeadless({
        prompt: 'hello',
        sessionId: 'session-1',
        model: 'claude-sonnet-4-5',
        runtime,
      }),
      format: 'json',
      stdout,
      stderr: new CollectingSink(),
    });

    const document = JSON.parse(stdout.text) as ResultDocument;
    // The runtime counts the **rounds** it made and sums their usage; the
    // document carries the count and the usage in the target's own shape.
    expect(document.num_turns).toBe(1);
    expect(document.usage.input_tokens).toBe(10);
    expect(document.usage.output_tokens).toBe(2);
    expect(document.stop_reason).toBe('end_turn');
    expect(document.result).toBe('one');
  });
});

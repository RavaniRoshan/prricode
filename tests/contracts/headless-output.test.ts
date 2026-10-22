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
import { buildSystemInitDocument, TextResultPrinter, type AssistantDocument, type SystemInitDocument } from '../../src/cli/print/documents.js';
import { EXIT_FAILURE, EXIT_SUCCESS, writeHeadlessOutput, type HeadlessEvent, type OutputSink } from '../../src/cli/output.js';
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

/**
 * The init document a stream run wires up.
 *
 * The fixture the stream-json tests carry; the command builds its own from the
 * session's context.
 */
function initDocumentFixture(): SystemInitDocument {
  return buildSystemInitDocument({
    cwd: '/work',
    model: 'claude-sonnet-4-5',
    mode: 'default',
    apiKeySource: 'none',
    version: '0.1.0',
    tools: ['Read', 'Write'],
    slashCommands: ['/help', '/model'],
    outputStyle: 'default',
    skills: ['review'],
  });
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

    // The target's error variant names its failure: the subtype is
    // `error_during_execution` (`chunk-pj5cyqhw.js:326977`), and the printer
    // reads the failure's `errors` member for the detail it puts on stderr
    // (`chunk-e7w77ts3.js:445913`).
    expect(document.subtype).toBe('error_during_execution');
    expect(document.is_error).toBe(true);
    expect(document.errors).toEqual(['the provider failed']);
    expect(document.stop_reason).toBeNull();
    // The target's error variant carries no answer text: the printer writes
    // `Execution error` on stdout and the `errors` member's detail on stderr
    // (`chunk-e7w77ts3.js:445913`).
    expect(Object.hasOwn(document, 'result')).toBe(false);
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
      init: initDocumentFixture(),
      sessionId: 'session-1',
      model: 'claude-sonnet-4-5',
    });

    expect(code).toBe(EXIT_SUCCESS);
    const documents = readJsonDocuments(stdout.text);
    expect(documents).toHaveLength(3);

    // The documents are the SDK message kinds: the `system`/`init` document
    // first (`chunk-btsgvmny.js:29557` — a message written before the init
    // document is held and flushed after it, so the init document is always
    // the first on the wire), the assistant's message inside an `assistant`
    // document (`chunk-pj5cyqhw.js:261767`), and the **result** document
    // last (`chunk-pj5cyqhw.js:300922`).
    expect(memberNames(documents[0])).toEqual([
      'type',
      'subtype',
      'apiKeySource',
      'claude_code_version',
      'cwd',
      'tools',
      'mcp_servers',
      'model',
      'permissionMode',
      'slash_commands',
      'output_style',
      'skills',
      'plugins',
      'plugin_errors',
    ]);
    expect(documents[1]).toMatchObject({ type: 'assistant' });
    expect((documents[1] as AssistantDocument).message.content).toEqual([
      { type: 'text', text: 'hi there' },
    ]);

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

  it('writes the target\'s line to stderr and nothing to stdout when no result document was produced', async () => {
    // **The target's own rule** (`chunk-e7w77ts3.js:529318`): the `json` and
    // `text` formats check the run's result document, and a run without one
    // writes `Error: No messages returned from query` to **stderr**, writes
    // **nothing** to stdout, and exits `1`.
    async function* events(): AsyncIterable<HeadlessEvent> {
      yield { type: 'text', id: 'rec-1', text: 'partial' };
    }

    for (const format of ['json', 'text'] as const) {
      const stdout = new CollectingSink();
      const stderr = new CollectingSink();

      const code = await writeHeadlessOutput({ events: events(), format, stdout, stderr });

      expect(code, format).toBe(EXIT_FAILURE);
      expect(stdout.text, format).toBe('');
      expect(stderr.text, format).toBe('Error: No messages returned from query\n');
    }
  });

  it('refuses the stream-json output when no init document was supplied', async () => {
    // The init document is always the first document on the wire, and the run
    // that the command wires up always carries one; a caller without one has
    // built no stream, and the writer refuses rather than writing a stream
    // that starts elsewhere.
    const stdout = new CollectingSink();

    await expect(
      writeHeadlessOutput({
        events: runHeadless({
          prompt: 'hello',
          sessionId: 'session-1',
          model: 'claude-sonnet-4-5',
          runtime: runtimeOf([assistantRecord('hi there')]),
        }),
        format: 'stream-json',
        stdout,
        stderr: new CollectingSink(),
      }),
    ).rejects.toThrow('init document');
  });

  it('writes the target\'s line to stderr, and nothing to stdout, when the turn produced no records', async () => {
    // A run whose turn threw produced no records at all: the writer treats it
    // as the target's own no-result case — the same line on stderr, nothing on
    // stdout, exit `1`.
    async function* events(): AsyncIterable<HeadlessEvent> {
      yield { type: 'text', id: 'rec-1', text: 'partial' };
      throw new Error('the turn exploded');
    }

    const stdout = new CollectingSink();
    const stderr = new CollectingSink();

    const code = await writeHeadlessOutput({ events: events(), format: 'json', stdout, stderr });

    expect(code).toBe(EXIT_FAILURE);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('Error: No messages returned from query\n');
  });
});

/* -------------------------------------------------------------------------- */
/* The stream-json documents are the SDK message kinds                          */
/* -------------------------------------------------------------------------- */

describe('the stream-json documents', () => {
  it('carries the tool call inside an assistant document and the result inside a user document', async () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();

    await writeHeadlessOutput({
      events: runHeadless({
        prompt: 'hello',
        sessionId: 'session-1',
        model: 'claude-sonnet-4-5',
        runtime: runtimeOf([
          { v: 1, ts: 0, id: 'toolu_1', t: 'tool_call', name: 'Write', input: { file_path: '/x' } },
          {
            v: 1,
            ts: 1,
            id: 'rec-2',
            t: 'tool_result',
            envelope: { toolUseId: 'toolu_1', content: 'written', isError: false },
          },
          assistantRecord('done'),
        ]),
      }),
      format: 'stream-json',
      stdout,
      stderr,
      init: initDocumentFixture(),
      sessionId: 'session-1',
      model: 'claude-sonnet-4-5',
    });

    const documents = readJsonDocuments(stdout.text);
    // init, the call's assistant document, the result's user document, the
    // closing assistant text, and the result document.
    expect(documents).toHaveLength(5);
    expect(documents[0]).toMatchObject({ type: 'system', subtype: 'init' });

    // **The assistant document** — `chunk-pj5cyqhw.js:261767`:
    // `{type:"assistant", message, parent_tool_use_id, uuid, session_id}`.
    const call = documents[1] as AssistantDocument;
    expect(memberNames(call)).toEqual(['type', 'message', 'parent_tool_use_id', 'uuid', 'session_id']);
    expect(call.message).toEqual({
      id: 'toolu_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: '/x' } }],
    });
    expect(call.parent_tool_use_id).toBeNull();
    expect(call.session_id).toBe('session-1');

    // **The user document** — `chunk-pj5cyqhw.js:239906`:
    // `{type:"user", message, parent_tool_use_id, tool_use_result, uuid, session_id}`;
    // the `tool_use_result` member is what the target's user document marks a
    // tool result with.
    const answer = documents[2] as Record<string, unknown>;
    expect(memberNames(answer)).toEqual([
      'type',
      'message',
      'parent_tool_use_id',
      'tool_use_result',
      'uuid',
      'session_id',
    ]);
    expect(answer).toMatchObject({ type: 'user' });
    expect(answer['message']).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'written', is_error: false }],
    });
    expect(answer['tool_use_result']).toBe('written');
    expect(answer['parent_tool_use_id']).toBeNull();
    expect(answer['session_id']).toBe('session-1');

    // The result document is last, whatever the kinds in between are.
    expect(documents[documents.length - 1]).toMatchObject({ type: 'result', subtype: 'success' });
  });

  it('writes the records the transcript carries only, in the order the run produced them', async () => {
    const stdout = new CollectingSink();

    await writeHeadlessOutput({
      events: runHeadless({
        prompt: 'hello',
        sessionId: 'session-1',
        model: 'claude-sonnet-4-5',
        runtime: runtimeOf([
          // The user's own prompt record produces no event: the headless mode
          // reports what the model produced and what the tools did.
          { v: 1, ts: 0, id: 'rec-0', t: 'user_message', text: 'hello' },
          assistantRecord('hi there'),
          // A permission decision, a compaction boundary, a provider ping —
          // none of them is a message the run emitted to the model or got back.
          {
            v: 1,
            ts: 2,
            id: 'rec-2',
            t: 'provider_event',
            event: { type: 'message_start', messageId: 'msg-1', model: 'claude-sonnet-4-5' },
          },
        ]),
      }),
      format: 'stream-json',
      stdout,
      stderr: new CollectingSink(),
      init: initDocumentFixture(),
      sessionId: 'session-1',
      model: 'claude-sonnet-4-5',
    });

    const documents = readJsonDocuments(stdout.text);
    expect(documents.map((document) => (document as { type: string }).type)).toEqual([
      'system',
      'assistant',
      'result',
    ]);
  });

  it('writes an escaped line, so a document is always one line', async () => {
    // `S_e` (`chunk-rrhrzgxv.js:11`) is `JSON.stringify` with U+2028 and
    // U+2029 escaped — a raw one would break the one-document-per-line rule
    // for a reader that splits on lines.
    const text = 'a\u2028b\u2029c';
    // (the two separators written as escapes, so the source stays plain)
    const stdout = new CollectingSink();

    await writeHeadlessOutput({
      events: runHeadless({
        prompt: 'hello',
        sessionId: 'session-1',
        model: 'claude-sonnet-4-5',
        runtime: runtimeOf([assistantRecord(text)]),
      }),
      format: 'stream-json',
      stdout,
      stderr: new CollectingSink(),
      init: initDocumentFixture(),
      sessionId: 'session-1',
      model: 'claude-sonnet-4-5',
    });

    // The line separators the target escapes are not on the wire raw.
    expect(stdout.text).not.toContain('\u2028');
    expect(stdout.text).not.toContain('\u2029');
    const documents = readJsonDocuments(stdout.text);
    const assistant = documents[1] as AssistantDocument;
    expect(assistant.message.content).toEqual([{ type: 'text', text }]);
  });

  it('writes the init document first, even when an event stream yields nothing but the result', async () => {
    // The target's own hold: a message written before the init document is
    // held and flushed after it, so the init document is always the first
    // document on the wire (`chunk-btsgvmny.js:29557`).
    async function* events(): AsyncIterable<HeadlessEvent> {
      yield buildResultDocument({
        isError: false,
        result: 'the answer',
        stopReason: 'end_turn',
        sessionId: 'session-1',
        durationMs: 12,
        numTurns: 1,
        usage: usageOf(undefined),
        permissionDenials: [],
        uuid: 'uuid-1',
      });
    }

    const stdout = new CollectingSink();
    await writeHeadlessOutput({
      events: events(),
      format: 'stream-json',
      stdout,
      stderr: new CollectingSink(),
      init: initDocumentFixture(),
      sessionId: 'session-1',
      model: 'claude-sonnet-4-5',
    });

    const documents = readJsonDocuments(stdout.text);
    expect(documents[0]).toMatchObject({ type: 'system', subtype: 'init' });
    expect(documents[1]).toMatchObject({ type: 'result' });
  });
});

/* -------------------------------------------------------------------------- */
/* The text printer                                                             */
/* -------------------------------------------------------------------------- */

describe('the text printer', () => {
  it('writes the success’s text with its trailing newline', () => {
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();
    const printer = new TextResultPrinter({ stdout, stderr });

    printer.print(
      buildResultDocument({
        isError: false,
        result: 'hi there',
        stopReason: 'end_turn',
        sessionId: 'session-1',
        durationMs: 12,
        numTurns: 1,
        usage: usageOf(undefined),
        permissionDenials: [],
        uuid: 'uuid-1',
      }),
    );

    expect(stdout.text).toBe('hi there\n');
    expect(stderr.text).toBe('');
  });

  it('does not double the newline a result already ends with', () => {
    const stdout = new CollectingSink();
    const printer = new TextResultPrinter({ stdout, stderr: new CollectingSink() });

    printer.print(
      buildResultDocument({
        isError: false,
        result: 'already\n',
        stopReason: 'end_turn',
        sessionId: 'session-1',
        durationMs: 12,
        numTurns: 1,
        usage: usageOf(undefined),
        permissionDenials: [],
        uuid: 'uuid-1',
      }),
    );

    expect(stdout.text).toBe('already\n');
  });

  it('writes the execution error’s line on stdout and the detail on stderr', () => {
    // `case"error_during_execution":{let h=zJn();if(h!==void 0)process.stderr.write(\`${h}\n\`);r="Execution error";break}`
    // (`chunk-e7w77ts3.js:445913`). The failure branch adds **no** newline on
    // stdout: `Or(s+r)` writes the line as it is.
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();
    const printer = new TextResultPrinter({ stdout, stderr });

    printer.print(
      buildResultDocument({
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
      }),
    );

    expect(stdout.text).toBe('Execution error');
    expect(stderr.text).toBe('the provider failed\n');
  });

  it('writes nothing on stderr when the failure carries no detail', () => {
    // `if(h!==void 0)` — the detail the run did not produce is not invented.
    const stdout = new CollectingSink();
    const stderr = new CollectingSink();
    const printer = new TextResultPrinter({ stdout, stderr });

    printer.print(
      buildResultDocument({
        isError: true,
        result: '',
        stopReason: null,
        sessionId: 'session-1',
        durationMs: 12,
        numTurns: 0,
        usage: usageOf(undefined),
        permissionDenials: [],
        uuid: 'uuid-1',
      }),
    );

    expect(stdout.text).toBe('Execution error');
    expect(stderr.text).toBe('');
  });

  it('writes each error variant’s own line', () => {
    // The printer's own lines for the error variants the target names
    // (`chunk-e7w77ts3.js:445913`). The limits are the printer's own values;
    // this implementation has no turn-budget machinery, so the documents that
    // name these subtypes come from a caller, and the printer formats them.
    function documentOf(subtype: ResultDocument['subtype'], errors?: readonly string[]): ResultDocument {
      return {
        is_error: true,
        duration_api_ms: 0,
        num_turns: 3,
        stop_reason: null,
        session_id: 'session-1',
        total_cost_usd: 0,
        usage: usageOf(undefined),
        modelUsage: {},
        permission_denials: [],
        subtype,
        ...(errors === undefined ? {} : { errors: [...errors] }),
        type: 'result',
        duration_ms: 12,
        uuid: 'uuid-1',
      };
    }

    const limit = { maxTurns: 50, maxBudgetUsd: 3.5 };
    const printerFor = function (stdout: CollectingSink): TextResultPrinter {
      return new TextResultPrinter({ stdout, stderr: new CollectingSink(), limits: limit });
    };

    const turns = new CollectingSink();
    printerFor(turns).print(documentOf('error_max_turns'));
    expect(turns.text).toBe('Error: Reached max turns (50)');

    const budget = new CollectingSink();
    printerFor(budget).print(documentOf('error_max_budget_usd'));
    expect(budget.text).toBe('Error: Exceeded USD budget (3.5)');

    const retries = new CollectingSink();
    new TextResultPrinter({ stdout: retries, stderr: new CollectingSink() }).print(
      documentOf('error_max_structured_output_retries', ['the parsed value failed']),
    );
    expect(retries.text).toBe('Error: the parsed value failed');

    const unexplained = new CollectingSink();
    new TextResultPrinter({ stdout: unexplained, stderr: new CollectingSink() }).print(
      documentOf('error_max_structured_output_retries'),
    );
    expect(unexplained.text).toBe(
      'Error: Failed to provide valid structured output after maximum retries',
    );
  });

  it('prints a document once, and another with the target’s separator between them', () => {
    // `printAtExit` prints only when the document is **not** the one already
    // printed, and the separator is `\n` after a print that ended with a
    // newline and `\n\n` otherwise (`chunk-e7w77ts3.js:445913`).
    const stdout = new CollectingSink();
    const printer = new TextResultPrinter({ stdout, stderr: new CollectingSink() });

    const first = buildResultDocument({
      isError: false,
      result: 'first turn',
      stopReason: 'end_turn',
      sessionId: 'session-1',
      durationMs: 12,
      numTurns: 1,
      usage: usageOf(undefined),
      permissionDenials: [],
      uuid: 'uuid-1',
    });
    printer.print(first);
    printer.print(first);

    const second = buildResultDocument({
      isError: false,
      result: 'second turn',
      stopReason: 'end_turn',
      sessionId: 'session-1',
      durationMs: 24,
      numTurns: 2,
      usage: usageOf(undefined),
      permissionDenials: [],
      uuid: 'uuid-2',
    });
    printer.print(second);

    expect(stdout.text).toBe('first turn\n\nsecond turn\n');
  });

  it('writes the format\'s own line on stdout and the failure\'s detail on stderr when the text format fails', async () => {
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
    // The target's printer writes the format's own line on **stdout** —
    // `Execution error`, with **no** trailing newline: the printer writes
    // `Or(s+r)` and the failure branch sets `r = "Execution error"`
    // (`chunk-e7w77ts3.js:445913`) — and the failure's detail on **stderr**
    // (`process.stderr.write(\`${h}\n\`)` in the same printer).
    expect(stdout.text).toBe('Execution error');
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

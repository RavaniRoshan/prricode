/**
 * Contract test for the agent runtime: the turn cycle, the tool dispatch order,
 * the abort path, the permission integration and the persistence of a turn.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.4 (Agent loop and tool
 * dispatch), §2.5 (Permissions) and §2.6 (Sessions, persistence, and resumption),
 * and the `CC-010` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * The test pins:
 *
 *   - the cycle: request → stream → tool call → permission check → tool run →
 *     tool result → a **second** request that carries the tool result;
 *   - the dispatch order: two calls in one assistant message run in the order
 *     they appear, and each result is appended **before** the next request;
 *   - the abort path: the loop stops, a `provider_event` with `type: 'error'`
 *     and `retryable: false` is appended, and the turn returns `aborted` — also
 *     when the abort arrives during a tool;
 *   - the permission integration: `allow` runs the tool, `deny` refuses it and
 *     ends the turn without a tool result, `ask` refuses it rather than
 *     running it, and an unregistered tool is a refusal rather than a crash;
 *   - the re-check of a rewritten input, and that the stricter verdict wins;
 *   - that the dispatch groups agree with the `parallel` flag;
 *   - that a second turn reuses the session handle and appends to the same
 *     transcript;
 *   - the mapping of the provider's stop reasons onto the runtime's five.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAgentRuntime,
  ABORTED_MESSAGE,
  type AgentRuntime,
  type TurnInput,
  type TurnResult,
} from '../../src/agent/loop.js';
import { groupToolCalls, toolCallsFrom, type ToolCall } from '../../src/agent/dispatch.js';
import type { PermissionDecision } from '../../src/permissions/decision.js';
import type {
  ProviderDriver,
  ProviderEvent,
  ProviderRequest,
  StopReason,
} from '../../src/provider/drivers/types.js';
import { SESSION_SCHEMA_VERSION, type SessionEvent } from '../../src/session/event.js';
import { createSessionStore, type SessionHandle, type SessionStore } from '../../src/session/store.js';
import { createToolRegistry, type ToolDefinition } from '../../src/tools/registry.js';

/* -------------------------------------------------------------------------- */
/* The fixtures                                                                */
/* -------------------------------------------------------------------------- */

const CWD = '/work/project';

type PermissionChecker = typeof import('../../src/permissions/decision.js').checkPermission;

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cc010-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

/** A store that keeps every record it appends, so the test can watch them. */
class RecordingStore implements SessionStore {
  readonly appended: SessionEvent[] = [];

  constructor(private readonly inner: SessionStore) {}

  async create(opts: { cwd: string; sessionId?: string }): Promise<SessionHandle> {
    return this.inner.create(opts);
  }

  async append(handle: SessionHandle, event: SessionEvent): Promise<void> {
    await this.inner.append(handle, event);
    this.appended.push(event);
  }

  read(handle: SessionHandle): AsyncIterable<SessionEvent> {
    return this.inner.read(handle);
  }

  list(opts: { cwd: string; limit?: number }) {
    return this.inner.list(opts);
  }
}

/** One round of a fake provider turn. */
interface FakeRound {
  /** The events of the round. */
  events: ProviderEvent[];
  /** Awaited before the round's events are yielded. */
  wait?: Promise<void>;
}

/** A fake driver that also carries the transport. */
interface FakeDriver extends ProviderDriver {
  /** The transport seam: the driver sends the request. */
  send(request: ProviderRequest, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
  /** The requests the driver was given. */
  readonly requests: ProviderRequest[];
}

function fakeDriver(
  rounds: FakeRound[],
  onRequest?: (request: ProviderRequest, index: number) => void,
): FakeDriver {
  const requests: ProviderRequest[] = [];

  return {
    route: 'firstParty',
    requests,
    async *send(request: ProviderRequest): AsyncIterable<ProviderEvent> {
      const index = requests.length;
      requests.push(request);
      onRequest?.(request, index);
      const round = rounds[index];
      if (round === undefined) return;
      if (round.wait !== undefined) await round.wait;
      for (const event of round.events) yield event;
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

/** A tool that records what it was asked to do. */
interface FakeToolOptions {
  name: string;
  /** The tool's own verdict. `undefined` means the tool expresses no opinion. */
  decision?: PermissionDecision | undefined;
  /** The verdict of the re-check. */
  recheck?: PermissionDecision | undefined;
  /** The output of the tool. */
  output?: unknown;
  /** Called when the tool runs. */
  onExecute?: (input: unknown) => void;
  /** Called with the input the re-check received. */
  onRecheck?: (input: unknown) => void;
  /** Whether the tool's execution waits for this promise. */
  wait?: Promise<void>;
}

function fakeTool(options: FakeToolOptions): ToolDefinition {
  return {
    name: options.name,
    description: `the ${options.name} tool`,
    inputSchema: { type: 'object', properties: {} },
    mutatesFiles: false,
    checkPermissions: async (): Promise<PermissionDecision | undefined> => options.decision,
    validateInput: async () => ({ ok: true }),
    recheckPermission: async (input: unknown) => {
      options.onRecheck?.(input);
      return { decision: options.recheck };
    },
    execute: async (input: unknown) => {
      options.onExecute?.(input);
      if (options.wait !== undefined) await options.wait;
      return options.output ?? 'ok';
    },
  };
}

const allowAll: PermissionChecker = async () => ({
  behavior: 'allow',
  source: 'unknown',
  reasonType: 'other',
});

const denyAll: PermissionChecker = async () => ({
  behavior: 'deny',
  source: 'unknown',
  reasonType: 'other',
  reason: 'The rule denies this call.',
});

const askAll: PermissionChecker = async () => ({
  behavior: 'ask',
  source: 'unknown',
  reasonType: 'other',
  reason: 'This call needs approval.',
});

/** The events of a turn that calls one tool. */
function toolTurn(toolUseId: string, name: string, input: unknown): ProviderEvent[] {
  return [
    { type: 'message_start', messageId: 'msg_01', model: 'test-model' },
    { type: 'tool_use', id: toolUseId, name, input },
    { type: 'message_stop', stopReason: 'tool_use' },
  ];
}

/** The events of a turn that ends without a tool call. */
function finalTurn(text?: string): ProviderEvent[] {
  const events: ProviderEvent[] = [
    { type: 'message_start', messageId: 'msg_02', model: 'test-model' },
  ];
  if (text !== undefined) events.push({ type: 'text_delta', text });
  events.push({ type: 'message_stop', stopReason: 'end_turn' });
  return events;
}

/** The runtime under test, with its store and its driver. */
interface Harness {
  runtime: AgentRuntime;
  store: RecordingStore;
  driver: FakeDriver;
}

function harness(options: {
  rounds: FakeRound[];
  tools?: ToolDefinition[];
  permission?: PermissionChecker;
  onRequest?: (request: ProviderRequest, index: number) => void;
}): Harness {
  const store = new RecordingStore(createSessionStore({ configDir: makeRoot() }));
  const registry = createToolRegistry();
  for (const tool of options.tools ?? []) registry.register(tool);

  const driver = fakeDriver(options.rounds, options.onRequest);

  const runtime = createAgentRuntime({
    driver,
    registry,
    store,
    permission: options.permission ?? allowAll,
    cwd: CWD,
  });

  return { runtime, store, driver };
}

const input: TurnInput = { prompt: 'hello', sessionId: 'session-01', model: 'test-model' };

/** The kinds of the records a turn appended. */
function kinds(events: SessionEvent[]): string[] {
  return events.map((event) => event.t);
}

/** The tool-result blocks of a request's messages. */
function toolResultBlocks(
  request: ProviderRequest,
): { toolUseId: string; content: unknown; isError?: boolean }[] {
  const blocks: { toolUseId: string; content: unknown; isError?: boolean }[] = [];
  for (const message of request.messages) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      blocks.push({ toolUseId: block.tool_use_id, content: block.content, isError: block.is_error });
    }
  }
  return blocks;
}

/** The whole request, as text. */
function requestText(request: ProviderRequest): string {
  return JSON.stringify(request.messages);
}

/** How many times a text appears in a request's messages. */
function promptOccurrences(request: ProviderRequest, text: string): number {
  let count = 0;
  for (const message of request.messages) {
    const content = message.content;
    if (typeof content === 'string') {
      if (content === text) count += 1;
      continue;
    }
    for (const block of content) {
      if (block.type === 'text' && block.text === text) count += 1;
    }
  }
  return count;
}

/* -------------------------------------------------------------------------- */
/* The tests                                                                   */
/* -------------------------------------------------------------------------- */

describe('the agent runtime', () => {
  it('runs the tool, records the events, and issues a second request that carries the tool result', async () => {
    const { runtime, store, driver } = harness({
      rounds: [
        { events: toolTurn('toolu_01', 'Echo', { text: 'hi' }) },
        { events: finalTurn('done') },
      ],
      tools: [fakeTool({ name: 'Echo', output: 'hello' })],
    });

    const result = await runtime.runTurn(input);

    expect(result.stopReason).toBe('end_turn');
    expect(result.providerStopReason).toBe('end_turn');

    // The records of the turn: the prompt, the provider's events, the call, the
    // decision and the result.
    expect(kinds(result.events)).toEqual([
      'user_message',
      'provider_event',
      'provider_event',
      'provider_event',
      'tool_call',
      'permission_request',
      'tool_result',
      'provider_event',
      'provider_event',
      'provider_event',
      'assistant_message',
    ]);

    // Every provider event is persisted, as it arrives.
    const providerEvents = result.events.filter((event) => event.t === 'provider_event');
    expect(
      providerEvents.map((event) => (event.t === 'provider_event' ? event.event.type : '')),
    ).toEqual([
      'message_start',
      'tool_use',
      'message_stop',
      'message_start',
      'text_delta',
      'message_stop',
    ]);

    // The tool ran, and its result is a record.
    const toolResult = result.events.find((event) => event.t === 'tool_result');
    expect(toolResult?.t === 'tool_result' ? toolResult.envelope.toolUseId : '').toBe('toolu_01');
    expect(toolResult?.t === 'tool_result' ? toolResult.envelope.content : '').toBe('hello');

    // The call's record carries the tool-use id, so the call and its result
    // pair up.
    const toolCall = result.events.find((event) => event.t === 'tool_call');
    expect(toolCall?.t === 'tool_call' ? toolCall.id : '').toBe('toolu_01');

    // The **second** request carries the tool result.
    expect(driver.requests).toHaveLength(2);
    const blocks = toolResultBlocks(driver.requests[1]!);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.toolUseId).toBe('toolu_01');
    expect(blocks[0]?.content).toBe('hello');
    expect(requestText(driver.requests[1]!)).toContain('toolu_01');

    // The prompt is in the request exactly once: the conversation is projected
    // from the transcript, and the prompt is the one message the turn adds.
    expect(promptOccurrences(driver.requests[0]!, 'hello')).toBe(1);
    expect(promptOccurrences(driver.requests[1]!, 'hello')).toBe(1);

    // The records are in the transcript, not only in the result.
    expect(store.appended).toHaveLength(result.events.length);
  });

  it('executes two tool calls in the order they appear and appends each result before the next request', async () => {
    const executed: string[] = [];
    const toolResultsAtRequest: number[] = [];

    const { runtime, store } = harness({
      rounds: [
        {
          events: [
            { type: 'message_start', messageId: 'msg_01', model: 'test-model' },
            { type: 'tool_use', id: 'toolu_a', name: 'First', input: { n: 1 } },
            { type: 'tool_use', id: 'toolu_b', name: 'Second', input: { n: 2 } },
            { type: 'message_stop', stopReason: 'tool_use' },
          ],
        },
        { events: finalTurn() },
      ],
      tools: [
        fakeTool({ name: 'First', output: 'first', onExecute: () => executed.push('First') }),
        fakeTool({ name: 'Second', output: 'second', onExecute: () => executed.push('Second') }),
      ],
      onRequest: () => {
        toolResultsAtRequest.push(store.appended.filter((event) => event.t === 'tool_result').length);
      },
    });

    const result = await runtime.runTurn(input);

    // The calls ran in the order they appear.
    expect(executed).toEqual(['First', 'Second']);

    // Each result was appended before the next request was issued: the first
    // request carried no result, the second carried both.
    expect(toolResultsAtRequest).toEqual([0, 2]);

    // The records are in that order too.
    const order = result.events
      .filter((event) => event.t === 'tool_call' || event.t === 'tool_result')
      .map((event) => event.t);
    expect(order).toEqual(['tool_call', 'tool_result', 'tool_call', 'tool_result']);
  });

  it('aborting mid-stream stops the loop, records the error event, and returns aborted', async () => {
    const controller = new AbortController();
    const wait = new Promise<void>((resolve) => setTimeout(resolve, 40));
    const { runtime, store } = harness({
      rounds: [
        {
          events: [{ type: 'message_start', messageId: 'msg_01', model: 'test-model' }],
          wait,
        },
      ],
    });

    const pending = runtime.runTurn(input, controller.signal);
    setTimeout(() => controller.abort(), 5);
    const result = await pending;

    expect(result.stopReason).toBe('aborted');

    const last = result.events[result.events.length - 1];
    expect(last?.t).toBe('provider_event');
    expect(last?.t === 'provider_event' ? last.event : undefined).toEqual({
      type: 'error',
      message: ABORTED_MESSAGE,
      retryable: false,
    });

    // The record is in the transcript too.
    const recorded = store.appended[store.appended.length - 1];
    expect(recorded?.t === 'provider_event' ? recorded.event.type : '').toBe('error');
  });

  it('aborting during a tool does not append the tool result', async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    const { runtime, store } = harness({
      rounds: [{ events: toolTurn('toolu_01', 'Slow', {}) }],
      tools: [
        fakeTool({
          name: 'Slow',
          wait: new Promise<void>((resolve) => setTimeout(resolve, 40)),
          onExecute: () => {
            executed.push('Slow');
            controller.abort();
          },
        }),
      ],
    });

    const result = await runtime.runTurn(input, controller.signal);

    expect(result.stopReason).toBe('aborted');
    expect(executed).toEqual(['Slow']);
    expect(store.appended.some((event) => event.t === 'tool_result')).toBe(false);
  });

  it('a denied call is refused, recorded, and ends the turn without a tool result', async () => {
    const executed: string[] = [];
    const { runtime, store, driver } = harness({
      rounds: [{ events: toolTurn('toolu_01', 'Echo', {}) }],
      tools: [fakeTool({ name: 'Echo', onExecute: () => executed.push('Echo') })],
      permission: denyAll,
    });

    const result = await runtime.runTurn(input);

    expect(result.stopReason).toBe('tool_use');
    expect(executed).toEqual([]);

    // The denial is recorded.
    const request = result.events.find((event) => event.t === 'permission_request');
    expect(request?.t === 'permission_request' ? request.decision?.behavior : '').toBe('deny');

    // No tool result is recorded and no second request is issued: nothing is
    // sent back to the provider as if the tool had run.
    expect(store.appended.some((event) => event.t === 'tool_result')).toBe(false);
    expect(driver.requests).toHaveLength(1);
  });

  it('an ask is refused rather than run', async () => {
    const executed: string[] = [];
    const { runtime, store } = harness({
      rounds: [{ events: toolTurn('toolu_01', 'Echo', {}) }],
      tools: [fakeTool({ name: 'Echo', onExecute: () => executed.push('Echo') })],
      permission: askAll,
    });

    const result = await runtime.runTurn(input);

    expect(result.stopReason).toBe('tool_use');
    expect(executed).toEqual([]);

    const request = result.events.find((event) => event.t === 'permission_request');
    expect(request?.t === 'permission_request' ? request.decision?.behavior : '').toBe('ask');
    expect(store.appended.some((event) => event.t === 'tool_result')).toBe(false);
  });

  it('an unregistered tool is a refusal, not a crash', async () => {
    const { runtime, driver } = harness({
      rounds: [{ events: toolTurn('toolu_01', 'Missing', {}) }],
    });

    const result = await runtime.runTurn(input);

    expect(result.stopReason).toBe('tool_use');
    expect(driver.requests).toHaveLength(1);
  });

  it('a tool named after an Object.prototype member is not resolved', async () => {
    const { runtime } = harness({
      rounds: [{ events: toolTurn('toolu_01', 'constructor', {}) }],
    });

    const result = await runtime.runTurn(input);

    expect(result.stopReason).toBe('tool_use');
  });

  it('a rewritten input is re-checked in full, and the stricter verdict wins', async () => {
    const executed: string[] = [];
    const rechecked: unknown[] = [];
    const { runtime } = harness({
      rounds: [{ events: toolTurn('toolu_01', 'Echo', { value: 'original' }) }],
      tools: [
        fakeTool({
          name: 'Echo',
          decision: {
            behavior: 'allow',
            source: 'hook',
            reasonType: 'other',
            updatedInput: { value: 'rewritten' },
          },
          recheck: {
            behavior: 'deny',
            source: 'unknown',
            reasonType: 'other',
            reason: 'The rewritten input is not allowed.',
          },
          onExecute: () => executed.push('Echo'),
          onRecheck: (input) => rechecked.push(input),
        }),
      ],
    });

    const result = await runtime.runTurn(input);

    // The re-check ran with the **effective** (rewritten) input.
    expect(rechecked).toEqual([{ value: 'rewritten' }]);
    // The stricter verdict wins: the call did not run.
    expect(executed).toEqual([]);
    expect(result.stopReason).toBe('tool_use');
  });

  it('a second turn reuses the session handle and appends to the same transcript', async () => {
    const { runtime, store, driver } = harness({
      rounds: [
        { events: finalTurn('first') },
        { events: finalTurn('second') },
      ],
    });

    const first = await runtime.runTurn(input);
    const second = await runtime.runTurn({ ...input, prompt: 'goodbye' });

    expect(first.stopReason).toBe('end_turn');
    expect(second.stopReason).toBe('end_turn');

    // One session, one transcript: the second turn appended to the first one's
    // records.
    const summaries = await store.list({ cwd: CWD });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.sessionId).toBe('session-01');

    const userMessages = store.appended.filter((event) => event.t === 'user_message');
    expect(userMessages).toHaveLength(2);

    // The second turn's request carries the first turn's history: the
    // conversation is projected from the transcript.
    expect(driver.requests).toHaveLength(2);
    const secondRequest = requestText(driver.requests[1]!);
    expect(secondRequest).toContain('hello');
    expect(secondRequest).toContain('goodbye');
  });

  it('maps the provider stop reasons onto the runtime stop reasons', async () => {
    const cases: { provider: StopReason; expected: TurnResult['stopReason'] }[] = [
      { provider: 'end_turn', expected: 'end_turn' },
      { provider: 'max_tokens', expected: 'max_tokens' },
      { provider: 'stop_sequence', expected: 'end_turn' },
      { provider: 'refusal', expected: 'end_turn' },
    ];

    for (const entry of cases) {
      const { runtime } = harness({
        rounds: [
          {
            events: [
              { type: 'message_start', messageId: 'msg_01', model: 'test-model' },
              { type: 'message_stop', stopReason: entry.provider },
            ],
          },
        ],
      });

      const result = await runtime.runTurn(input);
      expect(result.stopReason).toBe(entry.expected);
      expect(result.providerStopReason).toBe(entry.provider);
    }
  });

  it('records a provider error as an error turn', async () => {
    const { runtime } = harness({
      rounds: [
        {
          events: [
            { type: 'message_start', messageId: 'msg_01', model: 'test-model' },
            { type: 'error', message: 'the upstream failed', retryable: true },
          ],
        },
      ],
    });

    const result = await runtime.runTurn(input);
    expect(result.stopReason).toBe('error');
  });

  it('carries the version, the timestamp and the id of every record', async () => {
    const { runtime } = harness({
      rounds: [{ events: finalTurn('hello') }],
    });

    const result = await runtime.runTurn(input);

    for (const event of result.events) {
      expect(event.v).toBe(SESSION_SCHEMA_VERSION);
      expect(typeof event.ts).toBe('number');
      expect(event.id.length).toBeGreaterThan(0);
    }
  });
});

describe('the tool-call dispatch', () => {
  it('collects the tool calls of a turn in the order they appear', () => {
    const calls = toolCallsFrom([
      { type: 'message_start', messageId: 'msg_01', model: 'test-model' },
      { type: 'tool_use', id: 'toolu_a', name: 'First', input: { n: 1 } },
      { type: 'text_delta', text: 'thinking' },
      { type: 'tool_use', id: 'toolu_b', name: 'Second', input: { n: 2 } },
      { type: 'message_stop', stopReason: 'tool_use' },
    ]);

    expect(calls).toEqual([
      { id: 'toolu_a', name: 'First', input: { n: 1 } },
      { id: 'toolu_b', name: 'Second', input: { n: 2 } },
    ]);
  });

  it('keeps the groups consistent with the parallel flag', () => {
    const calls: ToolCall[] = [
      { id: 'toolu_a', name: 'First', input: {} },
      { id: 'toolu_b', name: 'Second', input: {} },
    ];

    const sequential = groupToolCalls(calls);
    expect(sequential.parallel).toBe(false);
    expect(sequential.groups).toEqual([['toolu_a'], ['toolu_b']]);

    const parallel = groupToolCalls(calls, { mode: 'parallel' });
    expect(parallel.parallel).toBe(true);
    expect(parallel.groups).toEqual([['toolu_a', 'toolu_b']]);

    // The invariant: a sequential plan gives every call its own group, and a
    // parallel plan puts every call in one group.
    for (const plan of [sequential, parallel]) {
      const grouped = [...plan.groups.flat()].sort();
      expect(grouped).toEqual(['toolu_a', 'toolu_b']);
      if (plan.parallel) {
        expect(plan.groups).toHaveLength(1);
      } else {
        expect(plan.groups.every((group) => group.length === 1)).toBe(true);
      }
    }
  });
});

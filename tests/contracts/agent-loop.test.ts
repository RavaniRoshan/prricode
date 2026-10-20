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
 *     answers it with a `<tool_use_error>` result, `ask` refuses it rather than
 *     running it, and an unregistered tool is a refusal rather than a crash;
 *   - the **combination** rule: the tool's own verdict and the session's
 *     verdict, the one exception the generic prompt makes, and the short
 *     circuit a tool's own denial is;
 *   - the re-check of a rewritten input, that the stricter verdict wins, and
 *     that the session's service is consulted with the **rewritten** input;
 *   - that the transcript is **well formed** after a refusal and after an
 *     interruption: no empty message, no unanswered tool call;
 *   - that the groups agree with the `parallel` flag;
 *   - that a second turn reuses the session handle and appends to the same
 *     transcript;
 *   - the mapping of the provider's stop reasons onto the runtime's five;
 *   - the two numeric implementation choices: the output-token budget and the round cap;
 *   - the `approveAsk` seam: an ask it resolves runs the call, and an ask it
 *     does not resolve refuses it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAgentRuntime,
  ABORTED_MESSAGE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_TURNS,
  sessionKeyOf,
  type AgentRuntime,
  type AgentRuntimeDeps,
  type TurnInput,
  type TurnResult,
} from '../../src/agent/loop.js';
import { TURN_SOURCE } from '../../src/agent/context.js';
import { groupToolCalls, toolCallsFrom, type ToolCall } from '../../src/agent/dispatch.js';
import type {
  CheckPermissionOptions,
  PermissionDecision,
  ToolContext,
} from '../../src/permissions/decision.js';
import type {
  ProviderDriver,
  ProviderEvent,
  ProviderMessage,
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
  /** The marker that declares the driver the turn's transport. */
  readonly [TURN_SOURCE]: true;
  /** The transport seam: the driver sends the request. */
  send(request: ProviderRequest, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
  /** The requests the driver was given. */
  readonly requests: ProviderRequest[];
}

function fakeDriver(
  rounds: FakeRound[],
  onRequest?: (request: ProviderRequest, index: number) => void,
  repeatLastRound = false,
): FakeDriver {
  const requests: ProviderRequest[] = [];

  return {
    route: 'firstParty',
    requests,
    [TURN_SOURCE]: true,
    async *send(request: ProviderRequest): AsyncIterable<ProviderEvent> {
      const index = requests.length;
      requests.push(request);
      onRequest?.(request, index);
      const round = rounds[index] ?? (repeatLastRound ? rounds[rounds.length - 1] : undefined);
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

/**
 * A driver that carries a `send` member but does **not** declare itself the
 * turn's transport.
 */
function unmarkedDriver(): ProviderDriver & { send: () => Promise<unknown> } {
  return {
    route: 'firstParty',
    send: async () => ({ ok: true }),
    buildUrl: () => 'https://api.anthropic.com/v1/messages',
    buildHeaders: () => ({}),
    buildBody: () => ({ body: {}, headers: {} }),
    parseStream: () => ({ events: [], state: {} }),
    parseNonStreaming: () => ({ events: [] }),
    classifyError: () => ({ message: 'HTTP 500', retryable: false }),
    calculateNonstreamingTimeout: () => 1_000,
    betaFlagsFor: (flags: string[]) => flags,
  };
}

/**
 * A driver that declares itself the turn's transport but whose `send` returns
 * a promise rather than a stream of events.
 */
function promisingDriver(): ProviderDriver & { [TURN_SOURCE]: true; send: () => Promise<unknown> } {
  return {
    route: 'firstParty',
    [TURN_SOURCE]: true,
    send: async () => ({ ok: true }),
    buildUrl: () => 'https://api.anthropic.com/v1/messages',
    buildHeaders: () => ({}),
    buildBody: () => ({ body: {}, headers: {} }),
    parseStream: () => ({ events: [], state: {} }),
    parseNonStreaming: () => ({ events: [] }),
    classifyError: () => ({ message: 'HTTP 500', retryable: false }),
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
  /**
   * Whether the tool declares itself concurrency safe.
   *
   * `undefined` means the tool declares **nothing**, which is the target's own
   * default: a tool that does not declare the flag is not concurrency safe.
   */
  concurrencySafe?: boolean;
  /** The execution, when the test needs to control it. */
  run?: (input: unknown) => Promise<unknown>;
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
    isConcurrencySafe:
      options.concurrencySafe === undefined ? undefined : () => options.concurrencySafe === true,
    execute: async (input: unknown) => {
      options.onExecute?.(input);
      if (options.run !== undefined) return options.run(input);
      if (options.wait !== undefined) await options.wait;
      return options.output ?? 'ok';
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The concurrency tracker                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The calls that are in flight at the same time.
 *
 * The tracker is the **mechanism** the scheduling tests use: a call that
 * enters and leaves it is in flight, and the peak it records is the number of
 * calls that were in flight **at the same time**. A peak of one is a
 * sequential run; a peak of two is an overlap.
 */
class Concurrency {
  /** The calls in flight right now. */
  private active = 0;

  /** The largest number of calls that were in flight at the same time. */
  private peak = 0;

  /** The order the calls entered and left. */
  readonly log: string[] = [];

  /** A call starts. */
  enter(name: string): void {
    this.active += 1;
    if (this.active > this.peak) this.peak = this.active;
    this.log.push(`enter:${name}`);
  }

  /** A call ends. */
  leave(name: string): void {
    this.active -= 1;
    this.log.push(`leave:${name}`);
  }

  /** The largest number of calls that were in flight at the same time. */
  get peakConcurrency(): number {
    return this.peak;
  }

  /** The calls in flight right now. */
  get inFlight(): number {
    return this.active;
  }
}

/**
 * A gate that opens when `parties` calls have arrived.
 *
 * The gate is how the tests **prove** an overlap rather than infer it: a call
 * that waits at the gate cannot finish until another call has arrived, so two
 * calls that both wait at the gate are in flight at the same time — and two
 * calls that are run one after the other cannot both be at the gate, so the
 * gate times out instead.
 */
function meetingGate(parties: number, timeoutMs = 500): { arrive(): Promise<void>; timedOut(): boolean } {
  let arrived = 0;
  let release: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    release();
  }, timeoutMs);
  return {
    async arrive(): Promise<void> {
      arrived += 1;
      if (arrived >= parties) release();
      await opened;
      clearTimeout(timer);
    },
    timedOut(): boolean {
      return expired;
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
  approveAsk?: (
    ctx: ToolContext,
    decision: PermissionDecision,
  ) => Promise<PermissionDecision | undefined>;
  maxTokens?: number;
  maxTurns?: number;
  repeatLastRound?: boolean;
  now?: () => number;
  onRequest?: (request: ProviderRequest, index: number) => void;
  preToolUseHook?: AgentRuntimeDeps['preToolUseHook'];
  hook?: AgentRuntimeDeps['hook'];
  permissionOptions?: AgentRuntimeDeps['permissionOptions'];
}): Harness {
  const store = new RecordingStore(createSessionStore({ configDir: makeRoot() }));
  const registry = createToolRegistry();
  for (const tool of options.tools ?? []) registry.register(tool);

  const driver = fakeDriver(options.rounds, options.onRequest, options.repeatLastRound ?? false);

  const runtime = createAgentRuntime({
    driver,
    registry,
    store,
    permission: options.permission ?? allowAll,
    approveAsk: options.approveAsk,
    cwd: CWD,
    maxTokens: options.maxTokens,
    maxTurns: options.maxTurns,
    now: options.now,
    preToolUseHook: options.preToolUseHook,
    hook: options.hook,
    permissionOptions: options.permissionOptions,
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

/**
 * The ways a request is **not** well formed.
 *
 * A request is well formed when no message is empty, when two user messages do
 * not follow each other, and when every `tool_use` has a `tool_result` that
 * answers it.
 */
function malformed(request: ProviderRequest): string[] {
  const problems: string[] = [];
  const toolUses: string[] = [];
  const toolResults: string[] = [];
  let previous: ProviderMessage['role'] | undefined;

  for (const message of request.messages) {
    const content = message.content;
    if (typeof content === 'string') {
      if (content === '') problems.push('an empty message');
    } else {
      if (content.length === 0) problems.push('an empty message');
      for (const block of content) {
        if (block.type === 'tool_use') toolUses.push(block.id);
        if (block.type === 'tool_result') toolResults.push(block.tool_use_id);
      }
    }
    if (previous === 'user' && message.role === 'user') {
      problems.push('two user messages in a row');
    }
    previous = message.role;
  }

  for (const id of toolUses) {
    if (!toolResults.includes(id)) problems.push(`the tool use '${id}' is unanswered`);
  }

  return problems;
}

/** The tool-result records of a turn. */
function toolResultRecords(events: SessionEvent[]): SessionEvent[] {
  return events.filter((event) => event.t === 'tool_result');
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
    expect(toolResult?.t === 'tool_result' ? toolResult.envelope.id : '').toBe('toolu_01');
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

  it('a denied call is refused, answered with a tool_use_error, and ends the turn', async () => {
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
    // The transcript reads tool_call → permission_request → tool_result.
    const order = result.events
      .filter(
        (event) =>
          event.t === 'tool_call' || event.t === 'permission_request' || event.t === 'tool_result',
      )
      .map((event) => event.t);
    expect(order).toEqual(['tool_call', 'permission_request', 'tool_result']);

    // The result is a real answer: the `<tool_use_error>` wrapper the target
    // produces, carrying the decision and its reason type.
    const record = result.events.find((event) => event.t === 'tool_result');
    const envelope = record?.t === 'tool_result' ? record.envelope : undefined;
    expect(envelope?.isError).toBe(true);
    expect(envelope?.content).toBe(
      "<tool_use_error>The rule denies this call. The permission decision was 'deny' (source: unknown, reason type: other). Ask the user to approve the call, or change the permission rules.</tool_use_error>",
    );
    expect(envelope?.permission_decision?.decision).toBe('deny');
    expect(envelope?.permission_decision?.source).toBe('unknown');
    expect(envelope?.permission_decision?.reason_type).toBe('other');
    expect(envelope?.non_execution_kind).toBe('permission_denied');

    // The refusal ends the turn: no second request is issued in this turn.
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

    // The refusal is answered: the call that did not run produces the error
    // result the target produces.
    const record = result.events.find((event) => event.t === 'tool_result');
    expect(record?.t === 'tool_result' ? record.envelope.isError : false).toBe(true);
    expect(record?.t === 'tool_result' ? record.envelope.content : '').toContain('<tool_use_error>');
    expect(record?.t === 'tool_result' ? record.envelope.non_execution_kind : '').toBe(
      'permission_unresolved',
    );
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

  it('an unregistered tool is answered with a tool result and no permission request', async () => {
    const { runtime, store } = harness({
      rounds: [{ events: toolTurn('toolu_01', 'Missing', {}) }],
    });

    const result = await runtime.runTurn(input);

    // No permission was ever asked for the call, so there is no permission
    // request: the record kind is the tool result, and only that.
    expect(store.appended.some((event) => event.t === 'permission_request')).toBe(false);

    // The call is answered with the error result the target produces.
    const record = result.events.find((event) => event.t === 'tool_result');
    expect(record?.t === 'tool_result' ? record.envelope.isError : false).toBe(true);
    expect(record?.t === 'tool_result' ? record.envelope.content : '').toContain('<tool_use_error>');
    expect(record?.t === 'tool_result' ? record.envelope.non_execution_kind : '').toBe('unknown_tool');
  });

  it('the permission request is recorded before the tool runs', async () => {
    let clock = 0;
    let executedAt = 0;
    const { runtime } = harness({
      rounds: [{ events: toolTurn('toolu_01', 'Echo', {}) }],
      tools: [
        fakeTool({
          name: 'Echo',
          onExecute: () => {
            clock += 1;
            executedAt = clock;
          },
        }),
      ],
      now: () => {
        clock += 1;
        return clock;
      },
    });

    const result = await runtime.runTurn(input);

    // The chronology of a call is the check, the execution and the result: the
    // decision is recorded when it is made, not after the tool has run.
    const record = result.events.find((event) => event.t === 'permission_request');
    expect(record?.t === 'permission_request' ? record.ts : 0).toBeLessThan(executedAt);
  });

  it('a denied turn leaves the next request well formed', async () => {
    const { runtime, driver } = harness({
      rounds: [
        { events: toolTurn('toolu_01', 'Echo', {}) },
        { events: finalTurn('done') },
      ],
      tools: [fakeTool({ name: 'Echo' })],
      permission: denyAll,
    });

    const first = await runtime.runTurn(input);
    expect(first.stopReason).toBe('tool_use');

    const second = await runtime.runTurn({ ...input, prompt: 'again' });
    expect(second.stopReason).toBe('end_turn');

    // The second turn's request is well formed: no empty assistant message, no
    // unanswered tool call, and no two user messages in a row.
    const request = driver.requests[1]!;
    expect(malformed(request)).toEqual([]);

    // The denied call is answered, so the model observes the decision.
    expect(toolResultBlocks(request)).toHaveLength(1);
    const assistant = request.messages.filter((message) => message.role === 'assistant');
    expect(assistant).toHaveLength(1);
  });

  it('an interrupted turn never leaves an empty assistant message', async () => {
    const controller = new AbortController();
    const { runtime, driver } = harness({
      rounds: [{ events: toolTurn('toolu_01', 'Slow', {}) }],
      tools: [
        fakeTool({
          name: 'Slow',
          wait: new Promise<void>((resolve) => setTimeout(resolve, 40)),
          onExecute: () => {
            controller.abort();
          },
        }),
      ],
    });

    const first = await runtime.runTurn(input, controller.signal);
    expect(first.stopReason).toBe('aborted');

    const second = await runtime.runTurn({ ...input, prompt: 'again' });
    expect(second.stopReason).toBe('end_turn');

    // The interrupted call left no result, so its `tool_use` block is dropped —
    // and the assistant message it was in is dropped with it: the request never
    // carries an empty message.
    const request = driver.requests[1]!;
    expect(malformed(request)).toEqual([]);
    expect(request.messages.every((message) => message.role !== 'assistant')).toBe(true);

    // The third turn's transcript holds the interrupted call **between** the two
    // prompts, so the projection drops the empty assistant message and merges
    // the two user messages that were left.
    const third = await runtime.runTurn({ ...input, prompt: 'once more' });
    expect(third.stopReason).toBe('end_turn');
    expect(malformed(driver.requests[2]!)).toEqual([]);
  });

  it('a refused call with a max_tokens stop is reported as max_tokens', async () => {
    const { runtime } = harness({
      rounds: [
        {
          events: [
            { type: 'message_start', messageId: 'msg_01', model: 'test-model' },
            { type: 'tool_use', id: 'toolu_01', name: 'Echo', input: {} },
            { type: 'message_stop', stopReason: 'max_tokens' },
          ],
        },
      ],
      tools: [fakeTool({ name: 'Echo' })],
      permission: denyAll,
    });

    const result = await runtime.runTurn(input);

    // The refusal does not report the turn as `tool_use`: the provider's own
    // stop reason governs, and it is preserved.
    expect(result.stopReason).toBe('max_tokens');
    expect(result.providerStopReason).toBe('max_tokens');
  });

  it("a tool's allow overrides the service's generic no-rule-match ask", async () => {
    const executed: string[] = [];
    const { runtime } = harness({
      rounds: [{ events: toolTurn('toolu_01', 'Echo', {}) }, { events: finalTurn('done') }],
      tools: [
        fakeTool({
          name: 'Echo',
          decision: { behavior: 'allow', source: 'hook', reasonType: 'other' },
          onExecute: () => executed.push('Echo'),
        }),
      ],
      permission: async () => ({
        behavior: 'ask',
        source: 'unknown',
        reasonType: 'other',
        reasonKind: 'permissionPromptTool',
        noRuleMatched: true,
        reason: 'No permission rule matched.',
      }),
    });

    const result = await runtime.runTurn(input);

    // The generic prompt carries no rule, so it does not override the tool's
    // own allow: the call runs.
    expect(executed).toEqual(['Echo']);
    expect(result.stopReason).toBe('end_turn');
  });

  it("a tool's allow does not override an ask rule", async () => {
    const executed: string[] = [];
    const { runtime } = harness({
      rounds: [{ events: toolTurn('toolu_01', 'Echo', {}) }],
      tools: [
        fakeTool({
          name: 'Echo',
          decision: { behavior: 'allow', source: 'hook', reasonType: 'other' },
          onExecute: () => executed.push('Echo'),
        }),
      ],
      permission: async () => ({
        behavior: 'ask',
        source: 'unknown',
        reasonType: 'rule',
        reasonKind: 'rule',
        reason: 'A permission rule requires approval.',
      }),
    });

    const result = await runtime.runTurn(input);

    // Every other ask restricts the call, so the call is refused.
    expect(executed).toEqual([]);
    expect(result.stopReason).toBe('tool_use');
  });

  it("a tool's own denial short-circuits the session service", async () => {
    const consulted: unknown[] = [];
    const { runtime } = harness({
      rounds: [{ events: toolTurn('toolu_01', 'Echo', {}) }],
      tools: [
        fakeTool({
          name: 'Echo',
          decision: {
            behavior: 'deny',
            source: 'hook',
            reasonType: 'other',
            reason: 'The tool refuses this call.',
          },
        }),
      ],
      permission: async (ctx) => {
        consulted.push(ctx);
        return { behavior: 'allow', source: 'unknown', reasonType: 'other' };
      },
    });

    const result = await runtime.runTurn(input);

    // The session's service is not consulted for a call the tool already
    // refused.
    expect(consulted).toHaveLength(0);
    expect(result.stopReason).toBe('tool_use');
  });

  it('the re-check consults the session service with the rewritten input', async () => {
    const executed: string[] = [];
    const seen: unknown[] = [];
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
          recheck: { behavior: 'allow', source: 'unknown', reasonType: 'other' },
          onExecute: () => executed.push('Echo'),
        }),
      ],
      permission: async (ctx) => {
        seen.push(ctx.input);
        if (seen.length === 2) {
          return {
            behavior: 'deny',
            source: 'unknown',
            reasonType: 'other',
            reason: 'The rewritten input is not allowed.',
          };
        }
        return { behavior: 'allow', source: 'unknown', reasonType: 'other' };
      },
    });

    const result = await runtime.runTurn(input);

    // The service was consulted twice: with the original input, and with the
    // **effective** (rewritten) one.
    expect(seen).toEqual([{ value: 'original' }, { value: 'rewritten' }]);
    // The re-check's denial governs: the call did not run.
    expect(executed).toEqual([]);
    expect(result.stopReason).toBe('tool_use');
  });

  it('the re-check may not widen an ask into an allow', async () => {
    const executed: string[] = [];
    const { runtime } = harness({
      rounds: [{ events: toolTurn('toolu_01', 'Echo', { value: 'original' }) }],
      tools: [
        fakeTool({
          name: 'Echo',
          decision: {
            behavior: 'ask',
            source: 'hook',
            reasonType: 'other',
            reason: 'This call needs approval.',
            updatedInput: { value: 'rewritten' },
          },
          recheck: { behavior: 'allow', source: 'unknown', reasonType: 'other' },
          onExecute: () => executed.push('Echo'),
        }),
      ],
      permission: async () => ({ behavior: 'allow', source: 'unknown', reasonType: 'other' }),
    });

    const result = await runtime.runTurn(input);

    // The ask of the first check stands: the re-check may only restrict.
    expect(executed).toEqual([]);
    expect(result.stopReason).toBe('tool_use');
  });

  it('an ask that approveAsk resolves runs the call', async () => {
    const executed: string[] = [];
    const { runtime } = harness({
      rounds: [{ events: toolTurn('toolu_01', 'Echo', {}) }, { events: finalTurn('done') }],
      tools: [fakeTool({ name: 'Echo', onExecute: () => executed.push('Echo') })],
      permission: askAll,
      approveAsk: async () => ({
        behavior: 'allow',
        source: 'user_temporary',
        reasonType: 'other',
      }),
    });

    const result = await runtime.runTurn(input);

    expect(executed).toEqual(['Echo']);
    expect(result.stopReason).toBe('end_turn');
    const record = result.events.find((event) => event.t === 'tool_result');
    expect(record?.t === 'tool_result' ? record.envelope.isError : true).toBe(false);
  });

  it('an ask that approveAsk does not resolve refuses the call', async () => {
    const executed: string[] = [];
    const { runtime } = harness({
      rounds: [{ events: toolTurn('toolu_01', 'Echo', {}) }],
      tools: [fakeTool({ name: 'Echo', onExecute: () => executed.push('Echo') })],
      permission: askAll,
      approveAsk: async () => undefined,
    });

    const result = await runtime.runTurn(input);

    expect(executed).toEqual([]);
    expect(result.stopReason).toBe('tool_use');
    const record = result.events.find((event) => event.t === 'tool_result');
    expect(record?.t === 'tool_result' ? record.envelope.isError : false).toBe(true);
    expect(record?.t === 'tool_result' ? record.envelope.content : '').toContain('<tool_use_error>');
  });

  it('a session that cannot be opened names the store reason', async () => {
    const { runtime } = harness({ rounds: [] });

    const result = await runtime.runTurn({ prompt: 'p', sessionId: 'bad id!', model: 'm' });

    // The failure is not an unexplained `error`: the store's own reason is
    // named.
    expect(result.stopReason).toBe('error');
    expect(result.message).toBeDefined();
    expect(result.message).toContain('bad id!');
    expect(result.message).toContain('not usable as a file name');
  });

  it('the request asks for the default output-token budget', async () => {
    const { runtime, driver } = harness({
      rounds: [{ events: finalTurn('done') }],
    });

    await runtime.runTurn(input);

    expect(DEFAULT_MAX_TOKENS).toBe(4096);
    expect(driver.requests[0]?.maxTokens).toBe(DEFAULT_MAX_TOKENS);
  });

  it('the caller may name the output-token budget', async () => {
    const { runtime, driver } = harness({
      rounds: [{ events: finalTurn('done') }],
      maxTokens: 512,
    });

    await runtime.runTurn(input);

    expect(driver.requests[0]?.maxTokens).toBe(512);
  });

  it('the round cap ends the turn with an error', async () => {
    const { runtime, driver } = harness({
      rounds: [{ events: toolTurn('toolu_01', 'Echo', {}) }],
      repeatLastRound: true,
      tools: [fakeTool({ name: 'Echo' })],
    });

    const result = await runtime.runTurn(input);

    // The turn ran the cap's worth of rounds and gave up.
    expect(DEFAULT_MAX_TURNS).toBe(32);
    expect(driver.requests).toHaveLength(DEFAULT_MAX_TURNS);
    expect(result.stopReason).toBe('error');

    // The reason is in the transcript, and in the result.
    const last = result.events[result.events.length - 1];
    expect(last?.t === 'provider_event' ? last.event : undefined).toEqual({
      type: 'error',
      message: expect.stringContaining(String(DEFAULT_MAX_TURNS)),
      retryable: false,
    });
    expect(result.message).toContain(String(DEFAULT_MAX_TURNS));
  });

  it('an empty tool-use id is minted once and used everywhere', async () => {
    const { runtime, driver } = harness({
      rounds: [{ events: toolTurn('', 'Echo', {}) }, { events: finalTurn('done') }],
      tools: [fakeTool({ name: 'Echo', output: 'hello' })],
    });

    const result = await runtime.runTurn(input);

    const call = result.events.find((event) => event.t === 'tool_call');
    const callId = call?.t === 'tool_call' ? call.id : '';
    expect(callId).not.toBe('');

    // The record, the envelope and the request all carry the minted id, so the
    // call and its answer pair up.
    const record = result.events.find((event) => event.t === 'tool_result');
    expect(record?.t === 'tool_result' ? record.envelope.id : '').toBe(callId);
    expect(toolResultBlocks(driver.requests[1]!)[0]?.toolUseId).toBe(callId);
    expect(malformed(driver.requests[1]!)).toEqual([]);
  });

  it('the session key is injective for arbitrary session ids', () => {
    expect(sessionKeyOf('/a', 'b\0c')).not.toBe(sessionKeyOf('/a\0b', 'c'));
    expect(sessionKeyOf('/a', 'b')).toBe(sessionKeyOf('/a', 'b'));
  });

  it('a driver that does not declare itself a turn source is not adopted', async () => {
    const store = new RecordingStore(createSessionStore({ configDir: makeRoot() }));
    const registry = createToolRegistry();
    const runtime = createAgentRuntime({
      driver: unmarkedDriver(),
      registry,
      store,
      permission: allowAll,
      cwd: CWD,
    });

    const result = await runtime.runTurn(input);

    expect(result.stopReason).toBe('error');
    expect(result.message).toContain('carries no turn source');
  });

  it("a driver's send member must return an async iterable", async () => {
    const store = new RecordingStore(createSessionStore({ configDir: makeRoot() }));
    const registry = createToolRegistry();
    const runtime = createAgentRuntime({
      driver: promisingDriver(),
      registry,
      store,
      permission: allowAll,
      cwd: CWD,
    });

    const result = await runtime.runTurn(input);

    // The failure is named, not the runtime's "…is not iterable".
    expect(result.stopReason).toBe('error');
    expect(result.message).toContain('must return an async iterable of provider events');
    expect(result.message).toContain('a promise');
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
      { provider: 'tool_use', expected: 'tool_use' },
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

/* -------------------------------------------------------------------------- */
/* The scheduling                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The scheduling of the tool calls of one assistant message.
 *
 * The target's scheduler is **per tool, not per message**: every tool declares
 * whether it is concurrency safe, the safe calls of a message run **together**,
 * a call that is not concurrency safe runs **alone** and is a **barrier**, and
 * the next model request is issued only after **every** call of the message
 * has produced its result.
 *
 * The tests below prove the overlap with a **gate**: a call that waits at the
 * gate cannot finish until another call has arrived, so two calls that both
 * wait at the gate were in flight at the same time.
 */
describe('the tool-call scheduling', () => {
  /** The events of a turn that makes three tool calls. */
  function threeCallTurn(): ProviderEvent[] {
    return [
      { type: 'message_start', messageId: 'msg_01', model: 'test-model' },
      { type: 'tool_use', id: 'toolu_a', name: 'First', input: { n: 1 } },
      { type: 'tool_use', id: 'toolu_b', name: 'Second', input: { n: 2 } },
      { type: 'tool_use', id: 'toolu_c', name: 'Third', input: { n: 3 } },
      { type: 'message_stop', stopReason: 'tool_use' },
    ];
  }

  it('runs two concurrency-safe calls of one message at the same time', async () => {
    const tracker = new Concurrency();
    const gate = meetingGate(2);

    const waiting = (name: string) =>
      fakeTool({
        name,
        concurrencySafe: true,
        run: async () => {
          tracker.enter(name);
          await gate.arrive();
          tracker.leave(name);
          return name;
        },
      });

    const { runtime } = harness({
      rounds: [{ events: threeCallTurn() }, { events: finalTurn() }],
      tools: [waiting('First'), waiting('Second'), waiting('Third')],
    });

    const result = await runtime.runTurn(input);

    expect(result.stopReason).toBe('end_turn');
    // The two calls of the first group met at the gate: neither of them waited
    // for the timeout, and they were in flight at the same time.
    expect(gate.timedOut()).toBe(false);
    expect(tracker.peakConcurrency).toBeGreaterThanOrEqual(2);
  });

  it('runs a call that is not concurrency safe alone, and stops the queue at it', async () => {
    const tracker = new Concurrency();
    const gate = meetingGate(2);
    /** What the unsafe call saw when it started. */
    let inFlightAtStart = -1;

    const safe = (name: string) =>
      fakeTool({
        name,
        concurrencySafe: true,
        run: async () => {
          tracker.enter(name);
          await gate.arrive();
          tracker.leave(name);
          return name;
        },
      });

    const unsafe = fakeTool({
      name: 'Second',
      run: async () => {
        // The call that is not concurrency safe runs **alone**: nothing else is
        // in flight when it starts.
        inFlightAtStart = tracker.inFlight;
        tracker.enter('Second');
        await new Promise((resolve) => setTimeout(resolve, 10));
        tracker.leave('Second');
        return 'second';
      },
    });

    const { runtime } = harness({
      rounds: [{ events: threeCallTurn() }, { events: finalTurn() }],
      tools: [safe('First'), unsafe, safe('Third')],
    });

    const result = await runtime.runTurn(input);

    expect(result.stopReason).toBe('end_turn');
    // Nothing was running when the unsafe call started.
    expect(inFlightAtStart).toBe(0);
    // The unsafe call is a **barrier**: the call behind it waits for it, so
    // the third call did not meet the first one at the gate.
    expect(gate.timedOut()).toBe(true);
    expect(tracker.log.indexOf('leave:Second')).toBeLessThan(tracker.log.indexOf('enter:Third'));
    // The first and the third call are in different groups, so they never ran
    // at the same time.
    expect(tracker.peakConcurrency).toBe(1);
  });

  it('issues the next model request only after every call has produced its result', async () => {
    const tracker = new Concurrency();
    const gate = meetingGate(2);
    const resultsAtRequest: number[] = [];

    const waiting = (name: string, delayMs: number) =>
      fakeTool({
        name,
        concurrencySafe: true,
        run: async () => {
          tracker.enter(name);
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          await gate.arrive();
          tracker.leave(name);
          return name;
        },
      });

    const { runtime, store } = harness({
      rounds: [{ events: threeCallTurn() }, { events: finalTurn() }],
      tools: [waiting('First', 0), waiting('Second', 30), waiting('Third', 0)],
      onRequest: () => {
        resultsAtRequest.push(store.appended.filter((event) => event.t === 'tool_result').length);
      },
    });

    const result = await runtime.runTurn(input);

    expect(result.stopReason).toBe('end_turn');
    // The first request carried no result; the second carried **all three**.
    expect(resultsAtRequest).toEqual([0, 3]);
  });

  it('runs a tool that does not declare the flag on its own', async () => {
    const tracker = new Concurrency();
    const gate = meetingGate(2, 200);

    const waiting = (name: string) =>
      fakeTool({
        name,
        // No `concurrencySafe`: the tool declares **nothing**, which is the
        // target's own default — a tool that does not declare the flag is not
        // concurrency safe.
        run: async () => {
          tracker.enter(name);
          await gate.arrive();
          tracker.leave(name);
          return name;
        },
      });

    const { runtime } = harness({
      rounds: [{ events: threeCallTurn() }, { events: finalTurn() }],
      tools: [waiting('First'), waiting('Second'), waiting('Third')],
    });

    const result = await runtime.runTurn(input);

    expect(result.stopReason).toBe('end_turn');
    // The calls ran one after the other: the gate never opened on a second
    // arrival, and only one call was ever in flight.
    expect(gate.timedOut()).toBe(true);
    expect(tracker.peakConcurrency).toBe(1);
  });

  it('emits the results of the concurrency-safe calls in completion order', async () => {
    const order: string[] = [];

    const waiting = (name: string, delayMs: number) =>
      fakeTool({
        name,
        concurrencySafe: true,
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          order.push(name);
          return name;
        },
      });

    const { runtime, driver } = harness({
      rounds: [{ events: threeCallTurn() }, { events: finalTurn() }],
      tools: [waiting('First', 30), waiting('Second', 5), waiting('Third', 15)],
    });

    await runtime.runTurn(input);

    // The calls finished in the order their work took, and the results are
    // emitted in that order.
    expect(order).toEqual(['Second', 'Third', 'First']);
    const blocks = toolResultBlocks(driver.requests[1]!);
    expect(blocks.map((block) => block.toolUseId)).toEqual(['toolu_b', 'toolu_c', 'toolu_a']);
  });
});

/* -------------------------------------------------------------------------- */
/* The seams the runtime's own permission service consults                      */
/* -------------------------------------------------------------------------- */

describe('the runtime\'s permission options', () => {
  it('carries the PreToolUse seam when the caller supplies no permission options', async () => {
    const seen: CheckPermissionOptions[] = [];
    const seam = (): undefined => undefined;

    const { runtime } = harness({
      rounds: [
        { events: toolTurn('toolu_01', 'Echo', { text: 'hi' }) },
        { events: finalTurn('done') },
      ],
      tools: [fakeTool({ name: 'Echo', output: 'hello' })],
      permission: async (_ctx, options) => {
        seen.push(options);
        return { behavior: 'allow', source: 'unknown', reasonType: 'other' };
      },
      preToolUseHook: seam,
    });

    await runtime.runTurn(input);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.preToolUseHook).toBe(seam);
  });

  it('carries the PermissionRequest seam as well', async () => {
    const seen: CheckPermissionOptions[] = [];
    const seam = (): undefined => undefined;

    const { runtime } = harness({
      rounds: [
        { events: toolTurn('toolu_01', 'Echo', { text: 'hi' }) },
        { events: finalTurn('done') },
      ],
      tools: [fakeTool({ name: 'Echo', output: 'hello' })],
      permission: async (_ctx, options) => {
        seen.push(options);
        return { behavior: 'allow', source: 'unknown', reasonType: 'other' };
      },
      hook: seam,
    });

    await runtime.runTurn(input);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.hook).toBe(seam);
  });

  it('keeps a caller-supplied permissionOptions and fills in the seams it lacks', async () => {
    const seen: CheckPermissionOptions[] = [];
    const seam = (): undefined => undefined;
    const supplied: CheckPermissionOptions = {
      rules: { allow: [], deny: [], ask: [] },
      mode: 'default',
    };

    const { runtime } = harness({
      rounds: [
        { events: toolTurn('toolu_01', 'Echo', { text: 'hi' }) },
        { events: finalTurn('done') },
      ],
      tools: [fakeTool({ name: 'Echo', output: 'hello' })],
      permission: async (_ctx, options) => {
        seen.push(options);
        return { behavior: 'allow', source: 'unknown', reasonType: 'other' };
      },
      permissionOptions: supplied,
      preToolUseHook: seam,
    });

    await runtime.runTurn(input);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.mode).toBe('default');
    expect(seen[0]?.preToolUseHook).toBe(seam);
  });

  it('prefers a seam the caller supplied in the options over the dependency\'s', async () => {
    const seen: CheckPermissionOptions[] = [];
    const fromOptions = (): undefined => undefined;
    const fromDependency = (): undefined => undefined;

    const { runtime } = harness({
      rounds: [
        { events: toolTurn('toolu_01', 'Echo', { text: 'hi' }) },
        { events: finalTurn('done') },
      ],
      tools: [fakeTool({ name: 'Echo', output: 'hello' })],
      permission: async (_ctx, options) => {
        seen.push(options);
        return { behavior: 'allow', source: 'unknown', reasonType: 'other' };
      },
      permissionOptions: {
        rules: { allow: [], deny: [], ask: [] },
        mode: 'default',
        preToolUseHook: fromOptions,
      },
      preToolUseHook: fromDependency,
    });

    await runtime.runTurn(input);

    // The options are the **more specific** statement, so the seam the caller
    // put in them wins over the one the dependency carries.
    expect(seen[0]?.preToolUseHook).toBe(fromOptions);
  });

  it('does not mutate the options object the caller handed over', async () => {
    const supplied: CheckPermissionOptions = {
      rules: { allow: [], deny: [], ask: [] },
      mode: 'default',
    };
    const before = Object.keys(supplied).sort();

    const { runtime } = harness({
      rounds: [
        { events: toolTurn('toolu_01', 'Echo', { text: 'hi' }) },
        { events: finalTurn('done') },
      ],
      tools: [fakeTool({ name: 'Echo', output: 'hello' })],
      permission: async () => ({ behavior: 'allow', source: 'unknown', reasonType: 'other' }),
      permissionOptions: supplied,
      preToolUseHook: (): undefined => undefined,
      hook: (): undefined => undefined,
    });

    await runtime.runTurn(input);

    // The runtime **copies** the options, so a seam it filled in is not
    // visible to the caller — and the caller's object is untouched.
    expect(Object.keys(supplied).sort()).toEqual(before);
    expect(supplied.preToolUseHook).toBeUndefined();
    expect(supplied.hook).toBeUndefined();
  });

  it('does not leak one runtime\'s seam into another that shares the options', async () => {
    const shared: CheckPermissionOptions = {
      rules: { allow: [], deny: [], ask: [] },
      mode: 'default',
    };
    const first = (): undefined => undefined;
    const second = (): undefined => undefined;
    const seen: Array<string | undefined> = [];

    const a = harness({
      rounds: [
        { events: toolTurn('toolu_01', 'Echo', { text: 'hi' }) },
        { events: finalTurn('done') },
      ],
      tools: [fakeTool({ name: 'Echo', output: 'hello' })],
      permission: async (_ctx, options) => {
        seen.push(options.preToolUseHook === first ? 'first' : 'other');
        return { behavior: 'allow', source: 'unknown', reasonType: 'other' };
      },
      permissionOptions: shared,
      preToolUseHook: first,
    });
    const b = harness({
      rounds: [
        { events: toolTurn('toolu_02', 'Echo', { text: 'hi' }) },
        { events: finalTurn('done') },
      ],
      tools: [fakeTool({ name: 'Echo', output: 'hello' })],
      permission: async (_ctx, options) => {
        seen.push(options.preToolUseHook === second ? 'second' : 'other');
        return { behavior: 'allow', source: 'unknown', reasonType: 'other' };
      },
      permissionOptions: shared,
      preToolUseHook: second,
    });

    await a.runtime.runTurn(input);
    await b.runtime.runTurn(input);

    // Each runtime sees **its own** seam, and the shared object is unchanged.
    expect(seen).toEqual(['first', 'second']);
    expect(shared.preToolUseHook).toBeUndefined();
  });

  it('leaves the default options untouched when no seam is supplied', async () => {
    const seen: CheckPermissionOptions[] = [];

    const { runtime } = harness({
      rounds: [
        { events: toolTurn('toolu_01', 'Echo', { text: 'hi' }) },
        { events: finalTurn('done') },
      ],
      tools: [fakeTool({ name: 'Echo', output: 'hello' })],
      permission: async (_ctx, options) => {
        seen.push(options);
        return { behavior: 'allow', source: 'unknown', reasonType: 'other' };
      },
    });

    await runtime.runTurn(input);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.preToolUseHook).toBeUndefined();
    expect(seen[0]?.hook).toBeUndefined();
    expect(seen[0]?.mode).toBe('default');
  });
});

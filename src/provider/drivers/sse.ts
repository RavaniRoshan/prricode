/**
 * The Anthropic **SSE parser** and its event mapper.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.2 (the pinned
 * SDK's SSE parser, its extended event vocabulary and the parse-failure
 * message) and §2.2a (the Bedrock adapter's binary eventstream, whose frames
 * carry the **same** Anthropic event objects).
 *
 * ## Why this file exists
 *
 * The shared vocabulary (`types.ts`) had five responsibilities: the type
 * vocabulary, the body/header builders, the error classifier, the timeout
 * policy and the SSE parser plus its event mapper. The plan fixes the
 * *file name* `drivers/types.ts`, so that file stays; the streaming logic
 * moves **here**, and `types.ts` re-exports this module's public surface so
 * that no importer changes.
 *
 * ## The parse state is explicit
 *
 * The state is an object rather than a closure, so a chunk boundary in the
 * middle of a frame does not lose data: the unparsed remainder is carried
 * forward in `buffer`, and the accumulating tool blocks live in the state.
 *
 * ## The vocabulary is **tolerated**, not required
 *
 * **Observed** (audit §2.2): the pinned SDK's SSE parser accepts an event
 * vocabulary that is broader than the public API documents — `agent.*`,
 * `user.*`, `session.*`, `span.*`, plus `event_start`, `event_delta`,
 * `system.message` and a legacy `completion`. A frame whose event is in that
 * list is parsed and never fails the stream; a frame whose event is in
 * **neither** list is tolerated too (this implementation does not fail a stream over an
 * event it does not recognise).
 */

import {
  classifyErrorStatus,
  isRecord,
  ownArray,
  ownBoolean,
  ownNumber,
  ownRecord,
  ownString,
  stopReasonFromWire,
  usageFromWire,
  type ProviderEvent,
  type StopReason,
  type Usage,
} from './types.js';

/* -------------------------------------------------------------------------- */
/* The event vocabulary                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The Anthropic **core** SSE events.
 *
 * **Observed** (audit §2.2): the pinned SDK's SSE parser accepts a broader
 * event vocabulary than the public API documents.
 *
 * `error` is part of the core set: the plan's Step 8 requires that "a `data:`
 * frame carrying an `error` object emits `{ type: 'error' }`", and the
 * Anthropic API delivers a stream failure as an `event: error` frame.
 */
export const CORE_SSE_EVENTS: ReadonlySet<string> = new Set([
  'message_start',
  'message_delta',
  'message_stop',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message',
  'error',
]);

/**
 * The **extended** SSE events the pinned SDK accepts.
 *
 * **Observed** (audit §2.2): `agent.*`, `user.*`, `session.*`, `span.*`, plus
 * `event_start`, `event_delta`, `system.message` and a legacy `completion`.
 *
 * This implementation **tolerates** them: a frame whose event is in this set is parsed
 * and never fails the stream.
 */
export const EXTENDED_SSE_EVENTS: ReadonlySet<string> = new Set([
  // agent
  'agent.message',
  'agent.thinking',
  'agent.tool_use',
  'agent.tool_result',
  'agent.mcp_tool_use',
  'agent.mcp_tool_result',
  'agent.custom_tool_use',
  'agent.thread_context_compacted',
  'agent.thread_message_received',
  'agent.thread_message_sent',
  'agent.session_thread_message_received',
  'agent.session_thread_message_sent',
  // user
  'user.message',
  'user.interrupt',
  'user.tool_confirmation',
  'user.custom_tool_result',
  'user.tool_result',
  'user.define_outcome',
  // session
  'session.status_running',
  'session.status_idle',
  'session.status_rescheduled',
  'session.status_terminated',
  'session.error',
  'session.deleted',
  'session.updated',
  'session.thread_created',
  'session.thread_status_created',
  'session.thread_status_running',
  'session.thread_status_idle',
  'session.thread_status_rescheduled',
  'session.thread_status_terminated',
  // span / outcome
  'span.model_request_start',
  'span.model_request_end',
  'span.outcome_evaluation_start',
  'span.outcome_evaluation_ongoing',
  'span.outcome_evaluation_end',
  // misc
  'event_start',
  'event_delta',
  'system.message',
  'completion',
]);

/** Whether an event name is in the pinned SDK's accepted vocabulary. */
export function isKnownSseEvent(name: string): boolean {
  return CORE_SSE_EVENTS.has(name) || EXTENDED_SSE_EVENTS.has(name);
}

/* -------------------------------------------------------------------------- */
/* The parse state                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The parse state of an Anthropic SSE stream.
 *
 * The state is **explicit** (the plan's Step 9) so that a chunk boundary in the
 * middle of a frame does not lose data: the unparsed remainder is carried
 * forward.
 */
export interface AnthropicStreamState {
  /** The unparsed remainder of the last chunk. */
  buffer: string;
  /** Whether a `message_start` has already been emitted. */
  started: boolean;
  /** The latest **cumulative** usage the stream reported. */
  usage?: Usage;
  /** The stop reason the stream reported. */
  stopReason?: StopReason;
  /** The tool blocks that are still accumulating their JSON input. */
  pendingTools: Map<number, PendingToolBlock>;
}

/** A tool block whose input is still arriving. */
export interface PendingToolBlock {
  id: string;
  name: string;
  /** The accumulated partial JSON. */
  json: string;
  /** The input the block carried at its start, when it carried one. */
  input?: unknown;
}

/** A fresh parse state. */
export function createStreamState(): AnthropicStreamState {
  return { buffer: '', started: false, pendingTools: new Map() };
}

/** Whether an opaque parse state is an Anthropic stream state. */
export function isAnthropicStreamState(state: unknown): state is AnthropicStreamState {
  if (!isRecord(state)) return false;
  if (typeof state['buffer'] !== 'string') return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/* The frame parser                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The SSE frame separator: a blank line, with either line ending.
 */
const FRAME_SEPARATOR = /\r?\n\r?\n/;

/**
 * Split a buffer into complete frames and the remainder.
 *
 * The remainder is the partial frame at the end of the buffer, which the caller
 * carries forward.
 */
export function splitSseFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let rest = buffer;
  for (;;) {
    const match = FRAME_SEPARATOR.exec(rest);
    if (match === null) break;
    frames.push(rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);
  }
  return { frames, rest };
}

/** One parsed SSE frame. */
export interface SseFrame {
  /** The `event:` name, when the frame carried one. */
  event?: string;
  /** The concatenated `data:` payload. */
  data: string;
  /** The raw frame, for an error message. */
  raw: string;
}

/**
 * Parse one SSE frame.
 *
 * A frame with no `data:` line (a keep-alive comment, for instance) yields
 * `undefined`. A frame with **several** `data:` lines joins them with a
 * newline, as the SSE specification requires. The `id:` and `retry:` lines
 * carry no meaning for this implementation and are ignored.
 */
export function parseSseFrame(frame: string): SseFrame | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      event = value;
      continue;
    }
    if (field === 'data') {
      data.push(value);
      continue;
    }
    // `id:` and `retry:` carry no meaning for this implementation.
  }
  if (data.length === 0) return undefined;
  return event !== undefined ? { event, data: data.join('\n'), raw: frame } : { data: data.join('\n'), raw: frame };
}

/* -------------------------------------------------------------------------- */
/* The chunk parser                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Parse a chunk of an Anthropic SSE stream.
 *
 * A frame whose payload is not JSON throws with the offending data and the raw
 * frame — **observed** (audit §2.2): "a parse failure throws with the
 * offending data and raw chunk".
 */
export function parseSseChunk(
  chunk: string,
  state: AnthropicStreamState,
): { events: ProviderEvent[]; state: AnthropicStreamState } {
  const { frames, rest } = splitSseFrames(state.buffer + chunk);
  const events: ProviderEvent[] = [];
  const next: AnthropicStreamState = {
    buffer: rest,
    started: state.started,
    pendingTools: state.pendingTools,
  };
  if (state.usage !== undefined) next.usage = state.usage;
  if (state.stopReason !== undefined) next.stopReason = state.stopReason;

  for (const frame of frames) {
    const parsed = parseSseFrame(frame);
    if (parsed === undefined) continue;
    events.push(...eventsFromSseFrame(parsed, next));
  }

  return { events, state: next };
}

/**
 * The events of a whole SSE text, as an async iterable.
 *
 * This is this implementation's analogue of the target's
 * `SSEParser.fromSSEResponse(response, controller, client)`: the streaming
 * branch of `parseResponse` returns one of these, and a consumer iterates it
 * for the turn's events.
 */
export function sseEventsFromText(text: string): AsyncIterable<ProviderEvent> {
  const source = text.endsWith('\n\n') ? text : `${text}\n\n`;
  const { events } = parseSseChunk(source, createStreamState());
  return iterateEvents(events);
}

/** Yield the events of a parsed chunk, one at a time. */
async function* iterateEvents(events: readonly ProviderEvent[]): AsyncGenerator<ProviderEvent> {
  for (const event of events) yield event;
}

/* -------------------------------------------------------------------------- */
/* The event mapper                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Turn one SSE frame into this implementation's events.
 *
 * The **extended** vocabulary is tolerated: a frame whose event is in
 * `EXTENDED_SSE_EVENTS` never fails the stream. The tool-shaped extended
 * events are surfaced, because the plan's `ProviderEvent` union has a
 * `tool_result` member that would otherwise be unreachable; every other
 * extended event is ignored.
 */
export function eventsFromSseFrame(frame: SseFrame, state: AnthropicStreamState): ProviderEvent[] {
  let payload: unknown;
  try {
    payload = JSON.parse(frame.data);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to parse the SSE payload ${JSON.stringify(frame.data)} (frame ${JSON.stringify(frame.raw)}): ${reason}`,
    );
  }

  const type = isRecord(payload) ? (ownString(payload, 'type') ?? frame.event ?? '') : (frame.event ?? '');

  if (!isKnownSseEvent(type)) {
    // An event the pinned SDK does not know is not a failure: this implementation
    // tolerates what it does not recognise.
    return [];
  }

  if (EXTENDED_SSE_EVENTS.has(type) && !CORE_SSE_EVENTS.has(type)) {
    return extendedEventToEvents(type, payload);
  }

  return coreEventToEvents(type, payload, state);
}

/**
 * Map an extended event onto this implementation's events.
 *
 * Only the tool-shaped events are surfaced; the rest are ignored (this implementation
 * tolerates them).
 */
function extendedEventToEvents(type: string, payload: unknown): ProviderEvent[] {
  if (!isRecord(payload)) return [];
  if (type === 'agent.tool_use' || type === 'agent.mcp_tool_use' || type === 'agent.custom_tool_use') {
    const id = ownString(payload, 'tool_use_id') ?? ownString(payload, 'id') ?? '';
    const name = ownString(payload, 'name') ?? '';
    if (id === '' || name === '') return [];
    const input = Object.hasOwn(payload, 'input') ? payload['input'] : {};
    return [{ type: 'tool_use', id, name, input }];
  }
  if (
    type === 'agent.tool_result' ||
    type === 'agent.mcp_tool_result' ||
    type === 'user.tool_result' ||
    type === 'user.custom_tool_result'
  ) {
    const id = ownString(payload, 'tool_use_id') ?? ownString(payload, 'id') ?? '';
    if (id === '') return [];
    const content = Object.hasOwn(payload, 'content') ? payload['content'] : '';
    const isError = ownBoolean(payload, 'is_error') ?? ownBoolean(payload, 'isError') ?? false;
    return [{ type: 'tool_result', id, content, isError }];
  }
  return [];
}

/**
 * Map a core event onto this implementation's events.
 */
function coreEventToEvents(type: string, payload: unknown, state: AnthropicStreamState): ProviderEvent[] {
  if (!isRecord(payload)) return [];

  switch (type) {
    case 'message_start': {
      if (state.started) return [];
      state.started = true;
      const message = ownRecord(payload, 'message');
      const messageId = message !== undefined ? (ownString(message, 'id') ?? '') : (ownString(payload, 'id') ?? '');
      const model = message !== undefined ? (ownString(message, 'model') ?? '') : (ownString(payload, 'model') ?? '');
      const role = message !== undefined ? ownString(message, 'role') : ownString(payload, 'role');
      const usage = message !== undefined ? usageFromWire(message['usage']) : usageFromWire(payload['usage']);
      if (usage !== undefined) state.usage = usage;
      return [
        {
          type: 'message_start',
          messageId,
          model,
          ...(role !== undefined ? { role } : {}),
          ...(usage !== undefined ? { usage } : {}),
        },
      ];
    }
    case 'message_delta': {
      // **The usage in a `message_delta` is cumulative, not incremental**
      // (audit §2.2 and the research report's streaming note). It therefore
      // *replaces* the cumulative counter rather than being added to it — but
      // it replaces it **field-wise**: the wire's delta carries only
      // `output_tokens`, so the `input_tokens` the `message_start` reported
      // must survive the merge.
      const usage = usageFromWire(payload['usage']);
      if (usage !== undefined) {
        state.usage = { ...(state.usage ?? {}), ...usage };
      }
      const delta = ownRecord(payload, 'delta');
      if (delta !== undefined) {
        const stopReason = ownString(delta, 'stop_reason');
        if (stopReason !== undefined) state.stopReason = stopReasonFromWire(stopReason);
      }
      return [];
    }
    case 'message_stop': {
      const stopReason = state.stopReason ?? 'end_turn';
      const usage = state.usage;
      return [{ type: 'message_stop', stopReason, ...(usage !== undefined ? { usage } : {}) }];
    }
    case 'content_block_start': {
      const block = ownRecord(payload, 'content_block');
      if (block === undefined) return [];
      const blockType = ownString(block, 'type');
      const index = ownNumber(payload, 'index') ?? 0;
      if (blockType === 'tool_use') {
        const id = ownString(block, 'id') ?? '';
        const name = ownString(block, 'name') ?? '';
        const pending: PendingToolBlock = { id, name, json: '' };
        if (Object.hasOwn(block, 'input')) pending.input = block['input'];
        state.pendingTools.set(index, pending);
        return [];
      }
      return [];
    }
    case 'content_block_delta': {
      const index = ownNumber(payload, 'index') ?? 0;
      const delta = ownRecord(payload, 'delta');
      if (delta === undefined) return [];
      const deltaType = ownString(delta, 'type');
      if (deltaType === 'text_delta') {
        const text = ownString(delta, 'text');
        return text === undefined ? [] : [{ type: 'text_delta', text }];
      }
      if (deltaType === 'thinking_delta') {
        const text = ownString(delta, 'thinking');
        return text === undefined ? [] : [{ type: 'thinking_delta', text }];
      }
      if (deltaType === 'input_json_delta') {
        const pending = state.pendingTools.get(index);
        if (pending === undefined) return [];
        const partial = ownString(delta, 'partial_json');
        if (partial !== undefined) pending.json += partial;
        return [];
      }
      return [];
    }
    case 'content_block_stop': {
      const index = ownNumber(payload, 'index') ?? 0;
      const pending = state.pendingTools.get(index);
      if (pending === undefined) return [];
      state.pendingTools.delete(index);
      return [{ type: 'tool_use', id: pending.id, name: pending.name, input: toolInputOf(pending) }];
    }
    case 'message': {
      // A whole message delivered over SSE.
      return eventsFromMessage(payload);
    }
    case 'error': {
      return [errorEventFrom(payload)];
    }
    default:
      return [];
  }
}

/**
 * The input of a tool block: the block's own input when it carried one, else
 * the accumulated partial JSON.
 */
function toolInputOf(pending: PendingToolBlock): unknown {
  if (pending.input !== undefined) return pending.input;
  const trimmed = pending.json.trim();
  if (trimmed === '') return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

/**
 * The error event of a wire error payload.
 *
 * **Observed** (audit §2.2 and the plan's Step 8): the retryability is
 * derived from the status.
 */
export function errorEventFrom(payload: unknown): ProviderEvent {
  if (!isRecord(payload)) {
    return { type: 'error', message: 'unknown provider error', retryable: false };
  }
  const error = ownRecord(payload, 'error');
  const source = error ?? payload;
  const message = ownString(source, 'message') ?? 'unknown provider error';
  const explicitStatus = ownNumber(source, 'status');
  const status = explicitStatus ?? sseErrorTypeStatus(ownString(source, 'type'));
  const classification = classifyErrorStatus(status ?? 0, payload);
  return {
    type: 'error',
    message,
    ...(status !== undefined ? { status } : {}),
    retryable: status !== undefined ? classification.retryable : false,
  };
}

/**
 * The status a well-known SSE error type implies.
 */
export function sseErrorTypeStatus(type: string | undefined): number | undefined {
  switch (type) {
    case 'overloaded_error':
      return 529;
    case 'api_error':
      return 500;
    case 'rate_limit_error':
      return 429;
    case 'authentication_error':
      return 401;
    case 'permission_error':
      return 403;
    case 'not_found_error':
      return 404;
    case 'invalid_request_error':
      return 400;
    default:
      return undefined;
  }
}

/**
 * The events of a whole Anthropic message.
 *
 * Used by the non-streaming parser and by the SSE `message` event.
 */
export function eventsFromMessage(body: unknown): ProviderEvent[] {
  if (!isRecord(body)) {
    return [{ type: 'error', message: 'the provider returned a body that is not a JSON object', retryable: false }];
  }
  if (ownString(body, 'type') === 'error') {
    return [errorEventFrom(body)];
  }

  const usage = usageFromWire(body['usage']);
  const role = ownString(body, 'role');
  const events: ProviderEvent[] = [
    {
      type: 'message_start',
      messageId: ownString(body, 'id') ?? '',
      model: ownString(body, 'model') ?? '',
      ...(role !== undefined ? { role } : {}),
      ...(usage !== undefined ? { usage } : {}),
    },
  ];

  const content = ownArray(body, 'content');
  for (const block of content ?? []) {
    if (!isRecord(block)) continue;
    const blockType = ownString(block, 'type');
    if (blockType === 'text') {
      const text = ownString(block, 'text');
      if (text !== undefined) events.push({ type: 'text_delta', text });
      continue;
    }
    if (blockType === 'thinking') {
      const thinking = ownString(block, 'thinking');
      if (thinking !== undefined) events.push({ type: 'thinking_delta', text: thinking });
      continue;
    }
    if (blockType === 'tool_use') {
      events.push({
        type: 'tool_use',
        id: ownString(block, 'id') ?? '',
        name: ownString(block, 'name') ?? '',
        input: Object.hasOwn(block, 'input') ? block['input'] : {},
      });
      continue;
    }
  }

  const stopReason = stopReasonFromWire(ownString(body, 'stop_reason'));
  events.push({ type: 'message_stop', stopReason, ...(usage !== undefined ? { usage } : {}) });
  return events;
}

/**
 * The `messages` shape — a messages request and a streamed reply.
 *
 * The shape carries a system prompt beside the messages, the content of a
 * message as a list of blocks, and the credential in a header of its own. One
 * module, one code path; the provider's own quirks are data in the catalogue.
 *
 * See [`docs/protocol/MODEL-LAYER.md`](../../docs/protocol/MODEL-LAYER.md) §2.
 */

import { parseModelList } from '../entries.js';
import type { ContentPart, ModelMessage, ModelStreamEvent, ModelTool } from '../types.js';
import { createSseReader } from './sse.js';
import { joinEndpoint, type Dialect, type DialectRequest, type DialectRequestInput } from './types.js';

/** The version this shape speaks. */
export const MESSAGES_API_VERSION = '1';

/** How a content part is carried in this shape. */
function encodePart(part: ContentPart): Record<string, unknown> {
  if (part.type === 'text') return { type: 'text', text: part.text ?? '' };
  return {
    type: part.type,
    source: {
      type: 'base64',
      media_type: part.mediaType ?? 'application/octet-stream',
      data: part.data ?? '',
    },
  };
}

/** How a message's content is carried in this shape. */
function encodeContent(content: ModelMessage['content']): Record<string, unknown>[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map(encodePart);
}

/** How a tool is carried in this shape. */
function encodeTool(tool: ModelTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

/** The tool call a streamed reply is assembling. */
interface PartialCall {
  id: string;
  name: string;
  args: string;
}

/** Parse the arguments a streamed tool call carries. */
function parseArguments(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // A tool call whose arguments do not parse carries no arguments; the
    // call itself is still reported, so the caller can refuse it.
  }
  return {};
}

/** The `messages` shape. */
export const messagesDialect: Dialect = {
  name: 'messages',
  requestPath: '/messages',
  modelsPath: '/models',

  buildRequest(input: DialectRequestInput): DialectRequest {
    const system = input.messages
      .filter((message) => message.role === 'system')
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .join('\n\n');

    const body: Record<string, unknown> = {
      model: input.model.id,
      messages: input.messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({
          role: message.role,
          content: encodeContent(message.content),
          ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
        })),
      stream: true,
    };
    if (system !== '') body['system'] = system;
    if (input.tools && input.tools.length > 0) body['tools'] = input.tools.map(encodeTool);
    if (input.maxOutputTokens !== undefined) body['max_tokens'] = input.maxOutputTokens;
    if (input.temperature !== undefined) body['temperature'] = input.temperature;

    if (input.overlay.body) Object.assign(body, input.overlay.body);
    if (input.overlay.fields) Object.assign(body, input.overlay.fields);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-api-version': MESSAGES_API_VERSION,
      ...(input.provider.headers ?? {}),
    };
    if (input.credential) headers['x-api-key'] = input.credential.secret;
    if (input.overlay.headers) Object.assign(headers, input.overlay.headers);

    return {
      url: joinEndpoint(input.provider.endpoint, this.requestPath),
      method: 'POST',
      headers,
      body,
    };
  },

  createParser() {
    const reader = createSseReader();
    const calls = new Map<number, PartialCall>();
    let stopReason = 'stop';
    let finished = false;

    const consume = (event: { event?: string; data: string }): readonly ModelStreamEvent[] => {
      const events: ModelStreamEvent[] = [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return events;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return events;
      const record = parsed as Record<string, unknown>;
      const type = typeof record['type'] === 'string' ? record['type'] : event.event;

      switch (type) {
        case 'message_start': {
          const message = record['message'];
          if (typeof message === 'object' && message !== null) {
            const usage = (message as Record<string, unknown>)['usage'];
            if (typeof usage === 'object' && usage !== null) {
              const usageRecord = usage as Record<string, unknown>;
              const inputTokens =
                typeof usageRecord['input_tokens'] === 'number' ? usageRecord['input_tokens'] : 0;
              events.push({ type: 'usage', usage: { inputTokens, outputTokens: 0 } });
            }
          }
          break;
        }
        case 'content_block_start': {
          const index = typeof record['index'] === 'number' ? record['index'] : 0;
          const block = record['content_block'];
          if (typeof block === 'object' && block !== null) {
            const blockRecord = block as Record<string, unknown>;
            if (blockRecord['type'] === 'tool_use') {
              calls.set(index, {
                id: typeof blockRecord['id'] === 'string' ? blockRecord['id'] : '',
                name: typeof blockRecord['name'] === 'string' ? blockRecord['name'] : '',
                args: '',
              });
            }
          }
          break;
        }
        case 'content_block_delta': {
          const index = typeof record['index'] === 'number' ? record['index'] : 0;
          const delta = record['delta'];
          if (typeof delta === 'object' && delta !== null) {
            const deltaRecord = delta as Record<string, unknown>;
            const deltaType = deltaRecord['type'];
            if (deltaType === 'text_delta') {
              const text = deltaRecord['text'];
              if (typeof text === 'string' && text !== '') events.push({ type: 'text', text });
            } else if (deltaType === 'input_json_delta') {
              const partial = deltaRecord['partial_json'];
              const existing = calls.get(index) ?? { id: '', name: '', args: '' };
              if (typeof partial === 'string') {
                calls.set(index, { ...existing, args: existing.args + partial });
              }
            }
          }
          break;
        }
        case 'content_block_stop': {
          const index = typeof record['index'] === 'number' ? record['index'] : 0;
          const call = calls.get(index);
          if (call) {
            calls.delete(index);
            events.push({
              type: 'tool-call',
              call: { id: call.id, name: call.name, arguments: parseArguments(call.args) },
            });
          }
          break;
        }
        case 'message_delta': {
          const delta = record['delta'];
          if (typeof delta === 'object' && delta !== null) {
            const stop = (delta as Record<string, unknown>)['stop_reason'];
            if (typeof stop === 'string' && stop !== '') stopReason = stop;
          }
          const usage = record['usage'];
          if (typeof usage === 'object' && usage !== null) {
            const usageRecord = usage as Record<string, unknown>;
            const outputTokens =
              typeof usageRecord['output_tokens'] === 'number' ? usageRecord['output_tokens'] : 0;
            events.push({ type: 'usage', usage: { inputTokens: 0, outputTokens } });
          }
          break;
        }
        case 'message_stop': {
          for (const [index, call] of calls) {
            events.push({
              type: 'tool-call',
              call: { id: call.id, name: call.name, arguments: parseArguments(call.args) },
            });
            calls.delete(index);
          }
          events.push({ type: 'end', stopReason });
          finished = true;
          break;
        }
        default:
          break;
      }
      return events;
    };

    return {
      push(chunk: string): readonly ModelStreamEvent[] {
        if (finished) return [];
        const events: ModelStreamEvent[] = [];
        for (const event of reader.push(chunk)) events.push(...consume(event));
        return events;
      },
      end(): readonly ModelStreamEvent[] {
        if (finished) return [];
        const events: ModelStreamEvent[] = [];
        for (const event of reader.end()) events.push(...consume(event));
        if (events.length === 0) {
          for (const [index, call] of calls) {
            events.push({
              type: 'tool-call',
              call: { id: call.id, name: call.name, arguments: parseArguments(call.args) },
            });
            calls.delete(index);
          }
          events.push({ type: 'end', stopReason });
        }
        finished = true;
        return events;
      },
    };
  },

  parseModels(payload: unknown, provider: string) {
    return parseModelList(payload, provider);
  },
};

/**
 * The `responses` shape — a response-oriented request and a streamed reply.
 *
 * The shape carries the turn's input as a list of items, and the reply as a
 * sequence of named deltas. One module, one code path.
 *
 * See [`docs/protocol/MODEL-LAYER.md`](../../docs/protocol/MODEL-LAYER.md) §2.
 */

import { parseModelList } from '../entries.js';
import { mergeOwn } from '../merge.js';
import type { ContentPart, ModelMessage, ModelStreamEvent, ModelTool } from '../types.js';
import { createSseReader } from './sse.js';
import { joinEndpoint, type Dialect, type DialectRequest, type DialectRequestInput } from './types.js';

/** How a content part is carried in this shape. */
function encodePart(part: ContentPart): Record<string, unknown> {
  if (part.type === 'text') return { type: 'input_text', text: part.text ?? '' };
  const mediaType = part.mediaType ?? 'application/octet-stream';
  return {
    type: 'input_image',
    image_url: `data:${mediaType};base64,${part.data ?? ''}`,
  };
}

/** How a message's content is carried in this shape. */
function encodeContent(content: ModelMessage['content']): Record<string, unknown>[] {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  return content.map(encodePart);
}

/** The text of a message's content, whatever shape it carries. */
function textOf(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
}

/**
 * How a message is carried in this shape.
 *
 * A tool's answer travels as an output item, and an assistant's tool calls
 * travel as call items beside the text.
 */
function encodeItem(message: ModelMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      type: 'function_call_output',
      call_id: message.toolCallId ?? '',
      output: textOf(message.content),
    };
  }
  const content = encodeContent(message.content);
  if (message.role === 'assistant' && message.toolCalls) {
    for (const call of message.toolCalls) {
      content.push({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      });
    }
  }
  return { role: message.role, content };
}

/** How a tool is carried in this shape. */
function encodeTool(tool: ModelTool): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
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

/** The `responses` shape. */
export const responsesDialect: Dialect = {
  name: 'responses',
  requestPath: '/responses',
  modelsPath: '/models',

  buildRequest(input: DialectRequestInput): DialectRequest {
    const body: Record<string, unknown> = {
      model: input.model.id,
      input: input.messages.map(encodeItem),
      stream: true,
    };
    if (input.tools && input.tools.length > 0) body['tools'] = input.tools.map(encodeTool);
    if (input.maxOutputTokens !== undefined) body['max_output_tokens'] = input.maxOutputTokens;
    if (input.temperature !== undefined) body['temperature'] = input.temperature;

    if (input.overlay.body) mergeOwn(body, input.overlay.body);
    if (input.overlay.fields) mergeOwn(body, input.overlay.fields);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(input.provider.headers ?? {}),
    };
    if (input.credential) headers['authorization'] = `Bearer ${input.credential.secret}`;
    if (input.overlay.headers) mergeOwn(headers, input.overlay.headers);

    return {
      url: joinEndpoint(input.provider.endpoint, this.requestPath),
      method: 'POST',
      headers,
      body,
    };
  },

  createParser() {
    const reader = createSseReader();
    const calls = new Map<string, PartialCall>();
    let stopReason = 'stop';
    let finished = false;

    const flush = (events: ModelStreamEvent[]): void => {
      for (const [id, call] of calls) {
        events.push({
          type: 'tool-call',
          call: { id: call.id, name: call.name, arguments: parseArguments(call.args) },
        });
        calls.delete(id);
      }
    };

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
        case 'response.output_text.delta': {
          const delta = record['delta'];
          if (typeof delta === 'string' && delta !== '') events.push({ type: 'text', text: delta });
          break;
        }
        case 'response.output_item.added': {
          const item = record['item'];
          if (typeof item === 'object' && item !== null) {
            const itemRecord = item as Record<string, unknown>;
            if (itemRecord['type'] === 'function_call') {
              const id =
                typeof itemRecord['call_id'] === 'string'
                  ? itemRecord['call_id']
                  : typeof itemRecord['id'] === 'string'
                    ? itemRecord['id']
                    : '';
              calls.set(id, {
                id,
                name: typeof itemRecord['name'] === 'string' ? itemRecord['name'] : '',
                args: '',
              });
            }
          }
          break;
        }
        case 'response.function_call_arguments.delta': {
          const itemId = typeof record['item_id'] === 'string' ? record['item_id'] : '';
          const delta = record['delta'];
          const existing = calls.get(itemId) ?? { id: itemId, name: '', args: '' };
          if (typeof delta === 'string') {
            calls.set(itemId, { ...existing, args: existing.args + delta });
          }
          break;
        }
        case 'response.function_call_arguments.done': {
          const itemId = typeof record['item_id'] === 'string' ? record['item_id'] : '';
          const call = calls.get(itemId);
          if (call) {
            calls.delete(itemId);
            events.push({
              type: 'tool-call',
              call: { id: call.id, name: call.name, arguments: parseArguments(call.args) },
            });
          }
          break;
        }
        case 'response.completed': {
          flush(events);
          const response = record['response'];
          if (typeof response === 'object' && response !== null) {
            const usage = (response as Record<string, unknown>)['usage'];
            if (typeof usage === 'object' && usage !== null) {
              const usageRecord = usage as Record<string, unknown>;
              const inputTokens =
                typeof usageRecord['input_tokens'] === 'number' ? usageRecord['input_tokens'] : 0;
              const outputTokens =
                typeof usageRecord['output_tokens'] === 'number'
                  ? usageRecord['output_tokens']
                  : 0;
              events.push({ type: 'usage', usage: { inputTokens, outputTokens } });
            }
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
          flush(events);
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

/**
 * The `chat` shape — a chat-completions request and a streamed reply.
 *
 * One module, one code path. The provider's own quirks — the parameter names
 * it wants, the fields it refuses — are layered on top as **data**, in the
 * catalogue, and never as a branch here.
 *
 * See [`docs/protocol/MODEL-LAYER.md`](../../docs/protocol/MODEL-LAYER.md) §2.
 */

import { parseModelList } from '../entries.js';
import type { ContentPart, ModelMessage, ModelStreamEvent, ModelTool } from '../types.js';
import { createSseReader } from './sse.js';
import { joinEndpoint, type Dialect, type DialectRequest, type DialectRequestInput } from './types.js';

/** How a content part is carried in this shape. */
function encodePart(part: ContentPart): Record<string, unknown> {
  if (part.type === 'text') return { type: 'text', text: part.text ?? '' };
  const mediaType = part.mediaType ?? 'application/octet-stream';
  return {
    type: 'image_url',
    image_url: { url: `data:${mediaType};base64,${part.data ?? ''}` },
  };
}

/** How a message's content is carried in this shape. */
function encodeContent(content: ModelMessage['content']): string | Record<string, unknown>[] {
  if (typeof content === 'string') return content;
  return content.map(encodePart);
}

/** How a tool is carried in this shape. */
function encodeTool(tool: ModelTool): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
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

/** The `chat` shape. */
export const chatDialect: Dialect = {
  name: 'chat',
  requestPath: '/chat/completions',
  modelsPath: '/models',

  buildRequest(input: DialectRequestInput): DialectRequest {
    const body: Record<string, unknown> = {
      model: input.model.id,
      messages: input.messages.map((message) => ({
        role: message.role,
        content: encodeContent(message.content),
        ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
        ...(message.toolCalls === undefined
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            }),
      })),
      stream: true,
    };
    if (input.tools && input.tools.length > 0) body['tools'] = input.tools.map(encodeTool);
    if (input.maxOutputTokens !== undefined) body['max_tokens'] = input.maxOutputTokens;
    if (input.temperature !== undefined) body['temperature'] = input.temperature;

    // The overlay's own contribution is merged over the shape's body.
    if (input.overlay.body) Object.assign(body, input.overlay.body);
    if (input.overlay.fields) Object.assign(body, input.overlay.fields);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(input.provider.headers ?? {}),
    };
    if (input.credential) headers['authorization'] = `Bearer ${input.credential.secret}`;
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

    const flush = (events: ModelStreamEvent[]): void => {
      for (const [index, call] of calls) {
        events.push({
          type: 'tool-call',
          call: { id: call.id, name: call.name, arguments: parseArguments(call.args) },
        });
        calls.delete(index);
      }
    };

    const consume = (payload: string): readonly ModelStreamEvent[] => {
      const events: ModelStreamEvent[] = [];
      if (payload === '[DONE]') {
        flush(events);
        finished = true;
        events.push({ type: 'end', stopReason });
        return events;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return events;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return events;
      const record = parsed as Record<string, unknown>;

      const choices = record['choices'];
      if (Array.isArray(choices)) {
        for (const choice of choices) {
          if (typeof choice !== 'object' || choice === null) continue;
          const choiceRecord = choice as Record<string, unknown>;
          const delta = choiceRecord['delta'];
          if (typeof delta === 'object' && delta !== null) {
            const deltaRecord = delta as Record<string, unknown>;
            const content = deltaRecord['content'];
            if (typeof content === 'string' && content !== '') {
              events.push({ type: 'text', text: content });
            }
            const toolCalls = deltaRecord['tool_calls'];
            if (Array.isArray(toolCalls)) {
              for (const entry of toolCalls) {
                if (typeof entry !== 'object' || entry === null) continue;
                const call = entry as Record<string, unknown>;
                const index = typeof call['index'] === 'number' ? call['index'] : calls.size;
                const existing = calls.get(index) ?? { id: '', name: '', args: '' };
                const id = typeof call['id'] === 'string' ? call['id'] : existing.id;
                const fn = call['function'];
                let name = existing.name;
                let args = existing.args;
                if (typeof fn === 'object' && fn !== null) {
                  const fnRecord = fn as Record<string, unknown>;
                  if (typeof fnRecord['name'] === 'string') name = fnRecord['name'];
                  if (typeof fnRecord['arguments'] === 'string') args += fnRecord['arguments'];
                }
                calls.set(index, { id, name, args });
              }
            }
          }
          const finish = choiceRecord['finish_reason'];
          if (typeof finish === 'string' && finish !== '') {
            stopReason = finish;
            flush(events);
          }
        }
      }

      const usage = record['usage'];
      if (typeof usage === 'object' && usage !== null) {
        const usageRecord = usage as Record<string, unknown>;
        const inputTokens =
          typeof usageRecord['prompt_tokens'] === 'number' ? usageRecord['prompt_tokens'] : 0;
        const outputTokens =
          typeof usageRecord['completion_tokens'] === 'number'
            ? usageRecord['completion_tokens']
            : 0;
        events.push({ type: 'usage', usage: { inputTokens, outputTokens } });
      }
      return events;
    };

    return {
      push(chunk: string): readonly ModelStreamEvent[] {
        if (finished) return [];
        const events: ModelStreamEvent[] = [];
        for (const event of reader.push(chunk)) events.push(...consume(event.data));
        return events;
      },
      end(): readonly ModelStreamEvent[] {
        if (finished) return [];
        const events: ModelStreamEvent[] = [];
        for (const event of reader.end()) events.push(...consume(event.data));
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

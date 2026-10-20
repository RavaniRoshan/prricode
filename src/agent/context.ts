/**
 * The turn context: the provider request the runtime builds, the conversation it
 * carries, and the context a tool call runs in.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.1 (Providers and model
 * catalogs), §2.2 (Provider request construction), §2.4 (Agent loop and tool
 * dispatch) and §2.6 (Sessions, persistence, and resumption), and the `CC-010`
 * milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## The request is the Anthropic-shaped one
 *
 * Every route of the target speaks an **Anthropic-shaped** protocol (audit
 * §2.1), so the request the runtime builds is the public Messages shape:
 * `model`, `max_tokens`, `messages`, `system`, `tools` and `stream`. The
 * **tools** come from the registry — the model may only call what the registry
 * holds — and each tool's JSON Schema is the schema the model sees.
 *
 * ## The transport seam
 *
 * `ProviderDriver` builds a request; it does not **send** one. The target's
 * client owns the transport, and this implementation's transport is not part of this
 * milestone. The seam is therefore explicit: a **turn source** is anything that
 * turns a request into a stream of provider events. A driver that carries a
 * `send` member *is* a turn source, and a caller may also supply one directly.
 *
 * ## The conversation is the transcript
 *
 * The conversation the runtime sends is **projected from the session
 * transcript**: the records the store holds are turned into the messages of the
 * request with the resume module's own projection (`projectContext` and
 * `contextToProviderMessages`). The transcript is therefore the single source of
 * truth, and a turn that starts in a fresh process sees the same history a turn
 * that starts in the middle of one does.
 *
 * A tool call that was **refused** never produced a result, so its `tool_use`
 * block has no answer. An unanswered `tool_use` would make the next request
 * invalid, so the projection drops it — the refusal is in the transcript as a
 * `permission_request` record, which is not part of the conversation.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The **output-token budget** a request asks for when the caller does not
 *     name one.
 *   - The **system prompt**: the runtime sends none unless the caller supplies
 *     one.
 *   - The way a tool result's **content** is carried into the request: a string
 *     is carried as it is, and anything else is carried as its JSON
 *     serialization, because the wire shape accepts a string or a list of
 *     content blocks and not an arbitrary value.
 */

import type { ToolContext } from '../permissions/decision.js';
import type {
  ProviderContentBlock,
  ProviderDriver,
  ProviderEvent,
  ProviderMessage,
  ProviderRequest,
  ProviderTool,
} from '../provider/drivers/types.js';
import { contextToProviderMessages, projectContext, type ContextItem } from '../session/resume.js';
import type { SessionEvent } from '../session/event.js';
import type { ToolRegistry } from '../tools/registry.js';

import type { ToolCall } from './dispatch.js';

/* -------------------------------------------------------------------------- */
/* The transport seam                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Anything that turns a provider request into a stream of provider events.
 *
 * The `ProviderDriver` interface builds a request — its URL, its headers, its
 * body and its parser — but the **transport** is the part that sends it. This
 * is that seam, and it is where the abort signal enters: a source that honours
 * the signal stops producing events when it fires.
 */
export interface ProviderTurnSource {
  /** Send a request and yield the events of the turn. */
  send(request: ProviderRequest, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
}

/**
 * A driver that can also send.
 *
 * The plan fixes `createAgentRuntime`'s `driver` member as a `ProviderDriver`,
 * so the extra member is optional: a driver that carries it is used as the turn
 * source, and a driver that does not is used for everything else it is good for.
 */
export interface StreamingProviderDriver extends ProviderDriver {
  /** Send a request and yield the events of the turn. */
  send(request: ProviderRequest, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
}

/**
 * The turn source of a driver, when the driver is one.
 *
 * The member name is fixed (`send`), so the lookup is a plain read of a known
 * member rather than a lookup of a caller-supplied key: no `Object.hasOwn`
 * guard is needed, and none of the `Object.prototype` hazards apply.
 */
export function streamingSourceOf(driver: ProviderDriver): ProviderTurnSource | undefined {
  const candidate = (driver as { send?: unknown }).send;
  if (typeof candidate !== 'function') return undefined;
  return driver as unknown as ProviderTurnSource;
}

/* -------------------------------------------------------------------------- */
/* The request                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The tools the model may call.
 *
 * The set is the registry's: a model-generated action never reaches the machine
 * without being registered, so the model is offered exactly the tools the
 * registry holds.
 */
export function buildProviderTools(registry: ToolRegistry): ProviderTool[] {
  return registry.list().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object' },
  }));
}

/** The options a request is built with. */
export interface ProviderRequestOptions {
  /** The model the request names. */
  model: string;
  /** The output-token budget the request asks for. */
  maxTokens: number;
  /** The conversation the request carries. */
  messages: ProviderMessage[];
  /** The tools the request offers. */
  tools: ProviderTool[];
  /** The system prompt, when the caller supplies one. */
  system?: string;
}

/**
 * Build the provider request of a turn.
 *
 * The request is a **streaming** one: the target's agent turn is a streaming
 * `beta.messages.create` (audit §2.4), and the events of the turn are what the
 * runtime consumes.
 */
export function buildProviderRequest(options: ProviderRequestOptions): ProviderRequest {
  const request: ProviderRequest = {
    model: options.model,
    maxTokens: options.maxTokens,
    messages: options.messages,
    tools: options.tools,
    stream: true,
  };
  if (options.system !== undefined) request.system = options.system;
  return request;
}

/* -------------------------------------------------------------------------- */
/* The conversation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The conversation of a session, projected from its transcript.
 *
 * The projection is the resume module's: a `user_message` becomes a user
 * message, an `assistant_message` and the `tool_call` records that follow it
 * become one assistant message, and the `tool_result` records become the user
 * message that carries the results. The raw stream, the permission log and the
 * boundary markers are not part of the conversation.
 */
export function conversationFromEvents(events: SessionEvent[]): ProviderMessage[] {
  const context = projectContext(events);
  dropUnansweredToolUses(context);
  return contextToProviderMessages(context);
}

/**
 * Drop the `tool_use` blocks that no `tool_result` answers.
 *
 * A call that was **refused** produced no result, and a request that carries
 * an unanswered tool call is not a well-formed request. The refusal itself is
 * in the transcript as a `permission_request` record.
 */
export function dropUnansweredToolUses(context: ContextItem[]): void {
  const answered = new Set<string>();
  for (const item of context) {
    if (item.type !== 'message') continue;
    for (const block of item.blocks) {
      if (block.type === 'tool_result') answered.add(block.toolUseId);
    }
  }
  for (const item of context) {
    if (item.type !== 'message') continue;
    item.blocks = item.blocks.filter(
      (block) => !(block.type === 'tool_use' && !answered.has(block.id)),
    );
  }
}

/**
 * The content blocks of a message's content.
 *
 * A message's content is either a string or a list of blocks; the blocks are
 * what a merge needs.
 */
export function toContentBlocks(content: string | ProviderContentBlock[]): ProviderContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [...content];
}

/**
 * Add a user turn to the conversation.
 *
 * Two user messages in a row are **merged** into one: the tool results of a
 * turn and the next prompt are both the user's side of the conversation, and a
 * request that carries them as two messages is not well-formed.
 */
export function pushUserText(messages: ProviderMessage[], text: string): void {
  const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
  if (last !== undefined && last.role === 'user') {
    last.content = [...toContentBlocks(last.content), { type: 'text', text }];
    return;
  }
  messages.push({ role: 'user', content: text });
}

/**
 * Add an assistant turn to the conversation.
 *
 * The blocks are the text the assistant produced and the tool calls it made.
 */
export function pushAssistant(messages: ProviderMessage[], blocks: ProviderContentBlock[]): void {
  if (blocks.length === 0) return;
  messages.push({ role: 'assistant', content: blocks });
}

/**
 * Add the tool results of a turn to the conversation.
 *
 * The results are a **user** message: the target's transcript carries them as
 * one, and the model's tool calls are answered by the user side of the
 * conversation.
 */
export function pushToolResults(messages: ProviderMessage[], blocks: ProviderContentBlock[]): void {
  if (blocks.length === 0) return;
  messages.push({ role: 'user', content: blocks });
}

/**
 * The content block that carries a tool result into the request.
 *
 * The content is carried as a string when it is one, and as its JSON
 * serialization otherwise: the wire shape accepts a string or a list of content
 * blocks, and not an arbitrary value.
 */
export function toolResultBlock(
  toolUseId: string,
  content: unknown,
  isError: boolean,
): ProviderContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: contentForWire(content),
    is_error: isError,
  };
}

/** The wire form of a tool result's content. */
function contentForWire(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (content === undefined) return '';
  try {
    const serialized = JSON.stringify(content);
    return serialized === undefined ? String(content) : serialized;
  } catch {
    return String(content);
  }
}

/* -------------------------------------------------------------------------- */
/* The tool context                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The context a tool call runs in.
 *
 * The context names the tool, the input, the tool-use id the result answers,
 * and the session the call belongs to.
 */
export function toolContextFor(call: ToolCall, sessionId: string): ToolContext {
  return {
    toolName: call.name,
    input: call.input,
    toolUseId: call.id,
    sessionId,
  };
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Whether a value is a plain object (not an array, not `null`). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

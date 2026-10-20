/**
 * The hook surface's schemas: the event classification, the payload the hooks
 * receive, and the JSON a hook writes back.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("Hook outputs",
 * "Hook event matrix") and `docs/compatibility/extension-surface.md` ("The
 * exit-code contract"), and the `CC-012` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * The **matcher** lives in its own module (`./matcher.js`): it is a regular
 * expression engine, and it is the only part of the hook surface that has to
 * reason about untrusted text. Its public surface is re-exported here, so a
 * consumer of the schema module still finds `matchToolName` where it was.
 *
 * The event classification lives here rather than in the registry because the
 * **runner** needs it as a value: the runner decides whether an exit code of
 * `2` blocks, and a value import from the registry would make the two modules
 * depend on each other at run time.
 *
 * ## The payload
 *
 * The payload the target hands a hook carries `session_id`, `prompt_id`,
 * `transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode`, `effort.level`
 * and `hook_event_name`, plus `agent_id` and `agent_type` for a subagent. The
 * payload is written to the hook's standard input as one JSON document.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - **The payload is built from the caller's input and the context**, and the
 *     context wins for the common fields. The caller's input keeps every key
 *     it brought, because the event-specific fields (`tool_name`, `tool_input`,
 *     the prompt, the MCP server name) live there.
 *   - **A `__proto__` key in the caller's input is dropped.** Copying it into
 *     the payload would set the payload's prototype, and the payload is JSON
 *     that a hook reads.
 *   - **The `permission_mode` in the payload is the normalized six.** The
 *     `manual` alias of `default` is normalized to `default`, so the payload
 *     never carries an alias that is not one of the six modes. A value that
 *     names none of the six — the caller's input is untrusted data — is
 *     **refused**: the payload does not carry a mode at all rather than
 *     carrying one that is not a mode.
 *   - **The blockable events are the eleven decision-capable events plus
 *     `PermissionRequest`** — twelve in all. The audit records
 *     `PermissionRequest` as carrying a decision of its own, so this implementation
 *     treats an exit code of `2` there as a block.
 *   - **The JSON a hook writes is read tolerantly.** A hook that writes
 *     something that is not JSON contributes nothing; it is not an error.
 */

import { normalizePermissionMode, type PermissionMode } from '../../permissions/decision.js';
import type { HookEvent, HookHandlerType, HookSpec } from './registry.js';

/**
 * The events on which a hook's exit code `2` **blocks**.
 *
 * A blockable event is one where a block has a meaning: the tool call is
 * refused, the prompt is refused, or the turn does not stop. On every other
 * event an exit code of `2` is a non-blocking error, because there is nothing
 * to block.
 *
 * The set is the decision-capable events plus `PermissionRequest`, which the
 * audit records as carrying a decision of its own — a **implementation choice** of
 * twelve events, and this implementation labels it as such.
 */
export const BLOCKABLE_EVENTS: readonly HookEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PermissionDenied',
  'PermissionRequest',
];

/** Whether an exit code of `2` blocks on an event. */
export function isBlockableEvent(event: HookEvent): boolean {
  return BLOCKABLE_EVENTS.includes(event);
}

/**
 * The events that fire **before** the session's MCP servers are available.
 *
 * An `mcp_tool` hook is skipped there: the server it names cannot be called
 * yet.
 */
export const EVENTS_WITHOUT_MCP_SERVERS: readonly HookEvent[] = ['SessionStart', 'Setup'];

/** Whether the session's MCP servers are available at an event. */
export function mcpServersAvailable(event: HookEvent): boolean {
  return !EVENTS_WITHOUT_MCP_SERVERS.includes(event);
}

/**
 * The **effective** handler type of a hook.
 *
 * `handlerType` carries the handler kind when it is present, and the plan's
 * `type` carries it otherwise. The two are never read for different purposes:
 * the runner dispatches the hook by this value, and the registry indexes it by
 * server the same way.
 */
export function effectiveHandlerType(spec: HookSpec): HookHandlerType {
  return spec.handlerType ?? spec.type ?? 'command';
}

/**
 * The matcher, re-exported.
 *
 * The matcher is its own module, and the schema module is where a consumer
 * of the hook surface has always found it.
 */
export {
  MAX_MATCH_INPUT_LENGTH,
  MAX_MATCH_NODES,
  MAX_MATCH_PATTERN_LENGTH,
  MAX_MATCH_REPEAT,
  MatcherError,
  compileMatcher,
  isInputWithinBound,
  matchToolName,
  type CompiledMatcher,
  type MatcherCompilation,
} from './matcher.js';

/**
 * The permission modes the payload carries.
 *
 * The six modes, without the `manual` alias of `default`: the payload
 * carries a **normalized** mode.
 */
export type HookPermissionMode = Exclude<PermissionMode, 'manual'>;

/** The six modes the payload carries. */
const HOOK_PERMISSION_MODES: ReadonlySet<string> = new Set<string>([
  'default',
  'plan',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
]);

/**
 * Whether a value names one of the six modes.
 *
 * The `manual` alias is **not** one of the six: it is the UI label of
 * `default`, and it is normalized away before the payload carries it.
 */
export function isHookPermissionMode(value: unknown): value is HookPermissionMode {
  return typeof value === 'string' && HOOK_PERMISSION_MODES.has(value);
}

/**
 * The context a hook payload is built from.
 *
 * The members are the ones the target's payload carries, in the target's
 * snake_case spelling.
 */
export interface HookContext {
  /** The session the hook runs in. */
  session_id?: string;
  /** The prompt the hook runs for. */
  prompt_id?: string;
  /** The transcript of the session. */
  transcript_path?: string;
  /** The working directory. */
  cwd?: string;
  /** The scratchpad directory of the session. */
  scratchpad_dir?: string;
  /** The session's permission mode; the `manual` alias is normalized away. */
  permission_mode?: PermissionMode;
  /** The effort level of the session. */
  effort?: { level?: string };
  /** The subagent the hook runs for. */
  agent_id?: string;
  /** The subagent's type. */
  agent_type?: string;
}

/** The payload a hook receives on its standard input. */
export interface HookPayload {
  /** The session the hook runs in. */
  session_id?: string;
  /** The prompt the hook runs for. */
  prompt_id?: string;
  /** The transcript of the session. */
  transcript_path?: string;
  /** The working directory. */
  cwd?: string;
  /** The scratchpad directory of the session. */
  scratchpad_dir?: string;
  /** The session's permission mode — one of the six, never the `manual` alias. */
  permission_mode?: HookPermissionMode;
  /** The effort level of the session. */
  effort?: { level?: string };
  /** The event the hook runs for. */
  hook_event_name: HookEvent;
  /** The subagent the hook runs for. */
  agent_id?: string;
  /** The subagent's type. */
  agent_type?: string;
  /** The event-specific fields the caller supplied. */
  [key: string]: unknown;
}

/** The common fields of the payload. */
const CONTEXT_FIELDS = [
  'session_id',
  'prompt_id',
  'transcript_path',
  'cwd',
  'scratchpad_dir',
  'permission_mode',
  'effort',
  'agent_id',
  'agent_type',
] as const;

/** Whether a value is a plain object. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a field of a plain object.
 *
 * The field names come from the caller, so the lookup is guarded: an inherited
 * member of `Object.prototype` is never read as if it were the caller's data.
 */
export function readField(record: Record<string, unknown>, field: string): unknown {
  if (!Object.hasOwn(record, field)) return undefined;
  return record[field];
}

/**
 * Build the payload of a hook.
 *
 * The caller's input keeps every key it brought — the event-specific fields
 * live there — and the context wins for the common fields. The event name is
 * always the payload's `hook_event_name`, and the permission mode is
 * **normalized**: the payload carries one of the six modes, never the
 * `manual` alias and never a value that names no mode at all.
 */
export function buildHookPayload(
  event: HookEvent,
  input: unknown,
  context?: HookContext,
): HookPayload {
  const payload: Record<string, unknown> = {};

  if (isPlainObject(input)) {
    for (const key of Object.keys(input)) {
      // `__proto__` is never copied: it would set the payload's prototype.
      if (key === '__proto__') continue;
      payload[key] = input[key];
    }
  }

  if (context) {
    const record = context as unknown as Record<string, unknown>;
    for (const field of CONTEXT_FIELDS) {
      if (!Object.hasOwn(record, field)) continue;
      const value = record[field];
      if (value === undefined) continue;
      payload[field] = value;
    }
  }

  // The payload carries the **normalized** mode: `manual` is the UI label of
  // `default`, not a mode of its own.
  const mode = payload['permission_mode'];
  if (typeof mode === 'string') {
    payload['permission_mode'] = normalizePermissionMode(mode as PermissionMode);
  }

  // The payload carries **one of the six** modes, and only one of them. The
  // caller's input is untrusted data, so the guarantee cannot be a type
  // claim alone: a value that names none of the six is **refused**, and the
  // payload does not carry a mode at all.
  if (!isHookPermissionMode(payload['permission_mode'])) {
    delete payload['permission_mode'];
  }

  payload['hook_event_name'] = event;
  return payload as HookPayload;
}

/**
 * The text a matcher is matched against.
 *
 * For the tool events it is the **tool name**; for `Elicitation` and
 * `ElicitationResult` it is the **MCP server name**.
 */
export function matcherSubject(event: HookEvent, payload: HookPayload): string | undefined {
  const record = payload as unknown as Record<string, unknown>;
  if (event === 'Elicitation' || event === 'ElicitationResult') {
    return firstString(record, ['mcp_server_name', 'server_name', 'server']);
  }
  return firstString(record, ['tool_name']);
}

function firstString(record: Record<string, unknown>, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = readField(record, field);
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

// --- the JSON a hook writes ------------------------------------------------------

/**
 * The JSON a hook writes to its standard output.
 *
 * The shape is read tolerantly: a member of the wrong type is ignored.
 */
export interface HookJsonOutput {
  /** Whether the session should continue. */
  continue?: boolean;
  /** The reason the session stopped. */
  stopReason?: string;
  /** A message for the user. */
  systemMessage?: string;
  /** Extra context for the model. */
  additionalContext?: string;
  /** Whether the agent should retry. */
  retry?: boolean;
  /** The decision, as an object or as a word. */
  decision?: unknown;
  /** The rewritten tool input. */
  updatedInput?: unknown;
  /** The paths the hook wants to watch. */
  watchPaths?: unknown;
  /** The permissions the hook wants to change. */
  updatedPermissions?: unknown;
  /** The severity of a failure. */
  severity?: unknown;
  /** The event-specific output. */
  hookSpecificOutput?: unknown;
}

/**
 * Parse the JSON a hook wrote.
 *
 * A hook that writes nothing, or writes something that is not a JSON object,
 * contributes nothing: it is not an error.
 */
export function parseHookOutput(text: string): HookJsonOutput | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  return parsed as HookJsonOutput;
}

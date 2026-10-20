/**
 * The resume algorithm: which part of a transcript a session continues from, and
 * what that part is.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.6 (Sessions,
 * persistence, and resumption) and the `CC-009` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## The target's resume is not a file replay
 *
 * The plan's design note records the target's shape: "it indexes messages by id,
 * selects the newest leaf, and walks the parent chain backwards, then applies
 * projections (compaction boundary, preserved segments, content replacements).
 * File order is write order only; dead branches from a rewind stay in the file
 * and are pruned."
 *
 * The audit is careful about the evidence: the resume algorithm is **partial**
 * — "the exact `--resume` / `--continue` selection algorithm, the session-row
 * index, and the transcript replay path were not traced to resolved relations".
 * This implementation therefore implements the **shape** the plan describes and does not
 * claim that the target's selection rule is verified.
 *
 * ## The three rules this module implements
 *
 *   1. **The branch.** The events are indexed by id; the *newest leaf* is
 *      selected; the parent chain is walked backwards. The newest leaf is the
 *      leaf with the greatest timestamp, and a tie is won by the one written
 *      last — **not** the last line in the file. That difference is observable:
 *      a user who rewinds and then resumes must see the rewound branch, not the
 *      branch that was written last. A log that carries no parent links is one
 *      chain, and the reader falls back to file order for it.
 *   2. **The resume point.** The last assistant message that contains a
 *      `tool_use`, falling back to the last message overall.
 *   3. **The interrupted turn.** The message list is walked **backward** from the
 *      end, collecting the `tool_use_id` of every `tool_result` seen in a `user`
 *      message; the walk continues over assistant messages, and if a message's
 *      `tool_use` blocks carry an id that is not in the collected set, the
 *      session ends with an unanswered tool call.
 *
 * ## The projections
 *
 *   - **The compaction boundary** is a marker, not a deletion: the pre-compact
 *     prefix is **skipped** when the session is read, and the summary replaces
 *     it in the context. The prefix is still in the file.
 *   - **The content replacement** is applied on resume, so the payload of an
 *     oversized tool result does not come back into the context.
 *
 * ## What is *not* claimed
 *
 * The target's boundary model is *inference* — third-party analysis of the
 * target's transcript format, not the pinned binary (Global Constraints). The
 * boundary this module implements is the **implementation's own design**, and this header
 * says so rather than claiming the target verifies it.
 */

import type { PermissionDecision } from '../permissions/decision.js';
import type { ProviderContentBlock, ProviderMessage } from '../provider/drivers/types.js';

import {
  SESSION_SCHEMA_VERSION,
  SessionVersionError,
  isMessageEvent,
  type SessionEvent,
} from './event.js';

export type { SessionEvent } from './event.js';

/* -------------------------------------------------------------------------- */
/* The context vocabulary                                                       */
/* -------------------------------------------------------------------------- */

/** One block of a context message. */
export type ContextBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: unknown; isError: boolean };

/** One message of the reconstructed context. */
export interface ContextMessage {
  /** The message's role. */
  role: 'user' | 'assistant';
  /** The message's blocks. */
  blocks: ContextBlock[];
  /** The ids of the records the message was projected from. */
  eventIds: string[];
}

/**
 * One item of the reconstructed context.
 *
 * The `message` item is the shape the target's transcript has: an assistant
 * message carries `tool_use` blocks, a user message carries `tool_result`
 * blocks. The `summary` item is the compaction boundary's summary, and the
 * `permission_request` item is the log of an approval — the decision itself
 * reaches the model through the tool result, so this item is not part of a
 * provider request.
 */
export type ContextItem =
  | ({ type: 'message' } & ContextMessage)
  | { type: 'summary'; text: string; replacedFrom: number; eventId: string }
  | { type: 'permission_request'; toolName: string; decision?: PermissionDecision; eventId: string };

/* -------------------------------------------------------------------------- */
/* The result of a resume                                                      */
/* -------------------------------------------------------------------------- */

/** Where the session resumes. */
export interface ResumePoint {
  /**
   * The kind of the resume point.
   *
   * `assistant_tool_use` — the last assistant message that contains a
   * `tool_use`. `last_message` — the fallback, when no assistant message
   * carries one.
   */
  kind: 'assistant_tool_use' | 'last_message';
  /** The index of the message in the context. */
  index: number;
  /** The ids of the records the message was projected from. */
  eventIds: string[];
}

/** An interrupted turn: a tool call that was never answered. */
export interface InterruptedTurn {
  /** The ids of the records of the assistant message that asked for the calls. */
  eventIds: string[];
  /** The ids of the tool calls that were never answered. */
  toolUseIds: string[];
}

/** The compaction boundary that was applied. */
export interface AppliedCompaction {
  /** The summary that replaces the prefix. */
  summary: string;
  /** How many records of the branch the summary replaces. */
  replacedFrom: number;
  /** The id of the marker record. */
  eventId: string;
}

/** A content replacement that was applied. */
export interface AppliedReplacement {
  /** The id of the record whose content was replaced. */
  targetId: string;
  /** The size of the content the stub replaced, in bytes. */
  originalBytes: number;
}

/** What a resume produces. */
export interface ResumeResult {
  /** The reconstructed context. */
  context: ContextItem[];
  /** The branch the resume selected. */
  branch?: { leafId: string | undefined; eventIds: string[] };
  /** Where the session resumes. */
  resumePoint?: ResumePoint;
  /** The unanswered tool calls, when the last turn was interrupted. */
  interrupted?: InterruptedTurn;
  /** The compaction boundary that was applied. */
  compaction?: AppliedCompaction;
  /** The content replacements that were applied. */
  replacements?: AppliedReplacement[];
}

/* -------------------------------------------------------------------------- */
/* The branch                                                                  */
/* -------------------------------------------------------------------------- */

/** The branch a resume selected. */
interface Branch {
  /** The records of the branch, in order. */
  events: SessionEvent[];
  /** The id of the leaf the branch ends at. */
  leafId: string | undefined;
}

/**
 * Select the branch the session continues from.
 *
 * The index is by record id; the leaf is the **newest** leaf; the chain is
 * walked backwards. A record that is a parent of another *message* has
 * children; a boundary marker or a content replacement never disqualifies a
 * message from being a leaf.
 */
export function selectBranch(events: SessionEvent[]): Branch {
  const messages = events.filter((event) => isMessageEvent(event));
  const last = messages[messages.length - 1];
  if (last === undefined) return { events: [], leafId: undefined };

  const byId = new Map<string, SessionEvent>();
  for (const event of events) {
    // The first record of an id wins: a rewound branch may replay an id, and
    // the original is the one the branch hangs off.
    if (!byId.has(event.id)) byId.set(event.id, event);
  }

  const hasChildren = new Set<string>();
  for (const event of messages) {
    const parentId = event.parentId;
    if (parentId === undefined) continue;
    hasChildren.add(parentId);
  }

  // The newest leaf: the greatest timestamp wins, and a tie is won by the one
  // written last. The last line of the file is **not** the rule — a rewound
  // branch stays in the file and must not win by being written last.
  let leaf: SessionEvent | undefined;
  for (const event of messages) {
    if (hasChildren.has(event.id)) continue;
    if (leaf === undefined || event.ts >= leaf.ts) leaf = event;
  }
  if (leaf === undefined) {
    // Every message is somebody's parent: the log is degenerate, and the last
    // written message is the leaf.
    leaf = last;
  }

  const chain: SessionEvent[] = [];
  const seen = new Set<string>();
  let current: SessionEvent | undefined = leaf;
  let foundAncestor = false;
  while (current !== undefined) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    // Only the **messages** are the branch. A boundary marker or a content
    // replacement is walked *through* — a record that continues a compacted
    // conversation hangs off the marker — but it is not part of the branch.
    if (isMessageEvent(current)) chain.push(current);
    const parentId: string | undefined = current.parentId;
    const parent: SessionEvent | undefined =
      parentId === undefined ? undefined : byId.get(parentId);
    if (parent !== undefined) foundAncestor = true;
    current = parent;
  }
  chain.reverse();

  if (!foundAncestor) {
    // The leaf has no ancestor at all: the log carries no parent links (or the
    // link is broken), and the branch is the run of messages up to the leaf.
    const index = events.indexOf(leaf);
    const run = events.slice(0, index + 1).filter((event) => isMessageEvent(event));
    return { events: run, leafId: leaf.id };
  }

  return { events: chain, leafId: leaf.id };
}

/* -------------------------------------------------------------------------- */
/* The projections                                                             */
/* -------------------------------------------------------------------------- */

/** The compaction boundary that applies to a branch. */
function findCompaction(
  events: SessionEvent[],
  branch: SessionEvent[],
): AppliedCompaction | undefined {
  const branchIds = new Set(branch.map((event) => event.id));
  let found: AppliedCompaction | undefined;
  for (const event of events) {
    if (event.t !== 'compaction') continue;
    // A marker that compacts another branch does not apply here.
    if (event.parentId !== undefined && !branchIds.has(event.parentId)) continue;
    found = { summary: event.summary, replacedFrom: event.replacedFrom, eventId: event.id };
  }
  return found;
}

/**
 * Apply the content replacements to a branch.
 *
 * A replacement record names the record whose content it replaces, and the
 * replacement is a **stub**: the payload of an oversized tool result does not
 * come back into the context.
 */
function applyReplacements(
  events: SessionEvent[],
  all: SessionEvent[],
): { events: SessionEvent[]; applied: AppliedReplacement[] } {
  const replacements = new Map<string, { content: unknown; originalBytes: number }>();
  for (const event of all) {
    if (event.t !== 'content_replacement') continue;
    replacements.set(event.targetId, {
      content: event.replacement,
      originalBytes: event.replacement.originalBytes,
    });
  }
  if (replacements.size === 0) return { events, applied: [] };

  const applied: AppliedReplacement[] = [];
  const replaced = events.map((event) => {
    if (event.t !== 'tool_result') return event;
    const replacement = replacements.get(event.id);
    if (replacement === undefined) return event;
    applied.push({ targetId: event.id, originalBytes: replacement.originalBytes });
    return {
      ...event,
      envelope: { ...event.envelope, content: replacement.content },
    };
  });
  return { events: replaced, applied };
}

/**
 * Project a branch into the context.
 *
 * Consecutive `tool_call` records become **one** assistant message with one
 * `tool_use` block each, and consecutive `tool_result` records become **one**
 * user message with one `tool_result` block each — the shape the target's
 * transcript has, and the shape the interrupted-turn rule is stated in.
 */
export function projectContext(events: SessionEvent[]): ContextItem[] {
  const items: ContextItem[] = [];
  let current: Extract<ContextItem, { type: 'message' }> | undefined;

  const openMessage = (role: 'user' | 'assistant'): Extract<ContextItem, { type: 'message' }> => {
    const message: Extract<ContextItem, { type: 'message' }> = {
      type: 'message',
      role,
      blocks: [],
      eventIds: [],
    };
    items.push(message);
    return message;
  };

  for (const event of events) {
    switch (event.t) {
      case 'user_message': {
        current = openMessage('user');
        current.blocks.push({ type: 'text', text: event.text });
        current.eventIds.push(event.id);
        break;
      }
      case 'assistant_message': {
        current = openMessage('assistant');
        current.blocks.push({ type: 'text', text: event.text });
        current.eventIds.push(event.id);
        break;
      }
      case 'tool_call': {
        if (current === undefined || current.role !== 'assistant') current = openMessage('assistant');
        current.blocks.push({ type: 'tool_use', id: event.id, name: event.name, input: event.input });
        current.eventIds.push(event.id);
        break;
      }
      case 'tool_result': {
        if (current === undefined || current.role !== 'user') current = openMessage('user');
        current.blocks.push({
          type: 'tool_result',
          toolUseId: event.envelope.toolUseId,
          content: event.envelope.content,
          isError: event.envelope.isError,
        });
        current.eventIds.push(event.id);
        break;
      }
      case 'permission_request': {
        items.push({
          type: 'permission_request',
          toolName: event.toolName,
          decision: event.decision,
          eventId: event.id,
        });
        break;
      }
      case 'provider_event':
      case 'compaction':
      case 'content_replacement': {
        // The raw stream, the boundary marker and the replacement record are
        // not part of the conversation: the marker is applied before the
        // projection and the replacement is applied to the record it names.
        break;
      }
      default: {
        break;
      }
    }
  }

  return items;
}

/* -------------------------------------------------------------------------- */
/* The resume point and the interrupted turn                                   */
/* -------------------------------------------------------------------------- */

/**
 * The resume point: the last assistant message that contains a `tool_use`,
 * falling back to the last message overall.
 */
export function findResumePoint(context: ContextItem[]): ResumePoint | undefined {
  for (let index = context.length - 1; index >= 0; index -= 1) {
    const item = context[index];
    if (item === undefined || item.type !== 'message' || item.role !== 'assistant') continue;
    if (!item.blocks.some((block) => block.type === 'tool_use')) continue;
    return { kind: 'assistant_tool_use', index, eventIds: [...item.eventIds] };
  }

  for (let index = context.length - 1; index >= 0; index -= 1) {
    const item = context[index];
    if (item === undefined || item.type !== 'message') continue;
    return { kind: 'last_message', index, eventIds: [...item.eventIds] };
  }
  return undefined;
}

/**
 * Detect an interrupted turn.
 *
 * The message list is walked **backward** from the end. Every `tool_result` seen
 * in a `user` message contributes its `tool_use_id` to the set of answered
 * calls; the walk continues over assistant messages, and an assistant message
 * whose `tool_use` blocks carry an id that is not in that set ends the session
 * with an unanswered tool call.
 */
export function findInterruptedTurn(context: ContextItem[]): InterruptedTurn | undefined {
  const answered = new Set<string>();
  for (let index = context.length - 1; index >= 0; index -= 1) {
    const item = context[index];
    if (item === undefined || item.type !== 'message') continue;

    if (item.role === 'user') {
      for (const block of item.blocks) {
        if (block.type === 'tool_result') answered.add(block.toolUseId);
      }
      continue;
    }

    const missing: string[] = [];
    for (const block of item.blocks) {
      if (block.type !== 'tool_use') continue;
      if (!answered.has(block.id)) missing.push(block.id);
    }
    if (missing.length > 0) {
      return { eventIds: [...item.eventIds], toolUseIds: missing };
    }
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* The tool-call pairing                                                       */
/* -------------------------------------------------------------------------- */

/** One tool call and the result that answered it. */
export interface ToolCallPair {
  /** The call. */
  call: SessionEvent;
  /** The result that answered the call, when one did. */
  result?: SessionEvent;
}

/** The pairing of a list of records. */
export interface ToolCallPairing {
  /** The calls, in the order they were made. */
  pairs: ToolCallPair[];
  /** The ids of the calls whose result never arrived. */
  pending: string[];
}

/**
 * Pair a `tool_result` with the `tool_call` it answers.
 *
 * A `tool_use` is answered by the `tool_result` with the same id, and the
 * pending id is **removed from the pending set the moment its result is seen**.
 */
export function pairToolCalls(events: SessionEvent[]): ToolCallPairing {
  const pairs = new Map<string, ToolCallPair>();
  const pending = new Set<string>();

  for (const event of events) {
    if (event.t === 'tool_call') {
      if (!pairs.has(event.id)) {
        pairs.set(event.id, { call: event });
        pending.add(event.id);
      }
      continue;
    }
    if (event.t !== 'tool_result') continue;

    const toolUseId = event.envelope.toolUseId;
    const pair = pairs.get(toolUseId);
    if (pair === undefined) {
      // A result whose call is not in the list — a call in another branch, or a
      // call that was never written. It is not paired, and it answers nothing.
      continue;
    }
    if (pair.result === undefined) pair.result = event;
    pending.delete(toolUseId);
  }

  return { pairs: [...pairs.values()], pending: [...pending] };
}

/* -------------------------------------------------------------------------- */
/* The resume                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Refuse a record whose version this build does not know.
 *
 * The store's reader already refuses such a record, but a resume can also be
 * handed a list that did not come from the store — a list built from a JSON
 * document, say. The version guard therefore runs at the resume boundary too:
 * a transcript whose format changed is **refused**, never partially read.
 */
export function assertSupportedVersions(events: SessionEvent[]): void {
  for (const event of events) {
    const version = (event as { v?: unknown }).v;
    if (version === SESSION_SCHEMA_VERSION) continue;
    throw new SessionVersionError(
      typeof version === 'number' ? version : undefined,
      SESSION_SCHEMA_VERSION,
    );
  }
}

/**
 * Reconstruct the context a session continues from.
 *
 * The branch is selected, the compaction boundary is applied, the content
 * replacements are applied, and the result is projected into the context. The
 * resume point and the interrupted turn are reported alongside it.
 */
export function resumeEvents(events: SessionEvent[]): ResumeResult {
  assertSupportedVersions(events);

  const branch = selectBranch(events);
  const compaction = findCompaction(events, branch.events);

  // The pre-compact prefix is **skipped**, not deleted: it is still in the
  // file, and the summary replaces it in the context.
  const effective =
    compaction === undefined
      ? branch.events
      : branch.events.slice(Math.max(0, Math.min(compaction.replacedFrom, branch.events.length)));

  const { events: replaced, applied } = applyReplacements(effective, events);

  const projected = projectContext(replaced);
  const context: ContextItem[] =
    compaction === undefined
      ? projected
      : [
          {
            type: 'summary',
            text: compaction.summary,
            replacedFrom: compaction.replacedFrom,
            eventId: compaction.eventId,
          },
          ...projected,
        ];

  const result: ResumeResult = { context };
  result.branch = { leafId: branch.leafId, eventIds: branch.events.map((event) => event.id) };
  const resumePoint = findResumePoint(context);
  if (resumePoint !== undefined) result.resumePoint = resumePoint;
  const interrupted = findInterruptedTurn(context);
  if (interrupted !== undefined) result.interrupted = interrupted;
  if (compaction !== undefined) result.compaction = compaction;
  if (applied.length > 0) result.replacements = applied;
  return result;
}

/**
 * Turn a context into the messages of a provider request.
 *
 * A compaction summary is sent as a user message — the summary of the prefix
 * has to reach the model, and the user turn is where it belongs. A
 * `permission_request` item is **not** sent: the decision reaches the model
 * through the tool result.
 */
export function contextToProviderMessages(context: ContextItem[]): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  for (const item of context) {
    if (item.type === 'summary') {
      messages.push({ role: 'user', content: [{ type: 'text', text: item.text }] });
      continue;
    }
    if (item.type === 'permission_request') continue;

    const blocks: ProviderContentBlock[] = item.blocks.map((block) => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: block.text };
        case 'tool_use':
          return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: block.toolUseId,
            content: block.content,
            is_error: block.isError,
          };
        default:
          return { type: 'text', text: '' };
      }
    });
    messages.push({ role: item.role, content: blocks });
  }
  return messages;
}

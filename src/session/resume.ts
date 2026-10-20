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
 *     it in the context. The prefix is still in the file. The boundary is
 *     located by the marker's **parent link** on the branch's parent chain, so
 *     a record that is not a message moves it with it.
 *   - **The content replacement** is applied on resume, so the payload of an
 *     oversized tool result does not come back into the context. The
 *     transcript keeps the payload; only the context is stubbed.
 *
 * ## Resuming a *session*, not only a transcript
 *
 * The audit establishes the session-level surface as well (audit §2.6, feature
 * matrix row 19), and this module owns the parts of it that are the
 * **session domain's** rather than the command line's:
 *
 *   - **The target.** A resume names a session id or an **exact** session
 *     title. More than one session carrying the title is an error that lists
 *     the candidates with their modification times, and a value that matches
 *     neither is an error that says so. The lookup itself lives in
 *     `src/session/store.ts`; the flags belong to the CLI.
 *   - **The drop guard.** A resume at a message uuid that is not present is
 *     refused, and a resume that would discard part of a turn is refused
 *     before anything reaches a context.
 *   - **The structured state.** A resumed transcript carries not only
 *     messages but a state: the interruption of the turn it picked up, the
 *     tool uses that were answered, the ones that were superseded, the tool
 *     use that was deferred, and the identity the session adopted.
 *   - **The attach.** A **live** session is attached to rather than replayed,
 *     and the fork flag bypasses that short-circuit so that a fork always
 *     loads a copy.
 *   - **The telemetry.** Every resume emits `tengu_session_resumed`, with the
 *     entrypoint it came from and, when it fails, the reason it failed.
 *
 * ## What is *not* claimed
 *
 * The target's boundary model is *inference* — third-party analysis of the
 * target's transcript format, not the pinned binary (Global Constraints). The
 * boundary this module implements is the **implementation's own design**, and this header
 * says so rather than claiming the target verifies it.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { PermissionDecision } from '../permissions/decision.js';
import type { ProviderContentBlock, ProviderMessage } from '../provider/drivers/types.js';

import {
  SESSION_SCHEMA_VERSION,
  SessionVersionError,
  answeredToolUseId,
  isMessageEvent,
  requestedToolUseId,
  type SessionEvent,
} from './event.js';
import { readAllSessionEvents, resolveSessionTarget, type SessionStore } from './store.js';

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

/**
 * The kinds of interruption a resumed turn can carry.
 *
 * **Implementation choice.** The audit records that a resumed transcript carries a
 * `turnInterruptionState` with a `kind`, and that the kind is surfaced in the
 * telemetry as `interruption_kind`; it does not record the values. This implementation
 * uses the two it can tell apart: the turn ended cleanly, or the turn ended
 * with a tool call that was never answered.
 */
export type TurnInterruptionKind = 'none' | 'pending_tool_use';

/** The state of the turn a resume picked up. */
export interface TurnInterruptionState {
  /** The kind of the interruption. */
  kind: TurnInterruptionKind;
  /** The ids of the records of the interrupted turn. */
  eventIds: string[];
  /** The tool-use ids that were never answered. */
  toolUseIds: string[];
}

/** A tool use the interrupted turn deferred. */
export interface DeferredToolUse {
  /** The tool-use id. */
  id: string;
  /** The tool's name. */
  name: string;
  /** The tool's input. */
  input: unknown;
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

  /* ------------------------------------------------------------------ */
  /* The structured state a resumed transcript carries                     */
  /* ------------------------------------------------------------------ */

  /**
   * The state of the turn the resume picked up.
   *
   * **Observed** (audit §2.6): a resumed transcript carries not only
   * messages but a structured state, of which `turnInterruptionState` — with
   * its `kind` — is the first member.
   */
  turnInterruptionState?: TurnInterruptionState;
  /**
   * The tool-use ids the resume does **not** carry.
   *
   * A tool call that the compaction replaced, or that belongs to a branch the
   * resume did not select, is *superseded*: it is in the transcript and not in
   * the context.
   */
  supersededToolUseIds?: string[];
  /** The names of the superseded tools. */
  supersededToolNames?: string[];
  /**
   * The tool-use ids that were **answered**.
   *
   * The set agrees with the pairing rule: a tool use is answered by the
   * `tool_result` with the same id.
   */
  answeredToolUseIds?: string[];
  /**
   * Whether a pending tool use was **suppressed** rather than rescued.
   *
   * This implementation reports an interrupted turn and does not re-issue the pending
   * tool call, so the rescue is suppressed whenever there is one.
   */
  rescueSuppressed?: boolean;
  /** The tool use the interrupted turn deferred. */
  deferredToolUse?: DeferredToolUse;
  /**
   * Whether the session was in **plan mode** when it was resumed.
   *
   * **Implementation choice.** This implementation's transcript vocabulary has no plan-mode
   * record, so the caller carries the flag in.
   */
  planModeOnResume?: boolean;
  /** Whether the resume was a **fork** of the session it read. */
  resumedAsFork?: boolean;
  /**
   * The id the resumed session **adopted**.
   *
   * A resumed session may adopt a different id — a fork does, and a session
   * that continues under a new identity does.
   */
  adoptedSessionId?: string;
}

/** The options a resume runs with. */
export interface ResumeEventsOptions {
  /** Whether the session was in plan mode. */
  planModeOnResume?: boolean;
  /** Whether the resume is a fork. */
  resumedAsFork?: boolean;
  /** The id the resumed session adopts. */
  adoptedSessionId?: string;
}

/* -------------------------------------------------------------------------- */
/* The branch                                                                  */
/* -------------------------------------------------------------------------- */

/** The branch a resume selected. */
interface Branch {
  /** The message records of the branch, in order. */
  events: SessionEvent[];
  /**
   * Every record of the branch's parent chain, in order.
   *
   * The chain carries the **non-message** records too: a `provider_event`, a
   * `permission_request` and a `compaction` marker are walked *through* when
   * the branch is selected, and the boundary of a compaction is located on
   * this chain — a marker whose parent is not a message still belongs to the
   * branch.
   */
  chain: SessionEvent[];
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
  if (last === undefined) return { events: [], chain: [], leafId: undefined };

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
  const messageChain: SessionEvent[] = [];
  const seen = new Set<string>();
  let current: SessionEvent | undefined = leaf;
  let foundAncestor = false;
  while (current !== undefined) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    // The **chain** carries every record; the **branch** is the messages. A
    // boundary marker or a content replacement is walked *through* — a record
    // that continues a compacted conversation hangs off the marker — but it is
    // not part of the branch.
    chain.push(current);
    if (isMessageEvent(current)) messageChain.push(current);
    const parentId: string | undefined = current.parentId;
    const parent: SessionEvent | undefined =
      parentId === undefined ? undefined : byId.get(parentId);
    if (parent !== undefined) foundAncestor = true;
    current = parent;
  }
  chain.reverse();
  messageChain.reverse();

  if (!foundAncestor) {
    // The leaf has no ancestor at all: the log carries no parent links (or the
    // link is broken), and the branch is the run of messages up to the leaf.
    const index = events.indexOf(leaf);
    const run = events.slice(0, index + 1);
    return {
      events: run.filter((event) => isMessageEvent(event)),
      chain: run,
      leafId: leaf.id,
    };
  }

  return { events: messageChain, chain, leafId: leaf.id };
}

/* -------------------------------------------------------------------------- */
/* The projections                                                             */
/* -------------------------------------------------------------------------- */

/** The compaction boundary that applies to a branch. */
interface FoundCompaction {
  /** The boundary itself. */
  compaction: AppliedCompaction;
  /**
   * The index of the record the marker hangs off, on the branch's chain.
   *
   * `-1` when the marker names no parent, or names a record that is not on
   * this branch's chain.
   */
  boundaryIndex: number;
}

/**
 * Find the compaction boundary that applies to a branch.
 *
 * A marker applies when it is **reachable from the branch's parent chain**:
 * the record it hangs off is a record of the chain, whatever its kind. A
 * marker whose parent is a record of *another* branch does not apply here. A
 * marker whose parent is **not in the transcript at all** does apply: the
 * prefix it named is not here, so nothing is skipped and the summary leads
 * the context.
 *
 * The boundary itself is located by the marker's **parent link** and not by
 * counting records: `replacedFrom` counts the records the summary replaces,
 * and a count over one sequence is never an index into another. A record
 * that is not a message — a `provider_event`, a `permission_request` — sits
 * on the chain as well, and the boundary moves with it.
 */
function findCompaction(events: SessionEvent[], branch: Branch): FoundCompaction | undefined {
  const chainIds = new Set(branch.chain.map((event) => event.id));
  const knownIds = new Set(events.map((event) => event.id));
  let found: FoundCompaction | undefined;

  for (const event of events) {
    if (event.t !== 'compaction') continue;
    const parentId = event.parentId;
    if (parentId !== undefined && knownIds.has(parentId) && !chainIds.has(parentId)) {
      // A marker that compacts another branch does not apply here.
      continue;
    }
    const boundaryIndex =
      parentId === undefined
        ? -1
        : branch.chain.findIndex((record) => record.id === parentId);
    found = {
      compaction: {
        summary: event.summary,
        replacedFrom: event.replacedFrom,
        eventId: event.id,
      },
      boundaryIndex,
    };
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
    const requested = requestedToolUseId(event);
    if (requested !== undefined) {
      if (!pairs.has(requested)) {
        pairs.set(requested, { call: event });
        pending.add(requested);
      }
      continue;
    }
    const answered = answeredToolUseId(event);
    if (answered === undefined) continue;

    const pair = pairs.get(answered);
    if (pair === undefined) {
      // A result whose call is not in the list — a call in another branch, or a
      // call that was never written. It is not paired, and it answers nothing.
      continue;
    }
    if (pair.result === undefined) pair.result = event;
    pending.delete(answered);
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
    // A list that did not come from the store may hold anything, so the
    // version is read defensively: a `null` element is a record that carries
    // no version, and it is refused like any other unknown version.
    const record: unknown = event;
    const version =
      typeof record === 'object' && record !== null
        ? (record as { v?: unknown }).v
        : undefined;
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
export function resumeEvents(
  events: SessionEvent[],
  options: ResumeEventsOptions = {},
): ResumeResult {
  assertSupportedVersions(events);

  const branch = selectBranch(events);
  const found = findCompaction(events, branch);
  const compaction = found?.compaction;

  // The pre-compact prefix is **skipped**, not deleted: it is still in the
  // file, and the summary replaces it in the context. The boundary is the
  // record the marker hangs off, so the records that follow it survive —
  // whatever their kind.
  const effectiveRecords =
    found === undefined || found.boundaryIndex < 0
      ? branch.chain
      : branch.chain.slice(found.boundaryIndex + 1);

  const { events: replaced, applied } = applyReplacements(effectiveRecords, events);

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

  // The structured state a resumed transcript carries. The **pairing** is the
  // one rule that decides which tool uses were answered: a tool use is
  // answered by the tool result with the same id.
  const effectiveIds = new Set(replaced.map((event) => event.id));
  const pairing = pairToolCalls(replaced);
  const answered = pairing.pairs.filter((pair) => pair.result !== undefined);
  const superseded = pairToolCalls(events).pairs.filter((pair) => !effectiveIds.has(pair.call.id));

  result.answeredToolUseIds = answered.map((pair) => pair.call.id);
  result.supersededToolUseIds = superseded.map((pair) => pair.call.id);
  result.supersededToolNames = superseded.map((pair) =>
    pair.call.t === 'tool_call' ? pair.call.name : '',
  );

  const pending = pairing.pending[0];
  const pendingCall = pending === undefined ? undefined : pairing.pairs.find((pair) => pair.call.id === pending);
  if (pendingCall?.call.t === 'tool_call') {
    result.deferredToolUse = {
      id: pendingCall.call.id,
      name: pendingCall.call.name,
      input: pendingCall.call.input,
    };
    result.rescueSuppressed = true;
  } else {
    result.rescueSuppressed = false;
  }

  result.turnInterruptionState =
    interrupted === undefined
      ? { kind: 'none', eventIds: [], toolUseIds: [] }
      : {
          kind: 'pending_tool_use',
          eventIds: [...interrupted.eventIds],
          toolUseIds: [...interrupted.toolUseIds],
        };

  result.planModeOnResume = options.planModeOnResume === true;
  result.resumedAsFork = options.resumedAsFork === true;
  if (options.adoptedSessionId !== undefined) result.adoptedSessionId = options.adoptedSessionId;

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

/* -------------------------------------------------------------------------- */
/* Resuming at a message                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The outcome of resuming at a message.
 *
 * **Observed** (audit §2.6): a resume at a message uuid that is not present is
 * refused with `No message found with message.uuid of: <uuid>`, and the
 * **drop guard** refuses a resume that would discard entries not attributable
 * to the named turn.
 */
export type ResumeAtMessageResult =
  /** The resume is allowed. */
  | { kind: 'ok'; events: SessionEvent[]; turn?: string; discardedEventIds: string[] }
  /** The resume is refused. */
  | { kind: 'refused'; reason: 'processing_error' | 'drop_guard_refused'; message: string };

/**
 * Resume at a message.
 *
 * **Observed** (audit §2.6): "`--resume-session-at <message-uuid>` resumes at a
 * specific message. A uuid that is not present yields `No message found with
 * message.uuid of: <uuid>` and the failure reason `processing_error`. A **drop
 * guard** refuses a resume that would discard entries not attributable to the
 * named turn: `resuming at <uuid> would discard entries not attributable to
 * turn <turn>: <reason>`, with the failure reason `drop_guard_refused`. So a
 * resume cannot silently drop part of a turn."
 *
 * **Implementation reading of the guard.** A resume at a message discards the records
 * that follow it on the branch. The guard refuses when the discard would
 * **split a turn**: a discarded tool result whose tool call is kept would drop
 * the answer to a call the session still holds. A turn that is discarded whole
 * is allowed, and a call that was never answered is allowed.
 */
export function resumeAtMessage(events: SessionEvent[], messageUuid: string): ResumeAtMessageResult {
  const branch = selectBranch(events);
  const index = branch.chain.findIndex((event) => event.id === messageUuid);
  if (index < 0) {
    return {
      kind: 'refused',
      reason: 'processing_error',
      message: `No message found with message.uuid of: ${messageUuid}`,
    };
  }

  const kept = branch.chain.slice(0, index + 1);
  const discarded = branch.chain.slice(index + 1);
  const keptIds = new Set(kept.map((event) => event.id));

  for (const event of discarded) {
    const answered = answeredToolUseId(event);
    if (answered !== undefined) {
      if (!keptIds.has(answered)) continue;
      // The result is discarded and its call is kept: the turn is split.
      return {
        kind: 'refused',
        reason: 'drop_guard_refused',
        message: `resuming at ${messageUuid} would discard entries not attributable to turn ${answered}: the tool result ${event.id} answers the tool call ${answered}, which is kept`,
      };
    }

    const requested = requestedToolUseId(event);
    if (requested === undefined) continue;
    const result = branch.chain.find(
      (candidate) => answeredToolUseId(candidate) === requested,
    );
    if (result === undefined) continue;
    if (discarded.some((candidate) => candidate.id === result.id)) continue;
    // The call is discarded and its answer is kept: the turn is split.
    return {
      kind: 'refused',
      reason: 'drop_guard_refused',
      message: `resuming at ${messageUuid} would discard entries not attributable to turn ${requested}: the tool call ${event.id} is answered by the tool result ${result.id}, which is kept`,
    };
  }

  return { kind: 'ok', events: kept, discardedEventIds: discarded.map((event) => event.id) };
}

/* -------------------------------------------------------------------------- */
/* Resuming a session: the target, the attach, and the telemetry               */
/* -------------------------------------------------------------------------- */

/**
 * The entrypoints a session resume can come from.
 *
 * **Observed** (audit §2.6): "**`file`** (a path to a `.jsonl` transcript) and
 * **`cli_flag`** (a session id looked up in the store), plus **`print`** for
 * the headless `-p` path."
 */
export type SessionResumeEntrypoint = 'file' | 'cli_flag' | 'print';

/**
 * The failure reasons the target's resume telemetry carries.
 *
 * **Observed** (audit §2.6): "The observed failure reasons are
 * `not_found_explicit_id`, `processing_error`, `load_error`,
 * `drop_guard_refused`, and `worker_state_unread` (the last meaning the worker
 * could not read the session's stored state and will not start a turn without
 * it)."
 */
export type SessionResumeFailureReason =
  | 'not_found_explicit_id'
  | 'processing_error'
  | 'load_error'
  | 'drop_guard_refused'
  | 'worker_state_unread';

/**
 * The telemetry event the target emits when a session is resumed.
 *
 * **Observed** (audit §2.6): "The event is `tengu_session_resumed` with
 * `{entrypoint, success, resume_duration_ms}` on success,
 * `{entrypoint, success, failure_reason, error_name, error_code}` on failure,
 * and an extra `interruption_kind` on the print path."
 */
export const SESSION_RESUMED_TELEMETRY_EVENT = 'tengu_session_resumed';

/** The telemetry of a successful resume. */
export interface SessionResumedSuccess {
  /** The event's name. */
  name: typeof SESSION_RESUMED_TELEMETRY_EVENT;
  /** The entrypoint the resume came from. */
  entrypoint: SessionResumeEntrypoint;
  /** Whether the resume succeeded. */
  success: true;
  /** How long the resume took, in milliseconds. */
  resume_duration_ms: number;
  /** The kind of the interruption the resume picked up. */
  interruption_kind?: TurnInterruptionKind;
}

/** The telemetry of a failed resume. */
export interface SessionResumedFailure {
  /** The event's name. */
  name: typeof SESSION_RESUMED_TELEMETRY_EVENT;
  /** The entrypoint the resume came from. */
  entrypoint: SessionResumeEntrypoint;
  /** Whether the resume succeeded. */
  success: false;
  /** Why the resume failed. */
  failure_reason: SessionResumeFailureReason;
  /** The name of the error that failed the resume. */
  error_name: string;
  /** The code of the error that failed the resume. */
  error_code?: string;
  /** The kind of the interruption the resume picked up. */
  interruption_kind?: TurnInterruptionKind;
}

/** The telemetry of a resume. */
export type SessionResumedTelemetry = SessionResumedSuccess | SessionResumedFailure;

/** The options a session resume runs with. */
export interface ResumeSessionOptions {
  /** The store the sessions live in. */
  store: SessionStore;
  /** The working directory the sessions live under. */
  cwd: string;
  /** The entrypoint the resume came from. */
  entrypoint: SessionResumeEntrypoint;
  /**
   * The target: a session id, an **exact** session title, or the path of a
   * transcript.
   */
  target?: string;
  /** The uuid of the message to resume at. */
  messageUuid?: string;
  /**
   * Load a **copy** of the session.
   *
   * The fork flag bypasses the attach short-circuit, so a fork always loads a
   * copy — even when the session it forks is live.
   */
  forkSession?: boolean;
  /** Whether the session was in plan mode. */
  planModeOnResume?: boolean;
  /**
   * Whether a session is **live**.
   *
   * A live session is **attached** to rather than replayed. This implementation's
   * transcript has no "this session is running" marker, so the caller says
   * which sessions are live.
   */
  isLiveSession?: (sessionId: string) => boolean;
  /**
   * The reader of the session's stored state.
   *
   * The target's worker refuses to start a turn when it cannot read the state
   * (`worker_state_unread`); this implementation asks the caller for it, and a failure
   * is reported with that reason.
   */
  readSessionState?: () => void;
  /** The telemetry sink. */
  onTelemetry?: (event: SessionResumedTelemetry) => void;
  /** The clock. */
  now?: () => number;
  /** The id factory for an adopted session id. */
  idFactory?: () => string;
}

/** The outcome of a session resume. */
export interface ResumeSessionResult {
  /** What happened. */
  status: 'resumed' | 'attached' | 'failed';
  /** The session that was resumed. */
  sessionId?: string;
  /** The id the resumed session adopted. */
  adoptedSessionId?: string;
  /** Whether the resume was a fork. */
  resumedAsFork?: boolean;
  /** Whether the session can be forked from here. */
  canFork?: boolean;
  /** The resume itself. */
  resume?: ResumeResult;
  /** The failure, when the resume failed. */
  failure?: { reason: SessionResumeFailureReason; message: string };
  /** The telemetry event that was emitted. */
  telemetry: SessionResumedTelemetry;
}

/** The message of a thrown value. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The name of a thrown value. */
function errorNameOf(error: unknown): string {
  if (error instanceof Error) return error.name;
  return 'Error';
}

/**
 * Resume a session.
 *
 * The **target** is resolved first: a path to a transcript is read as it is,
 * and an id or an exact title is looked up in the store. A **live** session is
 * then **attached** to rather than replayed — unless `forkSession` is set,
 * which bypasses the short-circuit so that a fork always loads a copy.
 *
 * A resume at a message runs the **drop guard** first: a resume that would
 * discard part of a turn is refused before anything is loaded into a context.
 *
 * Every outcome emits the target's `tengu_session_resumed` telemetry.
 */
export async function resumeSession(options: ResumeSessionOptions): Promise<ResumeSessionResult> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const entrypoint = options.entrypoint;

  const fail = (
    reason: SessionResumeFailureReason,
    message: string,
    errorName = 'SessionResumeError',
  ): ResumeSessionResult => {
    const telemetry: SessionResumedFailure = {
      name: SESSION_RESUMED_TELEMETRY_EVENT,
      entrypoint,
      success: false,
      failure_reason: reason,
      error_name: errorName,
    };
    options.onTelemetry?.(telemetry);
    return { status: 'failed', failure: { reason, message }, telemetry };
  };

  const succeed = (interruptionKind?: TurnInterruptionKind): SessionResumedSuccess => {
    const telemetry: SessionResumedSuccess = {
      name: SESSION_RESUMED_TELEMETRY_EVENT,
      entrypoint,
      success: true,
      resume_duration_ms: Math.max(0, now() - startedAt),
    };
    if (interruptionKind !== undefined) telemetry.interruption_kind = interruptionKind;
    return telemetry;
  };

  // The target: a path to a transcript, or a session of the store.
  const target = (options.target ?? '').trim();
  let sessionId: string | undefined;
  let filePath: string;
  if (entrypoint === 'file') {
    if (target === '') {
      return fail('not_found_explicit_id', 'No transcript path was given.');
    }
    filePath = path.resolve(target);
    sessionId = path.basename(filePath).replace(/\.jsonl$/, '');
  } else {
    const summaries = await options.store.list({ cwd: options.cwd });
    const resolution = resolveSessionTarget(summaries, target);
    if (resolution.kind === 'found') {
      sessionId = resolution.summary.sessionId;
      filePath = resolution.summary.path;
    } else if (resolution.kind === 'ambiguous') {
      return fail('not_found_explicit_id', resolution.message);
    } else if (target.endsWith('.jsonl')) {
      // A path to a transcript, named on the command line rather than looked
      // up in the store.
      filePath = path.resolve(target);
      sessionId = path.basename(filePath).replace(/\.jsonl$/, '');
    } else {
      return fail('not_found_explicit_id', resolution.message);
    }
  }

  // The attach short-circuit: a live session is handed off, not replayed.
  if (options.forkSession !== true && options.isLiveSession?.(sessionId) === true) {
    const telemetry = succeed();
    options.onTelemetry?.(telemetry);
    return { status: 'attached', sessionId, canFork: true, telemetry };
  }

  // The session's stored state: the target's worker refuses to start a turn
  // without it.
  if (options.readSessionState !== undefined) {
    try {
      options.readSessionState();
    } catch (error) {
      return fail('worker_state_unread', messageOf(error), errorNameOf(error));
    }
  }

  // The transcript.
  let events: SessionEvent[];
  try {
    events = await readAllSessionEvents(filePath);
  } catch (error) {
    return fail('load_error', messageOf(error), errorNameOf(error));
  }

  // The resume at a message, with its drop guard.
  if (options.messageUuid !== undefined) {
    const at = resumeAtMessage(events, options.messageUuid);
    if (at.kind === 'refused') {
      return fail(at.reason, at.message);
    }
    events = at.events;
  }

  // The resume itself. A fork adopts a new session id.
  const forked = options.forkSession === true;
  const adoptedSessionId = forked
    ? (options.idFactory ?? (() => randomUUID()))()
    : undefined;
  const resume = resumeEvents(events, {
    planModeOnResume: options.planModeOnResume === true,
    resumedAsFork: forked,
    ...(adoptedSessionId === undefined ? {} : { adoptedSessionId }),
  });

  const telemetry = succeed(
    entrypoint === 'print' ? (resume.turnInterruptionState?.kind ?? 'none') : undefined,
  );
  options.onTelemetry?.(telemetry);

  const result: ResumeSessionResult = {
    status: 'resumed',
    sessionId,
    resumedAsFork: forked,
    resume,
    telemetry,
  };
  if (adoptedSessionId !== undefined) result.adoptedSessionId = adoptedSessionId;
  return result;
}

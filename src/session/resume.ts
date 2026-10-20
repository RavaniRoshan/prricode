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
 *     prefix is **skipped** when the session is resumed (by `resumeEvents`,
 *     not by the store's reader), and the summary replaces it in the context.
 *     The prefix is still in the file. The boundary is located by the marker's
 *     **parent link** on the branch's parent chain, so a record that is not a
 *     message moves it with it.
 *   - **The content replacement** is applied wherever a transcript becomes a
 *     context, so the payload of an oversized tool result does not come back
 *     to the model. The transcript keeps the payload; only the context is
 *     stubbed. **Three** paths apply it, and all three produce the same
 *     stubbed content: the cross-turn projection (`resumeEvents` here), the
 *     between-turns load (`conversationFromEvents`, in
 *     `src/agent/context.ts`), and the **within-turn** push
 *     (`src/agent/loop.ts`), which uses the store's own rule
 *     (`contentReplacementStub`) and the store's own limit. The limit is the
 *     **store's**, not a constant: a store built with a different
 *     `maxToolResultBytes` stubs at that limit on every path.
 *   - **The tool-result content** is serialised into a **string** on the way
 *     out, because the observed shape of a `tool_result` block is
 *     `{tool_use_id, type:"tool_result", content:<string>}` (audit §2.4) and an
 *     envelope's content is not always a string — a failed tool leaves an
 *     **object** behind. The serialisation is **shared**: the block is built
 *     once, by `providerToolResultBlock`, and the within-turn path
 *     (`src/agent/context.ts`) reaches it by import, so the paths cannot
 *     drift.
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
 *   - **The reason an ambiguity reports.** This implementation reports
 *     `not_found_explicit_id` for an ambiguous title — the same reason a
 *     session id that is not in the store gets. The audit records the
 *     ambiguity *error* but never the reason it maps to, so that mapping is a
 *     **implementation choice**, and this header says so rather than claiming the
 *     target verifies it.
 *   - **The drop guard.** A resume at a message uuid that is not present is
 *     refused, and a resume that would discard part of a turn is refused
 *     before anything reaches a context.
 *   - **The structured state.** A resumed transcript carries not only
 *     messages but a state: the interruption of the turn it picked up, the
 *     tool uses that were answered, the ones that were superseded, the tool
 *     use that was deferred, and the identity the session adopted. The audit
 *     records four more members of that state — `agentSetting`,
 *     `sessionProjectPath`, `transcriptAnchor` and `liveSourceRows` — and
 *     they are here as **optional** members, but only one of them is
 *     **derived**: the `transcriptAnchor` is the record the branch ends at
 *     and where it sits among the source rows. This implementation **cannot derive**
 *     the other three from its own vocabulary: its transcript has no
 *     **agent-setting record** and no **project-path record**, so the caller
 *     carries those two in, and `liveSourceRows` — the rows still live in
 *     the source, as opposed to the reconstructed messages — has **no implementation
 *     counterpart** at all, so the member stays absent.
 *   - **The attach.** A **live** session is attached to rather than replayed,
 *     and the fork flag bypasses that short-circuit so that a fork always
 *     loads a copy.
 *   - **The telemetry.** Every resume emits `tengu_session_resumed`, with the
 *     entrypoint it came from and, when it fails, the reason it failed. The
 *     **print** path emits `tengu_resume_print` as well, at the start: that
 *     event marks the start of a print-mode resume.
 *   - **The `--continue`.** A continue names **no** session: the store picks
 *     the newest one. A session that is already running in the background is
 *     **reported** rather than silently continued, a failure that happened
 *     before the restore is reported with the target's "could not continue"
 *     message and a failure that happened after it with the target's
 *     "startup failed after restoring" message, and the run emits
 *     `tengu_continue`.
 *
 * ## What is *not* claimed
 *
 * The target's boundary model is *inference* — third-party analysis of the
 * target's transcript format, not the pinned binary (Global Constraints). The
 * boundary this module implements is the **implementation's own design**, and this header
 * says so rather than claiming the target verifies it.
 *
 * The target's `--continue` **ordering** rule — which candidates its lookup
 * skips — is not observed either: the lookup lives in a module outside the
 * retained scope. This implementation's rule is its own, and `continueSession` says so
 * where it is implemented.
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
import { readAllSessionEvents, resolveSessionTarget, type SessionStore, type SessionSummary } from './store.js';

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

/**
 * The anchor of a resumed transcript.
 *
 * **Implementation choice.** The audit records that a resumed transcript carries a
 * `transcriptAnchor` (audit §2.6) but never what the anchor holds, so the
 * implementation's reading is documented here rather than claimed: the anchor is the
 * point the resume continues from — the record the branch ends at, and how
 * many source rows precede it.
 */
export interface TranscriptAnchor {
  /** The id of the record the resumed transcript is anchored at. */
  recordId: string;
  /** How many rows of the source precede the anchor. */
  rowIndex: number;
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
  /**
   * The agent setting the resumed session carries.
   *
   * **Implementation choice.** The audit records the member but not its shape, and the
   * implementation's transcript vocabulary has no **agent-setting record**, so the
   * caller carries the setting in and this implementation does not derive it.
   */
  agentSetting?: Record<string, unknown>;
  /**
   * The project path the resumed session belongs to.
   *
   * **Implementation choice.** This implementation's transcript vocabulary has no
   * **project-path record**, so the caller carries the path in and this implementation
   * does not derive it.
   */
  sessionProjectPath?: string;
  /**
   * The anchor of the resumed transcript.
   *
   * **Observed** (audit §2.6): a resumed transcript carries a
   * `transcriptAnchor`. This implementation derives it: the anchor is the record the
   * branch ends at and where it sits among the source rows.
   */
  transcriptAnchor?: TranscriptAnchor;
  /**
   * The rows still live in the source.
   *
   * **Not implemented.** The target's rows are rows of *its* source, as
   * opposed to the reconstructed `messages`; this implementation's source is the
   * transcript and it has no such rows, so the member stays absent. It is
   * here so that the shape of the resumed state is the target's.
   */
  liveSourceRows?: readonly unknown[];
}

/** The options a resume runs with. */
export interface ResumeEventsOptions {
  /** Whether the session was in plan mode. */
  planModeOnResume?: boolean;
  /** Whether the resume is a fork. */
  resumedAsFork?: boolean;
  /** The id the resumed session adopts. */
  adoptedSessionId?: string;
  /**
   * The agent setting the resumed session carries.
   *
   * This implementation's transcript vocabulary has no agent-setting record, so the
   * caller carries the setting in.
   */
  agentSetting?: Record<string, unknown>;
  /**
   * The project path the resumed session belongs to.
   *
   * This implementation's transcript vocabulary has no project-path record, so the
   * caller carries the path in.
   */
  sessionProjectPath?: string;
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
 * Apply the content replacements of a transcript to its records.
 *
 * A replacement record names the record whose content it replaces, and the
 * replacement is a **stub**: the payload of an oversized tool result does not
 * come back into the context.
 *
 * The replacement is applied **on read**. The transcript keeps the payload —
 * the data is not lost — and every path that projects a transcript into a
 * context applies the replacement, so the payload never reaches the model:
 * the **cross-turn** projection (`resumeEvents`) and the **between-turns**
 * load (`conversationFromEvents`, in `src/agent/context.ts`) both call this
 * function.
 *
 * The stub's **wire form** — the stub's own JSON, `{"type":"tool_result_stub",
 * …}` — is a **implementation choice**: the audit pins that the oversized payload does
 * not come back into the context, and not what the stub looks like on the
 * wire.
 *
 * @param events the records whose content is replaced.
 * @param all the records the replacement records are read from.
 */
export function applyContentReplacements(
  events: SessionEvent[],
  all: SessionEvent[] = events,
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

  const { events: replaced, applied } = applyContentReplacements(effectiveRecords, events);

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
  if (options.agentSetting !== undefined) result.agentSetting = options.agentSetting;
  if (options.sessionProjectPath !== undefined) {
    result.sessionProjectPath = options.sessionProjectPath;
  }

  // The **anchor**: the point the resume continues from. It is the record the
  // branch ends at, and where that record sits among the source rows.
  if (branch.leafId !== undefined) {
    const rowIndex = events.findIndex((event) => event.id === branch.leafId);
    result.transcriptAnchor = {
      recordId: branch.leafId,
      rowIndex: rowIndex < 0 ? 0 : rowIndex,
    };
  }

  // The **live source rows** are not implemented: this implementation's source is the
  // transcript, and it has no rows that are still live beside the
  // reconstructed messages. The member stays absent.

  return result;
}

/* -------------------------------------------------------------------------- */
/* The tool-result content                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The content a tool result carries when it can be neither serialized nor
 * stringified.
 *
 * **Implementation choice.** The audit does not pin a wire form for a value that has
 * none; the placeholder is this implementation's own.
 */
const UNSERIALIZABLE_CONTENT = '[unserializable tool result]';

/**
 * The wire form of a tool result's content.
 *
 * **Observed** (audit §2.4): "the block is `{ tool_use_id, type: "tool_result",
 * content: <string> }` with `is_error: true` added for a failure". The content
 * is therefore **always a string**. A string is carried as it is, and anything
 * else is carried as its JSON serialization, because the wire shape accepts a
 * string or a list of content blocks and not an arbitrary value.
 *
 * The value that reaches this function is the envelope's own content, and an
 * envelope's content is not always a string: a **failed** tool leaves
 * `{type:"error", message, errorCode}` behind, and a **replaced** tool result
 * leaves the stub behind. Both are objects, and both have to reach the model
 * as a string.
 *
 * The **stub's wire form** — the stub's own JSON, `{"type":"tool_result_stub",
 * …}` — is a **implementation choice**: the audit pins that the oversized payload does
 * not come back into the context, and not what the stub looks like on the
 * wire.
 *
 * The failed tool's **text** is the **implementation's own**. The target answers a
 * refused call and an input-validation failure with a
 * `<tool_use_error>…</tool_use_error>` wrapper (audit §2.4), and this implementation's
 * runtime wraps a **refusal** that way — the wrapper is labelled a reimplementation
 * choice in `src/agent/loop.ts` — while an **execution** failure is reported
 * with the error envelope the tool runner produces. This module does not
 * reproduce the target's wrapper for that case; it decides that whatever the
 * envelope holds reaches the model as a **string**.
 *
 * **This is the one serialisation.** The **within-turn** builder — the block a
 * running turn pushes into its next request — and the **cross-turn**
 * projection — the request a resumed session builds, here — both reach it
 * through `providerToolResultBlock`, so the paths cannot drift.
 *
 * The serialisation stays in the **session** module: the session module is the
 * lower layer, and the agent module imports it. A `src/provider/` home would
 * turn the session module's dependency on the provider layer — a **type-only**
 * one, today — into a **runtime** one, and the direction the milestone
 * established (one shared serialisation, reached from the agent module
 * through the session module) would be gone.
 *
 * The empty string stands for an absent content: the envelope of a call that
 * produced nothing carries `undefined`, and the wire shape wants a string.
 *
 * ## What the serialisation reads
 *
 * The serialisation **reads** the value it is given, and it reads it **through
 * the prototype chain**: `JSON.stringify` performs a `[[Get]]` of `toJSON` —
 * through the chain — and invokes it, and it invokes the value's own getters;
 * and `String(value)` reads `Symbol.toPrimitive`, `toString` and `valueOf` —
 * through the chain — and invokes them. The wire form therefore depends on
 * the **prototype** of the caller's value: a value whose prototype carries a
 * `toJSON` is serialized by that `toJSON`, and a polluted
 * `Object.prototype.toJSON` would rewrite every tool result.
 *
 * Nothing is **written**: the serialisation sets no member and defines no
 * property, so there is no pollution vector, and `__proto__` as an **own** key
 * serializes as a plain key.
 */
export function toolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === undefined) return '';
  try {
    const serialized = JSON.stringify(content);
    if (serialized !== undefined) return serialized;
    // `JSON.stringify` returns `undefined` for a value it cannot represent —
    // a symbol, a function. The string form is what reaches the model.
    return stringForm(content);
  } catch {
    // A value `JSON.stringify` refuses — a circular structure, a `BigInt` —
    // still has to reach the model as a string.
    return stringForm(content);
  }
}

/**
 * The string form of a value, or a placeholder when it has none.
 *
 * `String(value)` reads `Symbol.toPrimitive`, `toString` and `valueOf` through
 * the prototype chain and invokes them, so it can **throw**: a null-prototype
 * value has none of them, and `String(Object.create(null))` raises a
 * `TypeError`. The fallback therefore has a fallback of its own — a value that
 * can be neither serialized nor stringified still has to reach the model as a
 * string, and the exception must not escape the request build.
 */
function stringForm(value: unknown): string {
  try {
    return String(value);
  } catch {
    return UNSERIALIZABLE_CONTENT;
  }
}

/**
 * The provider block that carries a tool result.
 *
 * **This is the one builder of a `tool_result` block.** The within-turn path
 * (`src/agent/context.ts`, `toolResultBlock`) and the cross-turn projection
 * (`contextToProviderMessages`, here) both build the block through it, so the
 * wire shape is written once.
 *
 * **Observed** (audit §2.4): the block is `{ tool_use_id, type: "tool_result",
 * content: <string> }` with `is_error: true` added **for a failure** — a
 * success carries **no** `is_error` member at all, and the member is
 * therefore added only for a failure.
 */
export function providerToolResultBlock(
  toolUseId: string,
  content: unknown,
  isError: boolean,
): ProviderContentBlock {
  const block: Extract<ProviderContentBlock, { type: 'tool_result' }> = {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: toolResultContent(content),
  };
  if (isError) block.is_error = true;
  return block;
}

/**
 * Turn a context into the messages of a provider request.
 *
 * A compaction summary is sent as a user message — the summary of the prefix
 * has to reach the model, and the user turn is where it belongs. A
 * `permission_request` item is **not** sent: the decision reaches the model
 * through the tool result.
 *
 * A `tool_result` block's content is serialised by `toolResultContent`, so the
 * request that follows a failed tool is well formed: its content is a string,
 * never the error envelope's object.
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
          return providerToolResultBlock(block.toolUseId, block.content, block.isError);
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
 *
 * The uuid is looked up among the **messages** of the branch. A uuid that
 * names another record of the branch — a `provider_event`, a boundary marker —
 * is not a message, and it is refused with the same wording as a uuid that is
 * not there at all.
 */
export function resumeAtMessage(events: SessionEvent[], messageUuid: string): ResumeAtMessageResult {
  const branch = selectBranch(events);
  // The uuid is looked up among the **messages**. A uuid that names another
  // record of the branch — a `provider_event`, a boundary marker — is not a
  // message, and the target refuses it with the same wording it uses for a
  // uuid that is not there at all.
  const index = branch.chain.findIndex(
    (event) => event.id === messageUuid && isMessageEvent(event),
  );
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
    //
    // This branch **cannot fire** on the chain this guard walks. The chain is
    // ancestor-ordered — it is the parent path from the root to the leaf — so a
    // result always *follows* the call it answers, and a call that is
    // discarded takes its answer with it. The check is kept as a **defensive**
    // guard for a chain that is not ordered that way: an answer that precedes
    // its call would otherwise be split from it without a word.
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

/**
 * The telemetry event that marks the **start** of a print-mode resume.
 *
 * **Observed** (audit §2.6): "A separate `tengu_resume_print` event marks the
 * start of a print-mode resume." The audit does not record the members of the
 * event, so this implementation's payload is a **implementation choice**: the entrypoint the
 * print-mode resume came from.
 */
export const SESSION_RESUME_PRINT_TELEMETRY_EVENT = 'tengu_resume_print';

/** The telemetry of a print-mode resume's start. */
export interface SessionResumePrintTelemetry {
  /** The event's name. */
  name: typeof SESSION_RESUME_PRINT_TELEMETRY_EVENT;
  /** The entrypoint the print-mode resume came from. */
  entrypoint: 'print';
}

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
  /**
   * The sink of the **print-mode** telemetry.
   *
   * The print path emits a second, separate event — `tengu_resume_print` —
   * that marks the start of the print-mode resume. It has its own sink, so a
   * caller that only wants the resume's own telemetry does not have to know
   * about it.
   */
  onPrintTelemetry?: (event: SessionResumePrintTelemetry) => void;
  /** The clock. */
  now?: () => number;
  /** The id factory for an adopted session id. */
  idFactory?: () => string;
  /**
   * The agent setting the resumed session carries.
   *
   * This implementation's transcript vocabulary has no agent-setting record, so the
   * caller carries the setting in.
   */
  agentSetting?: Record<string, unknown>;
  /**
   * The project path the resumed session belongs to.
   *
   * This implementation's transcript vocabulary has no project-path record, so the
   * caller carries the path in.
   */
  sessionProjectPath?: string;
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
 * Every outcome emits the target's `tengu_session_resumed` telemetry. The
 * **print** path emits `tengu_resume_print` as well, at the start: the event
 * marks the start of a print-mode resume, before anything can fail.
 */
export async function resumeSession(options: ResumeSessionOptions): Promise<ResumeSessionResult> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const entrypoint = options.entrypoint;

  // The print path marks its start, whether the resume goes on to succeed or
  // to fail.
  if (entrypoint === 'print') {
    options.onPrintTelemetry?.({
      name: SESSION_RESUME_PRINT_TELEMETRY_EVENT,
      entrypoint: 'print',
    });
  }

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
    ...(options.agentSetting === undefined ? {} : { agentSetting: options.agentSetting }),
    ...(options.sessionProjectPath === undefined
      ? {}
      : { sessionProjectPath: options.sessionProjectPath }),
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

/* -------------------------------------------------------------------------- */
/* Continuing the newest session                                               */
/* -------------------------------------------------------------------------- */

/**
 * The telemetry event the target emits for a `--continue`.
 *
 * **Observed** (audit §2.6): "The telemetry is `tengu_continue` with
 * `{success}` and `resume_duration_ms`, or `{success: false, error_name}` on
 * failure."
 */
export const SESSION_CONTINUE_TELEMETRY_EVENT = 'tengu_continue';

/**
 * The message the target's lookup reports when there is **nothing** to
 * continue.
 *
 * **Observed** (audit §2.6): "If nothing is found the message is `No
 * conversation found to continue`."
 */
export const CONTINUE_NOT_FOUND_MESSAGE = 'No conversation found to continue';

/**
 * The report of a session that is **already running in the background**.
 *
 * **Implementation choice.** The audit records that "if a background session was found,
 * a different, more specific message is used", but it does not record the
 * text. This implementation's message says what the target's says: the session is
 * running, and the way to pick a session is `--resume`.
 */
export const CONTINUE_BACKGROUND_RUNNING_MESSAGE =
  'The previous session is already running in the background. Run agent --resume to pick a session, or start a new one.';

/**
 * The message the target prints when the failure happened **after** the
 * restore.
 *
 * **Observed** (audit §2.6): "`The agent exited: startup failed after
 * restoring the previous session (<reason>).`"
 */
export const CONTINUE_FAILED_AFTER_RESTORE_MESSAGE =
  'The agent exited: startup failed after restoring the previous session ({reason}).';

/**
 * The message the target prints when the failure happened **before** the
 * restore.
 *
 * **Observed** (audit §2.6): "`The agent exited: could not continue the
 * previous session (<reason>). Run agent --resume to pick a session, or start
 * a new one.`"
 */
export const CONTINUE_FAILED_BEFORE_RESTORE_MESSAGE =
  'The agent exited: could not continue the previous session ({reason}). Run agent --resume to pick a session, or start a new one.';

/**
 * The message a `--continue` failure is reported with.
 *
 * The two texts are the target's, and the **reason** is the text the
 * parentheses hold: the lookup's own report, or the message of the error that
 * failed the run.
 */
export function continueFailureMessage(reason: string, afterRestore: boolean): string {
  const template = afterRestore
    ? CONTINUE_FAILED_AFTER_RESTORE_MESSAGE
    : CONTINUE_FAILED_BEFORE_RESTORE_MESSAGE;
  return template.replace('{reason}', reason);
}

/**
 * The reasons a `--continue` can fail.
 *
 * **Implementation choice.** The audit records the two failure *messages* and the
 * lookup's "not found" message; it does not record a reason vocabulary. The
 * implementation names the reasons it can tell apart, and each one says whether the
 * failure happened **before** the restore or **after** it.
 */
export type SessionContinueFailureReason =
  /** There was no session to continue. */
  | 'not_found'
  /** The newest session is already running in the background. */
  | 'background_running'
  /** The transcript could not be read. */
  | 'load_error'
  /** The session's stored state could not be read. */
  | 'worker_state_unread'
  /** The previous session could not be restored. */
  | 'restore_error'
  /** The startup failed after the previous session was restored. */
  | 'startup_error';

/** The telemetry of a successful continue. */
export interface SessionContinueSuccess {
  /** The event's name. */
  name: typeof SESSION_CONTINUE_TELEMETRY_EVENT;
  /** Whether the continue succeeded. */
  success: true;
  /** How long the continue took, in milliseconds. */
  resume_duration_ms: number;
}

/** The telemetry of a failed continue. */
export interface SessionContinueFailure {
  /** The event's name. */
  name: typeof SESSION_CONTINUE_TELEMETRY_EVENT;
  /** Whether the continue succeeded. */
  success: false;
  /** The name of the error that failed the continue. */
  error_name: string;
}

/** The telemetry of a continue. */
export type SessionContinueTelemetry = SessionContinueSuccess | SessionContinueFailure;

/** The session a `--continue` restored. */
export interface ContinueRestoredSession {
  /** The id of the session that was restored. */
  sessionId: string;
  /** The path of its transcript. */
  path: string;
  /** The reconstructed state. */
  resume: ResumeResult;
}

/** The options a `--continue` runs with. */
export interface ContinueSessionOptions {
  /** The store the sessions live in. */
  store: SessionStore;
  /** The working directory the sessions live under. */
  cwd: string;
  /**
   * Whether a session is **live** — already running in the background.
   *
   * This implementation's transcript has no "this session is running" marker, so the
   * caller says which sessions are live.
   */
  isLiveSession?: (sessionId: string) => boolean;
  /**
   * The startup that follows the restore.
   *
   * This implementation restores the previous session and then **starts** it. A failure
   * in the startup is the failure that happened **after** the restore, and it
   * is reported with the target's other message.
   */
  startSession?: (session: ContinueRestoredSession) => void;
  /**
   * Load a **copy** of the session.
   *
   * The fork flag is threaded through the continue, as it is threaded through
   * the resume.
   */
  forkSession?: boolean;
  /**
   * The reader of the session's stored state.
   *
   * The target's worker refuses to start a turn when it cannot read the state
   * (`worker_state_unread`); this implementation asks the caller for it, and a failure
   * is reported with that reason.
   */
  readSessionState?: () => void;
  /** The telemetry sink. */
  onTelemetry?: (event: SessionContinueTelemetry) => void;
  /** The clock. */
  now?: () => number;
  /** The id factory for an adopted session id. */
  idFactory?: () => string;
}

/** The outcome of a `--continue`. */
export interface SessionContinueResult {
  /** What happened. */
  status: 'continued' | 'failed';
  /** The session that was continued. */
  sessionId?: string;
  /** The id the continued session adopted. */
  adoptedSessionId?: string;
  /** The reconstructed state, when the session was restored. */
  resume?: ResumeResult;
  /**
   * The session that is **already running in the background**, when one was
   * reported instead of continued.
   */
  backgroundSessionId?: string;
  /** The failure, when the continue failed. */
  failure?: {
    /** Why the continue failed. */
    reason: SessionContinueFailureReason;
    /**
     * Whether the failure happened **after** the restore.
     *
     * The two cases have distinct texts: a failure before the restore is
     * reported as "could not continue the previous session", a failure after
     * it as "startup failed after restoring the previous session".
     */
    afterRestore: boolean;
    /**
     * The reason the failure carries.
     *
     * It is the text the parentheses of the target's message hold: the
     * lookup's own report, or the message of the error that failed the run.
     */
    detail: string;
    /** The message the target prints. */
    message: string;
  };
  /** The telemetry event that was emitted. */
  telemetry: SessionContinueTelemetry;
}

/**
 * Continue the newest session of a working directory.
 *
 * **Observed** (audit §2.6): "The path (`chunk-9y799w6p.js`) calls the session
 * lookup with **no explicit id**, so the store selects the newest session. The
 * lookup takes an `onNewestRunningInBackground` callback that captures the
 * newest session **already running in the background** — so a background
 * session is reported rather than silently continued. If nothing is found the
 * message is `No conversation found to continue`; if a background session was
 * found, a different, more specific message is used. The failure path
 * distinguishes two cases with distinct text: `The agent exited: startup
 * failed after restoring the previous session (<reason>).` when the failure
 * happened **after** the restore, and `The agent exited: could not continue
 * the previous session (<reason>). Run agent --resume to pick a session, or
 * start a new one.` when it happened **before**."
 *
 * **Implementation choice.** The audit does not record the *ordering* rule inside the
 * target's lookup — which candidates it skips — so this implementation's rule is its
 * own: the **newest** session of the working directory, and the newest
 * session is *reported* when it is already running in the background.
 *
 * **Not implemented.** The target's path also clears the session caches
 * first, passes `resumeSource: "store"` and `includeAttribution: true`, and
 * threads `replyOnResume` through. This implementation's store holds **no cache** — a
 * lookup always reads the transcripts — so the clearing step has no
 * counterpart, and the continue always resumes from the store.
 * `includeAttribution` and `replyOnResume` have **no counterpart** in the
 * implementation's vocabulary and are not implemented. `forkSession` is threaded
 * through, and does what it does everywhere else.
 */
export async function continueSession(
  options: ContinueSessionOptions,
): Promise<SessionContinueResult> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  const fail = (
    reason: SessionContinueFailureReason,
    detail: string,
    afterRestore: boolean,
    errorName = 'SessionContinueError',
  ): SessionContinueResult => {
    const telemetry: SessionContinueFailure = {
      name: SESSION_CONTINUE_TELEMETRY_EVENT,
      success: false,
      error_name: errorName,
    };
    options.onTelemetry?.(telemetry);
    return {
      status: 'failed',
      failure: {
        reason,
        afterRestore,
        detail,
        message: continueFailureMessage(detail, afterRestore),
      },
      telemetry,
    };
  };

  // The lookup: the **newest** session of the working directory.
  let summaries: SessionSummary[];
  try {
    summaries = await options.store.list({ cwd: options.cwd });
  } catch (error) {
    return fail('load_error', messageOf(error), false, errorNameOf(error));
  }
  const newest = summaries[0];
  if (newest === undefined) {
    return fail('not_found', CONTINUE_NOT_FOUND_MESSAGE, false);
  }
  if (options.isLiveSession?.(newest.sessionId) === true) {
    // The session is already running in the background: it is **reported**,
    // not silently continued.
    const reported = fail('background_running', CONTINUE_BACKGROUND_RUNNING_MESSAGE, false);
    reported.backgroundSessionId = newest.sessionId;
    return reported;
  }

  // The session's stored state: the target's worker refuses to start a turn
  // without it. This happens **before** the restore.
  if (options.readSessionState !== undefined) {
    try {
      options.readSessionState();
    } catch (error) {
      return fail('worker_state_unread', messageOf(error), false, errorNameOf(error));
    }
  }

  // The transcript. A transcript that cannot be read is a failure **before**
  // the restore.
  let events: SessionEvent[];
  try {
    events = await readAllSessionEvents(newest.path);
  } catch (error) {
    return fail('load_error', messageOf(error), false, errorNameOf(error));
  }

  // The restore itself.
  const forked = options.forkSession === true;
  const adoptedSessionId = forked
    ? (options.idFactory ?? (() => randomUUID()))()
    : undefined;
  let resume: ResumeResult;
  try {
    resume = resumeEvents(events, {
      planModeOnResume: false,
      resumedAsFork: forked,
      ...(adoptedSessionId === undefined ? {} : { adoptedSessionId }),
    });
  } catch (error) {
    return fail('restore_error', messageOf(error), false, errorNameOf(error));
  }

  // The startup, which follows the restore. A failure here is the failure
  // that happened **after** the restore.
  const restored: ContinueRestoredSession = {
    sessionId: newest.sessionId,
    path: newest.path,
    resume,
  };
  if (options.startSession !== undefined) {
    try {
      options.startSession(restored);
    } catch (error) {
      return fail('startup_error', messageOf(error), true, errorNameOf(error));
    }
  }

  const telemetry: SessionContinueSuccess = {
    name: SESSION_CONTINUE_TELEMETRY_EVENT,
    success: true,
    resume_duration_ms: Math.max(0, now() - startedAt),
  };
  options.onTelemetry?.(telemetry);

  const result: SessionContinueResult = {
    status: 'continued',
    sessionId: newest.sessionId,
    resume,
    telemetry,
  };
  if (adoptedSessionId !== undefined) result.adoptedSessionId = adoptedSessionId;
  return result;
}

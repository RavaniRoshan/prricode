/**
 * The compaction boundary.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.6 (Sessions,
 * persistence, and resumption) and the `CC-009` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## A boundary marker, not a deletion
 *
 * The plan's design note is explicit: "the target's compaction is a **boundary
 * marker, not a deletion** — a system line with a `compact_boundary` subtype
 * whose `logicalParentUuid` points at the last pre-compact message, with the
 * summary in a separate line — and this implementation must match that, because a reimplementation
 * that *deletes* the prefix cannot replay a preserved tail."
 *
 * So this implementation writes a **marker record** that carries the summary of the prefix
 * it replaces and the number of records that prefix held. The prefix stays in
 * the file; the reader **skips** it when the session is read, and the summary
 * takes its place in the context. The marker points at the last pre-compact
 * record the way the target's boundary line points at the last pre-compact
 * message.
 *
 * ## The boundary is located by a link, not by a count
 *
 * The marker carries two things: the **summary** of the prefix it replaces,
 * and the **number of records** that prefix held (`replacedFrom`). The number
 * is a **count over the list the compaction ran on** — it is *not* an index
 * into any other sequence, and no reader uses it as one.
 *
 * The **boundary** — the point where the summary takes over — is located by
 * the marker's **parent link**: the marker hangs off the last record of the
 * dropped prefix, and a reader walks the branch's parent chain to that record.
 * A record that is not a message — a `provider_event`, a `permission_request` —
 * sits on that chain like any other record, so the boundary moves with it. A
 * reader that counted records instead would index a *different* sequence than
 * the one the count was made over, and would drop a message the boundary never
 * claimed to replace.
 *
 * ## What is *not* claimed
 *
 * The target's boundary model is *inference*: it comes from third-party analysis
 * of the target's transcript format, not from the pinned binary (Global
 * Constraints). The boundary this module implements is the **implementation's own
 * design**, and this header says so rather than claiming the target verifies
 * it. This implementation's record format is independently versioned; see
 * `src/session/event.ts` for the version policy and the migration path.
 *
 * ## The summary is produced by the provider, not locally
 *
 * The summary of a compacted prefix is a **model** output: this implementation asks the
 * provider for it and passes it in. `compact` never writes one itself — a
 * summary produced by a local heuristic would not be a summary of the
 * conversation, and the plan's Step 11 requires exactly this. Without a summary
 * there is no boundary to mark, so `compact` leaves the events alone and
 * reports no summary.
 */

import { randomUUID } from 'node:crypto';

import { SESSION_SCHEMA_VERSION, type SessionEvent } from './event.js';

/** The options a compaction runs with. */
export interface CompactOptions {
  /** How many of the most recent records to keep. */
  keepLast: number;
  /**
   * The provider-produced summary of the dropped prefix.
   *
   * When it is absent, `compact` cannot mark a boundary and leaves the events
   * alone — the summary is never produced locally.
   */
  summary?: string;
  /** The timestamp of the marker. */
  ts?: number;
  /** The id of the marker. */
  id?: string;
  /**
   * The record the marker hangs off.
   *
   * It defaults to the last record of the dropped prefix, the way the target's
   * boundary line points at the last pre-compact message. The last dropped
   * record is not necessarily a **message**: a transcript may hold a
   * `provider_event` or a `permission_request` at that place, and the reader
   * locates the boundary on the branch's parent chain, whatever the kind of
   * the record is.
   */
  parentId?: string;
}

/**
 * Compact a list of records.
 *
 * The returned `events` are the **effective** list: the boundary marker,
 * followed by the last `keepLast` records. The marker is the only **new**
 * record — the tail is already in the file, and the transcript is append-only,
 * so the caller persists the marker and adopts the returned list as the
 * session's current records.
 *
 * The marker's `replacedFrom` is the **number of records** the dropped prefix
 * held; the marker's `parentId` names the **record** the boundary sits on.
 * A reader locates the boundary by the link, never by the count.
 */
export function compact(
  events: SessionEvent[],
  opts: CompactOptions,
): { events: SessionEvent[]; summary: string | undefined } {
  const keepLast = Number.isFinite(opts.keepLast) ? Math.max(0, Math.floor(opts.keepLast)) : 0;

  if (keepLast >= events.length) {
    // Nothing would be dropped: there is no prefix to summarize, so there is
    // no boundary to mark.
    return { events: [...events], summary: undefined };
  }

  const summary = opts.summary;
  if (summary === undefined) {
    // The summary is produced by the provider and passed in. Without one there
    // is no marker, and the records are left alone rather than dropped.
    return { events: [...events], summary: undefined };
  }

  const replacedFrom = events.length - keepLast;
  const tail = events.slice(replacedFrom);

  const lastDropped = events[replacedFrom - 1];
  const parentId = opts.parentId ?? lastDropped?.id;

  const marker: SessionEvent = {
    v: SESSION_SCHEMA_VERSION,
    t: 'compaction',
    ts: opts.ts ?? Date.now(),
    id: opts.id ?? randomUUID(),
    summary,
    replacedFrom,
    ...(parentId === undefined ? {} : { parentId }),
  };

  return { events: [marker, ...tail], summary };
}

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
   * boundary line points at the last pre-compact message.
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

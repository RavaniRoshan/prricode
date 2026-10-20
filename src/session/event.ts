/**
 * The session event vocabulary, this implementation's own record version, and the guards
 * that read a record back.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.6 (Sessions,
 * persistence, and resumption) and the `CC-009` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## This implementation's record format is this implementation's own, and it is versioned
 *
 * The target states outright that its session-record format is **internal and
 * changes between versions** (Global Constraints; audit §2.6 records the layout,
 * the transcript classifier, the two transcript sources and the carried-prompt
 * vocabulary, but never the record shape). Two consequences follow, and the
 * implementation takes both seriously:
 *
 *   1. This implementation does **not** claim byte-compatibility with the target's
 *      records. The observable part of the target's session surface is the
 *      *layout* — JSONL under a `projects` subtree of the configuration root, at
 *      `<project>/<sessionId>.jsonl` — and this implementation reproduces that.
 *   2. This implementation's format carries its **own version**, and a reader **refuses** a
 *      version it does not know rather than dropping the record.
 *
 * ### The version policy
 *
 * - `SESSION_SCHEMA_VERSION` is the version this build writes and reads.
 * - **Every record carries its own `v`.** A format change is therefore visible
 *   *per record*: a file that mixes versions is detected at the first record that
 *   differs, not at the file's first line.
 * - A record whose `v` is not the supported version is **refused**: the reader
 *   raises `SessionVersionError`, which names the version it found and the
 *   version it supports. The record is never dropped silently — a silently
 *   dropped record is a silently corrupted conversation.
 * - **Migration path.** The file is append-only, so a migration is a *reader*
 *   concern and a rewrite into the new version, never an in-place edit. A future
 *   version `N+1` must ship a reader that either understands version `N` and
 *   migrates it, or refuses it with the same error. Version `1` is the initial
 *   format; there is no version `0`, and there is no "unversioned" record.
 *
 * ### The per-record version check, and what a refusal does
 *
 * The check runs in **two** places, and both refuse rather than repair:
 *
 * 1. **The reader** (`src/session/store.ts`) checks the version of every
 *    record it reads, *before* the shape of the record is looked at, so a
 *    record that is both the wrong version and the wrong shape is reported as
 *    the version problem it is. The check is per record, not per file: a file
 *    whose first record is version `1` and whose third record is version `3` is
 *    refused at the third record. A record of an unknown version is refused
 *    **wherever it sits** in the file — a torn *final* line is tolerated, a
 *    record of an unknown version never is.
 * 2. **The resume boundary** (`src/session/resume.ts`) checks the version of
 *    every record it is handed, because a resume can be handed a list that did
 *    not come from the store.
 *
 * A refusal is a raised `SessionVersionError`, never a skipped record. The
 * error names the version that was found and the version that is supported, so
 * the operator can tell "this file is from a newer build" from "this file is
 * corrupt". The reader does not skip the record and carry on: a partially
 * read transcript is worse than a refused one, because the part that was read
 * looks complete.
 *
 * ### What a version covers
 *
 * The version covers the **record**: its members, their types, and the
 * vocabulary of kinds. Version `1` carries the eight kinds below; the members
 * this file adds on top of the plan's seven (`parentId` and the
 * `content_replacement` kind) are part of version `1` as well, because they
 * were introduced with it. A change to the vocabulary — a new kind, a new
 * member, a member that changes its meaning — is a change of the **version**,
 * and it is written as such: `SESSION_SCHEMA_VERSION` moves to `2`, the reader
 * of version `1` either understands the new record or refuses it, and the
 * migration is a rewrite of the file into the new version. The file is
 * append-only, so a migration never edits a record in place: it writes a new
 * file and replaces the old one, which is the only way a transcript stays
 * consistent with itself.
 *
 * ### What is *not* claimed here
 *
 * The **compaction boundary model** — a marker record that names the summary of
 * the prefix it replaces, with the prefix *skipped* on read rather than deleted
 * from the file — is a **implementation design**. The target's boundary model is
 * *inference*: it comes from third-party analysis of the target's transcript
 * format, not from the pinned binary (Global Constraints). This implementation implements
 * its own boundary, and this header says so rather than claiming the target
 * verifies it. The same is true of the **branch selection** (index → newest
 * leaf → walk the parent chain backwards): the audit records the resume
 * algorithm as *partial*, so this implementation's rule is this implementation's.
 *
 * ## The members the plan fixes, and the ones this file adds
 *
 * The plan fixes the `SessionEvent` union's seven members and their field names.
 * This file adds, **additively**:
 *
 *   - a shared `parentId` — the record this one continues. The target's
 *     transcripts carry the same idea (`parentUuid` / `logicalParentUuid`), and
 *     without it a rewound branch cannot be told apart from the branch that was
 *     written last;
 *   - a `content_replacement` member, which the plan's own Step 13 requires
 *     ("a stub **plus** a content-replacement entry"). A replacement is a
 *     *separate record*: the transcript keeps the tool result's real content,
 *     and the replacement record names the record and the stub that stands in
 *     for it. A reader applies the replacement when it replays the transcript,
 *     so the payload is kept in the file and kept out of the context.
 */

import type { PermissionDecision } from '../permissions/decision.js';
import type { ProviderEvent } from '../provider/drivers/types.js';
import type { ToolResultEnvelope } from '../tools/runner.js';

/* -------------------------------------------------------------------------- */
/* The record version                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The version of this implementation's own session-record format.
 *
 * **Implementation-owned.** The target's record format is internal and changes between
 * versions, so this implementation versions its own independently. See the file header for
 * the policy and the migration path.
 */
export const SESSION_SCHEMA_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* The event vocabulary                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The stub that replaces an oversized tool result.
 *
 * This implementation stores a **stub** instead of the payload so that a large file read
 * cannot blow the context window when the session is resumed.
 *
 * **The stub's wire form is a implementation choice.** The audit pins that the
 * oversized payload does not come back into the context, and not what the stub
 * looks like on the wire: the discriminator, the byte count and the notice are
 * this implementation's own. The stub reaches the model on **every** path that puts a
 * tool result into a context — the **within-turn** push of a running turn
 * (`src/agent/loop.ts`), the **between-turns** load and the **cross-turn**
 * projection — and all of them carry this same shape.
 */
export interface ToolResultStub {
  /** The discriminator of a stub. */
  type: 'tool_result_stub';
  /** The size of the content the stub replaced, in bytes. */
  originalBytes: number;
  /** A human-readable notice. */
  message: string;
}

/**
 * The members every record carries.
 *
 * `parentId` is the record this one continues. It is **optional**: a log that
 * carries no parent links is a single chain, and the reader falls back to file
 * order for it.
 */
export interface SessionEventBase {
  /** The record's version. Every record carries its own. */
  v: typeof SESSION_SCHEMA_VERSION;
  /** The record's timestamp, in epoch milliseconds. */
  ts: number;
  /** The record's id. */
  id: string;
  /**
   * The id of the record this one continues, when the log carries one.
   *
   * In a linear conversation that is the **previous** record. A rewind starts a
   * new chain from the record the user rewound to, so the abandoned branch
   * stays in the file and is pruned when the session is resumed.
   */
  parentId?: string;
}

/**
 * One record of a session transcript.
 *
 * The first seven members are the plan's, verbatim. The eighth
 * (`content_replacement`) is the additive member the plan's Step 13 requires.
 */
export type SessionEvent =
  | (SessionEventBase & { t: 'user_message'; text: string })
  | (SessionEventBase & { t: 'assistant_message'; text: string })
  | (SessionEventBase & { t: 'tool_call'; name: string; input: unknown })
  | (SessionEventBase & { t: 'tool_result'; envelope: ToolResultEnvelope })
  | (SessionEventBase & { t: 'provider_event'; event: ProviderEvent })
  | (SessionEventBase & { t: 'permission_request'; toolName: string; decision?: PermissionDecision })
  | (SessionEventBase & { t: 'compaction'; summary: string; replacedFrom: number })
  | (SessionEventBase & {
      t: 'content_replacement';
      /** The id of the record whose content was replaced. */
      targetId: string;
      /** The stub that replaced the content. */
      replacement: ToolResultStub;
    });

/** The kinds of record a transcript can hold. */
export const SESSION_EVENT_KINDS = [
  'user_message',
  'assistant_message',
  'tool_call',
  'tool_result',
  'provider_event',
  'permission_request',
  'compaction',
  'content_replacement',
] as const;

/** One kind of record. */
export type SessionEventKind = (typeof SESSION_EVENT_KINDS)[number];

/**
 * The kinds that are **messages** — the records a conversation is made of.
 *
 * A `provider_event` is the raw stream, a `permission_request` is the log of an
 * approval, a `compaction` is a boundary marker and a `content_replacement` is a
 * marker as well: none of them is a message, and none of them can be the leaf
 * of a branch.
 */
export const MESSAGE_EVENT_KINDS: readonly SessionEventKind[] = Object.freeze([
  'user_message',
  'assistant_message',
  'tool_call',
  'tool_result',
]);

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/** Where a record came from, for an error message. */
export interface SessionRecordContext {
  /** The file the record was read from. */
  path?: string;
  /** The one-based line the record was read from. */
  line?: number;
}

function where(context: SessionRecordContext): string {
  if (context.path !== undefined && context.line !== undefined) {
    return `${context.path}:${context.line}`;
  }
  if (context.path !== undefined) return context.path;
  if (context.line !== undefined) return `line ${context.line}`;
  return 'the session record';
}

/**
 * A record the reader cannot read.
 *
 * It is raised for a record that is structurally wrong — a missing field, a
 * wrong type, a line that is not a JSON object. A **torn** final line is not an
 * error: the reader discards it.
 */
export class SessionFormatError extends Error {
  /** The file the record was read from, when it is known. */
  readonly path: string | undefined;
  /** The one-based line the record was read from, when it is known. */
  readonly line: number | undefined;

  constructor(message: string, context: SessionRecordContext = {}) {
    super(`${where(context)}: ${message}`);
    this.name = 'SessionFormatError';
    this.path = context.path;
    this.line = context.line;
  }
}

/**
 * A record whose version this build does not know.
 *
 * The error **names the version it found and the version it supports**, and the
 * record is never dropped: a transcript whose version changed cannot be read
 * safely, and a partially-read transcript is worse than a refused one.
 */
export class SessionVersionError extends Error {
  /** The version the record carried, when it carried one at all. */
  readonly found: number | undefined;
  /** The version this build supports. */
  readonly supported: number;
  /** The file the record was read from, when it is known. */
  readonly path: string | undefined;
  /** The one-based line the record was read from, when it is known. */
  readonly line: number | undefined;

  constructor(found: number | undefined, supported: number, context: SessionRecordContext = {}) {
    super(
      found === undefined
        ? `${where(context)}: the session record carries no version, but this build supports version ${supported}.`
        : `${where(context)}: the session record has version ${found}, but this build supports version ${supported}.`,
    );
    this.name = 'SessionVersionError';
    this.found = found;
    this.supported = supported;
    this.path = context.path;
    this.line = context.line;
  }
}

/* -------------------------------------------------------------------------- */
/* Small own-property helpers                                                  */
/* -------------------------------------------------------------------------- */

/** Whether a value is a plain object (not an array, not `null`). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read an own string member.
 *
 * **Own-property** on purpose: a member name in a record is caller-supplied
 * data, and `Object.prototype` carries members called `constructor`, `toString`
 * and `__proto__`. A bare index would resolve one of those instead of reporting
 * "absent".
 */
export function ownString(record: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** Read an own finite number member. */
export function ownNumber(record: Record<string, unknown>, key: string): number | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Read an own boolean member. */
export function ownBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

/* -------------------------------------------------------------------------- */
/* Reading a record back                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Read one record back.
 *
 * The **version guard** is the first thing that runs: a record whose version
 * this build does not know is refused with a `SessionVersionError` that names
 * the version found and the version supported. The guard runs before the shape
 * check, so a record that is both the wrong version and the wrong shape is
 * reported as the version problem it is.
 */
export function parseSessionEvent(
  value: unknown,
  context: SessionRecordContext = {},
): SessionEvent {
  if (!isRecord(value)) {
    throw new SessionFormatError('the record is not a JSON object', context);
  }

  const version = ownNumber(value, 'v');
  if (version === undefined) {
    throw new SessionVersionError(undefined, SESSION_SCHEMA_VERSION, context);
  }
  if (version !== SESSION_SCHEMA_VERSION) {
    throw new SessionVersionError(version, SESSION_SCHEMA_VERSION, context);
  }

  const kind = ownString(value, 't');
  if (kind === undefined) {
    throw new SessionFormatError('the record carries no "t" member', context);
  }
  if (!isSessionEventKind(kind)) {
    throw new SessionFormatError(`the record has the unknown kind "${kind}"`, context);
  }

  const ts = ownNumber(value, 'ts');
  if (ts === undefined) {
    throw new SessionFormatError('the record carries no numeric "ts" member', context);
  }
  const id = ownString(value, 'id');
  if (id === undefined || id === '') {
    throw new SessionFormatError('the record carries no "id" member', context);
  }
  const parentId = ownString(value, 'parentId');

  const base: SessionEventBase = parentId === undefined
    ? { v: SESSION_SCHEMA_VERSION, ts, id }
    : { v: SESSION_SCHEMA_VERSION, ts, id, parentId };

  switch (kind) {
    case 'user_message': {
      const text = ownString(value, 'text');
      if (text === undefined) {
        throw new SessionFormatError('a user_message carries no "text" member', context);
      }
      return { ...base, t: 'user_message', text };
    }
    case 'assistant_message': {
      const text = ownString(value, 'text');
      if (text === undefined) {
        throw new SessionFormatError('an assistant_message carries no "text" member', context);
      }
      return { ...base, t: 'assistant_message', text };
    }
    case 'tool_call': {
      const name = ownString(value, 'name');
      if (name === undefined || name === '') {
        throw new SessionFormatError('a tool_call carries no "name" member', context);
      }
      if (!Object.hasOwn(value, 'input')) {
        throw new SessionFormatError('a tool_call carries no "input" member', context);
      }
      return { ...base, t: 'tool_call', name, input: value['input'] };
    }
    case 'tool_result': {
      const envelope = ownRecordOf(value, 'envelope');
      if (envelope === undefined) {
        throw new SessionFormatError('a tool_result carries no "envelope" member', context);
      }
      const toolUseId = ownString(envelope, 'toolUseId');
      if (toolUseId === undefined || toolUseId === '') {
        throw new SessionFormatError('a tool_result envelope carries no "toolUseId" member', context);
      }
      if (ownBoolean(envelope, 'isError') === undefined) {
        throw new SessionFormatError('a tool_result envelope carries no "isError" member', context);
      }
      return { ...base, t: 'tool_result', envelope: envelope as unknown as ToolResultEnvelope };
    }
    case 'provider_event': {
      const event = ownRecordOf(value, 'event');
      if (event === undefined) {
        throw new SessionFormatError('a provider_event carries no "event" member', context);
      }
      const type = ownString(event, 'type');
      if (type === undefined) {
        throw new SessionFormatError('a provider_event carries no event "type" member', context);
      }
      return { ...base, t: 'provider_event', event: event as unknown as ProviderEvent };
    }
    case 'permission_request': {
      const toolName = ownString(value, 'toolName');
      if (toolName === undefined || toolName === '') {
        throw new SessionFormatError('a permission_request carries no "toolName" member', context);
      }
      const decision = ownRecordOf(value, 'decision');
      return decision === undefined
        ? { ...base, t: 'permission_request', toolName }
        : { ...base, t: 'permission_request', toolName, decision: decision as unknown as PermissionDecision };
    }
    case 'compaction': {
      const summary = ownString(value, 'summary');
      if (summary === undefined) {
        throw new SessionFormatError('a compaction carries no "summary" member', context);
      }
      const replacedFrom = ownNumber(value, 'replacedFrom');
      if (replacedFrom === undefined) {
        throw new SessionFormatError('a compaction carries no numeric "replacedFrom" member', context);
      }
      return { ...base, t: 'compaction', summary, replacedFrom };
    }
    case 'content_replacement': {
      const targetId = ownString(value, 'targetId');
      if (targetId === undefined || targetId === '') {
        throw new SessionFormatError('a content_replacement carries no "targetId" member', context);
      }
      const replacement = ownRecordOf(value, 'replacement');
      if (replacement === undefined) {
        throw new SessionFormatError('a content_replacement carries no "replacement" member', context);
      }
      const stub = readStub(replacement);
      return { ...base, t: 'content_replacement', targetId, replacement: stub };
    }
    default:
      // Unreachable: the kind was checked against the closed list above.
      throw new SessionFormatError(`the record has the unknown kind "${kind}"`, context);
  }
}

/** Read an own object member. */
function ownRecordOf(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

/** Whether a kind is one of the closed kinds. */
export function isSessionEventKind(kind: string): kind is SessionEventKind {
  return (SESSION_EVENT_KINDS as readonly string[]).includes(kind);
}

/** Read a stub back. */
function readStub(record: Record<string, unknown>): ToolResultStub {
  const originalBytes = ownNumber(record, 'originalBytes') ?? 0;
  const message = ownString(record, 'message') ?? 'The tool result was replaced by a stub.';
  return { type: 'tool_result_stub', originalBytes, message };
}

/* -------------------------------------------------------------------------- */
/* Small predicates the other session modules share                            */
/* -------------------------------------------------------------------------- */

/** Whether a record is a **message** — a record a conversation is made of. */
export function isMessageEvent(event: SessionEvent): boolean {
  return (MESSAGE_EVENT_KINDS as readonly string[]).includes(event.t);
}

/**
 * The tool-use id a record answers, when it answers one.
 *
 * A `tool_result` answers the tool use named by its envelope's `toolUseId`. The
 * lookup is a plain read of a **known** member, not of a caller-supplied key.
 */
export function answeredToolUseId(event: SessionEvent): string | undefined {
  if (event.t !== 'tool_result') return undefined;
  const id = event.envelope?.toolUseId;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** The tool-use id a record asks for, when it asks for one. */
export function requestedToolUseId(event: SessionEvent): string | undefined {
  if (event.t !== 'tool_call') return undefined;
  return event.id;
}

/**
 * The session store: the append-only JSONL transcript, the transcript index, and
 * the carried-prompt store.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.6 (Sessions,
 * persistence, and resumption) and the `CC-009` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## The storage layout
 *
 * **Observed** (audit §2.6): the target's configuration root is `~/.claude` and
 * it holds a `projects` subtree; a path classifier returns `"session_transcript"`
 * for a `.jsonl` path under `/projects/`. This implementation reproduces the layout:
 *
 * ```
 * <configDir>/projects/<encoded-cwd>/<sessionId>.jsonl
 * ```
 *
 * one file per session, **one JSON object per line**, append-only. The project
 * directory name is the working directory's path with every non-alphanumeric
 * character replaced by `-`; a name longer than 200 characters is truncated and
 * a hash of the **full** path is appended, so two long paths that share a
 * prefix cannot collide.
 *
 * ## The transcript is append-only
 *
 * Nothing in this module ever rewrites a record. A compaction **skips** a
 * prefix when the session is read; it does not delete it, because a transcript
 * that can replay a preserved tail is worth more than a small file. The
 * carried-prompt store follows the same rule: a delivery is recorded by
 * **appending** an updated row, and the last row for an id wins.
 *
 * ## A torn final line is discarded
 *
 * A process killed mid-append leaves a partial line at the end of the file. The
 * reader discards that line rather than failing or half-parsing it — but only
 * the **last** line: a corrupt line in the middle of a file is a real error and
 * is raised, because a silently skipped middle record is a silently corrupted
 * conversation. The **version guard** runs before the torn-line tolerance: a
 * record whose version this build does not know is refused with a
 * `SessionVersionError` whatever its position in the file.
 *
 * ## Implementation choices
 *
 * The audit does not pin these, so they are marked here:
 *
 *   - The **hash** in a truncated project directory name is a SHA-256 prefix.
 *   - The **oversized-tool-result limit** is 256 KiB of serialized content. The
 *     audit records that the target replaces oversized tool output with a stub
 *     and a content-replacement entry, but not the threshold.
 *   - The **carried-prompt file** is `<configDir>/carried-prompts.jsonl`. The
 *     audit records that the target "reads a file, parses prompts, filters out
 *     prompts marked `perhapsDelivered`" but not where the file lives.
 *   - The **carried-prompt age limit** is one hour.
 *   - The carried-prompt **outcome semantics** are this implementation's reading of the
 *     vocabulary the audit records. The audit names the seven outcomes and
 *     nothing else, so the mapping is documented rather than claimed.
 */

import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  SESSION_SCHEMA_VERSION,
  SessionFormatError,
  SessionVersionError,
  isMessageEvent,
  parseSessionEvent,
  type SessionEvent,
  type SessionRecordContext,
  type ToolResultStub,
} from './event.js';
import type { ToolResultEnvelope } from '../tools/runner.js';

export { SessionFormatError, SessionVersionError } from './event.js';

/* -------------------------------------------------------------------------- */
/* The layout                                                                  */
/* -------------------------------------------------------------------------- */

/** The longest a project directory name may be. */
export const MAX_PROJECT_DIRECTORY_LENGTH = 200;

/** How many characters of the path's hash a truncated name carries. */
export const PROJECT_DIRECTORY_HASH_LENGTH = 16;

/**
 * The project directory name of a working directory.
 *
 * Every non-alphanumeric character of the path becomes a `-`, so `/home/u/p`
 * becomes `-home-u-p`. A name longer than `MAX_PROJECT_DIRECTORY_LENGTH` is
 * truncated and a hash of the **full** path is appended — the hash is of the
 * untruncated path, so two paths that share a prefix still get different names.
 */
export function projectDirectoryName(cwd: string): string {
  const encoded = cwd.replace(/[^A-Za-z0-9]/g, '-');
  if (encoded.length <= MAX_PROJECT_DIRECTORY_LENGTH) return encoded;
  const digest = createHash('sha256').update(cwd, 'utf8').digest('hex').slice(0, PROJECT_DIRECTORY_HASH_LENGTH);
  const keep = Math.max(0, MAX_PROJECT_DIRECTORY_LENGTH - digest.length - 1);
  return `${encoded.slice(0, keep)}-${digest}`;
}

/** The project directory of a working directory, under a configuration root. */
export function projectDirectoryFor(configDir: string, cwd: string): string {
  return path.join(path.resolve(configDir), 'projects', projectDirectoryName(cwd));
}

/**
 * The configuration root the target keeps its state in.
 *
 * **Observed** (audit §2.6): the target's storage root is `~/.claude`, and it
 * holds a `projects` subtree among fifty-five others. This implementation reproduces the
 * root and the subtree; the rest of the target's layout is not part of the
 * implementation's session surface.
 */
export function defaultConfigDir(): string {
  return path.join(homedir(), '.claude');
}

/**
 * A session id that may be used as a file name.
 *
 * A session id is **caller-supplied**, so it is validated before it becomes a
 * path: it must start with an alphanumeric character and may then carry
 * alphanumerics, `.`, `_` and `-`. A path separator, a `..` segment or a name
 * that starts with a dot is refused, so a session id can never escape the
 * project directory.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Check a session id and return it.
 *
 * @throws when the id is not usable as a file name.
 */
export function assertValidSessionId(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(
      `The session id '${sessionId}' is not usable as a file name; it must start with a letter or a digit and may then carry letters, digits, '.', '_' and '-'.`,
    );
  }
  return sessionId;
}

/** The path of a session's transcript. */
export function sessionFilePath(configDir: string, cwd: string, sessionId: string): string {
  return path.join(projectDirectoryFor(configDir, cwd), `${assertValidSessionId(sessionId)}.jsonl`);
}

/* -------------------------------------------------------------------------- */
/* The store                                                                   */
/* -------------------------------------------------------------------------- */

/** A handle on one session's transcript. */
export interface SessionHandle {
  /** The session's id. */
  sessionId: string;
  /** The transcript's path. */
  path: string;
}

/** One row of the session index. */
export interface SessionSummary {
  /** The session's id. */
  sessionId: string;
  /** The transcript's path. */
  path: string;
  /** The timestamp of the session's first record. */
  startedAt: number;
  /** The timestamp of the session's last record. */
  updatedAt: number;
  /** How many message records the session holds. */
  messageCount: number;
  /**
   * The error the store ran into while reading the transcript, when it ran into
   * one.
   *
   * A transcript that cannot be read is **listed with its error** rather than
   * hidden: a session that exists must not vanish from the index because its
   * format changed.
   */
  error?: string;
}

/** The store's contract. */
export interface SessionStore {
  /** Create a session — or open an existing one, when the id is given. */
  create(opts: { cwd: string; sessionId?: string }): Promise<SessionHandle>;
  /** Append one record. The transcript is never rewritten. */
  append(handle: SessionHandle, event: SessionEvent): Promise<void>;
  /** Read the records back, in order. */
  read(handle: SessionHandle): AsyncIterable<SessionEvent>;
  /** The sessions of a working directory, newest first. */
  list(opts: { cwd: string; limit?: number }): Promise<SessionSummary[]>;
}

/** The options a store is built with. */
export interface SessionStoreOptions {
  /** The configuration root the `projects` subtree lives in. */
  configDir: string;
  /**
   * The largest tool-result content, in bytes, that is stored verbatim.
   *
   * A larger content is stored as a **stub** plus a content-replacement record.
   */
  maxToolResultBytes?: number;
  /** The clock. */
  now?: () => number;
  /** The id factory for the records the store writes. */
  idFactory?: () => string;
}

/**
 * The default oversized-tool-result limit.
 *
 * **Implementation choice.** 256 KiB of serialized content.
 */
export const DEFAULT_MAX_TOOL_RESULT_BYTES = 256 * 1024;

/** The message of a thrown value. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Whether an error is a "not found". */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * The size of a value, in bytes, as it would be serialized.
 *
 * A value that cannot be serialized has no size as far as the transcript is
 * concerned: it is reported as infinitely large, so it is replaced by a stub
 * rather than breaking the append.
 */
export function serializedSize(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return 0;
    return Buffer.byteLength(text, 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Read a transcript back.
 *
 * The reader yields the records in file order. A **torn final line** — a line
 * that is not valid JSON, or that is not a well-formed record — is discarded;
 * a corrupt line anywhere else is raised. A record whose version this build does
 * not know is **always** raised, wherever it sits in the file.
 */
export async function* readSessionFile(
  filePath: string,
): AsyncGenerator<SessionEvent, void, undefined> {
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.split('\n');
  // A trailing newline leaves an empty last element; it is not a record.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (line.trim() === '') continue;

    const isLast = index === lines.length - 1;
    const context: SessionRecordContext = { path: filePath, line: index + 1 };

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (isLast) return;
      throw new SessionFormatError('the line is not valid JSON', context);
    }

    let event: SessionEvent;
    try {
      event = parseSessionEvent(parsed, context);
    } catch (error) {
      // A version this build does not know is refused whatever its position.
      if (error instanceof SessionVersionError) throw error;
      if (isLast) return;
      throw error;
    }

    yield event;
  }
}

/** Read a whole transcript into an array. */
export async function readAllSessionEvents(filePath: string): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of readSessionFile(filePath)) events.push(event);
  return events;
}

/**
 * Create a store.
 *
 * The store holds the configuration root, so the layout has one source of truth
 * and a caller cannot point two transcripts at two different roots by accident.
 */
export function createSessionStore(options: SessionStoreOptions): SessionStore {
  const configDir = path.resolve(options.configDir);
  const maxToolResultBytes = options.maxToolResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES;
  const now = options.now ?? (() => Date.now());
  const idFactory = options.idFactory ?? (() => randomUUID());

  /**
   * The records an append writes.
   *
   * A tool result whose serialized content is over the limit is written as a
   * **stub**, and the stub is accompanied by a **content-replacement record**:
   * the stored record carries the stub, and the replacement record says which
   * record was replaced and with what.
   */
  function recordsFor(event: SessionEvent): SessionEvent[] {
    if (event.t !== 'tool_result') return [event];
    const envelope: ToolResultEnvelope | undefined = event.envelope;
    if (envelope === undefined) return [event];
    const bytes = serializedSize(envelope.content);
    if (bytes <= maxToolResultBytes) return [event];

    const stub: ToolResultStub = {
      type: 'tool_result_stub',
      originalBytes: Number.isFinite(bytes) ? bytes : 0,
      message: `The tool result was ${Number.isFinite(bytes) ? bytes : 'of an unknown size'} bytes and was replaced by a stub; the full output is not part of the context.`,
    };
    const replacement: SessionEvent = {
      v: SESSION_SCHEMA_VERSION,
      t: 'content_replacement',
      ts: event.ts,
      id: idFactory(),
      targetId: event.id,
      replacement: stub,
    };
    return [
      { ...event, envelope: { ...envelope, content: stub } },
      replacement,
    ];
  }

  return {
    async create(opts: { cwd: string; sessionId?: string }): Promise<SessionHandle> {
      const sessionId = assertValidSessionId(opts.sessionId ?? randomUUID());
      const directory = projectDirectoryFor(configDir, opts.cwd);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const filePath = path.join(directory, `${sessionId}.jsonl`);
      // Touch the file so that the transcript exists before the first append.
      await appendFile(filePath, '', 'utf8');
      return { sessionId, path: filePath };
    },

    async append(handle: SessionHandle, event: SessionEvent): Promise<void> {
      const payload = recordsFor(event)
        .map((record) => `${JSON.stringify(record)}\n`)
        .join('');
      await appendFile(handle.path, payload, 'utf8');
    },

    read(handle: SessionHandle): AsyncIterable<SessionEvent> {
      return readSessionFile(handle.path);
    },

    async list(opts: { cwd: string; limit?: number }): Promise<SessionSummary[]> {
      const directory = projectDirectoryFor(configDir, opts.cwd);
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }

      const summaries: SessionSummary[] = [];
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const filePath = path.join(directory, name);
        const sessionId = name.slice(0, name.length - '.jsonl'.length);
        try {
          const events = await readAllSessionEvents(filePath);
          summaries.push(summarize(sessionId, filePath, events));
        } catch (error) {
          const details = await stat(filePath).catch(() => undefined);
          summaries.push({
            sessionId,
            path: filePath,
            startedAt: 0,
            updatedAt: details?.mtimeMs ?? 0,
            messageCount: 0,
            error: messageOf(error),
          });
        }
      }

      summaries.sort((left, right) => right.updatedAt - left.updatedAt);
      const limit = opts.limit;
      return limit === undefined ? summaries : summaries.slice(0, Math.max(0, limit));
    },
  };
}

/** Summarize a transcript. */
function summarize(sessionId: string, filePath: string, events: SessionEvent[]): SessionSummary {
  let startedAt = 0;
  let updatedAt = 0;
  let messageCount = 0;
  for (const event of events) {
    if (startedAt === 0) startedAt = event.ts;
    updatedAt = event.ts;
    if (isMessageEvent(event)) messageCount += 1;
  }
  return { sessionId, path: filePath, startedAt, updatedAt, messageCount };
}

/* -------------------------------------------------------------------------- */
/* The carried prompts                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The outcomes a carried prompt can have.
 *
 * The vocabulary is the target's, as the audit records it. The audit names the
 * seven outcomes and nothing more, so the **semantics** below are this implementation's
 * reading of them:
 *
 *   - `no_row` — nothing is stored for this id in this session's binding: the
 *     row is absent, or it is bound to another session;
 *   - `job_has_run` — the row's job has already run;
 *   - `too_old` — the row is older than the age limit;
 *   - `future_dated` — the row is dated in the future;
 *   - `sent` — the prompt has already been delivered;
 *   - `altered` — the prompt was altered after it was persisted, and the
 *     altered text is what is returned;
 *   - `bound` — the row is bound to this session and is taken as it stands.
 */
export type CarriedPromptOutcome =
  | 'sent'
  | 'bound'
  | 'altered'
  | 'no_row'
  | 'job_has_run'
  | 'too_old'
  | 'future_dated';

/**
 * The telemetry event the target emits when a carried prompt is taken.
 *
 * **Observed** (audit §2.6): "with a `tengu_carried_prompts_taken` telemetry
 * event".
 */
export const CARRIED_PROMPT_TELEMETRY_EVENT = 'tengu_carried_prompts_taken';

/** One persisted prompt. */
export interface CarriedPromptRow {
  /** The prompt's id. */
  id: string;
  /** The session the prompt is bound to. */
  sessionId: string;
  /** The prompt's text. */
  prompt: string;
  /** When the prompt was persisted, in epoch milliseconds. */
  createdAt: number;
  /** Whether the prompt was altered after it was persisted. */
  altered?: boolean;
  /** Whether the row's job has already run. */
  jobHasRun?: boolean;
  /** Whether the prompt may already have been delivered. */
  perhapsDelivered?: boolean;
  /** When the prompt was delivered, in epoch milliseconds. */
  deliveredAt?: number;
}

/** The options a take runs with. */
export interface CarriedPromptTakeOptions {
  /** The prompt's id. */
  id: string;
  /** The session that asks for the prompt. */
  sessionId: string;
  /** The clock. */
  now?: number;
  /** The age limit, in milliseconds. */
  maxAgeMs?: number;
}

/** The result of a take. */
export interface CarriedPromptTakeResult {
  /** What happened to the row. */
  outcome: CarriedPromptOutcome;
  /** The row, when the prompt was taken. */
  prompt?: CarriedPromptRow;
  /** The telemetry event the target emits. */
  telemetry: typeof CARRIED_PROMPT_TELEMETRY_EVENT;
}

/** The carried-prompt store's contract. */
export interface CarriedPromptStore {
  /** Persist a prompt for a later process. */
  put(row: CarriedPromptRow): Promise<void>;
  /** Take a prompt for a later process, under the binding and age policy. */
  take(opts: CarriedPromptTakeOptions): Promise<CarriedPromptTakeResult>;
  /** The rows the store holds, the last row for an id winning. */
  rows(): Promise<CarriedPromptRow[]>;
}

/** The options a carried-prompt store is built with. */
export interface CarriedPromptStoreOptions {
  /** The configuration root the file lives in. */
  configDir: string;
  /** The default age limit, in milliseconds. */
  maxAgeMs?: number;
  /** The clock. */
  now?: () => number;
  /**
   * The telemetry sink.
   *
   * The target emits `tengu_carried_prompts_taken` when a carried prompt is
   * taken (audit §2.6), and this implementation emits the same event name with the
   * outcome attached. The sink is optional: a caller that has no telemetry
   * pipeline simply does not receive the event.
   */
  onTelemetry?: (event: {
    name: typeof CARRIED_PROMPT_TELEMETRY_EVENT;
    outcome: CarriedPromptOutcome;
    id: string;
  }) => void;
}

/**
 * The default age limit of a carried prompt.
 *
 * **Implementation choice.** One hour: a prompt is carried over to a process that
 * starts soon after the one that wrote it, not to the next day.
 */
export const DEFAULT_CARRIED_PROMPT_MAX_AGE_MS = 60 * 60 * 1000;

/** The file the carried prompts live in. */
export function carriedPromptsPath(configDir: string): string {
  return path.join(path.resolve(configDir), 'carried-prompts.jsonl');
}

/** Read a row back. */
function parseCarriedPrompt(value: unknown): CarriedPromptRow | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = Object.hasOwn(record, 'id') ? record['id'] : undefined;
  const sessionId = Object.hasOwn(record, 'sessionId') ? record['sessionId'] : undefined;
  const prompt = Object.hasOwn(record, 'prompt') ? record['prompt'] : undefined;
  const createdAt = Object.hasOwn(record, 'createdAt') ? record['createdAt'] : undefined;
  if (typeof id !== 'string' || id === '') return undefined;
  if (typeof sessionId !== 'string' || sessionId === '') return undefined;
  if (typeof prompt !== 'string') return undefined;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return undefined;

  const row: CarriedPromptRow = { id, sessionId, prompt, createdAt };
  if (record['altered'] === true) row.altered = true;
  if (record['jobHasRun'] === true) row.jobHasRun = true;
  if (record['perhapsDelivered'] === true) row.perhapsDelivered = true;
  const deliveredAt = record['deliveredAt'];
  if (typeof deliveredAt === 'number' && Number.isFinite(deliveredAt)) row.deliveredAt = deliveredAt;
  return row;
}

/**
 * Create the carried-prompt store.
 *
 * The file is **append-only**: a delivery is recorded by appending an updated
 * row, and the last row for an id wins.
 */
export function createCarriedPromptStore(options: CarriedPromptStoreOptions): CarriedPromptStore {
  const filePath = carriedPromptsPath(options.configDir);
  const defaultMaxAgeMs = options.maxAgeMs ?? DEFAULT_CARRIED_PROMPT_MAX_AGE_MS;
  const now = options.now ?? (() => Date.now());

  async function readRows(): Promise<CarriedPromptRow[]> {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const byId = new Map<string, CarriedPromptRow>();
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A torn final line is discarded, exactly as in the transcript.
        continue;
      }
      const row = parseCarriedPrompt(parsed);
      if (row === undefined) continue;
      byId.set(row.id, row);
    }
    return [...byId.values()];
  }

  async function writeRow(row: CarriedPromptRow): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await appendFile(filePath, `${JSON.stringify(row)}\n`, 'utf8');
  }

  return {
    async put(row: CarriedPromptRow): Promise<void> {
      await writeRow(row);
    },

    async take(opts: CarriedPromptTakeOptions): Promise<CarriedPromptTakeResult> {
      const at = opts.now ?? now();
      const maxAgeMs = opts.maxAgeMs ?? defaultMaxAgeMs;
      const rows = await readRows();
      const row = rows.find((candidate) => candidate.id === opts.id);

      const fail = (outcome: CarriedPromptOutcome): CarriedPromptTakeResult => {
        const result: CarriedPromptTakeResult = {
          outcome,
          telemetry: CARRIED_PROMPT_TELEMETRY_EVENT,
        };
        options.onTelemetry?.({ name: CARRIED_PROMPT_TELEMETRY_EVENT, outcome, id: opts.id });
        return result;
      };

      // The row is looked up **in this session's binding**: a row that belongs
      // to another session is not a row for this session.
      if (row === undefined || row.sessionId !== opts.sessionId) return fail('no_row');
      if (row.jobHasRun === true) return fail('job_has_run');
      if (row.createdAt > at) return fail('future_dated');
      if (at - row.createdAt > maxAgeMs) return fail('too_old');
      if (row.perhapsDelivered === true || row.deliveredAt !== undefined) return fail('sent');

      // The prompt is taken. The delivery is recorded by **appending** the
      // updated row: the transcript of the carried prompts is append-only too.
      const taken: CarriedPromptRow = {
        ...row,
        perhapsDelivered: true,
        deliveredAt: at,
      };
      await writeRow(taken);

      const outcome: CarriedPromptOutcome = row.altered === true ? 'altered' : 'bound';
      options.onTelemetry?.({ name: CARRIED_PROMPT_TELEMETRY_EVENT, outcome, id: opts.id });
      return {
        outcome,
        prompt: taken,
        telemetry: CARRIED_PROMPT_TELEMETRY_EVENT,
      };
    },

    async rows(): Promise<CarriedPromptRow[]> {
      return readRows();
    },
  };
}

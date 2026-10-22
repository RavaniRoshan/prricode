/**
 * The persistence — **three separate stores**, because they answer different
 * questions:
 *
 * - the **user interface's** preferences — the recent list, the favourites,
 *   and the overlay chosen for each model — written atomically, and **watched
 *   for edits made elsewhere**;
 * - the **durable** choice, on the session's own record;
 * - the **configuration's** model.
 *
 * The configuration's model is not a store here: it is one of the selection
 * sources, and the selection module reads it.
 *
 * See [`docs/protocol/MODEL-LAYER.md`](../../docs/protocol/MODEL-LAYER.md) §7.
 */

import { mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ModelRef } from './selection.js';
import { defineOwn } from './merge.js';

/** What the user interface remembers. */
export interface ModelPreferences {
  /** The models used recently, newest first. */
  readonly recent: readonly ModelRef[];
  /** The models marked as favourites. */
  readonly favorites: readonly ModelRef[];
  /** The overlay chosen for each model, keyed by `provider/model`. */
  readonly overlays: Readonly<Record<string, string>>;
}

/** Nothing remembered yet. */
export const EMPTY_PREFERENCES: ModelPreferences = Object.freeze({
  recent: [],
  favorites: [],
  overlays: {},
});

/** How many models the recent list keeps. */
export const RECENT_LIMIT = 10;

/**
 * How long the watcher waits for a write to settle before it reads.
 *
 * A write that is not atomic passes through a truncated file, and a truncated
 * file is not a change: the watcher waits, reads once, and compares.
 */
export const WATCH_SETTLE_MS = 30;

/** Whether a value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a model reference out of a payload. */
function readRef(value: unknown): ModelRef | undefined {
  if (!isRecord(value)) return undefined;
  const provider = value['provider'];
  const model = value['model'];
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined;
  const overlay = value['overlay'];
  return typeof overlay === 'string' ? { provider, model, overlay } : { provider, model };
}

/** Read a list of model references. */
function readRefs(value: unknown): readonly ModelRef[] {
  if (!Array.isArray(value)) return [];
  const refs: ModelRef[] = [];
  for (const entry of value) {
    const ref = readRef(entry);
    if (ref) refs.push(ref);
  }
  return refs;
}

/** Read the preferences out of a document's text. */
function readPreferences(text: string): ModelPreferences {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return EMPTY_PREFERENCES;
  }
  if (!isRecord(payload)) return EMPTY_PREFERENCES;
  const overlays: Record<string, string> = {};
  const raw = payload['overlays'];
  if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') defineOwn(overlays, key, value);
    }
  }
  return {
    recent: readRefs(payload['recent']).slice(0, RECENT_LIMIT),
    favorites: readRefs(payload['favorites']),
    overlays,
  };
}

/**
 * The user interface's preferences.
 *
 * The file is written **atomically** — a temporary file, then a rename — so a
 * reader never sees half a document, and the directory is watched so an edit
 * made elsewhere is picked up.
 */
export class ModelPreferenceStore {
  readonly #path: string;

  constructor(file: string) {
    this.#path = file;
  }

  /** The path the preferences live at. */
  get path(): string {
    return this.#path;
  }

  /** What is remembered. */
  read(): ModelPreferences {
    return readPreferences(this.#readText());
  }

  /** Remember something. The write is atomic. */
  write(preferences: ModelPreferences): void {
    const document = {
      recent: preferences.recent.slice(0, RECENT_LIMIT),
      favorites: preferences.favorites,
      overlays: { ...preferences.overlays },
    };
    const directory = path.dirname(this.#path);
    mkdirSync(directory, { recursive: true });
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporary, this.#path);
  }

  /**
   * Watch the preferences for an edit made elsewhere.
   *
   * The watcher reports only a **real** change: the file's text is read after
   * the write has settled, and compared with the text last seen, so the
   * truncated middle of a write is not mistaken for a change. The returned
   * function stops watching.
   */
  watch(listener: (preferences: ModelPreferences) => void): () => void {
    let last = this.#readText();
    let timer: NodeJS.Timeout | undefined;
    let watcher: FSWatcher;
    const settle = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        const text = this.#readText();
        if (text === last) return;
        last = text;
        listener(readPreferences(text));
      }, WATCH_SETTLE_MS);
      timer.unref?.();
    };
    try {
      watcher = watch(path.dirname(this.#path), (_event, filename) => {
        const name = filename === null ? undefined : filename.toString();
        if (name !== undefined && name !== path.basename(this.#path)) return;
        settle();
      });
    } catch {
      // A directory that cannot be watched is not a failure: the store still
      // reads and writes, and the caller is not woken for an edit it cannot see.
      return () => {};
    }
    return () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    };
  }

  /** The file's text, or an empty string when there is no file. */
  #readText(): string {
    try {
      return readFileSync(this.#path, 'utf8');
    } catch {
      return '';
    }
  }
}

// ---------------------------------------------------------------------------
// The durable choice, on the session's own record
// ---------------------------------------------------------------------------

/** A record a session keeps. */
export interface SessionRecordCarrier {
  /** Read a session's record. */
  read(sessionId: string): Promise<Record<string, unknown> | undefined>;
  /** Write a session's record. */
  write(sessionId: string, record: Record<string, unknown>): Promise<void>;
}

/**
 * The durable choice: the model a session is running against, kept on the
 * session's own record.
 */
export class DurableModelChoice {
  readonly #carrier: SessionRecordCarrier;

  constructor(carrier: SessionRecordCarrier) {
    this.#carrier = carrier;
  }

  /** The model the session last chose. */
  async read(sessionId: string): Promise<ModelRef | undefined> {
    const record = await this.#carrier.read(sessionId);
    if (!record) return undefined;
    return readRef(record['model']);
  }

  /** Remember the model the session is running against. */
  async write(sessionId: string, ref: ModelRef): Promise<void> {
    const record = (await this.#carrier.read(sessionId)) ?? {};
    await this.#carrier.write(sessionId, {
      ...record,
      model: {
        provider: ref.provider,
        model: ref.model,
        ...(ref.overlay === undefined ? {} : { overlay: ref.overlay }),
      },
    });
  }
}

/**
 * A carrier that keeps one record per session, in a directory.
 *
 * The write is atomic, exactly as the preferences' write is: a reader never
 * sees half a record.
 */
export function createFileSessionRecordCarrier(options: { readonly dir: string }): SessionRecordCarrier {
  const fileFor = (sessionId: string): string =>
    path.join(options.dir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);

  return {
    async read(sessionId: string): Promise<Record<string, unknown> | undefined> {
      let raw: string;
      try {
        raw = await readFile(fileFor(sessionId), 'utf8');
      } catch {
        return undefined;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        return isRecord(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
    async write(sessionId: string, record: Record<string, unknown>): Promise<void> {
      await mkdir(options.dir, { recursive: true });
      const file = fileFor(sessionId);
      const temporary = `${file}.tmp`;
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporary, file);
    },
  };
}

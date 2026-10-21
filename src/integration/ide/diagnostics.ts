/**
 * The **IDE diagnostics** subsystem: the shape of a diagnostic, the rule that
 * validates a diagnostics payload, the baseline that decides which
 * diagnostics are *new*, and the block the target renders for them.
 *
 * Evidence: the target's own source, read out of the pinned build and recorded
 * in `/home/shiva/opt/reference-agent-rea/analysis/findings-ide-integration.md`
 * — every claim there carries a file and a byte offset. The milestone is
 * `CC-036` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * | what | where in the target |
 * |---|---|
 * | the constants | `chunk-4jsg44k7.js:555600`+ |
 * | the manager | `chunk-4jsg44k7.js:555731`+ — `class rCt` |
 * | the baseline | `chunk-4jsg44k7.js:555731`+ — `beforeFileEdited(e)` |
 * | the fetch | `chunk-4jsg44k7.js:556998`+ — `getNewDiagnostics()` |
 * | the payload validation | `chunk-4jsg44k7.js:4021561` — `cHn(e)` |
 * | the rendering | `chunk-4jsg44k7.js:4021561`+ — `L7r(e)`, `UAe(e)` |
 * | the severity glyphs | `chunk-wb61d889.js:6706`–`:7401` |
 * | the timeout helper | `chunk-4g64c19v.js:1726` — `Lt(t, r, e)` |
 * | the timeout test | `chunk-w8r781a6.js:4626` — `yP(n, e)` |
 *
 * ## What the target's diagnostics are
 *
 * An IDE reports diagnostics as a list of **files**, and each file carries a
 * list of diagnostics. A diagnostic has a `message`, a `range` with a `start`
 * and an `end`, and optionally a `severity`, a `code` and a `source`.
 *
 * The subsystem keeps a **baseline** — the diagnostics a file had *before* the
 * agent edited it — and reports only the diagnostics that are **new**.
 *
 * ## The honest boundary
 *
 * The **shape** is implemented here: the severity vocabulary, the validation
 * rule, the baseline, the comparison, the rendering and the timeouts are all
 * the target's own.
 *
 * The **transport** is not: the target reaches the IDE through an MCP client
 * named `ide`, and this implementation has no IDE, no extension, no socket and
 * no diagnostics channel. So the request that would need that channel
 * **refuses**, and the refusal **names the capability** it needed.
 */

import path from 'node:path';

/* -------------------------------------------------------------------------- */
/* The constants                                                               */
/* -------------------------------------------------------------------------- */

/** The timeout of a single baseline request, in milliseconds. */
export const IDE_DIAGNOSTICS_BASELINE_TIMEOUT_MS = 500;

/** The timeout of a workspace-wide fetch, in milliseconds. */
export const IDE_DIAGNOSTICS_FETCH_TIMEOUT_MS = 2000;

/** How many consecutive baseline timeouts disable the baselines. */
export const IDE_DIAGNOSTICS_MAX_CONSECUTIVE_BASELINE_TIMEOUTS = 3;

/** The message a baseline timeout carries. */
export const IDE_DIAGNOSTICS_BASELINE_TIMEOUT_MESSAGE = 'IDE diagnostics baseline timed out';

/** The message a fetch timeout carries. */
export const IDE_DIAGNOSTICS_FETCH_TIMEOUT_MESSAGE = 'IDE diagnostics fetch timed out';

/** The message the target logs when the baselines are disabled. */
export const IDE_DIAGNOSTICS_BASELINES_DISABLED_MESSAGE =
  'IDE diagnostics baselines disabled after 3 consecutive timeouts';

/**
 * The MCP server names the target does **not** baseline.
 *
 * The target leaves exactly one server out of the baselines: the JetBrains
 * plugin's own server, which answers `getDiagnostics` itself.
 *
 * The plugin's server name **is** the target's product name with a suffix,
 * and this repository may not name the target's product — so the name is a
 * **parameter** here and not a literal. A caller that has the plugin in
 * front of it supplies the name; a caller that does not, supplies nothing
 * and every server is baselined.
 */
export const IDE_DIAGNOSTICS_EXCLUDED_SERVER_NAMES: readonly string[] = Object.freeze([]);

/** The uri prefixes the target normalises away. */
export const IDE_DIAGNOSTICS_URI_PREFIXES: readonly string[] = Object.freeze([
  'file://',
  '_claude_fs_right:',
  '_claude_fs_left:',
]);

/** The telemetry event a baseline emits. */
export const IDE_DIAGNOSTICS_BASELINE_EVENT = 'ide_diagnostics_baseline';

/** The telemetry event a fetch emits. */
export const IDE_DIAGNOSTICS_FETCH_EVENT = 'ide_diagnostics_fetch';

/* -------------------------------------------------------------------------- */
/* The refusals                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The capability an IDE request needs: a **running IDE** with the extension
 * or the plugin installed, and its transport listening.
 */
export const IDE_CONNECTION_CAPABILITY =
  'a running IDE with its extension or plugin installed';

/**
 * The capability a diagnostics request needs: a **connected IDE client**.
 */
export const IDE_DIAGNOSTICS_CAPABILITY = 'a connected IDE client';

/**
 * The capability an extension install needs: the **IDE's own command-line
 * launcher**.
 */
export const IDE_EXTENSION_INSTALL_CAPABILITY = "the IDE's own command-line launcher";

/**
 * A refusal that names the capability the operation needed.
 *
 * The target never refuses — it has the IDE. This implementation does not, so
 * the refusal is typed and it **names** the capability, so that a caller can
 * tell what is missing.
 */
export class IdeCapabilityError extends Error {
  /** The stable code of the refusal. */
  readonly code = 'ide_capability_unavailable';

  /** The capability the operation needed. */
  readonly capability: string;

  constructor(capability: string, operation: string) {
    super(
      `${operation} needs ${capability}, which this session does not have, so it was not attempted.`,
    );
    this.name = 'IdeCapabilityError';
    this.capability = capability;
  }
}

/* -------------------------------------------------------------------------- */
/* The shape                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The four severities a diagnostic may carry.
 *
 * The target's own table is keyed in lower case and holds **five** keys —
 * `error`, `warning`, `info`, `information` and `hint` — of which `info` and
 * `information` name the same severity.
 */
export const IDE_DIAGNOSTIC_SEVERITIES = ['Error', 'Warning', 'Info', 'Hint'] as const;

/** One of the four severities a diagnostic may carry. */
export type IdeDiagnosticSeverity = (typeof IDE_DIAGNOSTIC_SEVERITIES)[number];

/**
 * The target's own severity table, keyed in lower case.
 *
 * `information` and `info` are the same severity, so a diagnostic that says
 * `information` is reported as `Info`.
 */
const SEVERITY_BY_LOWER_CASE: Readonly<Record<string, IdeDiagnosticSeverity>> = Object.freeze({
  error: 'Error',
  warning: 'Warning',
  info: 'Info',
  information: 'Info',
  hint: 'Hint',
});

/**
 * The canonical severity for that value.
 *
 * The lookup is case-insensitive, and a severity outside the target's table is
 * **not** kept — it is dropped, so that a diagnostic carries a severity the
 * target would recognise or nothing at all.
 */
export function normalizeDiagnosticSeverity(value: unknown): IdeDiagnosticSeverity | undefined {
  if (typeof value !== 'string') return undefined;
  const lowered = value.toLowerCase();
  if (!Object.hasOwn(SEVERITY_BY_LOWER_CASE, lowered)) return undefined;
  return SEVERITY_BY_LOWER_CASE[lowered];
}

/** A position in a file. */
export interface IdeDiagnosticPosition {
  /** The zero-based line. */
  readonly line: number;
  /** The zero-based character. */
  readonly character: number;
}

/** A range in a file. */
export interface IdeDiagnosticRange {
  /** The start of the range. */
  readonly start: IdeDiagnosticPosition;
  /** The end of the range. */
  readonly end: IdeDiagnosticPosition;
}

/** One diagnostic. */
export interface IdeDiagnostic {
  /** The diagnostic's message. */
  readonly message: string;
  /** The severity, when the severity was one the target knows. */
  readonly severity?: IdeDiagnosticSeverity;
  /** The range the diagnostic covers. */
  readonly range: IdeDiagnosticRange;
  /** The diagnostic's code, when it is a string. */
  readonly code?: string;
  /** The diagnostic's source, when it is a string. */
  readonly source?: string;
}

/** The diagnostics of one file. */
export interface IdeDiagnosticFile {
  /** The file's uri. */
  readonly uri: string;
  /** The file's diagnostics. */
  readonly diagnostics: readonly IdeDiagnostic[];
}

/* -------------------------------------------------------------------------- */
/* The validation                                                              */
/* -------------------------------------------------------------------------- */

/** What the validation kept, and what it dropped. */
export interface IdeDiagnosticsValidation {
  /** The files that survived, with their normalized diagnostics. */
  readonly files: IdeDiagnosticFile[];
  /** How many files were dropped. */
  readonly droppedFiles: number;
  /** How many diagnostics were dropped. */
  readonly droppedDiagnostics: number;
  /** Whether the payload was not an array at all. */
  readonly droppedPayload: boolean;
}

/**
 * Validate a diagnostics payload, the way the target does.
 *
 * The target's own rule:
 *
 *   - a payload that is not an array is dropped whole;
 *   - a file is dropped when it is not an object, when its `uri` is not a
 *     string, or when its `diagnostics` is not an array;
 *   - a diagnostic is dropped when it is not an object, when its `message` is
 *     not a string, or when `range.start.line` or `range.start.character` is
 *     not a number;
 *   - a file whose diagnostics **all** drop out is itself dropped;
 *   - a surviving diagnostic is normalized: its severity is looked up
 *     case-insensitively and dropped when it is not one the target knows, its
 *     range end falls back to its start when it is not a pair of numbers, and
 *     its `code` and `source` are kept only when they are strings.
 */
export function validateDiagnosticsPayload(payload: unknown): IdeDiagnosticsValidation {
  if (!Array.isArray(payload)) {
    return { files: [], droppedFiles: 0, droppedDiagnostics: 0, droppedPayload: true };
  }

  const files: IdeDiagnosticFile[] = [];
  let droppedFiles = 0;
  let droppedDiagnostics = 0;

  for (const entry of payload) {
    if (typeof entry !== 'object' || entry === null) {
      droppedFiles++;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const uri = record['uri'];
    const rawDiagnostics = record['diagnostics'];
    if (typeof uri !== 'string' || !Array.isArray(rawDiagnostics)) {
      droppedFiles++;
      continue;
    }

    const diagnostics: IdeDiagnostic[] = [];
    for (const rawDiagnostic of rawDiagnostics) {
      if (typeof rawDiagnostic !== 'object' || rawDiagnostic === null) {
        droppedDiagnostics++;
        continue;
      }
      const diagnostic = rawDiagnostic as Record<string, unknown>;
      const message = diagnostic['message'];
      const range = diagnostic['range'];
      const start = typeof range === 'object' && range !== null
        ? (range as Record<string, unknown>)['start']
        : undefined;
      const startPosition =
        typeof start === 'object' && start !== null ? (start as Record<string, unknown>) : undefined;
      const line = startPosition?.['line'];
      const character = startPosition?.['character'];
      if (
        typeof message !== 'string' ||
        typeof line !== 'number' ||
        typeof character !== 'number'
      ) {
        droppedDiagnostics++;
        continue;
      }

      const severity = normalizeDiagnosticSeverity(diagnostic['severity']);
      const rawRange = range as Record<string, unknown> | undefined;
      const rawEnd = rawRange?.['end'];
      const endPosition =
        typeof rawEnd === 'object' && rawEnd !== null ? (rawEnd as Record<string, unknown>) : undefined;
      const endLine = endPosition?.['line'];
      const endCharacter = endPosition?.['character'];
      const resolvedEnd: IdeDiagnosticPosition =
        typeof endLine === 'number' && typeof endCharacter === 'number'
          ? { line: endLine, character: endCharacter }
          : { line, character };

      const code = diagnostic['code'];
      const source = diagnostic['source'];
      diagnostics.push({
        message,
        ...(severity === undefined ? {} : { severity }),
        range: { start: { line, character }, end: resolvedEnd },
        ...(typeof code === 'string' ? { code } : {}),
        ...(typeof source === 'string' ? { source } : {}),
      });
    }

    if (diagnostics.length === 0) {
      droppedFiles++;
      continue;
    }
    files.push({ uri, diagnostics });
  }

  return { files, droppedFiles, droppedDiagnostics, droppedPayload: false };
}

/* -------------------------------------------------------------------------- */
/* The comparison                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The key two diagnostics are compared by.
 *
 * The target's own key is the JSON of the diagnostic's message, severity,
 * source, code, and the four numbers of its range.
 */
export function diagnosticKey(diagnostic: IdeDiagnostic): string {
  return JSON.stringify([
    diagnostic.message,
    diagnostic.severity,
    diagnostic.source,
    diagnostic.code,
    diagnostic.range.start.line,
    diagnostic.range.start.character,
    diagnostic.range.end.line,
    diagnostic.range.end.character,
  ]);
}

/**
 * The diagnostics in `current` that are not in `baseline`.
 *
 * The target compares the two **as sets of keys**: a diagnostic that is in the
 * baseline is not new, whatever its position.
 */
export function newDiagnostics(
  baseline: readonly IdeDiagnostic[],
  current: readonly IdeDiagnostic[],
): IdeDiagnostic[] {
  const known = new Set(baseline.map((diagnostic) => diagnosticKey(diagnostic)));
  return current.filter((diagnostic) => !known.has(diagnosticKey(diagnostic)));
}

/* -------------------------------------------------------------------------- */
/* The rendering                                                               */
/* -------------------------------------------------------------------------- */

/** The glyph each severity is rendered with. */
export const IDE_DIAGNOSTICS_SEVERITY_GLYPHS: Readonly<Record<string, string>> = Object.freeze({
  Error: '✘',
  Warning: '⚠',
  Info: 'ℹ',
  Hint: '★',
});

/** The glyph a severity outside the four is rendered with. */
export const IDE_DIAGNOSTICS_FALLBACK_GLYPH = '●';

/** The longest the rendered block may be. */
export const IDE_DIAGNOSTICS_MAX_LENGTH = 4000;

/**
 * Render the diagnostics of one file.
 *
 * The target's own line: two spaces, the severity glyph, the position — the
 * line and the character, both **one-based** — the message, and then the
 * code and the source when they are there.
 */
export function formatDiagnosticLines(diagnostics: readonly IdeDiagnostic[]): string {
  return diagnostics
    .map((diagnostic) => {
      const glyph =
        diagnostic.severity === undefined
          ? IDE_DIAGNOSTICS_FALLBACK_GLYPH
          : (IDE_DIAGNOSTICS_SEVERITY_GLYPHS[diagnostic.severity] ??
            IDE_DIAGNOSTICS_FALLBACK_GLYPH);
      const code = diagnostic.code === undefined ? '' : ` [${diagnostic.code}]`;
      const source = diagnostic.source === undefined ? '' : ` (${diagnostic.source})`;
      return `  ${glyph} [Line ${diagnostic.range.start.line + 1}:${
        diagnostic.range.start.character + 1
      }] ${diagnostic.message}${code}${source}`;
    })
    .join('\n');
}

/**
 * Render a set of diagnostic files.
 *
 * The target's own form: the file's name, a colon, and its diagnostics; the
 * files are separated by a blank line. A result longer than **4000**
 * characters is cut to the first `4000 - 12` characters and given the
 * ellipsis marker.
 */
export function formatDiagnosticsFiles(files: readonly IdeDiagnosticFile[]): string {
  const rendered = files
    .map((file) => {
      const name = file.uri.split('/').pop() || file.uri;
      return `${name}:\n${formatDiagnosticLines(file.diagnostics)}`;
    })
    .join('\n\n');
  if (rendered.length > IDE_DIAGNOSTICS_MAX_LENGTH) {
    return `${rendered.slice(0, IDE_DIAGNOSTICS_MAX_LENGTH - 12)}…[truncated]`;
  }
  return rendered;
}

/**
 * The block the target gives the model.
 */
export function renderNewDiagnostics(files: readonly IdeDiagnosticFile[]): string {
  return `<new-diagnostics>The following new diagnostic issues were detected:\n\n${formatDiagnosticsFiles(
    files,
  )}</new-diagnostics>`;
}

/* -------------------------------------------------------------------------- */
/* The manager                                                                 */
/* -------------------------------------------------------------------------- */

/** The MCP client the IDE is reached through. */
export interface IdeDiagnosticsClient {
  /** The client's kind — the target only baselines a `connected` client. */
  readonly type: string;
  /** The server's name — the JetBrains plugin is left alone. */
  readonly serverInfo?: { readonly name?: string } | undefined;
}

/** The request the manager makes to the IDE. */
export type IdeDiagnosticsRpc = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/** Where the manager reports. */
export interface IdeDiagnosticsReporter {
  /** A telemetry event. */
  readonly telemetry?: (event: string, kind?: string, properties?: Record<string, unknown>) => void;
  /** A log line. */
  readonly log?: (message: string) => void;
}

/**
 * The diagnostics manager.
 *
 * The lifecycle is the target's own:
 *
 *   - `initialize(client)` attaches a client; a second call does nothing;
 *   - `shutdown()` detaches and clears **everything**, including the
 *     consecutive-timeout counter;
 *   - `reset()` clears the baseline, the right-hand-side state, the
 *     timestamps and the in-flight fetch, and **leaves the counter alone**;
 *   - `handleQueryStart(client)` initializes on the first query and resets on
 *     every later one.
 */
export class IdeDiagnosticsManager {
  /** The baseline — the diagnostics a file had before the agent edited it. */
  readonly baseline = new Map<string, readonly IdeDiagnostic[]>();

  /** When each file was last baselined. */
  readonly lastProcessedTimestamps = new Map<string, number>();

  /** The last right-hand-side diagnostics seen for each file. */
  readonly rightFileDiagnosticsState = new Map<string, readonly IdeDiagnostic[]>();

  /** How many baseline timeouts have happened in a row. */
  consecutiveBaselineTimeouts = 0;

  /** Whether a client is attached. */
  private attached = false;

  /** The attached client. */
  private client: IdeDiagnosticsClient | undefined;

  /** The request the manager makes to the IDE. */
  private rpc: IdeDiagnosticsRpc | undefined;

  /** The in-flight workspace fetch. */
  private workspaceFetchInFlight: Promise<unknown> | undefined;

  /** The MCP server names the target does not baseline. */
  private readonly excludedServerNames: readonly string[];

  constructor(
    private readonly reporter: IdeDiagnosticsReporter = {},
    rpc?: IdeDiagnosticsRpc,
    excludedServerNames: readonly string[] = IDE_DIAGNOSTICS_EXCLUDED_SERVER_NAMES,
  ) {
    this.rpc = rpc;
    this.excludedServerNames = excludedServerNames;
  }

  /**
   * Attach a client.
   *
   * The target's rule: a second call does nothing.
   */
  initialize(client: IdeDiagnosticsClient): void {
    if (this.attached) return;
    this.client = client;
    this.attached = true;
  }

  /** Detach and clear everything. */
  shutdown(): void {
    this.attached = false;
    this.client = undefined;
    this.baseline.clear();
    this.rightFileDiagnosticsState.clear();
    this.lastProcessedTimestamps.clear();
    this.consecutiveBaselineTimeouts = 0;
    this.workspaceFetchInFlight = undefined;
  }

  /** Clear the baseline, the right-hand-side state and the timestamps. */
  reset(): void {
    this.baseline.clear();
    this.rightFileDiagnosticsState.clear();
    this.lastProcessedTimestamps.clear();
    this.workspaceFetchInFlight = undefined;
  }

  /**
   * The first query initializes the manager; every later query resets it.
   */
  handleQueryStart(client?: IdeDiagnosticsClient): void {
    if (!this.attached) {
      if (client !== undefined) this.initialize(client);
      return;
    }
    this.reset();
  }

  /**
   * Whether the manager may talk to the IDE.
   *
   * The target's own conditions: a client is attached, the client is
   * `connected`, and the client is **not** the JetBrains plugin — whose
   * server answers `getDiagnostics` itself, so the target leaves it alone.
   */
  private usable(): boolean {
    if (!this.attached) return false;
    const client = this.client;
    if (client === undefined) return false;
    if (client.type !== 'connected') return false;
    const serverName = client.serverInfo?.name;
    if (serverName !== undefined && this.excludedServerNames.includes(serverName)) return false;
    return this.consecutiveBaselineTimeouts < IDE_DIAGNOSTICS_MAX_CONSECUTIVE_BASELINE_TIMEOUTS;
  }

  /**
   * Record the diagnostics a file had **before** the agent edited it.
   *
   * The target's own rule: the request is a `getDiagnostics` for that one
   * file, under a **500 ms** timeout; the reply's file path must match the
   * one asked for; and three timeouts in a row disable the baselines.
   */
  async beforeFileEdited(file: string, now = Date.now()): Promise<void> {
    if (!this.usable()) return;
    const rpc = this.rpc;
    if (rpc === undefined) return;

    const started = Date.now();
    const before = this.consecutiveBaselineTimeouts;
    try {
      const reply = await withTimeout(
        rpc('getDiagnostics', { uri: `file://${file}` }),
        IDE_DIAGNOSTICS_BASELINE_TIMEOUT_MS,
        IDE_DIAGNOSTICS_BASELINE_TIMEOUT_MESSAGE,
      );
      const files = parseDiagnosticsReply(reply);
      const first = files[0];
      if (first !== undefined && !samePath(this.normalizeFileUri(file), this.normalizeFileUri(first.uri))) {
        this.reporter.log?.(
          `Diagnostics file path mismatch: expected ${file}, got ${first.uri}`,
        );
        this.reporter.telemetry?.(IDE_DIAGNOSTICS_BASELINE_EVENT, 'path_mismatch', {
          duration_ms: Date.now() - started,
          consecutive_timeouts: this.consecutiveBaselineTimeouts,
        });
        return;
      }
      const key = this.normalizeFileUri(file);
      this.baseline.set(key, first === undefined ? [] : first.diagnostics);
      this.lastProcessedTimestamps.set(key, now);
      this.consecutiveBaselineTimeouts = 0;
      this.reporter.telemetry?.(IDE_DIAGNOSTICS_BASELINE_EVENT, undefined, {
        duration_ms: Date.now() - started,
      });
    } catch (error) {
      const kind = diagnosticsErrorKind(error);
      if (kind === 'timeout' && this.consecutiveBaselineTimeouts === before) {
        this.consecutiveBaselineTimeouts++;
        if (this.consecutiveBaselineTimeouts === IDE_DIAGNOSTICS_MAX_CONSECUTIVE_BASELINE_TIMEOUTS) {
          this.reporter.log?.(IDE_DIAGNOSTICS_BASELINES_DISABLED_MESSAGE);
        }
      }
      this.reporter.telemetry?.(IDE_DIAGNOSTICS_BASELINE_EVENT, kind, {
        duration_ms: Date.now() - started,
        consecutive_timeouts: this.consecutiveBaselineTimeouts,
      });
    }
  }

  /**
   * The diagnostics that appeared since the baseline.
   *
   * The target's own rule: the request is a workspace-wide `getDiagnostics`,
   * under a **2000 ms** timeout; the files that are not in the baseline are
   * ignored; and the files that are in it contribute only their new
   * diagnostics.
   */
  async getNewDiagnostics(): Promise<IdeDiagnosticFile[]> {
    if (!this.attached || this.client === undefined) return [];
    if (this.client.type !== 'connected') return [];
    if (this.baseline.size === 0) return [];
    const rpc = this.rpc;
    if (rpc === undefined) return [];
    if (this.workspaceFetchInFlight !== undefined) {
      this.reporter.telemetry?.(IDE_DIAGNOSTICS_FETCH_EVENT, 'in_flight');
      return [];
    }

    const started = Date.now();
    let files: IdeDiagnosticFile[];
    try {
      const pending = rpc('getDiagnostics', {});
      this.workspaceFetchInFlight = pending;
      void pending
        .finally(() => {
          if (this.workspaceFetchInFlight === pending) this.workspaceFetchInFlight = undefined;
        })
        .catch(() => undefined);
      files = parseDiagnosticsReply(
        await withTimeout(pending, IDE_DIAGNOSTICS_FETCH_TIMEOUT_MS, IDE_DIAGNOSTICS_FETCH_TIMEOUT_MESSAGE),
      );
    } catch (error) {
      this.reporter.telemetry?.(IDE_DIAGNOSTICS_FETCH_EVENT, diagnosticsErrorKind(error), {
        duration_ms: Date.now() - started,
      });
      return [];
    }

    const fromFiles: IdeDiagnosticFile[] = [];
    const fromRight = new Map<string, IdeDiagnosticFile>();
    for (const file of files) {
      const isFileUri = file.uri.startsWith('file://');
      if (!isFileUri && !file.uri.startsWith('_claude_fs_right:')) continue;
      const key = this.normalizeFileUri(file.uri);
      if (!this.baseline.has(key)) continue;
      if (isFileUri) fromFiles.push({ uri: file.uri, diagnostics: file.diagnostics });
      else fromRight.set(key, file);
    }

    const result: IdeDiagnosticFile[] = [];
    for (const entry of fromFiles) {
      const key = this.normalizeFileUri(entry.uri);
      const known = this.baseline.get(key) ?? [];
      const right = fromRight.get(key);
      let current = entry;
      if (right !== undefined) {
        const previous = this.rightFileDiagnosticsState.get(key);
        if (previous === undefined || !sameDiagnostics(previous, right.diagnostics)) {
          current = right;
        }
        this.rightFileDiagnosticsState.set(key, right.diagnostics);
      }
      const fresh = newDiagnostics(known, current.diagnostics);
      if (fresh.length > 0) result.push({ uri: entry.uri, diagnostics: fresh });
      this.baseline.set(key, current.diagnostics);
    }
    return result;
  }

  /**
   * Ask the IDE for its diagnostics.
   *
   * **This implementation's** entry point, and the one that **refuses**: the
   * target reaches the IDE through an MCP client named `ide`, and this
   * implementation has no IDE to reach. The refusal names the capability it
   * needed.
   */
  async requestDiagnostics(): Promise<IdeDiagnosticFile[]> {
    if (!this.attached || this.client === undefined || this.rpc === undefined) {
      throw new IdeCapabilityError(IDE_DIAGNOSTICS_CAPABILITY, 'Requesting IDE diagnostics');
    }
    return this.getNewDiagnostics();
  }

  /**
   * Reduce a uri to the path the baseline is keyed by.
   *
   * The target strips the three uri prefixes it knows, drops the leading
   * slash of a `/C:/…` path, and normalises the rest.
   */
  normalizeFileUri(uri: string): string {
    const prefix = IDE_DIAGNOSTICS_URI_PREFIXES.find((candidate) => uri.startsWith(candidate));
    let rest = prefix === undefined ? uri : uri.slice(prefix.length);
    if (prefix !== undefined && /^[\\/][A-Za-z]:[\\/]/.test(rest)) rest = rest.slice(1);
    return path.normalize(rest);
  }
}

/**
 * Parse the reply of a `getDiagnostics` request.
 *
 * The target's own rule: the reply is an array of MCP content blocks; the
 * first block of the type `text` carries a JSON document, and that document
 * is the diagnostics payload. Anything else is **no** diagnostics.
 */
export function parseDiagnosticsReply(reply: unknown): IdeDiagnosticFile[] {
  if (!Array.isArray(reply)) return [];
  const text = reply.find(
    (block): block is { type: 'text'; text: string } =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      'text' in (block as object),
  );
  if (text === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.text);
  } catch {
    return [];
  }
  return validateDiagnosticsPayload(parsed).files;
}

/**
 * The kind of a failed diagnostics request.
 *
 * The target's own rule: a timeout is an `Error` whose message is **exactly**
 * the timeout message; a `SyntaxError` is a parse failure; anything else is an
 * error.
 */
export function diagnosticsErrorKind(error: unknown): 'timeout' | 'parse_failed' | 'error' {
  if (error instanceof Error && error.message === IDE_DIAGNOSTICS_BASELINE_TIMEOUT_MESSAGE) {
    return 'timeout';
  }
  if (error instanceof Error && error.message === IDE_DIAGNOSTICS_FETCH_TIMEOUT_MESSAGE) {
    return 'timeout';
  }
  if (error instanceof SyntaxError) return 'parse_failed';
  return 'error';
}

/**
 * Race a promise against a timeout.
 *
 * The target's own helper: the timeout rejects with an `Error` carrying the
 * given message, and the timer is cleared when the promise settles.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Whether two lists of diagnostics are the same set.
 *
 * The target's own rule: the lengths must match, and the two sets of keys
 * must be equal.
 */
export function sameDiagnostics(
  left: readonly IdeDiagnostic[],
  right: readonly IdeDiagnostic[],
): boolean {
  if (left.length !== right.length) return false;
  const leftKeys = new Set(left.map((diagnostic) => diagnosticKey(diagnostic)));
  const rightKeys = new Set(right.map((diagnostic) => diagnosticKey(diagnostic)));
  if (leftKeys.size !== rightKeys.size) return false;
  for (const key of leftKeys) {
    if (!rightKeys.has(key)) return false;
  }
  return true;
}

/**
 * Whether two paths name the same file.
 *
 * The target compares the two **normalized** paths.
 */
export function samePath(left: string, right: string): boolean {
  return path.normalize(left) === path.normalize(right);
}

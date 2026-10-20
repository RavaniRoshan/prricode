/**
 * The pieces the manager commands share.
 *
 * The provider manager (`src/cli/commands/provider.ts`) and the catalog
 * browser (`src/cli/commands/catalog.ts`) are two commands over one product
 * surface. They used to carry their own copies of the same five helpers and
 * their own copy of the argument parser, which is how two commands drift: the
 * parser in particular is a **generic** piece of argument handling. It lives
 * here, **once**, and both commands import it.
 *
 * The manager's parser is not the CLI's parser: `src/cli/args.ts` parses the
 * **command line** — the flags, the modes and the subcommands of the reference build — and
 * hands the manager a *manager invocation*, whose verbs, flags and output
 * formats are the manager's own business.
 *
 * ## What is in here
 *
 *   - **The result** — {@link CommandResult}, the record a command returns.
 *     It is here, and not in a command module, because a *CLI-wide* result
 *     type belongs with the CLI's other shared vocabulary
 *     (`src/cli/output.ts`, which owns the exit codes).
 *   - **The extension label** — the single wording every manager surface
 *     carries. The picker used to keep its own copy of the wording, and two
 *     copies of a label is one copy too many.
 *   - **The invocation parser** — the two forms a manager command is called
 *     in: the subcommand form (`provider list`) and the non-interactive flag
 *     form (`--provider list`).
 *   - **The result helpers** — a usage error, a failure, an error's message.
 *   - **The table renderer** — one implementation, padding by **display
 *     width** so a wide character does not break the columns.
 *   - **The state file** — the persisted form of the manager's state: the
 *     connection table and the catalog table, in one file.
 *
 * ## The state file
 *
 * The manager's state is **two records** — the connections and the catalogs —
 * and they are persisted together so that one write cannot lose the other.
 * Each writer owns one member and preserves the other: the provider command
 * writes the connections, the catalog command writes the catalogs, and both go
 * through {@link updateProviderStateFile}, which reads the file, replaces one
 * member and writes the whole thing back.
 *
 * **A credential is never in the file.** A connection carries a credential
 * *reference* — an environment variable name, a file path, or an OS
 * credential-store key — and that is what is written. The file never carries
 * a secret.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { EXIT_FAILURE, EXIT_USAGE } from '../output.js';
import type { ModelCatalog } from '../../provider/catalog.js';
import { createProviderRegistry, type Connection, type ProviderRegistry } from '../../provider/registry.js';
import type { ProviderRoute } from '../../provider/routes.js';

/* -------------------------------------------------------------------------- */
/* The result                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a command produced.
 *
 * **Implementation choice.** The audit records the target's exit codes ("`1` for a
 * failed session lookup and `2` for an argument error") but records no
 * command-result shape. This implementation's own commands return this record: the exit
 * code, the text for each stream, and the machine-readable payload.
 *
 * The payload is what the non-interactive form writes as its JSON document, so
 * the two never disagree.
 *
 * **One home.** The type used to live in `src/cli/commands/provider.ts` and be
 * re-exported by `src/cli/commands/catalog.ts`, which is how two commands end
 * up with two definitions of the same record. It is now **re-exported** from
 * `src/cli/output.ts`, next to the exit codes it is written with, so the CLI
 * has exactly one definition of the record.
 */
import type { CommandResult } from '../output.js';

export type { CommandResult };

/* -------------------------------------------------------------------------- */
/* The extension label                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The label the extension carries.
 *
 * **Project requirement** (plan §Global Constraints): "Multi-provider management
 * is a **project requirement**, not part of the reference agent. It must be labelled as
 * an extension everywhere it surfaces (UI, `--help`, docs, compatibility
 * matrix)."
 *
 * The constant is the single wording the command surfaces use, so the label
 * cannot drift between the text output, the JSON document and the help.
 */
export const PROVIDER_EXTENSION_NOTICE =
  'The multi-provider manager is a project extension, not part of the reference agent.';

/** The shorter form of the label, used in a heading. */
export const PROVIDER_EXTENSION_LABEL = 'project extension - not part of the reference agent';

/* -------------------------------------------------------------------------- */
/* The invocation                                                               */
/* -------------------------------------------------------------------------- */

/** A parsed invocation of a manager command. */
export interface CommandInvocation {
  /** The verb, when one was given. */
  verb?: string;
  /** The operands — the arguments that are not flags and not the verb. */
  operands: string[];
  /** The flag values, keyed by flag name. */
  flags: ReadonlyMap<string, readonly string[]>;
  /** Whether the command was given in the flag form (`--provider list`). */
  flagForm: boolean;
  /** The format the output is rendered in. */
  format: 'text' | 'json';
  /** Whether the help was asked for. */
  help: boolean;
}

/** The result of parsing an invocation. */
export type InvocationParse =
  | { ok: true; invocation: CommandInvocation }
  | { ok: false; message: string };

/**
 * The vocabulary a manager command is parsed with.
 */
export interface InvocationSpec {
  /** The flag that names the command in the flag form (`--provider`). */
  commandFlag: string;
  /** The word that may lead the arguments (`provider`). */
  commandWord: string;
  /** The flags that take a value. */
  valueFlags: ReadonlySet<string>;
  /** The flags that take no value. */
  booleanFlags: ReadonlySet<string>;
}

/**
 * Parse a manager command's arguments.
 *
 * Two forms are accepted and they run the **same** operations:
 *
 *   - the **subcommand** form — `provider list`, `provider use prod`;
 *   - the **non-interactive flag** form — `--provider list`, `--provider use
 *     prod` — which is machine-readable by default.
 *
 * The flag form is recognized by its command flag (`--provider` here,
 * `--catalog` there); the flag that follows it is the verb.
 */
export function parseInvocation(args: readonly string[], spec: InvocationSpec): InvocationParse {
  const { valueFlags, booleanFlags } = spec;
  const flags = new Map<string, string[]>();
  const operands: string[] = [];
  let verb: string | undefined;
  let flagForm = false;
  let help = false;
  let format: 'text' | 'json' | undefined;

  const record = (name: string, values: readonly string[]): void => {
    const existing = flags.get(name);
    if (existing === undefined) flags.set(name, [...values]);
    else existing.push(...values);
  };

  const queue = [...args];
  let cursor = 0;

  // The command's own name may lead the arguments — `provider list` — so the
  // command reads the same whether it is called as `list` or as `provider
  // list`. The flag form is recognized by its command flag.
  if (queue[0] === spec.commandWord) cursor = 1;

  // The command flag comes first in the flag form.
  if (queue[cursor] === spec.commandFlag) {
    flagForm = true;
    cursor += 1;
    const next = queue[cursor];
    if (next !== undefined && !isFlagToken(next)) {
      verb = next;
      cursor += 1;
    }
  }

  while (cursor < queue.length) {
    const token = queue[cursor];
    cursor += 1;
    if (token === undefined) continue;

    if (!isFlagToken(token)) {
      if (verb === undefined) {
        verb = token;
        continue;
      }
      operands.push(token);
      continue;
    }

    let name = token;
    let inline: string | undefined;
    const equals = token.indexOf('=');
    if (token.startsWith('--') && equals !== -1) {
      name = token.slice(0, equals);
      inline = token.slice(equals + 1);
    }

    if (booleanFlags.has(name)) {
      if (inline !== undefined) {
        return { ok: false, message: `Error: ${name} does not take a value.` };
      }
      record(name, []);
      if (name === '--help') help = true;
      if (name === '--json') format = 'json';
      continue;
    }

    if (valueFlags.has(name)) {
      let value = inline;
      if (value === undefined) {
        const next = queue[cursor];
        if (next === undefined) {
          return { ok: false, message: `Error: ${name} requires a value.` };
        }
        value = next;
        cursor += 1;
      }
      record(name, [value]);
      if (name === '--format') {
        if (value !== 'text' && value !== 'json') {
          return { ok: false, message: `Error: Invalid output format "${value}".` };
        }
        format = value;
      }
      continue;
    }

    return { ok: false, message: `Error: unknown option '${token}'.` };
  }

  const resolvedFormat: 'text' | 'json' = format ?? (flagForm ? 'json' : 'text');

  const invocation: CommandInvocation = {
    operands,
    flags,
    flagForm,
    format: resolvedFormat,
    help,
    ...(verb === undefined ? {} : { verb }),
  };
  return { ok: true, invocation };
}

/** The last value of a flag. */
export function flagValue(invocation: CommandInvocation, name: string): string | undefined {
  const values = invocation.flags.get(name);
  if (values === undefined || values.length === 0) return undefined;
  return values[values.length - 1];
}

/** Every value of a flag. */
export function flagValues(invocation: CommandInvocation, name: string): string[] {
  return [...(invocation.flags.get(name) ?? [])];
}

/** Whether a token is a flag. */
function isFlagToken(token: string): boolean {
  return token.length > 1 && token.startsWith('-');
}

/* -------------------------------------------------------------------------- */
/* The result helpers                                                           */
/* -------------------------------------------------------------------------- */

/** The message of an error. */
export function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

/** A usage error. */
export function usageError(message: string): CommandResult {
  return { exitCode: EXIT_USAGE, stdout: '', stderr: `${message}\n` };
}

/** A failure. */
export function failure(message: string): CommandResult {
  return { exitCode: EXIT_FAILURE, stdout: '', stderr: `${message}\n` };
}

/* -------------------------------------------------------------------------- */
/* The table                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The code-point ranges that occupy **two** columns.
 *
 * A CJK ideograph, a Hangul syllable, a fullwidth form and an emoji are all
 * drawn twice as wide as a Latin letter, so a table that pads by the string's
 * **length** puts the next column in the wrong place as soon as a cell holds
 * one of them.
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, Hangul compatibility, CJK compatibility
  [0x3400, 0x4dbf], // CJK unified ideographs extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi syllables
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // Vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f300, 0x1f64f], // Emoji
  [0x1f680, 0x1f6ff], // Transport and map symbols
  [0x1f900, 0x1f9ff], // Supplemental symbols
  [0x20000, 0x2fffd], // CJK unified ideographs extension B and beyond
  [0x30000, 0x3fffd],
];

/**
 * The code-point ranges that occupy **no** column of their own.
 *
 * A combining mark is drawn on top of the character before it, so it must not
 * push the next column along.
 */
const ZERO_WIDTH_RANGES: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f], // Combining diacritical marks
  [0x200b, 0x200f], // Zero-width space through right-to-left mark
  [0xfe00, 0xfe0f], // Variation selectors
];

/** Whether a code point is in one of the ranges. */
function inRanges(code: number, ranges: readonly (readonly [number, number])[]): boolean {
  for (const range of ranges) {
    const low = range[0];
    const high = range[1];
    if (low !== undefined && high !== undefined && code >= low && code <= high) return true;
  }
  return false;
}

/**
 * The width a string occupies in a terminal.
 *
 * The width is counted in **columns**, not in UTF-16 code units: a wide
 * character counts as two and a combining mark counts as none.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code === undefined) continue;
    if (inRanges(code, ZERO_WIDTH_RANGES)) continue;
    width += inRanges(code, WIDE_RANGES) ? 2 : 1;
  }
  return width;
}

/**
 * Pad a string to a width, counted in **columns**.
 *
 * A string that is already wider than the width is returned unchanged: the
 * table's columns are a floor, not a truncation.
 */
export function padToWidth(text: string, width: number): string {
  const missing = width - displayWidth(text);
  return missing > 0 ? `${text}${' '.repeat(missing)}` : text;
}

/**
 * Render a table.
 *
 * The columns are padded to their widest cell, so the output is readable and
 * the rows stay one per record. The padding is by **display width**, so a cell
 * that holds a wide character does not push the next column out of line.
 */
export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = headers.map((header) => displayWidth(header));
  for (const row of rows) {
    for (let index = 0; index < headers.length; index += 1) {
      const cell = row[index] ?? '';
      const current = widths[index] ?? 0;
      const width = displayWidth(cell);
      if (width > current) widths[index] = width;
    }
  }

  const render = (cells: readonly string[]): string =>
    headers
      .map((_, index) => padToWidth(cells[index] ?? '', widths[index] ?? 0))
      .join('  ')
      .trimEnd();

  return [render(headers), ...rows.map((row) => render(row))];
}

/* -------------------------------------------------------------------------- */
/* The state file                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One connection's catalog, in the persisted form.
 *
 * The overrides are written as **pairs** rather than as maps, because a JSON
 * object cannot hold a key that is not a string and because the order of a
 * map is not part of the data.
 */
export interface CatalogStateEntry {
  /** The connection the catalog belongs to. */
  connectionId: string;
  /** The catalog's own rows. */
  catalog: ModelCatalog;
  /** The display names the user chose, as `[model id, display name]` pairs. */
  displayNames: Array<readonly [string, string]>;
  /** The provider ids the user chose, as `[model id, route, provider id]` triples. */
  providerIds: Array<readonly [string, ProviderRoute, string]>;
}

/**
 * The persisted form of the manager's state.
 *
 * The two members are the two records of the product's central rule: the
 * **connections** (routing identity) and the **catalogs** (model metadata).
 * They are stored together so that a write of one cannot lose the other.
 */
export interface ProviderStateFile {
  /** The format version. */
  version: 1;
  /** The connection table. */
  connections: Connection[];
  /** The catalog table. */
  catalogs: CatalogStateEntry[];
}

/** A state file with nothing in it. */
export function emptyProviderState(): ProviderStateFile {
  return { version: 1, connections: [], catalogs: [] };
}

/**
 * Read the state file.
 *
 * A file that is not there is **not** an error: it is the state of a manager
 * that has never been used. A file that is there but cannot be parsed **is**
 * an error — silently starting from an empty state would throw away the
 * user's connections.
 */
export async function readProviderStateFile(path: string): Promise<ProviderStateFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`the provider state file ${path} is not valid JSON: ${errorMessageOf(error)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`the provider state file ${path} is not a provider state document`);
  }

  const document = parsed as Partial<ProviderStateFile>;
  const connections = Array.isArray(document.connections) ? document.connections : [];
  const catalogs = Array.isArray(document.catalogs) ? document.catalogs : [];
  return { version: 1, connections, catalogs };
}

/**
 * Write the state file.
 *
 * The directory is created when it is not there, so a caller can name a path
 * inside a configuration directory that does not exist yet.
 */
export async function writeProviderStateFile(path: string, state: ProviderStateFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * Replace one member of the state file and write it back.
 *
 * The file is read first, so the member the caller does **not** own survives
 * the write: the provider command writes the connections and the catalog
 * command writes the catalogs, and neither can lose the other's work.
 */
export async function updateProviderStateFile(
  path: string,
  patch: Partial<ProviderStateFile>,
): Promise<ProviderStateFile> {
  const current = (await readProviderStateFile(path)) ?? emptyProviderState();
  const next: ProviderStateFile = {
    version: 1,
    connections: patch.connections ?? current.connections,
    catalogs: patch.catalogs ?? current.catalogs,
  };
  await writeProviderStateFile(path, next);
  return next;
}

/**
 * The registry the state file's connections describe.
 *
 * The connections are the **live** records the registry hands out, so a
 * `use` on the rebuilt registry is seen by the caller.
 */
export function registryFromState(state: ProviderStateFile): ProviderRegistry {
  return createProviderRegistry(state.connections);
}

/**
 * The conformance documents' **references**: every "Pinned by" cell, resolved.
 *
 * A conformance document claims that a test pins a fact. The claim is only
 * worth anything if the test **exists**, so this module reads the documents,
 * resolves every reference, and reports the ones that name a file or a test
 * nobody wrote.
 *
 * The resolution rules are the documents' own:
 *
 *   - a cell of the form `` `path` — "title" `` names a file and a test title;
 *   - a cell of the form `same file — "title"` names the file the previous row
 *     of the same table named;
 *   - a cell of the form `same file` names that file and no title;
 *   - a cell of the form `` `path` + its test `` names a source file.
 *
 * A **title** matches when the file contains it, after the typography is
 * normalised (`’` for `'`, `“`/`”` for `"`) and an **ellipsis** is read as
 * "and then some": each fragment around the `…` must be in the file.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root. */
export const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The conformance documents, and the rows each of them covers. */
export const CONFORMANCE_DOCUMENTS: readonly string[] = [
  'command-surface.md',
  'extension-surface.md',
  'permission-matrix.md',
  'provider-catalog.md',
  'sandbox-surface.md',
  'session-format.md',
  'settings-precedence.md',
  'tool-surface.md',
];

/** One resolved reference. */
export interface Reference {
  /** The document the reference is in. */
  readonly document: string;
  /** The line the reference is on. */
  readonly line: number;
  /** The file the reference names. */
  readonly file: string | undefined;
  /** The test titles the reference names. */
  readonly titles: readonly string[];
  /** The matrix row the conformance row backs. */
  readonly matrixRow: string | undefined;
  /** The cell the reference was read from. */
  readonly text: string;
}

/** A reference that does not hold. */
export interface ReferenceProblem {
  /** The document the reference is in. */
  readonly document: string;
  /** The line the reference is on. */
  readonly line: number;
  /** What is wrong with it. */
  readonly problem: string;
  /** The cell the reference was read from. */
  readonly text: string;
}

/**
 * The cells of a markdown table row.
 *
 * An empty array for a line that is not a table row. A `\|` inside a cell is
 * an **escaped pipe**: it is part of the cell and does not split it.
 */
export function cellsOf(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return [];
  const cells: string[] = [];
  let current = '';
  for (let index = 1; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (character === '\\' && trimmed[index + 1] === '|') {
      current += '|';
      index += 1;
      continue;
    }
    if (character === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  const last = cells[cells.length - 1];
  if (last === '') cells.pop();
  return cells;
}

/** The typography of a reference, normalised. */
export function normalizeTypography(text: string): string {
  return text
    .replace(/\\(['"])/g, '$1')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"');
}

/**
 * Whether a backticked path names a **file**.
 *
 * A cell may backtick an identifier (`io_uring_setup`) as well as a path, and
 * only a path names a file.
 */
function isFilePath(candidate: string): boolean {
  return /[/\\]/.test(candidate) || /\.(ts|tsx|js|mjs|md|json)$/.test(candidate);
}

/**
 * Whether a file contains a test title.
 *
 * The title is matched after the typography is normalised, and an ellipsis
 * stands for "and then some": every fragment around it must be in the file.
 */
export function fileHasTitle(source: string, title: string): boolean {
  const haystack = normalizeTypography(source);
  const needle = normalizeTypography(title);
  const fragments = needle.split('\u2026').map((fragment) => fragment.trim());
  return fragments.every((fragment) => fragment === '' || haystack.includes(fragment));
}

/**
 * Read the references of one conformance document.
 *
 * The document's tables are read in order; a table's "Pinned by" column is the
 * column whose header says so. The `same file` shorthand resolves to the file
 * the previous row of the same table named.
 */
export function parseReferences(document: string, markdown: string): Reference[] {
  const references: Reference[] = [];
  let pinnedIndex = -1;
  let matrixIndex = -1;
  let lastFile: string | undefined;
  const lines = markdown.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const cells = cellsOf(line);
    if (cells.length === 0) {
      pinnedIndex = -1;
      matrixIndex = -1;
      lastFile = undefined;
      continue;
    }
    if (cells.every((cell) => /^-+$/.test(cell))) continue;
    const headerIndex = cells.findIndex((cell) => cell.toLowerCase() === 'pinned by');
    if (headerIndex >= 0) {
      pinnedIndex = headerIndex;
      matrixIndex = cells.findIndex((cell) => cell.toLowerCase() === 'matrix row');
      lastFile = undefined;
      continue;
    }
    if (pinnedIndex < 0) continue;
    const cell = cells[pinnedIndex];
    if (cell === undefined || cell === '') continue;
    if (cell === '—' || cell === '-') continue;

    const titles = [...cell.matchAll(/["\u201c]([^"\u201d]+)["\u201d]/g)].map((match) => match[1] ?? '');
    const paths = [...cell.matchAll(/`([^`]+)`/g)]
      .map((match) => match[1] ?? '')
      .filter(isFilePath);
    let file: string | undefined;
    if (/^same file\b/i.test(cell)) {
      // The shorthand names the file the previous row of this table named.
      file = lastFile;
    } else if (paths.length > 0) {
      file = paths[0];
      lastFile = file;
    }
    const matrixRow = matrixIndex < 0 ? undefined : cells[matrixIndex];
    references.push({ document, line: index + 1, file, titles, matrixRow, text: cell });
  }
  return references;
}

/**
 * Check the references of one conformance document.
 *
 * A reference that names a file must name a file that exists, and a reference
 * that names a test title must name a test the file really has.
 */
export function checkReferences(
  document: string,
  markdown: string,
  read: (file: string) => string | undefined,
): ReferenceProblem[] {
  const problems: ReferenceProblem[] = [];
  for (const reference of parseReferences(document, markdown)) {
    if (reference.file === undefined) {
      problems.push({
        document: reference.document,
        line: reference.line,
        problem: 'the reference names no file',
        text: reference.text,
      });
      continue;
    }
    const source = read(reference.file);
    if (source === undefined) {
      problems.push({
        document: reference.document,
        line: reference.line,
        problem: `the file ${reference.file} does not exist`,
        text: reference.text,
      });
      continue;
    }
    for (const title of reference.titles) {
      if (!fileHasTitle(source, title)) {
        problems.push({
          document: reference.document,
          line: reference.line,
          problem: `the file ${reference.file} has no test called "${title}"`,
          text: reference.text,
        });
      }
    }
  }
  return problems;
}

/** Read a file of the repository, or `undefined` when it does not exist. */
export function readRepositoryFile(relativePath: string): string | undefined {
  try {
    return readFileSync(path.join(REPOSITORY_ROOT, relativePath), 'utf8');
  } catch {
    return undefined;
  }
}

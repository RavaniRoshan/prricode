/**
 * Contract test: the **remaining surfaces'** conformance document.
 *
 * The document claims that a test pins a fact. A claim that names a test nobody
 * wrote is decoration, and this test is what stops it from being decoration.
 *
 * The check is the same shape as the compatibility harness's own
 * (`tests/compatibility/references.ts`): a **"Pinned by"** cell names a file and
 * the titles of the tests in it, and every one of them must exist.
 *
 * The document is not in the harness's own list — the harness owns that list, and
 * this milestone does not touch it — so this test is what checks the document.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The document this test checks. */
const DOCUMENT = path.join(REPOSITORY, 'docs', 'compatibility', 'remaining-surfaces.md');

/**
 * The titles a test file **declares**.
 *
 * A title is declared by an `it`, a `test` or a `describe` call. A comment that
 * repeats a title declares nothing, so a reference cannot be satisfied by prose.
 */
const DECLARED_TITLE =
  /\b(?:it|test|describe)\b\s*(?:\.\s*[A-Za-z]+\s*\([^()]*\)\s*)*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g;

/** The titles a file declares, with their typography normalised. */
function declaredTitlesOf(source: string): string[] {
  return [...source.matchAll(DECLARED_TITLE)].map((match) =>
    (match[2] ?? '').replace(/\\(['"])/g, '$1').replace(/[‘’]/g, "'").replace(/[“”]/g, '"'),
  );
}

/** The cells of a markdown table row. */
function cellsOf(line: string): string[] {
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
  if (cells[cells.length - 1] === '') cells.pop();
  return cells;
}

describe('the remaining surfaces\' conformance document', () => {
  it('exists', () => {
    expect(readFileSync(DOCUMENT, 'utf8').length).toBeGreaterThan(1000);
  });

  it('every "Pinned by" cell names a file that exists and a test the file really has', () => {
    const markdown = readFileSync(DOCUMENT, 'utf8');
    const problems: string[] = [];
    let checked = 0;

    let pinnedIndex = -1;
    let lastFile: string | undefined;

    for (const [index, line] of markdown.split('\n').entries()) {
      const cells = cellsOf(line);
      if (cells.length === 0) {
        pinnedIndex = -1;
        lastFile = undefined;
        continue;
      }
      if (cells.every((cell) => /^-+$/.test(cell))) continue;
      const headerIndex = cells.findIndex((cell) => cell.toLowerCase() === 'pinned by');
      if (headerIndex >= 0) {
        pinnedIndex = headerIndex;
        lastFile = undefined;
        continue;
      }
      if (pinnedIndex < 0) continue;
      const cell = cells[pinnedIndex];
      if (cell === undefined || cell === '') continue;

      const titles = [...cell.matchAll(/["“]([^"”]+)["”]/g)].map((match) => match[1] ?? '');
      const paths = [...cell.matchAll(/`([^`]+)`/g)]
        .map((match) => match[1] ?? '')
        .filter((candidate) => candidate.includes('/') || /\.(ts|md)$/.test(candidate));

      const file = /^same file\b/i.test(cell) ? lastFile : paths[0];
      if (file === undefined) {
        problems.push(`line ${index + 1}: the reference names no file`);
        continue;
      }
      lastFile = file;
      checked += 1;

      let source: string;
      try {
        source = readFileSync(path.join(REPOSITORY, file), 'utf8');
      } catch {
        problems.push(`line ${index + 1}: the file ${file} does not exist`);
        continue;
      }

      const declared = declaredTitlesOf(source);
      for (const title of titles) {
        const wanted = title.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
        if (!declared.includes(wanted)) {
          problems.push(`line ${index + 1}: the file ${file} has no test called "${title}"`);
        }
      }
    }

    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(10);
  });

  it('has at least one reference to check', () => {
    const markdown = readFileSync(DOCUMENT, 'utf8');
    expect(markdown).toContain('| Pinned by |');
  });
});

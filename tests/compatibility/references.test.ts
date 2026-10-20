/**
 * The conformance documents' own check: every reference names a test that
 * exists.
 *
 * A conformance document claims that a test pins a fact. When the claim names
 * a test nobody wrote, the claim is decoration, and this test is what stops it
 * from being decoration again.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readMatrix } from './matrix.js';
import {
  CONFORMANCE_DOCUMENTS,
  REPOSITORY_ROOT,
  checkReferences,
  fileHasTitle,
  parseReferences,
} from './references.js';

/** The markdown of one conformance document. */
function documentOf(name: string): string {
  return readFileSync(path.join(REPOSITORY_ROOT, 'docs', 'compatibility', name), 'utf8');
}

/** The source of a file of the repository, or `undefined`. */
function read(relativePath: string): string | undefined {
  try {
    return readFileSync(path.join(REPOSITORY_ROOT, relativePath), 'utf8');
  } catch {
    return undefined;
  }
}

describe('the conformance documents', () => {
  it('every reference names a file that exists and a test the file really has', () => {
    const problems = CONFORMANCE_DOCUMENTS.flatMap((name) =>
      checkReferences(name, documentOf(name), read),
    );
    expect(
      problems.map((problem) => `${problem.document}:${problem.line} ${problem.problem}`),
      'a conformance reference names a test nobody wrote',
    ).toEqual([]);
  });

  it('every conformance document has references to check', () => {
    for (const name of CONFORMANCE_DOCUMENTS) {
      const references = parseReferences(name, documentOf(name));
      expect(references.length, `${name} has no "Pinned by" references`).toBeGreaterThan(0);
    }
  });

  it('every conformance row names the matrix row it backs', () => {
    const matrixIds = new Set(readMatrix().map((row) => row.id));
    for (const name of CONFORMANCE_DOCUMENTS) {
      for (const reference of parseReferences(name, documentOf(name))) {
        expect(
          reference.matrixRow,
          `${name}:${reference.line} names no matrix row`,
        ).toBeDefined();
        expect(
          matrixIds.has(reference.matrixRow ?? ''),
          `${name}:${reference.line} names the matrix row "${reference.matrixRow}", which the matrix does not have`,
        ).toBe(true);
      }
    }
  });

  it('the references are checked after the typography is normalised', () => {
    // The check itself: a title that differs only in its typography or in an
    // ellipsis is a match, and a title that differs in its words is not.
    const source = 'it("the target’s validation messages", () => {});';
    expect(fileHasTitle(source, "the target's validation messages")).toBe(true);
    expect(fileHasTitle(source, 'the target’s validation messages')).toBe(true);
    expect(fileHasTitle(source, 'validation messages')).toBe(true);
    expect(fileHasTitle(source, 'the target’s other messages')).toBe(false);
  });
});

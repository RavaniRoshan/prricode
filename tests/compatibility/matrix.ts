/**
 * The two tables this milestone keeps in step.
 *
 * The **feature matrix** (`docs/compatibility/feature-matrix.md`) is the contract
 * list: it names every row this implementation claims something about, and it names the
 * **evidence class** of each row — the class that decides how the row may be
 * reported.
 *
 * The **results** (`docs/compatibility/results.md`) is the measurement: one row
 * per contract, carrying the outcome, the evidence class, the test that
 * produced it and the command that reproduces it.
 *
 * This module reads both and applies the matrix's own
 * **compatibility-reporting rule**:
 *
 * > A row may be reported as `match` in `docs/compatibility/results.md` only
 * > when its evidence class is `REA observed` **and** a test in the owning task
 * > passes. A row whose target evidence is `unknown` or `partial` may be
 * > reported as `partial`, `not-tested`, or `unknown` — never as `match`.
 *
 * The rule is applied **here**, once, so that the harness and the report cannot
 * disagree about what a row is allowed to say.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { cellsOf } from './references.js';

/* -------------------------------------------------------------------------- */
/* The paths                                                                   */
/* -------------------------------------------------------------------------- */

/** The contract list. */
export const FEATURE_MATRIX_PATH = fileURLToPath(
  new URL('../../docs/compatibility/feature-matrix.md', import.meta.url),
);

/** The measurement. */
export const RESULTS_PATH = fileURLToPath(
  new URL('../../docs/compatibility/results.md', import.meta.url),
);

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                              */
/* -------------------------------------------------------------------------- */

/** The outcomes a row may be reported with. */
export const OUTCOMES = ['match', 'partial', 'mismatch', 'not-tested', 'unknown'] as const;

/** One of the five outcomes. */
export type Outcome = (typeof OUTCOMES)[number];

/** Whether a value is one of the five outcomes. */
export function isOutcome(value: string): value is Outcome {
  return (OUTCOMES as readonly string[]).includes(value);
}

/**
 * The canonical evidence classes.
 *
 * The matrix writes them in prose — `REA observed`, `**implementation choice** (the
 * target's routing is unobserved)` — so the class is **canonicalised** before it
 * is compared: the markdown is stripped, the parenthetical is dropped, and the
 * rest is lower-cased.
 */
export const EVIDENCE_CLASSES = [
  'rea observed',
  'documented only',
  'project requirement',
  'implementation choice',
  'unknown',
] as const;

/** One of the canonical evidence classes. */
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

/* -------------------------------------------------------------------------- */
/* The rows                                                                    */
/* -------------------------------------------------------------------------- */

/** A row of the feature matrix. */
export interface MatrixRow {
  /** The row's id — `F-01`, `F-15b`, … */
  readonly id: string;
  /** The group the row belongs to. */
  readonly area: string;
  /** The requirement the row names. */
  readonly feature: string;
  /** The matrix's own status — `observed`, `partial`, `unknown`, … */
  readonly status: string;
  /** The evidence class, as the matrix writes it. */
  readonly evidenceClass: string;
  /** The evidence class, canonicalised. */
  readonly canonicalEvidenceClass: EvidenceClass;
  /** This implementation's own status. */
  readonly cloneStatus: string;
  /** The task that owns the row. */
  readonly owningTask: string;
  /** The tests the matrix names for the row. */
  readonly testRef: string;
  /**
   * How many cells the row read as.
   *
   * The matrix's rows carry nine columns, and a row that carries a pipe
   * inside a cell must still read as nine: a reader that splits on the pipe
   * reads the wrong number of columns, and the tail columns it reads are the
   * wrong ones.
   */
  readonly cellCount: number;
}

/** A row of the results report. */
export interface ResultRow {
  /** The matrix row this result is for. */
  readonly id: string;
  /** The group the matrix row belongs to. */
  readonly area: string;
  /** The requirement the matrix row names. */
  readonly feature: string;
  /** The measured outcome. */
  readonly outcome: string;
  /** The evidence class the measurement was made under. */
  readonly evidenceClass: string;
  /** What was measured, in one sentence. */
  readonly measured: string;
  /** The test that produced the measurement — `file` and `title`. */
  readonly linkedTest: { readonly file: string; readonly title: string };
  /** The owning task's test that pins the same fact. */
  readonly pinningTest: { readonly file: string; readonly title: string } | undefined;
  /** The command that reproduces the measurement. */
  readonly reproduce: string;
}

/* -------------------------------------------------------------------------- */
/* The parsing                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The canonical form of an evidence class.
 *
 * The markdown is stripped, the parenthetical explanation is dropped, and an
 * empty cell — the matrix's `—` — becomes `unknown`.
 */
export function canonicalizeEvidenceClass(cell: string): EvidenceClass {
  const text = cell.replace(/\*\*/g, '').replace(/`/g, '').trim();
  const head = (text.split('(')[0] ?? '').trim().toLowerCase();
  if (head === '' || head === '—' || head === '-') return 'unknown';
  if ((EVIDENCE_CLASSES as readonly string[]).includes(head)) return head as EvidenceClass;
  return 'unknown';
}

/**
 * Parse the feature matrix.
 *
 * Only the rows of the matrix table are read: a line whose first cell looks
 * like a row id (`F-01`, `F-15b`). The totals table and the prose are ignored.
 */
export function parseMatrix(markdown: string): MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const line of markdown.split('\n')) {
    const cells = cellsOf(line);
    const id = cells[0];
    if (id === undefined || !/^F-\d+[a-z]?$/.test(id)) continue;
    const area = cells[1] ?? '';
    const feature = cells[2] ?? '';
    const status = cells[3] ?? '';
    const evidenceClass = cells[4] ?? '';
    // The last three columns are read from the **end** of the row: four of the
    // matrix's rows carry a pipe inside a cell, and reading the tail keeps the
    // implementation status, the owning task and the test ref correct for them too.
    const cloneStatus = cells[cells.length - 3] ?? '';
    const owningTask = cells[cells.length - 2] ?? '';
    const testRef = cells[cells.length - 1] ?? '';
    rows.push({
      id,
      area,
      feature,
      status,
      evidenceClass,
      canonicalEvidenceClass: canonicalizeEvidenceClass(evidenceClass),
      cloneStatus,
      owningTask,
      testRef,
      cellCount: cells.length,
    });
  }
  return rows;
}

/**
 * Parse a `file — "title"` reference.
 *
 * The cell carries the file in backticks and the title in double quotes.
 */
function parseTestReference(cell: string): { file: string; title: string } | undefined {
  const match = /`([^`]+)`\s*—\s*"([^"]+)"/.exec(cell);
  if (match === null) return undefined;
  const file = match[1];
  const title = match[2];
  if (file === undefined || title === undefined) return undefined;
  return { file, title };
}

/**
 * Parse the results report.
 *
 * Only the rows of the report's table are read: a line whose first cell looks
 * like a row id.
 */
export function parseResults(markdown: string): ResultRow[] {
  const rows: ResultRow[] = [];
  for (const line of markdown.split('\n')) {
    const cells = cellsOf(line);
    const id = cells[0];
    if (id === undefined || !/^F-\d+[a-z]?$/.test(id)) continue;
    const area = cells[1] ?? '';
    const feature = cells[2] ?? '';
    const evidenceClass = cells[3] ?? '';
    const outcome = cells[4] ?? '';
    const measured = cells[5] ?? '';
    const linkedCell = cells[6] ?? '';
    const pinningCell = cells[7] ?? '';
    const reproduceCell = cells[8] ?? '';
    const linkedTest = parseTestReference(linkedCell);
    const pinningTest = parseTestReference(pinningCell);
    rows.push({
      id,
      area,
      feature,
      outcome,
      evidenceClass,
      measured,
      linkedTest: linkedTest ?? { file: '', title: '' },
      pinningTest,
      reproduce: reproduceCell.replace(/`/g, '').trim(),
    });
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* The rule                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Whether a row may be reported as `match`.
 *
 * The matrix's rule, applied literally: the evidence class must be
 * `REA observed`, and the target's evidence must not be `unknown` or
 * `partial`.
 */
export function mayReportMatch(row: MatrixRow): boolean {
  if (row.canonicalEvidenceClass !== 'rea observed') return false;
  if (row.status === 'partial' || row.status === 'unknown') return false;
  return true;
}

/**
 * The outcomes a row may be reported with.
 *
 * `match` is in the set only when the row's own evidence permits it.
 * `mismatch` is always permitted: it is the honest downgrade, and no row is
 * forbidden from reporting that this implementation differs.
 */
export function permittedOutcomes(row: MatrixRow): readonly Outcome[] {
  const base: readonly Outcome[] = ['partial', 'mismatch', 'not-tested', 'unknown'];
  return mayReportMatch(row) ? ['match', ...base] : base;
}

/* -------------------------------------------------------------------------- */
/* The readers                                                                 */
/* -------------------------------------------------------------------------- */

/** Read the feature matrix from disk. */
export function readMatrix(): MatrixRow[] {
  return parseMatrix(readFileSync(FEATURE_MATRIX_PATH, 'utf8'));
}

/** Read the results report from disk. */
export function readResults(): ResultRow[] {
  return parseResults(readFileSync(RESULTS_PATH, 'utf8'));
}

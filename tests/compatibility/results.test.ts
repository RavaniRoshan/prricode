/**
 * The results test: the report must agree with the matrix and with the
 * measurement.
 *
 * The plan's `CC-019` Step 1 asks for exactly this:
 *
 * > every feature-matrix row has exactly one results row, and every result row
 * > with `match` has a linked passing test. A row whose target evidence class
 * > is `unknown` may not be reported as `match`.
 *
 * The matrix's own **compatibility-reporting rule** adds the rest:
 *
 * > A row may be reported as `match` in `docs/compatibility/results.md` only
 * > when its evidence class is `REA observed` **and** a test in the owning task
 * > passes. A row whose target evidence is `unknown` or `partial` may be
 * > reported as `partial`, `not-tested`, or `unknown` — never as `match`.
 *
 * ## What makes the report trustworthy
 *
 * The test does not read the report and believe it. It **re-runs** the
 * measurement: every scenario is executed against this implementation, and the outcome
 * the report carries must be the outcome the measurement produced. A `match`
 * whose scenario no longer holds fails here, and so does a report that claims
 * a `match` for a row the matrix forbids.
 *
 * The report's **prose** is bound to the measurement too: the "What was
 * measured" cell of a row must be the **detail** the probe returned, so every
 * explanatory sentence in the report is the harness's own words and not the
 * writer's.
 *
 * The **measurement** is bound to this implementation: a probe that observed nothing of
 * this implementation, or that asserted a constant rather than a value it observed, is
 * not a measurement, and the report may not carry it.
 *
 * The links are checked too: the linked test must be a test this repository
 * really has, the pinning test must be a test the owning task really has, the
 * matrix's own **Test ref** must name a file this repository has, and two rows
 * may not claim the same scenario.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  OUTCOMES,
  RESULTS_PATH,
  canonicalizeEvidenceClass,
  isOutcome,
  mayReportMatch,
  parseTotals,
  permittedOutcomes,
  readMatrix,
  readResults,
  type MatrixRow,
  type Outcome,
  type ResultRow,
} from './matrix.js';
import { REPOSITORY_ROOT } from './scenarios.js';
import { SCENARIOS, meaningfulness, measure, scenarioOf } from './scenarios.js';
import { declaredTitlesOf } from './references.js';

const REPOSITORY = fileURLToPath(new URL('../../', import.meta.url));

/** The harness's own test file — the linked test of every row. */
const HARNESS_FILE = 'tests/compatibility/scenarios.test.ts';

/** The matrix's rows. */
const MATRIX: MatrixRow[] = readMatrix();

/** The report's rows. */
const RESULTS: ResultRow[] = existsSync(RESULTS_PATH) ? readResults() : [];

/** The rows of the matrix, by id. */
const MATRIX_BY_ID = new Map(MATRIX.map((row) => [row.id, row]));

/**
 * The text of a test file, for the link checks.
 *
 * The links are checked against the **source** of the test, so that a report
 * that names a test nobody wrote fails here.
 */
function testSourceOf(relativePath: string): string | undefined {
  const absolute = path.join(REPOSITORY, relativePath);
  if (!existsSync(absolute)) return undefined;
  return readFileSync(absolute, 'utf8');
}

/**
 * The files a cell names.
 *
 * A cell names its files in backticks; a cell that names none names no file.
 */
function filesOf(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1] ?? '')
    .filter((candidate) => /[/\\]/.test(candidate) || /\.(ts|tsx|js|mjs|md|json)$/.test(candidate));
}

describe('the compatibility report', () => {
  it('the report exists', () => {
    expect(
      existsSync(RESULTS_PATH),
      `${RESULTS_PATH} does not exist: the report is this milestone's deliverable`,
    ).toBe(true);
  });

  it('the matrix has 42 rows, and every one of them has exactly one results row', () => {
    expect(MATRIX.length).toBe(42);
    const resultIds = RESULTS.map((row) => row.id);
    for (const matrixRow of MATRIX) {
      const matching = resultIds.filter((id) => id === matrixRow.id);
      expect(matching.length, `${matrixRow.id} has ${matching.length} results rows`).toBe(1);
    }
    // No result row names a row the matrix does not have.
    for (const result of RESULTS) {
      expect(
        MATRIX_BY_ID.has(result.id),
        `${result.id} is not a feature-matrix row`,
      ).toBe(true);
    }
  });

  it('the harness measures exactly the rows the matrix names', () => {
    // A scenario for a row the matrix does not have measures nothing, and a
    // matrix row without a scenario is not measured at all.
    const matrixIds = MATRIX.map((row) => row.id).sort();
    const scenarioIds = SCENARIOS.map((scenario) => scenario.rowId).sort();
    expect(scenarioIds).toEqual(matrixIds);
  });

  it('every matrix row reads as nine columns', () => {
    // A row that carries a pipe inside a cell must still read as nine columns:
    // a reader that splits on the pipe reads the wrong tail columns.
    for (const row of MATRIX) {
      expect(
        row.cellCount,
        `${row.id} reads as ${row.cellCount} columns, not nine: a pipe inside a cell is splitting the row`,
      ).toBe(9);
    }
  });

  it('the matrix\'s own test ref names a file this repository has', () => {
    for (const row of MATRIX) {
      const files = filesOf(row.testRef);
      if (files.length === 0) {
        // A row with no test of its own — the whole-image native inventory —
        // names none, and the matrix must not invent one.
        expect(row.testRef, `${row.id} names no test ref`).toMatch(/^—$/);
        continue;
      }
      for (const file of files) {
        const source = testSourceOf(file);
        expect(source, `${row.id} names the test ref ${file}, which does not exist`).toBeDefined();
        expect(
          source ?? '',
          `${row.id} names the test ref ${file}, which has no test in it`,
        ).toMatch(/\b(it|test)\(/);
      }
    }
  });

  it('no two rows claim the same scenario', () => {
    const linked = RESULTS.map((row) => `${row.linkedTest.file} — ${row.linkedTest.title}`);
    expect(new Set(linked).size, 'two results rows claim the same linked test').toBe(linked.length);
    const rowIds = RESULTS.map((row) => row.id);
    expect(new Set(rowIds).size, 'two results rows claim the same matrix row').toBe(rowIds.length);
  });

  it('every results row names a linked test that exists, and the scenario that measures it', () => {
    const source = testSourceOf(HARNESS_FILE);
    expect(source, `${HARNESS_FILE} does not exist`).toBeDefined();
    for (const result of RESULTS) {
      const scenario = SCENARIOS.find(
        (candidate) => candidate.title === result.linkedTest.title,
      );
      expect(
        scenario,
        `${result.id} names a linked test no scenario provides: ${result.linkedTest.title}`,
      ).toBeDefined();
      expect(result.linkedTest.file).toBe(HARNESS_FILE);
      expect(scenario?.rowId).toBe(result.id);
      expect(source).toContain(result.linkedTest.title);
    }
  });

  it('every results row names the evidence class its matrix row carries', () => {
    for (const result of RESULTS) {
      const matrixRow = MATRIX_BY_ID.get(result.id);
      expect(matrixRow, `${result.id} is not a feature-matrix row`).toBeDefined();
      expect(
        canonicalizeEvidenceClass(result.evidenceClass),
        `${result.id} carries the evidence class "${result.evidenceClass}"`,
      ).toBe(matrixRow?.canonicalEvidenceClass);
    }
  });

  it('no row is reported as a match that its evidence forbids', () => {
    for (const result of RESULTS) {
      const matrixRow = MATRIX_BY_ID.get(result.id);
      expect(matrixRow, `${result.id} is not a feature-matrix row`).toBeDefined();
      if (result.outcome !== 'match') continue;
      expect(
        mayReportMatch(matrixRow!),
        `${result.id} is reported as a match, but its evidence class is "${matrixRow!.evidenceClass}" and its status is "${matrixRow!.status}"`,
      ).toBe(true);
    }
  });

  it('every outcome is one of the five, and it is one the row may report', () => {
    for (const result of RESULTS) {
      expect(isOutcome(result.outcome), `${result.id} carries the outcome "${result.outcome}"`).toBe(
        true,
      );
      const matrixRow = MATRIX_BY_ID.get(result.id);
      expect(matrixRow, `${result.id} is not a feature-matrix row`).toBeDefined();
      expect(
        permittedOutcomes(matrixRow!).includes(result.outcome as never),
        `${result.id} may not be reported as "${result.outcome}"`,
      ).toBe(true);
    }
  });

  it('every results row names the command that reproduces it', () => {
    for (const result of RESULTS) {
      expect(result.reproduce.length, `${result.id} names no command`).toBeGreaterThan(0);
      expect(result.reproduce).toContain('vitest run');
      expect(result.reproduce).toContain(result.linkedTest.title);
    }
  });

  it('every results row names the pinning test of the owning task, and that test exists', () => {
    for (const result of RESULTS) {
      const scenario = scenarioOf(result.id);
      if (scenario.pinning === undefined) {
        // A scenario with no owning-task test — the whole-image native
        // inventory — names none, and the report must not invent one.
        expect(
          result.pinningTest,
          `${result.id} names a pinning test, but no owning-task test pins it`,
        ).toBeUndefined();
        continue;
      }
      expect(result.pinningTest, `${result.id} names no pinning test`).toBeDefined();
      expect(result.pinningTest?.file).toBe(scenario.pinning.file);
      expect(result.pinningTest?.title).toBe(scenario.pinning.title);
      const source = testSourceOf(scenario.pinning.file);
      expect(source, `${scenario.pinning.file} does not exist`).toBeDefined();
      // The pinning test is a **declared** title of that file: a file that
      // merely repeats the words does not pin anything.
      const declared = declaredTitlesOf(source ?? '');
      expect(
        declared,
        `${scenario.pinning.file} declares no test called "${scenario.pinning.title}"`,
      ).toContain(scenario.pinning.title);
    }
  });

  it('the totals the report declares are the totals its own rows make', () => {
    // The report's totals are a claim about its rows. The claim is checked
    // here, so a row that changes its outcome cannot leave the totals stale.
    const totals = parseTotals(readFileSync(RESULTS_PATH, 'utf8'));
    const counted = new Map<Outcome, number>();
    for (const result of RESULTS) {
      const outcome = result.outcome as Outcome;
      counted.set(outcome, (counted.get(outcome) ?? 0) + 1);
    }
    for (const outcome of OUTCOMES) {
      expect(
        totals.get(outcome),
        `the report declares ${String(totals.get(outcome))} rows for "${outcome}", but it carries ${String(counted.get(outcome) ?? 0)}`,
      ).toBe(counted.get(outcome) ?? 0);
    }
    const total = [...counted.values()].reduce((sum, count) => sum + count, 0);
    expect(total, 'the report does not carry one row per matrix row').toBe(MATRIX.length);
  });

  it('every results row carries the measurement the harness produced', async () => {
    for (const result of RESULTS) {
      const scenario = scenarioOf(result.id);
      const measurement = await measure(scenario);
      expect(
        measurement.failed,
        `${result.id} does not measure: ${measurement.detail}`,
      ).toBe(false);
      expect(
        measurement.outcome,
        `${result.id} is reported as "${result.outcome}", but the harness measured "${measurement.outcome}" (${measurement.detail})`,
      ).toBe(result.outcome);
    }
  });

  it('every results row carries the prose the harness wrote', async () => {
    // The "What was measured" cell is the probe's own detail. The report's
    // sentences are therefore the harness's, and a cell that was edited by
    // hand fails here.
    for (const result of RESULTS) {
      const scenario = scenarioOf(result.id);
      const measurement = await measure(scenario);
      expect(
        result.measured,
        `${result.id} carries a "What was measured" cell that is not the harness's own: the harness measured "${measurement.detail}"`,
      ).toBe(measurement.detail);
    }
  });

  it('every measurement measured something', async () => {
    // A probe that observes nothing of this implementation, or that asserts a constant
    // rather than a value it observed, is not a measurement — and the report
    // may not carry one.
    const problems: string[] = [];
    for (const result of RESULTS) {
      const scenario = scenarioOf(result.id);
      const measurement = await measure(scenario);
      const meaning = meaningfulness(measurement);
      if (!meaning.meaningful) problems.push(`${result.id} measured nothing: ${meaning.reason}`);
    }
    expect(problems).toEqual([]);
  });

  it('every row reported as a match has a scenario that passes', async () => {
    for (const result of RESULTS) {
      if (result.outcome !== 'match') continue;
      const scenario = scenarioOf(result.id);
      const measurement = await measure(scenario);
      expect(
        measurement.failed,
        `${result.id} is reported as a match, but its scenario does not pass: ${measurement.detail}`,
      ).toBe(false);
      expect(measurement.outcome).toBe('match');
    }
  });

  it('the repository root the harness reads is the repository this test runs in', () => {
    expect(REPOSITORY_ROOT).toBe(REPOSITORY);
  });
});

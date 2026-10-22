/**
 * The verification — **the criteria, really checked, and compared with what
 * the run claimed**.
 *
 * **One responsibility:** the execution of the acceptance criteria against the
 * files the build produced, and the comparison of that execution with the
 * verdict the run gave.
 *
 * ## The rule this module exists to keep
 *
 * > **A run that claims a criterion is met and does not meet it must fail.**
 *
 * So there are two verdicts here, and they are kept apart:
 *
 *   - the **claim** — what the run said: the pipeline's own check over the
 *     documents the run holds, which says that a criterion is met when a file
 *     delivers it;
 *   - the **execution** — what the files actually do: the tests that cover the
 *     criterion, **run**, and their own verdict.
 *
 * The claim is a statement about the documents. The execution is a fact about
 * the product. When the claim is **more generous** than the execution, the
 * run is **wrong**, and the comparison says so — with the criteria named.
 *
 * ## How a criterion is met
 *
 * A criterion is met when **a test that covers it passes**. The test that
 * covers a criterion is a test file the build produced that names the
 * criterion, and the coverage is the build's own: the `satisfies` number the
 * file carries is the criterion it delivers.
 *
 * So a criterion with **no test** is **not met** — not because a rule says
 * so, but because nothing demonstrated it. A criterion whose test **fails** is
 * not met either. Both are facts about the product, and both are found by
 * running the product's own tests.
 *
 * ## The under-claim
 *
 * The other direction — the run said a criterion was **not** met, and the
 * execution says it is — is reported, and it is **not** a failure. A run that
 * is too careful has not faked anything.
 */

import path from 'node:path';

import type { ProductTestFileResult, ProductTestRun, ProductTestRunner } from './testrun.js';

/** One artefact the build produced, as the verification reads it. */
export interface ProductArtefact {
  /** The path of the file, relative to the product's own directory. */
  readonly path: string;
  /** The text of the file. */
  readonly content: string;
  /** The acceptance criterion the artefact delivers — one-based. */
  readonly criterion: number;
}

/** What the run claimed about one criterion. */
export interface ClaimedCheck {
  /** The criterion that was checked. */
  readonly criterion: string;
  /** Whether the run said it was met. */
  readonly passed: boolean;
  /** Why, in the run's own words. */
  readonly detail: string;
}

/** One criterion, and the verdict of the check that was really executed. */
export interface ExecutedCheck {
  /** The criterion's number — one-based. */
  readonly index: number;
  /** The criterion itself. */
  readonly criterion: string;
  /** Whether the execution met it. */
  readonly passed: boolean;
  /** Why, in one line. */
  readonly detail: string;
  /** The test files that cover it. */
  readonly tests: readonly string[];
}

/** The claim, and the execution, side by side. */
export interface VerificationComparison {
  /** Whether the claim and the execution agree. */
  readonly agreed: boolean;
  /** What the run claimed: every criterion met. */
  readonly claimed: boolean;
  /** What the execution found: every criterion met. */
  readonly executed: boolean;
  /** The criteria the run claimed were met and are not. */
  readonly overClaimed: readonly string[];
  /** The criteria the run claimed were not met and are. */
  readonly underClaimed: readonly string[];
  /** The comparison, in one sentence. */
  readonly detail: string;
}

/** What the run claimed, whole. */
export interface VerificationClaim {
  /** The checks the run made, one per criterion. */
  readonly checks: readonly ClaimedCheck[];
  /** Whether the run claimed that every criterion was met. */
  readonly passed: boolean;
}

/** The verification, whole. */
export interface ProductVerification {
  /** The checks, really executed. */
  readonly checks: readonly ExecutedCheck[];
  /** What the run claimed, beside the execution. */
  readonly claimed: VerificationClaim;
  /** The claim, and the execution, side by side. */
  readonly comparison: VerificationComparison;
  /** The product's own test run. */
  readonly tests: ProductTestRun;
  /** Whether every criterion was met by the execution. */
  readonly passed: boolean;
}

/**
 * Whether a path denotes a test.
 *
 * A file whose name carries `.test.` or `.spec.`, or a file that lives in a
 * `test`, `tests` or `spec` directory, is a test. The reading is ours: the
 * pipeline's format says what a file is for, not what it is called.
 */
export function isTestPath(filePath: string): boolean {
  const segments = filePath.split('/').filter((segment) => segment.length > 0);
  const name = segments.at(-1) ?? '';
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) return true;
  const first = segments[0];
  return first === 'test' || first === 'tests' || first === 'spec';
}

/** The verdict of one file, looked up by its path. */
function verdictOf(
  results: readonly ProductTestFileResult[],
  file: string,
): ProductTestFileResult | undefined {
  for (const result of results) {
    if (result.path === file) return result;
  }
  return undefined;
}

/** How the verification is run. */
export interface ExecuteVerificationOptions {
  /** The specification's acceptance criteria, in order. */
  readonly criteria: readonly string[];
  /** The files the build produced. */
  readonly artefacts: readonly ProductArtefact[];
  /** What the run claimed, one entry per criterion. */
  readonly claimed: readonly ClaimedCheck[];
  /** The runner that runs the product's own tests. */
  readonly runner: ProductTestRunner;
  /** The directory the product's files are in. */
  readonly cwd: string;
}

/**
 * Execute the criteria, and compare the execution with the claim.
 *
 * The **test run** is the product's own: every test file the build produced
 * is run, once, and the verdicts are the runner's. The criteria are then read
 * off that run — a criterion is met by the tests that cover it.
 */
export async function executeVerification(
  options: ExecuteVerificationOptions,
): Promise<ProductVerification> {
  const testArtefacts = options.artefacts.filter((artefact) => isTestPath(artefact.path));
  const testFiles = testArtefacts.map((artefact) => path.resolve(options.cwd, artefact.path));

  const tests = await options.runner.run(testFiles, { cwd: options.cwd });

  const checks: ExecutedCheck[] = options.criteria.map((criterion, index) => {
    const number = index + 1;
    const covering = testArtefacts.filter((artefact) => artefact.criterion === number);
    if (covering.length === 0) {
      return {
        index: number,
        criterion,
        passed: false,
        detail:
          'no test covers this acceptance criterion, and a criterion that nothing tests is not met',
        tests: [],
      };
    }
    const failures: string[] = [];
    for (const artefact of covering) {
      const file = path.resolve(options.cwd, artefact.path);
      const result = verdictOf(tests.files, file);
      if (result === undefined) {
        failures.push(`${artefact.path} (the runner reported nothing about it)`);
        continue;
      }
      if (!result.passed) failures.push(`${artefact.path} (${result.detail})`);
    }
    return {
      index: number,
      criterion,
      passed: failures.length === 0,
      detail:
        failures.length === 0
          ? `${covering.length} test(s) cover it, and every one of them passed`
          : `the test that covers it failed: ${failures.join('; ')}`,
      tests: covering.map((artefact) => artefact.path),
    };
  });

  const executed = checks.every((check) => check.passed);
  const claim = {
    checks: options.claimed,
    passed: options.claimed.length > 0 && options.claimed.every((check) => check.passed),
  };
  const comparison = compare(criteriaClaimed(options.claimed, options.criteria), checks, executed);

  return { checks, claimed: claim, comparison, tests, passed: executed };
}

/**
 * The claim, read criterion by criterion.
 *
 * The claim and the criteria have to pair: a claim about a different set of
 * criteria is not a claim about these, and it is reported as a disagreement
 * rather than read as if it fitted.
 */
function criteriaClaimed(
  claimed: readonly ClaimedCheck[],
  criteria: readonly string[],
): readonly (ClaimedCheck | undefined)[] {
  return criteria.map((criterion, index) => {
    const byText = claimed.find((check) => check.criterion === criterion);
    if (byText !== undefined) return byText;
    return claimed[index];
  });
}

/** The comparison of the claim with the execution. */
function compare(
  claimed: readonly (ClaimedCheck | undefined)[],
  checks: readonly ExecutedCheck[],
  executed: boolean,
): VerificationComparison {
  const overClaimed: string[] = [];
  const underClaimed: string[] = [];
  const reasons: string[] = [];

  for (const check of checks) {
    const claim = claimed[check.index - 1];
    if (claim === undefined) continue;
    if (claim.passed && !check.passed) {
      overClaimed.push(check.criterion);
      // The criterion is named, and so is **why** the execution did not meet
      // it: a failure that does not say what failed is half a report.
      reasons.push(`${check.criterion} (${check.detail})`);
    }
    if (!claim.passed && check.passed) underClaimed.push(check.criterion);
  }

  const claimedAll = claimed.every((check) => check !== undefined && check.passed);
  const agreed = overClaimed.length === 0;

  let detail: string;
  if (overClaimed.length > 0) {
    detail =
      `the run claimed ${overClaimed.length} acceptance criterion/criteria were met, and the product's own test run does not meet ${overClaimed.length === 1 ? 'it' : 'them'}: ` +
      reasons.join('; ');
  } else if (underClaimed.length > 0) {
    detail =
      `the run claimed ${underClaimed.length} acceptance criterion/criteria were not met, and the product's own test run does meet ${underClaimed.length === 1 ? 'it' : 'them'}`;
  } else {
    detail = 'the run claimed what the product does, and the product does what the run claimed';
  }

  return { agreed, claimed: claimedAll, executed, overClaimed, underClaimed, detail };
}

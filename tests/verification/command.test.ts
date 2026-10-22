/**
 * The **command** — one command that runs all four kinds, and a report that
 * says which passed.
 *
 * **The milestone:** `CC-050` of
 * [`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../../docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md).
 *
 * ## What is measured, and how
 *
 * - **The report names every kind, and says which passed.** A kind that failed
 *   is named, and so is the check that failed; a kind that could not run says
 *   why, in the shared shape.
 * - **The exit code says the same thing.** Zero when every kind passed, one
 *   when a kind failed, and two when a kind could not run — so a suite that
 *   could not measure everything never reads as a suite that measured
 *   everything and found nothing wrong.
 * - **The command runs.** The whole thing is run here, and the exit code it
 *   leaves behind is the one the shell would see.
 */

import { describe, expect, it } from 'vitest';

import {
  VERIFICATION_KINDS,
  exitCodeOf,
  formatVerificationReport,
  main,
  readArguments,
  runVerification,
  type VerificationKindResult,
  type VerificationReport,
} from '../../scripts/verify-product.js';

/* -------------------------------------------------------------------------- */
/* The helpers                                                                  */
/* -------------------------------------------------------------------------- */

/** A kind that passed. */
function passingKind(kind: string): VerificationKindResult {
  return {
    kind: kind as VerificationKindResult['kind'],
    title: `the ${kind}`,
    enabled: true,
    unsupported: null,
    state: 'passed',
    checks: [{ name: 'a check', passed: true, detail: 'it passed' }],
  };
}

/** A kind that failed. */
function failingKind(kind: string): VerificationKindResult {
  return {
    kind: kind as VerificationKindResult['kind'],
    title: `the ${kind}`,
    enabled: true,
    unsupported: null,
    state: 'failed',
    checks: [{ name: 'a check', passed: false, detail: 'it did not pass' }],
  };
}

/** A kind that could not run. */
function unsupportedKind(kind: string): VerificationKindResult {
  return {
    kind: kind as VerificationKindResult['kind'],
    title: `the ${kind}`,
    enabled: false,
    unsupported: 'there is nothing to measure here',
    state: 'unsupported',
    checks: [],
  };
}

/** A report of the given kinds. */
function reportOf(kinds: readonly VerificationKindResult[]): VerificationReport {
  const failed = kinds.filter((kind) => kind.state === 'failed').length;
  const unsupported = kinds.filter((kind) => kind.state === 'unsupported').length;
  return {
    kinds,
    passed: failed === 0 && unsupported === 0 && kinds.length > 0,
    failed,
    unsupported,
  };
}

/** Run something with the standard output taken over. */
async function capture(
  body: () => Promise<number>,
): Promise<{ readonly code: number; readonly output: string }> {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await body();
    return { code, output: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
}

/* -------------------------------------------------------------------------- */
/* The kinds                                                                    */
/* -------------------------------------------------------------------------- */

describe('the four kinds', () => {
  it('are the four the milestone names', () => {
    expect(VERIFICATION_KINDS).toEqual(['product', 'backend', 'frontend', 'visual']);
  });

  it('are all run by the suite, and all report', async () => {
    const report = await runVerification();

    expect(report.kinds.map((kind) => kind.kind)).toEqual([
      'product',
      'backend',
      'frontend',
      'visual',
    ]);
    for (const kind of report.kinds) {
      expect(kind.title.length).toBeGreaterThan(0);
      expect(kind.checks.length).toBeGreaterThan(0);
    }
    expect(report.failed).toBe(0);
    expect(report.unsupported).toBe(0);
    expect(report.passed).toBe(true);
  });

  it('can be run one at a time', async () => {
    const report = await runVerification({ kinds: ['backend'] });

    expect(report.kinds).toHaveLength(1);
    expect(report.kinds[0]?.kind).toBe('backend');
    expect(report.passed).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The report                                                                   */
/* -------------------------------------------------------------------------- */

describe('the report', () => {
  it('names every kind, and says which passed', () => {
    const report = reportOf([passingKind('product'), failingKind('backend')]);
    const text = formatVerificationReport(report);

    expect(text).toContain('the verification suite');
    expect(text).toContain('the product — passed');
    expect(text).toContain('the backend — failed');
    expect(text).toContain('FAIL a check — it did not pass');
    expect(text).toContain('the suite: 1 of 2 kind(s) passed, 1 failed');
  });

  it('says why a kind could not run, and does not call it a pass', () => {
    const report = reportOf([passingKind('product'), unsupportedKind('visual')]);
    const text = formatVerificationReport(report);

    expect(text).toContain('the visual — could not run');
    expect(text).toContain('why: there is nothing to measure here');
    expect(text).toContain('the suite: 1 of 2 kind(s) passed, 1 could not run');
    expect(text).not.toContain('the visual — passed');
  });
});

/* -------------------------------------------------------------------------- */
/* The exit code                                                                */
/* -------------------------------------------------------------------------- */

describe('the exit code', () => {
  it('is zero when every kind passed', () => {
    const report = reportOf([passingKind('product'), passingKind('backend')]);
    expect(exitCodeOf(report)).toBe(0);
  });

  it('is one when a kind failed', () => {
    const report = reportOf([passingKind('product'), failingKind('backend')]);
    expect(exitCodeOf(report)).toBe(1);
  });

  it('is two when a kind could not run', () => {
    // A suite that could not measure everything does not read as a suite that
    // measured everything and found nothing wrong.
    const report = reportOf([passingKind('product'), unsupportedKind('visual')]);
    expect(exitCodeOf(report)).toBe(2);
  });

  it('is one when a kind failed, even when another could not run', () => {
    const report = reportOf([failingKind('product'), unsupportedKind('visual')]);
    expect(exitCodeOf(report)).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* The command                                                                  */
/* -------------------------------------------------------------------------- */

describe('the command', () => {
  it('reads its arguments', () => {
    expect(readArguments([]).kinds).toEqual(['product', 'backend', 'frontend', 'visual']);
    expect(readArguments(['--kind=backend']).kinds).toEqual(['backend']);
    expect(readArguments(['backend']).kinds).toEqual(['backend']);
    expect(readArguments(['--kind', 'frontend']).kinds).toEqual(['frontend']);
    expect(readArguments(['--help']).help).toBe(true);
    expect(readArguments(['--kind=nonsense']).kinds).toEqual([
      'product',
      'backend',
      'frontend',
      'visual',
    ]);
  });

  it('prints the usage, and leaves the exit code at zero', async () => {
    const { code, output } = await capture(() => main(['--help']));

    expect(code).toBe(0);
    expect(output).toContain('the verification suite');
    expect(output).toContain('usage: bun run scripts/verify-product.ts');
    expect(output).toContain('the kinds: product, backend, frontend, visual');
  });

  it('runs every kind, prints the report, and leaves the exit code at zero', async () => {
    const { code, output } = await capture(() => main([]));

    expect(code).toBe(0);
    expect(output).toContain('the verification suite');
    expect(output).toContain('the product — passed');
    expect(output).toContain('the backend — passed');
    expect(output).toContain('the frontend — passed');
    expect(output).toContain('the goldens, visually — passed');
    expect(output).toContain('the suite: 4 of 4 kind(s) passed');
    expect(output).not.toContain('FAIL');
  });

  it('runs one kind, and says which one', async () => {
    const { code, output } = await capture(() => main(['--kind=visual']));

    expect(code).toBe(0);
    expect(output).toContain('the goldens, visually — passed');
    expect(output).not.toContain('the product —');
    expect(output).toContain('the suite: 1 of 1 kind(s) passed');
  });
});

/**
 * The **verification suite's own tests**.
 *
 * **The milestone:** `CC-050` of
 * [`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../../docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md).
 *
 * **The conformance document:**
 * [`docs/compatibility/verification.md`](../../docs/compatibility/verification.md).
 *
 * ## What is measured, and how
 *
 * The suite measures four kinds, and **each kind is measured against its own
 * failure**: a kind that cannot go red is a claim, not a check. So every kind
 * is driven here in the state that must fail, and the test says which check
 * went red.
 *
 * | the kind | the state that must fail |
 * |---|---|
 * | the product | a run that **over-claims** and is accepted |
 * | the backend | a backend that refuses every request |
 * | the frontend | a golden that is not the picture that is drawn now |
 * | visually | a golden that is **stale** |
 *
 * And the **other** rule is measured here too: a kind that **cannot run**
 * reports `enabled: false` and `unsupported: <why>` — it does not pass
 * vacuously, and it does not skip quietly.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkBackend,
  checkFrontend,
  checkProduct,
  checkVisual,
  runTheProduct,
  startFakeBackend,
  type FakeBackendFactory,
  type ProductRunner,
  type VerificationKindResult,
} from '../../scripts/verify-product.js';
import { GOLDENS, picturePath, recordPath, writeGolden } from '../visual/goldens.js';

/* -------------------------------------------------------------------------- */
/* The helpers                                                                  */
/* -------------------------------------------------------------------------- */

/** The directories this file opened, so that every test leaves none behind. */
const opened: string[] = [];

afterEach(() => {
  while (opened.length > 0) {
    const directory = opened.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

/** A directory of its own. */
function scratch(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'prricode-verification-'));
  opened.push(directory);
  return directory;
}

/** The checks of a kind, by name. */
function checkNamed(result: VerificationKindResult, name: string) {
  const found = result.checks.find((check) => check.name === name);
  if (found === undefined) {
    throw new Error(
      `the kind "${result.kind}" has no check named "${name}"; it has: ${result.checks
        .map((check) => check.name)
        .join(', ')}`,
    );
  }
  return found;
}

/** The checks of a kind that did not pass. */
function failuresOf(result: VerificationKindResult): readonly string[] {
  return result.checks.filter((check) => !check.passed).map((check) => check.name);
}

/* -------------------------------------------------------------------------- */
/* 1. The product                                                              */
/* -------------------------------------------------------------------------- */

describe('the product kind', () => {
  it('passes on an honest run, and on a run that over-claims', async () => {
    const result = await checkProduct();

    expect(result.enabled).toBe(true);
    expect(result.unsupported).toBeNull();
    expect(result.state).toBe('passed');
    expect(failuresOf(result)).toEqual([]);
  });

  it('measures the eight stages, the documents and the verification', async () => {
    const result = await checkProduct();

    const stages = checkNamed(result, 'the run reaches all eight stages');
    expect(stages.passed).toBe(true);
    expect(stages.detail).toContain('concept');
    expect(stages.detail).toContain('operate');

    const documents = checkNamed(result, 'the run produces the eight documents, and writes them down');
    expect(documents.passed).toBe(true);
    expect(documents.detail).toContain('8 document(s)');

    const verification = checkNamed(result, 'the verification is really executed');
    expect(verification.passed).toBe(true);
    expect(verification.detail).toContain('test file(s) ran');
  });

  it('fails when a run that over-claims is accepted', async () => {
    // The product is broken: it accepts a run that claims a criterion is met
    // while its own test run does not meet it.
    const lying: ProductRunner = async (build, node) => {
      const run = await runTheProduct(build, node);
      const verification = run.verification;
      return {
        ...run,
        state: 'verified',
        failedAt: null,
        reason: null,
        ...(verification === null
          ? {}
          : {
              verification: {
                ...verification,
                comparison: { ...verification.comparison, agreed: true, overClaimed: [] },
              },
            }),
      };
    };

    const result = await checkProduct({ run: lying });

    expect(result.state).toBe('failed');
    expect(failuresOf(result)).toContain('a run that over-claims fails at the stage that claimed it');
    // And the rest of the kind is untouched: only the broken thing went red.
    expect(checkNamed(result, 'the run reaches all eight stages').passed).toBe(true);
  });

  it('fails when a run that over-claims releases something', async () => {
    const releasing: ProductRunner = async (build, node) => {
      const run = await runTheProduct(build, node);
      const records = new Map(run.records);
      records.set('ship', 'completed');
      records.set('operate', 'completed');
      return { ...run, records };
    };

    const result = await checkProduct({ run: releasing });

    expect(result.state).toBe('failed');
    expect(failuresOf(result)).toContain('a run that over-claims releases nothing');
  });

  it('reports that it could not run when there is no node to run the product own tests', async () => {
    const result = await checkProduct({ node: null });

    // The shared shape: the kind says it could not run, and why.
    expect(result.enabled).toBe(false);
    expect(result.unsupported).toContain('node');
    expect(result.state).toBe('unsupported');
    // It does not pass vacuously, and it does not skip quietly.
    expect(result.checks).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. The backend                                                              */
/* -------------------------------------------------------------------------- */

describe('the backend kind', () => {
  it('passes against a fake backend that speaks every API shape', async () => {
    const result = await checkBackend();

    expect(result.enabled).toBe(true);
    expect(result.unsupported).toBeNull();
    expect(result.state).toBe('passed');
    expect(failuresOf(result)).toEqual([]);
  });

  it('measures the protocol over a real pipe, and the frames on the wire', async () => {
    const result = await checkBackend();

    const pipe = checkNamed(result, 'the protocol answers over a real pipe');
    expect(pipe.passed).toBe(true);
    expect(pipe.detail).toContain('the server is the process');

    const frames = checkNamed(result, 'the frames on the wire are frames');
    expect(frames.passed).toBe(true);
    expect(frames.detail).toContain('4242');

    const refusal = checkNamed(result, 'a frame that is not JSON is refused with a reason');
    expect(refusal.passed).toBe(true);
    expect(refusal.detail).toContain('frame/malformed');
  });

  it('measures the credential store, and where the secret came from', async () => {
    const result = await checkBackend();

    const stored = checkNamed(result, 'the credential store resolves the secret, and says where it came from');
    expect(stored.passed).toBe(true);
    expect(stored.detail).toContain('encrypted-file');

    const environment = checkNamed(result, 'the environment is a first-class peer of a stored key');
    expect(environment.passed).toBe(true);
    expect(environment.detail).toContain('environment');

    const noSecret = checkNamed(result, 'the provider record carries no secret');
    expect(noSecret.passed).toBe(true);
  });

  it('measures the five failures, and each one degrades with its reason', async () => {
    const result = await checkBackend();

    for (const [name, code] of [
      ['a provider that is not connected degrades with its reason', 'model/not-connected'],
      ['a model that has become unavailable degrades with its reason', 'model/unavailable'],
      ['an endpoint that refuses degrades with its reason', 'model/endpoint-refused'],
      ['a credential that cannot be resolved degrades with its reason', 'model/credential-unresolved'],
      ['an overlay the model does not offer degrades with its reason', 'model/overlay-unknown'],
    ] as const) {
      const check = checkNamed(result, name);
      expect(check.passed).toBe(true);
      expect(check.detail).toContain(code);
      // The failure never claims success: it names the code and the reason.
      expect(check.detail.length).toBeGreaterThan(code.length);
    }
  });

  it('fails when the backend refuses every request', async () => {
    // The backend is broken: it refuses everything, so no provider is reached.
    const refusing: FakeBackendFactory = async (request) =>
      startFakeBackend({ ...request, refuseWith: 500 });

    const result = await checkBackend({ backend: refusing });

    expect(result.state).toBe('failed');
    expect(failuresOf(result)).toContain('the providers are reached over a real socket');
    // The refusal itself is still measured, and still passes: the endpoint
    // that refuses does degrade with its reason.
    expect(
      checkNamed(result, 'an endpoint that refuses degrades with its reason').passed,
    ).toBe(true);
  });

  it('reports that it could not run when there is no node to run the protocol server', async () => {
    const result = await checkBackend({ node: null });

    expect(result.enabled).toBe(false);
    expect(result.unsupported).toContain('node');
    expect(result.state).toBe('unsupported');
    expect(result.checks).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. The frontend                                                             */
/* -------------------------------------------------------------------------- */

describe('the frontend kind', () => {
  it('passes against the recorded goldens', async () => {
    const result = await checkFrontend();

    expect(result.enabled).toBe(true);
    expect(result.unsupported).toBeNull();
    expect(result.state).toBe('passed');
    expect(failuresOf(result)).toEqual([]);
  });

  it('compares every golden with the picture that is drawn now', async () => {
    const result = await checkFrontend();

    for (const definition of GOLDENS) {
      const check = checkNamed(result, `the "${definition.name}" frame is the picture that is drawn now`);
      expect(check.passed).toBe(true);
      expect(check.detail).toContain('the same as the golden');
    }
  });

  it('compares the degraded form against its own golden', async () => {
    const result = await checkFrontend();

    const check = checkNamed(result, 'the degraded form has a golden of its own');
    expect(check.passed).toBe(true);
    expect(check.detail).toContain('the motion is off');
  });

  it('fails when a golden is not the picture that is drawn now', async () => {
    const directory = scratch();
    for (const definition of GOLDENS) writeGolden(definition, directory);
    // The golden is tampered with: it is no longer the picture that is drawn.
    writeFileSync(picturePath('prompt-shimmer', directory), 'something else entirely\n', 'utf8');

    const result = await checkFrontend({ directory });

    expect(result.state).toBe('failed');
    expect(failuresOf(result)).toContain(
      'the "prompt-shimmer" frame is the picture that is drawn now',
    );
    // And only that one: the other goldens are untouched.
    expect(
      checkNamed(result, 'the "state-transition" frame is the picture that is drawn now').passed,
    ).toBe(true);
  });

  it('reports that it could not run when the goldens are not recorded', async () => {
    const result = await checkFrontend({ directory: path.join(scratch(), 'not-there') });

    expect(result.enabled).toBe(false);
    expect(result.unsupported).toContain('the golden frames are not recorded');
    expect(result.state).toBe('unsupported');
    // It does not pass vacuously, and it does not skip quietly.
    expect(result.checks).toEqual([]);
  });

  it('reports that it could not run when the goldens machinery is not there', async () => {
    const result = await checkFrontend({
      load: async () => {
        throw new Error('the machinery is not there');
      },
    });

    expect(result.enabled).toBe(false);
    expect(result.unsupported).toContain('the machinery could not be loaded');
    expect(result.state).toBe('unsupported');
  });
});

/* -------------------------------------------------------------------------- */
/* 4. The goldens, visually                                                    */
/* -------------------------------------------------------------------------- */

describe('the visual kind', () => {
  it('passes against the recorded goldens', async () => {
    const result = await checkVisual();

    expect(result.enabled).toBe(true);
    expect(result.unsupported).toBeNull();
    expect(result.state).toBe('passed');
    expect(failuresOf(result)).toEqual([]);
  });

  it('checks that every golden is current, so a stale picture cannot pass quietly', async () => {
    const result = await checkVisual();

    for (const definition of GOLDENS) {
      const check = checkNamed(result, `the "${definition.name}" golden is current`);
      expect(check.passed).toBe(true);
      expect(check.detail).toContain('the drawing is unchanged');
    }
  });

  it('fails when a golden is stale', async () => {
    const directory = scratch();
    for (const definition of GOLDENS) writeGolden(definition, directory);

    // The golden is not regenerated: its record still carries the fingerprint
    // of a drawing that is not the one that is there.
    const file = recordPath('prompt-shimmer', directory);
    const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, `${JSON.stringify({ ...record, fingerprint: 'a fingerprint of another drawing' }, null, 2)}\n`, 'utf8');

    const result = await checkVisual({ directory });

    expect(result.state).toBe('failed');
    expect(failuresOf(result)).toContain('the "prompt-shimmer" golden is current');
    // The other goldens are current, and stay green.
    expect(checkNamed(result, 'the "state-transition" golden is current').passed).toBe(true);
  });

  it('fails when the record does not describe the picture beside it', async () => {
    const directory = scratch();
    for (const definition of GOLDENS) writeGolden(definition, directory);
    writeFileSync(picturePath('overlay-in', directory), 'a picture that is not the one\n', 'utf8');

    const result = await checkVisual({ directory });

    expect(result.state).toBe('failed');
    expect(failuresOf(result)).toContain(
      'the "overlay-in" record describes the picture beside it',
    );
  });

  it('reports that it could not run when the goldens are not recorded', async () => {
    const result = await checkVisual({ directory: path.join(scratch(), 'not-there') });

    expect(result.enabled).toBe(false);
    expect(result.unsupported).toContain('the golden frames are not recorded');
    expect(result.state).toBe('unsupported');
    expect(result.checks).toEqual([]);
  });
});

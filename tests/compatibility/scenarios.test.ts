/**
 * The compatibility scenario harness's own test: every scenario, run against
 * this implementation.
 *
 * A scenario is one measurable claim. This file runs each of them and fails
 * when a claim does not hold — a probe that throws is a **mismatch**, and the
 * test says so. A scenario that cannot run raises `NotTestedError` and is
 * recorded as `not-tested`, which is **not** a failure.
 *
 * The test also checks that every scenario **measured something**: a probe that
 * observed nothing of this implementation, or that asserted a constant rather than a
 * value it observed, has not measured the claim it names, and the test says
 * so.
 *
 * The tests are written out one by one, with their titles spelled out, so that
 * a reader — and `tests/compatibility/results.test.ts` — can find a scenario by
 * name in this file.
 *
 * The **report** lives in `docs/compatibility/results.md`, and
 * `tests/compatibility/results.test.ts` checks that the report agrees with what
 * this file measured.
 */

import { describe, expect, it } from 'vitest';

import { SESSION_SCHEMA_VERSION } from '../../src/session/event.js';
import { selectRoute } from '../../src/provider/routes.js';

import { readMatrix } from './matrix.js';
import {
  SCENARIOS,
  expect as harnessExpect,
  meaningfulness,
  measure,
  observe,
  observeCall,
  scenarioOf,
  type Scenario,
} from './scenarios.js';

/**
 * Run a scenario and assert that its claim holds.
 *
 * A scenario that measured a mismatch fails here, with the reason the probe
 * gave. A scenario that could not run is recorded as `not-tested` and passes:
 * an honest gap is not a failure. A scenario that measured **nothing** fails
 * too: a probe that asserts a constant is not a measurement.
 */
async function expectScenario(rowId: string): Promise<void> {
  const scenario = scenarioOf(rowId);
  const measurement = await measure(scenario);
  expect(
    measurement.failed,
    `${rowId} did not measure: ${measurement.detail}`,
  ).toBe(false);
  const meaning = meaningfulness(measurement);
  expect(meaning.meaningful, `${rowId} measured nothing: ${meaning.reason}`).toBe(true);
}

describe('compatibility scenarios', () => {
  it('F-01 cli entry and flags', async () => {
    await expectScenario('F-01');
  });

  it('F-02 headless print and the output formats', async () => {
    await expectScenario('F-02');
  });

  it('F-03 the five settings tiers', async () => {
    await expectScenario('F-03');
  });

  it('F-04 the two precedence orderings', async () => {
    await expectScenario('F-04');
  });

  it('F-05 scope isolation and suppression', async () => {
    await expectScenario('F-05');
  });

  it('F-06 the eight provider routes', async () => {
    await expectScenario('F-06');
  });

  it('F-07 the provider-owned model catalog', async () => {
    await expectScenario('F-07');
  });

  it('F-08 route selection', async () => {
    await expectScenario('F-08');
  });

  it('F-09 the per-provider endpoint policy', async () => {
    await expectScenario('F-09');
  });

  it('F-10 the connection registry', async () => {
    await expectScenario('F-10');
  });

  it('F-11 credentials as references only', async () => {
    await expectScenario('F-11');
  });

  it('F-12 request construction', async () => {
    await expectScenario('F-12');
  });

  it('F-13 retry timeout and error classification', async () => {
    await expectScenario('F-13');
  });

  it('F-14 response parsing and streaming', async () => {
    await expectScenario('F-14');
  });

  it('F-15 the local gateway', async () => {
    await expectScenario('F-15');
  });

  it('F-15b the transport the retry loop and sigv4', async () => {
    await expectScenario('F-15b');
  });

  it('F-16 the agent turn and its continuation', async () => {
    await expectScenario('F-16');
  });

  it('F-17 tool-call scheduling order', async () => {
    await expectScenario('F-17');
  });

  it('F-17b the projected tool-result content is a string', async () => {
    await expectScenario('F-17b');
  });

  it('F-18 tool-result shaping and permission feedback', async () => {
    await expectScenario('F-18');
  });

  it('F-19 the permission decision vocabulary', async () => {
    await expectScenario('F-19');
  });

  it('F-20 rule precedence and the modes', async () => {
    await expectScenario('F-20');
  });

  it('F-21 the reason kinds and the file-mutating set', async () => {
    await expectScenario('F-21');
  });

  it('F-22 the host-level gates', async () => {
    await expectScenario('F-22');
  });

  it('F-23 the remote permission transport', async () => {
    await expectScenario('F-23');
  });

  it('F-24 the session storage layout', async () => {
    await expectScenario('F-24');
  });

  it('F-25 resume semantics', async () => {
    await expectScenario('F-25');
  });

  it('F-26 the cross-restart carried prompts', async () => {
    await expectScenario('F-26');
  });

  it('F-27 compaction', async () => {
    await expectScenario('F-27');
  });

  it('F-28 the mcp control-request surface', async () => {
    await expectScenario('F-28');
  });

  it('F-29 the directional control-request policy', async () => {
    await expectScenario('F-29');
  });

  it('F-30 the mcp transport and its batching', async () => {
    await expectScenario('F-30');
  });

  it('F-31 the mcp server lifecycle', async () => {
    await expectScenario('F-31');
  });

  it('F-32 the hook event matrix', async () => {
    await expectScenario('F-32');
  });

  it('F-33 skills subagents plugins marketplaces and the ide', async () => {
    await expectScenario('F-33');
  });

  it('F-34 the native sandbox helper', async () => {
    await expectScenario('F-34');
  });

  it('F-35 the seccomp notification supervisor', async () => {
    await expectScenario('F-35');
  });

  it('F-36 the whole-image native inventory', async () => {
    await expectScenario('F-36');
  });

  it("F-37 the bash tool's sandbox routing", async () => {
    await expectScenario('F-37');
  });

  it('F-38 the command-line surface', async () => {
    await expectScenario('F-38');
  });

  it('F-39 the interactive terminal ui', async () => {
    await expectScenario('F-39');
  });

  it('F-40 the multi-provider manager surfaces', async () => {
    await expectScenario('F-40');
  });

  it('measures one scenario per feature-matrix row', () => {
    // The harness is complete: every row has a scenario, and no two scenarios
    // claim the same row.
    const rowIds = SCENARIOS.map((scenario) => scenario.rowId);
    expect(new Set(rowIds).size).toBe(rowIds.length);
    const titles = SCENARIOS.map((scenario) => scenario.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('measures exactly the rows the feature matrix names', () => {
    // The two sets are **equal**: a scenario for a row the matrix does not
    // have measures nothing, and a matrix row without a scenario is not
    // measured at all.
    const matrixIds = readMatrix().map((row) => row.id);
    const scenarioIds = SCENARIOS.map((scenario) => scenario.rowId);
    expect([...scenarioIds].sort()).toEqual([...matrixIds].sort());
  });
});

/**
 * A scenario that runs one probe, so that the rule can be tried on it.
 *
 * The row id is one the matrix does not have: the scenario is a **rule's**
 * own fixture, not a measurement of this implementation.
 */
function probeScenario(probe: Scenario['probe']): Scenario {
  return {
    rowId: 'F-99',
    title: "the rule's own fixture",
    command: 'npx vitest run tests/compatibility/scenarios.test.ts -t "the rule"',
    pinning: undefined,
    probe,
  };
}

describe('the harness refuses a rubber stamp', () => {
  it('a probe that observes a bare constant and compares it with itself measures nothing', async () => {
    // The proof: `SESSION_SCHEMA_VERSION` is a primitive this implementation merely
    // exports, so reading it is not reading this implementation's behaviour, and
    // `expect(c).toBe(c)` compares the value with itself. The rule refuses
    // the whole measurement.
    const measurement = await measure(
      probeScenario(() => {
        const c = observe('a constant', SESSION_SCHEMA_VERSION);
        harnessExpect(c).toBe(c);
        return { outcome: 'match', detail: 'a rubber stamp' };
      }),
    );
    const meaning = meaningfulness(measurement);
    expect(meaning.meaningful).toBe(false);
    expect(meaning.reason).toContain('with itself');
  });

  it('a probe that observes a bare constant measures nothing, even when it compares it with another value', async () => {
    // The other half of the rule: a bare constant is not a value this implementation
    // produced, so a probe that reads one has measured nothing at all.
    const measurement = await measure(
      probeScenario(() => {
        const c = observe('a constant', SESSION_SCHEMA_VERSION);
        harnessExpect(c).toBe(2);
        return { outcome: 'match', detail: 'a rubber stamp' };
      }),
    );
    const meaning = meaningfulness(measurement);
    expect(meaning.meaningful).toBe(false);
    expect(meaning.reason).toContain('nothing this implementation produced');
  });

  it('a probe that observes a primitive this implementation produced and compares it with itself measures nothing', async () => {
    // The same shape, with a value this implementation really produced: the route the
    // implementation's own selector returns. A comparison of a value with itself
    // cannot fail, so it measures nothing either.
    const measurement = await measure(
      probeScenario(async () => {
        const c = await observeCall('the route', selectRoute, [{}]);
        harnessExpect(c).toBe(c);
        return { outcome: 'match', detail: 'a rubber stamp' };
      }),
    );
    const meaning = meaningfulness(measurement);
    expect(meaning.meaningful).toBe(false);
    expect(meaning.reason).toContain('with itself');
  });

  it('a probe that compares a value this implementation produced against the constant it must equal measures something', async () => {
    // The ordinary form of an assertion: the route this implementation's selector
    // returns, compared with the route the target's selector returns. It is
    // not a comparison of a value with itself, and it measures something.
    const measurement = await measure(
      probeScenario(async () => {
        const c = await observeCall('the route', selectRoute, [{}]);
        harnessExpect(c).toBe('firstParty');
        return { outcome: 'match', detail: 'a measurement' };
      }),
    );
    expect(meaningfulness(measurement).meaningful).toBe(true);
  });

  it('a probe that asserts a constant measures nothing', async () => {
    const measurement = await measure(
      probeScenario(() => {
        harnessExpect(1).toBe(1);
        return { outcome: 'match', detail: 'a rubber stamp' };
      }),
    );
    expect(meaningfulness(measurement).meaningful).toBe(false);
  });
});

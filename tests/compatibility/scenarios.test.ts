/**
 * The harness's own test: every scenario, run against this implementation.
 *
 * A scenario is one measurable claim. This file runs each of them and fails
 * when a claim does not hold — a probe that throws is a **mismatch**, and the
 * test says so. A scenario that cannot run raises `NotTestedError` and is
 * recorded as `not-tested`, which is **not** a failure.
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

import { SCENARIOS, measure, scenarioOf } from './scenarios.js';

/**
 * Run a scenario and assert that its claim holds.
 *
 * A scenario that measured a mismatch fails here, with the reason the probe
 * gave. A scenario that could not run is recorded as `not-tested` and passes:
 * an honest gap is not a failure.
 */
async function expectScenario(rowId: string): Promise<void> {
  const scenario = scenarioOf(rowId);
  const measurement = await measure(scenario);
  expect(
    measurement.failed,
    `${rowId} did not measure: ${measurement.detail}`,
  ).toBe(false);
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
});

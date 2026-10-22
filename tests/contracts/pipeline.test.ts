/**
 * The contract test for the pipeline.
 *
 * **The milestone:** `CC-045` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The concept:** `docs/DIVERGENCE-LAYER-2.md` §4 and §6 — the Product Builder
 * pipeline, and the decision that **the stages are pluggable**.
 * **The specification:** `docs/protocol/PROTOCOL.md` §8 — the three deliveries,
 * and the `event/stage` notification.
 *
 * ## What is measured, and how
 *
 * **One stage interface, three deliveries.** The stage contract is written
 * **once**, in one function, and run against a stage of **each** delivery:
 *
 *   - **in-process**, registered through the typed interface;
 *   - **a package** the agent loads — a module on disk that exports a stage,
 *     and one that imports **nothing** from this repository, so what is measured
 *     is the contract and not our implementation of it;
 *   - **a process** speaking our protocol over stdio and answering `tool/call`
 *     — a **real child process**, and the frames on the wire are the frames the
 *     specification describes.
 *
 * **The pipeline cannot tell them apart.** The whole pipeline is run three
 * times, once per delivery of one stage, and the three runs are compared.
 *
 * **The eight built-in stages** each have a defined input, a defined output and
 * a defined refusal, and each is measured on its own.
 *
 * **The degradation contract.** The model layer is another milestone's work and
 * is **not** landed, so the `model` capability is off and the stages that
 * would use it say so, in the shared shape. The approval **rules** are another
 * milestone's work too, so a stage that needs an approval asks the approval
 * seam and is refused with a reason.
 *
 * ## What is not measured here
 *
 * The approval **rules** (`CC-046`) and the model layer (`CC-044`) are other
 * milestones' work, and this test does not fake either of them: the fakes it
 * uses are **test doubles for the seams**, and the production wiring reports
 * both capabilities as off.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isReportableReason } from '../../src/protocol/index.js';
import {
  PIPELINE_STAGE_IDS,
  Pipeline,
  createBuiltInStages,
  createProcessStage,
  createStageServices,
  loadPackageStage,
  registerStage,
  stageEventParams,
  type StageContext,
  type StageInput,
  type StageModelBackend,
  type StageApprovalBackend,
  type StageOutput,
  type StageRegistration,
} from '../../src/pipeline/index.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');

/** The package: a module on disk that exports a stage, and imports nothing of ours. */
const PACKAGE_FIXTURE = path.join(FIXTURES, 'stage-package.mjs');

/** The loader that starts the stage process — the same shape the protocol's own fixture uses. */
const PROCESS_FIXTURE = path.join(FIXTURES, 'stage-child.mjs');

/* -------------------------------------------------------------------------- */
/* The harness                                                                */
/* -------------------------------------------------------------------------- */

/** The brief every stage of the shared contract is given. */
const BRIEF = 'A terminal that reads a build log and explains the failure in one line.';

/** The input the shared contract gives a stage. */
function stageInput(brief: string): StageInput {
  return { runId: 'run_1', brief, previous: null, outputs: {} };
}

/** The context for a stage that is run on its own. */
function stageContext(): StageContext {
  const services = createStageServices();
  return {
    runId: 'run_1',
    services,
    capabilities: services.capabilities,
    signal: new AbortController().signal,
  };
}

/** The concept's document, as the stages after it see it. */
function conceptOutput(): StageOutput {
  return {
    stageId: 'concept',
    summary: 'the concept',
    artifacts: { title: BRIEF, idea: BRIEF, problem: BRIEF },
  };
}

/** The specification's document, as the stages after it see it. */
function specificationOutput(): StageOutput {
  return {
    stageId: 'specify',
    summary: 'the specification',
    artifacts: {
      requirements: ['the build log is read', 'the failure is explained'],
      criteria: [
        'the build log is read and its last line is reported',
        'the failure is explained in one line of plain words',
      ],
    },
  };
}

/** The plan's document, as the stages after it see it. */
function planOutput(): StageOutput {
  return {
    stageId: 'plan',
    summary: 'the plan',
    artifacts: {
      steps: [
        { text: 'read the build log', criterion: 1 },
        { text: 'explain the failure', criterion: 2 },
      ],
    },
  };
}

/** The input of a stage, with the documents of the stages before it. */
function inputWith(outputs: Record<string, StageOutput>): StageInput {
  return { runId: 'run_1', brief: BRIEF, previous: null, outputs };
}

/** Wait for a condition, up to a bound. */
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return condition();
}

/**
 * The model double.
 *
 * It is a **test double for the seam**, not a model: it answers the three
 * stages that ask one, in the format those stages parse. The production wiring
 * has no model at all, and the stages that would use one say so.
 */
const fakeModel: StageModelBackend = {
  async complete(request) {
    if (request.stageId === 'specify') {
      return {
        text: [
          'requirement the build log is read',
          'accept the build log is read and its last line is reported',
          'requirement the failure is explained',
          'accept the failure is explained in one line of plain words',
        ].join('\n'),
      };
    }
    if (request.stageId === 'plan') {
      return {
        text: [
          'step read the build log',
          'satisfies 1',
          'step explain the failure',
          'satisfies 2',
        ].join('\n'),
      };
    }
    if (request.stageId === 'build') {
      return {
        text: [
          'artefact src/read-log.ts',
          'content reads the build log and reports its last line',
          'satisfies 1',
          'artefact src/explain-failure.ts',
          'content explains the failure in one line of plain words',
          'satisfies 2',
        ].join('\n'),
      };
    }
    return { text: '' };
  },
};

/** The approval double — a test double for the seam, and not a rule. */
const fakeApprovals: StageApprovalBackend = {
  async request() {
    return { decision: 'allow', answerer: 'the-operator' };
  },
};

/** The services a run that is expected to finish uses. */
function workingServices(): ReturnType<typeof createStageServices> {
  return createStageServices({ model: fakeModel, approvals: fakeApprovals });
}

/** A pipeline carrying the eight built-in stages. */
function builtInPipeline(services = workingServices()): Pipeline {
  const pipeline = new Pipeline({ services });
  for (const stage of createBuiltInStages()) pipeline.register(registerStage(stage));
  return pipeline;
}

/**
 * The projection of a run that is compared across the deliveries.
 *
 * The **summary** is the stage's own prose — it is not a contract, and two
 * implementations may word it differently. The **document** and the
 * **decisions** are the contract, and those are compared.
 */
function contractOf(outputs: Readonly<Record<string, StageOutput>>): unknown {
  const projected: Record<string, unknown> = {};
  for (const [id, output] of Object.entries(outputs)) {
    projected[id] = { stageId: output.stageId, artifacts: output.artifacts };
  }
  return projected;
}

/* -------------------------------------------------------------------------- */
/* One stage interface, three deliveries                                       */
/* -------------------------------------------------------------------------- */

/**
 * The three deliveries.
 *
 * Each one registers the **same** contract — the `concept` stage — and the
 * test below is written **once** and run against all three.
 */
const DELIVERIES = [
  {
    label: 'the in-process',
    register: async (): Promise<StageRegistration> =>
      registerStage(createBuiltInStages()[0]!),
  },
  {
    label: 'the package',
    register: async (): Promise<StageRegistration> => loadPackageStage(PACKAGE_FIXTURE),
  },
  {
    label: 'the process',
    register: async (): Promise<StageRegistration> =>
      createProcessStage({
        command: process.execPath,
        args: [PROCESS_FIXTURE],
        id: 'concept',
      }),
  },
];

describe('one stage interface, three deliveries', () => {
  it.each(DELIVERIES)('a stage of $label delivery passes the stage contract', async ({ register }) => {
    const stage = (await register()).stage;

    // The stage says which stage it is.
    expect(stage.id).toBe('concept');
    expect(typeof stage.title).toBe('string');
    expect(stage.title.length).toBeGreaterThan(0);

    // Given the input it needs, it produces its output.
    const context = stageContext();
    const outcome = await stage.run(stageInput(BRIEF), context);
    expect(outcome.state).toBe('completed');
    if (outcome.state !== 'completed') return;
    expect(outcome.output.stageId).toBe('concept');
    expect(typeof outcome.output.summary).toBe('string');
    expect(outcome.output.summary.length).toBeGreaterThan(0);

    // The document is the contract: the idea, a title and the problem.
    const artifacts = outcome.output.artifacts;
    expect(artifacts['idea']).toBe(BRIEF);
    expect(typeof artifacts['title']).toBe('string');
    expect(typeof artifacts['problem']).toBe('string');

    // Given an input it cannot use, it refuses — with the shared shape.
    const refused = await stage.run(stageInput('   '), context);
    expect(refused.state).toBe('refused');
    if (refused.state !== 'refused') return;
    expect(refused.capability.enabled).toBe(false);
    expect(isReportableReason(refused.capability.unsupported)).toBe(true);
    expect(refused.reason).toBe(refused.capability.unsupported);
  });

  it('the pipeline cannot tell the deliveries apart', async () => {
    // Three pipelines, identical but for the delivery of one stage.
    const runs = [];
    for (const delivery of DELIVERIES) {
      const pipeline = new Pipeline({ services: workingServices() });
      for (const stage of createBuiltInStages()) {
        if (stage.id === 'concept') continue;
        pipeline.register(registerStage(stage));
      }
      pipeline.register(await delivery.register());
      runs.push(await pipeline.run({ brief: BRIEF, runId: 'run_1' }));
    }

    // The three runs took the same decisions, in the same order.
    for (const run of runs) {
      expect(run.state).toBe('completed');
      expect(run.records.map((record) => record.stageId)).toEqual([...PIPELINE_STAGE_IDS]);
      expect(run.records.map((record) => record.state)).toEqual(
        PIPELINE_STAGE_IDS.map(() => 'completed'),
      );
    }

    // And they produced the same documents.
    const documents = runs.map((run) => contractOf(run.outputs));
    expect(documents[1]).toEqual(documents[0]);
    expect(documents[2]).toEqual(documents[0]);
  });

  it('the package delivery loads a module and takes its stage', async () => {
    const registration = await loadPackageStage(PACKAGE_FIXTURE);
    expect(registration.delivery).toBe('package');
    expect(registration.id).toBe('concept');
    expect(typeof registration.stage.run).toBe('function');
  });

  it('a package that exports no stage is refused with a reason', async () => {
    await expect(loadPackageStage(path.join(FIXTURES, 'stage-empty.mjs'))).rejects.toThrow(
      /exports no stage/,
    );
  });

  it('the process delivery speaks the protocol over a real pipe', async () => {
    // The child is a **real process**: it says its own pid on stderr, and the
    // pid is not this process's.
    const diagnostics: string[] = [];
    const registration = createProcessStage({
      command: process.execPath,
      args: [PROCESS_FIXTURE],
      id: 'concept',
      onDiagnostic: (message) => diagnostics.push(message),
    });

    const outcome = await registration.stage.run(stageInput(BRIEF), stageContext());
    expect(outcome.state).toBe('completed');

    const reported = await waitFor(() => diagnostics.some((line) => line.includes('pid')));
    expect(reported).toBe(true);
    const line = diagnostics.find((entry) => entry.includes('pid')) ?? '';
    const pid = Number.parseInt(line.split('pid')[1]?.trim() ?? '0', 10);
    expect(Number.isFinite(pid)).toBe(true);
    expect(pid).toBeGreaterThan(0);
    expect(pid).not.toBe(process.pid);
  });

  it('a stage the pipeline does not have is reported, not skipped', async () => {
    const pipeline = new Pipeline({ services: workingServices() });
    // Only one stage of the eight is registered.
    pipeline.register(registerStage(createBuiltInStages()[0]!));

    const run = await pipeline.run({ brief: BRIEF, runId: 'run_1' });
    expect(run.state).toBe('refused');
    expect(run.failedAt).toBe('clarify');
    expect(run.reason).toMatch(/no stage is registered/);

    // Every stage of the pipeline is in the report — the one that refused, and
    // the ones that were never reached.
    expect(run.records.map((record) => record.stageId)).toEqual([...PIPELINE_STAGE_IDS]);
    expect(run.records[0]!.state).toBe('completed');
    expect(run.records[1]!.state).toBe('refused');
    expect(run.records[2]!.state).toBe('not-reached');
    expect(run.records[7]!.state).toBe('not-reached');
    expect(run.records[7]!.reason).toMatch(/clarify/);
  });
});

/* -------------------------------------------------------------------------- */
/* The pipeline runs                                                           */
/* -------------------------------------------------------------------------- */

describe('the pipeline runs', () => {
  it('the pipeline runs end to end', async () => {
    const pipeline = builtInPipeline();
    const run = await pipeline.run({ brief: BRIEF, runId: 'run_1' });

    expect(run.state).toBe('completed');
    expect(run.failedAt).toBeNull();
    expect(run.reason).toBeNull();
    expect(run.records).toHaveLength(8);
    for (const record of run.records) {
      expect(record.state).toBe('completed');
      expect(record.output).toBeDefined();
    }

    // The run produced a verified, shippable product: the stages' documents
    // are there, and the verification says the criteria were met.
    expect(run.outputs['verify']).toBeDefined();
    const verification = run.outputs['verify']!;
    expect(verification.artifacts['passed']).toBe(true);
    expect(run.outputs['ship']).toBeDefined();
    expect(run.outputs['operate']).toBeDefined();
  });

  it('a stage that cannot run says so, and the pipeline reports which stage and why', async () => {
    // The production wiring: no model backend is connected.
    const pipeline = builtInPipeline(createStageServices());
    const run = await pipeline.run({ brief: BRIEF, runId: 'run_1' });

    expect(run.state).toBe('refused');
    expect(run.failedAt).toBe('specify');
    expect(run.reason).toMatch(/model backend/);

    // The stage that could not run is reported, with the reason that names
    // what is missing.
    const refused = run.records[2]!;
    expect(refused.stageId).toBe('specify');
    expect(refused.state).toBe('refused');
    expect(refused.reason).toMatch(/model backend/);

    // And the stages that were never reached are reported too.
    expect(run.records).toHaveLength(8);
    for (const record of run.records.slice(3)) {
      expect(record.state).toBe('not-reached');
      expect(record.reason).toMatch(/specify/);
    }
  });

  it("a stage's advance is an event/stage notification carrying the id, the state and the shared shape", async () => {
    const events: Array<Record<string, unknown>> = [];
    const pipeline = builtInPipeline();
    await pipeline.run({
      brief: BRIEF,
      runId: 'run_1',
      onStage: (event) => {
        events.push(stageEventParams(event));
      },
    });

    // The stages advance, in order, and the notification carries the stage's
    // id and the stage's state.
    const running = events.filter((event) => event['state'] === 'running');
    expect(running.map((event) => event['stageId'])).toEqual([...PIPELINE_STAGE_IDS]);
    for (const event of running) {
      expect(event['enabled']).toBe(true);
      expect(event['unsupported']).toBeNull();
    }

    const completed = events.filter((event) => event['state'] === 'completed');
    expect(completed).toHaveLength(8);
  });

  it('a stage that is not proceeding carries the shared shape', async () => {
    const events: Array<Record<string, unknown>> = [];
    const pipeline = builtInPipeline(createStageServices());
    await pipeline.run({
      brief: BRIEF,
      runId: 'run_1',
      onStage: (event) => {
        events.push(stageEventParams(event));
      },
    });

    const refused = events.filter((event) => event['state'] === 'refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]!['stageId']).toBe('specify');
    expect(refused[0]!['enabled']).toBe(false);
    expect(isReportableReason(refused[0]!['unsupported'])).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The eight built-in stages                                                   */
/* -------------------------------------------------------------------------- */

describe('the eight built-in stages', () => {
  it('the pipeline has the eight stages of the Product Builder, in order', () => {
    expect([...PIPELINE_STAGE_IDS]).toEqual([
      'concept',
      'clarify',
      'specify',
      'plan',
      'build',
      'verify',
      'ship',
      'operate',
    ]);
    const stages = createBuiltInStages();
    expect(stages.map((stage) => stage.id)).toEqual([...PIPELINE_STAGE_IDS]);
  });

  it('the concept stage turns the idea into a concept', async () => {
    const stage = createBuiltInStages()[0]!;
    const outcome = await stage.run(stageInput(BRIEF), stageContext());
    expect(outcome.state).toBe('completed');
    if (outcome.state !== 'completed') return;
    expect(outcome.output.stageId).toBe('concept');
    expect(outcome.output.artifacts['idea']).toBe(BRIEF);
    expect(outcome.output.artifacts['title']).toBe(BRIEF);
  });

  it('the concept stage refuses an idea that is not there', async () => {
    const stage = createBuiltInStages()[0]!;
    const outcome = await stage.run(stageInput('  '), stageContext());
    expect(outcome.state).toBe('refused');
    if (outcome.state !== 'refused') return;
    expect(outcome.reason).toMatch(/no idea/);
    expect(outcome.capability.enabled).toBe(false);
  });

  it('the clarify stage asks the questions the concept leaves open', async () => {
    const stage = createBuiltInStages()[1]!;
    const concept = createBuiltInStages()[0]!;
    const first = await concept.run(stageInput(BRIEF), stageContext());
    if (first.state !== 'completed') throw new Error('the concept did not complete');

    const outcome = await stage.run(
      { runId: 'run_1', brief: BRIEF, previous: first.output, outputs: { concept: first.output } },
      stageContext(),
    );
    expect(outcome.state).toBe('completed');
    if (outcome.state !== 'completed') return;
    const questions = outcome.output.artifacts['questions'];
    expect(Array.isArray(questions)).toBe(true);
    expect((questions as unknown[]).length).toBeGreaterThan(0);
  });

  it('the clarify stage refuses a concept that is not there', async () => {
    const stage = createBuiltInStages()[1]!;
    const outcome = await stage.run(stageInput(BRIEF), stageContext());
    expect(outcome.state).toBe('refused');
    if (outcome.state !== 'refused') return;
    expect(outcome.reason).toMatch(/nothing to clarify/);
  });

  it('the specify stage writes a specification', async () => {
    const stage = createBuiltInStages()[2]!;
    const outcome = await stage.run(inputWith({ concept: conceptOutput() }), {
      ...stageContext(),
      services: workingServices(),
    });
    expect(outcome.state).toBe('completed');
    if (outcome.state !== 'completed') return;
    const requirements = outcome.output.artifacts['requirements'];
    expect(Array.isArray(requirements)).toBe(true);
    expect((requirements as unknown[]).length).toBeGreaterThan(0);
  });

  it('the specify stage refuses an answer it cannot use', async () => {
    const stage = createBuiltInStages()[2]!;
    const services = createStageServices({
      model: { async complete() { return { text: 'nothing useful' }; } },
    });
    const outcome = await stage.run(inputWith({ concept: conceptOutput() }), {
      ...stageContext(),
      services,
    });
    expect(outcome.state).toBe('refused');
    if (outcome.state !== 'refused') return;
    expect(outcome.reason).toMatch(/no requirement/);
  });

  it('the plan stage orders the work', async () => {
    const stage = createBuiltInStages()[3]!;
    const outcome = await stage.run(
      inputWith({ concept: conceptOutput(), specify: specificationOutput() }),
      { ...stageContext(), services: workingServices() },
    );
    expect(outcome.state).toBe('completed');
    if (outcome.state !== 'completed') return;
    const steps = outcome.output.artifacts['steps'];
    expect(Array.isArray(steps)).toBe(true);
    expect((steps as unknown[]).length).toBeGreaterThan(0);
  });

  it('the build stage produces the artefacts', async () => {
    const stage = createBuiltInStages()[4]!;
    const outcome = await stage.run(
      inputWith({
        concept: conceptOutput(),
        specify: specificationOutput(),
        plan: planOutput(),
      }),
      { ...stageContext(), services: workingServices() },
    );
    expect(outcome.state).toBe('completed');
    if (outcome.state !== 'completed') return;
    const artefacts = outcome.output.artifacts['artefacts'];
    expect(Array.isArray(artefacts)).toBe(true);
    expect((artefacts as unknown[]).length).toBeGreaterThan(0);
  });

  it('the verify stage checks the criteria against the artefacts', async () => {
    const stage = createBuiltInStages()[5]!;
    const outcome = await stage.run(
      {
        runId: 'run_1',
        brief: BRIEF,
        previous: null,
        outputs: {
          specify: {
            stageId: 'specify',
            summary: 'the specification',
            artifacts: { criteria: ['the log is read', 'the failure is explained'] },
          },
          build: {
            stageId: 'build',
            summary: 'the artefacts',
            artifacts: {
              artefacts: [{ path: 'src/a.ts', content: 'a', criterion: 1 }],
            },
          },
        },
      },
      stageContext(),
    );
    expect(outcome.state).toBe('completed');
    if (outcome.state !== 'completed') return;
    expect(outcome.output.artifacts['passed']).toBe(false);
    const checks = outcome.output.artifacts['checks'] as Array<Record<string, unknown>>;
    expect(checks).toHaveLength(2);
    expect(checks[0]!['passed']).toBe(true);
    expect(checks[1]!['passed']).toBe(false);
  });

  it('the verify stage refuses to verify nothing', async () => {
    const stage = createBuiltInStages()[5]!;
    const outcome = await stage.run(stageInput(BRIEF), stageContext());
    expect(outcome.state).toBe('refused');
    if (outcome.state !== 'refused') return;
    expect(outcome.reason).toMatch(/nothing to verify/);
  });

  it('the ship stage releases what was verified', async () => {
    const stage = createBuiltInStages()[6]!;
    const outcome = await stage.run(
      {
        runId: 'run_1',
        brief: BRIEF,
        previous: null,
        outputs: {
          verify: {
            stageId: 'verify',
            summary: 'the verification',
            artifacts: { passed: true },
          },
          build: {
            stageId: 'build',
            summary: 'the artefacts',
            artifacts: { artefacts: [{ path: 'src/a.ts', content: 'a', criterion: 1 }] },
          },
        },
      },
      { ...stageContext(), services: workingServices() },
    );
    expect(outcome.state).toBe('completed');
    if (outcome.state !== 'completed') return;
    expect(outcome.output.artifacts['release']).toBeDefined();
  });

  it('the ship stage refuses to release what did not pass verification', async () => {
    const stage = createBuiltInStages()[6]!;
    const outcome = await stage.run(
      {
        runId: 'run_1',
        brief: BRIEF,
        previous: null,
        outputs: {
          verify: {
            stageId: 'verify',
            summary: 'the verification',
            artifacts: { passed: false },
          },
        },
      },
      { ...stageContext(), services: workingServices() },
    );
    expect(outcome.state).toBe('refused');
    if (outcome.state !== 'refused') return;
    expect(outcome.reason).toMatch(/did not pass verification/);
  });

  it('the operate stage records what to watch', async () => {
    const stage = createBuiltInStages()[7]!;
    const outcome = await stage.run(
      {
        runId: 'run_1',
        brief: BRIEF,
        previous: null,
        outputs: {
          ship: {
            stageId: 'ship',
            summary: 'the release',
            artifacts: {
              release: {
                id: 'run_1',
                artefacts: [{ path: 'src/a.ts', content: 'a', criterion: 1 }],
              },
            },
          },
        },
      },
      stageContext(),
    );
    expect(outcome.state).toBe('completed');
    if (outcome.state !== 'completed') return;
    const watch = outcome.output.artifacts['watch'];
    expect(Array.isArray(watch)).toBe(true);
    expect((watch as unknown[]).length).toBeGreaterThan(0);
  });

  it('the operate stage refuses to operate nothing', async () => {
    const stage = createBuiltInStages()[7]!;
    const outcome = await stage.run(stageInput(BRIEF), stageContext());
    expect(outcome.state).toBe('refused');
    if (outcome.state !== 'refused') return;
    expect(outcome.reason).toMatch(/nothing to operate/);
  });
});

/* -------------------------------------------------------------------------- */
/* The degradation contract                                                    */
/* -------------------------------------------------------------------------- */

describe('the degradation contract', () => {
  it('the model capability is off in this build, and the stages that would use it report it', async () => {
    const services = createStageServices();
    const record = services.capabilities.get('model');
    expect(record?.enabled).toBe(false);
    expect(record?.unsupported).toMatch(/model backend/);

    // The stages that would use the model refuse with the shared shape.
    const stages = createBuiltInStages();
    const inputs: StageInput[] = [
      inputWith({ concept: conceptOutput() }),
      inputWith({ concept: conceptOutput(), specify: specificationOutput() }),
      inputWith({ concept: conceptOutput(), specify: specificationOutput(), plan: planOutput() }),
    ];
    for (const [index, stage] of [stages[2]!, stages[3]!, stages[4]!].entries()) {
      expect(stage.requires).toContain('model');
      const outcome = await stage.run(inputs[index]!, { ...stageContext(), services });
      expect(outcome.state).toBe('refused');
      if (outcome.state !== 'refused') return;
      expect(outcome.capability.enabled).toBe(false);
      expect(outcome.capability.unsupported).toMatch(/model backend/);
    }
  });

  it('the approval capability is off in this build, and a stage that needs one is refused with a reason', async () => {
    const services = createStageServices();
    const record = services.capabilities.get('approval');
    expect(record?.enabled).toBe(false);
    expect(record?.unsupported).toMatch(/approval rules/);

    const stage = createBuiltInStages()[6]!;
    expect(stage.requires).toContain('approval');
    const outcome = await stage.run(
      {
        runId: 'run_1',
        brief: BRIEF,
        previous: null,
        outputs: {
          verify: {
            stageId: 'verify',
            summary: 'the verification',
            artifacts: { passed: true },
          },
        },
      },
      { ...stageContext(), services },
    );
    expect(outcome.state).toBe('refused');
    if (outcome.state !== 'refused') return;
    expect(outcome.reason).toMatch(/approval rules/);
    expect(outcome.capability.enabled).toBe(false);
  });

  it('an enabled capability is not a promise that does nothing', async () => {
    // A capability that is enabled and does nothing is a bug. The services
    // enable a capability only when a backend is there to serve it.
    const withoutModel = createStageServices();
    expect(withoutModel.capabilities.get('model')?.enabled).toBe(false);
    const withModel = createStageServices({ model: fakeModel });
    expect(withModel.capabilities.get('model')?.enabled).toBe(true);

    // And the seam really answers when it is enabled.
    const answer = await withModel.model.complete({ stageId: 'specify', prompt: 'anything' });
    expect(answer.text.length).toBeGreaterThan(0);
  });
});

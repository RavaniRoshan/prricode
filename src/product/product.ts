/**
 * The product — **an idea in, a verified product out**.
 *
 * **The concept:** `docs/DIVERGENCE-LAYER-2.md` §4 — the purpose is stated
 * plainly: "**turning an idea into a verified, shippable product**", and the
 * pipeline's shape is *concept → clarify → specify → plan → build → verify →
 * ship → operate*.
 *
 * **One responsibility:** the wiring, and the run.
 *
 * ## What the wiring is
 *
 * Everything the product is made of has landed — the protocol surface, the
 * model layer, the pipeline and the approval rules — and this module is the
 * place they meet:
 *
 * | the seam | what it follows | what happens when it is not there |
 * |---|---|---|
 * | the **model** | the **backend** — the model layer's own predicate says whether a provider is connected | the `model` capability is **off**, with the reason, and the three generative stages refuse with it |
 * | the **approvals** | the **rules** and the seam — a rule that matches decides without asking | the `approval` capability is **off**, with the reason, and the release is refused with it |
 *
 * **The capability records are never written by hand.** Each one follows the
 * backend it belongs to, so an enabled capability always has something behind
 * it — and a capability that is on and does nothing cannot be shipped.
 *
 * ## What "verified" means here
 *
 * Three things, and all three are the run's own:
 *
 *   1. **The whole thing runs** — all eight stages, and the eight documents
 *      they produce.
 *   2. **The verification stage's own checks are really executed** — the
 *      criteria are met by the files, not asserted, and the result is
 *      compared with what the run claimed. A run that claims a criterion is
 *      met and does not meet it **fails**, and it fails **at the stage that
 *      claimed it**, so nothing is released.
 *   3. **The product's own test run happens** — the files the build produced
 *      are **run**, and their own verdict is the evidence.
 *
 * ## A failure is a failure
 *
 * A stage that cannot run **stops** the run, and the run names the stage and
 * the reason. The stages after it are reported as `not-reached` — by the
 * pipeline, which is the pipeline's own rule — and the product says the same
 * thing in its own report. A product that carried on past a failure would be
 * a product claiming a success it did not have.
 */

import {
  createApprovalGate,
  type ApprovalRuleSet,
  type ApprovalRuleStore,
  type ApprovalTransport,
} from '../approvals/index.js';
import {
  type Connection,
  type ModelEngine,
  type ModelRef,
  type ProviderEntry,
  providerAvailability,
} from '../model/index.js';
import {
  Pipeline,
  createBuiltInStages,
  createStageServices,
  outputOf,
  stageRefusal,
  type PipelineRun,
  type PipelineStage,
  type StageEvent,
  type StageInput,
  type StageOutcome,
  type StageOutput,
} from '../pipeline/index.js';
import {
  createDefaultCapabilityRegistry,
  type CapabilityRecord,
} from '../protocol/index.js';

import { approvalBackend } from './approvals.js';
import { modelBackend } from './model.js';
import { nodeTestRunner, type ProductTestRunner } from './testrun.js';
import {
  executeVerification,
  type ClaimedCheck,
  type ProductArtefact,
  type ProductVerification,
} from './verification.js';
import { ProductWorkspace } from './workspace.js';

/* -------------------------------------------------------------------------- */
/* The options                                                                 */
/* -------------------------------------------------------------------------- */

/** How the product reaches a model. */
export interface ProductModelOptions {
  /** The model layer's engine. */
  readonly engine: ModelEngine;
  /** The model the stages' work runs against. */
  readonly selection: ModelRef;
  /** The provider the engine will reach, as the product holds it. */
  readonly provider: ProviderEntry;
  /** The provider's connections, as the model layer derives them. */
  readonly connections?: readonly Connection[];
}

/** How the product reaches a person. */
export interface ProductApprovalOptions {
  /** The rules that decide, and the ones that ask. */
  readonly rules: ApprovalRuleSet;
  /** How an approval reaches a human. Without one, an ask cannot be asked. */
  readonly transport?: ApprovalTransport;
  /** Where a human's approval is kept, so that it decides next time. */
  readonly store?: ApprovalRuleStore;
  /** How long the gate waits for an answer. */
  readonly timeoutMs?: number;
}

/** How the product is run. */
export interface ProductOptions {
  /** The idea the run starts from. */
  readonly brief: string;
  /** The directory the product is written into. */
  readonly workspace: string;
  /** The model, when one is connected. */
  readonly model?: ProductModelOptions;
  /** The approvals, when rules are configured. */
  readonly approvals?: ProductApprovalOptions;
  /** The runner that runs the product's own tests. */
  readonly testRunner?: ProductTestRunner;
  /** The run's id. */
  readonly runId?: string;
  /** Called with every advance of a stage. */
  readonly onStage?: (event: StageEvent) => void;
}

/* -------------------------------------------------------------------------- */
/* The documents                                                               */
/* -------------------------------------------------------------------------- */

/** One document the stages produced. */
export interface ProductDocument {
  /** The stage that produced it. */
  readonly stageId: string;
  /** What the stage is called. */
  readonly title: string;
  /** One line saying what the stage did. */
  readonly summary: string;
  /** The stage's own document, beneath the summary. */
  readonly artifacts: Readonly<Record<string, unknown>>;
}

/* -------------------------------------------------------------------------- */
/* The result                                                                  */
/* -------------------------------------------------------------------------- */

/** What the product's run produced. */
export interface ProductResult {
  /** The run's id. */
  readonly runId: string;
  /** The idea the run started from. */
  readonly brief: string;
  /** Whether the product is verified. */
  readonly state: 'verified' | 'refused';
  /** Whether every acceptance criterion was met by the product's own tests. */
  readonly verified: boolean;
  /** Why the product is not verified, when it is not. */
  readonly reason: string | null;
  /** The stage the run stopped at, when it stopped. */
  readonly failedAt: string | null;
  /** The pipeline's own report — every stage, whatever happened to it. */
  readonly run: PipelineRun;
  /** The eight documents, in the order the stages produced them. */
  readonly documents: readonly ProductDocument[];
  /** The verification, when the run reached it. */
  readonly verification: ProductVerification | null;
  /** The capabilities the run knew about. */
  readonly capabilities: Readonly<Record<string, CapabilityRecord>>;
  /** What the product found, in its own words. */
  readonly diagnostics: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* The helpers                                                                 */
/* -------------------------------------------------------------------------- */

/** The run counter, so that two runs never share an id. */
let runCounter = 0;

/** The message of a thrown value. */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'the error carried no message';
}

/** Whether a value is a plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The criteria of the specification, as the verification reads them. */
function readCriteria(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const criteria: string[] = [];
  for (const entry of value) {
    criteria.push(String(entry));
  }
  return criteria;
}

/** The files the build produced, as the verification reads them. */
function readArtefacts(value: unknown): ProductArtefact[] {
  if (!Array.isArray(value)) return [];
  const artefacts: ProductArtefact[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    const filePath = entry['path'];
    const content = entry['content'];
    const criterion = entry['criterion'];
    if (typeof filePath !== 'string') continue;
    if (typeof criterion !== 'number') continue;
    artefacts.push({
      path: filePath,
      content: typeof content === 'string' ? content : '',
      criterion,
    });
  }
  return artefacts;
}

/** The claim the verification stage made, as the comparison reads it. */
function readClaim(value: unknown): ClaimedCheck[] {
  if (!Array.isArray(value)) return [];
  const claimed: ClaimedCheck[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    const criterion = entry['criterion'];
    const passed = entry['passed'];
    const detail = entry['detail'];
    if (typeof criterion !== 'string') continue;
    if (typeof passed !== 'boolean') continue;
    claimed.push({
      criterion,
      passed,
      detail: typeof detail === 'string' ? detail : '',
    });
  }
  return claimed;
}

/**
 * What a stage's hook may say.
 *
 * `undefined` keeps the stage's own outcome; an outcome replaces it. A hook
 * that refuses **stops the run at that stage**, which is what an over-claim
 * does.
 */
type StageHook = (
  output: StageOutput,
  input: StageInput,
) => Promise<StageOutcome | undefined>;

/** Wrap a stage, so that the product can act on what it produced. */
function wrapStage(stage: PipelineStage, hook: StageHook): PipelineStage {
  return {
    id: stage.id,
    title: stage.title,
    requires: stage.requires,
    async run(input, context): Promise<StageOutcome> {
      const outcome = await stage.run(input, context);
      if (outcome.state !== 'completed') return outcome;
      const replacement = await hook(outcome.output, input);
      return replacement ?? outcome;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Run the product.
 *
 * An idea in, and a verified product out — or a refusal that says which
 * stage stopped the run and why.
 */
export async function runProduct(options: ProductOptions): Promise<ProductResult> {
  runCounter += 1;
  const runId = options.runId ?? `run_${Date.now().toString(36)}_${runCounter}`;
  const workspace = new ProductWorkspace(options.workspace);
  const diagnostics: string[] = [];

  /* --- the model seam: the capability follows the backend --------------- */
  let model: ReturnType<typeof modelBackend> | undefined;
  if (options.model === undefined) {
    diagnostics.push('no model backend was given to the product');
  } else {
    const availability = providerAvailability(
      options.model.provider,
      options.model.connections ?? [],
    );
    if (availability.available) {
      model = modelBackend({
        engine: options.model.engine,
        selection: options.model.selection,
      });
    } else {
      diagnostics.push(
        `the model backend is not connected: ${availability.reason ?? 'the provider is not connected'}`,
      );
    }
  }

  /* --- the approval seam: the capability follows the rules --------------- */
  let approvals: ReturnType<typeof approvalBackend> | undefined;
  if (options.approvals === undefined) {
    diagnostics.push('no approval rules were given to the product');
  } else {
    const rules = options.approvals.rules;
    const configured = rules.allow.length + rules.ask.length + rules.deny.length;
    if (configured === 0) {
      diagnostics.push('no approval rule is configured, so no approval can be decided');
    } else {
      const gate = createApprovalGate({
        rules,
        ...(options.approvals.transport === undefined
          ? {}
          : { transport: options.approvals.transport }),
        ...(options.approvals.store === undefined ? {} : { store: options.approvals.store }),
        ...(options.approvals.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.approvals.timeoutMs }),
      });
      approvals = approvalBackend({
        gate,
        turnId: runId,
        ...(options.model === undefined ? {} : { model: options.model.selection.model }),
        path: workspace.root,
      });
    }
  }

  /* --- the services, and the capabilities they carry --------------------- */
  const capabilities = createDefaultCapabilityRegistry();
  const services = createStageServices({
    capabilities,
    ...(model === undefined ? {} : { model }),
    ...(approvals === undefined ? {} : { approvals }),
  });

  /* --- the stages -------------------------------------------------------- */
  const documents: ProductDocument[] = [];
  // The verification is produced inside a stage's hook, so it is held in an
  // object: a `let` would be narrowed away by the time the run is reported.
  const held: { verification: ProductVerification | null } = { verification: null };
  const runner = options.testRunner ?? nodeTestRunner();

  /** Record a stage's document, and write it down. */
  const recordDocument = async (
    stage: PipelineStage,
    output: StageOutput,
  ): Promise<void> => {
    const document: ProductDocument = {
      stageId: output.stageId,
      title: stage.title,
      summary: output.summary,
      artifacts: output.artifacts,
    };
    documents.push(document);
    try {
      await workspace.write(`documents/${output.stageId}.json`, `${JSON.stringify(document, null, 2)}\n`);
    } catch (error) {
      diagnostics.push(
        `the document of the "${output.stageId}" stage could not be written: ${messageOf(error)}`,
      );
    }
  };

  const stages = createBuiltInStages().map((stage) => {
    if (stage.id === 'build') {
      return wrapStage(stage, async (output) => {
        const artefacts = readArtefacts(output.artifacts['artefacts']);
        try {
          for (const artefact of artefacts) {
            await workspace.write(artefact.path, artefact.content);
          }
        } catch (error) {
          return stageRefusal(
            `the product could not write the file the build produced: ${messageOf(error)}`,
          );
        }
        await recordDocument(stage, output);
        return undefined;
      });
    }

    if (stage.id === 'verify') {
      return wrapStage(stage, async (output, input) => {
        const specification = outputOf(input, 'specify');
        const criteria = readCriteria(specification?.artifacts['criteria']);
        const built = outputOf(input, 'build');
        const artefacts = readArtefacts(built?.artifacts['artefacts']);

        const executed = await executeVerification({
          criteria,
          artefacts,
          claimed: readClaim(output.artifacts['checks']),
          runner,
          cwd: workspace.root,
        });
        held.verification = executed;
        if (!executed.comparison.agreed) {
          // The run claimed more than the product does. The stage refuses,
          // and the stages after it are never reached.
          return stageRefusal(executed.comparison.detail);
        }

        const produced: StageOutput = {
          stageId: 'verify',
          summary: `${executed.checks.filter((check) => check.passed).length} of ${executed.checks.length} acceptance criteria met by the product's own tests`,
          artifacts: {
            checks: executed.checks,
            passed: executed.passed,
            claimed: executed.claimed,
            tests: executed.tests,
            comparison: executed.comparison,
          },
        };
        await recordDocument(stage, produced);
        return { state: 'completed', output: produced };
      });
    }

    if (stage.id === 'ship') {
      return wrapStage(stage, async (output) => {
        try {
          await workspace.write(
            'release.json',
            `${JSON.stringify(output.artifacts['release'] ?? null, null, 2)}\n`,
          );
        } catch (error) {
          diagnostics.push(`the release record could not be written: ${messageOf(error)}`);
        }
        await recordDocument(stage, output);
        return undefined;
      });
    }

    return wrapStage(stage, async (output) => {
      await recordDocument(stage, output);
      return undefined;
    });
  });

  const pipeline = new Pipeline({ services });
  for (const stage of stages) {
    pipeline.register({ id: stage.id, delivery: 'in-process', stage });
  }

  /* --- the run ----------------------------------------------------------- */
  const run = await pipeline.run({
    brief: options.brief,
    runId,
    ...(options.onStage === undefined ? {} : { onStage: options.onStage }),
  });

  /* --- the verdict -------------------------------------------------------- */
  const verification = held.verification;
  const verified =
    run.state === 'completed' && verification !== null && verification.passed;
  const reason = verified
    ? null
    : (run.reason ?? verification?.comparison.detail ?? 'the product was not verified');

  return {
    runId,
    brief: options.brief,
    state: verified ? 'verified' : 'refused',
    verified,
    reason,
    failedAt: run.failedAt,
    run,
    documents,
    verification,
    capabilities: capabilities.all(),
    diagnostics,
  };
}

/**
 * The pipeline — the Product Builder's stages, and the three ways a stage
 * arrives.
 *
 * **The concept:** `docs/DIVERGENCE-LAYER-2.md` §4 and §6 — the pipeline, and
 * the decision that **the stages are pluggable**: "One interface, three
 * deliveries. A stage may be in-process, a package, or a process speaking our
 * protocol over stdio, and the pipeline does not know the difference."
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §8.
 *
 * **One responsibility:** the barrel. Every module of the pipeline is
 * re-exported here, so that an importer of `pipeline/index.js` sees the whole
 * surface and not a part of it.
 *
 * ## The modules
 *
 * | module | what it owns |
 * |---|---|
 * | `stage.ts` | the stage interface, the input, the output and the outcome |
 * | `services.ts` | the model seam and the approval seam |
 * | `registry.ts` | the three deliveries, and the registration they make |
 * | `process.ts` | the process delivery: the child, and the `tool/call` it answers |
 * | `pipeline.ts` | the run, and the report of every stage |
 * | `stages/` | the eight built-in stages |
 */

export {
  PIPELINE_STAGE_IDS,
  isPipelineStage,
  isStageOutcome,
  isStageOutput,
  outputOf,
  refusalFromSeam,
  stageRefusal,
  type PipelineStage,
  type PipelineStageId,
  type StageContext,
  type StageInput,
  type StageOutcome,
  type StageOutput,
  type StageRefusal,
  type StageState,
} from './stage.js';

export {
  APPROVAL_UNAVAILABLE,
  MODEL_UNAVAILABLE,
  StageSeamRefusal,
  createStageServices,
  type StageApprovalAnswer,
  type StageApprovalBackend,
  type StageApprovalRequest,
  type StageApprovalSeam,
  type StageModelAnswer,
  type StageModelBackend,
  type StageModelRequest,
  type StageModelSeam,
  type StageServices,
  type StageServicesOptions,
} from './services.js';

export {
  StageLoadError,
  createProcessStage,
  loadPackageStage,
  registerStage,
  type StageDelivery,
  type StagePackageModule,
  type StageRegistration,
} from './registry.js';

export {
  callProcessStage,
  mapStageAnswer,
  type StageProcessOptions,
} from './process.js';

export {
  Pipeline,
  runOutput,
  stageEventParams,
  type PipelineOptions,
  type PipelineRun,
  type PipelineRunOptions,
  type StageEvent,
  type StageRecord,
} from './pipeline.js';

export {
  BUILT_IN_STAGE_FACTORIES,
  createBuildStage,
  createBuiltInStages,
  createClarifyStage,
  createConceptStage,
  createOperateStage,
  createPlanStage,
  createShipStage,
  createSpecifyStage,
  createVerifyStage,
} from './stages/index.js';

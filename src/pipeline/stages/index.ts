/**
 * The eight built-in stages.
 *
 * **The concept:** `docs/DIVERGENCE-LAYER-2.md` §4 — the pipeline's shape.
 *
 * **One responsibility:** the eight stages of the Product Builder pipeline, in
 * the order they run, and the factory for each.
 *
 * | the stage | its input | its output | its refusal |
 * |---|---|---|---|
 * | `concept` | the brief | the idea, its title, the problem it names | the run carries no idea to work from |
 * | `clarify` | the concept | the open questions, each with what it guards | there is no concept to clarify |
 * | `specify` | the concept | the requirements, each with a criterion | the model is not connected; the answer names no requirement |
 * | `plan` | the specification | the steps, each with the criterion it delivers | the model is not connected; a step names no criterion |
 * | `build` | the plan | the files, each with the criterion it delivers | the model is not connected; the answer names no file |
 * | `verify` | the criteria and the files | the checks, and whether the whole passed | there is nothing to verify; there is nothing to verify against |
 * | `ship` | the verdict and the files | the release | nothing was verified; it did not pass; the approval was refused |
 * | `operate` | the release | the runbook, and the files to watch | there is no release to operate |
 *
 * Each stage's own module says the same, at length.
 */

import type { PipelineStage } from '../stage.js';
import { createBuildStage } from './build.js';
import { createClarifyStage } from './clarify.js';
import { createConceptStage } from './concept.js';
import { createOperateStage } from './operate.js';
import { createPlanStage } from './plan.js';
import { createShipStage } from './ship.js';
import { createSpecifyStage } from './specify.js';
import { createVerifyStage } from './verify.js';

/** The factory of each of the eight stages, in the order they run. */
export const BUILT_IN_STAGE_FACTORIES: readonly (() => PipelineStage)[] = [
  createConceptStage,
  createClarifyStage,
  createSpecifyStage,
  createPlanStage,
  createBuildStage,
  createVerifyStage,
  createShipStage,
  createOperateStage,
];

/**
 * The eight built-in stages, in the order they run.
 *
 * Every call builds **new** stages, so a pipeline and its stages do not share
 * any state with another pipeline's.
 */
export function createBuiltInStages(): PipelineStage[] {
  return BUILT_IN_STAGE_FACTORIES.map((factory) => factory());
}

export {
  createBuildStage,
  createClarifyStage,
  createConceptStage,
  createOperateStage,
  createPlanStage,
  createShipStage,
  createSpecifyStage,
  createVerifyStage,
};

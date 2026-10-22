/**
 * The `plan` stage — the work, in order.
 *
 * **One responsibility:** turning the specification into **steps**, each naming
 * the acceptance criterion it delivers.
 *
 * ## The contract
 *
 * | | |
 * |---|---|
 * | the **input** | the specification's requirements and criteria |
 * | the **output** | the steps, each with the criterion it delivers |
 * | the **refusal** | the model is not connected; or there is no specification to plan; or a step names no criterion |
 *
 * ## Why a step names a criterion
 *
 * The `verify` stage checks every criterion against what the `build` stage
 * produced. A step that named no criterion would leave the criterion to
 * nobody, and the verification would have nothing to check it against. So a
 * step without one is refused — the stage does not guess which criterion a
 * step meant.
 */

import {
  outputOf,
  refusalFromSeam,
  stageRefusal,
  type PipelineStage,
  type StageOutcome,
} from '../stage.js';
import { criterionNumber, parseModelLines } from './format.js';

/** One step of the plan. */
export interface PlanStep {
  /** What the step does. */
  readonly text: string;
  /** The acceptance criterion the step delivers — one-based. */
  readonly criterion: number;
}

/** The instruction the stage gives the model. */
export function planPrompt(requirements: readonly string[]): string {
  return [
    'Order the work that satisfies the requirements below.',
    'Answer with one line per item and no other text:',
    '  step <what the step does>',
    '  satisfies <the number of the acceptance criterion the step delivers>',
    'The criterion numbers count from 1, in the order the requirements are listed.',
    '',
    'The requirements:',
    ...requirements.map((requirement, index) => `${index + 1}. ${requirement}`),
  ].join('\n');
}

/** What the stage read out of the model's answer. */
export type PlanReading =
  | { readonly ok: true; readonly steps: PlanStep[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Read the plan out of an answer.
 *
 * A `step` line opens a step and the `satisfies` line that follows it closes
 * it. A step with no criterion is a plan that leaves a criterion to nobody.
 */
export function parsePlan(text: string, criteriaCount: number): PlanReading {
  const steps: PlanStep[] = [];
  let open: string | null = null;

  for (const line of parseModelLines(text)) {
    if (line.name === 'step') {
      if (open !== null) {
        return {
          ok: false,
          reason: 'the plan names a step that delivers no acceptance criterion',
        };
      }
      open = line.value;
      continue;
    }
    if (line.name === 'satisfies') {
      if (open === null) {
        return {
          ok: false,
          reason: 'the plan names an acceptance criterion that belongs to no step',
        };
      }
      const criterion = criterionNumber(line.value);
      if (criterion === null) {
        return {
          ok: false,
          reason: 'the plan names an acceptance criterion that is not a number',
        };
      }
      if (criterion > criteriaCount) {
        return {
          ok: false,
          reason: `the plan delivers the acceptance criterion ${criterion}, and the specification has ${criteriaCount}`,
        };
      }
      steps.push({ text: open, criterion });
      open = null;
    }
  }

  if (open !== null) {
    return { ok: false, reason: 'the plan names a step that delivers no acceptance criterion' };
  }
  if (steps.length === 0) {
    return { ok: false, reason: 'the model named no step for the plan' };
  }
  return { ok: true, steps };
}

/** The `plan` stage. */
export function createPlanStage(): PipelineStage {
  return {
    id: 'plan',
    title: 'the work, in order',
    requires: ['model'],
    async run(input, context): Promise<StageOutcome> {
      const specification = outputOf(input, 'specify');
      if (!specification) {
        return stageRefusal('the specification stage produced nothing to plan');
      }
      const requirements = specification.artifacts['requirements'];
      const criteria = specification.artifacts['criteria'];
      if (!Array.isArray(requirements) || requirements.length === 0) {
        return stageRefusal('the specification names no requirement to plan');
      }
      if (!Array.isArray(criteria)) {
        return stageRefusal('the specification names no acceptance criterion to plan');
      }

      let answer: { readonly text: string };
      try {
        answer = await context.services.model.complete({
          stageId: 'plan',
          prompt: planPrompt(requirements.map((entry) => String(entry))),
        });
      } catch (error) {
        return refusalFromSeam(error);
      }

      const reading = parsePlan(answer.text, criteria.length);
      if (!reading.ok) {
        return stageRefusal(reading.reason);
      }

      return {
        state: 'completed',
        output: {
          stageId: 'plan',
          summary: `${reading.steps.length} steps, each delivering an acceptance criterion`,
          artifacts: { steps: reading.steps },
        },
      };
    },
  };
}

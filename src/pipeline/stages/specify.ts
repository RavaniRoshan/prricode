/**
 * The `specify` stage — the specification.
 *
 * **One responsibility:** turning the concept into **requirements**, each with
 * the **acceptance criterion** that shows it is met.
 *
 * ## The contract
 *
 * | | |
 * |---|---|
 * | the **input** | the concept's document |
 * | the **output** | the requirements, and the criterion that shows each is met |
 * | the **refusal** | the model is not connected; or the answer names no requirement; or the requirements and the criteria do not pair |
 *
 * ## The model
 *
 * This is the first stage that needs a **model**, and the model layer is
 * another milestone's work. So in this build the seam refuses, the stage
 * refuses with it, and the pipeline reports the stage and why. That is the
 * degradation contract doing its job — not a gap to work around.
 *
 * When the model layer lands, the same stage asks the same seam, and the seam
 * answers.
 */

import {
  outputOf,
  refusalFromSeam,
  stageRefusal,
  type PipelineStage,
  type StageOutcome,
} from '../stage.js';
import { linesNamed, parseModelLines } from './format.js';

/** The instruction the stage gives the model. */
export function specifyPrompt(idea: string): string {
  return [
    'Write the specification of the product described below.',
    'Answer with one line per item and no other text:',
    '  requirement <the requirement>',
    '  accept <the criterion that shows the requirement is met>',
    'Give one "accept" line for every "requirement" line, in the same order.',
    '',
    'The idea:',
    idea,
  ].join('\n');
}

/** What the stage read out of the model's answer. */
export type SpecificationReading =
  | { readonly ok: true; readonly requirements: string[]; readonly criteria: string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Read the specification out of an answer.
 *
 * A model that answered with something the stage cannot read is **not**
 * completed with half an answer: the stage refuses, and says which part was
 * missing.
 */
export function parseSpecification(text: string): SpecificationReading {
  const lines = parseModelLines(text);
  const requirements = linesNamed(lines, 'requirement');
  const criteria = linesNamed(lines, 'accept');

  if (requirements.length === 0) {
    return { ok: false, reason: 'the model named no requirement for the specification' };
  }
  if (requirements.length !== criteria.length) {
    return {
      ok: false,
      reason: `the specification names ${requirements.length} requirements and ${criteria.length} acceptance criteria, and they do not pair`,
    };
  }
  return { ok: true, requirements, criteria };
}

/** The `specify` stage. */
export function createSpecifyStage(): PipelineStage {
  return {
    id: 'specify',
    title: 'the specification',
    requires: ['model'],
    async run(input, context): Promise<StageOutcome> {
      const concept = outputOf(input, 'concept');
      if (!concept) {
        return stageRefusal('the concept stage produced nothing to specify');
      }
      const idea = concept.artifacts['idea'];
      if (typeof idea !== 'string' || idea.trim().length === 0) {
        return stageRefusal('the concept carries no idea to specify');
      }

      let answer: { readonly text: string };
      try {
        answer = await context.services.model.complete({
          stageId: 'specify',
          prompt: specifyPrompt(idea),
        });
      } catch (error) {
        return refusalFromSeam(error);
      }

      const reading = parseSpecification(answer.text);
      if (!reading.ok) {
        return stageRefusal(reading.reason);
      }

      return {
        state: 'completed',
        output: {
          stageId: 'specify',
          summary: `${reading.requirements.length} requirements, each with an acceptance criterion`,
          artifacts: {
            requirements: reading.requirements,
            criteria: reading.criteria,
          },
        },
      };
    },
  };
}

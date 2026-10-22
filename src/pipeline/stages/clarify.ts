/**
 * The `clarify` stage — the questions the idea leaves open.
 *
 * **One responsibility:** naming what the concept has **not** answered, so
 * that the specification is written against answers and not against guesses.
 *
 * ## The contract
 *
 * | | |
 * |---|---|
 * | the **input** | the concept's document |
 * | the **output** | the questions, each with the assumption it holds down |
 * | the **refusal** | there is no concept to clarify |
 *
 * The stage **asks**; it does not answer. Each question carries the assumption
 * it guards — what would go wrong if nobody answered it — so the reader knows
 * which question is the expensive one. The stage does not pretend the
 * questions are answered, and it does not answer them on the user's behalf.
 */

import { outputOf, stageRefusal, type PipelineStage, type StageOutcome } from '../stage.js';

/** One open question. */
export interface ClarificationQuestion {
  /** The question. */
  readonly question: string;
  /** What goes wrong while it is unanswered. */
  readonly guards: string;
}

/** The standing questions every concept leaves open. */
const QUESTIONS: readonly ClarificationQuestion[] = [
  {
    question: 'Who is the product for?',
    guards: 'the audience is not named, and the work would be for nobody in particular',
  },
  {
    question: 'What does "done" look like, and how is it measured?',
    guards: 'an acceptance criterion cannot be written without it',
  },
  {
    question: 'What must the product satisfy, and what must it never do?',
    guards: 'the constraints decide what the specification may ask for',
  },
];

/** The `clarify` stage. */
export function createClarifyStage(): PipelineStage {
  return {
    id: 'clarify',
    title: 'the questions the idea leaves open',
    requires: [],
    async run(input): Promise<StageOutcome> {
      const concept = outputOf(input, 'concept');
      if (!concept) {
        return stageRefusal('the concept stage produced nothing to clarify');
      }
      const idea = concept.artifacts['idea'];
      if (typeof idea !== 'string' || idea.trim().length === 0) {
        return stageRefusal('the concept carries no idea to clarify');
      }
      return {
        state: 'completed',
        output: {
          stageId: 'clarify',
          summary: `${QUESTIONS.length} questions to answer before the work is specified`,
          artifacts: {
            questions: QUESTIONS,
            idea,
          },
        },
      };
    },
  };
}

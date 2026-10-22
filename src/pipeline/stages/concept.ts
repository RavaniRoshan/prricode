/**
 * The `concept` stage — the idea, as a concept.
 *
 * **One responsibility:** turning the run's **brief** into the concept the
 * next stage consumes.
 *
 * ## The contract
 *
 * | | |
 * |---|---|
 * | the **input** | the brief — the idea the run started from |
 * | the **output** | the document: the idea, a title, and the problem it names |
 * | the **refusal** | the run carries no idea to work from |
 *
 * The stage **invents nothing**. It records the idea in the shape the stages
 * after it need: the whole idea, its title, and the problem it names. The
 * questions the idea leaves open are the `clarify` stage's, and the
 * specification is the `specify` stage's — this stage answers for neither.
 */

import { stageRefusal, type PipelineStage, type StageOutcome } from '../stage.js';

/** The first line of the text, trimmed. */
function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

/** The first sentence of the text. */
function firstSentence(text: string): string {
  const stop = text.indexOf('. ');
  return (stop === -1 ? text : text.slice(0, stop)).trim();
}

/** The `concept` stage. */
export function createConceptStage(): PipelineStage {
  return {
    id: 'concept',
    title: 'the idea, as a concept',
    requires: [],
    async run(input): Promise<StageOutcome> {
      const idea = input.brief.trim();
      if (idea.length === 0) {
        return stageRefusal('the run carries no idea to work from');
      }
      return {
        state: 'completed',
        output: {
          stageId: 'concept',
          summary: `the concept of "${firstLine(idea)}"`,
          artifacts: {
            title: firstLine(idea),
            idea,
            problem: firstSentence(idea),
          },
        },
      };
    },
  };
}

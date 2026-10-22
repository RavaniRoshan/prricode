/**
 * The `build` stage — the artefacts.
 *
 * **One responsibility:** turning the plan into the **artefacts** the step
 * calls for, each naming the acceptance criterion it delivers.
 *
 * ## The contract
 *
 * | | |
 * |---|---|
 * | the **input** | the plan's steps |
 * | the **output** | the artefacts — a path, the content, and the criterion delivered |
 * | the **refusal** | the model is not connected; or there is no plan to build; or the answer names no artefact |
 *
 * ## What an artefact is
 *
 * An artefact is a **file the product will hold**: a path, the text of the
 * file, and the criterion it delivers. The stage does not write the file —
 * the `ship` stage releases what the verification found, and what happens to
 * the files themselves is the product's business, not this stage's.
 */

import {
  outputOf,
  refusalFromSeam,
  stageRefusal,
  type PipelineStage,
  type StageOutcome,
} from '../stage.js';
import { criterionNumber, parseModelLines } from './format.js';

/** One artefact the build produced. */
export interface BuiltArtefact {
  /** The path of the file. */
  readonly path: string;
  /** The text of the file. */
  readonly content: string;
  /** The acceptance criterion the artefact delivers — one-based. */
  readonly criterion: number;
}

/** The instruction the stage gives the model. */
export function buildPrompt(steps: readonly unknown[]): string {
  return [
    'Produce the files that carry out the steps below.',
    'Answer with one line per item and no other text:',
    '  artefact <the path of the file>',
    '  content <the text of the file, on one line>',
    '  satisfies <the number of the acceptance criterion the file delivers>',
    'The criterion numbers count from 1, in the order the specification listed them.',
    '',
    'The steps:',
    ...steps.map((step, index) => {
      const record = typeof step === 'object' && step !== null ? (step as Record<string, unknown>) : {};
      return `${index + 1}. ${String(record['text'] ?? '')} (criterion ${String(record['criterion'] ?? '')})`;
    }),
  ].join('\n');
}

/** What the stage read out of the model's answer. */
export type BuildReading =
  | { readonly ok: true; readonly artefacts: BuiltArtefact[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Read the artefacts out of an answer.
 *
 * An `artefact` line opens a file, and the `content` and `satisfies` lines
 * that follow it close it. A file with no criterion is refused: the
 * verification would have nothing to check it against.
 */
export function parseArtefacts(text: string, criteriaCount: number): BuildReading {
  const artefacts: BuiltArtefact[] = [];
  let path: string | null = null;
  let content: string | null = null;

  for (const line of parseModelLines(text)) {
    if (line.name === 'artefact') {
      if (path !== null) {
        return { ok: false, reason: 'the build named a file that carries no acceptance criterion' };
      }
      path = line.value;
      content = null;
      continue;
    }
    if (line.name === 'content') {
      if (path === null) {
        return { ok: false, reason: 'the build named content that belongs to no file' };
      }
      content = line.value;
      continue;
    }
    if (line.name === 'satisfies') {
      if (path === null) {
        return { ok: false, reason: 'the build named an acceptance criterion that belongs to no file' };
      }
      const criterion = criterionNumber(line.value);
      if (criterion === null) {
        return { ok: false, reason: 'the build named an acceptance criterion that is not a number' };
      }
      if (criterion > criteriaCount) {
        return {
          ok: false,
          reason: `the build delivers the acceptance criterion ${criterion}, and the specification has ${criteriaCount}`,
        };
      }
      artefacts.push({ path, content: content ?? '', criterion });
      path = null;
      content = null;
    }
  }

  if (path !== null) {
    return { ok: false, reason: 'the build named a file that carries no acceptance criterion' };
  }
  if (artefacts.length === 0) {
    return { ok: false, reason: 'the model named no file for the build' };
  }
  return { ok: true, artefacts };
}

/** The `build` stage. */
export function createBuildStage(): PipelineStage {
  return {
    id: 'build',
    title: 'the artefacts',
    requires: ['model'],
    async run(input, context): Promise<StageOutcome> {
      const plan = outputOf(input, 'plan');
      if (!plan) {
        return stageRefusal('the plan stage produced nothing to build');
      }
      const steps = plan.artifacts['steps'];
      if (!Array.isArray(steps) || steps.length === 0) {
        return stageRefusal('the plan names no step to build');
      }
      const specification = outputOf(input, 'specify');
      const criteria = specification?.artifacts['criteria'];
      const criteriaCount = Array.isArray(criteria) ? criteria.length : 0;

      let answer: { readonly text: string };
      try {
        answer = await context.services.model.complete({
          stageId: 'build',
          prompt: buildPrompt(steps),
        });
      } catch (error) {
        return refusalFromSeam(error);
      }

      const reading = parseArtefacts(answer.text, criteriaCount);
      if (!reading.ok) {
        return stageRefusal(reading.reason);
      }

      return {
        state: 'completed',
        output: {
          stageId: 'build',
          summary: `${reading.artefacts.length} files, each delivering an acceptance criterion`,
          artifacts: { artefacts: reading.artefacts },
        },
      };
    },
  };
}

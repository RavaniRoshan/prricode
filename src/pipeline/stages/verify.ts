/**
 * The `verify` stage — the checks.
 *
 * **One responsibility:** checking every acceptance criterion of the
 * specification against what the build produced, and saying which ones are met.
 *
 * ## The contract
 *
 * | | |
 * |---|---|
 * | the **input** | the specification's criteria, and the build's artefacts |
 * | the **output** | the checks — one per criterion, each with its verdict — and whether the whole passed |
 * | the **refusal** | there is nothing to verify; or there is nothing to verify against |
 *
 * ## How a criterion is checked
 *
 * A criterion is met when **an artefact delivers it**: the build named the
 * criterion the artefact satisfies, and the criterion is one of the
 * specification's. That is a real check with a real answer — a criterion no
 * artefact delivers **fails**, and the stage says so.
 *
 * The stage does not re-run the product's own tests: that is the verification
 * the product milestone (`CC-049`) carries out, and this stage is the
 * **pipeline's** check, over the documents the pipeline holds.
 */

import { outputOf, stageRefusal, type PipelineStage, type StageOutcome } from '../stage.js';

/** One check, and its verdict. */
export interface VerificationCheck {
  /** The criterion that was checked. */
  readonly criterion: string;
  /** Whether it is met. */
  readonly passed: boolean;
  /** Why, in one line. */
  readonly detail: string;
}

/** One artefact, as the verification reads it. */
interface DeliveredArtefact {
  readonly path: string;
  readonly criterion: number;
}

/** The artefacts of the build, as the verification reads them. */
function readArtefacts(value: unknown): DeliveredArtefact[] {
  if (!Array.isArray(value)) return [];
  const artefacts: DeliveredArtefact[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const path = record['path'];
    const criterion = record['criterion'];
    if (typeof path !== 'string') continue;
    if (typeof criterion !== 'number') continue;
    artefacts.push({ path, criterion });
  }
  return artefacts;
}

/** The `verify` stage. */
export function createVerifyStage(): PipelineStage {
  return {
    id: 'verify',
    title: 'the checks',
    requires: [],
    async run(input): Promise<StageOutcome> {
      const specification = outputOf(input, 'specify');
      if (!specification) {
        return stageRefusal('there is nothing to verify, because there is no specification');
      }
      const criteria = specification.artifacts['criteria'];
      if (!Array.isArray(criteria) || criteria.length === 0) {
        return stageRefusal('there is nothing to verify against, because the specification names no acceptance criterion');
      }

      const built = outputOf(input, 'build');
      if (!built) {
        return stageRefusal('there is nothing to verify, because the build produced nothing');
      }
      const artefacts = readArtefacts(built.artifacts['artefacts']);
      if (artefacts.length === 0) {
        return stageRefusal('there is nothing to verify, because the build produced no file');
      }

      const checks: VerificationCheck[] = criteria.map((criterion, index) => {
        const delivered = artefacts.filter((artefact) => artefact.criterion === index + 1);
        return {
          criterion: String(criterion),
          passed: delivered.length > 0,
          detail:
            delivered.length > 0
              ? `${delivered.length} file(s) deliver it: ${delivered.map((artefact) => artefact.path).join(', ')}`
              : 'no file delivers this criterion',
        };
      });

      const passed = checks.every((check) => check.passed);
      const met = checks.filter((check) => check.passed).length;

      return {
        state: 'completed',
        output: {
          stageId: 'verify',
          summary: `${met} of ${checks.length} acceptance criteria met`,
          artifacts: { checks, passed },
        },
      };
    },
  };
}

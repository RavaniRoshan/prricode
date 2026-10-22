/**
 * The `ship` stage — the release.
 *
 * **One responsibility:** releasing what the verification found, and only
 * what it found.
 *
 * ## The contract
 *
 * | | |
 * |---|---|
 * | the **input** | the verification's verdict, and the build's artefacts |
 * | the **output** | the release — the artefacts, under the run's id |
 * | the **refusal** | nothing was verified; or the verification did not pass; or the approval was refused |
 *
 * ## The approval
 *
 * A release is a **decision for a person**, so this stage asks the approval
 * seam. The approval **rules** are another milestone's work (`CC-046`): the
 * protocol's *mechanics* exist and the rules do not, so in this build the seam
 * refuses with a reason, and this stage refuses with it.
 *
 * The stage does not release without the decision, and it does not release
 * what did not pass verification — either way it says why.
 */

import {
  outputOf,
  refusalFromSeam,
  stageRefusal,
  type PipelineStage,
  type StageOutcome,
} from '../stage.js';

/** What the stage releases. */
export interface Release {
  /** The release's id — the run it came from. */
  readonly id: string;
  /** The files it carries. */
  readonly artefacts: unknown;
}

/** The `ship` stage. */
export function createShipStage(): PipelineStage {
  return {
    id: 'ship',
    title: 'the release',
    requires: ['approval'],
    async run(input, context): Promise<StageOutcome> {
      const verification = outputOf(input, 'verify');
      if (!verification) {
        return stageRefusal('there is nothing to release, because nothing was verified');
      }
      if (verification.artifacts['passed'] !== true) {
        return stageRefusal('the product did not pass verification, so it was not released');
      }
      const built = outputOf(input, 'build');
      const artefacts = built?.artifacts['artefacts'] ?? [];

      let decision: { readonly decision: 'allow' | 'deny'; readonly answerer: string };
      try {
        decision = await context.services.approvals.request({
          stageId: 'ship',
          subject: 'the release',
          reason: 'releasing a verified product is a decision for a person',
          call: { artefacts },
        });
      } catch (error) {
        return refusalFromSeam(error);
      }

      if (decision.decision !== 'allow') {
        return stageRefusal('the release was denied, so the product was not shipped');
      }

      const release: Release = { id: input.runId, artefacts };
      return {
        state: 'completed',
        output: {
          stageId: 'ship',
          summary: `the release of ${Array.isArray(artefacts) ? artefacts.length : 0} file(s), approved by ${decision.answerer}`,
          artifacts: { release },
        },
      };
    },
  };
}

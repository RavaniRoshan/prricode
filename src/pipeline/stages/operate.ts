/**
 * The `operate` stage — the operating record.
 *
 * **One responsibility:** recording what has to be watched once the product is
 * out.
 *
 * ## The contract
 *
 * | | |
 * |---|---|
 * | the **input** | the release |
 * | the **output** | the runbook, and the files to watch |
 * | the **refusal** | there is no release to operate |
 *
 * ## What this stage is and is not
 *
 * It **records** the operating work; it does not perform it. Nothing here
 * watches a process, schedules a job or opens a dashboard — the stage says
 * what would have to be watched, and the product is what does it. A stage that
 * claimed to be operating something would be faking it.
 */

import { outputOf, stageRefusal, type PipelineStage, type StageOutcome } from '../stage.js';

/** The `operate` stage. */
export function createOperateStage(): PipelineStage {
  return {
    id: 'operate',
    title: 'the operating record',
    requires: [],
    async run(input): Promise<StageOutcome> {
      const shipped = outputOf(input, 'ship');
      if (!shipped) {
        return stageRefusal('there is nothing to operate, because nothing was shipped');
      }
      const release = shipped.artifacts['release'];
      if (typeof release !== 'object' || release === null) {
        return stageRefusal('the release carries nothing to operate');
      }
      const record = release as Record<string, unknown>;
      const artefacts = Array.isArray(record['artefacts']) ? record['artefacts'] : [];

      const watch: string[] = [];
      for (const entry of artefacts) {
        if (typeof entry !== 'object' || entry === null) continue;
        const artefact = entry as Record<string, unknown>;
        const path = artefact['path'];
        if (typeof path !== 'string') continue;
        watch.push(path);
      }

      const runbook = [
        're-read the release record and confirm it still matches what was shipped',
        're-run the verification stage against every acceptance criterion',
        ...watch.map((path) => `watch ${path}: a change to it is a change to the product`),
      ];

      return {
        state: 'completed',
        output: {
          stageId: 'operate',
          summary: `${watch.length} file(s) to watch, and a runbook of ${runbook.length} lines`,
          artifacts: { runbook, watch },
        },
      };
    },
  };
}

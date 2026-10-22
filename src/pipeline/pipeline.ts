/**
 * The pipeline — the run.
 *
 * **The concept:** `docs/DIVERGENCE-LAYER-2.md` §4 — "the purpose is stated
 * plainly: **turning an idea into a verified, shippable product.**"
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §8.
 *
 * **One responsibility:** running the eight stages in order, and **reporting
 * every one of them**.
 *
 * ## The rule this module exists to keep
 *
 * > **A stage that cannot run says so and the pipeline reports which stage and
 * > why**, rather than skipping it silently.
 *
 * So the run has three obligations, and each of them is a rule about what the
 * report may **not** leave out:
 *
 *   1. **A stage that refuses stops the run** — the stages after it consume
 *      what it did not produce, and running them would be pretending.
 *   2. **The stages that were never reached are reported** — with the state
 *      `not-reached` and the reason. A stage that is skipped is a stage that
 *      was reported.
 *   3. **A stage that is not registered is reported** — the run refuses at that
 *      stage and says which one is missing. The pipeline never skips a stage
 *      because nobody supplied it.
 *
 * ## The pipeline does not know how a stage arrived
 *
 * The runner holds registrations, and a registration carries a `PipelineStage`
 * and the **way** it arrived. The runner never reads the way: it calls
 * `stage.run(input, context)` and nothing else. The delivery is metadata for
 * the caller; the behaviour is the same for all three.
 *
 * ## The advance
 *
 * Every stage that is reached advances twice — once when it starts and once
 * when it ends — and each advance is an event. The event carries the stage's
 * id and the stage's state, and a stage that is **not proceeding** carries the
 * shared shape: `{ enabled: false, unsupported: <why> }`.
 */

import { capabilityRecord, type CapabilityRecord } from '../protocol/index.js';
import {
  PIPELINE_STAGE_IDS,
  isStageOutcome,
  stageRefusal,
  type StageContext,
  type StageInput,
  type StageOutput,
  type StageOutcome,
  type StageState,
} from './stage.js';
import { createStageServices, type StageServices } from './services.js';
import type { StageRegistration } from './registry.js';

/* -------------------------------------------------------------------------- */
/* The events                                                                  */
/* -------------------------------------------------------------------------- */

/** One advance of a stage. */
export interface StageEvent {
  /** The run the stage belongs to. */
  readonly runId: string;
  /** The stage that advanced. */
  readonly stageId: string;
  /** The state the stage is in. */
  readonly state: StageState;
  /** The output, when the stage completed. */
  readonly output?: StageOutput;
  /** The shared shape, when the stage is not proceeding. */
  readonly capability?: CapabilityRecord;
}

/**
 * The parameters of an `event/stage` notification.
 *
 * The specification says the advance carries the stage's id, the stage's
 * state, and — when the stage is not proceeding — the shared shape. So the
 * notification carries the pair **flat**: `enabled` and `unsupported`, which is
 * what the protocol's own fixture already sends.
 */
export function stageEventParams(event: StageEvent): Record<string, unknown> {
  const proceeding = event.state === 'running' || event.state === 'completed';
  const unsupported = proceeding
    ? null
    : (event.capability?.unsupported ?? 'the stage did not proceed and named no reason');
  return {
    stageId: event.stageId,
    state: event.state,
    enabled: proceeding,
    unsupported,
  };
}

/* -------------------------------------------------------------------------- */
/* The report                                                                  */
/* -------------------------------------------------------------------------- */

/** What the run did with one stage. */
export interface StageRecord {
  /** The stage's id. */
  readonly stageId: string;
  /** The stage's title, when it had one. */
  readonly title: string;
  /** What happened to it. */
  readonly state: 'completed' | 'refused' | 'not-reached';
  /** The output, when the stage completed. */
  readonly output?: StageOutput;
  /** The reason, when it did not proceed. */
  readonly reason?: string;
}

/** The run's report. */
export interface PipelineRun {
  /** The run's id. */
  readonly runId: string;
  /** The idea the run started from. */
  readonly brief: string;
  /** Whether the run finished. */
  readonly state: 'completed' | 'refused';
  /** Every stage of the pipeline, in order — including the ones never reached. */
  readonly records: readonly StageRecord[];
  /** Every stage that completed, keyed by that stage's id. */
  readonly outputs: Readonly<Record<string, StageOutput>>;
  /** The stage the run stopped at, when it stopped. */
  readonly failedAt: string | null;
  /** The reason the run stopped, when it stopped. */
  readonly reason: string | null;
}

/** The options a run is started with. */
export interface PipelineRunOptions {
  /** The idea the run starts from. */
  readonly brief: string;
  /** The run's id. */
  readonly runId?: string;
  /** The seams the run uses. */
  readonly services?: StageServices;
  /** Called with every advance. */
  readonly onStage?: (event: StageEvent) => void;
}

/* -------------------------------------------------------------------------- */
/* The pipeline                                                                */
/* -------------------------------------------------------------------------- */

/** The options a pipeline is created with. */
export interface PipelineOptions {
  /** The seams the pipeline's runs use. */
  readonly services?: StageServices;
}

/**
 * The pipeline.
 *
 * It holds the stages — however they arrived — and runs them in the
 * pipeline's order.
 */
export class Pipeline {
  private readonly registrations = new Map<string, StageRegistration>();
  private readonly services: StageServices;
  private runCounter = 0;

  constructor(options: PipelineOptions = {}) {
    this.services = options.services ?? createStageServices();
  }

  /** The seams this pipeline's runs use. */
  get stageServices(): StageServices {
    return this.services;
  }

  /** Every registered stage, in the order it was registered. */
  get stages(): StageRegistration[] {
    return [...this.registrations.values()];
  }

  /**
   * Register a stage.
   *
   * The registration carries the **way** the stage arrived, and the pipeline's
   * behaviour never reads it.
   */
  register(registration: StageRegistration): this {
    this.registrations.set(registration.id, registration);
    this.services.capabilities.register('pipeline', capabilityRecord(true, null));
    return this;
  }

  /**
   * Run the pipeline.
   *
   * Every stage of the pipeline is in the report, whatever happened to it.
   */
  async run(options: PipelineRunOptions): Promise<PipelineRun> {
    this.runCounter += 1;
    const runId = options.runId ?? `run_${this.runCounter}`;
    const brief = options.brief;
    const services = options.services ?? this.services;

    const outputs: Record<string, StageOutput> = {};
    const records: StageRecord[] = [];
    let previous: StageOutput | null = null;
    let state: 'completed' | 'refused' = 'completed';
    let failedAt: string | null = null;
    let reason: string | null = null;

    const emit = (event: StageEvent): void => {
      options.onStage?.(event);
    };

    for (const stageId of PIPELINE_STAGE_IDS) {
      if (failedAt !== null) {
        // The stage was never reached. It is **reported**, never skipped.
        records.push({
          stageId,
          title: stageId,
          state: 'not-reached',
          reason: `the run stopped at "${failedAt}", which did not proceed`,
        });
        continue;
      }

      const registration = this.registrations.get(stageId);
      if (!registration) {
        // The stage nobody supplied. The run refuses **here** and says which
        // stage is missing.
        const refusal = stageRefusal(`no stage is registered for "${stageId}"`);
        records.push({ stageId, title: stageId, state: 'refused', reason: refusal.reason });
        emit({ runId, stageId, state: 'refused', capability: refusal.capability });
        state = 'refused';
        failedAt = stageId;
        reason = refusal.reason;
        continue;
      }

      emit({ runId, stageId, state: 'running' });

      const input: StageInput = {
        runId,
        brief,
        previous,
        outputs: { ...outputs },
      };
      const context: StageContext = {
        runId,
        services,
        capabilities: services.capabilities,
        signal: new AbortController().signal,
      };

      const outcome = await this.runStage(stageId, registration, input, context);
      if (outcome.state === 'completed') {
        outputs[stageId] = outcome.output;
        previous = outcome.output;
        records.push({
          stageId,
          title: registration.stage.title,
          state: 'completed',
          output: outcome.output,
        });
        emit({ runId, stageId, state: 'completed', output: outcome.output });
        continue;
      }

      records.push({
        stageId,
        title: registration.stage.title,
        state: 'refused',
        reason: outcome.reason,
      });
      emit({ runId, stageId, state: 'refused', capability: outcome.capability });
      state = 'refused';
      failedAt = stageId;
      reason = outcome.reason;
    }

    return { runId, brief, state, records, outputs, failedAt, reason };
  }

  /**
   * Run one stage, and turn whatever it does into an outcome.
   *
   * A stage that throws is **refused with the reason it threw**: the run
   * reports the stage and why, and the stages after it are reported as
   * not reached. A stage that hands back something that is not an outcome is
   * refused the same way — there is no third thing.
   */
  private async runStage(
    stageId: string,
    registration: StageRegistration,
    input: StageInput,
    context: StageContext,
  ): Promise<StageOutcome> {
    let outcome: StageOutcome;
    try {
      outcome = await registration.stage.run(input, context);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome = stageRefusal(`the stage "${stageId}" failed: ${detail}`);
    }
    if (!isStageOutcome(outcome)) {
      outcome = stageRefusal(`the stage "${stageId}" returned something that is not an outcome`);
    }
    return outcome;
  }
}

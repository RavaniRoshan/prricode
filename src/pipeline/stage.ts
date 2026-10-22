/**
 * The stage — the one interface every delivery implements.
 *
 * **The concept:** `docs/DIVERGENCE-LAYER-2.md` §4 and §6. The Product Builder
 * pipeline is *concept → clarify → specify → plan → build → verify → ship →
 * operate*, and **the stages are pluggable**: "A stage may be in-process, a
 * package, or a process speaking our protocol over stdio, and the pipeline
 * does not know the difference."
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §8.
 *
 * **One responsibility:** the shape of a stage — what it is given, what it
 * produces, and the three ways it can end.
 *
 * ## The three ways a stage ends
 *
 * > **Never fake success.** A stage either produces its output, or refuses
 * > with a reason, or reports the capability as not enabled with a reason.
 * > There is no third thing.
 *
 * So a stage ends in exactly one of two ways:
 *
 *   - **completed** — it produced its output; or
 *   - **refused** — it is not proceeding, and it carries the **shared shape**:
 *     `{ enabled: false, unsupported: <the reason> }`.
 *
 * The specification says the same of the advance notification:
 *
 * > A stage's **advance** is an `event/stage` notification carrying the stage's
 * > id, the stage's state, and — when the stage is not proceeding — the same
 * > `{ enabled: false, unsupported: <why> }` shape.
 *
 * So **every** stage that is not proceeding carries the shared pair, whether it
 * refused because a capability it needs is off, or because a seam it asked
 * refused it, or because the input it was given is not the input it needs.
 * There is one shape for "not proceeding", and a reason in it.
 *
 * ## Why a refusal carries the capability record
 *
 * The first layer raised **typed** refusals that named the capability they
 * needed, and the second layer generalises that into **data**: one record,
 * asked of anything. A refusal is that record, already built — so the reason a
 * stage gives is checked where it is made (a reason is a sentence, never a
 * placeholder), and a caller can ask the refusal the same question it asks of
 * any capability.
 */

import {
  capabilityRecord,
  type CapabilityRecord,
  type CapabilityRegistry,
} from '../protocol/index.js';
import { StageSeamRefusal, type StageServices } from './services.js';

/* -------------------------------------------------------------------------- */
/* The pipeline's shape                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The eight stages of the Product Builder pipeline, in the order they run.
 *
 * The order is the concept's: "turning an idea into a verified, shippable
 * product". Each stage consumes the one before it and produces the one after.
 */
export const PIPELINE_STAGE_IDS = [
  'concept',
  'clarify',
  'specify',
  'plan',
  'build',
  'verify',
  'ship',
  'operate',
] as const;

/** One of the pipeline's eight stage ids. */
export type PipelineStageId = (typeof PIPELINE_STAGE_IDS)[number];

/**
 * The state a stage is in.
 *
 * `not-reached` is a state the **report** uses: a stage the run never got to,
 * because the stage before it refused. It is reported, never silently skipped.
 */
export type StageState = 'pending' | 'running' | 'completed' | 'refused' | 'not-reached';

/* -------------------------------------------------------------------------- */
/* What a stage produces                                                       */
/* -------------------------------------------------------------------------- */

/** What a stage produces. */
export interface StageOutput {
  /** The stage that produced it. */
  readonly stageId: string;
  /** One line saying what the stage did. */
  readonly summary: string;
  /** The stage's own document, beneath the summary. */
  readonly artifacts: Readonly<Record<string, unknown>>;
}

/**
 * A stage that is not proceeding, and why.
 *
 * The reason is a sentence, and the capability record carries the **same**
 * sentence — the shared shape the whole product uses.
 */
export interface StageRefusal {
  readonly state: 'refused';
  /** The sentence that says what is missing. */
  readonly reason: string;
  /** The shared shape: `{ enabled: false, unsupported: <the reason> }`. */
  readonly capability: CapabilityRecord;
}

/** How a stage ended. */
export type StageOutcome =
  | { readonly state: 'completed'; readonly output: StageOutput }
  | StageRefusal;

/**
 * Build a refusal.
 *
 * The reason is checked where the refusal is made: `capabilityRecord` refuses
 * a reason that is empty, a placeholder, or a single word. A stage therefore
 * **cannot** refuse with something that says nothing.
 */
export function stageRefusal(reason: string): StageRefusal {
  const trimmed = reason.trim();
  return {
    state: 'refused',
    reason: trimmed,
    capability: capabilityRecord(false, trimmed),
  };
}

/**
 * Turn whatever a seam refused with into a stage refusal.
 *
 * A seam that refused with a reason gives the reason; a seam that **failed**
 * — threw something else — is reported as a failure, and the failure's message
 * is carried so that nothing is swallowed.
 */
export function refusalFromSeam(error: unknown): StageRefusal {
  if (error instanceof StageSeamRefusal) {
    return stageRefusal(error.reason);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return stageRefusal(`the seam failed: ${detail}`);
}

/* -------------------------------------------------------------------------- */
/* What a stage is given                                                       */
/* -------------------------------------------------------------------------- */

/** What a stage is given. */
export interface StageInput {
  /** The run the stage belongs to. */
  readonly runId: string;
  /** The idea the run started from. */
  readonly brief: string;
  /** The output of the stage immediately before this one. */
  readonly previous: StageOutput | null;
  /** Every earlier stage's output, keyed by that stage's id. */
  readonly outputs: Readonly<Record<string, StageOutput>>;
}

/** The context a stage runs in. */
export interface StageContext {
  /** The run the stage belongs to. */
  readonly runId: string;
  /** The seams the stage may use — the model and the approvals. */
  readonly services: StageServices;
  /** The capabilities this run knows about. */
  readonly capabilities: CapabilityRegistry;
  /** The signal that fires when the run is cancelled. */
  readonly signal: AbortSignal;
}

/**
 * The output of an earlier stage, or `null` when there is none.
 *
 * The lookup is of a **caller-supplied key** in a plain object — a stage that
 * arrived over the wire carries its input as data — so it is guarded: a stage
 * named `__proto__` is an ordinary name and not a prototype assignment.
 */
export function outputOf(input: StageInput, stageId: string): StageOutput | null {
  if (!Object.hasOwn(input.outputs, stageId)) return null;
  return input.outputs[stageId] ?? null;
}

/* -------------------------------------------------------------------------- */
/* The stage itself                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A stage of the pipeline.
 *
 * **This is the interface every delivery implements.** An in-process stage, a
 * stage loaded from a package and a stage served by a process are all this —
 * and the pipeline never asks which one it is holding.
 */
export interface PipelineStage {
  /** The stage's id — one of the pipeline's eight. */
  readonly id: string;
  /** What the stage does, in one line. */
  readonly title: string;
  /** The capabilities the stage needs in order to run. */
  readonly requires: readonly string[];
  /** Run the stage. */
  run(input: StageInput, context: StageContext): Promise<StageOutcome>;
}

/* -------------------------------------------------------------------------- */
/* The registration                                                            */
/* -------------------------------------------------------------------------- */

/** How a stage is delivered. */
export type StageDelivery = 'in-process' | 'package' | 'process';

/** A stage, and how it was delivered. */
export interface StageRegistration {
  /** The stage's id — one of the pipeline's eight. */
  readonly id: string;
  /** How the stage arrived. The pipeline's **behaviour** never reads this. */
  readonly delivery: StageDelivery;
  /** The stage itself. */
  readonly stage: PipelineStage;
}

/* -------------------------------------------------------------------------- */
/* The checks the pipeline makes on what a stage hands back                    */
/* -------------------------------------------------------------------------- */

/** Whether a value is a stage output. */
export function isStageOutput(value: unknown): value is StageOutput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record['stageId'] !== 'string') return false;
  if (typeof record['summary'] !== 'string') return false;
  const artifacts = record['artifacts'];
  return typeof artifacts === 'object' && artifacts !== null && !Array.isArray(artifacts);
}

/** Whether a value is a stage outcome. */
export function isStageOutcome(value: unknown): value is StageOutcome {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const state = record['state'];
  if (state === 'completed') return isStageOutput(record['output']);
  if (state === 'refused') {
    if (typeof record['reason'] !== 'string') return false;
    const capability = record['capability'];
    return typeof capability === 'object' && capability !== null && !Array.isArray(capability);
  }
  return false;
}

/** Whether a value is a stage. */
export function isPipelineStage(value: unknown): value is PipelineStage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record['id'] !== 'string' || record['id'].length === 0) return false;
  return typeof record['run'] === 'function';
}

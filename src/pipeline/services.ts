/**
 * The seams — what a stage may use besides its input.
 *
 * **The concept:** `docs/DIVERGENCE-LAYER-2.md` §3 — the honest-degradation
 * contract: "a feature that cannot run **degrades with a clear reason** —
 * `enabled: false`, `unsupported: <why>` — and **never fakes success**."
 *
 * **One responsibility:** the two seams a stage reaches through — the model and
 * the approvals — and the capability records that say whether they can run.
 *
 * ## The two seams, and what is missing in this build
 *
 * | the seam | what it needs | what it is in this build |
 * |---|---|---|
 * | the **model** | a model backend | **off** — the model layer is another milestone's work (`CC-044`), and nothing is connected |
 * | the **approvals** | rules that decide, and a person to ask | **off** — the approval *rules* are another milestone's work (`CC-046`); the protocol's *mechanics* exist, the rules do not |
 *
 * So the production wiring here has **no** model and **no** approval rules, and
 * both capabilities say so in the shared shape. A stage that needs one asks the
 * seam and is refused with a reason — it never gets a pretend answer.
 *
 * ## Why the capability record is the seam's own
 *
 * A capability that is enabled and does nothing is a **bug**. So the record is
 * not written by hand: it follows the **backend**. A seam with a backend is
 * enabled, and a seam without one is disabled with the reason that names what
 * is missing. When the model layer lands, it hands a backend to this module and
 * the capability turns on — in one place, and nowhere else.
 */

import {
  CapabilityRegistry,
  capabilityRecord,
  createDefaultCapabilityRegistry,
  type CapabilityRecord,
} from '../protocol/index.js';

/** The reason the model capability gives when no backend is connected. */
export const MODEL_UNAVAILABLE = 'no model backend is connected';

/** The reason the approval capability gives when no rule can decide. */
export const APPROVAL_UNAVAILABLE = 'no approval rules are configured';

/* -------------------------------------------------------------------------- */
/* The model seam                                                              */
/* -------------------------------------------------------------------------- */

/** What a stage asks the model for. */
export interface StageModelRequest {
  /** The stage that is asking. */
  readonly stageId: string;
  /** The instruction. */
  readonly prompt: string;
}

/** What the model answered. */
export interface StageModelAnswer {
  /** The answer, as text. */
  readonly text: string;
}

/** The model backend a stage talks to. */
export interface StageModelBackend {
  /** Answer a request. */
  complete(request: StageModelRequest): Promise<StageModelAnswer>;
}

/** The model seam. */
export interface StageModelSeam {
  /** Whether the model can run, and why not when it cannot. */
  readonly capability: CapabilityRecord;
  /** Ask the model for an answer. */
  complete(request: StageModelRequest): Promise<StageModelAnswer>;
}

/* -------------------------------------------------------------------------- */
/* The approval seam                                                           */
/* -------------------------------------------------------------------------- */

/** What a stage asks a person to approve. */
export interface StageApprovalRequest {
  /** The stage that is asking. */
  readonly stageId: string;
  /** What is being approved. */
  readonly subject: string;
  /** Why it is being asked for. */
  readonly reason: string;
  /** The call the decision is about, when there is one. */
  readonly call?: unknown;
}

/** The answer to an approval. */
export interface StageApprovalAnswer {
  /** The decision. */
  readonly decision: 'allow' | 'deny';
  /** Who gave it. */
  readonly answerer: string;
}

/** The approval backend a stage talks to. */
export interface StageApprovalBackend {
  /** Ask for a decision. */
  request(request: StageApprovalRequest): Promise<StageApprovalAnswer>;
}

/** The approval seam. */
export interface StageApprovalSeam {
  /** Whether an approval can be decided, and why not when it cannot. */
  readonly capability: CapabilityRecord;
  /** Ask for a decision. */
  request(request: StageApprovalRequest): Promise<StageApprovalAnswer>;
}

/* -------------------------------------------------------------------------- */
/* The services                                                                */
/* -------------------------------------------------------------------------- */

/** Everything a stage may use besides its input. */
export interface StageServices {
  /** The model seam. */
  readonly model: StageModelSeam;
  /** The approval seam. */
  readonly approvals: StageApprovalSeam;
  /** The capabilities this run knows about — the seams' records live here. */
  readonly capabilities: CapabilityRegistry;
}

/* -------------------------------------------------------------------------- */
/* The refusal a seam gives                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A seam that refused.
 *
 * The refusal carries the **shared shape** — the capability record of the seam
 * that refused — so a stage can hand it on unchanged and the report says why
 * in the one shape the product uses.
 */
export class StageSeamRefusal extends Error {
  /** The sentence that says what is missing. */
  readonly reason: string;
  /** The shared shape, carrying the same reason. */
  readonly capability: CapabilityRecord;

  constructor(reason: string, capability?: CapabilityRecord) {
    super(reason);
    this.name = 'StageSeamRefusal';
    this.reason = reason.trim();
    this.capability = capability ?? capabilityRecord(false, this.reason);
  }
}

/* -------------------------------------------------------------------------- */
/* The wiring                                                                  */
/* -------------------------------------------------------------------------- */

/** The options the services are created with. */
export interface StageServicesOptions {
  /** The capabilities this run knows about. */
  readonly capabilities?: CapabilityRegistry;
  /** The model backend, when one is connected. */
  readonly model?: StageModelBackend;
  /** The approval backend, when the rules can decide. */
  readonly approvals?: StageApprovalBackend;
}

/**
 * Create the services.
 *
 * The capability records are **not written by hand**: each one follows the
 * backend it belongs to, and is registered in the capability registry so that
 * the protocol reports the same thing the stages see.
 */
export function createStageServices(options: StageServicesOptions = {}): StageServices {
  const capabilities = options.capabilities ?? createDefaultCapabilityRegistry();

  const modelRecord = options.model
    ? capabilityRecord(true, null)
    : capabilityRecord(false, MODEL_UNAVAILABLE);
  capabilities.register('model', modelRecord);

  const approvalRecord = options.approvals
    ? capabilityRecord(true, null)
    : capabilityRecord(false, APPROVAL_UNAVAILABLE);
  capabilities.register('approval', approvalRecord);

  const modelBackend = options.model;
  const approvalBackend = options.approvals;

  const model: StageModelSeam = {
    capability: modelRecord,
    complete(request) {
      if (!modelBackend) {
        return Promise.reject(new StageSeamRefusal(MODEL_UNAVAILABLE, modelRecord));
      }
      return modelBackend.complete(request);
    },
  };

  const approvals: StageApprovalSeam = {
    capability: approvalRecord,
    request(request) {
      if (!approvalBackend) {
        return Promise.reject(new StageSeamRefusal(APPROVAL_UNAVAILABLE, approvalRecord));
      }
      return approvalBackend.request(request);
    },
  };

  return { model, approvals, capabilities };
}

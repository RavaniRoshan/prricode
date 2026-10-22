/**
 * The approval seam — **the approval gate, as the pipeline's backend**.
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §7 — "approvals are
 * rules, the way the first layer's permissions are — `allow`, `ask`, `deny` —
 * so a matching rule decides without asking, and a rule persists".
 *
 * **One responsibility:** the decision point's answer, in the shape the
 * pipeline's seam asks for.
 *
 * ## The rule this module exists to keep
 *
 * > **A rule that matches decides without asking, and an approval nobody
 * > answers is a refusal with a reason.**
 *
 * The decision point has **three** ways out — `allowed`, `denied`, `refused` —
 * and this module maps them onto the seam's two answers and its one refusal.
 * The mapping is one-way and total:
 *
 * | the decision point | the seam |
 * |---|---|
 * | `allowed` | an answer: `allow`, with **who decided** |
 * | `denied` | an answer: `deny`, with **who decided** |
 * | `refused` | a **refusal** carrying the reason — never a quiet allow |
 *
 * **An approval that could not be asked for is not an approval that was
 * granted.** The decision point's `refused` is exactly that case: no
 * transport, a disabled capability, a peer that failed, a peer that never
 * answered. Each of them is a refusal with the reason the decision point
 * gave, and the stage that asked is refused with it.
 *
 * ## The subject
 *
 * The rules are the first layer's, and they match a **tool call**. The
 * pipeline's seam asks about a **stage's subject**, so the subject is mapped
 * onto a call: the **stage's id** is the tool, and the stage's own words —
 * what it is about, why it is asking, and the call it carries — are the
 * call's arguments. The turn the run belongs to is the subject's turn, so a
 * denial is final for the run, and the model the run works against is part of
 * the subject, so a rule may name it.
 */

import {
  type ApprovalGate,
  type ApprovalOutcome,
  type ApprovalSubject,
} from '../approvals/index.js';
import {
  StageSeamRefusal,
  type StageApprovalAnswer,
  type StageApprovalBackend,
  type StageApprovalRequest,
} from '../pipeline/index.js';

/** How the approval backend is built. */
export interface ApprovalBackendOptions {
  /** The decision point — the place where a call is decided, or asked about. */
  readonly gate: ApprovalGate;
  /** The turn the run belongs to, so a denial is final for the run. */
  readonly turnId?: string;
  /** The model the run works against, so a rule may name it. */
  readonly model?: string;
  /** Where the run's files are written, so a path rule may name them. */
  readonly path?: string;
}

/** Whether a value is a plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The subject a rule matches.
 *
 * The call's own fields always win: the stage's context is **added** to them,
 * never a replacement of them.
 */
function subjectOf(request: StageApprovalRequest, options: ApprovalBackendOptions): ApprovalSubject {
  const call = isPlainObject(request.call) ? request.call : {};
  const input: Record<string, unknown> = {
    ...(options.path === undefined ? {} : { path: options.path }),
    subject: request.subject,
    reason: request.reason,
    ...call,
  };
  return {
    toolName: request.stageId,
    input,
    ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
    ...(options.model === undefined ? {} : { model: options.model }),
  };
}

/**
 * Who decided.
 *
 * A rule decides, and the rule is named — its text and where it came from. A
 * person decides, and the person is the peer that gave the answer.
 */
export function approvalAnswerer(outcome: ApprovalOutcome): string {
  if (outcome.decidedBy === 'rule') {
    const rule = outcome.rule;
    if (rule === undefined) return 'an approval rule';
    return `the approval rule '${rule.content}' from ${rule.source}`;
  }
  if (outcome.decidedBy === 'answer') {
    return outcome.answerer;
  }
  return 'nobody';
}

/**
 * The approval gate, as the pipeline's backend.
 *
 * The decision point is asked, and its answer is the seam's answer. A refusal
 * is a refusal: the seam throws it, and the stage that asked is refused with
 * the reason the decision point gave.
 */
export function approvalBackend(options: ApprovalBackendOptions): StageApprovalBackend {
  return {
    async request(request: StageApprovalRequest): Promise<StageApprovalAnswer> {
      const outcome = await options.gate.decide(subjectOf(request, options));
      if (outcome.outcome === 'allowed') {
        return { decision: 'allow', answerer: approvalAnswerer(outcome) };
      }
      if (outcome.outcome === 'denied') {
        return { decision: 'deny', answerer: approvalAnswerer(outcome) };
      }
      throw new StageSeamRefusal(outcome.reason);
    },
  };
}

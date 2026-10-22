/**
 * The approvals.
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §7.
 *
 * **One responsibility:** the pending approvals, the decision that settles one,
 * and who the decision is attributed to.
 *
 * ## What the specification states
 *
 * - **`approval/request`** is sent when a rule says *ask*. It names the tool,
 *   the call and the reason, and it carries the request id the answer must
 *   quote.
 * - **`approval/answer`** carries `allow` or `deny` and the request id. **An
 *   answer for an unknown request id is dropped** and reported as
 *   `approval/unknown`, never applied to the wrong request.
 * - **An answer is attributed to the peer that gave it**, so a client that
 *   answers on the user's behalf is recorded as the answerer, not as the user.
 * - **A denial is final.** It is not re-asked within the turn.
 *
 * ## The rule model is not here
 *
 * The **rules** — `allow`, `ask`, `deny`, and the matching that decides
 * whether an approval is asked for at all — belong to the approvals milestone
 * (`CC-046`). This module owns the **mechanics** the protocol needs: the
 * pending set, the decision, the attribution and the finality.
 *
 * ## What is an implementation choice
 *
 *   - The **answerer** is the identity of the **peer** that sent the answer.
 *     The peer names itself when it creates a session, and the name is the
 *     answerer of every approval answered on that connection. A client that
 *     answers on the user's behalf is therefore recorded as the client, which
 *     is what the specification asks for.
 *   - A second answer for a request that is **already decided** is refused
 *     with `approval/decided`, not with `approval/unknown`: the request is
 *     known, and its decision is final. The two refusals say different things
 *     and the difference is kept.
 */

import { PROTOCOL_ERROR_CODES, protocolError } from './errors.js';

/** The two decisions an answer may carry. */
export type ApprovalDecision = 'allow' | 'deny';

/** The request an approval carries. */
export interface ApprovalRequest {
  /** The id the answer must quote. */
  readonly requestId: string;
  /** The tool the approval is about. */
  readonly tool: string;
  /** The call the approval is about. */
  readonly call: unknown;
  /** Why the approval is being asked for. */
  readonly reason: string;
  /** The session the approval belongs to, when it belongs to one. */
  readonly sessionId?: string;
  /** The turn the approval belongs to, when it belongs to one. */
  readonly turnId?: string;
}

/** A request that is waiting for an answer. */
export interface PendingApproval extends ApprovalRequest {
  /** The state of the request: `pending`, `allowed` or `denied`. */
  state: 'pending' | 'allowed' | 'denied';
  /** The peer that answered, when it has been answered. */
  answerer?: string;
  /** The decision, when it has been decided. */
  decision?: ApprovalDecision;
}

/**
 * The pending approvals of one peer.
 *
 * A decision is applied **once**: a second answer for the same request id is
 * refused, and a denial is never re-opened.
 */
export class ApprovalRegistry {
  private readonly approvals = new Map<string, PendingApproval>();

  /**
   * Open an approval.
   *
   * Opening an id that is already open is refused: two approvals may not
   * share an id, because an answer quotes the id and would then be ambiguous.
   */
  open(request: ApprovalRequest): PendingApproval {
    if (this.approvals.has(request.requestId)) {
      throw protocolError(
        PROTOCOL_ERROR_CODES.approvalUnknown,
        `the approval request id "${request.requestId}" is already open`,
      );
    }
    const pending: PendingApproval = { ...request, state: 'pending' };
    this.approvals.set(request.requestId, pending);
    return pending;
  }

  /** The approval with that id, or `undefined`. */
  get(requestId: string): PendingApproval | undefined {
    return this.approvals.get(requestId);
  }

  /** Every approval that is still waiting for an answer. */
  pending(): PendingApproval[] {
    return [...this.approvals.values()].filter((approval) => approval.state === 'pending');
  }

  /**
   * Apply a decision.
   *
   * An unknown request id is refused with `approval/unknown` and nothing is
   * applied. A request that is already decided is refused with
   * `approval/decided`, and the decision it carries is left as it is.
   */
  decide(requestId: string, decision: ApprovalDecision, answerer: string): PendingApproval {
    const approval = this.approvals.get(requestId);
    if (!approval) {
      throw protocolError(
        PROTOCOL_ERROR_CODES.approvalUnknown,
        `no approval is waiting for the request id "${requestId}"`,
        { requestId },
      );
    }
    if (approval.state !== 'pending') {
      throw protocolError(
        PROTOCOL_ERROR_CODES.approvalDecided,
        `the approval request id "${requestId}" has already been decided`,
        { requestId, decision: approval.decision },
      );
    }
    approval.state = decision === 'allow' ? 'allowed' : 'denied';
    approval.decision = decision;
    approval.answerer = answerer;
    return approval;
  }
}

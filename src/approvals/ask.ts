/**
 * The transport — **how an approval reaches a human**.
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §7.
 *
 * **One responsibility:** the seam the decision point asks through, and the
 * adapter that carries the request over the protocol.
 *
 * ## What the specification states
 *
 * - **`approval/request`** is sent when a rule says *ask*. It names the tool,
 *   the call and the reason, and it carries the request id the answer must
 *   quote.
 * - **`approval/answer`** carries `allow` or `deny` and the request id.
 * - **An answer is attributed to the peer that gave it**, so a client that
 *   answers on the user's behalf is recorded as the answerer, not as the user.
 *
 * The **mechanics** — the pending set, the answer, the attribution and the
 * finality — are the protocol's own (`src/protocol/approvals.ts`), and this
 * milestone does not reimplement them. This module is the seam the decision
 * point asks through, and the adapter that hands the protocol's server the
 * request it has to carry.
 *
 * ## What is an implementation choice
 *
 *   - **The transport reports whether an approval can be asked at all.** The
 *     protocol has one capability per area, and the `approval` area is off
 *     until a deployment turns it on. An approval that cannot be asked for is
 *     not an approval that was granted: the decision point turns a disabled
 *     capability into a **refusal that carries the capability's own reason**.
 *   - **The answerer is the peer that gave the answer.** The protocol records
 *     it, and the decision point carries it into the outcome unchanged — a
 *     client that answers on the user's behalf is recorded as the client.
 */

import type { ApprovalRequest } from '../protocol/approvals.js';
import type { ProtocolServer } from '../protocol/server.js';

/** What an answer carries. */
export interface ApprovalAnswer {
  /** The decision: `allow` or `deny`. */
  readonly decision: 'allow' | 'deny';
  /** The peer that gave the answer. */
  readonly answerer: string;
}

/** Whether an approval can be asked at all. */
export interface ApprovalCapability {
  /** Whether the approval can be asked. */
  readonly enabled: boolean;
  /** Why it cannot, or `null` when it can. */
  readonly unsupported: string | null;
}

/**
 * How an approval reaches a human.
 *
 * The transport is the only way the decision point asks, and it is the seam a
 * deployment replaces: the protocol's server over a pipe, a terminal prompt, a
 * test double.
 */
export interface ApprovalTransport {
  /** Whether an approval can be asked at all. */
  capability(): ApprovalCapability;
  /**
   * Ask, and report what the peer answered.
   *
   * The answer carries the peer that gave it, so the decision point can
   * attribute the decision.
   */
  ask(request: ApprovalRequest): Promise<ApprovalAnswer>;
}

/**
 * The protocol's server, as an approval transport.
 *
 * The server owns the request id, the pending set and the wire: it opens the
 * request, sends `approval/request` to the peer and waits for the
 * `approval/answer` that quotes the id. The answer it reports back carries the
 * peer that gave it.
 *
 * The **capability** is the protocol's own: an `approval` area that is off
 * answers with the capability's record rather than with a decision, so the
 * transport reports it and the decision point refuses with the reason the
 * capability gives.
 */
export function protocolApprovalTransport(server: ProtocolServer): ApprovalTransport {
  return {
    capability(): ApprovalCapability {
      const record = server.capabilities.get('approval');
      if (record === undefined) {
        return {
          enabled: false,
          unsupported: 'this build has no approval capability, so no approval can be asked for',
        };
      }
      return { enabled: record.enabled, unsupported: record.unsupported };
    },
    ask: (request: ApprovalRequest) => server.requestApproval(request),
  };
}

/**
 * The approvals — the second layer's approval rules and the decision point that
 * asks.
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §7 — approvals are rules,
 * the way the first layer's permissions are, and the answer travels over the
 * protocol, attributed to the peer that gave it.
 *
 * **The conformance document:**
 * [`docs/compatibility/approval-surface.md`](../../docs/compatibility/approval-surface.md).
 *
 * **The naming rule applies.** The layer names the capability — an approval —
 * and no product and no company.
 *
 * **What this layer is, in one line:** the first layer's rule language over the
 * second layer's subject, and the place where a call is decided or asked
 * about. The **rules** are the first layer's, and they are called rather than
 * copied; the **decision point** and the **protocol** are ours.
 */

export {
  APPROVAL_MODEL_FIELD,
  anchorPersistedRule,
  approvalRules,
  approvalToolContext,
  evaluateApprovalRules,
  mergeApprovalRules,
  type ApprovalRuleOptions,
  type ApprovalRuleRef,
  type ApprovalRuleSet,
  type ApprovalRuleVerdict,
  type ApprovalSubject,
} from './rules.js';

export {
  protocolApprovalTransport,
  type ApprovalAnswer,
  type ApprovalCapability,
  type ApprovalTransport,
} from './ask.js';

export {
  ApprovalError,
  PERSISTED_RULE_SOURCE,
  createFileApprovalRuleStore,
  createMemoryApprovalRuleStore,
  type ApprovalRuleStore,
} from './store.js';

export {
  ApprovalGate,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  approvalCallKey,
  approvalScope,
  createApprovalGate,
  type ApprovalAllowedByAnswer,
  type ApprovalAllowedByRule,
  type ApprovalDeniedByAnswer,
  type ApprovalDeniedByRule,
  type ApprovalGateOptions,
  type ApprovalOutcome,
  type ApprovalPersistence,
  type ApprovalRefused,
} from './decision.js';

export type { ApprovalRequest } from '../protocol/approvals.js';

/**
 * The decision point — **the place where a call is decided, or asked about**.
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §7.
 *
 * **One responsibility:** the decision. A rule decides, or a human does, and
 * the outcome says which and why.
 *
 * ## What the specification states
 *
 * - "Approvals are rules, the way the first layer's permissions are — `allow`,
 *   `ask`, `deny` — so a matching rule decides without asking, and a rule
 *   persists."
 * - "`approval/request` is sent when a rule says *ask*. It names the tool, the
 *   call and the reason, and it carries the request id the answer must quote."
 * - "**An answer is attributed to the peer that gave it**, so a client that
 *   answers on the user's behalf is recorded as the answerer, not as the user."
 * - "**A denial is final.** It is not re-asked within the turn."
 *
 * ## The three ways out
 *
 * There are **three**, and there is no fourth:
 *
 * | the outcome | what it means |
 * |---|---|
 * | `allowed` | the call may run — a rule decided, or a human allowed it |
 * | `denied` | the call may not run — a rule decided, or a human denied it |
 * | `refused` | **nobody decided**: the approval could not be asked for, and the reason says why |
 *
 * **An approval that cannot be asked for is not an approval that was
 * granted.** A build with no transport, a deployment whose approval
 * capability is off, a peer that went away and a peer that never answers are
 * all a **refusal with a reason** — never a quiet allow.
 *
 * ## The denial is final
 *
 * A denial is recorded against the **turn** the call belonged to, and the next
 * time the same call is decided in that turn, the recorded denial is returned
 * and **nobody is asked again**. The next turn asks again: the specification
 * scopes the finality to the turn.
 *
 * ## What is an implementation choice
 *
 *   - **The scope of the finality is the turn, the session, or the build.**
 *     A call that belongs to a turn is final within that turn; a call that
 *     belongs to a session but to no turn is final within that session; a
 *     call that belongs to neither is final for the life of the gate.
 *   - **Only an approval is persisted.** The specification says a rule
 *     persists, and the first layer's own "don't ask again" affordance writes
 *     allow rules. A denial is final within the turn and is not written down:
 *     the human refused *this* call, and a rule that refused every call of
 *     that shape afterwards would be a larger decision than the one that was
 *     made.
 *   - **The gate waits for an answer, and then refuses.** An approval nobody
 *     answers is not an approval that was granted, so the wait has an end and
 *     the end is a refusal that says how long it waited.
 */

import type { PermissionDecision } from '../permissions/decision.js';
import { persistentAllowRules } from '../permissions/decision.js';
import type { ApprovalRequest } from '../protocol/approvals.js';

import type { ApprovalAnswer, ApprovalTransport } from './ask.js';
import {
  anchorPersistedRule,
  approvalToolContext,
  evaluateApprovalRules,
  mergeApprovalRules,
  type ApprovalRuleRef,
  type ApprovalRuleSet,
  type ApprovalRuleVerdict,
  type ApprovalSubject,
} from './rules.js';
import type { ApprovalRuleStore } from './store.js';

/** What a decision says about the persistence of the rule it produced. */
export interface ApprovalPersistence {
  /** The rules that were written. */
  readonly rules: readonly string[];
  /** Why no rule was written, when none was. */
  readonly refused?: string;
}

/** A call a rule allowed. */
export interface ApprovalAllowedByRule {
  /** The call may run. */
  readonly outcome: 'allowed';
  /** The rule decided it. */
  readonly decidedBy: 'rule';
  /** Why. */
  readonly reason: string;
  /** The rule that decided it. */
  readonly rule?: ApprovalRuleRef;
}

/** A call a human allowed. */
export interface ApprovalAllowedByAnswer {
  /** The call may run. */
  readonly outcome: 'allowed';
  /** The human decided it. */
  readonly decidedBy: 'answer';
  /** Why. */
  readonly reason: string;
  /** The peer that gave the answer. */
  readonly answerer: string;
  /** The request id the answer quoted. */
  readonly requestId: string;
  /** What was persisted, when a store is configured. */
  readonly persistence?: ApprovalPersistence;
}

/** A call a rule blocked. */
export interface ApprovalDeniedByRule {
  /** The call may not run. */
  readonly outcome: 'denied';
  /** The rule decided it. */
  readonly decidedBy: 'rule';
  /** Why. */
  readonly reason: string;
  /** The rule that decided it. */
  readonly rule?: ApprovalRuleRef;
}

/** A call a human blocked. */
export interface ApprovalDeniedByAnswer {
  /** The call may not run. */
  readonly outcome: 'denied';
  /** The human decided it. */
  readonly decidedBy: 'answer';
  /** Why. */
  readonly reason: string;
  /** The peer that gave the answer. */
  readonly answerer: string;
  /** The request id the answer quoted. */
  readonly requestId: string;
}

/** A call nobody could decide. */
export interface ApprovalRefused {
  /** Nobody decided: the approval could not be asked for. */
  readonly outcome: 'refused';
  /** Nobody decided it. */
  readonly decidedBy: 'nobody';
  /** Why it could not be asked for. */
  readonly reason: string;
}

/** Every way a decision can come out. */
export type ApprovalOutcome =
  | ApprovalAllowedByRule
  | ApprovalAllowedByAnswer
  | ApprovalDeniedByRule
  | ApprovalDeniedByAnswer
  | ApprovalRefused;

/** How the gate is built. */
export interface ApprovalGateOptions {
  /** The rules the gate decides with. */
  readonly rules: ApprovalRuleSet;
  /** How an approval reaches a human. Without one, an ask cannot be asked. */
  readonly transport?: ApprovalTransport;
  /** Where the rules a human's approval produced are kept. */
  readonly store?: ApprovalRuleStore;
  /** How long the gate waits for an answer. Zero waits forever. */
  readonly timeoutMs?: number;
  /** The prefix of the request ids the gate allocates. */
  readonly requestIdPrefix?: string;
}

/** The default wait for an answer. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;

/** A denial that was recorded, so that it is not asked about again. */
interface RecordedDenial {
  readonly reason: string;
  readonly answerer: string;
  readonly requestId: string;
}

/**
 * The scope a denial is final in.
 *
 * The turn, when the call belongs to one; the session, when it belongs to one
 * but to no turn; and the life of the gate, when it belongs to neither.
 */
export function approvalScope(subject: ApprovalSubject): string {
  if (subject.turnId !== undefined && subject.turnId.length > 0) return `turn:${subject.turnId}`;
  if (subject.sessionId !== undefined && subject.sessionId.length > 0) {
    return `session:${subject.sessionId}`;
  }
  return 'gate';
}

/**
 * The key a call is recorded under.
 *
 * The id of the call, when the caller has one; otherwise the tool and the
 * call's own arguments, written out in a stable order so that two calls with
 * the same arguments are the same call.
 */
export function approvalCallKey(subject: ApprovalSubject): string {
  if (subject.toolUseId !== undefined && subject.toolUseId.length > 0) {
    return `use:${subject.toolUseId}`;
  }
  return `call:${subject.toolName}:${stableText(subject.input)}`;
}

/** A value written out in a stable order. */
function stableText(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableText(entry)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts = keys.map((key) => {
      // The keys are the object's own, and the lookup is guarded anyway.
      if (!Object.hasOwn(record, key)) return `${JSON.stringify(key)}:undefined`;
      return `${JSON.stringify(key)}:${stableText(record[key])}`;
    });
    return `{${parts.join(',')}}`;
  }
  return typeof value;
}

/**
 * The decision point.
 *
 * It is asked about a call, and it answers with one of the three outcomes.
 * Nothing else comes out of it, and an approval that could not be asked for is
 * a refusal and never an approval.
 */
export class ApprovalGate {
  readonly #rules: ApprovalRuleSet;
  readonly #transport: ApprovalTransport | undefined;
  readonly #store: ApprovalRuleStore | undefined;
  readonly #timeoutMs: number;
  readonly #requestIdPrefix: string;
  readonly #denials = new Map<string, RecordedDenial>();
  #counter = 0;

  constructor(options: ApprovalGateOptions) {
    this.#rules = options.rules;
    this.#transport = options.transport;
    this.#store = options.store;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.#requestIdPrefix = options.requestIdPrefix ?? 'approval';
  }

  /**
   * Decide a call.
   *
   * A rule decides without asking. A call no rule covers is asked about, and
   * the answer resolves it — attributed to the peer that gave it. A denial is
   * final within the turn, so the same call in the same turn is not asked
   * about again.
   */
  async decide(subject: ApprovalSubject): Promise<ApprovalOutcome> {
    let rules: ApprovalRuleSet;
    try {
      rules = await this.#effectiveRules();
    } catch (error) {
      return {
        outcome: 'refused',
        decidedBy: 'nobody',
        reason: `The approval rules could not be read, so this ${subject.toolName} call cannot be decided: ${messageOf(error)}`,
      };
    }

    const verdict = evaluateApprovalRules(subject, rules);

    if (verdict.behavior === 'allow') {
      return {
        outcome: 'allowed',
        decidedBy: 'rule',
        reason: verdict.reason,
        ...(verdict.rule === undefined ? {} : { rule: verdict.rule }),
      };
    }

    if (verdict.behavior === 'deny') {
      return {
        outcome: 'denied',
        decidedBy: 'rule',
        reason: verdict.reason,
        ...(verdict.rule === undefined ? {} : { rule: verdict.rule }),
      };
    }

    // The call needs a human.
    const key = `${approvalScope(subject)}|${approvalCallKey(subject)}`;
    const recorded = this.#denials.get(key);
    if (recorded !== undefined) {
      // The denial is final: it is not re-asked within the turn.
      return {
        outcome: 'denied',
        decidedBy: 'answer',
        reason: recorded.reason,
        answerer: recorded.answerer,
        requestId: recorded.requestId,
      };
    }

    const transport = this.#transport;
    if (transport === undefined) {
      return {
        outcome: 'refused',
        decidedBy: 'nobody',
        reason: `This ${subject.toolName} call needs a human decision, and this build has no way to ask for one.`,
      };
    }

    const capability = transport.capability();
    if (!capability.enabled) {
      return {
        outcome: 'refused',
        decidedBy: 'nobody',
        reason:
          capability.unsupported ??
          `Approvals cannot be asked for in this build, so this ${subject.toolName} call cannot be decided.`,
      };
    }

    const request = this.#buildRequest(subject, verdict);

    let answer: ApprovalAnswer;
    try {
      answer = await this.#ask(transport, request);
    } catch (error) {
      return {
        outcome: 'refused',
        decidedBy: 'nobody',
        reason: `The approval for this ${subject.toolName} call could not be asked for: ${messageOf(error)}`,
      };
    }

    if (answer.decision === 'deny') {
      const reason = `The approval for this ${subject.toolName} call was denied by ${answer.answerer}.`;
      this.#denials.set(key, {
        reason,
        answerer: answer.answerer,
        requestId: request.requestId,
      });
      return {
        outcome: 'denied',
        decidedBy: 'answer',
        reason,
        answerer: answer.answerer,
        requestId: request.requestId,
      };
    }

    const persistence = await this.#persist(subject, verdict);
    return {
      outcome: 'allowed',
      decidedBy: 'answer',
      reason: `The approval for this ${subject.toolName} call was allowed by ${answer.answerer}.`,
      answerer: answer.answerer,
      requestId: request.requestId,
      ...(persistence === undefined ? {} : { persistence }),
    };
  }

  /** The rules the gate decides with: the caller's rules and the persisted ones. */
  async #effectiveRules(): Promise<ApprovalRuleSet> {
    const store = this.#store;
    if (store === undefined) return this.#rules;
    return mergeApprovalRules(this.#rules, await store.read());
  }

  /** The request that carries the approval over the protocol. */
  #buildRequest(subject: ApprovalSubject, verdict: ApprovalRuleVerdict): ApprovalRequest {
    this.#counter += 1;
    return {
      requestId: `${this.#requestIdPrefix}_${this.#counter}`,
      tool: subject.toolName,
      call: subject.input,
      reason: verdict.reason,
      ...(subject.sessionId === undefined ? {} : { sessionId: subject.sessionId }),
      ...(subject.turnId === undefined ? {} : { turnId: subject.turnId }),
    };
  }

  /** Ask, and wait — but not forever. */
  async #ask(
    transport: ApprovalTransport,
    request: ApprovalRequest,
  ): Promise<ApprovalAnswer> {
    const asked = transport.ask(request);
    const timeoutMs = this.#timeoutMs;
    if (timeoutMs <= 0) return asked;

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        asked,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`nobody answered the approval within ${timeoutMs} ms`));
          }, timeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Keep the rules the human's approval produced, so that they decide next time. */
  async #persist(
    subject: ApprovalSubject,
    verdict: ApprovalRuleVerdict,
  ): Promise<ApprovalPersistence | undefined> {
    const store = this.#store;
    if (store === undefined) return undefined;

    const rules = persistedRulesFor(subject, verdict);
    if (rules.length === 0) {
      return {
        rules: [],
        refused: `This ${subject.toolName} call has no command and no path, so no approval rule can express it, and the approval could not be kept.`,
      };
    }

    try {
      await store.persist(rules);
      return { rules };
    } catch (error) {
      // The decision stands — the human allowed the call — and the failure to
      // keep the rule is reported rather than swallowed.
      return {
        rules: [],
        refused: `The approval rule could not be kept, so this ${subject.toolName} call will be asked about again: ${messageOf(error)}`,
      };
    }
  }
}

/**
 * The rules a human's approval is kept as.
 *
 * The first layer computes them — `persistentAllowRules` is the first layer's
 * own computation — and this layer anchors the path a rule names, so that the
 * rule matches the very call that was approved.
 */
function persistedRulesFor(
  subject: ApprovalSubject,
  verdict: ApprovalRuleVerdict,
): string[] {
  const tool = approvalToolContext(subject);
  const decision: PermissionDecision = {
    behavior: 'ask',
    source: 'unknown',
    reasonType: 'rule',
    reason: verdict.reason,
    ...(verdict.rule === undefined
      ? {}
      : { rule: { content: verdict.rule.content, source: verdict.rule.source } }),
    ...(verdict.unmatched === undefined
      ? {}
      : {
          subcommandResults: {
            commands: [...verdict.unmatched],
            count: verdict.unmatched.length,
            total: verdict.total ?? verdict.unmatched.length,
          },
        }),
  };

  const rules = persistentAllowRules(tool, decision);
  return rules.map((rule) => anchorPersistedRule(rule, subject));
}

/** The message of a thrown value. */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'the error carried no message';
}

/** Create a decision point. */
export function createApprovalGate(options: ApprovalGateOptions): ApprovalGate {
  return new ApprovalGate(options);
}

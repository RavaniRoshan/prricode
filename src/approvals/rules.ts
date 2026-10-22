/**
 * The approval rules — **the first layer's rule language over the second
 * layer's subject**.
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §7 — "Approvals are rules,
 * the way the first layer's permissions are — `allow`, `ask`, `deny` — so a
 * matching rule decides without asking, and a rule persists."
 *
 * **One responsibility:** the subject a rule matches, and the rule's verdict.
 * The asking lives in `src/approvals/decision.ts`, the transport in
 * `src/approvals/ask.ts` and the persistence in `src/approvals/store.ts`.
 *
 * ## The rules are the first layer's
 *
 * This module does **not** have a rule language of its own. The syntax, the
 * matching, the precedence and the path anchoring are the first layer's, and
 * they are **called**, not copied:
 *
 * - `evaluateListOutcome` (`src/permissions/rules.ts`) is the matcher. The
 *   lists are scanned `deny` → `ask` → `allow`, and the first rule **in a
 *   list** that matches is the rule that matched — the first layer's own
 *   precedence, which its own header records as the target's;
 * - `parseRule` and `extractToolPath` are the first layer's, so a rule's text
 *   is parsed the same way here and a tool's path is found the same way here.
 *
 * **The subject is the second layer's.** The first layer's subject is a tool
 * call; the second layer's is the same call **in the turn it belongs to** — so
 * the turn's **model** is part of the subject, and a rule may name it. The
 * model is presented as an **additional field** of the subject, and the call's
 * own fields always win: a tool that takes a `model` argument of its own is
 * not shadowed by the turn's model.
 *
 * The model's field is read with the first layer's own parameter rule form —
 * `Tool(param:value)` — so `Write(model:alpha)` is a rule of the first layer's
 * language and is matched by the first layer's matcher.
 *
 * ## What is an implementation choice
 *
 *   - **The unmatched case asks.** The first layer's `default` mode prompts
 *     when no rule matched; the approval layer has no modes, and the safe
 *     reading of "a matching rule decides without asking" is that a call no
 *     rule covers needs a human. The first layer's own `evaluateRules` returns
 *     nothing in that case, and the approval layer asks.
 *   - **A partially covered command asks.** An allow rule that covers only
 *     part of a compound command approves nothing, and the sub-commands it did
 *     not cover are named in the reason — the first layer's escalation, in the
 *     first layer's order.
 *   - **The reason text is ours.** The wording is the second layer's; the
 *     matching it reports is the first layer's.
 */

import path from 'node:path';

import type { ToolContext } from '../permissions/decision.js';
import {
  evaluateListOutcome,
  extractToolPath,
  parseRule,
  type RuleListOutcome,
  type RuleSet,
} from '../permissions/rules.js';

/**
 * The subject an approval rule matches.
 *
 * It is the first layer's subject — the tool and the call — **plus the turn the
 * call belongs to**. The turn's `model` is the one thing the second layer adds,
 * because the model layer (`CC-044`) is landed and a rule may name the model
 * a call runs against.
 */
export interface ApprovalSubject {
  /** The tool the call is for. */
  readonly toolName: string;
  /** The call's own arguments. */
  readonly input: unknown;
  /** The id of the call, when the caller has one. */
  readonly toolUseId?: string;
  /** The session the call belongs to. */
  readonly sessionId?: string;
  /** The turn the call belongs to. */
  readonly turnId?: string;
  /** The model the turn runs against. */
  readonly model?: string;
}

/**
 * The rules an approval reads.
 *
 * It is the **first layer's** rule set, reused as it is: the three lists, the
 * working directory, the settings directories and the per-rule attribution.
 * A rule written for the first layer's permissions is a rule here.
 */
export type ApprovalRuleSet = RuleSet;

/** A rule, and the place it came from. */
export interface ApprovalRuleRef {
  /** The rule's own text. */
  readonly content: string;
  /** Where the rule came from — the tier, or `persisted`. */
  readonly source: string;
}

/**
 * The field the turn's model is presented under.
 *
 * It is not one of the first layer's primary content fields, so a rule that
 * names it is a **parameter rule** and not a degraded one.
 */
export const APPROVAL_MODEL_FIELD = 'model';

/** The verdict a rule produces. */
export interface ApprovalRuleVerdict {
  /** What the rule says. */
  readonly behavior: 'allow' | 'deny' | 'ask';
  /** The rule that matched, when one did. */
  readonly rule?: ApprovalRuleRef;
  /** Why. */
  readonly reason: string;
  /** The parts of a command an allow rule did not cover. */
  readonly unmatched?: readonly string[];
  /** The number of parts the command was split into. */
  readonly total?: number;
}

/** Whether a value is a plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The subject, as the first layer's matcher sees it.
 *
 * The call's own arguments are the subject's input, and the turn's context is
 * **added** to them: the context never replaces a field of the call, so a tool
 * that takes a `model` argument of its own is not shadowed by the turn's
 * model.
 */
export function approvalToolContext(subject: ApprovalSubject): ToolContext {
  return {
    toolName: subject.toolName,
    input: subjectInput(subject),
    toolUseId: subject.toolUseId ?? '',
    sessionId: subject.sessionId ?? '',
  };
}

/** The subject's input, with the turn's context added to it. */
function subjectInput(subject: ApprovalSubject): unknown {
  const context: Record<string, unknown> = {};
  if (subject.model !== undefined) context[APPROVAL_MODEL_FIELD] = subject.model;
  if (!isPlainObject(subject.input)) return subject.input;
  // The call's own fields win: the context is additional, never a replacement.
  return { ...context, ...subject.input };
}

/** The options an approval rule set is built from. */
export interface ApprovalRuleOptions {
  /** The rules that approve a call without asking. */
  readonly allow?: readonly string[];
  /** The rules that always need a human. */
  readonly ask?: readonly string[];
  /** The rules that block a call. */
  readonly deny?: readonly string[];
  /** The working directory the path anchors resolve against. */
  readonly cwd?: string;
  /** Where the rules came from. */
  readonly source?: string;
  /** The per-rule attribution. */
  readonly ruleSources?: Readonly<Record<string, string>>;
  /** The directory the `/path` anchor resolves against. */
  readonly settingsDir?: string;
  /** The settings directory of each tier. */
  readonly settingsDirs?: Readonly<Record<string, string>>;
  /** The home directory the `~/path` anchor resolves against. */
  readonly homeDir?: string;
}

/**
 * Build a rule set.
 *
 * The lists are copied, so the caller's arrays are never held by the rule set
 * and a rule added to the caller's array afterwards does not appear in it.
 */
export function approvalRules(options: ApprovalRuleOptions = {}): ApprovalRuleSet {
  const ruleSources: Record<string, string> = {};
  if (options.ruleSources) {
    // `Object.entries` reads the own enumerable members only, and the copy is
    // made with a spread, so a rule text that names `__proto__` stays a data
    // property and never becomes a prototype.
    for (const [rule, source] of Object.entries(options.ruleSources)) {
      defineRuleSource(ruleSources, rule, source);
    }
  }
  return {
    allow: [...(options.allow ?? [])],
    ask: [...(options.ask ?? [])],
    deny: [...(options.deny ?? [])],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    source: options.source ?? 'settings',
    ruleSources,
    ...(options.settingsDir === undefined ? {} : { settingsDir: options.settingsDir }),
    ...(options.settingsDirs === undefined ? {} : { settingsDirs: { ...options.settingsDirs } }),
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
  };
}

/**
 * Define a rule's attribution as **data**.
 *
 * The rule text is caller-supplied data, so it is defined rather than assigned:
 * a rule text that names `__proto__` is an own data property of the map and
 * never a prototype.
 */
function defineRuleSource(
  map: Record<string, string>,
  rule: string,
  source: string,
): void {
  Object.defineProperty(map, rule, {
    value: source,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Merge the persisted rules into the rules the caller supplied.
 *
 * The caller's rules come **first** in every list, so the first rule in a list
 * that matches is still the rule that matched, and a persisted rule never
 * displaces a rule the user wrote.
 */
export function mergeApprovalRules(
  base: ApprovalRuleSet,
  persisted: ApprovalRuleSet,
): ApprovalRuleSet {
  const allow = [...base.allow];
  const ask = [...base.ask];
  const deny = [...base.deny];
  const ruleSources: Record<string, string> = {};
  for (const [rule, source] of Object.entries(base.ruleSources ?? {})) {
    defineRuleSource(ruleSources, rule, source);
  }

  const source = persisted.source ?? 'persisted';
  for (const [list, persistedList] of [
    [allow, persisted.allow],
    [ask, persisted.ask],
    [deny, persisted.deny],
  ] as const) {
    for (const rule of persistedList) {
      if (list.includes(rule)) continue;
      list.push(rule);
      if (!Object.hasOwn(ruleSources, rule)) defineRuleSource(ruleSources, rule, source);
    }
  }

  const cwd = base.cwd ?? persisted.cwd;
  return {
    ...base,
    allow,
    ask,
    deny,
    ruleSources,
    ...(cwd === undefined ? {} : { cwd }),
  };
}

/**
 * Evaluate the rules against a subject.
 *
 * The lists are scanned `deny` → `ask` → `allow` — the first layer's order,
 * which its own header records as the target's — and the **first rule in a
 * list** that matches is the rule that matched. A call no rule covers asks.
 */
export function evaluateApprovalRules(
  subject: ApprovalSubject,
  rules: ApprovalRuleSet,
): ApprovalRuleVerdict {
  const tool = approvalToolContext(subject);

  const denied = evaluateListOutcome(rules, rules.deny, 'deny', tool);
  if (denied.decision) return verdictOf(denied, subject);

  const asked = evaluateListOutcome(rules, rules.ask, 'ask', tool);
  if (asked.decision) return verdictOf(asked, subject);

  const allowed = evaluateListOutcome(rules, rules.allow, 'allow', tool);
  if (allowed.decision) return verdictOf(allowed, subject);

  if (allowed.unmatched.length > 0) {
    // An allow rule covered only part of the command, so it approves nothing:
    // the parts it did not cover are named.
    const rule = allowed.rule;
    const parts = allowed.unmatched.join(', ');
    const reason =
      rule === undefined
        ? `An approval rule covers ${allowed.unmatched.length} of ${allowed.total} parts of this command, and ${parts} needs a human decision.`
        : `Approval rule '${rule.content}' from ${rule.source} covers ${allowed.unmatched.length} of ${allowed.total} parts of this command, and ${parts} needs a human decision.`;
    return {
      behavior: 'ask',
      reason,
      ...(rule === undefined ? {} : { rule }),
      unmatched: [...allowed.unmatched],
      total: allowed.total,
    };
  }

  return {
    behavior: 'ask',
    reason: `No approval rule matched, so this ${subject.toolName} call needs a human decision.`,
  };
}

/**
 * The verdict of a rule that matched.
 *
 * The behaviour is the **decision's own**, not the list's: the first layer
 * degrades a deny rule that cannot be applied to the call — a rule that names
 * the tool's primary content field — to an **ask**, and the degradation
 * carries over. A rule that could not be applied protects nothing as a
 * denial, and it must not be reported as one.
 */
function verdictOf(outcome: RuleListOutcome, subject: ApprovalSubject): ApprovalRuleVerdict {
  const decision = outcome.decision;
  if (decision === undefined) {
    return {
      behavior: 'ask',
      reason: `This ${subject.toolName} call needs a human decision.`,
    };
  }
  const behavior = decision.behavior;
  const rule = decision.rule;
  return {
    behavior,
    reason: describeRuleVerdict(behavior, rule, subject.toolName),
    ...(rule === undefined ? {} : { rule }),
  };
}

/**
 * The reason a rule's verdict carries.
 *
 * The wording is the second layer's; the rule it names is the first layer's.
 */
function describeRuleVerdict(
  behavior: 'allow' | 'deny' | 'ask',
  rule: ApprovalRuleRef | undefined,
  toolName: string,
): string {
  if (rule === undefined) {
    return `This ${toolName} call needs a human decision.`;
  }
  const attribution = `Approval rule '${rule.content}' from ${rule.source}`;
  if (behavior === 'deny') return `${attribution} denies this ${toolName} call.`;
  if (behavior === 'allow') return `${attribution} allows this ${toolName} call.`;
  return `${attribution} needs a human decision for this ${toolName} call.`;
}

/**
 * The path a persisted rule names, anchored to the filesystem root.
 *
 * The first layer's `/path` anchor resolves against the **settings source**,
 * so a rule written from an absolute path would point somewhere else. The
 * `//path` anchor is the filesystem root, and it is the one that matches the
 * call that was approved. A relative path keeps the working-directory anchor,
 * and a home path keeps the `~` anchor.
 */
export function anchorPersistedRule(rule: string, subject: ApprovalSubject): string {
  const parsed = parseRule(rule);
  if (parsed.matcher === undefined) return rule;

  const tool = approvalToolContext(subject);
  const toolPath = extractToolPath(tool);
  if (toolPath === undefined || parsed.matcher !== toolPath) return rule;
  if (!path.isAbsolute(toolPath)) return rule;

  return `${parsed.toolName}(//${toolPath.replace(/^\/+/, '')})`;
}

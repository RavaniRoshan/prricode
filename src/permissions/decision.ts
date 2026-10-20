/**
 * The permission decision vocabulary, the mode semantics, the host-level gates
 * and the start-mode resolution.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.5 (Permissions) and the
 * `CC-007` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * The vocabularies are **closed** and are reproduced exactly:
 *
 *   - behavior: `allow` | `deny` | `ask`
 *   - source:   `classifier` | `hook` | `user_permanent` | `user_temporary` |
 *               `user_abort` | `user_reject` | `unknown`
 *   - reason type: `rule` | `safetyCheck` | `other`
 *
 * The **modes** are exactly six — `default` (UI label Manual, alias `manual`),
 * `acceptEdits`, `plan`, `auto`, `dontAsk` and `bypassPermissions` — and they behave
 * as the audit and the research describe them:
 *
 *   - a **deny** rule blocks in **every** mode, including `bypassPermissions`;
 *   - an **allow** rule has **no effect** in `bypassPermissions`;
 *   - `permissions.ask` beats `allow` and still prompts in `bypassPermissions`;
 *   - `dontAsk` **denies** anything that would prompt, and denies `AskUserQuestion`,
 *     MCP tools marked `requiresUserInteraction`, network-path reads and org-ask
 *     connector tools **even if allow-listed** — and it never consults the prompt;
 *   - `plan` never auto-approves a file edit, not even with a matching allow rule.
 *     "Auto-approves an edit" is a property of the **effect**, not of the tool
 *     name, so a `Bash` allow rule that covers `sed -i` does not auto-approve it
 *     either;
 *   - `acceptEdits` auto-approves Edit/Write plus `mkdir`, `touch`, `rm`, `rmdir`,
 *     `mv`, `cp` and `sed`, but only for paths inside the working directory or an
 *     added directory and only after a symlink check — and `rm` / `rmdir` on a
 *     **critical** path still prompts;
 *   - `auto` is a classifier review that **fails closed**: no verdict means deny.
 *
 * The `auto` review is **server-side by default** in current releases, with a local
 * model call as the fallback. This implementation never assumes a local model call: the
 * review is supplied by the caller as a callback, and **which** path the review uses
 * is not implemented in this module.
 *
 * The **start-mode precedence** is `--permission-mode` flag → `permissions.defaultMode`
 * → the built-in default. `auto` and `bypassPermissions` written into a settings
 * file are **ignored**. The built-in default is `auto` for an interactive terminal
 * session and `default` for a headless run, subject to three availability
 * overrides: `disableAutoMode: "disable"`, a HIPAA-configured session, and a session
 * where auto mode is unavailable.
 *
 * **The hooks run after the deny list.** A `PermissionRequest` hook may approve a
 * call and rewrite its input, but an approval never overrides a **deny** or an
 * **ask** rule — the research states it outright ("a hook returning `allow` does
 * not override a deny or ask rule"). The hook therefore runs *after* the deny list
 * has been evaluated, and an ask rule that matches takes precedence over the hook's
 * approval. A hook approval that carries `classifierApprovable: false` cannot be
 * laundered into an approval by the auto-mode review.
 *
 * **A hook approval replaces only the generic prompt.** The case where no rule
 * matched at all (`noRuleMatch`) is the one the hook's approval replaces; the
 * **escalation** of a compound command an allow rule covered only in part
 * (`subcommandResults`) stands, because the hook's approval must not approve the
 * sub-commands the allow rule did not cover.
 *
 * **The host-level gates** are the two the audit names: the
 * `CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG` restriction, which blocks every prompt and
 * tool call when the personal configuration has problems, and a hook failure of
 * severity `stop`, which denies every tool call.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - `interactive` and `hipaaConfigured` are optional members of the start-mode
 *     options. When `interactive` is not supplied this implementation assumes a **headless**
 *     session and starts in `default`: the conservative mode is the right default
 *     for a decision that can auto-approve tool calls.
 *   - A rule-produced decision carries the source `unknown`: the closed source
 *     vocabulary has no member for "the rule engine", and inventing one would break
 *     it.
 *   - The auto-mode classifier is supplied by the caller as a callback, because the
 *     review is server-side by default and this implementation must not assume a local model
 *     call.
 *   - In `auto` mode an explicit `permissions.ask` rule **still forces a prompt**:
 *     the classifier reviews the call, and a classifier approval does not turn the
 *     ask into an allow. The review may still *deny* the call outright.
 *   - A hook approval that the classifier may not approve (`classifierApprovable:
 *     false`) becomes an **ask** in `auto` mode rather than a denial: a person
 *     decides, and the classifier cannot decide for them.
 *   - The reason kinds are the audit's observed six plus `noRuleMatch`, a reimplementation
 *     addition so that the audit's `permissionPromptTool` ("a named tool requires
 *     approval for this command") keeps its observed meaning instead of also
 *     covering "no rule matched".
 *   - The "don't ask again" affordance **computes** the rules to persist and the
 *     five-rule cap, but **does not write them**: the write to
 *     `.claude/settings.local.json` is not implemented in this module.
 *   - The permission **rule lists** of **every** tier are **concatenated** in the
 *     tier order `policySettings`, `flagSettings`, `localSettings`,
 *     `projectSettings`, `userSettings`. The **order** of the three project-side
 *     tiers is the **observed** `MERGED_KEY_ORDER` (`localSettings`,
 *     `projectSettings`, `userSettings`); the two tiers that ordering does not
 *     name — the machine policy and the feature flags — are placed first, because
 *     a machine policy rule must win the first-match scan; that placement is a
 *     **implementation choice**, not an observed ordering. The **concatenation** itself is
 *     a **implementation choice** too: the observed "first source that defines the key
 *     wins" rule for a merged key would drop the rules of every lower tier, and
 *     concatenating is the fail-safe choice — a rule of any tier is in force.
 *   - `permissions.defaultMode` is a scalar under the **top-level** `permissions`
 *     key, so it is resolved through the **observed** `TOP_LEVEL_KEY_ORDER`
 *     (`policySettings`, `flagSettings`, `userSettings`). The project-side tiers
 *     are not part of that observed order, so they do not define a `defaultMode`.
 */

import path from 'node:path';

import {
  MERGED_KEY_ORDER,
  TOP_LEVEL_KEY_ORDER,
  documentOf,
  type SettingsSource,
} from '../config/tiers.js';
import type { SettingsLoadError, SettingsLoadResult } from '../config/loader.js';

import {
  FILE_MUTATING_TOOL_NAMES,
  collectRuleWarnings,
  evaluateListOutcome,
  evaluateRuleList,
  extractPrimaryValue,
  extractToolPath,
  isCriticalPath,
  isInsideDirectory,
  resolvePathTargets,
  shellSubCommandMutatesFiles,
  shellSubCommandParts,
  shellInvocation,
  shellSubCommands,
  type PathTargets,
  type RuleDecision,
  type RuleListOutcome,
  type RuleSet,
} from './rules.js';

/** The three behaviors a permission decision can carry. */
export type PermissionBehavior = 'allow' | 'deny' | 'ask';

/** Who produced a permission decision. */
export type PermissionSource =
  | 'classifier'
  | 'hook'
  | 'user_permanent'
  | 'user_temporary'
  | 'user_abort'
  | 'user_reject'
  | 'unknown';

/** The class of a permission decision's reason. */
export type PermissionReasonType = 'rule' | 'safetyCheck' | 'other';

/**
 * The reason kinds the audit records.
 *
 * `rule` names a matched rule and its tier; `subcommandResults` lists the offending
 * sub-commands of a compound command and counts the parts that need approval;
 * `permissionPromptTool` names a tool that requires approval; `sandboxOverride` is
 * "Run outside of the sandbox"; `workingDir` is the working directory; and
 * `safetyCheck` is a refusal that is independent of the rule engine.
 *
 * `noRuleMatch` is a **implementation addition**: it is the case where no rule matched at
 * all, which the audit's `permissionPromptTool` would otherwise have to cover.
 */
export type PermissionReasonKind =
  | 'rule'
  | 'subcommandResults'
  | 'permissionPromptTool'
  | 'sandboxOverride'
  | 'workingDir'
  | 'safetyCheck'
  | 'noRuleMatch';

/** The permission modes, including the `manual` alias of `default`. */
export type PermissionMode =
  | 'default'
  | 'manual'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'auto'
  | 'dontAsk';

/** A permission decision. */
export interface PermissionDecision {
  /** What happens to the call. */
  behavior: PermissionBehavior;
  /** Who produced the decision. */
  source: PermissionSource;
  /** The class of the reason. */
  reasonType: PermissionReasonType;
  /** The user-facing reason text. */
  reason?: string;
  /**
   * The rewritten tool input.
   *
   * Only the **hook** path sets this. A rule is a pure predicate and never
   * rewrites the input, so a rule decision leaves the member unset.
   */
  updatedInput?: unknown;
  /** The rule that matched, and the tier it came from. */
  rule?: { content: string; source: string };
  /** The specific reason kind, when it is known. */
  reasonKind?: PermissionReasonKind;
  /** The offending sub-commands of a compound command. */
  subcommandResults?: { commands: string[]; count: number; total: number };
  /** The rules that were ignored for this call. */
  warnings?: string[];
  /** The message shown to the user for an `ask`. */
  message?: string;
  /**
   * Whether a classifier may turn this decision into an approval.
   *
   * A `PermissionRequest` hook approval that carries `classifierApprovable: false`
   * sets this to `false`, so the auto-mode review cannot launder it into an
   * approval.
   */
  classifierApprovable?: boolean;
}

/** The context a permission check runs in. */
export interface ToolContext {
  toolName: string;
  input: unknown;
  toolUseId: string;
  sessionId: string;
}

/** The verdict an auto-mode review returns. */
export interface AutoModeVerdict {
  verdict: 'allow' | 'block';
  category?: string;
}

/** A host-level gate that blocks every prompt and tool call. */
export interface HostGate {
  /** Whether the gate blocks the call. */
  blocked: boolean;
  /** The reason shown to the user; it names the offending file paths. */
  reason: string;
  /** The offending file paths. */
  paths: string[];
}

/** A hook failure reported by the host. */
export interface HostHookFailure {
  /** The severity of the failure; `stop` blocks every tool call. */
  severity: string;
  /** The failure message. */
  message?: string;
}

/** The options a permission check runs with. */
export interface CheckPermissionOptions {
  /** The rule lists to evaluate. */
  rules: RuleSet;
  /** The active mode. */
  mode: PermissionMode;
  /**
   * A safety check, run **before** the rule engine and independent of it.
   *
   * A denial it returns holds in every mode, including `bypassPermissions`.
   */
  safetyCheck?: (ctx: ToolContext) => PermissionDecision | undefined;
  /**
   * The `PermissionRequest` hook, run **after** the deny list.
   *
   * The hook may deny the call, approve it, and rewrite the tool input. An
   * approval never overrides a deny rule or an ask rule, and never replaces the
   * escalation of a compound command an allow rule covered only in part; an
   * approval that carries `classifierApprovable: false` cannot be turned into an
   * approval by the auto-mode review.
   */
  hook?: (ctx: ToolContext) => PermissionDecision | undefined | Promise<PermissionDecision | undefined>;
  /**
   * The prompt. Only consulted for a decision that would prompt, and **never** in
   * `dontAsk`.
   */
  canUseTool?: (
    ctx: ToolContext,
    decision: PermissionDecision,
  ) => Promise<PermissionDecision | undefined>;
  /**
   * The auto-mode review. A missing verdict **denies**: the review fails closed.
   */
  classifier?: (ctx: ToolContext) => Promise<AutoModeVerdict | undefined>;
  /** The working directory, when it differs from the rule set's. */
  cwd?: string;
  /** Extra directories `acceptEdits` may write inside. */
  additionalDirs?: string[];
  /**
   * A host-level gate, e.g. the `CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG` restriction.
   *
   * A blocked gate denies every prompt and tool call.
   */
  hostGate?: HostGate;
  /**
   * A hook failure reported by the host.
   *
   * A failure of severity `stop` denies every tool call.
   */
  hookFailure?: HostHookFailure;
}

/** The options the start mode is resolved from. */
export interface StartModeOptions {
  /** The `--permission-mode` flag. */
  flag?: PermissionMode;
  /** `permissions.defaultMode` from the settings file. */
  settingsDefault?: PermissionMode;
  /** Whether auto mode is available for this session. */
  autoAvailable: boolean;
  /** Whether a policy disabled auto mode (`disableAutoMode: "disable"`). */
  autoDisabledByPolicy: boolean;
  /** Whether this is an interactive terminal session. Defaults to `false`. */
  interactive?: boolean;
  /** Whether this is a HIPAA-configured session. */
  hipaaConfigured?: boolean;
}

/** The commands `acceptEdits` may approve on its own. */
const ACCEPT_EDITS_COMMANDS: ReadonlySet<string> = new Set([
  'mkdir',
  'touch',
  'rm',
  'rmdir',
  'mv',
  'cp',
  'sed',
]);

/** The file-mutating tools. The set lives in the rule module: one source of truth. */
const FILE_MUTATING_TOOLS: ReadonlySet<string> = new Set(FILE_MUTATING_TOOL_NAMES);

/**
 * The environment variable that restricts personal configuration.
 *
 * When it is set, the personal configuration tiers have problems: every prompt and
 * every tool call is blocked, and the message names the offending file paths.
 */
export const RESTRICT_PERSONAL_CONFIG_ENV = 'CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG';

/**
 * The reason a hook failure of severity `stop` denies every tool call with.
 *
 * The wording is the audit's, verbatim.
 */
export const HOST_HOOK_FAILURE_REASON =
  'A problem with your own settings or hooks is blocking tool calls';

/**
 * The settings file the "don't ask again" rules are persisted to.
 *
 * The **write** is not implemented in this module; only the computation of the
 * rules and the cap are.
 */
export const PERSISTED_RULES_SETTINGS_PATH = '.claude/settings.local.json';

/** The maximum number of rules the "don't ask again" affordance persists. */
export const MAX_PERSISTED_RULES = 5;

/**
 * Resolve the `manual` alias.
 *
 * `manual` is the UI label of `default`; this implementation keeps it as an alias so a mode
 * that arrived from the UI behaves exactly like the mode it labels.
 */
export function normalizePermissionMode(mode: PermissionMode): Exclude<PermissionMode, 'manual'> {
  return mode === 'manual' ? 'default' : mode;
}

function attachWarnings<T extends PermissionDecision>(decision: T, warnings: string[]): T {
  if (warnings.length === 0) return decision;
  return { ...decision, warnings };
}

/**
 * The reason text of a decision.
 *
 * The reason kinds are the ones the audit records: `rule`,
 * `subcommandResults`, `permissionPromptTool`, `sandboxOverride`, `workingDir` and
 * `safetyCheck`, plus this implementation's `noRuleMatch`.
 */
export function describeReason(decision: PermissionDecision, toolName: string): string {
  const kind: PermissionReasonKind | 'other' =
    decision.reasonKind ??
    (decision.reasonType === 'rule'
      ? 'rule'
      : decision.reasonType === 'safetyCheck'
        ? 'safetyCheck'
        : 'other');

  switch (kind) {
    case 'rule':
      return describeRuleReason(decision, toolName);
    case 'subcommandResults':
      return describeSubcommandReason(decision, toolName);
    case 'permissionPromptTool':
      return decision.reason ?? `The ${toolName} tool requires approval for this command.`;
    case 'noRuleMatch':
      return decision.reason ?? `No permission rule matched, so this ${toolName} call requires approval.`;
    case 'sandboxOverride':
      return 'Run outside of the sandbox';
    case 'workingDir':
      return decision.reason ?? `This ${toolName} call is allowed because it stays inside the working directory.`;
    case 'safetyCheck':
      return decision.reason ?? `A safety check refused this ${toolName} call.`;
    default:
      return decision.reason ?? `This ${toolName} call requires approval.`;
  }
}

function describeRuleReason(decision: PermissionDecision, toolName: string): string {
  const rule = decision.rule;
  if (!rule) return decision.reason ?? `This ${toolName} call requires approval.`;
  const attribution = `Permission rule '${rule.content}' from ${rule.source}`;
  if (decision.behavior === 'deny') return `${attribution} denies this ${toolName} call.`;
  if (decision.behavior === 'allow') return `${attribution} allows this ${toolName} call.`;
  return `${attribution} requires approval for this ${toolName} command.`;
}

function describeSubcommandReason(decision: PermissionDecision, toolName: string): string {
  const subcommands = decision.subcommandResults;
  if (!subcommands) return decision.reason ?? `This ${toolName} call requires approval.`;
  const rule = decision.rule;
  const attribution = rule ? `Permission rule '${rule.content}' from ${rule.source}` : 'The command';
  const list = subcommands.commands.join(', ');
  if (decision.behavior === 'deny') {
    return `${attribution} denies ${subcommands.count} of ${subcommands.total} parts of this command: ${list}.`;
  }
  return `${attribution} requires approval for ${subcommands.count} of ${subcommands.total} parts of this command: ${list}.`;
}

/**
 * Attach the reason text to a decision.
 *
 * The reason belongs to the decision layer, so the rule module produces the
 * decision and this module renders it.
 */
function withReason<T extends PermissionDecision>(decision: T, toolName: string): T {
  if (decision.reason !== undefined) return decision;
  return { ...decision, reason: describeReason(decision, toolName) };
}

/**
 * Evaluate the rule lists against a tool call.
 *
 * The lists are scanned `deny` → `ask` → `allow`, and the first rule **in a list**
 * that matches is the rule that matched: specificity is irrelevant, and an allow
 * rule can never carve an exception out of a deny.
 *
 * Returns `undefined` when nothing matched, so the caller can escalate to a prompt.
 * The decision never carries a rewritten tool input — a rule is a pure predicate.
 */
export function evaluateRules(rules: RuleSet, tool: ToolContext): RuleDecision | undefined {
  for (const kind of ['deny', 'ask', 'allow'] as const) {
    const outcome = evaluateListOutcome(rules, rules[kind], kind, tool);
    if (outcome.decision) {
      return attachWarnings(withReason(outcome.decision, tool.toolName), collectRuleWarnings(rules, tool));
    }
  }
  return undefined;
}

function askDecision(
  toolName: string,
  reason?: string,
  reasonKind: PermissionReasonKind = 'noRuleMatch',
): PermissionDecision {
  const text = reason ?? `No permission rule matched, so this ${toolName} call requires approval.`;
  return {
    behavior: 'ask',
    source: 'unknown',
    reasonType: 'other',
    reasonKind,
    reason: text,
    message: text,
  };
}

/**
 * The escalation of a call an allow rule did not cover.
 *
 * When an allow rule covers only part of a compound command, the sub-commands it
 * does **not** cover are named, so the escalation is not the generic ask.
 */
function allowFailureEscalation(tool: ToolContext, outcome: RuleListOutcome): PermissionDecision {
  const decision: PermissionDecision = {
    behavior: 'ask',
    source: 'unknown',
    reasonType: 'rule',
    reasonKind: 'subcommandResults',
    subcommandResults: {
      commands: [...outcome.unmatched],
      count: outcome.unmatched.length,
      total: outcome.total,
    },
  };
  if (outcome.rule) decision.rule = outcome.rule;
  return withReason(decision, tool.toolName);
}

/** The hook's approval, as the mode layer sees it. */
interface HookApproval {
  /** The hook's decision. */
  decision: PermissionDecision;
  /** Whether an ask rule overrode the approval. */
  overridden: boolean;
}

/**
 * Check a tool call against the rules and the active mode.
 *
 * The order is: the host-level gates first (they block everything), then the
 * safety check (independent of the rule engine and holding in every mode), then
 * the deny list (a deny rule blocks in every mode), then the ask list, then the
 * `PermissionRequest` hook (an approval never overrides a deny or an ask rule),
 * and finally the mode's own semantics.
 */
export async function checkPermission(
  ctx: ToolContext,
  opts: CheckPermissionOptions,
): Promise<PermissionDecision> {
  const mode = normalizePermissionMode(opts.mode);
  const rules = opts.rules;
  const warnings = collectRuleWarnings(rules, ctx);

  // 0. The host-level gates block every prompt and every tool call.
  const gate = opts.hostGate;
  if (gate?.blocked) {
    return attachWarnings(
      { behavior: 'deny', source: 'unknown', reasonType: 'other', reason: gate.reason },
      warnings,
    );
  }
  const failure = opts.hookFailure;
  if (failure && failure.severity === 'stop') {
    return attachWarnings(
      { behavior: 'deny', source: 'hook', reasonType: 'other', reason: HOST_HOOK_FAILURE_REASON },
      warnings,
    );
  }

  // 1. The safety check is independent of the rule engine and holds in every mode.
  const safety = opts.safetyCheck?.(ctx);
  if (safety) return attachWarnings(safety, warnings);

  // 2. A deny rule blocks in every mode, including `bypassPermissions`.
  const denied = evaluateRuleList(rules, rules.deny, 'deny', ctx);
  if (denied) return attachWarnings(withReason(denied, ctx.toolName), warnings);

  // 3. The ask list. An ask rule beats a hook approval.
  const asked = evaluateRuleList(rules, rules.ask, 'ask', ctx);

  // 4. The hook runs **after** the deny list, so an approval can never override a
  //    deny rule, and an ask rule is never overridden by it either.
  let hookApproval: HookApproval | undefined;
  const hookDecision = opts.hook ? await opts.hook(ctx) : undefined;
  if (hookDecision) {
    if (hookDecision.behavior === 'deny') return attachWarnings(hookDecision, warnings);
    if (hookDecision.behavior === 'allow') {
      hookApproval = { decision: hookDecision, overridden: asked !== undefined };
    }
  }

  // 5. The mode's own semantics.
  const decision = applyHookApproval(
    await decideForMode(ctx, opts, mode, rules, asked, hookApproval),
    hookApproval,
  );

  // 6. The prompt is consulted for a decision that would prompt — never in
  //    `dontAsk`, which denies instead of asking.
  if (decision.behavior === 'ask' && mode !== 'dontAsk' && opts.canUseTool) {
    const resolved = await opts.canUseTool(ctx, decision);
    if (resolved) return attachWarnings(resolved, warnings);
  }

  return attachWarnings(withReason(decision, ctx.toolName), warnings);
}

/**
 * Apply a hook's approval to the decision the mode produced.
 *
 * An approval replaces a **generic** prompt — the case where no rule matched and
 * nothing else forced a prompt (`noRuleMatch`). It never replaces a denial, never
 * replaces a mode-level refusal (`permissionPromptTool`), never replaces the ask
 * of an ask rule, and never replaces the **escalation** of a partially covered
 * compound command (`subcommandResults`): the hook's approval must not approve
 * the sub-commands an allow rule did not cover.
 *
 * A hook that rewrote the input keeps its rewrite on every decision the call can
 * still end up with, because the rewritten input is what the tool receives.
 */
function applyHookApproval(
  decision: PermissionDecision,
  hookApproval: HookApproval | undefined,
): PermissionDecision {
  if (!hookApproval) return decision;
  const hook = hookApproval.decision;

  if (decision.behavior === 'allow') {
    return withHookInput(decision, hook);
  }
  if (decision.behavior === 'deny') return decision;

  // The call would prompt.
  if (decision.reasonKind === 'noRuleMatch' && !hookApproval.overridden) {
    // The **generic** prompt — the case where no rule matched — is the only one
    // the hook's approval replaces.
    return { ...hook, reason: hook.reason ?? 'A PermissionRequest hook approved this call.' };
  }
  // Everything else stands: the ask of an ask rule, the escalation of a partially
  // covered chain, a mode-level refusal and a degraded deny rule. The hook's
  // rewrite still rides along, because it is the input the tool would receive.
  return withHookInput(decision, hook);
}

/**
 * A decision with the hook's rewritten input attached.
 *
 * The rewrite is what the tool receives, so it rides along on every decision the
 * call can still end up with — the hook's approval may not replace the decision,
 * but the input it rewrote is still the input that would run.
 */
function withHookInput(decision: PermissionDecision, hook: PermissionDecision): PermissionDecision {
  if (hook.updatedInput === undefined) return decision;
  return { ...decision, updatedInput: hook.updatedInput };
}

async function decideForMode(
  ctx: ToolContext,
  opts: CheckPermissionOptions,
  mode: Exclude<PermissionMode, 'manual'>,
  rules: RuleSet,
  asked: RuleDecision | undefined,
  hookApproval: HookApproval | undefined,
): Promise<PermissionDecision> {
  switch (mode) {
    case 'bypassPermissions':
      return decideBypassPermissions(asked, hookApproval);
    case 'dontAsk':
      return decideDontAsk(ctx, rules, asked);
    case 'plan':
      return decidePlan(ctx, rules, asked);
    case 'acceptEdits':
      return decideAcceptEdits(ctx, opts, rules, asked);
    case 'auto':
      return decideAuto(ctx, opts, rules, asked, hookApproval);
    case 'default':
    default:
      return decideDefault(ctx, rules, asked);
  }
}

/**
 * `bypassPermissions`.
 *
 * A deny rule still blocks (handled before this function), an ask rule still
 * prompts, and an allow rule has **no effect** — it is not consulted at all.
 */
function decideBypassPermissions(
  asked: RuleDecision | undefined,
  hookApproval: HookApproval | undefined,
): PermissionDecision {
  if (asked) return asked;
  if (hookApproval && !hookApproval.overridden) {
    return { ...hookApproval.decision, reason: hookApproval.decision.reason ?? 'A PermissionRequest hook approved this call.' };
  }
  return {
    behavior: 'allow',
    source: 'unknown',
    reasonType: 'other',
    reason: 'Bypass permissions mode is active and no deny or ask rule matched.',
  };
}

/**
 * `dontAsk`.
 *
 * Anything that would prompt is **denied** rather than prompted, and the
 * always-denied categories are denied **even if an allow rule matches**.
 */
function decideDontAsk(
  ctx: ToolContext,
  rules: RuleSet,
  asked: RuleDecision | undefined,
): PermissionDecision {
  const refusal = dontAskRefusal(ctx);
  if (refusal) return refusal;

  if (asked) {
    const rule = asked.rule;
    return dontAskDenial(dontAskReason(rule), rule);
  }

  const allowed = evaluateListOutcome(rules, rules.allow, 'allow', ctx);
  if (allowed.decision) return allowed.decision;
  if (allowed.unmatched.length > 0) {
    // The allow rule did not cover every part of the command, so the call would
    // prompt — and `dontAsk` denies a prompt.
    const decision: PermissionDecision = {
      behavior: 'deny',
      source: 'unknown',
      reasonType: 'other',
      subcommandResults: {
        commands: [...allowed.unmatched],
        count: allowed.unmatched.length,
        total: allowed.total,
      },
      reason: `dontAsk mode is active: ${allowed.unmatched.length} of ${allowed.total} parts of this command need approval (${allowed.unmatched.join(', ')}), so the call is denied instead of prompted.`,
    };
    if (allowed.rule) decision.rule = allowed.rule;
    return decision;
  }

  return dontAskDenial(dontAskReason(undefined), undefined);
}

/**
 * A `dontAsk` denial.
 *
 * `dontAsk` **denies** anything that would prompt; it never asks. The rule that
 * matched is carried on the decision as context, but the denial itself is caused by
 * the mode, so the reason is the mode's.
 */
function dontAskDenial(
  reason: string,
  rule?: { content: string; source: string },
): PermissionDecision {
  const decision: PermissionDecision = {
    behavior: 'deny',
    source: 'unknown',
    reasonType: 'other',
    reason,
  };
  if (rule) decision.rule = rule;
  return decision;
}

function dontAskReason(rule?: { content: string; source: string }): string {
  if (rule) {
    return `dontAsk mode is active: permission rule '${rule.content}' from ${rule.source} would require approval, so the call is denied instead of prompted.`;
  }
  return 'dontAsk mode is active: this call would require approval, so it is denied instead of prompted.';
}

/**
 * The categories `dontAsk` denies even when an allow rule matches.
 *
 * The audit names `AskUserQuestion`, MCP tools marked `requiresUserInteraction` and
 * network-path reads. The org-ask connector tools are the connector MCP server's
 * asking tools; the audit does not name them, so this implementation recognises the
 * `connector` server segment of the tool name.
 */
function dontAskRefusal(ctx: ToolContext): PermissionDecision | undefined {
  if (ctx.toolName === 'AskUserQuestion') {
    return {
      behavior: 'deny',
      source: 'unknown',
      reasonType: 'other',
      reason: 'dontAsk mode is active, so AskUserQuestion is denied rather than asked.',
    };
  }
  if (isOrgAskConnectorTool(ctx.toolName) || requiresUserInteraction(ctx.input)) {
    return {
      behavior: 'deny',
      source: 'unknown',
      reasonType: 'other',
      reason: `dontAsk mode is active, so the interactive tool '${ctx.toolName}' is denied rather than asked.`,
    };
  }
  if (isNetworkPathRead(ctx)) {
    return {
      behavior: 'deny',
      source: 'unknown',
      reasonType: 'other',
      reason: 'dontAsk mode is active, so a read of a network path is denied rather than asked.',
    };
  }
  return undefined;
}

function isOrgAskConnectorTool(toolName: string): boolean {
  return toolName.startsWith('mcp__connector__');
}

function requiresUserInteraction(input: unknown): boolean {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  if (!Object.hasOwn(record, 'requiresUserInteraction')) return false;
  return record['requiresUserInteraction'] === true;
}

/** Whether a call reads from a network path. */
function isNetworkPathRead(ctx: ToolContext): boolean {
  if (!READ_TOOLS.has(ctx.toolName)) return false;
  const value = extractToolPath(ctx);
  if (value === undefined) return false;
  return isNetworkPath(value);
}

const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep', 'LS']);

function isNetworkPath(value: string): boolean {
  if (value.startsWith('//')) return true;
  if (value.startsWith('\\\\')) return true;
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value);
}

/**
 * `plan`.
 *
 * A file edit is **never** auto-approved, not even with a matching allow rule.
 * "Auto-approves an edit" is a property of the **effect**, so a `Bash` call whose
 * effect is a file write is refused as well.
 */
function decidePlan(
  ctx: ToolContext,
  rules: RuleSet,
  asked: RuleDecision | undefined,
): PermissionDecision {
  if (asked) return asked;

  if (mutatesFiles(ctx)) {
    return askDecision(
      ctx.toolName,
      `Plan mode never auto-approves a file edit, so this ${ctx.toolName} call requires approval.`,
      'permissionPromptTool',
    );
  }

  const allowed = evaluateListOutcome(rules, rules.allow, 'allow', ctx);
  if (allowed.decision) return allowed.decision;
  if (allowed.unmatched.length > 0) return allowFailureEscalation(ctx, allowed);
  return askDecision(ctx.toolName);
}

/**
 * Whether a call's **effect** is a file write.
 *
 * A file-mutating tool obviously is one; a shell call is one when one of its
 * sub-commands mutates a file, whether by its program or by a write redirection.
 */
function mutatesFiles(ctx: ToolContext): boolean {
  if (FILE_MUTATING_TOOLS.has(ctx.toolName)) return true;
  if (ctx.toolName !== 'Bash') return false;
  const command = extractPrimaryValue(ctx);
  if (command === undefined) return false;
  return shellSubCommandParts(command).some((part) => shellSubCommandMutatesFiles(part));
}

/**
 * `acceptEdits`.
 *
 * Edit/Write plus the safe shell commands are auto-approved, but only for paths
 * inside the working directory or an added directory and only after a symlink
 * check. `rm` and `rmdir` on a **critical** path still prompt.
 */
function decideAcceptEdits(
  ctx: ToolContext,
  opts: CheckPermissionOptions,
  rules: RuleSet,
  asked: RuleDecision | undefined,
): PermissionDecision {
  if (asked) return asked;

  const allowed = evaluateListOutcome(rules, rules.allow, 'allow', ctx);
  if (allowed.decision) return allowed.decision;

  // An allow rule that covers only part of the chain approves nothing, but the
  // mode's own auto-approval still applies. The escalation that names the
  // sub-commands is the fallback when the mode does not approve the call either.
  const approved = acceptEditsApproval(ctx, opts, rules);
  if (approved) return approved;

  if (allowed.unmatched.length > 0) return allowFailureEscalation(ctx, allowed);
  // No rule matched: the case is the **generic** prompt, the same one the
  // `default` mode produces, so the hook's approval replaces it here as well.
  return askDecision(ctx.toolName);
}

/**
 * The `acceptEdits` auto-approval of a call, when there is one.
 *
 * Edit/Write plus the safe shell commands are auto-approved, but only for paths
 * inside the working directory or an added directory and only after a symlink
 * check. `rm` and `rmdir` on a **critical** path still prompt.
 */
function acceptEditsApproval(
  ctx: ToolContext,
  opts: CheckPermissionOptions,
  rules: RuleSet,
): PermissionDecision | undefined {
  const directories = allowedDirectories(rules, opts);

  if (FILE_MUTATING_TOOLS.has(ctx.toolName)) {
    const toolPath = extractToolPath(ctx);
    if (toolPath === undefined) return undefined;
    const targets = resolvePathTargets(toolPath, { cwd: rules.cwd });
    const directory = matchingDirectory(targets, directories);
    if (!directory) return undefined;
    return workingDirectoryDecision(targets, directory);
  }

  if (ctx.toolName !== 'Bash') return undefined;

  const command = extractPrimaryValue(ctx);
  if (command === undefined) return undefined;
  const subCommands = shellSubCommands(command);
  if (subCommands.length === 0) return undefined;

  const wheres = new Set<string>();
  for (const subCommand of subCommands) {
    const invocation = shellInvocation(subCommand);
    if (!ACCEPT_EDITS_COMMANDS.has(invocation.program)) return undefined;

    const paths = invocation.args.filter((argument) => !argument.startsWith('-'));
    if (invocation.program === 'sed') paths.shift();
    if (paths.length === 0) return undefined;

    for (const candidate of paths) {
      const targets = resolvePathTargets(candidate, { cwd: rules.cwd });
      const directory = matchingDirectory(targets, directories);
      if (!directory) return undefined;
      if (
        (invocation.program === 'rm' || invocation.program === 'rmdir') &&
        isCriticalPath(targets.requested, rules)
      ) {
        return undefined;
      }
      wheres.add(describeDirectory(directory));
    }
  }
  return {
    behavior: 'allow',
    source: 'unknown',
    reasonType: 'other',
    reasonKind: 'workingDir',
    reason: `Every part of this command stays inside ${[...wheres].join(' and ')}.`,
  };
}

/** A directory `acceptEdits` may write inside. */
interface AllowedDirectory {
  /** The absolute path of the directory. */
  path: string;
  /** Whether it is the working directory or a directory the user added. */
  kind: 'workingDirectory' | 'additionalDirectory';
}

function allowedDirectories(rules: RuleSet, opts: CheckPermissionOptions): AllowedDirectory[] {
  const directories: AllowedDirectory[] = [
    {
      path: path.resolve(opts.cwd ?? rules.cwd ?? process.cwd()),
      kind: 'workingDirectory',
    },
  ];
  for (const extra of [...(rules.additionalDirs ?? []), ...(opts.additionalDirs ?? [])]) {
    directories.push({ path: path.resolve(extra), kind: 'additionalDirectory' });
  }
  return directories;
}

/**
 * The allowed directory a path lies in.
 *
 * Both the **requested** path and the **resolved** target must be inside it: that
 * is the symlink check, and it is what stops a symlink inside the working
 * directory from redirecting the write outside it.
 */
function matchingDirectory(
  targets: PathTargets,
  directories: AllowedDirectory[],
): AllowedDirectory | undefined {
  return directories.find(
    (directory) =>
      isInsideDirectory(targets.requested, directory.path) &&
      isInsideDirectory(targets.resolved, directory.path),
  );
}

/** How a directory is named in the reason of an `acceptEdits` approval. */
function describeDirectory(directory: AllowedDirectory): string {
  if (directory.kind === 'workingDirectory') return 'the working directory';
  return `the added directory '${directory.path}'`;
}

function workingDirectoryDecision(
  targets: PathTargets,
  directory: AllowedDirectory | undefined,
): PermissionDecision {
  const where =
    directory === undefined || directory.kind === 'workingDirectory'
      ? 'the working directory'
      : `the added directory '${directory.path}'`;
  return {
    behavior: 'allow',
    source: 'unknown',
    reasonType: 'other',
    reasonKind: 'workingDir',
    reason: `The path '${targets.requested}' resolves inside ${where}.`,
  };
}

/**
 * `auto`.
 *
 * The auto-mode review replaces the prompt, and it **fails closed**: a missing
 * verdict is a denial. An allow rule is still an allow — the user already approved
 * it — while a call that would prompt is sent to the review.
 *
 * An explicit `permissions.ask` rule still forces a prompt: the classifier may
 * deny the call outright, but it may not turn the ask into an allow. A hook
 * approval that the classifier may not approve cannot become an allow either.
 */
async function decideAuto(
  ctx: ToolContext,
  opts: CheckPermissionOptions,
  rules: RuleSet,
  asked: RuleDecision | undefined,
  hookApproval: HookApproval | undefined,
): Promise<PermissionDecision> {
  const allowed = evaluateListOutcome(rules, rules.allow, 'allow', ctx);
  if (allowed.decision) return allowed.decision;

  const verdict = await opts.classifier?.(ctx);

  if (!verdict) {
    const decision: PermissionDecision = {
      behavior: 'deny',
      source: 'classifier',
      reasonType: 'other',
      reason:
        'The auto-mode review returned no verdict, so the call is denied: the review fails closed.',
    };
    if (asked?.rule) decision.rule = asked.rule;
    return decision;
  }

  if (verdict.verdict === 'block') {
    const category = verdict.category ? ` (${verdict.category})` : '';
    const decision: PermissionDecision = {
      behavior: 'deny',
      source: 'classifier',
      reasonType: 'other',
      reason: `The auto-mode review blocked this call${category}.`,
    };
    if (asked?.rule) decision.rule = asked.rule;
    return decision;
  }

  // The classifier approved the call.
  if (hookApproval && hookApproval.decision.classifierApprovable === false) {
    // The approval cannot be laundered by the classifier, so a person decides.
    const decision: PermissionDecision = {
      behavior: 'ask',
      source: 'hook',
      reasonType: 'other',
      reasonKind: 'permissionPromptTool',
      reason:
        'The auto-mode review approved this call, but the hook approval cannot be approved by a classifier, so it requires approval.',
    };
    // The ask rule still speaks for the call: its attribution is not dropped by
    // the branch that refuses to let the classifier launder the approval.
    if (asked?.rule) decision.rule = asked.rule;
    if (hookApproval.decision.updatedInput !== undefined) {
      decision.updatedInput = hookApproval.decision.updatedInput;
    }
    return decision;
  }

  if (asked) {
    // An explicit ask rule still forces a prompt: the classifier does not turn an
    // ask into an allow.
    const decision: PermissionDecision = { ...asked };
    if (hookApproval?.decision.updatedInput !== undefined) {
      decision.updatedInput = hookApproval.decision.updatedInput;
    }
    return decision;
  }

  const decision: PermissionDecision = {
    behavior: 'allow',
    source: 'classifier',
    reasonType: 'other',
    reason: 'The auto-mode review approved this call.',
  };
  if (hookApproval?.decision.updatedInput !== undefined) {
    decision.updatedInput = hookApproval.decision.updatedInput;
  }
  return decision;
}

/** `default` (and its `manual` alias). */
function decideDefault(
  ctx: ToolContext,
  rules: RuleSet,
  asked: RuleDecision | undefined,
): PermissionDecision {
  if (asked) return asked;

  const allowed = evaluateListOutcome(rules, rules.allow, 'allow', ctx);
  if (allowed.decision) return allowed.decision;
  if (allowed.unmatched.length > 0) return allowFailureEscalation(ctx, allowed);

  return askDecision(ctx.toolName);
}

/**
 * Resolve the mode a session starts in.
 *
 * The flag beats `permissions.defaultMode`, which beats the built-in default.
 * `auto` and `bypassPermissions` written into a **settings file** are ignored: only
 * the flag may select them.
 */
export function resolveStartMode(opts: StartModeOptions): PermissionMode {
  if (opts.flag) return normalizePermissionMode(opts.flag);

  if (opts.settingsDefault) {
    const fromSettings = normalizePermissionMode(opts.settingsDefault);
    // `auto` and `bypassPermissions` are ignored when they come from a settings
    // file; only the flag may select them.
    if (fromSettings !== 'auto' && fromSettings !== 'bypassPermissions') return fromSettings;
  }

  if (
    opts.interactive === true &&
    opts.autoAvailable &&
    !opts.autoDisabledByPolicy &&
    opts.hipaaConfigured !== true
  ) {
    return 'auto';
  }

  return 'default';
}

/**
 * The rules the "don't ask again" affordance persists.
 *
 * One rule per sub-command that needs approval, **capped at five rules**. The
 * rules are returned for the caller to write; **this module does not write them**
 * — the write to `.claude/settings.local.json` is not implemented here.
 */
export function persistentAllowRules(
  tool: ToolContext,
  decision: PermissionDecision,
  opts: { cap?: number } = {},
): string[] {
  const cap = opts.cap ?? MAX_PERSISTED_RULES;
  if (cap <= 0) return [];

  const rules: string[] = [];
  const add = (rule: string): void => {
    if (rules.length >= cap) return;
    if (rules.includes(rule)) return;
    rules.push(rule);
  };

  if (tool.toolName === 'Bash') {
    const subCommands = decision.subcommandResults?.commands ?? [];
    for (const subCommand of subCommands) add(`Bash(${subCommand})`);
    if (subCommands.length === 0) {
      const command = extractPrimaryValue(tool);
      if (command !== undefined) {
        for (const part of shellSubCommands(command)) add(`Bash(${part})`);
      }
    }
    return rules;
  }

  const toolPath = extractToolPath(tool);
  if (toolPath !== undefined) add(`${tool.toolName}(${toolPath})`);
  return rules;
}

// --- the settings adapter --------------------------------------------------------

const PERMISSION_MODES: ReadonlySet<string> = new Set<PermissionMode>([
  'default',
  'manual',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'auto',
  'dontAsk',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The permissions a settings document contributes. */
export interface SettingsPermissions {
  /** The rule lists, with every tier's rules in them. */
  rules: RuleSet;
  /** `permissions.defaultMode`, when a settings file defines one. */
  defaultMode?: PermissionMode;
  /** The host-level gate, when the personal configuration blocks the session. */
  gate?: HostGate;
}

/**
 * The tiers the rule lists are collected from, highest first.
 *
 * The **observed** `MERGED_KEY_ORDER` is the per-key merge order for merged
 * settings (`localSettings`, `projectSettings`, `userSettings`), and the three
 * project-side tiers are collected in that order.
 *
 * `policySettings` and `flagSettings` are **not** named by that ordering: the
 * audit does not derive a per-key merge for them, so their placement here is a
 * **implementation choice**. They are listed first, because a machine policy rule must
 * win the first-match scan of a list. This implementation does not claim this ordering is
 * target-verified.
 */
const RULE_TIER_ORDER: readonly SettingsSource[] = [
  'policySettings',
  'flagSettings',
  ...MERGED_KEY_ORDER,
];

/**
 * The tiers `permissions.defaultMode` is resolved from, highest first.
 *
 * `permissions.defaultMode` is a scalar under the **top-level** `permissions`
 * key, so it is resolved through the **observed** `TOP_LEVEL_KEY_ORDER`
 * (`policySettings`, `flagSettings`, `userSettings`) — the order the settings
 * module applies to every other top-level key.
 *
 * The project-side tiers are **not** part of that observed order, so they do not
 * define a `defaultMode`: the same rule the settings module states for a
 * top-level key ("tiers outside `TOP_LEVEL_KEY_ORDER` never take part in a
 * top-level resolution"). A user-level `defaultMode` therefore beats a
 * project-level one, because the project-level one does not define the key.
 */
const DEFAULT_MODE_TIER_ORDER: readonly SettingsSource[] = [...TOP_LEVEL_KEY_ORDER];

/**
 * Build the rule lists from the loaded settings tiers.
 *
 * The rule lists of **every** tier are **concatenated** in the tier order
 * (`policySettings`, `flagSettings`, `localSettings`, `projectSettings`,
 * `userSettings`): a deny rule in the project settings blocks a call that the
 * user settings allow, and the precedence (`deny` → `ask` → `allow`) decides the
 * outcome. Each rule keeps the tier it came from, so a `!` negation only
 * cancels a rule from the **same** settings file.
 *
 * **The concatenation is a implementation choice.** The audit derives the *order* of the
 * project-side tiers (`MERGED_KEY_ORDER`) but not a per-key merge for the
 * permission lists, and the observed "first source that defines the key wins"
 * rule for a merged key would **drop** the rules of every lower tier — a rule a
 * user wrote could then be undone by a project settings file. Concatenating the
 * lists is the fail-safe choice: a rule of **any** tier is in force, and the
 * precedence decides the outcome. This implementation does not claim this is the target's
 * behaviour.
 *
 * `permissions.defaultMode` is taken from the highest tier of the **observed**
 * top-level order that defines one (`DEFAULT_MODE_TIER_ORDER`).
 * `auto` and `bypassPermissions` are **not** filtered here: `resolveStartMode`
 * ignores them when they come from a settings file.
 *
 * The **host-level gate** is computed here: with
 * `CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG` set, a personal configuration with
 * problems blocks every prompt and tool call, and the message names the offending
 * file paths.
 */
export function permissionsFromSettings(
  result: SettingsLoadResult,
  opts: { cwd?: string; configDir?: string; env?: NodeJS.ProcessEnv } = {},
): SettingsPermissions {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const configDir = path.resolve(opts.configDir ?? cwd);
  const env = opts.env ?? process.env;

  const allow: string[] = [];
  const deny: string[] = [];
  const ask: string[] = [];
  const additionalDirs: string[] = [];
  const ruleSources: Record<string, string> = {};
  const settingsDirs: Record<string, string> = {
    userSettings: configDir,
    policySettings: configDir,
    projectSettings: path.join(cwd, '.claude'),
    localSettings: path.join(cwd, '.claude'),
  };
  let defaultMode: PermissionMode | undefined;

  for (const source of RULE_TIER_ORDER) {
    const tier = result.tiers.get(source);
    if (!tier) continue;
    const document = documentOf(tier.value);
    if (!isPlainObject(document)) continue;
    const permissions = document['permissions'];
    if (!isPlainObject(permissions)) continue;

    for (const [list, target] of [
      ['allow', allow],
      ['deny', deny],
      ['ask', ask],
    ] as const) {
      const entries = permissions[list];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (typeof entry !== 'string' || entry.length === 0) continue;
        if (target.includes(entry)) continue;
        target.push(entry);
        // The same rule text in two tiers keeps the **highest** tier, so the `/path`
        // anchor of a rule resolves against one settings source.
        if (!Object.hasOwn(ruleSources, entry)) ruleSources[entry] = source;
      }
    }

    // `permissions.additionalDirectories` are the directories `acceptEdits` may
    // write inside, beside the working directory.
    const directories = permissions['additionalDirectories'];
    if (Array.isArray(directories)) {
      for (const directory of directories) {
        if (typeof directory !== 'string' || directory.length === 0) continue;
        if (additionalDirs.includes(directory)) continue;
        additionalDirs.push(directory);
      }
    }
  }

  for (const source of DEFAULT_MODE_TIER_ORDER) {
    if (defaultMode !== undefined) break;
    const tier = result.tiers.get(source);
    if (!tier) continue;
    const document = documentOf(tier.value);
    if (!isPlainObject(document)) continue;
    const permissions = document['permissions'];
    if (!isPlainObject(permissions)) continue;
    const mode = permissions['defaultMode'];
    if (typeof mode === 'string' && PERMISSION_MODES.has(mode)) {
      defaultMode = mode as PermissionMode;
    }
  }

  const rules: RuleSet = {
    allow,
    deny,
    ask,
    cwd,
    source: 'settings',
    ruleSources,
    settingsDirs,
    additionalDirs,
  };

  const gate = personalConfigGate(result, { env });
  if (defaultMode === undefined) return gate ? { rules, gate } : { rules };
  return gate ? { rules, defaultMode, gate } : { rules, defaultMode };
}

/**
 * The settings tiers that belong to the **personal** configuration.
 *
 * The machine policy and the feature flags are not personal configuration, so a
 * problem in them does not block the session through this gate.
 */
const PERSONAL_TIERS: ReadonlySet<SettingsSource> = new Set<SettingsSource>([
  'userSettings',
  'projectSettings',
  'localSettings',
]);

/**
 * Whether the personal configuration is restricted.
 *
 * The environment variable is the transport the target uses; any value other than
 * an empty string, `0` and `false` restricts the personal configuration.
 */
export function isPersonalConfigRestricted(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[RESTRICT_PERSONAL_CONFIG_ENV];
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === '' || normalized === '0' || normalized === 'false') return false;
  return true;
}

/**
 * The host-level gate of a settings load result.
 *
 * With `CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG` set, a personal configuration with
 * problems blocks **every** prompt and tool call, and the message is built from the
 * offending file paths.
 *
 * The restriction has a second effect that belongs to the **loader**: the
 * project-side tiers are suppressed when the settings are read
 * (`loadSettings`'s `restricted` option). This gate is the audit's other effect —
 * the block on every prompt and tool call — and it is computed from the load
 * result the caller already has.
 */
export function personalConfigGate(
  result: SettingsLoadResult,
  opts: { env?: NodeJS.ProcessEnv } = {},
): HostGate | undefined {
  const env = opts.env ?? process.env;
  if (!isPersonalConfigRestricted(env)) return undefined;

  const offending = offendingPersonalErrors(result);
  if (offending.length === 0) return undefined;

  const paths = [...new Set(offending.map((error) => error.path))];
  const detail = offending.map((error) => `${error.path} (${error.message})`).join('; ');
  return {
    blocked: true,
    reason: `Your personal configuration has problems, so every prompt and tool call is blocked: ${detail}.`,
    paths,
  };
}

/**
 * The load errors of the personal configuration that block the session.
 *
 * A file that could not be read, was not valid JSON or failed validation is an
 * `error`. A personal tier that is **linked away** — the project settings file is
 * a link to the user settings file — is a warning, and it blocks as well: the
 * restriction exists precisely to keep such a file from steering the session.
 */
function offendingPersonalErrors(result: SettingsLoadResult): SettingsLoadError[] {
  const linkedAway = new Set(result.linkedAway);
  const offending: SettingsLoadError[] = [];
  for (const error of result.errors) {
    if (!PERSONAL_TIERS.has(error.source)) continue;
    if (error.severity === 'error' || linkedAway.has(error.source)) offending.push(error);
  }
  return offending;
}

// Re-exported so that a caller only ever needs the decision module for the
// vocabulary and the checks, and the rule module for the rules themselves.
export { collectRuleWarnings };
export type { RuleDecision, RuleSet };

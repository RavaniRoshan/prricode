/**
 * The permission decision vocabulary, the mode semantics, and the start-mode
 * resolution.
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
 *   - `plan` never auto-approves a file edit, not even with a matching allow rule;
 *   - `acceptEdits` auto-approves Edit/Write plus `mkdir`, `touch`, `rm`, `rmdir`,
 *     `mv`, `cp` and `sed`, but only for paths inside the working directory or an
 *     added directory and only after a symlink check — and `rm` / `rmdir` on a
 *     **critical** path still prompts;
 *   - `auto` is a classifier review that **fails closed**: no verdict means deny.
 *
 * The `auto` review is **server-side by default** in current releases, with a local
 * model call as the fallback; the local model is selected by
 * `CLAUDE_CODE_AUTO_MODE_MODEL` and server-side review is disabled with
 * `CLAUDE_CODE_AUTO_MODE_SERVER=0`. This implementation therefore never assumes a local
 * classifier call, and `resolveAutoModeReview` reports which path is available.
 *
 * The **start-mode precedence** is `--permission-mode` flag → `permissions.defaultMode`
 * → the built-in default. `auto` and `bypassPermissions` written into a settings
 * file are **ignored**. The built-in default is `auto` for an interactive terminal
 * session and `default` for a headless run, subject to three availability
 * overrides: `disableAutoMode: "disable"`, a HIPAA-configured session, and a session
 * where auto mode is unavailable.
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
 */

import path from 'node:path';

import { TIER_PRECEDENCE, documentOf, type SettingsSource } from '../config/tiers.js';
import type { SettingsLoadResult } from '../config/loader.js';

import {
  collectRuleWarnings,
  evaluateRuleList,
  extractPrimaryValue,
  extractToolPath,
  isCriticalPath,
  isInsideDirectory,
  resolvePathTargets,
  shellInvocation,
  shellSubCommands,
  type PathTargets,
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
 */
export type PermissionReasonKind =
  | 'rule'
  | 'subcommandResults'
  | 'permissionPromptTool'
  | 'sandboxOverride'
  | 'workingDir'
  | 'safetyCheck';

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

/** The tools that mutate a file. */
const FILE_MUTATING_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'NotebookEdit']);

/** The environment variable that selects the local auto-mode model. */
export const AUTO_MODE_MODEL_ENV = 'CLAUDE_CODE_AUTO_MODE_MODEL';

/** The environment variable that disables the server-side auto-mode review. */
export const AUTO_MODE_SERVER_ENV = 'CLAUDE_CODE_AUTO_MODE_SERVER';

/**
 * Resolve the `manual` alias.
 *
 * `manual` is the UI label of `default`; this implementation keeps it as an alias so a mode
 * that arrived from the UI behaves exactly like the mode it labels.
 */
export function normalizePermissionMode(mode: PermissionMode): Exclude<PermissionMode, 'manual'> {
  return mode === 'manual' ? 'default' : mode;
}

function attachWarnings(decision: PermissionDecision, warnings: string[]): PermissionDecision {
  if (warnings.length === 0) return decision;
  return { ...decision, warnings };
}

function askDecision(rule?: { content: string; source: string }, reason?: string): PermissionDecision {
  const text =
    reason ??
    (rule
      ? `Permission rule '${rule.content}' from ${rule.source} requires approval for this call.`
      : 'This call requires approval.');
  const decision: PermissionDecision = {
    behavior: 'ask',
    source: 'unknown',
    reasonType: rule ? 'rule' : 'other',
    reasonKind: rule ? 'rule' : 'permissionPromptTool',
    reason: text,
    message: text,
  };
  if (rule) decision.rule = rule;
  return decision;
}

/**
 * Check a tool call against the rules and the active mode.
 *
 * The order is: the safety check first (it is independent of the rule engine and
 * holds in every mode), then the deny list (a deny rule blocks in every mode),
 * then the mode's own semantics.
 */
export async function checkPermission(
  ctx: ToolContext,
  opts: CheckPermissionOptions,
): Promise<PermissionDecision> {
  const mode = normalizePermissionMode(opts.mode);
  const rules = opts.rules;
  const warnings = collectRuleWarnings(rules, ctx);

  // 1. The safety check is independent of the rule engine and holds in every mode.
  const safety = opts.safetyCheck?.(ctx);
  if (safety) return attachWarnings(safety, warnings);

  // 2. A deny rule blocks in every mode, including `bypassPermissions`.
  const denied = evaluateRuleList(rules, rules.deny, 'deny', ctx);
  if (denied) return attachWarnings(denied, warnings);

  const decision = await decideForMode(ctx, opts, mode, rules);

  // 3. The prompt is consulted for a decision that would prompt — never in
  //    `dontAsk`, which denies instead of asking.
  if (decision.behavior === 'ask' && mode !== 'dontAsk' && opts.canUseTool) {
    const resolved = await opts.canUseTool(ctx, decision);
    if (resolved) return attachWarnings(resolved, warnings);
  }

  return attachWarnings(decision, warnings);
}

async function decideForMode(
  ctx: ToolContext,
  opts: CheckPermissionOptions,
  mode: Exclude<PermissionMode, 'manual'>,
  rules: RuleSet,
): Promise<PermissionDecision> {
  switch (mode) {
    case 'bypassPermissions':
      return decideBypassPermissions(ctx, rules);
    case 'dontAsk':
      return decideDontAsk(ctx, rules);
    case 'plan':
      return decidePlan(ctx, rules);
    case 'acceptEdits':
      return decideAcceptEdits(ctx, opts, rules);
    case 'auto':
      return decideAuto(ctx, opts, rules);
    case 'default':
    default:
      return decideDefault(ctx, rules);
  }
}

/**
 * `bypassPermissions`.
 *
 * A deny rule still blocks (handled before this function), an ask rule still
 * prompts, and an allow rule has **no effect** — it is not consulted at all.
 */
function decideBypassPermissions(ctx: ToolContext, rules: RuleSet): PermissionDecision {
  const asked = evaluateRuleList(rules, rules.ask, 'ask', ctx);
  if (asked) return asked;
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
function decideDontAsk(ctx: ToolContext, rules: RuleSet): PermissionDecision {
  const refusal = dontAskRefusal(ctx);
  if (refusal) return refusal;

  const asked = evaluateRuleList(rules, rules.ask, 'ask', ctx);
  if (asked) {
    const rule = asked.rule;
    return dontAskDenial(dontAskReason(rule), rule);
  }

  const allowed = evaluateRuleList(rules, rules.allow, 'allow', ctx);
  if (allowed) return allowed;

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
 */
function decidePlan(ctx: ToolContext, rules: RuleSet): PermissionDecision {
  const asked = evaluateRuleList(rules, rules.ask, 'ask', ctx);
  if (asked) return asked;

  if (FILE_MUTATING_TOOLS.has(ctx.toolName)) {
    return askDecision(
      undefined,
      `Plan mode never auto-approves a file edit, so this ${ctx.toolName} call requires approval.`,
    );
  }

  const allowed = evaluateRuleList(rules, rules.allow, 'allow', ctx);
  if (allowed) return allowed;
  return askDecision(undefined);
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
): PermissionDecision {
  const asked = evaluateRuleList(rules, rules.ask, 'ask', ctx);
  if (asked) return asked;

  const allowed = evaluateRuleList(rules, rules.allow, 'allow', ctx);
  if (allowed) return allowed;

  const directories = allowedDirectories(rules, opts);

  if (FILE_MUTATING_TOOLS.has(ctx.toolName)) {
    const toolPath = extractToolPath(ctx);
    if (toolPath === undefined) return askDecision(undefined);
    const targets = resolvePathTargets(toolPath, { cwd: rules.cwd });
    if (!isAllowedTarget(targets, directories)) return askDecision(undefined);
    return workingDirectoryDecision(ctx, targets);
  }

  if (ctx.toolName === 'Bash') {
    const command = extractPrimaryValue(ctx);
    if (command === undefined) return askDecision(undefined);
    const subCommands = shellSubCommands(command);
    if (subCommands.length === 0) return askDecision(undefined);

    for (const subCommand of subCommands) {
      const invocation = shellInvocation(subCommand);
      if (!ACCEPT_EDITS_COMMANDS.has(invocation.program)) return askDecision(undefined);

      const paths = invocation.args.filter((argument) => !argument.startsWith('-'));
      if (invocation.program === 'sed') paths.shift();
      if (paths.length === 0) return askDecision(undefined);

      for (const candidate of paths) {
        const targets = resolvePathTargets(candidate, { cwd: rules.cwd });
        if (!isAllowedTarget(targets, directories)) return askDecision(undefined);
        if (
          (invocation.program === 'rm' || invocation.program === 'rmdir') &&
          isCriticalPath(targets.requested, rules)
        ) {
          return askDecision(
            undefined,
            `The critical path '${targets.requested}' is not auto-approved in acceptEdits mode.`,
          );
        }
      }
    }
    return {
      behavior: 'allow',
      source: 'unknown',
      reasonType: 'other',
      reasonKind: 'workingDir',
      reason: 'Every part of this command stays inside the working directory.',
    };
  }

  return askDecision(undefined);
}

function workingDirectoryDecision(ctx: ToolContext, targets: PathTargets): PermissionDecision {
  return {
    behavior: 'allow',
    source: 'unknown',
    reasonType: 'other',
    reasonKind: 'workingDir',
    reason: `The path '${targets.requested}' resolves inside the working directory.`,
  };
}

function allowedDirectories(rules: RuleSet, opts: CheckPermissionOptions): string[] {
  const directories = [path.resolve(opts.cwd ?? rules.cwd ?? process.cwd())];
  for (const extra of [...(rules.additionalDirs ?? []), ...(opts.additionalDirs ?? [])]) {
    directories.push(path.resolve(extra));
  }
  return directories;
}

/**
 * Whether a path may be written in `acceptEdits` mode.
 *
 * Both the **requested** path and the **resolved** target must be inside an allowed
 * directory: that is the symlink check, and it is what stops a symlink inside the
 * working directory from redirecting the write outside it.
 */
function isAllowedTarget(targets: PathTargets, directories: string[]): boolean {
  return directories.some(
    (directory) =>
      isInsideDirectory(targets.requested, directory) && isInsideDirectory(targets.resolved, directory),
  );
}

/**
 * `auto`.
 *
 * The auto-mode review replaces the prompt, and it **fails closed**: a missing
 * verdict is a denial. An allow rule is still an allow — the user already approved
 * it — while a call that would prompt (including one an ask rule matched) is sent
 * to the review.
 */
async function decideAuto(
  ctx: ToolContext,
  opts: CheckPermissionOptions,
  rules: RuleSet,
): Promise<PermissionDecision> {
  const allowed = evaluateRuleList(rules, rules.allow, 'allow', ctx);
  if (allowed) return allowed;

  const asked = evaluateRuleList(rules, rules.ask, 'ask', ctx);
  const verdict = await opts.classifier?.(ctx);

  if (!verdict) {
    return {
      behavior: 'deny',
      source: 'classifier',
      reasonType: 'other',
      reason:
        'The auto-mode review returned no verdict, so the call is denied: the review fails closed.',
      rule: asked?.rule,
    };
  }

  if (verdict.verdict === 'allow') {
    return {
      behavior: 'allow',
      source: 'classifier',
      reasonType: 'other',
      reason: 'The auto-mode review approved this call.',
    };
  }

  const category = verdict.category ? ` (${verdict.category})` : '';
  return {
    behavior: 'deny',
    source: 'classifier',
    reasonType: 'other',
    reason: `The auto-mode review blocked this call${category}.`,
    rule: asked?.rule,
  };
}

/** `default` (and its `manual` alias). */
function decideDefault(ctx: ToolContext, rules: RuleSet): PermissionDecision {
  const asked = evaluateRuleList(rules, rules.ask, 'ask', ctx);
  if (asked) return asked;

  const allowed = evaluateRuleList(rules, rules.allow, 'allow', ctx);
  if (allowed) return allowed;

  return askDecision(undefined);
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

/** How the auto-mode review is reached. */
export interface AutoModeReviewPlan {
  /** Which path the review uses. */
  kind: 'server' | 'local' | 'unavailable';
  /** The local model, when the local path is selected. */
  model?: string;
  /** Whether the server-side review is enabled. */
  serverSide: boolean;
}

/**
 * How the auto-mode review is reached in this environment.
 *
 * The review is **server-side by default**; the local model call is the fallback.
 * `CLAUDE_CODE_AUTO_MODE_SERVER=0` disables the server-side review, and
 * `CLAUDE_CODE_AUTO_MODE_MODEL` selects the local model.
 */
export function resolveAutoModeReview(
  env: NodeJS.ProcessEnv = process.env,
): AutoModeReviewPlan {
  const serverEnabled = env[AUTO_MODE_SERVER_ENV] !== '0';
  if (serverEnabled) return { kind: 'server', serverSide: true };

  const model = env[AUTO_MODE_MODEL_ENV];
  if (typeof model === 'string' && model.length > 0) {
    return { kind: 'local', model, serverSide: false };
  }
  return { kind: 'unavailable', serverSide: false };
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
}

/**
 * Build the rule lists from the loaded settings tiers.
 *
 * The rule lists of **every** tier are combined: a deny rule in the project
 * settings blocks a call that the user settings allow, and the precedence
 * (`deny` → `ask` → `allow`) decides the outcome. Each rule keeps the tier it came
 * from, so a `!` negation only cancels a rule from the **same** settings file.
 *
 * `permissions.defaultMode` is taken from the highest tier that defines one.
 * `auto` and `bypassPermissions` are **not** filtered here: `resolveStartMode`
 * ignores them when they come from a settings file.
 */
export function permissionsFromSettings(
  result: SettingsLoadResult,
  opts: { cwd?: string; configDir?: string } = {},
): SettingsPermissions {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const configDir = path.resolve(opts.configDir ?? cwd);

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

  for (const source of TIER_PRECEDENCE) {
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

    if (defaultMode === undefined) {
      const mode = permissions['defaultMode'];
      if (typeof mode === 'string' && PERMISSION_MODES.has(mode)) {
        defaultMode = mode as PermissionMode;
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
  return defaultMode === undefined ? { rules } : { rules, defaultMode };
}

// Re-exported so that a caller only ever needs the decision module for the
// vocabulary and the checks, and the rule module for the rules themselves.
export {
  collectRuleWarnings,
  describeReason,
  evaluateRules,
  type RuleSet,
} from './rules.js';

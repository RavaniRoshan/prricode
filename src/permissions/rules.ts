/**
 * The permission rule engine.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.5 (Permissions) and
 * `research/reference-agent-2.1.303-research.md` §5 (Permission models and known
 * security failures).
 *
 * **One responsibility:** the rule syntax and the rule matching — how a rule is
 * parsed, and which call it matches. The shell lexing lives in
 * `src/permissions/shell.ts` and the path anchoring in `src/permissions/paths.ts`;
 * the reason text lives in `src/permissions/decision.ts`, with the decision
 * layer. The public surface of this module is re-exported from those two
 * modules, so an importer of `rules.js` sees the same names it saw before.
 *
 * **A rule is a pure predicate.** It answers "allow", "deny" or "ask", and it names
 * the rule and the tier it came from. It never rewrites the tool input: a rule that
 * silently changed what runs is exactly the defect this design avoids, so the
 * rewrite path lives in the hook layer (`src/permissions/prompts.ts`) and routes its
 * `updatedInput` through the same `PermissionDecision.updatedInput` field.
 *
 * **Precedence** is `deny` → `ask` → `allow`, **first match wins, and specificity is
 * irrelevant**: a broad deny beats a narrower allow, and an allow rule can never
 * carve an exception out of a deny. The lists are scanned in order, so the first
 * rule *in the list* that matches is the rule that matched — never a more specific
 * one that happens to appear later.
 *
 * **Compound commands** are split on `&&`, `||`, `;`, `|`, `|&`, `&` and newlines, and
 * every sub-command is matched independently. There is **no sub-command cap**: the
 * target had a 50-sub-command cap that silently skipped every deny check and
 * degraded to a generic, auto-approvable ask, and this implementation does not reproduce it.
 * A deny or ask rule fires when **any** sub-command matches; an allow rule approves
 * only when **every** sub-command matches. When an allow rule covers only part of a
 * chain, the sub-commands it does **not** cover are carried forward, so the
 * escalation names them instead of degrading to a generic ask.
 *
 * **Quoted text is never stripped.** The target once had a validator that removed
 * single-quoted text before checking, so a payload inside quotes passed. This implementation
 * keeps the quoted text in the sub-command it matches, and only treats an operator
 * inside quotes as a literal character.
 *
 * **Bash rules match command text, not program identity.** `Bash(curl *)` does not
 * stop `/usr/bin/curl` or `sh -c 'curl …'`; the target's own documentation calls
 * these rules "not a security boundary around the program". This implementation does not claim
 * otherwise, and nothing in the safety-check path may assume the rule engine saw the
 * program.
 *
 * **Path rules** use four anchors: `//path` (filesystem root), `~/path` (home),
 * `/path` (**relative to the settings source**, not the filesystem root) and
 * `path` / `./path` (the working directory). A deny or ask pattern that names a
 * single segment matches that segment at any depth **below its anchor**; an allow
 * pattern matches only at the anchored depth.
 *
 * **Symlink semantics are asymmetric**: an allow rule requires **both** the
 * requested path and the resolved target to match, while a deny rule fires if
 * **either** matches. The path must also be **re-resolved after the check** — a
 * resolution taken before the check is a point-in-time fact, and this implementation exposes
 * `reResolvePath` so the write path never trusts it. `reResolvePath` is a **seam
 * that is not yet enforced**: the tool runner (`CC-008`) owns the write and must
 * call it; nothing in this module calls it on a write path.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The decision `source` of a rule-produced decision is `unknown`. The target's
 *     source vocabulary (`classifier`, `hook`, `user_permanent`, `user_temporary`,
 *     `user_abort`, `user_reject`, `unknown`) has no member for "the rule engine",
 *     and inventing one would break the closed vocabulary.
 *   - A `!`-negated rule cancels a matching rule **in the same list and from the
 *     same tier**. The research says a negation works "only within the same
 *     settings file"; this implementation is **narrower**, because a tier is not a file: a
 *     rule and a negation that came from two different files of the same tier do
 *     not cancel each other. Narrower is fail-safe, and the per-list boundary is
 *     pinned by a test.
 *   - `Tool(param:value)` is recognised as a *parameter* rule only when the prefix is
 *     an identifier and the value does not start with `/` (so `Edit(C:/x)` stays a
 *     path). A parameter rule that names the tool's primary content field
 *     (`command`, `file_path`, `path`, `url`) **cannot be applied to that field**.
 *     A **deny** rule in that position is **degraded to an ask** rather than
 *     dropped, and a warning is produced: a deny rule that silently does not apply
 *     protects nothing. **This degradation is not pinned by the plan, the audit or
 *     research §5** — the plan does not state the sentence it was read from — so it
 *     is recorded here as a implementation choice, and the warning says what happened.
 *   - Glob semantics: in a *command* pattern `*` matches any characters; in a *path*
 *     pattern `*` matches within one path segment and `**` crosses segments.
 *   - Redirect targets are matched against the path rules as file operations: a
 *     write redirect (`>`, `>>`, `&>`) is checked as a write, a read redirect (`<`)
 *     as a read. The target of a redirection is never lost: a target glued to the
 *     operator (`>/etc/passwd`) is the same target as a separated one
 *     (`> /etc/passwd`).
 */

import type { PermissionDecision, ToolContext } from './decision.js';
import {
  commandGlobMatch,
  pathPatternMatches,
  resolvePathTargets,
  type PathContext,
  type PathMatchKind,
} from './paths.js';
import { shellSubCommandParts, shellSubCommands } from './shell.js';

/**
 * The rule lists a settings document exposes.
 *
 * `allow`, `deny` and `ask` are the three lists the target names (audit §2.5,
 * "Rule sources"). The remaining members are optional context the evaluator needs
 * and that the settings loader can supply; a caller that omits them gets the
 * conservative defaults (the process working directory, the home directory and the
 * tier name `settings`).
 */
export interface RuleSet extends PathContext {
  /** Rules that approve a call without asking. */
  allow: string[];
  /** Rules that block a call in every mode. */
  deny: string[];
  /** Rules that always prompt. */
  ask: string[];
  /** The tier these rules came from, e.g. `userSettings`. */
  source?: string;
  /** Per-rule tier attribution, keyed by the rule text. */
  ruleSources?: Record<string, string>;
  /** Extra directories the user added; `acceptEdits` may write inside them. */
  additionalDirs?: string[];
}

/**
 * The decision a **rule** produces.
 *
 * The `updatedInput` member is typed `never` so that the rule engine cannot carry a
 * rewritten tool input, even by accident. The hook path uses `PermissionDecision`'s
 * own optional `updatedInput`.
 */
export type RuleDecision = PermissionDecision & { updatedInput?: never };

/** The three rule lists, in the order the target scans them. */
export type RuleListKind = PathMatchKind;

/** The primary content fields the target names. */
export const PRIMARY_CONTENT_FIELDS: readonly string[] = ['command', 'file_path', 'path', 'url'];

/**
 * The file-mutating tool set, exactly as the target names it.
 *
 * This is the **single source of truth** for the set: the mode layer, the redirect
 * matcher and the plan-mode effect check all read it from here.
 */
export const FILE_MUTATING_TOOL_NAMES: readonly string[] = ['Edit', 'Write', 'NotebookEdit'];

const PRIMARY_FIELDS_BY_TOOL: Readonly<Record<string, readonly string[]>> = {
  Bash: ['command'],
  Edit: ['file_path'],
  Write: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path', 'file_path'],
  NotebookRead: ['notebook_path', 'file_path'],
  Read: ['file_path'],
  Glob: ['path'],
  Grep: ['path'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  Cd: ['path'],
  Skill: ['skill'],
  TaskStop: ['task_id', 'shell_id'],
  GetTask: ['taskId'],
  ListMcpResourcesTool: ['server'],
  ReadMcpResourceTool: ['uri'],
  ReadMcpResourceDirTool: ['uri'],
  LSP: ['filePath'],
  memory_read: ['path'],
  memory_write: ['path'],
};

const PATH_FIELDS_BY_TOOL: Readonly<Record<string, readonly string[]>> = {
  Edit: ['file_path'],
  Write: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path', 'file_path'],
  NotebookRead: ['notebook_path', 'file_path'],
  Read: ['file_path'],
  Glob: ['path'],
  Grep: ['path'],
  Cd: ['path'],
  LSP: ['filePath'],
  memory_read: ['path'],
  memory_write: ['path'],
};

const DEFAULT_PATH_FIELDS: readonly string[] = ['file_path', 'notebook_path', 'path'];

/**
 * The rule groups the target uses.
 *
 * The target's own rule validation says that a `MultiEdit(path)` rule "is not
 * matched by file permission checks — only `Edit(path)` rules are", because the
 * `Edit` rules cover every file-editing tool
 * (`chunk-c9s0jh80.js:236134`, read out of the pinned build). This
 * implementation therefore matches an `Edit` rule against a `MultiEdit` call.
 *
 * **The group is additive and narrow.** It adds the `MultiEdit` case the target
 * names and nothing else: the `Read` group — which covers `Grep` and `Glob` —
 * is **not** widened here, because the read tools already apply the `Read(...)`
 * rules to their results (the read deny filter), and widening the rule match
 * would change what an `allow` rule approves.
 */
const RULE_GROUPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Edit: ['MultiEdit'],
});

/**
 * Whether a rule that names one tool governs a call to another.
 *
 * The tool names are caller-supplied data, so the lookup is an **own-property**
 * check.
 */
function ruleCoversTool(ruleToolName: string, toolName: string): boolean {
  if (ruleToolName === toolName) return true;
  if (!Object.hasOwn(RULE_GROUPS, ruleToolName)) return false;
  const group = RULE_GROUPS[ruleToolName];
  return group !== undefined && group.includes(toolName);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readInputField(input: unknown, field: string): unknown {
  if (!isPlainObject(input)) return undefined;
  if (!Object.hasOwn(input, field)) return undefined;
  return input[field];
}

/**
 * The primary content fields of a tool.
 *
 * The lookup is an **own-property** check: the tool name is caller-supplied data,
 * so a tool named `constructor` or `toString` must not resolve to an inherited
 * member of the table.
 */
export function primaryFieldsFor(toolName: string): readonly string[] {
  if (Object.hasOwn(PRIMARY_FIELDS_BY_TOOL, toolName)) {
    return PRIMARY_FIELDS_BY_TOOL[toolName] ?? PRIMARY_CONTENT_FIELDS;
  }
  return PRIMARY_CONTENT_FIELDS;
}

function pathFieldsFor(toolName: string): readonly string[] {
  if (Object.hasOwn(PATH_FIELDS_BY_TOOL, toolName)) {
    return PATH_FIELDS_BY_TOOL[toolName] ?? DEFAULT_PATH_FIELDS;
  }
  return DEFAULT_PATH_FIELDS;
}

/** The path a tool operates on, when it has one. */
export function extractToolPath(tool: ToolContext): string | undefined {
  for (const field of pathFieldsFor(tool.toolName)) {
    const value = readInputField(tool.input, field);
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** The tool's primary content value, when it is a string. */
export function extractPrimaryValue(tool: ToolContext): string | undefined {
  for (const field of primaryFieldsFor(tool.toolName)) {
    const value = readInputField(tool.input, field);
    if (typeof value === 'string') return value;
  }
  return undefined;
}

// --- rule parsing --------------------------------------------------------------

interface ParsedRule {
  raw: string;
  negated: boolean;
  toolName: string;
  /** The scoped matcher of a `Tool(matcher)` rule. */
  matcher: string | undefined;
  /** The parameter name of a `Tool(param:value)` rule. */
  param: string | undefined;
  /** The parameter value of a `Tool(param:value)` rule. */
  value: string | undefined;
  /** Whether the rule could not be parsed. */
  malformed: boolean;
}

/**
 * Parse a rule.
 *
 * The forms are `Tool`, `Tool(matcher)` and `Tool(param:value)`. A leading `!`
 * marks a negation.
 */
export function parseRule(raw: string): ParsedRule {
  const trimmed = raw.trim();
  let body = trimmed;
  let negated = false;
  if (body.startsWith('!')) {
    negated = true;
    body = body.slice(1).trim();
  }

  const open = body.indexOf('(');
  if (open === -1) {
    return {
      raw,
      negated,
      toolName: body,
      matcher: undefined,
      param: undefined,
      value: undefined,
      malformed: body.length === 0,
    };
  }

  if (!body.endsWith(')')) {
    return {
      raw,
      negated,
      toolName: body.slice(0, open).trim(),
      matcher: undefined,
      param: undefined,
      value: undefined,
      malformed: true,
    };
  }

  const toolName = body.slice(0, open).trim();
  const matcher = body.slice(open + 1, -1);
  const parameter = splitParameterRule(matcher);
  return {
    raw,
    negated,
    toolName,
    matcher: parameter === undefined ? matcher : undefined,
    param: parameter?.param,
    value: parameter?.value,
    malformed: toolName.length === 0,
  };
}

/**
 * Recognise the `Tool(param:value)` form.
 *
 * The prefix must be an identifier and the value must not start with `/`, so a
 * Windows-style `Edit(C:/src)` stays a path pattern.
 */
function splitParameterRule(matcher: string): { param: string; value: string } | undefined {
  const separator = matcher.indexOf(':');
  if (separator <= 0) return undefined;
  const param = matcher.slice(0, separator);
  const value = matcher.slice(separator + 1);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(param)) return undefined;
  if (value.length === 0) return undefined;
  if (value.startsWith('/')) return undefined;
  return { param, value };
}

/** The tier a rule came from. */
export function ruleSourceOf(rules: RuleSet, raw: string): string {
  const map = rules.ruleSources;
  if (map && Object.hasOwn(map, raw)) {
    const value = map[raw];
    if (typeof value === 'string') return value;
  }
  return rules.source ?? 'settings';
}

// --- rule matching -------------------------------------------------------------

interface MatchResult {
  matched: boolean;
  /** The sub-commands or paths that caused the match. */
  offending: string[];
  /** The number of sub-commands the command was split into. */
  total: number;
}

const NO_MATCH: MatchResult = { matched: false, offending: [], total: 0 };

interface MatchContext {
  rules: RuleSet;
  tool: ToolContext;
  kind: RuleListKind;
}

/** The result of evaluating one rule list. */
export interface RuleListOutcome {
  /** The decision of the first rule in the list that matched, when one matched. */
  decision: RuleDecision | undefined;
  /**
   * The sub-commands an allow rule did **not** cover.
   *
   * The first allow rule of the list is the one reported: the lists are scanned in
   * order and the first rule is the rule that spoke for the list.
   */
  unmatched: string[];
  /** The number of sub-commands the command was split into. */
  total: number;
  /** The rule whose sub-commands were not covered. */
  rule: { content: string; source: string } | undefined;
}

function matchRule(parsed: ParsedRule, context: MatchContext): MatchResult {
  const { tool } = context;
  if (parsed.malformed) return NO_MATCH;

  const sameTool = ruleCoversTool(parsed.toolName, tool.toolName);

  // The parameter form `Tool(param:value)`.
  if (parsed.param !== undefined) {
    if (!sameTool) return NO_MATCH;
    // A parameter rule that names the tool's primary content field cannot be
    // applied to that field: the rule cannot match. `collectRuleWarnings` reports
    // the rule to the user, and a deny rule in that position is degraded to an ask
    // rather than dropped.
    const primary = primaryFieldsFor(tool.toolName);
    if (primary.includes(parsed.param)) return NO_MATCH;
    const value = readInputField(tool.input, parsed.param);
    if (typeof value !== 'string') return NO_MATCH;
    return commandGlobMatch(parsed.value ?? '', value)
      ? { matched: true, offending: [value], total: 1 }
      : NO_MATCH;
  }

  if (tool.toolName === 'Bash') {
    // A shell call is matched by the Bash rules, and by the path rules of the file
    // tools for its **redirection targets**: a redirect is a file operation, so a
    // write redirect is checked against the Edit rules and a read redirect against
    // the Read rules.
    if (sameTool) return matchCommandRule(parsed, context);
    return matchRedirectTargetRule(parsed, context);
  }

  if (!sameTool) return NO_MATCH;

  if (parsed.matcher === undefined) {
    // A bare tool name matches every call of that tool.
    return { matched: true, offending: [], total: 1 };
  }

  const toolPath = extractToolPath(tool);
  if (toolPath !== undefined) {
    return matchPathRule(
      parsed.matcher,
      toolPath,
      context,
      ruleSourceOf(context.rules, parsed.raw),
    );
  }

  const primary = extractPrimaryValue(tool);
  if (primary !== undefined) {
    return commandGlobMatch(parsed.matcher, primary)
      ? { matched: true, offending: [primary], total: 1 }
      : NO_MATCH;
  }
  return NO_MATCH;
}

/** The tools whose rules describe a write to a file. */
const REDIRECT_WRITE_TOOLS: ReadonlySet<string> = new Set(FILE_MUTATING_TOOL_NAMES);

/** The tools whose rules describe a read of a file. */
const REDIRECT_READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep']);

/**
 * Match a rule against the **redirection targets** of a shell command.
 *
 * A redirect is a file operation: a write redirect (`>`, `>>`, `&>`) is checked
 * against the Edit/Write rules, and a read redirect (`<`) against the Read rules.
 * Only a scoped path rule of such a tool applies; a bare tool rule means "every
 * call of that tool", not "every file write".
 */
function matchRedirectTargetRule(parsed: ParsedRule, context: MatchContext): MatchResult {
  const { tool, kind } = context;
  if (parsed.matcher === undefined) return NO_MATCH;

  const writes = REDIRECT_WRITE_TOOLS.has(parsed.toolName);
  const reads = REDIRECT_READ_TOOLS.has(parsed.toolName);
  if (!writes && !reads) return NO_MATCH;

  const command = extractPrimaryValue(tool);
  if (command === undefined) return NO_MATCH;

  const redirects = shellSubCommandParts(command)
    .flatMap((part) => part.redirects)
    .filter((redirect) => redirect.target !== undefined && redirect.writes === writes);
  if (redirects.length === 0) return NO_MATCH;

  const matchedTargets: string[] = [];
  const blockedTargets: string[] = [];
  const source = ruleSourceOf(context.rules, parsed.raw);
  for (const redirect of redirects) {
    const target = redirect.target;
    if (target === undefined) continue;
    const match = matchPathRule(parsed.matcher, target, context, source);
    if (match.matched) matchedTargets.push(target);
    else blockedTargets.push(target);
  }

  if (kind === 'allow') {
    // An allow rule approves the redirects only when **every** target matches.
    if (matchedTargets.length !== redirects.length) {
      return { matched: false, offending: blockedTargets, total: redirects.length };
    }
    return { matched: true, offending: [], total: redirects.length };
  }
  // A deny or ask rule fires when **any** target matches.
  if (matchedTargets.length === 0) {
    return { matched: false, offending: [], total: redirects.length };
  }
  return { matched: true, offending: matchedTargets, total: redirects.length };
}

function matchCommandRule(parsed: ParsedRule, context: MatchContext): MatchResult {
  const command = extractPrimaryValue(context.tool);
  if (command === undefined) return NO_MATCH;
  const pattern = parsed.matcher;
  if (pattern === undefined) {
    // A bare `Bash` rule matches every shell call.
    return { matched: true, offending: [], total: 1 };
  }
  const subCommands = shellSubCommands(command);
  if (subCommands.length === 0) return NO_MATCH;

  const matching = subCommands.filter((subCommand) => commandGlobMatch(pattern, subCommand));
  if (context.kind === 'allow') {
    // An allow rule approves the chain only when **every** sub-command matches.
    const blocking = subCommands.filter((subCommand) => !commandGlobMatch(pattern, subCommand));
    return {
      matched: blocking.length === 0,
      offending: blocking,
      total: subCommands.length,
    };
  }
  // A deny or ask rule fires when **any** sub-command matches.
  return {
    matched: matching.length > 0,
    offending: matching,
    total: subCommands.length,
  };
}

function matchPathRule(
  pattern: string,
  toolPath: string,
  context: MatchContext,
  source?: string,
): MatchResult {
  const { rules, kind } = context;
  const targets = resolvePathTargets(toolPath, { cwd: rules.cwd });
  const requestedMatches = pathPatternMatches(pattern, targets.requested, rules, kind, source);
  const resolvedMatches = pathPatternMatches(pattern, targets.resolved, rules, kind, source);

  if (kind === 'allow') {
    // An allow rule requires **both** the requested path and the resolved target to
    // match: a symlink out of the allowed area must not inherit the allowance.
    const matched = requestedMatches && resolvedMatches;
    return {
      matched,
      offending: matched ? [] : [targets.requested, targets.resolved],
      total: 2,
    };
  }
  // A deny rule fires when **either** matches.
  const matched = requestedMatches || resolvedMatches;
  return {
    matched,
    offending: matched ? [requestedMatches ? targets.requested : targets.resolved] : [],
    total: 2,
  };
}

// --- the evaluator -------------------------------------------------------------

/**
 * Evaluate one rule list.
 *
 * The exported form is the building block the mode layer uses: the deny list is
 * evaluated on its own, before the mode is taken into account, because a deny rule
 * blocks in **every** mode.
 *
 * A **deny** rule that cannot be applied to the call — a `Tool(param:value)` rule
 * that names the tool's primary content field — is degraded to an **ask** rather
 * than dropped: a deny rule that silently does not apply protects nothing.
 */
export function evaluateListOutcome(
  rules: RuleSet,
  list: readonly string[],
  kind: RuleListKind,
  tool: ToolContext,
): RuleListOutcome {
  const context: MatchContext = { rules, tool, kind };
  const negations = list.filter((entry) => parseRule(entry).negated);

  let degraded: RuleDecision | undefined;
  let unmatched: string[] = [];
  let total = 0;
  let partialRule: { content: string; source: string } | undefined;

  for (const entry of list) {
    const parsed = parseRule(entry);
    if (parsed.negated) continue;
    if (parsed.malformed) continue;

    if (parsed.param !== undefined && isPrimaryContentRule(parsed, tool)) {
      if (kind === 'deny' && degraded === undefined) degraded = degradedDenyDecision(parsed, rules);
      continue;
    }

    const match = matchRule(parsed, context);
    if (!match.matched) {
      if (kind === 'allow' && match.offending.length > 0 && unmatched.length === 0) {
        unmatched = [...match.offending];
        total = match.total;
        partialRule = { content: parsed.raw, source: ruleSourceOf(rules, parsed.raw) };
      }
      continue;
    }

    if (isCancelledByNegation(parsed, negations, context)) continue;

    return {
      decision: buildDecision(kind, parsed, match, rules, tool),
      unmatched: [],
      total: match.total,
      rule: undefined,
    };
  }

  return { decision: degraded, unmatched, total, rule: partialRule };
}

/**
 * The decision view of {@link evaluateListOutcome}.
 *
 * The mode layer uses the outcome form when it needs the sub-commands an allow
 * rule did not cover; this form is the decision alone.
 */
export function evaluateRuleList(
  rules: RuleSet,
  list: readonly string[],
  kind: RuleListKind,
  tool: ToolContext,
): RuleDecision | undefined {
  return evaluateListOutcome(rules, list, kind, tool).decision;
}

/**
 * Whether a parameter rule names the tool's primary content field.
 *
 * A rule in that position cannot be applied to the field it names.
 */
function isPrimaryContentRule(parsed: ParsedRule, tool: ToolContext): boolean {
  if (parsed.param === undefined) return false;
  if (!ruleCoversTool(parsed.toolName, tool.toolName)) return false;
  return primaryFieldsFor(tool.toolName).includes(parsed.param);
}

/**
 * The decision a **deny** rule that cannot be applied is degraded to.
 *
 * The rule still speaks for the call, so the decision names it and asks for
 * approval instead of silently letting the call through.
 */
function degradedDenyDecision(parsed: ParsedRule, rules: RuleSet): RuleDecision {
  const source = ruleSourceOf(rules, parsed.raw);
  const field = parsed.param ?? '';
  return {
    behavior: 'ask',
    source: 'unknown',
    reasonType: 'rule',
    reasonKind: 'rule',
    rule: { content: parsed.raw, source },
    reason: `Permission rule '${parsed.raw}' from ${source} could not be applied to '${field}', the primary content field of ${parsed.toolName}, so it was degraded to an approval request.`,
  };
}

/**
 * Whether a matching rule is cancelled by a negation.
 *
 * A negation only cancels a rule from the **same tier**, because a negation written
 * in one settings file must not cancel a rule the user wrote in another one.
 */
function isCancelledByNegation(
  parsed: ParsedRule,
  negations: readonly string[],
  context: MatchContext,
): boolean {
  const ruleSource = ruleSourceOf(context.rules, parsed.raw);
  for (const negation of negations) {
    const negated = parseRule(negation);
    if (!negated.negated) continue;
    if (ruleSourceOf(context.rules, negated.raw) !== ruleSource) continue;
    if (matchRule(negated, context).matched) return true;
  }
  return false;
}

function buildDecision(
  kind: RuleListKind,
  parsed: ParsedRule,
  match: MatchResult,
  rules: RuleSet,
  tool: ToolContext,
): RuleDecision {
  const behavior = kind === 'deny' ? 'deny' : kind === 'ask' ? 'ask' : 'allow';
  const decision: RuleDecision = {
    behavior,
    source: 'unknown',
    reasonType: 'rule',
    reasonKind: 'rule',
    rule: { content: parsed.raw, source: ruleSourceOf(rules, parsed.raw) },
  };

  // A compound command names the offending sub-commands and counts the parts that
  // need approval; a single operation is reported as the rule that matched, but it
  // still carries the stripped sub-command it matched.
  if (tool.toolName === 'Bash' && match.offending.length > 0) {
    decision.subcommandResults = {
      commands: match.offending,
      count: match.offending.length,
      total: match.total,
    };
    if (match.total > 1 && (behavior === 'ask' || behavior === 'deny')) {
      decision.reasonKind = 'subcommandResults';
    }
  }

  return decision;
}

/**
 * The warnings a tool call produces: the rules that were ignored.
 *
 * A rule that names the tool's primary content field through the `param:value` form
 * cannot be applied to that field, so it is ignored — and the user is warned,
 * because an ignored **deny** rule protects nothing. A malformed rule is ignored for
 * the same reason.
 */
export function collectRuleWarnings(rules: RuleSet, tool: ToolContext): string[] {
  const warnings: string[] = [];
  const primary = primaryFieldsFor(tool.toolName);

  for (const [kind, list] of [
    ['deny', rules.deny],
    ['ask', rules.ask],
    ['allow', rules.allow],
  ] as const) {
    for (const entry of list) {
      const parsed = parseRule(entry);
      if (parsed.negated) continue;
      if (parsed.malformed) {
        warnings.push(`Permission rule '${entry}' is malformed and was ignored.`);
        continue;
      }
      if (parsed.param === undefined) continue;
      if (!ruleCoversTool(parsed.toolName, tool.toolName)) continue;
      if (!primary.includes(parsed.param)) continue;
      warnings.push(
        kind === 'deny'
          ? `Permission rule '${entry}' could not be applied: '${parsed.param}' is the primary content field of ${tool.toolName}, so the rule was degraded to an approval request. Write a ${tool.toolName}(<pattern>) rule instead.`
          : `Permission rule '${entry}' is ignored: '${parsed.param}' is the primary content field of ${tool.toolName}, so a ${tool.toolName}(<pattern>) rule is required instead.`,
      );
    }
  }
  return warnings;
}

// The shell and path surfaces are re-exported so that an importer of `rules.js`
// keeps seeing the names it saw before the split.
export * from './shell.js';
export * from './paths.js';

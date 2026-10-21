/**
 * The target's own **git and GitHub rule templates**: the ready-made permission rules
 * the target offers, and the "certified" command prefixes it uses for the commands it
 * runs itself.
 *
 * Evidence: `chunk-4jsg44k7.js:1676004` (the seven command templates), `:1676156` (how
 * they become rules), `:1675915` (the tool names the flow needs), `:1738787` (the
 * read-only git list), `:788097` (the certified prefixes), `:787667` (what "certified"
 * means), and `chunk-swcca8bf.js:3896` (the shell conversion). The record is
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-remaining-surfaces.md` §2.
 *
 * ## What the target has
 *
 * The target offers a **template** for each of the git and GitHub commands a pull
 * request needs, and a template is a **command pattern**, not a rule: `git checkout -b *`
 * matches any `git checkout -b` with an argument. A template becomes a rule by being
 * wrapped in the tool it applies to — `Bash(git checkout -b *)` — and the target builds
 * the PowerShell form of the same template as well.
 *
 * **One** PowerShell rule is dropped on purpose: `PowerShell(git checkout -b *)`. The
 * target removes it rather than offer a command it does not support there, and this
 * module removes it too.
 *
 * ## What "certified" means
 *
 * A rule whose content starts with `certified: ` is the target's **own**, not the user's.
 * The target **strips** such rules out of the always-allow list and out of the
 * dangerous-rule list before it makes a permission decision, so a certified rule is never
 * read as a user allow-rule.
 *
 * ## What this implementation does not have
 *
 * The target certifies the commands **it** runs — the ones its own pull-request flow
 * issues. This implementation has no such source, so nothing certifies a command here
 * and the stripping has nothing to strip in an ordinary run. The stripping is implemented
 * and the difference is recorded in `docs/compatibility/remaining-surfaces.md`.
 */

/* -------------------------------------------------------------------------- */
/* The templates                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The target's **git and GitHub command templates**.
 *
 * Seven, in the target's own order.
 */
export const GIT_RULE_TEMPLATES: readonly string[] = Object.freeze([
  'git checkout -b *',
  'git add *',
  'git status *',
  'git commit -m *',
  'gh pr create --title * --body *',
  'gh pr edit --title * --body *',
  'gh pr view *',
]);

/**
 * The **read-only** git commands the target's built-in review flow allows.
 *
 * Five, in the target's own order.
 */
export const READ_ONLY_GIT_TEMPLATES: readonly string[] = Object.freeze([
  'git diff *',
  'git status *',
  'git log *',
  'git show *',
  'git remote show *',
]);

/**
 * The tool names the target's built-in pull-request flow needs.
 *
 * Three, in the target's own order.
 */
export const PR_FLOW_TOOL_NAMES: readonly string[] = Object.freeze([
  'ToolSearch',
  'mcp__slack__send_message',
  'mcp__claude_ai_Slack__slack_send_message',
]);

/**
 * The **PowerShell rule the target drops**.
 *
 * The target removes it from the PowerShell form of the templates rather than offer a
 * command it does not support there.
 */
export const DROPPED_POWERSHELL_RULE = 'PowerShell(git checkout -b *)';

/* -------------------------------------------------------------------------- */
/* The certified prefixes                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The marker a **certified** rule's content carries.
 */
export const CERTIFIED_RULE_PREFIX = 'certified: ';

/**
 * The command prefixes the target itself certifies.
 *
 * The target holds them as module-level constants, and this module holds them as a
 * frozen record: the name is the target's own, and the value is the target's own data.
 */
export const CERTIFIED_COMMAND_PREFIXES = Object.freeze({
  gitStatus: 'certified: git status',
  gitAdd: 'certified: git add',
  gitCommit: 'certified: git commit',
  gitCheckoutBranch: 'certified: git checkout -b',
  gitLog: 'certified: git log',
  gitDiff: 'certified: git diff',
  gitBranchShowCurrent: 'certified: git branch --show-current',
  ghPrCreate: 'certified: gh pr create',
  ghPrEdit: 'certified: gh pr edit',
  ghPrView: 'certified: gh pr view',
  gitPush: 'certified: git push ',
  gitPushOrigin: 'certified: git push origin',
});

/**
 * The seven certified prefixes the target's built-in pull-request flow uses.
 *
 * In the target's own order.
 */
export const PR_FLOW_CERTIFIED_PREFIXES: readonly string[] = Object.freeze([
  CERTIFIED_COMMAND_PREFIXES.gitCheckoutBranch,
  CERTIFIED_COMMAND_PREFIXES.gitAdd,
  CERTIFIED_COMMAND_PREFIXES.gitStatus,
  CERTIFIED_COMMAND_PREFIXES.gitCommit,
  CERTIFIED_COMMAND_PREFIXES.ghPrCreate,
  CERTIFIED_COMMAND_PREFIXES.ghPrEdit,
  CERTIFIED_COMMAND_PREFIXES.ghPrView,
]);

/* -------------------------------------------------------------------------- */
/* The conversion                                                               */
/* -------------------------------------------------------------------------- */

/** The `Bash` rule for a template. */
export function bashRuleFor(template: string): string {
  return `Bash(${template})`;
}

/** The `PowerShell` rule for a template. */
export function powershellRuleFor(template: string): string {
  return `PowerShell(${template})`;
}

/**
 * The **PowerShell** rules for a list of templates.
 *
 * The target converts each template into both shells and then keeps only the PowerShell
 * ones, dropping the one rule it does not offer there.
 */
export function powershellRulesFor(templates: readonly string[]): string[] {
  const rules: string[] = [];
  for (const template of templates) {
    const rule = powershellRuleFor(template);
    if (rule === DROPPED_POWERSHELL_RULE) continue;
    rules.push(rule);
  }
  return rules;
}

/**
 * The rules a list of templates becomes — the target's own `WYt`.
 *
 * The first list becomes `Bash(...)` rules, one per template; the second list becomes
 * the **PowerShell** rules only; the tool names follow.
 */
export function ruleTemplatesFor(
  bashTemplates: readonly string[],
  powerShellTemplates: readonly string[] = [],
  toolNames: readonly string[] = [],
): string[] {
  return [
    ...bashTemplates.map((template) => bashRuleFor(template)),
    ...powershellRulesFor(powerShellTemplates),
    ...toolNames,
  ];
}

/**
 * The rules the target's built-in pull-request flow asks for.
 *
 * The seven certified prefixes become `Bash(...)` rules, the seven command templates
 * become the PowerShell rules, and the three tool names follow.
 */
export function prFlowRuleTemplates(): string[] {
  return ruleTemplatesFor(
    [...PR_FLOW_CERTIFIED_PREFIXES, CERTIFIED_COMMAND_PREFIXES.gitPushOrigin],
    GIT_RULE_TEMPLATES,
    PR_FLOW_TOOL_NAMES,
  );
}

/**
 * The `allowed-tools` list the target's built-in review flow declares.
 *
 * The target renders the read-only git templates into **both** shells and joins them
 * with `", "`.
 */
export function allowedToolsForReadOnlyGit(): string {
  const rules: string[] = [];
  for (const template of READ_ONLY_GIT_TEMPLATES) {
    rules.push(bashRuleFor(template));
    rules.push(powershellRuleFor(template));
  }
  return rules.join(', ');
}

/* -------------------------------------------------------------------------- */
/* The certified rules                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Whether a rule is a **certified** one.
 *
 * A certified rule is a `Bash` rule whose content starts with `certified: `.
 *
 * The content is taken directly rather than through the parameter rule, because
 * `certified: git status` has the *shape* of a `Tool(param:value)` rule and the
 * target reads it as a content, not as a parameter.
 */
export function isCertifiedRule(rule: string): boolean {
  const parsed = parseRuleShape(rule);
  if (parsed === undefined) return false;
  if (parsed.toolName !== 'Bash') return false;
  return parsed.content.startsWith(CERTIFIED_RULE_PREFIX);
}

/** The tool name and the content of a rule. */
function parseRuleShape(rule: string): { toolName: string; content: string } | undefined {
  let body = rule.trim();
  if (body.startsWith('!')) body = body.slice(1).trim();
  const open = body.indexOf('(');
  if (open === -1) return undefined;
  if (!body.endsWith(')')) return undefined;
  const toolName = body.slice(0, open).trim();
  if (toolName.length === 0) return undefined;
  return { toolName, content: body.slice(open + 1, -1) };
}

/**
 * Strip the **certified** rules out of a list of rules.
 *
 * The target applies this to the always-allow list and to the dangerous-rule list
 * before it makes a permission decision. A list with no certified rule is returned
 * unchanged, which is what the target does too.
 */
export function stripCertifiedRules(rules: readonly string[]): string[] {
  if (!rules.some((rule) => isCertifiedRule(rule))) return [...rules];
  return rules.filter((rule) => !isCertifiedRule(rule));
}

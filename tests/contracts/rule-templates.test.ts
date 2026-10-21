/**
 * Contract test: the target's own **git and GitHub rule templates**, and the certified
 * command prefixes.
 *
 * Evidence: `chunk-4jsg44k7.js:1676004` (the seven templates), `:1676156` (the
 * conversion), `:1675915` (the tool names), `:1738787` (the read-only list), `:788097`
 * (the certified prefixes), `:787667` (the stripping), and `chunk-swcca8bf.js:3896` (the
 * shell conversion). The record is
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-remaining-surfaces.md` §2.
 */

import { describe, expect, it } from 'vitest';

import {
  CERTIFIED_COMMAND_PREFIXES,
  CERTIFIED_RULE_PREFIX,
  DROPPED_POWERSHELL_RULE,
  GIT_RULE_TEMPLATES,
  PR_FLOW_CERTIFIED_PREFIXES,
  PR_FLOW_TOOL_NAMES,
  READ_ONLY_GIT_TEMPLATES,
  allowedToolsForReadOnlyGit,
  bashRuleFor,
  isCertifiedRule,
  prFlowRuleTemplates,
  powershellRulesFor,
  ruleTemplatesFor,
  stripCertifiedRules,
} from '../../src/permissions/templates.js';

describe('the git and GitHub rule templates', () => {
  it('carries the target\'s seven templates, in the target\'s order', () => {
    expect(GIT_RULE_TEMPLATES).toEqual([
      'git checkout -b *',
      'git add *',
      'git status *',
      'git commit -m *',
      'gh pr create --title * --body *',
      'gh pr edit --title * --body *',
      'gh pr view *',
    ]);
  });

  it('carries the target\'s five read-only git templates', () => {
    expect(READ_ONLY_GIT_TEMPLATES).toEqual([
      'git diff *',
      'git status *',
      'git log *',
      'git show *',
      'git remote show *',
    ]);
  });

  it('turns a template into the Bash rule the target writes', () => {
    expect(bashRuleFor('git checkout -b *')).toBe('Bash(git checkout -b *)');
  });

  it('drops the one PowerShell rule the target drops', () => {
    expect(DROPPED_POWERSHELL_RULE).toBe('PowerShell(git checkout -b *)');
    expect(powershellRulesFor(GIT_RULE_TEMPLATES)).toEqual([
      'PowerShell(git add *)',
      'PowerShell(git status *)',
      'PowerShell(git commit -m *)',
      'PowerShell(gh pr create --title * --body *)',
      'PowerShell(gh pr edit --title * --body *)',
      'PowerShell(gh pr view *)',
    ]);
  });

  it('builds the rule list the way the target does', () => {
    expect(ruleTemplatesFor(['git add *'], ['git add *'], ['ToolSearch'])).toEqual([
      'Bash(git add *)',
      'PowerShell(git add *)',
      'ToolSearch',
    ]);
  });

  it('builds the pull-request flow\'s rules the way the target does', () => {
    const rules = prFlowRuleTemplates();
    expect(rules.slice(0, 8)).toEqual([
      'Bash(certified: git checkout -b)',
      'Bash(certified: git add)',
      'Bash(certified: git status)',
      'Bash(certified: git commit)',
      'Bash(certified: gh pr create)',
      'Bash(certified: gh pr edit)',
      'Bash(certified: gh pr view)',
      'Bash(certified: git push origin)',
    ]);
    expect(rules).toContain('PowerShell(git add *)');
    expect(rules).not.toContain(DROPPED_POWERSHELL_RULE);
    expect(rules.slice(-3)).toEqual([...PR_FLOW_TOOL_NAMES]);
  });

  it('renders the read-only allowed-tools list in both shells', () => {
    expect(allowedToolsForReadOnlyGit()).toBe(
      'Bash(git diff *), PowerShell(git diff *), Bash(git status *), PowerShell(git status *), ' +
        'Bash(git log *), PowerShell(git log *), Bash(git show *), PowerShell(git show *), ' +
        'Bash(git remote show *), PowerShell(git remote show *)',
    );
  });
});

describe('the certified command prefixes', () => {
  it('carries the target\'s thirteen prefixes with the target\'s own values', () => {
    expect(CERTIFIED_COMMAND_PREFIXES.gitStatus).toBe('certified: git status');
    expect(CERTIFIED_COMMAND_PREFIXES.gitAdd).toBe('certified: git add');
    expect(CERTIFIED_COMMAND_PREFIXES.gitCommit).toBe('certified: git commit');
    expect(CERTIFIED_COMMAND_PREFIXES.gitCheckoutBranch).toBe('certified: git checkout -b');
    expect(CERTIFIED_COMMAND_PREFIXES.gitLog).toBe('certified: git log');
    expect(CERTIFIED_COMMAND_PREFIXES.gitDiff).toBe('certified: git diff');
    expect(CERTIFIED_COMMAND_PREFIXES.gitBranchShowCurrent).toBe('certified: git branch --show-current');
    expect(CERTIFIED_COMMAND_PREFIXES.ghPrCreate).toBe('certified: gh pr create');
    expect(CERTIFIED_COMMAND_PREFIXES.ghPrEdit).toBe('certified: gh pr edit');
    expect(CERTIFIED_COMMAND_PREFIXES.ghPrView).toBe('certified: gh pr view');
    expect(CERTIFIED_COMMAND_PREFIXES.gitPush).toBe('certified: git push ');
    expect(CERTIFIED_COMMAND_PREFIXES.gitPushOrigin).toBe('certified: git push origin');
  });

  it('carries the seven the pull-request flow uses', () => {
    expect(PR_FLOW_CERTIFIED_PREFIXES).toHaveLength(7);
    expect(PR_FLOW_CERTIFIED_PREFIXES).toContain(CERTIFIED_COMMAND_PREFIXES.gitCheckoutBranch);
    expect(PR_FLOW_CERTIFIED_PREFIXES).toContain(CERTIFIED_COMMAND_PREFIXES.ghPrView);
  });

  it('recognises a certified rule by its content', () => {
    expect(isCertifiedRule('Bash(certified: git status)')).toBe(true);
    expect(isCertifiedRule('Bash(git status)')).toBe(false);
    expect(isCertifiedRule('PowerShell(certified: git status)')).toBe(false);
    expect(isCertifiedRule('certified: git status')).toBe(false);
  });

  it('strips the certified rules out of a list', () => {
    expect(
      stripCertifiedRules(['Bash(certified: git status)', 'Bash(git add *)', 'Bash(certified: gh pr view)']),
    ).toEqual(['Bash(git add *)']);
  });

  it('leaves a list with no certified rule alone', () => {
    expect(stripCertifiedRules(['Bash(git add *)'])).toEqual(['Bash(git add *)']);
  });

  it('carries the marker the target uses', () => {
    expect(CERTIFIED_RULE_PREFIX).toBe('certified: ');
  });
});

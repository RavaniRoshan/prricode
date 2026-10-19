/**
 * Security test for the permission rule engine.
 *
 * The rules pinned here are the ones the target itself got wrong at some point, plus
 * the ones the research report lists as this implementation's own security posture:
 *
 *   1. A compound command is split on every documented operator and **every**
 *      sub-command is checked. The target had a 50-sub-command cap that silently
 *      skipped every deny check and degraded to a generic, auto-approvable ask.
 *   2. Rule precedence is `deny` → `ask` → `allow`, first match wins, and
 *      **specificity is irrelevant**: a broad deny beats a narrower allow, and an
 *      allow rule can never carve an exception out of a deny.
 *   3. Bash rules match **command text, not program identity**. `Bash(curl *)` does
 *      not stop `/usr/bin/curl` or `sh -c 'curl …'`. This implementation must not claim
 *      otherwise, and its safety checks must not assume the rule engine saw the
 *      program.
 *   4. Path rules use four anchors: `//path` (filesystem root), `~/path` (home),
 *      `/path` (relative to the settings source) and `path` / `./path` (the working
 *      directory).
 *   5. Symlink semantics are **asymmetric**: an allow rule requires both the
 *      requested path and the resolved target to match; a deny rule fires if either
 *      matches. The path must be re-resolved after the check.
 *   6. The approval prompt shows the **resolved** destination, not the literal
 *      command string.
 *   7. `Tool(param:value)` matching cannot apply to a tool's primary content field
 *      (`command`, `file_path`, `path`, `url`): such a rule is ignored and warns.
 *   8. Deny rules block in every mode, including `bypassPermissions`; allow rules have
 *      no effect in `bypassPermissions`; `dontAsk` denies rather than prompts; and a
 *      safety-check denial cannot be bypassed.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.5 (Permissions) and
 * `research/reference-agent-2.1.303-research.md` §5 (Permission models and known
 * security failures).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import {
  checkPermission,
  collectRuleWarnings,
  describeReason,
  evaluateRules,
  type PermissionDecision,
  type RuleSet,
  type ToolContext,
} from '../../src/permissions/decision.js';
import { reResolvePath, resolvePathTargets } from '../../src/permissions/rules.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'prricode-permissions-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tool(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    toolName: 'Bash',
    input: { command: 'ls -l' },
    toolUseId: 'toolu_01',
    sessionId: 'session-01',
    ...overrides,
  };
}

function rules(overrides: Partial<RuleSet> = {}): RuleSet {
  return {
    allow: [],
    deny: [],
    ask: [],
    cwd: '/work',
    source: 'userSettings',
    ...overrides,
  };
}

describe('the compound-command sub-command cap', () => {
  it('requires approval for the stripped sub-command and shows that one part of several needs it', () => {
    const decision = evaluateRules(
      rules({ ask: ['Bash(b)'] }),
      tool({ input: { command: 'a > out.txt && b' } }),
    );

    expect(decision?.behavior).toBe('ask');
    expect(decision?.reasonKind).toBe('subcommandResults');
    // The offending sub-command is listed with its redirection stripped.
    expect(decision?.subcommandResults?.commands).toEqual(['b']);
    expect(decision?.subcommandResults?.count).toBe(1);
    expect(decision?.subcommandResults?.total).toBe(2);

    const text = describeReason(decision as PermissionDecision, 'Bash');
    expect(text).toContain('b');
    expect(text).toContain('1');
    expect(text).not.toContain('a > out.txt');
  });

  it('checks every sub-command of a 51-part command', () => {
    const parts: string[] = [];
    for (let index = 0; index < 50; index += 1) parts.push(`echo ${index}`);
    parts.push('rm -rf /');

    const decision = evaluateRules(rules({ deny: ['Bash(rm *)'] }), tool({ input: { command: parts.join(' && ') } }));

    expect(decision?.behavior).toBe('deny');
    expect(decision?.subcommandResults?.count).toBe(1);
    expect(decision?.subcommandResults?.total).toBe(51);
  });

  it('does not degrade to a generic ask when the command has many parts', () => {
    const parts: string[] = [];
    for (let index = 0; index < 50; index += 1) parts.push(`echo ${index}`);
    parts.push('rm -rf /');

    const decision = evaluateRules(rules({ deny: ['Bash(rm *)'] }), tool({ input: { command: parts.join(' && ') } }));

    // The decision is a deny that names the offending part — never the generic,
    // auto-approvable ask the target degraded to.
    expect(decision?.behavior).toBe('deny');
    expect(decision?.reasonKind).toBe('subcommandResults');
    expect(decision?.subcommandResults?.commands).toEqual(['rm -rf /']);
  });

  it('never caps the number of sub-commands it inspects', () => {
    const parts: string[] = [];
    for (let index = 0; index < 500; index += 1) parts.push(`echo ${index}`);
    parts.push('curl https://example.com');

    const decision = evaluateRules(rules({ deny: ['Bash(curl *)'] }), tool({ input: { command: parts.join(' && ') } }));

    expect(decision?.behavior).toBe('deny');
    expect(decision?.subcommandResults?.total).toBe(501);
  });
});

describe('rule precedence is not specificity', () => {
  it('lets a broad deny beat a narrower allow', () => {
    const decision = evaluateRules(
      rules({ deny: ['Bash(aws *)'], allow: ['Bash(aws s3 ls)'] }),
      tool({ input: { command: 'aws s3 ls' } }),
    );

    expect(decision?.behavior).toBe('deny');
    expect(decision?.rule?.content).toBe('Bash(aws *)');
  });

  it('never lets an allow rule carve an exception out of a deny', () => {
    const decision = evaluateRules(
      rules({ allow: ['Bash(aws s3 ls)'], deny: ['Bash(aws *)'] }),
      tool({ input: { command: 'aws s3 ls' } }),
    );

    expect(decision?.behavior).toBe('deny');
  });

  it('requires every sub-command to match before an allow rule approves the chain', () => {
    const decision = evaluateRules(
      rules({ allow: ['Bash(echo *)'] }),
      tool({ input: { command: 'echo hello && rm -rf /' } }),
    );

    expect(decision).toBeUndefined();
  });
});

describe('bash rules match command text, not program identity', () => {
  it('does not treat a Bash(curl *) rule as a boundary around the curl program', () => {
    const decision = evaluateRules(
      rules({ deny: ['Bash(curl *)'] }),
      tool({ input: { command: '/usr/bin/curl https://example.com' } }),
    );

    // The rule engine matched command *text*: the absolute program path does not
    // match `curl *`. This implementation therefore must not claim that a Bash rule is a
    // security boundary around the program.
    expect(decision).toBeUndefined();
  });

  it('still matches the command text when the rule is written to cover it', () => {
    const decision = evaluateRules(
      rules({ deny: ['Bash(*curl*)'] }),
      tool({ input: { command: '/usr/bin/curl https://example.com' } }),
    );

    expect(decision?.behavior).toBe('deny');
  });

  it('does not treat a Bash(rm *) rule as a boundary around sh -c', () => {
    const decision = evaluateRules(
      rules({ deny: ['Bash(rm *)'] }),
      tool({ input: { command: "sh -c 'rm -rf /'" } }),
    );

    expect(decision).toBeUndefined();
  });
});

describe('the path rule anchors', () => {
  it('resolves // against the filesystem root', () => {
    const decision = evaluateRules(
      rules({ deny: ['Read(//etc/**)'] }),
      tool({ toolName: 'Read', input: { file_path: '/etc/passwd' } }),
    );

    expect(decision?.behavior).toBe('deny');
  });

  it('resolves ~ against the home directory', () => {
    const decision = evaluateRules(
      rules({ deny: ['Read(~/.ssh/**)'] }),
      tool({ toolName: 'Read', input: { file_path: path.join(homedir(), '.ssh', 'id_rsa') } }),
    );

    expect(decision?.behavior).toBe('deny');
  });

  it('resolves / against the settings source directory, not the filesystem root', () => {
    const decision = evaluateRules(
      rules({ deny: ['Read(/secrets/**)'], settingsDir: '/etc/app', cwd: '/work' }),
      tool({ toolName: 'Read', input: { file_path: '/etc/app/secrets/key' } }),
    );

    expect(decision?.behavior).toBe('deny');
  });

  it('resolves a bare or ./ path against the working directory', () => {
    const bare = evaluateRules(
      rules({ deny: ['Read(secrets/**)'], cwd: '/work' }),
      tool({ toolName: 'Read', input: { file_path: '/work/secrets/key' } }),
    );
    const dotted = evaluateRules(
      rules({ deny: ['Read(./secrets/**)'], cwd: '/work' }),
      tool({ toolName: 'Read', input: { file_path: '/work/secrets/key' } }),
    );

    expect(bare?.behavior).toBe('deny');
    expect(dotted?.behavior).toBe('deny');
  });

  it('does not let an anchored deny rule leak into an unrelated directory', () => {
    const decision = evaluateRules(
      rules({ deny: ['Read(secrets/**)'], cwd: '/work' }),
      tool({ toolName: 'Read', input: { file_path: '/elsewhere/secrets/key' } }),
    );

    expect(decision).toBeUndefined();
  });
});

describe('symlink semantics', () => {
  function makeWorkspace(): { root: string; work: string; outside: string } {
    const root = makeTempDir();
    const work = path.join(root, 'work');
    const outside = path.join(root, 'outside');
    mkdirSync(work, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'secret.txt'), 'secret', 'utf8');
    symlinkSync(path.join(outside, 'secret.txt'), path.join(work, 'link.txt'));
    return { root, work, outside };
  }

  it('requires both the requested path and the resolved target to match an allow rule', () => {
    const { work } = makeWorkspace();

    const decision = evaluateRules(
      rules({ allow: ['Read(link.txt)'], cwd: work }),
      tool({ toolName: 'Read', input: { file_path: path.join(work, 'link.txt') } }),
    );

    // The requested path matches, but the resolved target does not — so the allow
    // rule does not fire.
    expect(decision).toBeUndefined();
  });

  it('fires a deny rule when the resolved target matches', () => {
    const { work, outside } = makeWorkspace();

    const decision = evaluateRules(
      rules({ deny: ['Read(//**/secret.txt)'], cwd: work }),
      tool({ toolName: 'Read', input: { file_path: path.join(work, 'link.txt') } }),
    );

    expect(decision?.behavior).toBe('deny');
    expect(path.join(outside, 'secret.txt')).toContain('secret.txt');
  });

  it('fires a deny rule when the requested path matches', () => {
    const { work } = makeWorkspace();

    const decision = evaluateRules(
      rules({ deny: ['Read(link.txt)'], cwd: work }),
      tool({ toolName: 'Read', input: { file_path: path.join(work, 'link.txt') } }),
    );

    expect(decision?.behavior).toBe('deny');
  });

  it('re-resolves the path after the check rather than trusting the pre-check resolution', () => {
    const { work, root } = makeWorkspace();
    const link = path.join(work, 'link.txt');
    const before = resolvePathTargets(link, { cwd: work });

    expect(before.resolved).toBe(path.join(root, 'outside', 'secret.txt'));

    // The symlink is swapped after the permission check.
    writeFileSync(path.join(root, 'other.txt'), 'other', 'utf8');
    rmSync(link, { force: true });
    symlinkSync(path.join(root, 'other.txt'), link);

    const after = reResolvePath(before, { cwd: work });

    expect(after.resolved).toBe(path.join(root, 'other.txt'));
    expect(after.resolved).not.toBe(before.resolved);
  });
});

describe('redirect targets are file operations', () => {
  it('checks a write redirect against the write rules', () => {
    const decision = evaluateRules(
      rules({ deny: ['Write(//etc/**)'] }),
      tool({ input: { command: 'echo pwned > /etc/passwd' } }),
    );

    expect(decision?.behavior).toBe('deny');
  });

  it('checks a read redirect against the read rules', () => {
    const decision = evaluateRules(
      rules({ deny: ['Read(//etc/**)'] }),
      tool({ input: { command: 'cat < /etc/shadow' } }),
    );

    expect(decision?.behavior).toBe('deny');
  });

  it('does not fire a write rule for a redirect that writes elsewhere', () => {
    const decision = evaluateRules(
      rules({ deny: ['Write(//etc/**)'] }),
      tool({ input: { command: 'echo hello > /work/out.txt' } }),
    );

    expect(decision).toBeUndefined();
  });
});

describe('the primary content field', () => {
  it('ignores a Tool(param:value) rule that targets the primary content field', () => {
    const decision = evaluateRules(
      rules({ deny: ['Bash(command:rm *)'] }),
      tool({ input: { command: 'rm -rf /' } }),
    );

    expect(decision).toBeUndefined();
  });

  it('does not resolve an inherited member for a tool named after one', () => {
    // The tool name is caller-supplied data: a tool named `constructor` must not
    // pick up an inherited member of the tool tables.
    for (const toolName of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const decision = evaluateRules(
        rules({ deny: [`${toolName}(ls *)`] }),
        tool({ toolName, input: { command: 'ls -l' } }),
      );
      expect(decision, toolName).toBeDefined();
      expect(decision?.behavior, toolName).toBe('deny');
    }
  });

  it('still ignores a primary-content-field rule for such a tool', () => {
    const decision = evaluateRules(
      rules({ deny: ['constructor(command:ls *)'] }),
      tool({ toolName: 'constructor', input: { command: 'ls -l' } }),
    );

    expect(decision).toBeUndefined();
    expect(
      collectRuleWarnings(
        rules({ deny: ['constructor(command:ls *)'] }),
        tool({ toolName: 'constructor', input: { command: 'ls -l' } }),
      ).join(' '),
    ).toContain('constructor(command:ls *)');
  });

  it('warns when a rule is ignored', () => {
    const warnings = collectRuleWarnings(
      rules({ deny: ['Bash(command:rm *)'] }),
      tool({ input: { command: 'rm -rf /' } }),
    );

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join(' ')).toContain('Bash(command:rm *)');
  });

  it('applies a Tool(param:value) rule that names another parameter', () => {
    const decision = evaluateRules(
      rules({ deny: ['WebFetch(domain:example.com)'] }),
      tool({ toolName: 'WebFetch', input: { url: 'https://example.com/x', domain: 'example.com' } }),
    );

    expect(decision?.behavior).toBe('deny');
  });
});

describe('the modes cannot be used to escape a rule', () => {
  it('does not let bypassPermissions bypass a deny rule', async () => {
    const decision = await checkPermission(tool({ input: { command: 'rm -rf /' } }), {
      rules: rules({ deny: ['Bash(rm *)'] }),
      mode: 'bypassPermissions',
    });

    expect(decision.behavior).toBe('deny');
  });

  it('does not let bypassPermissions bypass a safety-check denial', async () => {
    const decision = await checkPermission(tool(), {
      rules: rules(),
      mode: 'bypassPermissions',
      safetyCheck: () => ({
        behavior: 'deny',
        source: 'hook',
        reasonType: 'safetyCheck',
        reason: 'The fetch arguments could not be verified, so nothing was fetched.',
      }),
    });

    expect(decision.behavior).toBe('deny');
    expect(decision.reasonType).toBe('safetyCheck');
  });

  it('does not let bypassPermissions bypass a deny rule on a file tool', async () => {
    const decision = await checkPermission(
      tool({ toolName: 'Write', input: { file_path: '/etc/hosts' } }),
      { rules: rules({ deny: ['Write(//etc/**)'] }), mode: 'bypassPermissions' },
    );

    expect(decision.behavior).toBe('deny');
  });

  it('does not let plan mode auto-approve a file edit', async () => {
    const decision = await checkPermission(
      tool({ toolName: 'Write', input: { file_path: '/work/a.txt' } }),
      { rules: rules({ allow: ['Write(a.txt)'] }), mode: 'plan' },
    );

    expect(decision.behavior).toBe('ask');
  });

  it('does not let dontAsk turn a would-be prompt into an approval', async () => {
    const decision = await checkPermission(tool({ input: { command: 'git push origin main' } }), {
      rules: rules(),
      mode: 'dontAsk',
    });

    expect(decision.behavior).toBe('deny');
  });

  it('does not let dontAsk honour an allow rule for an org-ask connector tool', async () => {
    const decision = await checkPermission(
      tool({ toolName: 'mcp__connector__org_ask', input: {} }),
      { rules: rules({ allow: ['mcp__connector__org_ask'] }), mode: 'dontAsk' },
    );

    expect(decision.behavior).toBe('deny');
  });
});

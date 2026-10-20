/**
 * Contract test for the `PreToolUse` seam's **wiring** into the tool runner.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.5 (Permissions) and the
 * `CC-007c` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * `CC-007b` built the permission side of the seam and `CC-012` built the hook
 * side, but nothing connected them: no tool call was gated by a `PreToolUse`
 * hook, and the hooks module could not *produce* an `ask` or a `defer` for the
 * permission layer. This test pins the connection:
 *
 *   - the tool layer passes the `PreToolUse` seam to the permission check, so a
 *     hook's **denial** refuses the call in **every** mode, `bypassPermissions`
 *     included, and a hook's **approval** never overrides a deny rule or an ask
 *     rule — this implementation's pick of the stricter of the target's two behaviours;
 *   - a hook's **rewrite** reaches the tool's effective input;
 *   - the tool layer's own re-check — the second line of defence, the one that
 *     owns the write path — consults **both** seams and keeps the **denial** of
 *     either, and nothing else;
 *   - the hooks module's approval carries an `ask` (the pending question, with
 *     the hook's own reason and source) and treats a `defer` as **no opinion**.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createPreToolUseApproval,
  mergePreToolUseApproval,
  type HookCommandOutcome,
  type HookDecisionValue,
  type HookResult,
  type HookRunner,
  type PreToolUseHookApproval,
} from '../../src/extensions/hooks/runner.js';
import type { HookEvent, HookSpec } from '../../src/extensions/hooks/registry.js';
import {
  checkPermission,
  type PermissionDecision,
  type PermissionMode,
  type ToolContext,
} from '../../src/permissions/decision.js';
import { createPreToolUseHook, type HookApproval } from '../../src/permissions/prompts.js';
import type { RuleSet } from '../../src/permissions/rules.js';
import {
  checkToolPermissions,
  recheckToolPermissions,
  type BuiltinToolDeps,
} from '../../src/tools/builtins/shared.js';
import { createWriteTool } from '../../src/tools/builtins/write.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { runTool } from '../../src/tools/runner.js';

const WORKDIR = '/work';

/** The six modes the target has. */
const MODES: readonly PermissionMode[] = [
  'default',
  'plan',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
];

function toolContext(toolName: string, input: unknown): ToolContext {
  return { toolName, input, toolUseId: 'toolu_01', sessionId: 'session-01' };
}

function ruleSet(overrides: Partial<RuleSet> = {}): RuleSet {
  return {
    allow: [],
    deny: [],
    ask: [],
    cwd: WORKDIR,
    source: 'userSettings',
    ...overrides,
  };
}

function builtinDeps(overrides: Partial<BuiltinToolDeps> = {}): BuiltinToolDeps {
  return {
    rules: ruleSet(),
    mode: 'default',
    cwd: WORKDIR,
    ...overrides,
  };
}

/** A hook's denial, as the permission layer's seam maps it. */
function hookDenial(reason = 'the hook refuses this call'): PermissionDecision {
  return { behavior: 'deny', source: 'hook', reasonType: 'other', reason };
}

/** A hook's approval, as the permission layer's seam maps it. */
function hookApproval(overrides: Partial<PermissionDecision> = {}): PermissionDecision {
  return {
    behavior: 'allow',
    source: 'hook',
    reasonType: 'other',
    reason: 'the hook approved this call',
    ...overrides,
  };
}

/** A hook that writes one JSON document. */
function jsonHook(event: HookEvent, body: unknown): HookSpec {
  return { event, command: 'the hook writes its JSON' };
}

/** The runner of a hook that writes one JSON document. */
function jsonRunner(body: unknown): HookRunner {
  return async (): Promise<HookCommandOutcome> => ({
    exitCode: 0,
    stdout: JSON.stringify(body),
    stderr: '',
  });
}

/** The temporary directories the test creates. */
const temporaryDirectories: string[] = [];

function makeDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'cc007c-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

// --- the compile-time pins ---------------------------------------------------------

/**
 * A compile-time pin on the approval shapes.
 *
 * The `PreToolUse` seam knows **four** decision values — `allow`, `ask`, `defer`
 * and `deny` — so its approval is **not** the permission-request approval, which
 * only ever sees `allow` and `deny`. It must still be **assignable** to the
 * permission layer's `HookApproval`, so the seam takes it unchanged.
 */
const PRE_TOOL_USE_APPROVAL_FITS_THE_PERMISSION_LAYER: PreToolUseHookApproval extends HookApproval
  ? true
  : false = true;

/**
 * A compile-time pin on the creator.
 *
 * The creator's approval plugs straight into the permission layer's `PreToolUse`
 * seam: no adaptation, no cast at the call site.
 */
const THE_APPROVAL_PLUGS_STRAIGHT_IN: (
  ctx: ToolContext,
) => HookApproval | undefined | Promise<HookApproval | undefined> = createPreToolUseApproval([]);

/**
 * A compile-time pin on the creator's default shape.
 *
 * The creator produces the `PreToolUse` approval — the one that knows `ask` and
 * `defer` — so a caller that asks for it without a context gets that shape.
 */
const THE_CREATOR_PRODUCES_THE_PRE_TOOL_USE_APPROVAL: (
  ctx: ToolContext,
) => Promise<PreToolUseHookApproval | undefined> = createPreToolUseApproval([]);

// --- the tool runner consults the seam ---------------------------------------------

describe('the tool runner and the PreToolUse seam', () => {
  it.each(MODES)('refuses a call a PreToolUse hook denies in %s mode', async (mode) => {
    const decision = await checkToolPermissions(
      toolContext('Bash', { command: 'rm -rf /' }),
      builtinDeps({
        mode,
        preToolUseHook: async () => hookDenial(),
      }),
    );

    // The denial is the hook's own: the mode dispatch never sees it, so it holds
    // in `bypassPermissions` as well.
    expect(decision.behavior).toBe('deny');
    expect(decision.source).toBe('hook');
    expect(decision.reason).toContain('the hook refuses this call');
  });

  it('does not let a PreToolUse approval override a deny rule', async () => {
    const decision = await checkToolPermissions(
      toolContext('Bash', { command: 'rm -rf /' }),
      builtinDeps({
        rules: ruleSet({ deny: ['Bash(rm *)'] }),
        preToolUseHook: async () => hookApproval(),
      }),
    );

    expect(decision.behavior).toBe('deny');
    expect(decision.rule?.content).toBe('Bash(rm *)');
  });

  it('does not let a PreToolUse approval override an ask rule', async () => {
    const decision = await checkToolPermissions(
      toolContext('Bash', { command: 'git push origin main' }),
      builtinDeps({
        rules: ruleSet({ ask: ['Bash(git push *)'] }),
        preToolUseHook: async () => hookApproval(),
      }),
    );

    expect(decision.behavior).toBe('ask');
    expect(decision.rule?.content).toBe('Bash(git push *)');
  });

  it('carries a PreToolUse rewrite into the tool’s effective input', async () => {
    const root = makeDirectory();
    const original = path.join(root, 'original.txt');
    const rewritten = path.join(root, 'rewritten.txt');

    const tool = createWriteTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Write'], cwd: root }),
        cwd: root,
        preToolUseHook: async () =>
          hookApproval({
            updatedInput: { file_path: rewritten, content: 'written' },
          }),
      }),
    );

    const registry = createToolRegistry();
    registry.register(tool);

    const input = { file_path: original, content: 'fine' };
    const envelope = await runTool(
      registry,
      'Write',
      input,
      toolContext('Write', input),
      { cwd: root },
    );

    expect(envelope.isError).toBe(false);
    // The **rewritten** path is the one the tool acted on.
    expect(readFileSync(rewritten, 'utf8')).toBe('written');
    expect(existsSync(original)).toBe(false);
  });
});

// --- the tool layer's own re-check --------------------------------------------------

describe('the tool layer’s re-check and the two seams', () => {
  it('keeps the denial of the PreToolUse seam', async () => {
    const recheck = await recheckToolPermissions(
      toolContext('Write', { file_path: '/work/a.txt', content: 'x' }),
      builtinDeps({
        rules: ruleSet({ allow: ['Write'] }),
        preToolUseHook: async () => hookDenial(),
      }),
    );

    expect(recheck.decision?.behavior).toBe('deny');
    expect(recheck.decision?.source).toBe('hook');
  });

  it('keeps the denial of the PermissionRequest seam', async () => {
    const recheck = await recheckToolPermissions(
      toolContext('Write', { file_path: '/work/a.txt', content: 'x' }),
      builtinDeps({
        rules: ruleSet({ allow: ['Write'] }),
        hook: async () => hookDenial(),
      }),
    );

    expect(recheck.decision?.behavior).toBe('deny');
  });

  it('keeps the approval of neither seam', async () => {
    // The re-check is the second line of defence and it owns the write path, so it
    // is stricter than the permission layer: an approval was given for the
    // **original** call and it does not carry the rewritten one.
    const recheck = await recheckToolPermissions(
      toolContext('Write', { file_path: '/work/a.txt', content: 'x' }),
      builtinDeps({
        preToolUseHook: async () => hookApproval(),
        hook: async () => hookApproval(),
      }),
    );

    expect(recheck.decision?.behavior).not.toBe('allow');
  });
});

// --- the hooks module’s approval in the permission layer ----------------------------

describe('the hooks module’s approval in the permission layer', () => {
  it('carries an ask as the pending question, with the hook’s own reason and source', async () => {
    const seam = createPreToolUseHook({
      approval: createPreToolUseApproval(
        [jsonHook('PreToolUse', { hookSpecificOutput: { permissionDecision: 'ask' } })],
        { runCommand: jsonRunner({ hookSpecificOutput: { permissionDecision: 'ask' } }) },
      ),
    });

    const decision = await checkPermission(toolContext('Bash', { command: 'ls' }), {
      rules: ruleSet(),
      mode: 'default',
      preToolUseHook: seam,
    });

    expect(decision.behavior).toBe('ask');
    // The question the user is asked is the **hook's** question.
    expect(decision.source).toBe('hook');
    expect(decision.reason).toContain('A PreToolUse hook asked for this call to be approved');
  });

  it('carries the hook’s own reason into the pending question', async () => {
    const body = {
      hookSpecificOutput: {
        permissionDecision: 'ask',
        permissionDecisionReason: 'the hook wants a second pair of eyes',
      },
    };
    const seam = createPreToolUseHook({
      approval: createPreToolUseApproval([jsonHook('PreToolUse', body)], {
        runCommand: jsonRunner(body),
      }),
    });

    const decision = await checkPermission(toolContext('Bash', { command: 'ls' }), {
      rules: ruleSet(),
      mode: 'default',
      preToolUseHook: seam,
    });

    expect(decision.behavior).toBe('ask');
    expect(decision.source).toBe('hook');
    expect(decision.reason).toContain('the hook wants a second pair of eyes');
  });

  it('treats a defer as no opinion', async () => {
    const body = { hookSpecificOutput: { permissionDecision: 'defer' } };
    const seam = createPreToolUseHook({
      approval: createPreToolUseApproval([jsonHook('PreToolUse', body)], {
        runCommand: jsonRunner(body),
      }),
    });

    const decision = await checkPermission(toolContext('Bash', { command: 'ls' }), {
      rules: ruleSet(),
      mode: 'default',
      preToolUseHook: seam,
    });

    // The normal permission path decides: the generic prompt, not the hook's.
    expect(decision.behavior).toBe('ask');
    expect(decision.source).not.toBe('hook');
    expect(decision.reasonKind).toBe('noRuleMatch');
  });

  it('merges a group of PreToolUse results into an approval that carries the ask', () => {
    const approval = mergePreToolUseApproval([
      {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'the hook asks',
      },
    ]);

    expect(approval?.hookEventName).toBe('PreToolUse');
    expect(approval?.decision?.behavior).toBe('ask');
    expect(approval?.decision?.reason).toBe('the hook asks');
  });

  it('merges a group of PreToolUse results into no approval when the hook defers', () => {
    const approval = mergePreToolUseApproval([
      { hookEventName: 'PreToolUse', permissionDecision: 'defer' },
    ]);

    expect(approval).toBeUndefined();
  });

  it('carries the rewrite of a PreToolUse hook into the approval', () => {
    const approval = mergePreToolUseApproval([
      {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { command: 'ls' },
      },
    ]);

    expect(approval?.updatedInput).toEqual({ command: 'ls' });
  });
});

// --- the approval shape -------------------------------------------------------------

describe('the PreToolUse approval shape', () => {
  it('knows the four decision values of the seam', () => {
    const behaviors: readonly HookDecisionValue[] = ['allow', 'ask', 'defer', 'deny'];
    const carried: HookDecisionValue[] = [];

    for (const behavior of behaviors) {
      const approval = mergePreToolUseApproval([
        { hookEventName: 'PreToolUse', permissionDecision: behavior },
      ]);
      if (approval === undefined) continue;
      carried.push(approval.decision.behavior);
    }

    // A `defer` is no opinion, so it is the only one of the four that is not
    // carried.
    expect(carried).toEqual(['allow', 'ask', 'deny']);
  });

  it('keeps the stricter decision of a group, with its own reason', () => {
    const results: HookResult[] = [
      { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
      { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' },
    ];

    const approval = mergePreToolUseApproval(results);

    expect(approval?.decision.behavior).toBe('deny');
    expect(approval?.decision.reason).toBe('no');
  });
});

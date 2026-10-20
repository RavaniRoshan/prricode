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
 *
 * **The compile-time pins are equality pins, not assignability pins.** A
 * creator that is generic in its approval shape resolves the type parameter
 * from the *contextual type* of the place it is used, so an assignability pin
 * is satisfied by a creator that can produce an `ask` where the compiler
 * believes it produced an `allow` or a `deny`. The pins below therefore
 * compare the types **exactly**, and each one names the thing it checks.
 *
 * **The seam is consulted three times for a rewritten call**, and the test
 * pins the number and the inputs each consultation saw: the original input
 * once, and the effective (rewritten) input twice.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createHookApproval,
  createPreToolUseApproval,
  mergePreToolUseApproval,
  type HookCommandOutcome,
  type HookDecisionValue,
  type HookResult,
  type HookRunner,
  type RunHooksOptions,
} from '../../src/extensions/hooks/runner.js';
import {
  createHookRegistry,
  createPreToolUseApproval as createPreToolUseApprovalFromTheEntryPoint,
  mergePreToolUseApproval as mergePreToolUseApprovalFromTheEntryPoint,
  type HookEvent,
  type HookSpec,
  type PreToolUseHookApproval,
} from '../../src/extensions/hooks/registry.js';
import {
  checkPermission,
  type PermissionDecision,
  type PermissionMode,
  type ToolContext,
} from '../../src/permissions/decision.js';
import {
  createPermissionRequestHook,
  createPreToolUseHook,
  type HookApproval,
} from '../../src/permissions/prompts.js';
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

/**
 * A hook that writes one JSON document, and the runner that writes it.
 *
 * The body and the spec are made **together**, so the body that reaches the
 * hook is the body the test meant: a spec whose body is not the body its
 * runner writes is a hook that decides something nobody asked it to decide.
 */
function jsonHook(event: HookEvent, body: unknown): { spec: HookSpec; runner: HookRunner } {
  return {
    spec: { event, command: 'the hook writes its JSON' },
    runner: async (): Promise<HookCommandOutcome> => ({
      exitCode: 0,
      stdout: JSON.stringify(body),
      stderr: '',
    }),
  };
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
 * Whether two types are **exactly** the same.
 *
 * The check is TypeScript's own identity test: it compares the two types
 * *deferred*, so a type that is merely **assignable** to the other is not the
 * same type. An assignability pin cannot tell a generic creator from a plain
 * one — the generic creator resolves its type parameter from the context it is
 * placed in — so the pins that must catch that are equality pins.
 */
type IsExactly<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? true
  : false;

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
 * The creator's **return type**, exactly.
 *
 * The creator returns the callback the plan's signature names: it resolves to
 * `PreToolUseHookApproval | undefined` and to nothing else — not the
 * permission-request approval, and not a type parameter that the caller's
 * context chose.
 */
type TheCreatorReturnsThePreToolUseApproval = IsExactly<
  ReturnType<typeof createPreToolUseApproval>,
  (ctx: ToolContext) => Promise<PreToolUseHookApproval | undefined>
>;

/**
 * A compile-time pin on the creator's **return type**.
 *
 * The creator returns **exactly** the `PreToolUse` approval — and the
 * `PreToolUse` approval is assignable to the permission layer's `HookApproval`,
 * so the seam takes it unchanged.
 */
const THE_APPROVAL_PLUGS_STRAIGHT_IN: TheCreatorReturnsThePreToolUseApproval extends true
  ? PreToolUseHookApproval extends HookApproval
    ? true
    : false
  : false = true;

/**
 * The plan's **exact** signature for the creator.
 *
 * It is the plan's signature and not a shape the plan happens to accept: the
 * creator takes the hook specs and the runner options, and it returns the
 * `PreToolUse` approval callback with the `PreToolUse` approval's own type.
 */
type ThePlanSignature = (
  specs: readonly HookSpec[],
  options?: RunHooksOptions,
) => (ctx: ToolContext) => Promise<PreToolUseHookApproval | undefined>;

/**
 * A compile-time pin on the creator's **signature**.
 *
 * The creator is **not** generic: a generic creator would resolve its type
 * parameter from the contextual type of the place it is placed, and the
 * compiler would then believe that the decision is one of `allow` and `deny`
 * while the value at run time can be an `ask`. The equality is what catches
 * that: an assignability check cannot.
 */
const THE_CREATOR_PRODUCES_THE_PRE_TOOL_USE_APPROVAL: IsExactly<
  typeof createPreToolUseApproval,
  ThePlanSignature
> = true;

describe('the compile-time pins', () => {
  it('the PreToolUse approval fits the permission layer', () => {
    expect(PRE_TOOL_USE_APPROVAL_FITS_THE_PERMISSION_LAYER).toBe(true);
  });

  it('the creator returns exactly the PreToolUse approval', () => {
    expect(THE_APPROVAL_PLUGS_STRAIGHT_IN).toBe(true);
  });

  it('the creator has the plan’s exact signature', () => {
    expect(THE_CREATOR_PRODUCES_THE_PRE_TOOL_USE_APPROVAL).toBe(true);
  });
});

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

  it('turns a PreToolUse ask into the pending question at the tool layer', async () => {
    // The seam asks the tool layer, not only the permission layer: the question
    // the user is asked is the **hook's** question, with the hook's own source.
    const decision = await checkToolPermissions(
      toolContext('Bash', { command: 'git push origin main' }),
      builtinDeps({
        preToolUseHook: async () => ({
          behavior: 'ask',
          source: 'hook',
          reasonType: 'other',
          reason: 'the hook wants a second pair of eyes',
        }),
      }),
    );

    expect(decision.behavior).toBe('ask');
    expect(decision.source).toBe('hook');
    expect(decision.reason).toContain('the hook wants a second pair of eyes');
  });
});

// --- the tool layer’s own re-check --------------------------------------------------

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
    // **original** call and it does not carry the rewritten one. The verdict is
    // the generic prompt — the call no rule covers — and not the absence of a
    // verdict.
    const recheck = await recheckToolPermissions(
      toolContext('Write', { file_path: '/work/a.txt', content: 'x' }),
      builtinDeps({
        preToolUseHook: async () => hookApproval(),
        hook: async () => hookApproval(),
      }),
    );

    expect(recheck.decision?.behavior).toBe('ask');
    // The target's reason kinds are six, and the generic prompt is the
    // target's `permissionPromptTool` — there is no seventh kind.
    expect(recheck.decision?.reasonKind).toBe('permissionPromptTool');
    expect(recheck.decision?.noRuleMatched).toBe(true);
  });

  it('reports the same denial as the permission layer when both seams deny', async () => {
    // The two layers consult the seams in the **same** order, so the refusal a
    // user sees names the same seam in both of them.
    const deps = builtinDeps({
      preToolUseHook: async () => hookDenial('the PreToolUse seam refuses this call'),
      hook: async () => hookDenial('the PermissionRequest seam refuses this call'),
    });
    const ctx = toolContext('Write', { file_path: '/work/a.txt', content: 'x' });

    const decision = await checkToolPermissions(ctx, deps);
    const recheck = await recheckToolPermissions(ctx, deps);

    expect(decision.behavior).toBe('deny');
    expect(decision.reason).toContain('the PreToolUse seam refuses this call');
    expect(recheck.decision?.behavior).toBe('deny');
    expect(recheck.decision?.reason).toContain('the PreToolUse seam refuses this call');
  });

  it('consults the seams with the effective input', async () => {
    // The re-check judges the input the call will really act on, so the seam
    // sees that input and not the original one.
    const seen: unknown[] = [];
    const effective = { file_path: '/work/rewritten.txt', content: 'x' };

    await recheckToolPermissions(
      toolContext('Write', effective),
      builtinDeps({
        rules: ruleSet({ allow: ['Write'] }),
        preToolUseHook: async (ctx: ToolContext) => {
          seen.push(ctx.input);
          return hookApproval();
        },
      }),
    );

    expect(seen).toEqual([effective]);
  });
});

// --- the number of consultations ----------------------------------------------------

describe('the number of seam consultations', () => {
  it('consults the PreToolUse seam three times for a rewritten call', async () => {
    // Three: the **original** input in the tool's own check, and the
    // **effective** input twice — once in the permission layer's re-check of
    // the rewritten input, and once in the tool layer's own re-check, which is
    // the second line of defence and owns the write path.
    const root = makeDirectory();
    const original = { file_path: path.join(root, 'original.txt'), content: 'fine' };
    const rewritten = { file_path: path.join(root, 'rewritten.txt'), content: 'written' };
    const seen: unknown[] = [];

    const tool = createWriteTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Write'], cwd: root }),
        cwd: root,
        preToolUseHook: async (ctx: ToolContext) => {
          seen.push(ctx.input);
          return hookApproval({ updatedInput: rewritten });
        },
      }),
    );

    const registry = createToolRegistry();
    registry.register(tool);

    const envelope = await runTool(
      registry,
      'Write',
      original,
      toolContext('Write', original),
      { cwd: root },
    );

    expect(envelope.isError).toBe(false);
    expect(seen).toHaveLength(3);
    // The first consultation judges the call as it was made; the other two
    // judge the call as it will act.
    expect(seen[0]).toEqual(original);
    expect(seen[1]).toEqual(rewritten);
    expect(seen[2]).toEqual(rewritten);
  });

  it('consults the seam once for a call that is not rewritten', async () => {
    const root = makeDirectory();
    const original = { file_path: path.join(root, 'original.txt'), content: 'fine' };
    let count = 0;

    const tool = createWriteTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Write'], cwd: root }),
        cwd: root,
        preToolUseHook: async () => {
          count += 1;
          return hookApproval();
        },
      }),
    );

    const registry = createToolRegistry();
    registry.register(tool);

    const envelope = await runTool(
      registry,
      'Write',
      original,
      toolContext('Write', original),
      { cwd: root },
    );

    expect(envelope.isError).toBe(false);
    expect(count).toBe(1);
  });

  it('runs the safety check twice for a rewritten call', async () => {
    // Once in the tool's own check and once in the tool layer's re-check of the
    // rewritten input. The permission layer's own re-check does not run it a
    // third time: it already judged the effective input.
    const root = makeDirectory();
    const original = { file_path: path.join(root, 'original.txt'), content: 'fine' };
    const rewritten = { file_path: path.join(root, 'rewritten.txt'), content: 'written' };
    let count = 0;

    const tool = createWriteTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Write'], cwd: root }),
        cwd: root,
        safetyCheck: () => {
          count += 1;
          return undefined;
        },
        preToolUseHook: async () => hookApproval({ updatedInput: rewritten }),
      }),
    );

    const registry = createToolRegistry();
    registry.register(tool);

    const envelope = await runTool(
      registry,
      'Write',
      original,
      toolContext('Write', original),
      { cwd: root },
    );

    expect(envelope.isError).toBe(false);
    expect(count).toBe(2);
  });
});

// --- the sharp edge of the stricter re-check ---------------------------------------

describe('the approving-and-rewriting hook and the uncovered call', () => {
  it('refuses the call the permission layer allowed and the hook approved', async () => {
    // The re-check keeps the **denial** of either seam and nothing else, so an
    // approval given for the original call does not carry the rewritten one. A
    // call no rule covers therefore leaves the re-check as the generic prompt,
    // and with no prompt to answer it the call is refused.
    const root = makeDirectory();
    const original = { file_path: path.join(root, 'original.txt'), content: 'fine' };
    const rewritten = { file_path: path.join(root, 'rewritten.txt'), content: 'written' };

    const tool = createWriteTool(
      builtinDeps({
        rules: ruleSet({ cwd: root }),
        cwd: root,
        preToolUseHook: async () => hookApproval({ updatedInput: rewritten }),
      }),
    );

    const registry = createToolRegistry();
    registry.register(tool);

    const envelope = await runTool(
      registry,
      'Write',
      original,
      toolContext('Write', original),
      { cwd: root },
    );

    expect(envelope.isError).toBe(true);
    expect(envelope.non_execution_kind).toBe('permission_unresolved');
    expect(existsSync(rewritten.file_path)).toBe(false);
  });
});

// --- the hooks module’s approval in the permission layer ----------------------------

describe('the hooks module’s approval in the permission layer', () => {
  it('carries an ask as the pending question, with the hook’s own reason and source', async () => {
    const hook = jsonHook('PreToolUse', {
      hookSpecificOutput: { permissionDecision: 'ask' },
    });
    const seam = createPreToolUseHook({
      approval: createPreToolUseApproval([hook.spec], { runCommand: hook.runner }),
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
    const hook = jsonHook('PreToolUse', {
      hookSpecificOutput: {
        permissionDecision: 'ask',
        permissionDecisionReason: 'the hook wants a second pair of eyes',
      },
    });
    const seam = createPreToolUseHook({
      approval: createPreToolUseApproval([hook.spec], { runCommand: hook.runner }),
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
    const hook = jsonHook('PreToolUse', { hookSpecificOutput: { permissionDecision: 'defer' } });
    const seam = createPreToolUseHook({
      approval: createPreToolUseApproval([hook.spec], { runCommand: hook.runner }),
    });

    const decision = await checkPermission(toolContext('Bash', { command: 'ls' }), {
      rules: ruleSet(),
      mode: 'default',
      preToolUseHook: seam,
    });

    // The normal permission path decides: the generic prompt, not the hook's.
    expect(decision.behavior).toBe('ask');
    expect(decision.source).not.toBe('hook');
    expect(decision.reasonKind).toBe('permissionPromptTool');
    expect(decision.noRuleMatched).toBe(true);
  });

  it('carries the rewrite of an ask along with the question', async () => {
    // The question the user is asked is about the **rewritten** call, so the
    // rewrite rides along with the ask.
    const hook = jsonHook('PreToolUse', {
      hookSpecificOutput: { permissionDecision: 'ask' },
      updatedInput: { command: 'ls -la' },
    });
    const seam = createPreToolUseHook({
      approval: createPreToolUseApproval([hook.spec], { runCommand: hook.runner }),
    });

    const decision = await checkPermission(toolContext('Bash', { command: 'ls' }), {
      rules: ruleSet(),
      mode: 'default',
      preToolUseHook: seam,
    });

    expect(decision.behavior).toBe('ask');
    expect(decision.source).toBe('hook');
    expect(decision.updatedInput).toEqual({ command: 'ls -la' });
  });

  it('drops the rewrite of a defer with the deferral', async () => {
    // A `defer` is no opinion, so nothing at all is carried — not the decision
    // and not the rewrite. The call runs as it was made.
    const hook = jsonHook('PreToolUse', {
      hookSpecificOutput: { permissionDecision: 'defer' },
      updatedInput: { command: 'ls -la' },
    });
    const seam = createPreToolUseHook({
      approval: createPreToolUseApproval([hook.spec], { runCommand: hook.runner }),
    });

    const decision = await checkPermission(toolContext('Bash', { command: 'ls' }), {
      rules: ruleSet({ allow: ['Bash'] }),
      mode: 'default',
      preToolUseHook: seam,
    });

    expect(decision.behavior).toBe('allow');
    expect(decision.updatedInput).toBeUndefined();
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

  it('drops the rewrite of a deferral with the deferral', () => {
    // A `defer` is no opinion, so nothing at all is carried — not the decision
    // and not the rewrite. The rewrite goes with it.
    const approval = mergePreToolUseApproval([
      {
        hookEventName: 'PreToolUse',
        permissionDecision: 'defer',
        updatedInput: { command: 'ls -la' },
      },
    ]);

    expect(approval).toBeUndefined();
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

  it('ignores the results of another event', () => {
    // A `PermissionRequest` result says nothing about a `PreToolUse` call, so
    // it is not merged into the `PreToolUse` approval.
    const approval = mergePreToolUseApproval([
      {
        hookEventName: 'PermissionRequest',
        permissionDecision: 'deny',
        permissionDecisionReason: 'the other seam refuses this call',
      },
    ]);

    expect(approval).toBeUndefined();
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

// --- the assembly the session and the CLI will build --------------------------------

describe('the assembly the session and the CLI will build', () => {
  it('wires the registry’s hooks into the tool layer', async () => {
    // This is the wiring `CC-014` has to build: the hook registry's hooks
    // become the two seam members of the tool dependencies, through the hooks
    // module's approval creators and the permission layer's seams. The code
    // below is the code the module header of `src/tools/builtins/shared.ts`
    // documents, so the documentation is compiled.
    const hookRegistry = createHookRegistry();
    hookRegistry.register({ event: 'PreToolUse', command: 'the hook refuses this call' });
    hookRegistry.register({ event: 'PermissionRequest', command: 'the other hook refuses it' });

    const preToolUse = jsonHook('PreToolUse', {
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'the hook refuses this call',
      },
    });
    const permissionRequest = jsonHook('PermissionRequest', {
      decision: { behavior: 'deny', reason: 'the other hook refuses this call' },
    });

    const deps = builtinDeps({
      hook: createPermissionRequestHook({
        approval: createHookApproval(hookRegistry.for('PermissionRequest'), {
          runCommand: permissionRequest.runner,
        }),
      }),
      preToolUseHook: createPreToolUseHook({
        approval: createPreToolUseApproval(hookRegistry.for('PreToolUse'), {
          runCommand: preToolUse.runner,
        }),
      }),
    });

    const decision = await checkToolPermissions(toolContext('Bash', { command: 'ls' }), deps);

    expect(decision.behavior).toBe('deny');
    expect(decision.source).toBe('hook');
    expect(decision.reason).toContain('the hook refuses this call');

    // The `PermissionRequest` seam is wired the same way, and it is consulted
    // with the same specs the registry holds for that event.
    const request = await deps.hook?.(toolContext('Bash', { command: 'ls' }));
    expect(request?.behavior).toBe('deny');
    expect(permissionRequest.spec.event).toBe('PermissionRequest');
  });

  it('re-exports the PreToolUse creator from the hooks entry point', async () => {
    // The entry point is the one import a consumer of the hook surface makes,
    // so the creator that produces the approval and the merger that carries it
    // have to be there. The approval **shape** is imported from the entry point
    // too — the pins above use it — so the re-export of the type is covered as
    // well.
    expect(typeof createPreToolUseApprovalFromTheEntryPoint).toBe('function');
    expect(typeof mergePreToolUseApprovalFromTheEntryPoint).toBe('function');

    const approval = await createPreToolUseApprovalFromTheEntryPoint([])(
      toolContext('Bash', { command: 'ls' }),
    );
    expect(approval).toBeUndefined();
  });
});

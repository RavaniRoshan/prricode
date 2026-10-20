/**
 * Contract test for the `PreToolUse` permission seam.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.5 (Permissions) and the
 * `CC-007b` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * The test pins this implementation's pick — the **stricter** of the target's two behaviours:
 * a `PreToolUse` hook's `allow` never overrides a deny rule or an ask rule, and a
 * `PreToolUse` hook's `deny` holds in **every** mode, `bypassPermissions` included.
 * It also pins the merge of the two hook seams (the stricter wins, and the two can
 * never cancel each other), the meaning of an `ask` and a `defer` coming from a
 * `PreToolUse` hook, and the rewrite path (the whole check runs again against the
 * effective input, a rewritten input the tool's validator rejects denies the
 * call, the rewrite survives the prompt, and the validator and the safety check
 * run **once** each).
 */

import { describe, expect, it, vi } from 'vitest';

import type { HookDecisionValue } from '../../src/extensions/hooks/runner.js';
import { createPreToolUseApproval } from '../../src/extensions/hooks/runner.js';
import {
  PERMISSION_STRICTNESS,
  checkPermission,
  permissionStrictness,
  type CheckPermissionOptions,
  type PermissionBehavior,
  type PermissionDecision,
  type PermissionMode,
  type RuleSet,
  type ToolContext,
} from '../../src/permissions/decision.js';
import {
  applyPermissionRequestHook,
  createPreToolUseHook,
  effectiveInput,
  safetyCheckForTool,
  type HookApproval,
  type HookApprovalBehavior,
  type PermissionRequestHookApproval,
} from '../../src/permissions/prompts.js';

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
    cwd: WORKDIR,
    source: 'userSettings',
    ...overrides,
  };
}

/** A `PreToolUse` hook decision, as the hooks module's approval maps into it. */
function hookDecision(
  behavior: PermissionBehavior,
  overrides: Partial<PermissionDecision> = {},
): PermissionDecision {
  return {
    behavior,
    source: 'hook',
    reasonType: 'other',
    reason: `A PreToolUse hook returned '${behavior}'.`,
    ...overrides,
  };
}

/**
 * A compile-time pin on the option's signature.
 *
 * The plan names the member as
 * `(ctx: ToolContext) => PermissionDecision | undefined | Promise<PermissionDecision | undefined>`,
 * so a caller written against the plan must still compile — and the option must
 * be **exactly** that: a widened option would still accept the plan's caller.
 *
 * The member is optional, so its type is the plan's signature **or undefined**,
 * and the pin is an **equality**: widening the option — to accept `null`, say —
 * breaks the compile.
 */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
const PLAN_SIGNED_PRE_TOOL_USE_HOOK: CheckPermissionOptions['preToolUseHook'] = async () => {
  const decision: PermissionDecision | undefined = undefined;
  return decision;
};
const PRE_TOOL_USE_HOOK_IS_EXACTLY_THE_PLAN_SIGNATURE: Equal<
  CheckPermissionOptions['preToolUseHook'],
  | ((ctx: ToolContext) => PermissionDecision | undefined | Promise<PermissionDecision | undefined>)
  | undefined
> = true;

/**
 * A compile-time pin on the behavior vocabulary.
 *
 * The vocabulary is closed and has **no** `defer`: a hook that defers has no word
 * in the permission decision, so it cannot be anything but an absence of opinion.
 */
type PermissionBehaviorIsClosed = Equal<PermissionBehavior, 'allow' | 'deny' | 'ask'>;
const BEHAVIOR_VOCABULARY_HAS_NO_DEFER: PermissionBehaviorIsClosed = true;

/**
 * A compile-time pin on the hooks module's decision vocabulary.
 *
 * The permission layer's `HookApprovalBehavior` **is** the hooks module's
 * `HookDecisionValue`: the four values are imported type-only, so the copy that
 * could drift is gone.
 */
const HOOK_APPROVAL_BEHAVIOR_IS_THE_HOOKS_VOCABULARY: Equal<
  HookApprovalBehavior,
  HookDecisionValue
> = true;

/**
 * A compile-time pin on the approval shapes.
 *
 * The `PermissionRequest` approval is a **narrowing** of the general one, so the
 * two are one concept and not two copies of it.
 */
const PERMISSION_REQUEST_APPROVAL_IS_A_HOOK_APPROVAL: PermissionRequestHookApproval extends HookApproval
  ? true
  : false = true;

/**
 * A compile-time pin on the narrowing itself.
 *
 * The `PermissionRequest` seam only ever sees `allow` and `deny`; the general
 * approval also knows the `PreToolUse` seam's `ask` and `defer`.
 */
const PERMISSION_REQUEST_BEHAVIOR_IS_THE_NARROWING: Equal<
  NonNullable<PermissionRequestHookApproval['decision']>['behavior'],
  'allow' | 'deny'
> = true;

/**
 * A compile-time pin that the seam is **ready to be wired**.
 *
 * The hooks module's `createPreToolUseApproval` is the approval callback of the
 * `PreToolUse` seam, and it plugs straight in: the seam's `approval` option
 * takes it unchanged. The production call site is the tool runner's
 * (`src/tools/builtins/shared.ts`), which is the next milestone's work.
 */
const HOOKS_MODULE_APPROVAL_FITS_THE_SEAM: (
  ctx: ToolContext,
) => HookApproval | undefined | Promise<HookApproval | undefined> = createPreToolUseApproval([]);

describe('the PreToolUse seam — the precedence', () => {
  it('does not let a PreToolUse approval override a deny rule', async () => {
    let hookRan = false;
    const decision = await checkPermission(tool({ input: { command: 'rm -rf /' } }), {
      rules: rules({ deny: ['Bash(rm *)'] }),
      mode: 'default',
      preToolUseHook: async () => {
        hookRan = true;
        return hookDecision('allow');
      },
    });

    expect(decision.behavior).toBe('deny');
    expect(decision.rule?.content).toBe('Bash(rm *)');
    // The deny list is evaluated before the hook, so the hook never even runs.
    expect(hookRan).toBe(false);
  });

  it('does not let a PreToolUse approval override an ask rule', async () => {
    const decision = await checkPermission(tool({ input: { command: 'git push origin main' } }), {
      rules: rules({ ask: ['Bash(git push *)'] }),
      mode: 'default',
      preToolUseHook: async () => hookDecision('allow'),
    });

    expect(decision.behavior).toBe('ask');
    expect(decision.rule?.content).toBe('Bash(git push *)');
  });

  it('does not let a PreToolUse approval replace the escalation of a partially covered chain', async () => {
    const decision = await checkPermission(
      tool({ input: { command: 'echo hello && rm -rf /' } }),
      {
        rules: rules({ allow: ['Bash(echo *)'] }),
        mode: 'default',
        preToolUseHook: async () => hookDecision('allow'),
      },
    );

    expect(decision.behavior).not.toBe('allow');
    expect(decision.behavior).toBe('ask');
    expect(decision.reasonKind).toBe('subcommandResults');
    expect(decision.subcommandResults?.commands).toEqual(['rm -rf /']);
  });

  it('holds a PreToolUse denial in every mode, bypassPermissions included', async () => {
    for (const mode of MODES) {
      const decision = await checkPermission(tool(), {
        rules: rules(),
        mode,
        preToolUseHook: async () =>
          hookDecision('deny', { reason: 'A PreToolUse hook denied this call.' }),
      });

      expect(decision.behavior, mode).toBe('deny');
      expect(decision.source, mode).toBe('hook');
    }
  });

  it('changes nothing when the PreToolUse hook expresses no opinion', async () => {
    const withoutHook = await checkPermission(tool({ input: { command: 'ls -l' } }), {
      rules: rules(),
      mode: 'default',
    });
    const withHook = await checkPermission(tool({ input: { command: 'ls -l' } }), {
      rules: rules(),
      mode: 'default',
      preToolUseHook: async () => undefined,
    });

    expect(withHook.behavior).toBe(withoutHook.behavior);
    expect(withHook.reasonKind).toBe(withoutHook.reasonKind);
  });

  it('lets a PreToolUse approval replace the generic prompt', async () => {
    const decision = await checkPermission(tool({ input: { command: 'ls -l' } }), {
      rules: rules(),
      mode: 'default',
      preToolUseHook: async () => hookDecision('allow'),
    });

    expect(decision.behavior).toBe('allow');
    expect(decision.source).toBe('hook');
  });
});

describe('the merge of the two hook seams', () => {
  it('gives deny when a PreToolUse approval meets a PermissionRequest denial', async () => {
    const decision = await checkPermission(tool(), {
      rules: rules(),
      mode: 'default',
      preToolUseHook: async () => hookDecision('allow'),
      hook: async () => hookDecision('deny', { reason: 'A PermissionRequest hook denied this call.' }),
    });

    expect(decision.behavior).toBe('deny');
  });

  it('gives deny when a PreToolUse denial meets a PermissionRequest approval', async () => {
    const decision = await checkPermission(tool(), {
      rules: rules(),
      mode: 'default',
      preToolUseHook: async () => hookDecision('deny'),
      hook: async () => hookDecision('allow'),
    });

    expect(decision.behavior).toBe('deny');
  });

  it('gives ask when a PreToolUse question meets a PermissionRequest approval', async () => {
    const decision = await checkPermission(tool(), {
      rules: rules(),
      mode: 'default',
      preToolUseHook: async () => hookDecision('ask'),
      hook: async () => hookDecision('allow'),
    });

    // The stricter decision wins: an ask is stricter than an allow, so the two
    // seams cannot cancel each other.
    expect(decision.behavior).toBe('ask');
  });

  it('gives ask when a PermissionRequest question meets a PreToolUse approval', async () => {
    const decision = await checkPermission(tool(), {
      rules: rules(),
      mode: 'default',
      preToolUseHook: async () => hookDecision('allow'),
      hook: async () => hookDecision('ask'),
    });

    expect(decision.behavior).toBe('ask');
  });

  it('gives allow when both seams approve', async () => {
    const decision = await checkPermission(tool(), {
      rules: rules(),
      mode: 'default',
      preToolUseHook: async () => hookDecision('allow'),
      hook: async () => hookDecision('allow'),
    });

    expect(decision.behavior).toBe('allow');
  });

  it('ranks the behaviors allow below ask below deny', () => {
    expect(permissionStrictness('allow')).toBeLessThan(permissionStrictness('ask'));
    expect(permissionStrictness('ask')).toBeLessThan(permissionStrictness('deny'));
    expect(PERMISSION_STRICTNESS.get('allow')).toBe(1);
    expect(PERMISSION_STRICTNESS.get('ask')).toBe(2);
    expect(PERMISSION_STRICTNESS.get('deny')).toBe(3);
  });

  it('fails closed on a behavior outside the closed vocabulary', () => {
    // The table is a `Map`: a lookup with a key of the caller's own making
    // reaches `undefined` and never `Object.prototype`.
    expect(PERMISSION_STRICTNESS.get('nonsense' as PermissionBehavior)).toBeUndefined();
    expect(permissionStrictness('nonsense' as PermissionBehavior)).toBe(
      PERMISSION_STRICTNESS.get('deny'),
    );
  });
});

describe('the meaning of a PreToolUse question and a PreToolUse deferral', () => {
  it('makes a PreToolUse question the pending question', async () => {
    const canUseTool = vi.fn(async () => undefined);

    const decision = await checkPermission(tool(), {
      rules: rules(),
      mode: 'default',
      preToolUseHook: async () => hookDecision('ask'),
      canUseTool,
    });

    expect(decision.behavior).toBe('ask');
    // The question reaches the prompt: the hook asked for a human decision.
    expect(canUseTool).toHaveBeenCalledTimes(1);
  });

  it("carries the hook's reason and source into the pending question", async () => {
    const canUseTool = vi.fn(async (_ctx: ToolContext, _decision: PermissionDecision) => undefined);

    const decision = await checkPermission(tool(), {
      rules: rules(),
      mode: 'default',
      preToolUseHook: async () =>
        hookDecision('ask', { reason: 'This call touches the production database.' }),
      canUseTool,
    });

    expect(decision.behavior).toBe('ask');
    // The question the user is asked is the hook's question, not the generic one.
    expect(decision.reason).toBe('This call touches the production database.');
    expect(decision.source).toBe('hook');
    // The prompt is asked with that question.
    const [, prompted] = canUseTool.mock.calls[0] ?? [];
    expect(prompted?.reason).toBe('This call touches the production database.');
    expect(prompted?.source).toBe('hook');
  });

  it('does not let a PreToolUse question override a deny rule', async () => {
    const decision = await checkPermission(tool({ input: { command: 'rm -rf /' } }), {
      rules: rules({ deny: ['Bash(rm *)'] }),
      mode: 'default',
      preToolUseHook: async () => hookDecision('ask'),
    });

    expect(decision.behavior).toBe('deny');
  });

  it('does not let an allow rule turn a PreToolUse question into an approval', async () => {
    const decision = await checkPermission(tool({ input: { command: 'ls -l' } }), {
      rules: rules({ allow: ['Bash(ls *)'] }),
      mode: 'default',
      preToolUseHook: async () => hookDecision('ask'),
    });

    // A question is stricter than an approval: the allow rule does not answer it.
    expect(decision.behavior).toBe('ask');
  });

  it('holds a PreToolUse question in bypassPermissions', async () => {
    const decision = await checkPermission(tool({ input: { command: 'ls -l' } }), {
      rules: rules(),
      mode: 'bypassPermissions',
      preToolUseHook: async () => hookDecision('ask'),
    });

    expect(decision.behavior).toBe('ask');
  });

  it('denies rather than asks when a PreToolUse question meets dontAsk', async () => {
    const canUseTool = vi.fn(async () => undefined);

    const decision = await checkPermission(tool(), {
      rules: rules(),
      mode: 'dontAsk',
      preToolUseHook: async () => hookDecision('ask'),
      canUseTool,
    });

    expect(decision.behavior).toBe('deny');
    // `dontAsk` never consults the prompt.
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('treats a deferral as no opinion, so the normal permission path decides', async () => {
    const preToolUseHook = createPreToolUseHook({
      approval: async () => ({ decision: { behavior: 'defer' } }),
    });

    // No rule matched: the normal path asks.
    const asked = await checkPermission(tool({ input: { command: 'ls -l' } }), {
      rules: rules(),
      mode: 'default',
      preToolUseHook,
    });
    expect(asked.behavior).toBe('ask');
    expect(asked.source).not.toBe('hook');

    // An allow rule matched: the normal path allows. A deferral does not deny.
    const allowed = await checkPermission(tool({ input: { command: 'ls -l' } }), {
      rules: rules({ allow: ['Bash(ls *)'] }),
      mode: 'default',
      preToolUseHook,
    });
    expect(allowed.behavior).toBe('allow');
  });

  it('maps a hook approval that carries no decision to no opinion', async () => {
    const preToolUseHook = createPreToolUseHook({
      approval: async () => ({ hookEventName: 'PreToolUse' }),
    });

    const decision = await checkPermission(tool({ input: { command: 'ls -l' } }), {
      rules: rules(),
      mode: 'default',
      preToolUseHook,
    });

    expect(decision.behavior).toBe('ask');
    expect(decision.source).not.toBe('hook');
  });

  it('takes an ask from the hooks module as the pending question', async () => {
    // The hooks module's `PreToolUse` decision vocabulary has four values; the
    // permission layer takes the `ask` as the question the prompt asks.
    const preToolUseHook = createPreToolUseHook({
      approval: async () => ({
        hookEventName: 'PreToolUse',
        decision: { behavior: 'ask', reason: 'The hook wants a human to look at this.' },
      }),
    });

    const canUseTool = vi.fn(async () => undefined);
    const decision = await checkPermission(tool({ input: { command: 'ls -l' } }), {
      rules: rules(),
      mode: 'default',
      preToolUseHook,
      canUseTool,
    });

    expect(decision.behavior).toBe('ask');
    expect(decision.source).toBe('hook');
    expect(decision.reason).toBe('The hook wants a human to look at this.');
    expect(canUseTool).toHaveBeenCalledTimes(1);
  });
});

describe('the PreToolUse rewrite', () => {
  it('runs the whole check again against the effective input', async () => {
    const preToolUseHook = createPreToolUseHook({
      approval: async () => ({
        decision: { behavior: 'allow' },
        updatedInput: { command: 'rm -rf /' },
      }),
    });

    const decision = await checkPermission(tool({ input: { command: 'ls -l' } }), {
      rules: rules({ deny: ['Bash(rm *)'] }),
      mode: 'default',
      preToolUseHook,
    });

    // The rewrite moved the call onto a path the deny list covers: the check runs
    // again against the effective input, and the stricter verdict wins.
    expect(decision.behavior).toBe('deny');
    expect(decision.rule?.content).toBe('Bash(rm *)');
  });

  it('makes the effective input the input the tool receives', async () => {
    const preToolUseHook = createPreToolUseHook({
      approval: async () => ({
        decision: { behavior: 'allow' },
        updatedInput: { command: 'ls /var' },
      }),
    });

    const decision = await checkPermission(tool({ input: { command: 'ls -l' } }), {
      rules: rules({ allow: ['Bash(ls *)'] }),
      mode: 'default',
      preToolUseHook,
    });

    expect(effectiveInput(decision, { command: 'ls -l' })).toEqual({ command: 'ls /var' });
  });

  it('does not downgrade a hook approval to an ask because the hook rewrote the input', async () => {
    const preToolUseHook = createPreToolUseHook({
      approval: async () => ({
        decision: { behavior: 'allow' },
        updatedInput: { command: 'ls /var' },
      }),
    });

    const decision = await checkPermission(tool({ input: { command: 'ls -l' } }), {
      rules: rules(),
      mode: 'default',
      preToolUseHook,
    });

    // The hook approved the call and produced the rewrite, so its approval
    // covers the input it produced: the rewrite alone does not escalate the
    // call to a prompt.
    expect(decision.behavior).toBe('allow');
    expect(decision.source).toBe('hook');
    expect(decision.updatedInput).toEqual({ command: 'ls /var' });
  });

  it('keeps the rewrite when the prompt resolves the call', async () => {
    const preToolUseHook = createPreToolUseHook({
      approval: async () => ({
        decision: { behavior: 'allow' },
        updatedInput: { command: 'ls /var' },
      }),
    });
    const canUseTool = vi.fn(
      async (_ctx: ToolContext, _decision: PermissionDecision) =>
        ({
          behavior: 'allow' as const,
          source: 'user_temporary' as const,
          reasonType: 'other' as const,
        }) as PermissionDecision,
    );

    const decision = await checkPermission(
      tool({ input: { command: 'git push origin main' } }),
      {
        rules: rules({ ask: ['Bash(git push *)'] }),
        mode: 'default',
        preToolUseHook,
        canUseTool,
      },
    );

    // The prompt showed the call that will really run.
    expect(canUseTool).toHaveBeenCalledTimes(1);
    const [prompted] = canUseTool.mock.calls[0] ?? [];
    expect(prompted?.input).toEqual({ command: 'ls /var' });

    // The user's answer is a decision about that input, so the rewrite rides
    // along with it: the input the tool receives is the rewritten one.
    expect(decision.behavior).toBe('allow');
    expect(decision.updatedInput).toEqual({ command: 'ls /var' });
    expect(effectiveInput(decision, { command: 'git push origin main' })).toEqual({
      command: 'ls /var',
    });
  });

  it('keeps the rewrite when the prompt resolves a hook question', async () => {
    const preToolUseHook = createPreToolUseHook({
      approval: async () => ({
        decision: { behavior: 'ask', reason: 'A human has to look at this.' },
        updatedInput: { command: 'ls /var' },
      }),
    });
    const canUseTool = vi.fn(
      async (_ctx: ToolContext, _decision: PermissionDecision) =>
        ({
          behavior: 'allow' as const,
          source: 'user_temporary' as const,
          reasonType: 'other' as const,
        }) as PermissionDecision,
    );

    const decision = await checkPermission(tool({ input: { command: 'ls -l' } }), {
      rules: rules(),
      mode: 'default',
      preToolUseHook,
      canUseTool,
    });

    expect(canUseTool).toHaveBeenCalledTimes(1);
    const [prompted] = canUseTool.mock.calls[0] ?? [];
    expect(prompted?.input).toEqual({ command: 'ls /var' });
    expect(decision.behavior).toBe('allow');
    expect(decision.updatedInput).toEqual({ command: 'ls /var' });
  });

  it('keeps the rewrite on an ask that no prompt resolved', async () => {
    const preToolUseHook = createPreToolUseHook({
      approval: async () => ({
        decision: { behavior: 'ask', reason: 'A human has to look at this.' },
        updatedInput: { command: 'ls /var' },
      }),
    });

    const decision = await checkPermission(tool({ input: { command: 'ls -l' } }), {
      rules: rules(),
      mode: 'default',
      preToolUseHook,
    });

    // A rewrite is never lost: the decision records the effective input even
    // when the call is still a question.
    expect(decision.behavior).toBe('ask');
    expect(decision.updatedInput).toEqual({ command: 'ls /var' });
  });

  it('denies the call when the rewritten input is rejected by the tool validator', async () => {
    const preToolUseHook = createPreToolUseHook({
      approval: async () => ({
        decision: { behavior: 'allow' },
        updatedInput: { command: '' },
      }),
    });

    const decision = await checkPermission(tool({ input: { command: 'ls -l' } }), {
      rules: rules(),
      mode: 'default',
      preToolUseHook,
      validate: (input) => {
        const command =
          typeof input === 'object' && input !== null
            ? (input as Record<string, unknown>)['command']
            : undefined;
        if (typeof command !== 'string' || command.length === 0) {
          return { ok: false, message: 'the command argument is missing', errorCode: 3 };
        }
        return { ok: true };
      },
    });

    expect(decision.behavior).toBe('deny');
    expect(decision.reason).toContain('the command argument is missing');
  });

  it('runs the safety check against the rewritten input', async () => {
    const preToolUseHook = createPreToolUseHook({
      approval: async () => ({
        decision: { behavior: 'allow' },
        updatedInput: { url: 'not-a-url' },
      }),
    });

    const decision = await checkPermission(
      tool({ toolName: 'WebFetch', input: { url: 'https://example.com' } }),
      {
        rules: rules(),
        mode: 'default',
        preToolUseHook,
        safetyCheck: safetyCheckForTool,
      },
    );

    expect(decision.behavior).toBe('deny');
    expect(decision.reasonType).toBe('safetyCheck');
    expect(decision.source).toBe('hook');
  });

  it('runs the safety check and the validator once each, on the effective input', async () => {
    const preToolUseHook = createPreToolUseHook({
      approval: async () => ({
        decision: { behavior: 'allow' },
        updatedInput: { command: 'ls /var' },
      }),
    });

    const seen: unknown[] = [];
    const safetyCheck = vi.fn((ctx: ToolContext) => {
      seen.push(ctx.input);
      return undefined;
    });
    const validate = vi.fn((input: unknown) => {
      seen.push(input);
      return { ok: true as const };
    });

    await checkPermission(tool({ input: { command: 'ls -l' } }), {
      rules: rules(),
      mode: 'default',
      preToolUseHook,
      safetyCheck,
      validate,
    });

    // A caller-supplied check that is not idempotent sees one invocation per
    // call, and it sees the input the tool would act on.
    expect(safetyCheck).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ command: 'ls /var' }, { command: 'ls /var' }]);
  });

  it('keeps the denial of the hook when the check runs again against the effective input', async () => {
    const preToolUseHook = createPreToolUseHook({
      approval: async (ctx) => {
        const command =
          typeof ctx.input === 'object' && ctx !== null && ctx.input !== null
            ? (ctx.input as Record<string, unknown>)['command']
            : undefined;
        if (command === 'ls /var') {
          return { decision: { behavior: 'deny', reason: 'The rewritten path is not allowed.' } };
        }
        return {
          decision: { behavior: 'allow' },
          updatedInput: { command: 'ls /var' },
        };
      },
    });

    const decision = await checkPermission(tool({ input: { command: 'ls -l' } }), {
      rules: rules(),
      mode: 'default',
      preToolUseHook,
    });

    // The re-check consults the hook with the rewritten input, and the hook's
    // denial still speaks: a rewrite must not launder itself.
    expect(decision.behavior).toBe('deny');
    expect(decision.reason).toContain('The rewritten path is not allowed.');
  });
});

describe('a hook that fails', () => {
  it('denies the call when the PreToolUse hook throws', async () => {
    const decision = await checkPermission(tool(), {
      rules: rules(),
      mode: 'default',
      preToolUseHook: async () => {
        throw new Error('the hook crashed');
      },
    });

    // A hook failure is neither a crash nor a bypass: the call is refused.
    expect(decision.behavior).toBe('deny');
    expect(decision.source).toBe('hook');
    expect(decision.reason).toContain('the hook crashed');
  });

  it('denies the call when the PermissionRequest hook throws', async () => {
    const decision = await checkPermission(tool(), {
      rules: rules(),
      mode: 'default',
      hook: async () => {
        throw new Error('the hook crashed');
      },
    });

    expect(decision.behavior).toBe('deny');
    expect(decision.source).toBe('hook');
    expect(decision.reason).toContain('the hook crashed');
  });

  it('gives a hook denial without a reason a reason', async () => {
    const decision = await checkPermission(tool(), {
      rules: rules(),
      mode: 'default',
      preToolUseHook: async () => ({
        behavior: 'deny',
        source: 'hook',
        reasonType: 'other',
      }),
    });

    expect(decision.behavior).toBe('deny');
    expect(decision.reason).toBeTypeOf('string');
    expect(decision.reason?.length).toBeGreaterThan(0);
  });
});

describe('the PreToolUse seam and the plan-shaped option', () => {
  it('accepts a caller written against the plan', async () => {
    const decision = await checkPermission(tool(), {
      rules: rules(),
      mode: 'default',
      preToolUseHook: PLAN_SIGNED_PRE_TOOL_USE_HOOK,
    });

    expect(decision.behavior).toBe('ask');
    expect(BEHAVIOR_VOCABULARY_HAS_NO_DEFER).toBe(true);
    expect(PRE_TOOL_USE_HOOK_IS_EXACTLY_THE_PLAN_SIGNATURE).toBe(true);
    expect(HOOK_APPROVAL_BEHAVIOR_IS_THE_HOOKS_VOCABULARY).toBe(true);
    expect(PERMISSION_REQUEST_APPROVAL_IS_A_HOOK_APPROVAL).toBe(true);
    expect(PERMISSION_REQUEST_BEHAVIOR_IS_THE_NARROWING).toBe(true);
    expect(HOOKS_MODULE_APPROVAL_FITS_THE_SEAM).toBeTypeOf('function');
  });

  it('takes the hook approval form the hooks module produces', async () => {
    // The hooks module's approval carries no `behavior`, `source` or `reasonType`:
    // the permission layer maps it into a decision.
    const approval: HookApproval = {
      hookEventName: 'PreToolUse',
      decision: { behavior: 'allow' },
    };

    const preToolUseHook = createPreToolUseHook({ approval: async () => approval });

    const decision = await checkPermission(tool({ input: { command: 'ls -l' } }), {
      rules: rules(),
      mode: 'default',
      preToolUseHook,
    });

    expect(decision.behavior).toBe('allow');
    expect(decision.source).toBe('hook');
  });

  it('names the hook event in the reason', async () => {
    const preToolUseHook = createPreToolUseHook({
      approval: async () => ({
        hookEventName: 'CustomGuard',
        decision: { behavior: 'deny' },
      }),
    });

    const decision = await checkPermission(tool(), {
      rules: rules(),
      mode: 'default',
      preToolUseHook,
    });

    expect(decision.behavior).toBe('deny');
    // The hook's own event name names it in the reason.
    expect(decision.reason).toContain('CustomGuard');
  });

  it("names the hook event of a PermissionRequest denial in the reason", () => {
    const decision = applyPermissionRequestHook(
      { hookEventName: 'CustomGuard', decision: { behavior: 'deny' } },
      tool(),
    );

    expect(decision?.behavior).toBe('deny');
    expect(decision?.reason).toContain('CustomGuard');
  });
});

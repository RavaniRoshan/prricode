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
 * effective input, and a rewritten input the tool's validator rejects denies the
 * call).
 */

import { describe, expect, it, vi } from 'vitest';

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
  createPreToolUseHook,
  effectiveInput,
  safetyCheckForTool,
  type HookApproval,
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
 * so a caller written against the plan must still compile.
 */
const PLAN_SIGNED_PRE_TOOL_USE_HOOK: CheckPermissionOptions['preToolUseHook'] = async () => {
  const decision: PermissionDecision | undefined = undefined;
  return decision;
};

/**
 * A compile-time pin on the behavior vocabulary.
 *
 * The vocabulary is closed and has **no** `defer`: a hook that defers has no word
 * in the permission decision, so it cannot be anything but an absence of opinion.
 */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
const BEHAVIOR_VOCABULARY_HAS_NO_DEFER: Equal<PermissionBehavior, 'allow' | 'deny' | 'ask'> =
  true;

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
    expect(PERMISSION_STRICTNESS.allow).toBe(1);
    expect(PERMISSION_STRICTNESS.ask).toBe(2);
    expect(PERMISSION_STRICTNESS.deny).toBe(3);
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

  it('denies the call when the rewritten input is rejected by the tool validator', async () => {
    const preToolUseHook = createPreToolUseHook({
      approval: async () => ({
        decision: { behavior: 'allow' },
        updatedInput: { command: '' },
      }),
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

    const decision = await checkPermission(tool({ input: { command: 'ls -l' } }), {
      rules: rules(),
      mode: 'default',
      preToolUseHook,
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
      safetyCheck: safetyCheckForTool,
    });

    const decision = await checkPermission(
      tool({ toolName: 'WebFetch', input: { url: 'https://example.com' } }),
      {
        rules: rules(),
        mode: 'default',
        preToolUseHook,
      },
    );

    expect(decision.behavior).toBe('deny');
    expect(decision.reasonType).toBe('safetyCheck');
    expect(decision.source).toBe('hook');
  });

  it('keeps the denial of the hook when the check runs again against the effective input', async () => {
    const preToolUseHook = createPreToolUseHook({
      approval: async (ctx) => {
        const command =
          typeof ctx.input === 'object' && ctx.input !== null
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

describe('the PreToolUse seam and the plan-shaped option', () => {
  it('accepts a caller written against the plan', async () => {
    const decision = await checkPermission(tool(), {
      rules: rules(),
      mode: 'default',
      preToolUseHook: PLAN_SIGNED_PRE_TOOL_USE_HOOK,
    });

    expect(decision.behavior).toBe('ask');
    expect(BEHAVIOR_VOCABULARY_HAS_NO_DEFER).toBe(true);
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
});

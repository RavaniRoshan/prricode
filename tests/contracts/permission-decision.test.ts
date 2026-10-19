/**
 * Contract test for the permission decision vocabulary, the rule engine, the
 * permission modes, the start-mode resolution, and the approval paths.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.5 (Permissions) and the
 * `CC-007` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * The test pins the closed vocabularies (behavior, source, reason type), the rule
 * precedence (`deny` → `ask` → `allow`, first match wins, specificity irrelevant),
 * the compound-command breakdown, the reason text, the mode semantics, the start-mode
 * precedence, and the remote `can_use_tool` dispatcher.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  checkPermission,
  collectRuleWarnings,
  describeReason,
  evaluateRules,
  normalizePermissionMode,
  permissionsFromSettings,
  resolveStartMode,
  type PermissionDecision,
  type RuleSet,
  type ToolContext,
} from '../../src/permissions/decision.js';
import type { SettingsLoadResult } from '../../src/config/loader.js';
import type { SettingsSource, SettingsTier } from '../../src/config/tiers.js';
import {
  applyPermissionRequestHook,
  buildApprovalPrompt,
  createTransportPermissionDispatcher,
  effectiveInput,
  safetyCheckForTool,
} from '../../src/permissions/prompts.js';

const WORKDIR = '/work';

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

/**
 * A **compile-time** pin on the rule engine's return type.
 *
 * A rule is a pure predicate: it decides, it never rewrites. The decision type
 * carries an optional `updatedInput` because the **hook** path uses it, so the pin is
 * on the *rule* decision type: its `updatedInput` must be `never`.
 */
type AssertFalse<T extends boolean> = [T] extends [true] ? never : false;
type RuleDecision = NonNullable<ReturnType<typeof evaluateRules>>;
type RuleDecisionInput = RuleDecision extends { updatedInput?: infer T } ? T : 'absent';
type RulesNeverRewriteInput = [unknown] extends [RuleDecisionInput] ? true : false;
const RULE_DECISION_CANNOT_CARRY_A_REWRITTEN_INPUT: AssertFalse<RulesNeverRewriteInput> = false;

describe('the permission decision vocabulary', () => {
  it('uses only the closed behavior, source and reason-type vocabularies', () => {
    const behaviors = new Set(['allow', 'deny', 'ask']);
    const sources = new Set([
      'classifier',
      'hook',
      'user_permanent',
      'user_temporary',
      'user_abort',
      'user_reject',
      'unknown',
    ]);
    const reasonTypes = new Set(['rule', 'safetyCheck', 'other']);

    const decision = evaluateRules(rules({ deny: ['Bash(rm *)'] }), tool({ input: { command: 'rm x' } }));

    expect(decision).toBeDefined();
    expect(behaviors.has(decision?.behavior ?? '')).toBe(true);
    expect(sources.has(decision?.source ?? '')).toBe(true);
    expect(reasonTypes.has(decision?.reasonType ?? '')).toBe(true);
  });

  it('returns deny for a matching deny rule', () => {
    const decision = evaluateRules(rules({ deny: ['Bash(rm *)'] }), tool({ input: { command: 'rm -rf /tmp/x' } }));

    expect(decision?.behavior).toBe('deny');
    expect(decision?.reasonType).toBe('rule');
    expect(decision?.rule?.content).toBe('Bash(rm *)');
    expect(decision?.rule?.source).toBe('userSettings');
  });

  it('returns allow when only an allow rule matches', () => {
    const decision = evaluateRules(rules({ allow: ['Bash(ls *)'] }), tool({ input: { command: 'ls -l' } }));

    expect(decision?.behavior).toBe('allow');
    expect(decision?.reasonType).toBe('rule');
  });

  it('returns ask when only an ask rule matches', () => {
    const decision = evaluateRules(
      rules({ ask: ['Bash(git push *)'] }),
      tool({ input: { command: 'git push origin main' } }),
    );

    expect(decision?.behavior).toBe('ask');
    expect(decision?.reasonType).toBe('rule');
  });

  it('returns undefined when nothing matches so the caller can escalate', () => {
    expect(evaluateRules(rules(), tool({ input: { command: 'ls -l' } }))).toBeUndefined();
  });

  it('never rewrites the tool input from a rule', () => {
    const decision = evaluateRules(rules({ allow: ['Bash(ls *)'] }), tool({ input: { command: 'ls -l' } }));

    expect(decision).toBeDefined();
    expect(decision && 'updatedInput' in decision).toBe(false);
    // The compile-time pin is the real one: `npx tsc --noEmit` fails if the rule
    // decision type ever grows an `updatedInput` that could carry a value.
    expect(RULE_DECISION_CANNOT_CARRY_A_REWRITTEN_INPUT).toBe(false);
  });
});

describe('rule precedence', () => {
  it('scans the deny list before the ask list and the ask list before the allow list', () => {
    const decision = evaluateRules(
      rules({ deny: ['Bash(rm *)'], ask: ['Bash(rm *)'], allow: ['Bash(rm *)'] }),
      tool({ input: { command: 'rm x' } }),
    );

    expect(decision?.behavior).toBe('deny');
  });

  it('scans the ask list before the allow list', () => {
    const decision = evaluateRules(
      rules({ ask: ['Bash(rm *)'], allow: ['Bash(rm *)'] }),
      tool({ input: { command: 'rm x' } }),
    );

    expect(decision?.behavior).toBe('ask');
  });

  it('ignores specificity: the first matching rule in a list wins', () => {
    const decision = evaluateRules(
      rules({ deny: ['Bash(aws *)', 'Bash(aws s3 ls)'] }),
      tool({ input: { command: 'aws s3 ls' } }),
    );

    // The broad rule is listed first, so it is the rule that matched — the narrower
    // rule never gets a chance to be more specific.
    expect(decision?.rule?.content).toBe('Bash(aws *)');
  });

  it('lets a negation in the same list cancel a matching rule', () => {
    const decision = evaluateRules(
      rules({ deny: ['Bash(rm *)', '!Bash(rm -rf /)'] }),
      tool({ input: { command: 'rm -rf /' } }),
    );

    expect(decision).toBeUndefined();
  });

  it('keeps a negation from cancelling a rule from another tier', () => {
    const decision = evaluateRules(
      rules({
        deny: ['Bash(rm *)'],
        ruleSources: { 'Bash(rm *)': 'userSettings', '!Bash(rm -rf /)': 'projectSettings' },
      }),
      tool({ input: { command: 'rm -rf /' } }),
    );

    expect(decision?.behavior).toBe('deny');
  });
});

describe('compound commands', () => {
  it('matches every sub-command independently and names only the offending ones', () => {
    const decision = evaluateRules(rules({ ask: ['Bash(b)'] }), tool({ input: { command: 'a && b' } }));

    expect(decision?.behavior).toBe('ask');
    expect(decision?.reasonKind).toBe('subcommandResults');
    expect(decision?.subcommandResults?.commands).toEqual(['b']);
    expect(decision?.subcommandResults?.count).toBe(1);
    expect(decision?.subcommandResults?.total).toBe(2);

    const text = describeReason(decision as PermissionDecision, 'Bash');
    expect(text).toContain('b');
    expect(text).toContain('1');
    expect(text).not.toContain('a && b');
  });

  it('strips redirections from the listed sub-commands', () => {
    const decision = evaluateRules(rules({ ask: ['Bash(b)'] }), tool({ input: { command: 'b > out.txt' } }));

    expect(decision?.subcommandResults?.commands).toEqual(['b']);
  });

  it('splits on every documented operator', () => {
    for (const separator of ['&&', '||', ';', '|', '|&', '&', '\n']) {
      const decision = evaluateRules(
        rules({ deny: ['Bash(boom)'] }),
        tool({ input: { command: `first ${separator} boom` } }),
      );
      expect(decision?.behavior, `separator ${JSON.stringify(separator)}`).toBe('deny');
    }
  });

  it('does not split inside a quoted string', () => {
    const decision = evaluateRules(rules({ deny: ['Bash(boom)'] }), tool({ input: { command: `echo 'a && boom'` } }));

    expect(decision).toBeUndefined();
  });

  it('strips a shell wrapper before matching', () => {
    const decision = evaluateRules(rules({ deny: ['Bash(rm *)'] }), tool({ input: { command: 'timeout 5 rm x' } }));

    expect(decision?.behavior).toBe('deny');
  });

  it('does not strip quoted text before matching', () => {
    const decision = evaluateRules(rules({ deny: ['Bash(*rm -rf*)'] }), tool({ input: { command: "echo 'rm -rf /'" } }));

    expect(decision?.behavior).toBe('deny');
  });
});

describe('describeReason', () => {
  it('names the rule and the tier it came from', () => {
    const decision = evaluateRules(
      rules({ ask: ['Bash(git push *)'] }),
      tool({ input: { command: 'git push origin main' } }),
    );

    expect(describeReason(decision as PermissionDecision, 'Bash')).toBe(
      "Permission rule 'Bash(git push *)' from userSettings requires approval for this Bash command.",
    );
  });

  it('renders the sandbox override text verbatim', () => {
    const decision: PermissionDecision = {
      behavior: 'ask',
      source: 'unknown',
      reasonType: 'other',
      reasonKind: 'sandboxOverride',
    };

    expect(describeReason(decision, 'Bash')).toBe('Run outside of the sandbox');
  });

  it('renders the working-directory reason', () => {
    const decision: PermissionDecision = {
      behavior: 'allow',
      source: 'unknown',
      reasonType: 'other',
      reasonKind: 'workingDir',
    };

    expect(describeReason(decision, 'Edit')).toContain('working directory');
  });

  it('renders the safety-check reason', () => {
    const decision: PermissionDecision = {
      behavior: 'deny',
      source: 'hook',
      reasonType: 'safetyCheck',
      reasonKind: 'safetyCheck',
      reason: 'The fetch arguments could not be verified, so nothing was fetched.',
    };

    expect(describeReason(decision, 'WebFetch')).toContain('nothing was fetched');
  });

  it('names the tool for a permission-prompt-tool reason', () => {
    const decision: PermissionDecision = {
      behavior: 'ask',
      source: 'unknown',
      reasonType: 'other',
      reasonKind: 'permissionPromptTool',
    };

    expect(describeReason(decision, 'WebFetch')).toContain('WebFetch');
  });
});

describe('the hook rewrite path', () => {
  it('carries a hook-approved updated input on the decision', () => {
    const hook = { decision: { behavior: 'allow' as const }, updatedInput: { command: 'ls' } };

    const decision = applyPermissionRequestHook(hook, tool({ input: { command: 'rm -rf /' } }));

    expect(decision?.behavior).toBe('allow');
    expect(decision?.source).toBe('hook');
    expect(decision?.updatedInput).toEqual({ command: 'ls' });
  });

  it('makes the modified input the input the tool receives', () => {
    const hook = { decision: { behavior: 'allow' as const }, updatedInput: { command: 'ls' } };

    const decision = applyPermissionRequestHook(hook, tool({ input: { command: 'rm -rf /' } }));
    const observed = effectiveInput(decision as PermissionDecision, { command: 'rm -rf /' });

    expect(observed).toEqual({ command: 'ls' });
  });

  it('denies the call when the rewritten input fails the tool validator', () => {
    const hook = { decision: { behavior: 'allow' as const }, updatedInput: { file_path: 42 } };

    const decision = applyPermissionRequestHook(
      hook,
      tool({ toolName: 'Edit', input: { file_path: '/work/a.txt' } }),
      {
        validate: (input: unknown) => {
          const filePath =
            typeof input === 'object' && input !== null
              ? (input as Record<string, unknown>)['file_path']
              : undefined;
          return typeof filePath === 'string'
            ? { ok: true as const }
            : { ok: false as const, message: 'file_path must be a string', errorCode: 7 };
        },
      },
    );

    expect(decision?.behavior).toBe('deny');
    expect(decision?.updatedInput).toBeUndefined();
  });

  it('honours a hook denial', () => {
    const hook = { decision: { behavior: 'deny' as const, reason: 'not allowed here' } };

    const decision = applyPermissionRequestHook(hook, tool());

    expect(decision?.behavior).toBe('deny');
    expect(decision?.source).toBe('hook');
    expect(decision?.reason).toContain('not allowed here');
  });
});

describe('the safety check', () => {
  it('refuses a WebFetch a PermissionRequest hook approved with unverifiable arguments', () => {
    const hook = {
      decision: { behavior: 'allow' as const },
      updatedInput: { url: 'not-a-url' },
      classifierApprovable: false,
    };

    const decision = applyPermissionRequestHook(
      hook,
      tool({ toolName: 'WebFetch', input: { url: 'https://example.com' } }),
      { safetyCheck: safetyCheckForTool },
    );

    expect(decision?.behavior).toBe('deny');
    expect(decision?.reasonType).toBe('safetyCheck');
    expect(decision?.reason).toContain('nothing was fetched');
  });

  it('does not report the refusal as a user denial', () => {
    const hook = {
      decision: { behavior: 'allow' as const },
      updatedInput: { url: 'not-a-url' },
      classifierApprovable: false,
    };

    const decision = applyPermissionRequestHook(
      hook,
      tool({ toolName: 'WebFetch', input: { url: 'https://example.com' } }),
      { safetyCheck: safetyCheckForTool },
    );

    expect(decision?.source).not.toBe('user_reject');
    expect(decision?.source).not.toBe('user_abort');
  });

  it('allows the call when the hook-approved arguments verify', () => {
    const hook = {
      decision: { behavior: 'allow' as const },
      updatedInput: { url: 'https://example.com/page' },
    };

    const decision = applyPermissionRequestHook(
      hook,
      tool({ toolName: 'WebFetch', input: { url: 'https://example.com' } }),
      { safetyCheck: safetyCheckForTool },
    );

    expect(decision?.behavior).toBe('allow');
  });
});

describe('the permission modes', () => {
  it('denies rather than prompts in dontAsk', async () => {
    const canUseTool = vi.fn(async () => ({
      behavior: 'allow' as const,
      source: 'user_temporary' as const,
      reasonType: 'other' as const,
    }));

    const decision = await checkPermission(tool(), { rules: rules(), mode: 'dontAsk', canUseTool });

    expect(decision.behavior).toBe('deny');
  });

  it('never consults canUseTool in dontAsk', async () => {
    const canUseTool = vi.fn(async () => ({
      behavior: 'allow' as const,
      source: 'user_temporary' as const,
      reasonType: 'other' as const,
    }));

    await checkPermission(tool(), { rules: rules(), mode: 'dontAsk', canUseTool });

    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('denies AskUserQuestion even if an allow rule matches', async () => {
    const decision = await checkPermission(
      tool({ toolName: 'AskUserQuestion', input: {} }),
      { rules: rules({ allow: ['AskUserQuestion'] }), mode: 'dontAsk' },
    );

    expect(decision.behavior).toBe('deny');
  });

  it('denies an MCP tool that requires user interaction even if an allow rule matches', async () => {
    const decision = await checkPermission(
      tool({ toolName: 'mcp__server__ask', input: { requiresUserInteraction: true } }),
      { rules: rules({ allow: ['mcp__server__ask'] }), mode: 'dontAsk' },
    );

    expect(decision.behavior).toBe('deny');
  });

  it('denies a network-path read even if an allow rule matches', async () => {
    const decision = await checkPermission(
      tool({ toolName: 'Read', input: { file_path: '//server/share/secret.txt' } }),
      { rules: rules({ allow: ['Read(//server/share/**)'] }), mode: 'dontAsk' },
    );

    expect(decision.behavior).toBe('deny');
  });

  it('denies an org-ask connector tool even if an allow rule matches', async () => {
    const decision = await checkPermission(
      tool({ toolName: 'mcp__connector__org_ask', input: {} }),
      { rules: rules({ allow: ['mcp__connector__org_ask'] }), mode: 'dontAsk' },
    );

    expect(decision.behavior).toBe('deny');
  });

  it('blocks a deny rule in every mode, including bypassPermissions', async () => {
    const modes = [
      'default',
      'manual',
      'acceptEdits',
      'plan',
      'auto',
      'dontAsk',
      'bypassPermissions',
    ] as const;

    for (const mode of modes) {
      const decision = await checkPermission(tool({ input: { command: 'rm -rf /' } }), {
        rules: rules({ deny: ['Bash(rm *)'] }),
        mode,
      });
      expect(decision.behavior, `mode ${mode}`).toBe('deny');
    }
  });

  it('gives an allow rule no effect in bypassPermissions', async () => {
    const decision = await checkPermission(tool({ input: { command: 'ls -l' } }), {
      rules: rules({ allow: ['Bash(ls *)'] }),
      mode: 'bypassPermissions',
    });

    expect(decision.behavior).toBe('allow');
    // The allow rule was not consulted, so it is not recorded on the decision.
    expect(decision.rule).toBeUndefined();
  });

  it('still prompts for an ask rule in bypassPermissions', async () => {
    const decision = await checkPermission(tool({ input: { command: 'git push origin main' } }), {
      rules: rules({ ask: ['Bash(git push *)'] }),
      mode: 'bypassPermissions',
    });

    expect(decision.behavior).toBe('ask');
  });

  it('never auto-approves a file edit in plan mode, even with a matching allow rule', async () => {
    const decision = await checkPermission(
      tool({ toolName: 'Edit', input: { file_path: '/work/a.txt' } }),
      { rules: rules({ allow: ['Edit(a.txt)'] }), mode: 'plan' },
    );

    expect(decision.behavior).toBe('ask');
  });

  it('resolves the manual alias to default', () => {
    expect(normalizePermissionMode('manual')).toBe('default');
  });

  it('auto-approves an edit inside the working directory in acceptEdits', async () => {
    const decision = await checkPermission(
      tool({ toolName: 'Edit', input: { file_path: '/work/a.txt' } }),
      { rules: rules(), mode: 'acceptEdits' },
    );

    expect(decision.behavior).toBe('allow');
    expect(decision.reasonKind).toBe('workingDir');
  });

  it('auto-approves a safe shell command inside the working directory in acceptEdits', async () => {
    const decision = await checkPermission(
      tool({ input: { command: 'mkdir /work/build' } }),
      { rules: rules(), mode: 'acceptEdits' },
    );

    expect(decision.behavior).toBe('allow');
    expect(decision.reasonKind).toBe('workingDir');
  });

  it('still prompts for rm on a critical path in acceptEdits', async () => {
    const decision = await checkPermission(tool({ input: { command: 'rm -rf /work' } }), {
      rules: rules(),
      mode: 'acceptEdits',
    });

    expect(decision.behavior).toBe('ask');
  });

  it('asks for a command outside the working directory in acceptEdits', async () => {
    const decision = await checkPermission(tool({ input: { command: 'mkdir /etc/thing' } }), {
      rules: rules(),
      mode: 'acceptEdits',
    });

    expect(decision.behavior).toBe('ask');
  });

  it('fails closed in auto mode when the classifier returns no verdict', async () => {
    const decision = await checkPermission(tool({ input: { command: 'ls -l' } }), {
      rules: rules(),
      mode: 'auto',
    });

    expect(decision.behavior).toBe('deny');
    expect(decision.source).toBe('classifier');
  });

  it('allows a call the auto-mode classifier approves', async () => {
    const decision = await checkPermission(tool({ input: { command: 'ls -l' } }), {
      rules: rules(),
      mode: 'auto',
      classifier: async () => ({ verdict: 'allow' as const }),
    });

    expect(decision.behavior).toBe('allow');
    expect(decision.source).toBe('classifier');
  });

  it('denies a call the auto-mode classifier blocks', async () => {
    const decision = await checkPermission(tool({ input: { command: 'ls -l' } }), {
      rules: rules(),
      mode: 'auto',
      classifier: async () => ({ verdict: 'block' as const, category: 'network' }),
    });

    expect(decision.behavior).toBe('deny');
    expect(decision.source).toBe('classifier');
  });
});

describe('resolveStartMode', () => {
  it('prefers the flag over the settings default', () => {
    expect(
      resolveStartMode({
        flag: 'plan',
        settingsDefault: 'acceptEdits',
        autoAvailable: true,
        autoDisabledByPolicy: false,
        interactive: true,
      }),
    ).toBe('plan');
  });

  it('prefers the settings default over the built-in default', () => {
    expect(
      resolveStartMode({
        settingsDefault: 'acceptEdits',
        autoAvailable: true,
        autoDisabledByPolicy: false,
        interactive: true,
      }),
    ).toBe('acceptEdits');
  });

  it('ignores auto and bypassPermissions written into a settings file', () => {
    expect(
      resolveStartMode({
        settingsDefault: 'auto',
        autoAvailable: true,
        autoDisabledByPolicy: false,
        interactive: false,
      }),
    ).toBe('default');
    expect(
      resolveStartMode({
        settingsDefault: 'bypassPermissions',
        autoAvailable: true,
        autoDisabledByPolicy: false,
        interactive: false,
      }),
    ).toBe('default');
  });

  it('starts in auto for an interactive session when auto mode is available', () => {
    expect(
      resolveStartMode({ autoAvailable: true, autoDisabledByPolicy: false, interactive: true }),
    ).toBe('auto');
  });

  it('starts in default for a headless run', () => {
    expect(
      resolveStartMode({ autoAvailable: true, autoDisabledByPolicy: false, interactive: false }),
    ).toBe('default');
  });

  it('falls back to default when auto mode is disabled by policy', () => {
    expect(
      resolveStartMode({ autoAvailable: true, autoDisabledByPolicy: true, interactive: true }),
    ).toBe('default');
  });

  it('falls back to default when auto mode is unavailable', () => {
    expect(
      resolveStartMode({ autoAvailable: false, autoDisabledByPolicy: false, interactive: true }),
    ).toBe('default');
  });

  it('falls back to default for a HIPAA-configured session', () => {
    expect(
      resolveStartMode({
        autoAvailable: true,
        autoDisabledByPolicy: false,
        interactive: true,
        hipaaConfigured: true,
      }),
    ).toBe('default');
  });

  it('honours an auto flag even when auto mode is unavailable', () => {
    expect(
      resolveStartMode({
        flag: 'auto',
        autoAvailable: false,
        autoDisabledByPolicy: true,
        interactive: false,
      }),
    ).toBe('auto');
  });
});

describe('the approval prompt', () => {
  it('shows the resolved destination rather than the literal command string', () => {
    const decision: PermissionDecision = {
      behavior: 'ask',
      source: 'unknown',
      reasonType: 'other',
      reasonKind: 'permissionPromptTool',
    };

    const prompt = buildApprovalPrompt({
      toolName: 'Bash',
      input: { command: 'cp /work/link.txt /work/out.txt' },
      decision,
      cwd: '/work',
    });

    expect(prompt).toContain('out.txt');
    expect(prompt).not.toContain('cp /work/link.txt /work/out.txt');
  });
});

describe('the settings adapter', () => {
  it('combines the rule lists of every tier and keeps the tier of each rule', () => {
    const loaded: SettingsLoadResult = {
      tiers: new Map<SettingsSource, SettingsTier>([
        [
          'userSettings',
          {
            source: 'userSettings',
            value: { permissions: { allow: ['Bash(ls *)'], defaultMode: 'acceptEdits' } },
          },
        ],
        [
          'projectSettings',
          { source: 'projectSettings', value: { permissions: { deny: ['Bash(ls *)'] } } },
        ],
      ]),
      errors: [],
      readMode: new Map(),
      linkedAway: [],
    };

    const permissions = permissionsFromSettings(loaded, { cwd: '/work', configDir: '/config' });

    expect(permissions.rules.allow).toEqual(['Bash(ls *)']);
    expect(permissions.rules.deny).toEqual(['Bash(ls *)']);
    expect(permissions.defaultMode).toBe('acceptEdits');
    expect(Object.values(permissions.rules.ruleSources ?? {})).toContain('projectSettings');

    // The deny rule of the project tier blocks the call the user tier allows.
    const decision = evaluateRules(permissions.rules, tool({ input: { command: 'ls -l' } }));
    expect(decision?.behavior).toBe('deny');
  });

  it('reads the additional directories the settings declare', () => {
    const loaded: SettingsLoadResult = {
      tiers: new Map<SettingsSource, SettingsTier>([
        [
          'userSettings',
          {
            source: 'userSettings',
            value: { permissions: { additionalDirectories: ['/srv/shared'] } },
          },
        ],
      ]),
      errors: [],
      readMode: new Map(),
      linkedAway: [],
    };

    const permissions = permissionsFromSettings(loaded, { cwd: '/work', configDir: '/config' });

    expect(permissions.rules.additionalDirs).toEqual(['/srv/shared']);
  });

  it('anchors a /path rule against the settings directory of its own tier', () => {    const loaded: SettingsLoadResult = {
      tiers: new Map<SettingsSource, SettingsTier>([
        [
          'projectSettings',
          {
            source: 'projectSettings',
            value: { permissions: { deny: ['Read(/secrets/**)'] } },
          },
        ],
      ]),
      errors: [],
      readMode: new Map(),
      linkedAway: [],
    };

    const permissions = permissionsFromSettings(loaded, { cwd: '/work', configDir: '/config' });

    const decision = evaluateRules(
      permissions.rules,
      tool({ toolName: 'Read', input: { file_path: '/work/.claude/secrets/key' } }),
    );
    expect(decision?.behavior).toBe('deny');
  });
});

describe('the transport permission dispatcher', () => {
  it('drops a can_use_tool request whose request_id is not a string, with no response', async () => {
    const dispatcher = createTransportPermissionDispatcher({
      requestDecision: async () => ({ behavior: 'allow' as const }),
    });

    const result = await dispatcher.dispatch({
      subtype: 'can_use_tool',
      request_id: 42,
      tool_name: 'Bash',
      input: { command: 'ls' },
    });

    expect(result.kind).toBe('dropped');
    if (result.kind === 'response') {
      expect.fail('a non-string request_id must produce no response at all');
    }
  });

  it('drops a request that is not a can_use_tool', async () => {
    const dispatcher = createTransportPermissionDispatcher({
      requestDecision: async () => ({ behavior: 'allow' as const }),
    });

    const result = await dispatcher.dispatch({
      subtype: 'set_model',
      request_id: 'r-1',
      tool_name: 'Bash',
      input: {},
    });

    expect(result.kind).toBe('dropped');
  });

  it('denies a malformed can_use_tool with a synthesized denial', async () => {
    const dispatcher = createTransportPermissionDispatcher({
      requestDecision: async () => ({ behavior: 'allow' as const }),
    });

    const result = await dispatcher.dispatch({
      subtype: 'can_use_tool',
      request_id: 'r-2',
      tool_name: 42,
    });

    expect(result.kind).toBe('response');
    if (result.kind === 'response') {
      expect(result.response.response.behavior).toBe('deny');
      expect(result.response.request_id).toBe('r-2');
    }
  });

  it('does not dispatch an in-flight request id twice', async () => {
    let calls = 0;
    const dispatcher = createTransportPermissionDispatcher({
      requestDecision: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { behavior: 'allow' as const };
      },
    });

    const request = {
      subtype: 'can_use_tool',
      request_id: 'dup-1',
      tool_name: 'Bash',
      input: { command: 'ls' },
    };

    const first = dispatcher.dispatch(request);
    const second = await dispatcher.dispatch(request);

    expect(second.kind).toBe('dropped');
    await first;
    expect(calls).toBe(1);
  });

  it('denies a computer-folder prompt whose input is not exactly three string arguments', async () => {
    const dispatcher = createTransportPermissionDispatcher({
      requestDecision: async () => ({ behavior: 'allow' as const }),
    });

    for (const input of [
      ['/work/folder'],
      ['/work/folder', 'host'],
      ['/work/folder', 'host', 'id', 'extra'],
      ['/work/folder', 'host', 7],
      '/work/folder',
    ]) {
      const result = await dispatcher.dispatch({
        subtype: 'can_use_tool',
        request_id: `cf-${JSON.stringify(input)}`,
        tool_name: 'computer_folder',
        input,
      });

      expect(result.kind, JSON.stringify(input)).toBe('response');
      if (result.kind === 'response') {
        expect(result.response.response.behavior, JSON.stringify(input)).toBe('deny');
      }
    }
  });

  it('denies a folder path or computer name containing CR, LF, U+2028 or U+2029', async () => {
    const dispatcher = createTransportPermissionDispatcher({
      requestDecision: async () => ({ behavior: 'allow' as const }),
    });

    const bad = ['\r', '\n', '\u2028', '\u2029'];
    for (const character of bad) {
      const withPath = await dispatcher.dispatch({
        subtype: 'can_use_tool',
        request_id: `p-${character.codePointAt(0)}`,
        tool_name: 'computer_folder',
        input: [`/work${character}/folder`, 'host', 'id'],
      });
      const withComputer = await dispatcher.dispatch({
        subtype: 'can_use_tool',
        request_id: `c-${character.codePointAt(0)}`,
        tool_name: 'computer_folder',
        input: ['/work/folder', `host${character}`, 'id'],
      });

      expect(withPath.kind).toBe('response');
      expect(withComputer.kind).toBe('response');
      if (withPath.kind === 'response') expect(withPath.response.response.behavior).toBe('deny');
      if (withComputer.kind === 'response') expect(withComputer.response.response.behavior).toBe('deny');
    }
  });

  it('denies a path that is not equal to its own normalized form', async () => {
    const dispatcher = createTransportPermissionDispatcher({
      requestDecision: async () => ({ behavior: 'allow' as const }),
    });

    const result = await dispatcher.dispatch({
      subtype: 'can_use_tool',
      request_id: 'norm-1',
      tool_name: 'computer_folder',
      input: ['/work//folder/../other', 'host', 'id'],
    });

    expect(result.kind).toBe('response');
    if (result.kind === 'response') {
      expect(result.response.response.behavior).toBe('deny');
    }
  });

  it('builds the prompt text from the tool description and the decision reason', async () => {
    let prompt = '';
    const dispatcher = createTransportPermissionDispatcher({
      requestDecision: async (request) => {
        prompt = request.prompt;
        return { behavior: 'allow' as const };
      },
    });

    await dispatcher.dispatch({
      subtype: 'can_use_tool',
      request_id: 'p-1',
      tool_name: 'Bash',
      input: { command: 'curl https://example.com' },
      description: 'Fetch a URL over the network',
      decision_reason: 'The command reaches the network',
    });

    expect(prompt).toContain('Fetch a URL over the network');
    expect(prompt).toContain('The command reaches the network');
  });
});

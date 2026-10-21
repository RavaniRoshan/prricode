/**
 * The agent-team surface: the teammate mode, the name-collision ledger, the
 * cross-session inbound gate and the team lifecycle.
 *
 * Evidence: the target's own source, read out of the pinned build and recorded
 * in `/home/shiva/opt/reference-agent-rea/analysis/findings-agent-teams.md` —
 * every claim there carries a file and a byte offset. The milestone is
 * `CC-034` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The honest boundary.** This implementation has **no team backend**: no
 * account, no teammate service, no cross-session transport, no tmux and no
 * iTerm2. So the surface is **recorded and shaped, never faked**:
 *
 *   - the **mode**'s states, its default, its snapshot and its selection rules
 *     are implemented;
 *   - the **ledger**'s rules are implemented;
 *   - the **inbound gate**'s policy is implemented;
 *   - the operations that would need a teammate runtime or a cross-session
 *     transport **refuse**, and the refusal **names the capability**.
 */

import { describe, expect, it } from 'vitest';

import type { ToolContext } from '../../src/permissions/decision.js';
import type { RuleSet } from '../../src/permissions/rules.js';
import { createAgentTool } from '../../src/tools/builtins/agent.js';
import type { BuiltinToolDeps } from '../../src/tools/builtins/shared.js';
import { TOOL_ERROR_CODES } from '../../src/tools/registry.js';

import {
  AGENT_ID_PATTERN,
  RESERVED_TEAMMATE_NAMES,
  TEAMMATE_RECORD_SOURCES,
  TEAMMATE_SETTLE_VALUES,
  isAgentIdShaped,
  isReservedTeammateName,
  normalizeTeammateName,
  sanitizeTeammateName,
  settleOutcome,
  teammateId,
  uniqueTeammateName,
  validateTeammateName,
} from '../../src/agent/teamLedger.js';
import {
  DEFAULT_TEAMMATE_MODE,
  TEAMMATE_MODES,
  TeammateBackendUnavailableError,
  captureTeammateModeSnapshot,
  clearCliTeammateModeOverride,
  getCliTeammateModeOverride,
  getTeammateModeFromSnapshot,
  hasTeammateModeSnapshot,
  isInProcessEnabled,
  planTeammateExecution,
  resetTeammateModeSnapshot,
  selectTeammateBackend,
  setCliTeammateModeOverride,
  teammateFallbackNotification,
} from '../../src/agent/teammateMode.js';
import {
  CROSS_SESSION_HOLD_CAPACITY,
  CrossSessionInbound,
  formatCrossSessionEnvelope,
  formatTeammateMessageEnvelope,
  parseCrossSessionEnvelope,
  permissionModeClass,
  resolveCrossSessionInbound,
} from '../../src/agent/crossSessionInbound.js';
import {
  reserveTeammateIdentity,
  teamDirectory,
  teamFilePath,
  teammateIdleHookPayload,
  teammateInboxPath,
  TeamLifecycle,
} from '../../src/agent/teamLifecycle.js';

describe('the teammate mode', () => {
  it("carries the target's four states and the target's default", () => {
    // chunk-wwqhf5t7.js:893 — Iqs=["auto","tmux","iterm2","in-process"]
    expect([...TEAMMATE_MODES]).toEqual(['auto', 'tmux', 'iterm2', 'in-process']);
    // chunk-9hxmx5h0.js:735 — var TKn="in-process"
    expect(DEFAULT_TEAMMATE_MODE).toBe('in-process');
  });

  it('captures the CLI override before the settings value', () => {
    resetTeammateModeSnapshot();
    setCliTeammateModeOverride('tmux');
    expect(getCliTeammateModeOverride()).toBe('tmux');

    captureTeammateModeSnapshot({ teammateMode: 'iterm2' });
    expect(getTeammateModeFromSnapshot()).toBe('tmux');
  });

  it('captures the settings value, and falls back to the default', () => {
    resetTeammateModeSnapshot();
    captureTeammateModeSnapshot({ teammateMode: 'iterm2' });
    expect(getTeammateModeFromSnapshot()).toBe('iterm2');

    resetTeammateModeSnapshot();
    captureTeammateModeSnapshot();
    expect(getTeammateModeFromSnapshot()).toBe('in-process');
  });

  it('refuses to report a mode before it has been captured', () => {
    resetTeammateModeSnapshot();
    expect(hasTeammateModeSnapshot()).toBe(false);
    expect(() => getTeammateModeFromSnapshot()).toThrow(/before capture/);
  });

  it('clears the CLI override and sets the mode', () => {
    // chunk-9hxmx5h0.js:1051 — the clear replaces the captured mode too.
    resetTeammateModeSnapshot();
    setCliTeammateModeOverride('tmux');
    captureTeammateModeSnapshot({ teammateMode: 'iterm2' });
    expect(getTeammateModeFromSnapshot()).toBe('tmux');

    clearCliTeammateModeOverride('in-process');
    expect(getCliTeammateModeOverride()).toBeUndefined();
    expect(getTeammateModeFromSnapshot()).toBe('in-process');
  });

  it('runs a non-interactive session in-process, whatever the mode says', () => {
    // chunk-vqa3vv4s.js — isInProcessEnabled: a non-interactive session is
    // always in-process.
    const environment = {
      insideTmux: true,
      insideITerm2: false,
      tmuxAvailable: true,
      it2Available: false,
      interactive: false,
      inProcessFallbackActive: false,
    };
    expect(isInProcessEnabled('auto', environment)).toBe(true);
    expect(isInProcessEnabled('tmux', environment)).toBe(true);
  });

  it('runs the auto mode in-process outside tmux and iTerm2', () => {
    const environment = {
      insideTmux: false,
      insideITerm2: false,
      tmuxAvailable: true,
      it2Available: false,
      interactive: true,
      inProcessFallbackActive: false,
    };
    expect(isInProcessEnabled('auto', environment)).toBe(true);
    expect(isInProcessEnabled('in-process', environment)).toBe(true);
    expect(isInProcessEnabled('tmux', environment)).toBe(false);
    expect(isInProcessEnabled('iterm2', environment)).toBe(false);
  });

  it('selects the tmux backend inside tmux', () => {
    const selection = selectTeammateBackend('auto', {
      insideTmux: true,
      insideITerm2: false,
      tmuxAvailable: true,
      it2Available: false,
      interactive: true,
      inProcessFallbackActive: false,
    });
    expect(selection.backend).toBe('tmux');
    expect(selection.isNative).toBe(true);
  });

  it('selects the iterm2 backend when the it2 CLI is reachable', () => {
    const selection = selectTeammateBackend('auto', {
      insideTmux: false,
      insideITerm2: true,
      tmuxAvailable: true,
      it2Available: true,
      interactive: true,
      inProcessFallbackActive: false,
    });
    expect(selection.backend).toBe('iterm2');
    expect(selection.needsIt2Setup).toBe(false);
  });

  it('falls back to tmux inside iTerm2 when it2 is missing, and says the setup is needed', () => {
    const selection = selectTeammateBackend('auto', {
      insideTmux: false,
      insideITerm2: true,
      tmuxAvailable: true,
      it2Available: false,
      interactive: true,
      inProcessFallbackActive: false,
    });
    expect(selection.backend).toBe('tmux');
    expect(selection.isNative).toBe(false);
    expect(selection.needsIt2Setup).toBe(true);
  });

  it("fails with the target's own message when iterm2 is explicit and the session is not in iTerm2", () => {
    expect(() =>
      selectTeammateBackend('iterm2', {
        insideTmux: false,
        insideITerm2: false,
        tmuxAvailable: true,
        it2Available: true,
        interactive: true,
        inProcessFallbackActive: false,
      }),
    ).toThrow(/teammateMode is set to "iterm2"/);
  });

  it("fails with the target's own message when iterm2 is explicit and it2 is not reachable", () => {
    expect(() =>
      selectTeammateBackend('iterm2', {
        insideTmux: false,
        insideITerm2: true,
        tmuxAvailable: true,
        it2Available: false,
        interactive: true,
        inProcessFallbackActive: false,
      }),
    ).toThrow(/it2 CLI is not reachable/);
  });

  it('names the capability a pane backend needs when it refuses', () => {
    let thrown: unknown;
    try {
      planTeammateExecution('tmux', {
        insideTmux: true,
        insideITerm2: false,
        tmuxAvailable: true,
        it2Available: false,
        interactive: true,
        inProcessFallbackActive: false,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TeammateBackendUnavailableError);
    expect((thrown as TeammateBackendUnavailableError).capability).toContain('tmux');
  });

  it("falls back to in-process, with the target's own notification, when the mode is auto", () => {
    const plan = planTeammateExecution('auto', {
      insideTmux: true,
      insideITerm2: false,
      tmuxAvailable: true,
      it2Available: false,
      interactive: true,
      inProcessFallbackActive: false,
    });
    expect(plan).toEqual({ kind: 'in-process', fallback: true });
  });

  it("carries the target's own fallback notification", () => {
    // chunk-xbdsavh3.js:31375 — the fallback text, with the product name
    // substituted.
    expect(teammateFallbackNotification(false)).toContain('teammateMode: "tmux"');
    expect(teammateFallbackNotification(true)).toContain('teammateMode: "iterm2"');
    expect(teammateFallbackNotification(false)).toContain("Couldn't open a teammate pane");
  });
});

describe('the name-collision ledger', () => {
  it('rejects the reserved names, in any spelling', () => {
    // chunk-jdykmg3v.js:9134 — the comparison is on the normalised name.
    expect([...RESERVED_TEAMMATE_NAMES]).toEqual(['main', 'team-lead', 'user', 'system']);
    expect(isReservedTeammateName('main')).toBe(true);
    expect(isReservedTeammateName('MAIN')).toBe(true);
    expect(isReservedTeammateName('Team-Lead')).toBe(true);
    expect(isReservedTeammateName('  user  ')).toBe(true);
    expect(isReservedTeammateName('researcher')).toBe(false);
  });

  it('rejects a name that has the shape of an agent id', () => {
    // chunk-mtkqr4r9.js:354 — the agent-id parser's own pattern.
    expect(AGENT_ID_PATTERN.source).toBe('^a(?:[\\w-]{1,63}-)?[0-9a-f]{16}$');
    expect(isAgentIdShaped('a0123456789abcdef')).toBe(true);
    expect(isAgentIdShaped('a1b2c3d4')).toBe(false);
    expect(isAgentIdShaped('researcher')).toBe(false);
    expect(isAgentIdShaped('-leading-dash')).toBe(false);
  });

  it("carries the target's three own validation messages", () => {
    // chunk-1vypyz65.js:11430 — the Agent tool's own `name` field.
    expect(validateTeammateName('researcher')).toEqual({ ok: true });
    expect(validateTeammateName('bad name')).toEqual({
      ok: false,
      message:
        'name must start with a letter or digit and contain only letters, digits, underscores, or hyphens (max 64 chars)',
    });
    expect(validateTeammateName('main')).toEqual({
      ok: false,
      message: '"main" is reserved — SendMessage routes it to the main conversation',
    });
    expect(validateTeammateName('Team-Lead')).toEqual({
      ok: false,
      message:
        'name must not be a reserved name ("main", "team-lead", "user" or "system", in any spelling) or have the shape of an agent id — those already address an agent directly',
    });
  });

  it('suffixes a colliding name with -2, then -3', () => {
    // chunk-xbdsavh3.js:20415 — the unique-name rule.
    expect(uniqueTeammateName('researcher', [])).toBe('researcher');
    expect(uniqueTeammateName('researcher', [{ name: 'researcher' }])).toBe('researcher-2');
    expect(
      uniqueTeammateName('researcher', [{ name: 'researcher' }, { name: 'researcher-2' }]),
    ).toBe('researcher-3');
    expect(uniqueTeammateName('researcher', [{ name: 'Researcher' }])).toBe('researcher-2');
  });

  it('sanitises the name and builds the teammate id', () => {
    // chunk-qsxcbpmk.js:1531 — "@" becomes "-"; chunk-fvj2e8y8.js:2175 — the id.
    expect(sanitizeTeammateName('a@b')).toBe('a-b');
    expect(teammateId('researcher', 'default')).toBe('researcher@default');
  });

  it('normalises a name the way the target compares names', () => {
    expect(normalizeTeammateName('  Team  Lead ')).toBe('team-lead');
    expect(normalizeTeammateName('R&D')).toBe('r&d');
  });

  it("carries the target's six settle values and its three outcomes", () => {
    // chunk-4jsg44k7.js:3562216 and :3563019.
    expect([...TEAMMATE_SETTLE_VALUES]).toEqual([
      'pre-decided',
      'own-name',
      'superseded',
      'held',
      'yielded',
      'kept',
    ]);
    expect(settleOutcome('superseded')).toBe('superseded');
    expect(settleOutcome('yielded')).toBe('yielded');
    expect(settleOutcome('held')).toBe('yielded');
    expect(settleOutcome('kept')).toBe('kept');
    expect(settleOutcome('own-name')).toBe('kept');
    expect(settleOutcome('pre-decided')).toBe('kept');
  });

  it("carries the target's record sources", () => {
    expect([...TEAMMATE_RECORD_SOURCES]).toContain('collision');
    expect([...TEAMMATE_RECORD_SOURCES]).toContain('hook');
    expect([...TEAMMATE_RECORD_SOURCES]).not.toContain('own-name');
    expect([...TEAMMATE_RECORD_SOURCES]).not.toContain('superseded');
  });
});

describe('the cross-session inbound gate', () => {
  it('resolves the setting in the target\'s order', () => {
    // chunk-v01p0e5r.js:2941 — policy, flag, user, highest first.
    const resolution = resolveCrossSessionInbound({
      policySettings: 'refuse',
      flagSettings: 'hold',
      userSettings: 'accept',
    });
    expect(resolution.value).toBe('refuse');
    expect(resolution.decidedBy).toBe('policySettings');

    expect(
      resolveCrossSessionInbound({ flagSettings: 'hold', userSettings: 'accept' }),
    ).toMatchObject({ value: 'hold', decidedBy: 'flagSettings' });

    expect(resolveCrossSessionInbound({ userSettings: 'accept' })).toMatchObject({
      value: 'accept',
      decidedBy: 'userSettings',
    });
  });

  it('lets a repository setting only tighten', () => {
    // chunk-v01p0e5r.js:1377 — f={accept:0,hold:1,refuse:2}.
    const loosening = resolveCrossSessionInbound({
      userSettings: 'refuse',
      projectSettings: 'accept',
    });
    expect(loosening.value).toBe('refuse');
    expect(loosening.decidedBy).toBe('userSettings');

    const tightening = resolveCrossSessionInbound({
      userSettings: 'accept',
      projectSettings: 'hold',
    });
    expect(tightening.value).toBe('hold');
    expect(tightening.decidedBy).toBe('repoSettings');
  });

  it('never lets a repository setting loosen a policy setting', () => {
    const resolution = resolveCrossSessionInbound({
      policySettings: 'refuse',
      projectSettings: 'accept',
    });
    expect(resolution.value).toBe('refuse');
    expect(resolution.decidedBy).toBe('policySettings');
  });

  it('lets a repository setting tighten a policy setting', () => {
    const resolution = resolveCrossSessionInbound({
      policySettings: 'accept',
      projectSettings: 'refuse',
    });
    expect(resolution.value).toBe('refuse');
    expect(resolution.decidedBy).toBe('repoSettings');
  });

  it('turns an unrecognised value in a policy source into refuse', () => {
    // chunk-c9s0jh80.js:427318 — the managed-settings normalisation.
    const resolution = resolveCrossSessionInbound({ policySettings: 'sometimes' });
    expect(resolution.value).toBe('refuse');
    expect(resolution.decidedBy).toBe('policySettings');
    expect(resolution.invalidValue).toBe(true);
  });

  it('turns an unrecognised value anywhere else into hold', () => {
    // chunk-v01p0e5r.js:3487 — the invalid-setting probe.
    const resolution = resolveCrossSessionInbound({ userSettings: 'sometimes' });
    expect(resolution.value).toBe('hold');
    expect(resolution.decidedBy).toBe('invalidSetting');
    expect(resolution.invalidValue).toBe(true);
  });

  it('accepts by default when the session prompts', () => {
    const gate = new CrossSessionInbound({ mode: { mode: 'default' } });
    expect(gate.policyFor({ id: 'a' })).toEqual({ policy: 'accept' });
  });

  it('holds by default when the session bypasses prompts', () => {
    const gate = new CrossSessionInbound({ mode: { mode: 'bypassPermissions' } });
    expect(gate.defaultPolicy()).toEqual({
      policy: 'hold',
      holdCause: 'bypass-default',
    });
  });

  it('holds when the sending session is in another permission class', () => {
    // chunk-v01p0e5r.js:4277 — the mode-parity rule.
    const gate = new CrossSessionInbound({ mode: { mode: 'default' } });
    expect(
      gate.policyFor({ id: 'a', origin: { kind: 'peer', fromMode: 'bypass' } }),
    ).toEqual({ policy: 'hold', holdCause: 'mode-mismatch' });
  });

  it('accepts when the sending session is in the same permission class', () => {
    const gate = new CrossSessionInbound({ mode: { mode: 'default' } });
    expect(
      gate.policyFor({ id: 'a', origin: { kind: 'peer', fromMode: 'prompting' } }),
    ).toEqual({ policy: 'accept' });
  });

  it('holds when the sender asserted no class and the receiver bypasses prompts', () => {
    const gate = new CrossSessionInbound({ mode: { mode: 'bypassPermissions' } });
    expect(gate.policyFor({ id: 'a', origin: { kind: 'peer' } })).toEqual({
      policy: 'hold',
      holdCause: 'no-mode-asserted',
    });
  });

  it('accepts a message the session sent to itself', () => {
    const gate = new CrossSessionInbound({ mode: { mode: 'bypassPermissions' } });
    expect(
      gate.policyFor({ id: 'a', origin: { kind: 'peer', selfSent: true } }),
    ).toEqual({ policy: 'accept' });
  });

  it('refuses when the setting is refuse', () => {
    const gate = new CrossSessionInbound({ sources: { userSettings: 'refuse' } });
    expect(gate.policyFor({ id: 'a' })).toEqual({
      policy: 'refuse',
      refuseCause: 'opt-out',
    });
  });

  it('refuses when the kill switch is on', () => {
    const gate = new CrossSessionInbound({ killSwitch: true, mode: { mode: 'default' } });
    expect(gate.policyFor({ id: 'a' })).toEqual({
      policy: 'refuse',
      refuseCause: 'kill-switch',
    });
  });

  it('parks a held message and reports the receipt', () => {
    const receipts: string[] = [];
    const gate = new CrossSessionInbound({
      sources: { userSettings: 'hold' },
      mode: { mode: 'default' },
      sendReceipt: (_message, receipt) => receipts.push(receipt),
    });
    const outcome = gate.admit({ id: 'a' });
    expect(outcome.decision).toBe('held');
    expect(receipts).toEqual(['held']);
    expect(gate.heldCount()).toBe(1);
  });

  it('evicts the oldest parked message when the buffer is full', () => {
    // chunk-v01p0e5r.js:1377 — Q=100.
    expect(CROSS_SESSION_HOLD_CAPACITY).toBe(100);
    const receipts: string[] = [];
    const gate = new CrossSessionInbound({
      sources: { userSettings: 'hold' },
      mode: { mode: 'default' },
      sendReceipt: (_message, receipt) => receipts.push(receipt),
    });
    for (let index = 0; index < CROSS_SESSION_HOLD_CAPACITY; index += 1) {
      gate.admit({ id: `m${index}` });
    }
    expect(gate.heldCount()).toBe(CROSS_SESSION_HOLD_CAPACITY);
    gate.admit({ id: 'overflow' });
    expect(gate.heldCount()).toBe(CROSS_SESSION_HOLD_CAPACITY);
    expect(receipts.filter((receipt) => receipt === 'expired')).toEqual(['expired']);
  });

  it('delivers an approved held message', () => {
    const receipts: string[] = [];
    const gate = new CrossSessionInbound({
      sources: { userSettings: 'hold' },
      mode: { mode: 'default' },
      sendReceipt: (_message, receipt) => receipts.push(receipt),
    });
    gate.admit({ id: 'a' });
    const settled = gate.approve('a');
    expect(settled.outcome).toBe('delivered');
    expect(receipts).toEqual(['held', 'delivered']);
    expect(gate.heldCount()).toBe(0);
  });

  it('drops a denied held message with a denial receipt', () => {
    const receipts: string[] = [];
    const gate = new CrossSessionInbound({
      sources: { userSettings: 'hold' },
      mode: { mode: 'default' },
      sendReceipt: (_message, receipt) => receipts.push(receipt),
    });
    gate.admit({ id: 'a' });
    expect(gate.deny('a').outcome).toBe('dropped');
    expect(receipts).toEqual(['held', 'denied']);
  });

  it('refuses to deliver a cross-session message, naming the capability it needs', () => {
    const gate = new CrossSessionInbound({ mode: { mode: 'default' } });
    expect(() => gate.deliver({ id: 'a' })).toThrow(/cross-session transport/i);
  });

  it('classifies a permission mode the way the target does', () => {
    expect(permissionModeClass({ mode: 'bypassPermissions' })).toBe('bypass');
    expect(permissionModeClass({ mode: 'default' })).toBe('prompting');
    expect(permissionModeClass({ mode: 'acceptEdits' })).toBe('prompting');
  });

  it('carries the inbound message form', () => {
    // chunk-fvj2e8y8.js — the cross-session envelope's own fields. The `from`
    // is the address the message came from, not an agent id.
    const text = formatCrossSessionEnvelope({
      from: 'uds:/tmp/cc-socks-a1b2c3d4',
      fromSession: 'session-1',
      fromName: 'researcher',
      fromMode: 'prompting',
      body: 'the report',
    });
    expect(text).toContain('<cross-session-message');
    expect(text).toContain('from="uds:/tmp/cc-socks-a1b2c3d4"');
    expect(text).toContain('from-mode="prompting"');
    expect(text).toContain('the report');

    const parsed = parseCrossSessionEnvelope(text);
    expect(parsed).toMatchObject({
      from: 'uds:/tmp/cc-socks-a1b2c3d4',
      fromSession: 'session-1',
      fromName: 'researcher',
      fromMode: 'prompting',
      body: 'the report',
    });
  });

  it('reads nothing out of a text that is not an envelope', () => {
    expect(parseCrossSessionEnvelope('just some text')).toBeUndefined();
  });

  it('carries the teammate-message form the target uses for an inbox entry', () => {
    // chunk-2pn9kb04.js:31586 — the delivered envelope.
    const text = formatTeammateMessageEnvelope({
      teammateId: 'researcher@default',
      color: 'blue',
      summary: 'the report is ready',
      unverified: true,
      body: 'the report',
    });
    expect(text).toContain('<teammate-message');
    expect(text).toContain('teammate_id="researcher@default"');
    expect(text).toContain('color="blue"');
    expect(text).toContain('summary="the report is ready"');
    expect(text).toContain('verified="false"');
    expect(text).toContain('the report');
  });
});

describe('the Agent tool', () => {
  /** The tool context a call runs in. */
  function toolContext(toolName: string, input: unknown): ToolContext {
    return { toolName, input, toolUseId: 'toolu_01', sessionId: 'session-01' };
  }

  /** A rule set. */
  function ruleSet(overrides: Partial<RuleSet> = {}): RuleSet {
    return {
      allow: [],
      deny: [],
      ask: [],
      cwd: '/tmp',
      source: 'userSettings',
      ...overrides,
    };
  }

  /** The dependencies the tool is built with. */
  function builtinDeps(overrides: Partial<BuiltinToolDeps> = {}): BuiltinToolDeps {
    return { rules: ruleSet(), mode: 'default', cwd: '/tmp', ...overrides };
  }

  it("carries the target's own description for the name field", () => {
    const tool = createAgentTool(builtinDeps());
    const schema = tool.inputSchema as {
      properties: Record<string, { description?: string }>;
    };
    expect(schema.properties['name']?.description).toBe(
      'Name for the spawned agent. Makes it addressable via SendMessage({to: name}) while running.',
    );
  });

  it("applies the target's own three rules to the name field", async () => {
    const tool = createAgentTool(builtinDeps());

    const reserved = await tool.validateInput(
      { description: 'do the thing', prompt: 'do the thing', name: 'main' } as never,
      toolContext('Agent', {}),
    );
    expect(reserved.ok).toBe(false);
    expect(reserved.ok ? '' : reserved.message).toBe(
      '"main" is reserved — SendMessage routes it to the main conversation',
    );

    const agentId = await tool.validateInput(
      { description: 'do the thing', prompt: 'do the thing', name: 'a0123456789abcdef' } as never,
      toolContext('Agent', {}),
    );
    expect(agentId.ok).toBe(false);
    expect(agentId.ok ? '' : agentId.message).toContain('the shape of an agent id');

    const good = await tool.validateInput(
      { description: 'do the thing', prompt: 'do the thing', name: 'researcher' } as never,
      toolContext('Agent', {}),
    );
    expect(good.ok).toBe(true);
  });

  it('refuses a named spawn, naming the capability it needs', async () => {
    const tool = createAgentTool(builtinDeps({ rules: ruleSet({ allow: ['Agent'] }) }));
    const input = { description: 'do the thing', prompt: 'do the thing', name: 'researcher' };

    await expect(tool.execute(input, toolContext('Agent', input))).rejects.toMatchObject({
      errorCode: TOOL_ERROR_CODES.capabilityUnavailable,
    });
    await expect(tool.execute(input, toolContext('Agent', input))).rejects.toThrow(
      /teammate runtime/i,
    );
  });

  it('starts a named agent through the teammate runtime the session supplies', async () => {
    const seen: { name?: string }[] = [];
    const tool = createAgentTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Agent'] }),
        spawnTeammate: async (input) => {
          seen.push(input);
          return { agentId: 'researcher@default', name: 'researcher' };
        },
      }),
    );
    const input = { description: 'do the thing', prompt: 'do the thing', name: 'researcher' };

    const output = await tool.execute(input, toolContext('Agent', input));

    // The target's own result text — chunk-1vypyz65.js:46339.
    expect(output.text).toContain('Spawned successfully.');
    expect(output.text).toContain('agent_id: researcher@default');
    expect(output.text).toContain('name: researcher');
    expect(output.text).toContain('The agent is now running and will receive instructions via mailbox.');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.name).toBe('researcher');
  });

  it('delegates an unnamed spawn to the task runner', async () => {
    const seen: unknown[] = [];
    const tool = createAgentTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Agent'] }),
        delegate: async (input) => {
          seen.push(input);
          return 'the sub-agent finished';
        },
      }),
    );
    const input = { description: 'do the thing', prompt: 'do the thing' };

    const output = await tool.execute(input, toolContext('Agent', input));

    expect(output.text).toBe('the sub-agent finished');
    expect(seen).toHaveLength(1);
  });
});

describe('the team lifecycle', () => {
  it('carries the target\'s team file layout', () => {
    // chunk-qsxcbpmk.js:1463 and :1613.
    expect(teamDirectory('/home/u/.claude', 'My Team')).toBe('/home/u/.claude/teams/my-team');
    expect(teamFilePath('/home/u/.claude', 'My Team')).toBe(
      '/home/u/.claude/teams/my-team/config.json',
    );
    expect(teammateInboxPath('/home/u/.claude', 'My Team', 'researcher')).toBe(
      '/home/u/.claude/teams/my-team/inboxes/researcher.json',
    );
  });

  it('reserves the teammate identity the way the target does', () => {
    const identity = reserveTeammateIdentity({
      name: 'researcher',
      teamName: 'default',
      members: [{ name: 'researcher' }],
      color: 'blue',
      now: 1000,
    });
    expect(identity.name).toBe('researcher-2');
    expect(identity.agentId).toBe('researcher-2@default');
    expect(identity.member).toMatchObject({
      name: 'researcher-2',
      color: 'blue',
      joinedAt: 1000,
      tmuxPaneId: '',
      subscriptions: [],
    });
  });

  it('refuses a name that carries a control character', () => {
    expect(() =>
      reserveTeammateIdentity({
        name: 'research er',
        teamName: 'default',
        members: [],
        color: 'blue',
      }),
    ).toThrow(/control characters are not allowed/);
  });

  it('refuses to spawn a teammate, naming the capability it needs', async () => {
    const lifecycle = new TeamLifecycle({ teamName: 'default', configRoot: '/home/u/.claude' });
    const outcome = await lifecycle.spawn({ name: 'researcher', color: 'blue' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.capability).toMatch(/teammate runtime/i);
      expect(outcome.message).toMatch(/teammate runtime/i);
    }
  });

  it('refuses to tear a team down, naming the capability it needs', async () => {
    const lifecycle = new TeamLifecycle({ teamName: 'default', configRoot: '/home/u/.claude' });
    await expect(lifecycle.teardown()).rejects.toThrow(/teammate runtime/i);
  });

  it("carries the target's TeammateIdle hook payload", () => {
    // chunk-4jsg44k7.js:3560929.
    expect(teammateIdleHookPayload('researcher', 'default')).toEqual({
      hook_event_name: 'TeammateIdle',
      teammate_name: 'researcher',
      team_name: 'default',
    });
  });

  it('runs the lifecycle when the session supplies a teammate runtime', async () => {
    const started: string[] = [];
    const stopped: string[] = [];
    const tornDown: string[] = [];
    const lifecycle = new TeamLifecycle({
      teamName: 'default',
      configRoot: '/home/u/.claude',
      runtime: {
        start: async (request) => {
          started.push(request.name);
          return `${request.name}@default`;
        },
        stop: async (agentId) => {
          stopped.push(agentId);
        },
        teardown: async (teamName) => {
          tornDown.push(teamName);
        },
      },
    });

    const outcome = await lifecycle.spawn({ name: 'researcher', color: 'blue' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.identity.name).toBe('researcher');
      expect(outcome.identity.agentId).toBe('researcher@default');
      expect(outcome.teammate.state).toBe('running');
    }
    expect(started).toEqual(['researcher']);

    const context = lifecycle.context();
    expect(context.teamName).toBe('default');
    expect(context.teamFilePath).toBe('/home/u/.claude/teams/default/config.json');
    expect(Object.keys(context.teammates)).toEqual(['researcher']);

    expect(lifecycle.markIdle('researcher@default')).toBe(true);
    expect(lifecycle.list()[0]?.state).toBe('idle');

    await lifecycle.teardown();
    expect(tornDown).toEqual(['default']);
  });
});

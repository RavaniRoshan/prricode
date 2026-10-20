/**
 * Contract test for the settings tier model and precedence.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.7 (Configuration).
 *
 * The test pins the two **distinct** orderings the target declares, the tier
 * degradation and suppression rules, the scope separation, the whole-block rule, and
 * the read modes.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  linkSync,
  mkdirSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import {
  MERGED_KEY_ORDER,
  PROJECT_SIDE_SOURCES,
  TOP_LEVEL_KEY_ORDER,
  documentsOf,
  effectiveOrdinarySource,
  effectiveSource,
  mergeDocuments,
  mergeMergedSettings,
  resolveBlock,
  resolveMergedKey,
  resolveTopLevelKey,
  type SettingsSource,
  type SettingsTier,
  type SettingsTierMap,
} from '../../src/config/tiers.js';
import { loadSettings } from '../../src/config/loader.js';
import {
  BOOLEAN_FLAG_SOURCES,
  POLICY_AND_USER_SOURCES,
  SCOPE_BY_SOURCE,
  SOURCE_ENUMERATION_ORDER,
  me,
  readBooleanFlag,
  readManagedConfigSection,
  readPerTier,
  readUserOnly,
  scopeFor,
} from '../../src/config/scope.js';
import {
  FLAT_MANAGED_CONFIG_KEYS,
  GATED_SETTINGS_KEYS,
  SETTINGS_DOCUMENT_KEYS,
  WORKSPACE_CONFIG_KEYS,
  canonicalizePath,
  effectiveSettingValue,
  flatManagedConfigSchema,
  materializeFlatManagedConfig,
  parseFlatManagedConfig,
  parseSettingsDocument,
  parseWorkspaceConfig,
  permissionsSchema,
  sandboxSchema,
  settingsDefault,
  settingsDocumentSchema,
  workspaceConfigSchema,
  writeSandboxSettings,
} from '../../src/config/schema.js';

interface Workspace {
  root: string;
  cwd: string;
  configDir: string;
}

const workspaces: Workspace[] = [];

function makeWorkspace(): Workspace {
  const root = mkdtempSync(path.join(tmpdir(), 'prricode-settings-'));
  const cwd = path.join(root, 'project');
  const configDir = path.join(root, 'config');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const workspace: Workspace = { root, cwd, configDir };
  workspaces.push(workspace);
  return workspace;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function makeProjectDir(workspace: Workspace): string {
  const projectDir = path.join(workspace.cwd, '.claude');
  mkdirSync(projectDir, { recursive: true });
  return projectDir;
}

afterEach(() => {
  while (workspaces.length > 0) {
    const workspace = workspaces.pop();
    if (workspace) rmSync(workspace.root, { recursive: true, force: true });
  }
});

describe('the settings merge is per top-level key', () => {
  // The target merges the tiers **per top-level key**, and the value rule is
  // decided per key. An ordinary object-valued setting is **not** merged key by
  // key: the higher tier's object wins whole. See the audit's §2.7.

  it('lets the higher tier replace an object whole, not key by key', () => {
    const merged = mergeDocuments(
      { modelPicker: { provider: 'user', detail: { a: 1, b: 2 } } },
      { modelPicker: { provider: 'policy', detail: { a: 9 } } },
    );

    // The higher tier's object wins **whole**: the lower tier's `detail.b` does
    // not survive.
    expect(merged['modelPicker']).toEqual({ provider: 'policy', detail: { a: 9 } });
  });

  it('concatenates and de-duplicates an array', () => {
    const merged = mergeDocuments({ allow: ['a', 'b'] }, { allow: ['b', 'c'] });

    expect(merged['allow']).toEqual(['a', 'b', 'c']);
  });

  it('replaces fallbackModel rather than concatenating it', () => {
    const merged = mergeDocuments(
      { fallbackModel: ['a', 'b'] },
      { fallbackModel: ['c'] },
    );

    expect(merged['fallbackModel']).toEqual(['c']);
  });

  it('replaces modelPicker outright', () => {
    const merged = mergeDocuments({ modelPicker: { a: 1 } }, { modelPicker: { b: 2 } });

    expect(merged['modelPicker']).toEqual({ b: 2 });
  });

  it('shallow-merges the two named object keys one level', () => {
    const merged = mergeDocuments(
      { managedMcpServers: { alpha: { keep: true }, beta: { keep: true } } },
      { managedMcpServers: { alpha: { changed: true } } },
    );

    // One level: `alpha` is replaced whole, and `beta` survives.
    expect(merged['managedMcpServers']).toEqual({
      alpha: { changed: true },
      beta: { keep: true },
    });
  });

  it('shallow-merges extraKnownMarketplaces the same way', () => {
    const merged = mergeDocuments(
      { extraKnownMarketplaces: { alpha: { keep: true } } },
      { extraKnownMarketplaces: { beta: { added: true } } },
    );

    expect(merged['extraKnownMarketplaces']).toEqual({
      alpha: { keep: true },
      beta: { added: true },
    });
  });

  it('replaces an ordinary object whole, with no exception', () => {
    const merged = mergeDocuments(
      { somethingElse: { from: 'low', keep: true } },
      { somethingElse: { from: 'high' } },
    );

    expect(merged['somethingElse']).toEqual({ from: 'high' });
  });
});

describe('a merged key is won whole by the first source that defines it', () => {
  // The target's merged-key rule is "the first source that defines the key
  // wins", and the key is the merged key's own unit. The value is not merged
  // leaf by leaf with a lower tier's value of the same unit.

  it('gives a unit to the first source in the merged order, whole', () => {
    const tiers = new Map<SettingsSource, unknown>([
      ['userSettings', { skills: { alpha: { enabled: false, fromUser: true } } }],
      ['projectSettings', { skills: { alpha: { enabled: true } } }],
    ]);

    const merged = mergeMergedSettings(tiers);

    // The project tier comes before the user tier in the merged order, so it
    // wins `alpha` **whole**: the user tier's `fromUser` does not survive.
    expect(merged['skills']).toEqual({ alpha: { enabled: true } });
  });

  it('keeps the units of two different tiers', () => {
    const tiers = new Map<SettingsSource, unknown>([
      ['userSettings', { skills: { alpha: { enabled: false } } }],
      ['projectSettings', { skills: { beta: { enabled: true } } }],
    ]);

    const merged = mergeMergedSettings(tiers);

    expect(merged['skills']).toEqual({ alpha: { enabled: false }, beta: { enabled: true } });
  });
});

describe('settings tier resolution', () => {
  it('declares the two distinct orderings and the project-side set', () => {
    expect([...TOP_LEVEL_KEY_ORDER]).toEqual(['policySettings', 'flagSettings', 'userSettings']);
    expect([...MERGED_KEY_ORDER]).toEqual(['localSettings', 'projectSettings', 'userSettings']);
    expect([...PROJECT_SIDE_SOURCES]).toEqual(['projectSettings', 'localSettings']);
  });

  it('resolves a top-level key through policy, then flag, then user settings', () => {
    const tiers = new Map<SettingsSource, unknown>([
      ['policySettings', { model: 'policy-model' }],
      ['flagSettings', { model: 'flag-model' }],
      ['userSettings', { model: 'user-model' }],
    ]);

    const resolved = resolveTopLevelKey(tiers, 'model');

    expect(resolved.map((tier) => tier.source)).toEqual([
      'policySettings',
      'flagSettings',
      'userSettings',
    ]);
    expect(resolved[0]?.value).toBe('policy-model');
    expect(effectiveSource(tiers, 'model')).toBe('policySettings');
  });

  it('resolves a merged key through local, then project, then user settings', () => {
    const tiers = new Map<SettingsSource, unknown>([
      ['userSettings', { model: 'user-model' }],
      ['projectSettings', { model: 'project-model' }],
      ['localSettings', { model: 'local-model' }],
    ]);

    const resolved = resolveMergedKey(tiers, 'model');

    expect(resolved.map((tier) => tier.source)).toEqual([
      'localSettings',
      'projectSettings',
      'userSettings',
    ]);
    expect(resolved[0]?.value).toBe('local-model');
  });

  it('keeps the two orderings genuinely different', () => {
    const tiers = new Map<SettingsSource, unknown>([
      ['policySettings', { model: 'policy-model' }],
      ['flagSettings', { model: 'flag-model' }],
      ['userSettings', { model: 'user-model' }],
      ['projectSettings', { model: 'project-model' }],
      ['localSettings', { model: 'local-model' }],
    ]);

    // The same key, resolved by the two rules, must not produce the same winner.
    expect(effectiveSource(tiers, 'model')).toBe('policySettings');
    expect(resolveMergedKey(tiers, 'model')[0]?.source).toBe('localSettings');
    expect([...TOP_LEVEL_KEY_ORDER]).not.toEqual([...MERGED_KEY_ORDER]);
  });

  it('does not consult the project or local tier for a top-level key', () => {
    const tiers = new Map<SettingsSource, unknown>([
      ['projectSettings', { model: 'project-model' }],
      ['localSettings', { model: 'local-model' }],
    ]);

    expect(resolveTopLevelKey(tiers, 'model')).toEqual([]);
    expect(effectiveSource(tiers, 'model')).toBeNull();
  });

  it('reports no tier for a key no source defines', () => {
    const tiers = new Map<SettingsSource, unknown>([['userSettings', { model: 'user-model' }]]);

    expect(resolveTopLevelKey(tiers, 'missing')).toEqual([]);
    expect(resolveMergedKey(tiers, 'missing')).toEqual([]);
    expect(effectiveSource(tiers, 'missing')).toBeNull();
  });

  it('resolves a merged key per leaf of a dotted path', () => {
    const tiers = new Map<SettingsSource, unknown>([
      ['userSettings', { skills: { alpha: { enabled: false } } }],
      ['localSettings', { skills: { beta: { enabled: true } } }],
    ]);

    const resolved = resolveMergedKey(tiers, 'skills.beta.enabled');

    expect(resolved).toEqual([{ source: 'localSettings', value: true }]);
  });

  it('merges the merged-settings document per key', () => {
    // Implementation choice (not observed): the merge is per leaf, so two tiers that define
    // different skills both survive and the higher tier wins the leaves it defines.
    const tiers = new Map<SettingsSource, unknown>([
      ['userSettings', { skills: { alpha: { enabled: false } }, model: 'user-model' }],
      ['projectSettings', { skills: { alpha: { enabled: true } } }],
      ['localSettings', { skills: { beta: { enabled: true } } }],
    ]);

    const merged = mergeMergedSettings(tiers);

    // The project tier wins the `alpha` leaf over the user tier; the local tier
    // contributes `beta`.
    expect(merged['skills']).toEqual({
      alpha: { enabled: true },
      beta: { enabled: true },
    });
    expect(merged['model']).toBe('user-model');
  });
});

describe('ordinary key resolution', () => {
  it('resolves an ordinary key through the project and local tiers', () => {
    // The target's per-key merge for ordinary keys is NOT derived from the target
    // (audit §2.7, final line). The ordinary path is an explicitly underived implementation
    // choice, so it is pinned here as such.
    const tiers = new Map<SettingsSource, unknown>([
      ['userSettings', { model: 'user-model' }],
      ['projectSettings', { model: 'project-model' }],
      ['localSettings', { model: 'local-model' }],
    ]);

    expect(effectiveOrdinarySource(tiers, 'model')).toBe('localSettings');
    expect(effectiveOrdinarySource(tiers, 'missing')).toBeNull();
  });

  it('distinguishes the ordinary path from the top-level path', () => {
    const tiers = new Map<SettingsSource, unknown>([
      ['userSettings', { model: 'user-model' }],
      ['localSettings', { model: 'local-model' }],
    ]);

    // The observed top-level order consults the policy, flag and user tiers only.
    expect(effectiveSource(tiers, 'model')).toBe('userSettings');
    // The ordinary path is a separate path and must not be silently identical.
    expect(effectiveOrdinarySource(tiers, 'model')).toBe('localSettings');
  });
});

describe('the ordinary key resolves to the merged value', () => {
  // The target's effective settings are composed per top-level key, and the
  // value rule decides what the value becomes. So an array two tiers define is
  // the **concatenation** of both — not the higher tier's alone — while the
  // source that supplied it is still the higher tier.

  it('concatenates an array two tiers define', () => {
    const tiers = new Map<SettingsSource, unknown>([
      ['userSettings', { allow: ['a'] }],
      ['projectSettings', { allow: ['b'] }],
    ]);

    const resolved = resolveBlock(tiers as SettingsTierMap, 'allow');

    expect(resolved?.value).toEqual(['a', 'b']);
    // The **source** is still the higher tier that defines the key.
    expect(resolved?.source).toBe('projectSettings');
  });

  it('gives the higher tier an object whole, not key by key', () => {
    const tiers = new Map<SettingsSource, unknown>([
      ['userSettings', { thing: { fromUser: true } }],
      ['projectSettings', { thing: { fromProject: true } }],
    ]);

    const resolved = resolveBlock(tiers as SettingsTierMap, 'thing');

    expect(resolved?.value).toEqual({ fromProject: true });
    expect(resolved?.source).toBe('projectSettings');
  });

  it('shallow-merges the two named object keys one level', () => {
    const tiers = new Map<SettingsSource, unknown>([
      ['userSettings', { managedMcpServers: { alpha: { keep: true } } }],
      ['projectSettings', { managedMcpServers: { beta: { added: true } } }],
    ]);

    const resolved = resolveBlock(tiers as SettingsTierMap, 'managedMcpServers');

    expect(resolved?.value).toEqual({ alpha: { keep: true }, beta: { added: true } });
  });
});

describe('whole-block override', () => {
  it('returns a higher tier block whole and never merges it key by key', () => {
    const tiers = new Map<SettingsSource, unknown>([
      ['userSettings', { permissions: { allow: ['Bash'], deny: ['Read'] } }],
      ['projectSettings', { permissions: { deny: ['Write'] } }],
    ]);

    const block = resolveBlock(tiers, 'permissions');

    expect(block?.source).toBe('projectSettings');
    expect(block?.value).toEqual({ deny: ['Write'] });
    // The lower tier's keys are not merged into the winning block.
    expect((block?.value as Record<string, unknown>)['allow']).toBeUndefined();
  });

  it('does not consult a lower tier block when a higher tier defines the block', () => {
    const tiers = new Map<SettingsSource, unknown>([
      ['userSettings', { sandbox: { enabled: true } }],
      ['localSettings', { sandbox: { enabled: false, allowUnsandboxedCommands: true } }],
    ]);

    const block = resolveBlock(tiers, 'sandbox');

    expect(block?.source).toBe('localSettings');
    expect(block?.value).toEqual({ enabled: false, allowUnsandboxedCommands: true });
  });

  it('resolves spellcheck from the user tier only', () => {
    const tiers = new Map<SettingsSource, unknown>([
      ['userSettings', { spellcheck: { enabled: true } }],
      ['projectSettings', { spellcheck: { enabled: false } }],
      ['localSettings', { spellcheck: { enabled: false } }],
    ]);

    const block = resolveBlock(tiers, 'spellcheck');

    expect(block?.source).toBe('userSettings');
    expect(block?.value).toEqual({ enabled: true });
  });

  it('never resolves a spellcheck block from a project or local tier', () => {
    const tiers = new Map<SettingsSource, unknown>([
      ['projectSettings', { spellcheck: { enabled: false } }],
      ['localSettings', { spellcheck: { enabled: false } }],
    ]);

    expect(resolveBlock(tiers, 'spellcheck')).toBeUndefined();
    expect(readPerTier(tiers, 'spellcheck')).toEqual([]);
  });
});

describe('settings scope separation', () => {
  it('maps every source to its observed scope', () => {
    expect([...SOURCE_ENUMERATION_ORDER]).toEqual([
      'userSettings',
      'projectSettings',
      'localSettings',
    ]);
    // The scope map carries exactly the sources of the enumeration order.
    expect(Object.keys(SCOPE_BY_SOURCE)).toEqual([...SOURCE_ENUMERATION_ORDER]);
    expect(SCOPE_BY_SOURCE).toEqual({
      userSettings: 'user',
      projectSettings: 'project',
      localSettings: 'local',
    });
    expect(scopeFor('userSettings')).toBe('user');
    expect(scopeFor('projectSettings')).toBe('project');
    expect(scopeFor('localSettings')).toBe('local');
    expect(scopeFor('policySettings')).toBeNull();
    expect(scopeFor('flagSettings')).toBeNull();
  });

  it('suppresses exactly the project-side sources when personal config is restricted', () => {
    expect(me('projectSettings', true)).toBeNull();
    expect(me('localSettings', true)).toBeNull();
    expect(me('userSettings', true)).toBe('user');

    expect(me('projectSettings', false)).toBe('project');
    expect(me('localSettings', false)).toBe('local');
  });

  it('reads spellcheck from user settings only', () => {
    const tiers = new Map<SettingsSource, unknown>([
      ['userSettings', { spellcheck: { enabled: true } }],
      ['projectSettings', { spellcheck: { enabled: false } }],
      ['localSettings', { spellcheck: { enabled: false } }],
    ]);

    expect(readUserOnly(tiers, 'spellcheck')).toEqual({
      source: 'userSettings',
      value: { enabled: true },
    });
  });

  it('resolves a restricted key from the user tier on the top-level path too', () => {
    // The restriction is a capability-level rule: `spellcheck` is scoped to the
    // user tier, so no other tier may supply it — whichever resolution path is
    // used. The paths must not disagree about a restricted key.
    const tiers = new Map<SettingsSource, unknown>([
      ['policySettings', { spellcheck: { enabled: false } }],
      ['flagSettings', { spellcheck: { enabled: false } }],
      ['userSettings', { spellcheck: { enabled: true } }],
    ]);

    expect(resolveTopLevelKey(tiers, 'spellcheck')).toEqual([
      { source: 'userSettings', value: { enabled: true } },
    ]);
    expect(effectiveSource(tiers, 'spellcheck')).toBe('userSettings');
  });

  it('reports per-tier settings together with the tier that supplied them', () => {
    const tiers = new Map<SettingsSource, unknown>([
      ['userSettings', { apiKeyHelper: 'user-helper' }],
      ['projectSettings', { apiKeyHelper: 'project-helper' }],
      ['localSettings', { otelHeadersHelper: 'local-helper' }],
    ]);

    expect(readPerTier(tiers, 'apiKeyHelper').map((tier) => tier.source)).toEqual([
      'projectSettings',
      'userSettings',
    ]);
    expect(readPerTier(tiers, 'otelHeadersHelper')).toEqual([
      { source: 'localSettings', value: 'local-helper' },
    ]);
    expect(readPerTier(tiers, 'autoMemoryDirectory')).toEqual([]);
  });

  it('reads a boolean flag from its explicit union of sources', () => {
    const tiers = new Map<SettingsSource, unknown>([
      ['userSettings', { skipWorkflowUsageWarning: false }],
      ['localSettings', { skipWorkflowUsageWarning: true }],
      ['policySettings', { skipWorkflowUsageWarning: false }],
    ]);

    expect([...BOOLEAN_FLAG_SOURCES].sort()).toEqual(
      ['flagSettings', 'localSettings', 'policySettings', 'userSettings'].sort(),
    );
    // The union is a membership set: the winner inside it is the highest precedence
    // member (machine policy first), not the first one listed.
    expect(readBooleanFlag(tiers, 'skipWorkflowUsageWarning')).toEqual({
      source: 'policySettings',
      value: false,
    });

    const withoutPolicy = new Map<SettingsSource, unknown>([
      ['userSettings', { skipWorkflowUsageWarning: false }],
      ['localSettings', { skipWorkflowUsageWarning: true }],
    ]);
    expect(readBooleanFlag(withoutPolicy, 'skipWorkflowUsageWarning')).toEqual({
      source: 'localSettings',
      value: true,
    });
  });

  it('reads a policy-and-user flag only from the policy and user settings', () => {
    const tiers = new Map<SettingsSource, unknown>([
      ['userSettings', { skipDangerousModePermissionPrompt: true }],
      ['localSettings', { skipDangerousModePermissionPrompt: true }],
      ['flagSettings', { skipDangerousModePermissionPrompt: true }],
    ]);

    expect([...POLICY_AND_USER_SOURCES]).toEqual(['policySettings', 'userSettings']);
    expect(readBooleanFlag(tiers, 'skipDangerousModePermissionPrompt')).toEqual({
      source: 'userSettings',
      value: true,
    });
  });

  it('refuses to read a boolean flag that has no explicit union', () => {
    const tiers = new Map<SettingsSource, unknown>([['localSettings', { someFlag: true }]]);

    expect(() => readBooleanFlag(tiers, 'someFlag')).toThrow(/explicit source union/);
    // A caller that knows the union can still read the flag.
    expect(readBooleanFlag(tiers, 'someFlag', POLICY_AND_USER_SOURCES)).toBeUndefined();
  });

  it('ignores a project or local spellcheck block in the merged-key path', () => {
    // The merged-key order is local, project, user — but a spellcheck block in
    // project or local settings is ignored *entirely*, not merely out-ranked.
    const tiers = new Map<SettingsSource, unknown>([
      ['userSettings', { spellcheck: { enabled: true } }],
      ['projectSettings', { spellcheck: { enabled: false } }],
      ['localSettings', { spellcheck: { enabled: false } }],
    ]);

    expect(resolveMergedKey(tiers, 'spellcheck')).toEqual([
      { source: 'userSettings', value: { enabled: true } },
    ]);
  });

  it('resolves no spellcheck at all when only a project or local tier defines it', () => {
    const tiers = new Map<SettingsSource, unknown>([
      ['projectSettings', { spellcheck: { enabled: false } }],
      ['localSettings', { spellcheck: { enabled: false } }],
    ]);

    expect(resolveMergedKey(tiers, 'spellcheck')).toEqual([]);
    expect(resolveBlock(tiers, 'spellcheck')).toBeUndefined();
  });

  it('ignores a project or local spellcheck block in the merged-settings document', () => {
    const tiers = new Map<SettingsSource, unknown>([
      ['userSettings', { spellcheck: { enabled: true } }],
      ['localSettings', { spellcheck: { enabled: false } }],
    ]);

    const merged = mergeMergedSettings(tiers);

    // The local block is ignored entirely, so the user block survives unchanged.
    expect(merged['spellcheck']).toEqual({ enabled: true });
  });

  it('merges no spellcheck block when only a project or local tier defines it', () => {
    const tiers = new Map<SettingsSource, unknown>([
      ['projectSettings', { spellcheck: { enabled: false } }],
      ['localSettings', { spellcheck: { enabled: false } }],
    ]);

    const merged = mergeMergedSettings(tiers);

    expect(Object.hasOwn(merged, 'spellcheck')).toBe(false);
    expect(merged['spellcheck']).toBeUndefined();
  });
});

describe('tier wrapper discrimination', () => {
  it('treats a document with source and value keys as a document, not a wrapper', () => {
    // The target preserves unknown keys, so this is a legal settings document.
    const document = { source: 'userSettings', value: { nested: true } };
    const tiers = new Map<SettingsSource, unknown>([['userSettings', document]]);

    expect(resolveTopLevelKey(tiers, 'value')).toEqual([
      { source: 'userSettings', value: { nested: true } },
    ]);
    expect(resolveTopLevelKey(tiers, 'source')).toEqual([
      { source: 'userSettings', value: 'userSettings' },
    ]);
  });

  it('converts plain tier entries into documents', () => {
    const tiers = new Map<SettingsSource, SettingsTier>([
      ['userSettings', { source: 'userSettings', value: { model: 'user-model' } }],
    ]);

    expect(effectiveSource(documentsOf(tiers), 'model')).toBe('userSettings');
  });

  it('does not mistake a document that merely carries a value key for a wrapper', () => {
    // The target preserves unknown keys, so a legal settings document may carry a
    // `value` key. A wrapper is recognised by a `source` *and* a `value` key, so
    // the document is never unwrapped and its own keys survive.
    const document = JSON.parse('{"value": 42, "model": "user-model"}') as Record<
      string,
      unknown
    >;
    const tiers = new Map<SettingsSource, unknown>([['userSettings', document]]);

    const documents = documentsOf(tiers);

    expect(documents.get('userSettings')).toBe(document);
    expect(effectiveSource(documents, 'model')).toBe('userSettings');
    expect(effectiveSource(documents, 'value')).toBe('userSettings');
  });

  it('merges documents without letting a settings file replace the prototype', () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;

    const merged = mergeDocuments({}, hostile);

    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(merged, '__proto__')).toBe(false);
  });
});

describe('settings lookup hardening', () => {
  /**
   * The names of the `Object.prototype` members a legal settings document may
   * carry as an ordinary key: the target preserves unknown keys, so a document
   * that contains `constructor` is legal.
   */
  const PROTOTYPE_NAMED_KEYS = [
    'constructor',
    'toString',
    'hasOwnProperty',
    'valueOf',
    '__proto__',
  ] as const;

  function captureError(run: () => unknown): unknown {
    try {
      run();
      return undefined;
    } catch (error) {
      return error;
    }
  }

  it('does not crash on a settings document that carries prototype-named keys', () => {
    // A legal document: every key here is an unknown key the target preserves.
    const document = JSON.parse(
      '{"constructor": 1, "toString": 2, "hasOwnProperty": 3, "valueOf": 4, "__proto__": 5}',
    ) as Record<string, unknown>;
    const tiers = new Map<SettingsSource, unknown>([['userSettings', document]]);

    for (const [index, key] of PROTOTYPE_NAMED_KEYS.entries()) {
      const value = index + 1;
      // No lookup may throw for a key that is merely an `Object.prototype` member.
      expect(() => resolveBlock(tiers, key)).not.toThrow();
      expect(() => readPerTier(tiers, key)).not.toThrow();
      expect(() => effectiveOrdinarySource(tiers, key)).not.toThrow();
      // Such a key is simply unrestricted: it resolves like any other key.
      expect(resolveBlock(tiers, key)).toEqual({ source: 'userSettings', value });
      expect(effectiveOrdinarySource(tiers, key)).toBe('userSettings');
      expect(readPerTier(tiers, key)).toEqual([{ source: 'userSettings', value }]);
      // A boolean flag with no registered union is a clear error, not a crash.
      const error = captureError(() => readBooleanFlag(tiers, key));
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/explicit source union/);
      expect(error).not.toBeInstanceOf(TypeError);
    }
  });

  it('reports no scope for a source that is not in the scope map', () => {
    // The scope map is a plain object, so its lookup must be an own-property
    // check: a caller that passes an `Object.prototype` member name gets no
    // scope rather than the inherited member.
    expect(scopeFor('constructor' as unknown as SettingsSource)).toBeNull();
    expect(scopeFor('toString' as unknown as SettingsSource)).toBeNull();
  });

  it('loads a settings file with prototype-named keys and resolves them without crashing', () => {
    const workspace = makeWorkspace();
    const document = JSON.parse(
      '{"constructor": "ctor", "toString": "ts", "hasOwnProperty": "hop", "valueOf": "vo", "__proto__": "proto", "model": "user-model"}',
    ) as Record<string, unknown>;
    writeJson(path.join(workspace.configDir, 'settings.json'), document);

    const result = loadSettings({
      cwd: workspace.cwd,
      configDir: workspace.configDir,
      restricted: false,
    });

    const tiers = result.tiers;
    for (const key of PROTOTYPE_NAMED_KEYS) {
      expect(() => resolveBlock(tiers, key)).not.toThrow();
      expect(() => readPerTier(tiers, key)).not.toThrow();
      expect(() => effectiveOrdinarySource(tiers, key)).not.toThrow();
      expect(() => readBooleanFlag(tiers, key)).toThrow(/explicit source union/);
    }
    // The unknown keys survive the load; `__proto__` is dropped by the schema, so
    // a settings file can never replace the prototype of the object it lands in.
    expect(resolveBlock(tiers, 'constructor')?.value).toBe('ctor');
    expect(resolveBlock(tiers, 'toString')?.value).toBe('ts');
    expect(effectiveOrdinarySource(tiers, 'model')).toBe('userSettings');
  });
});

describe('settings loader', () => {
  it('reports a project settings symlink to the user settings file as linked away', () => {
    const workspace = makeWorkspace();
    const projectDir = makeProjectDir(workspace);
    const userPath = path.join(workspace.configDir, 'settings.json');
    writeJson(userPath, { model: 'user-model' });
    symlinkSync(userPath, path.join(projectDir, 'settings.json'));

    const result = loadSettings({
      cwd: workspace.cwd,
      configDir: workspace.configDir,
      restricted: false,
    });

    expect(result.linkedAway).toContain('projectSettings');
    expect(result.tiers.has('projectSettings')).toBe(false);
    expect(result.readMode.get('projectSettings')).toBe('none');
    expect(result.tiers.get('userSettings')?.value).toEqual({ model: 'user-model' });
  });

  it('reports a project settings hard link to the user settings file as linked away', () => {
    const workspace = makeWorkspace();
    const projectDir = makeProjectDir(workspace);
    const userPath = path.join(workspace.configDir, 'settings.json');
    writeJson(userPath, { model: 'user-model' });
    linkSync(userPath, path.join(projectDir, 'settings.json'));

    const result = loadSettings({
      cwd: workspace.cwd,
      configDir: workspace.configDir,
      restricted: false,
    });

    expect(result.linkedAway).toContain('projectSettings');
    expect(result.tiers.has('projectSettings')).toBe(false);
    expect(result.readMode.get('projectSettings')).toBe('none');
  });

  it('skips a project tier that resolves to the user settings file and reports it as read', () => {
    const workspace = makeWorkspace();
    // The project's `.claude` directory *is* the configuration directory, so the
    // project settings path and the user settings path resolve to the same file.
    symlinkSync(workspace.configDir, path.join(workspace.cwd, '.claude'));
    writeJson(path.join(workspace.configDir, 'settings.json'), { model: 'user-model' });

    const result = loadSettings({
      cwd: workspace.cwd,
      configDir: workspace.configDir,
      restricted: false,
    });

    expect(result.tiers.has('projectSettings')).toBe(false);
    expect(result.readMode.get('projectSettings')).toBe('as_read');
    expect(result.readMode.get('projectSettings')).not.toBe('none');
    expect(result.linkedAway).not.toContain('projectSettings');
  });

  it('reads a distinct project settings file as its own tier', () => {
    const workspace = makeWorkspace();
    const projectDir = makeProjectDir(workspace);
    writeJson(path.join(projectDir, 'settings.json'), { model: 'project-model' });

    const result = loadSettings({
      cwd: workspace.cwd,
      configDir: workspace.configDir,
      restricted: false,
    });

    expect(result.tiers.has('projectSettings')).toBe(true);
    expect(result.tiers.get('projectSettings')?.value).toEqual({ model: 'project-model' });
    expect(result.readMode.get('projectSettings')).toBe('as_read');
    expect(result.linkedAway).not.toContain('projectSettings');
    // The document is resolvable through the tier map.
    expect(effectiveOrdinarySource(result.tiers, 'model')).toBe('projectSettings');
  });

  it('merges local settings over the legacy local settings file with the local file winning', () => {
    // Implementation choice (not observed): the legacy file is merged at *block* granularity,
    // so the local file's `permissions` block replaces the legacy one wholesale
    // instead of being merged key by key — the legacy `deny` rule is dropped with
    // the rest of the block. The audit only states that local settings are "merged
    // over a legacy local settings file, with the local file taking precedence",
    // and the whole-block rule it states is about tiers, not files. A key-level
    // merge would satisfy the audit's wording equally well.
    const workspace = makeWorkspace();
    const projectDir = makeProjectDir(workspace);
    writeJson(path.join(workspace.configDir, 'settings.local.json'), {
      model: 'legacy-model',
      legacyOnly: true,
      permissions: { allow: ['Bash'], deny: ['Read'] },
    });
    writeJson(path.join(projectDir, 'settings.local.json'), {
      model: 'local-model',
      permissions: { allow: ['Read'] },
    });

    const result = loadSettings({
      cwd: workspace.cwd,
      configDir: workspace.configDir,
      restricted: false,
    });

    const local = result.tiers.get('localSettings')?.value as Record<string, unknown>;
    expect(local['model']).toBe('local-model');
    expect(local['legacyOnly']).toBe(true);
    expect(local['permissions']).toEqual({ allow: ['Read'] });
  });

  it('reads policy settings as machine-administered policy', () => {
    const workspace = makeWorkspace();
    writeJson(path.join(workspace.configDir, 'managed-settings.json'), {
      sandbox: { enabled: false },
    });

    const result = loadSettings({
      cwd: workspace.cwd,
      configDir: workspace.configDir,
      restricted: false,
    });

    expect(result.readMode.get('policySettings')).toBe('machine_admin');
    expect(result.tiers.has('policySettings')).toBe(true);
    expect(result.tiers.get('policySettings')?.value).toEqual({ sandbox: { enabled: false } });
  });

  it('omits the project and local tiers when personal config is restricted', () => {
    const workspace = makeWorkspace();
    const projectDir = makeProjectDir(workspace);
    writeJson(path.join(workspace.configDir, 'settings.json'), { model: 'user-model' });
    writeJson(path.join(projectDir, 'settings.json'), { model: 'project-model' });
    writeJson(path.join(projectDir, 'settings.local.json'), { model: 'local-model' });

    const result = loadSettings({
      cwd: workspace.cwd,
      configDir: workspace.configDir,
      restricted: true,
    });

    expect(result.tiers.has('projectSettings')).toBe(false);
    expect(result.tiers.has('localSettings')).toBe(false);
    expect(result.readMode.get('projectSettings')).toBe('none');
    expect(result.readMode.get('localSettings')).toBe('none');
    expect(me('projectSettings', true)).toBeNull();
    expect(me('localSettings', true)).toBeNull();
    expect(result.tiers.has('userSettings')).toBe(true);
  });

  it('records an error for a malformed settings file and does not apply the tier', () => {
    const workspace = makeWorkspace();
    const userPath = path.join(workspace.configDir, 'settings.json');
    writeFileSync(userPath, '{ "model": ', 'utf8');

    const result = loadSettings({
      cwd: workspace.cwd,
      configDir: workspace.configDir,
      restricted: false,
    });

    expect(result.tiers.has('userSettings')).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.source).toBe('userSettings');
    expect(result.errors[0]?.severity).toBe('error');
    expect(result.errors[0]?.path).toBe(userPath);
  });

  it('warns about a linked-away project tier', () => {
    const workspace = makeWorkspace();
    const projectDir = makeProjectDir(workspace);
    const userPath = path.join(workspace.configDir, 'settings.json');
    writeJson(userPath, { model: 'user-model' });
    symlinkSync(userPath, path.join(projectDir, 'settings.json'));

    const result = loadSettings({
      cwd: workspace.cwd,
      configDir: workspace.configDir,
      restricted: false,
    });

    const warnings = result.errors.filter((error) => error.severity === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.source).toBe('projectSettings');
    expect(warnings[0]?.message).toContain('linked away');
  });

  it('warns about a project tier that resolves to the user settings file', () => {
    const workspace = makeWorkspace();
    symlinkSync(workspace.configDir, path.join(workspace.cwd, '.claude'));
    writeJson(path.join(workspace.configDir, 'settings.json'), { model: 'user-model' });

    const result = loadSettings({
      cwd: workspace.cwd,
      configDir: workspace.configDir,
      restricted: false,
    });

    const warnings = result.errors.filter((error) => error.severity === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.source).toBe('projectSettings');
    expect(warnings[0]?.message).toContain('same file');
  });

  it('applies the flag settings overlay', () => {
    const workspace = makeWorkspace();
    writeJson(path.join(workspace.configDir, 'settings.json'), { model: 'user-model' });

    const result = loadSettings({
      cwd: workspace.cwd,
      configDir: workspace.configDir,
      restricted: false,
      flagSettings: { model: 'flag-model' },
    });

    expect(result.tiers.has('flagSettings')).toBe(true);
    expect(result.tiers.get('flagSettings')?.value).toEqual({ model: 'flag-model' });
    expect(result.readMode.get('flagSettings')).toBe('as_read');
    // The flag tier wins a top-level key over the user tier.
    expect(effectiveSource(result.tiers, 'model')).toBe('flagSettings');
  });

  it('resolves a loaded tier through the top-level and merged rules', () => {
    const workspace = makeWorkspace();
    const projectDir = makeProjectDir(workspace);
    writeJson(path.join(workspace.configDir, 'settings.json'), { model: 'user-model' });
    writeJson(path.join(projectDir, 'settings.json'), { model: 'project-model' });
    writeJson(path.join(projectDir, 'settings.local.json'), { model: 'local-model' });

    const result = loadSettings({
      cwd: workspace.cwd,
      configDir: workspace.configDir,
      restricted: false,
    });

    // The load result is a tier map, so it can be handed to the resolvers directly.
    expect(effectiveSource(result.tiers, 'model')).toBe('userSettings');
    expect(resolveMergedKey(result.tiers, 'model')[0]?.source).toBe('localSettings');
  });
});

describe('sandbox configuration', () => {
  it('writes the sandbox configuration with mode 0o600 and canonicalizes path entries', () => {
    const workspace = makeWorkspace();
    const target = path.join(workspace.root, 'real-target');
    mkdirSync(target, { recursive: true });
    const link = path.join(workspace.root, 'linked-target');
    symlinkSync(target, link);

    const result = writeSandboxSettings({
      configDir: workspace.configDir,
      sandbox: {
        enabled: true,
        filesystem: { allowRead: [link], allowWrite: [path.join(workspace.root, 'not-yet')] },
      },
    });

    expect(result.path).toBe(path.join(workspace.configDir, 'settings.json'));
    const stats = statSync(result.path);
    expect(stats.mode & 0o777).toBe(0o600);

    const written = JSON.parse(readFileSync(result.path, 'utf8')) as {
      sandbox: { filesystem: { allowRead: string[]; allowWrite: string[] } };
    };
    // The symlinked entry is resolved to its real path before it is written.
    expect(written.sandbox.filesystem.allowRead).toEqual([realpathSync(target)]);
    expect(written.sandbox.filesystem.allowWrite).toEqual([
      path.join(workspace.root, 'not-yet'),
    ]);
  });

  it('preserves the other keys of the settings file when writing the sandbox block', () => {
    const workspace = makeWorkspace();
    writeJson(path.join(workspace.configDir, 'settings.json'), { model: 'user-model' });

    writeSandboxSettings({
      configDir: workspace.configDir,
      sandbox: { enabled: false, filesystem: { denyRead: ['/etc'] } },
    });

    const written = JSON.parse(
      readFileSync(path.join(workspace.configDir, 'settings.json'), 'utf8'),
    ) as { model: string; sandbox: { enabled: boolean } };
    expect(written.model).toBe('user-model');
    expect(written.sandbox.enabled).toBe(false);
  });

  it('refuses to overwrite a malformed settings file', () => {
    const workspace = makeWorkspace();
    const settingsPath = path.join(workspace.configDir, 'settings.json');
    writeFileSync(settingsPath, '{ not json', 'utf8');

    expect(() =>
      writeSandboxSettings({ configDir: workspace.configDir, sandbox: { enabled: true } }),
    ).toThrow(/refusing to overwrite/);
    expect(readFileSync(settingsPath, 'utf8')).toBe('{ not json');
  });

  it('creates the configuration directory with restrictive permissions', () => {
    const workspace = makeWorkspace();
    const configDir = path.join(workspace.root, 'created-config');

    writeSandboxSettings({ configDir, sandbox: { enabled: true } });

    const stats = statSync(configDir);
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it('narrows an existing wider configuration directory to the same mode', () => {
    const workspace = makeWorkspace();
    const configDir = path.join(workspace.root, 'existing-config');
    // A directory that already existed may carry a wider mode: the mode
    // `mkdir` sets is filtered through the process's umask, and a directory
    // that was there before is not created at all.
    mkdirSync(configDir, { recursive: true, mode: 0o755 });
    chmodSync(configDir, 0o755);
    expect(statSync(configDir).mode & 0o777).toBe(0o755);

    writeSandboxSettings({ configDir, sandbox: { enabled: true } });

    expect(statSync(configDir).mode & 0o777).toBe(0o700);
  });

  it('canonicalizes a path through its deepest existing ancestor', () => {
    const workspace = makeWorkspace();
    const real = path.join(workspace.root, 'real');
    mkdirSync(real, { recursive: true });
    const link = path.join(workspace.root, 'link');
    symlinkSync(real, link);

    // The symlinked ancestor is resolved; the missing tail is preserved.
    expect(canonicalizePath(path.join(link, 'a', 'b', 'c'))).toBe(
      path.join(realpathSync(real), 'a', 'b', 'c'),
    );
  });

  it('expands a leading ~ in a path entry', () => {
    const realHome = realpathSync(homedir());

    expect(canonicalizePath('~')).toBe(realHome);
    expect(canonicalizePath('~/x')).toBe(path.join(realHome, 'x'));
  });
});

describe('settings document schema', () => {
  it('preserves unknown keys', () => {
    const result = parseSettingsDocument({ unknownKey: { nested: true }, model: 'x' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value['unknownKey']).toEqual({ nested: true });
      expect(result.value['model']).toBe('x');
    }
  });

  it('validates the permission rule lists and the sandbox filesystem block', () => {
    const result = parseSettingsDocument({
      permissions: {
        allow: ['Bash(ls:*)'],
        deny: ['Read(./secret)'],
        ask: [],
        defaultMode: 'plan',
      },
      sandbox: {
        filesystem: {
          allowRead: ['/tmp'],
          allowWrite: ['/tmp/out'],
          denyRead: ['/etc'],
          denyWrite: ['/etc'],
          credentials: ['.aws/credentials'],
        },
      },
      spellcheck: { enabled: true },
    });

    expect(result.ok).toBe(true);
  });

  it('rejects a document whose known key has the wrong shape', () => {
    const result = parseSettingsDocument({ permissions: { allow: 'Bash(ls:*)' } });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]).toContain('permissions.allow');
  });
});

// --- the settings document --------------------------------------------------
//
// The target's settings document is 183 top-level keys, each with the target's
// own prose, plus the seven keys the gated blocks contribute, plus the
// `permissions` block (7 keys) and the `sandbox` block (16 keys). The document
// is read out of the pinned build at `chunk-c9s0jh80.js:253945`–`323785`.

/**
 * A representative value for a schema, or `undefined` when the schema has no
 * value this helper can produce.
 *
 * The helper reads the schema's own `def`, so the sample it produces is a value
 * of the right *kind* — and, where the schema carries a bound, a value that
 * satisfies it.
 */
function sampleValue(schema: unknown): unknown {
  const def = (schema as { def?: Record<string, unknown> } | undefined)?.def as
    | {
        type?: string;
        innerType?: unknown;
        out?: unknown;
        entries?: Record<string, unknown>;
        options?: unknown[];
        values?: unknown[];
        shape?: Record<string, unknown>;
        checks?: unknown[];
      }
    | undefined;
  if (!def || typeof def.type !== 'string') return undefined;
  switch (def.type) {
    case 'optional':
    case 'nullable':
    case 'catch':
    case 'default':
      return sampleValue(def.innerType);
    case 'pipe': {
      // A pipe is either a transform (`in` is the source) or a preprocess
      // (`in` is the transform and `out` is the target).
      const inType = (def as { in?: { def?: { type?: string } } }).in?.def?.type;
      return sampleValue(inType === 'transform' ? def.out : (def as { in?: unknown }).in);
    }
    case 'string':
      return sampleString(def);
    case 'number':
      return sampleNumber(def);
    case 'boolean':
      return true;
    case 'literal':
      return Array.isArray(def.values) ? def.values[0] : undefined;
    case 'enum':
      return def.entries ? Object.values(def.entries)[0] : undefined;
    case 'array':
      return [];
    case 'record':
      return {};
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [name, member] of Object.entries(def.shape ?? {})) {
        const memberType = (member as { def?: { type?: string } } | undefined)?.def?.type;
        if (memberType === 'optional') continue;
        const value = sampleValue(member);
        if (value !== undefined) out[name] = value;
      }
      return out;
    }
    case 'union': {
      for (const option of def.options ?? []) {
        const value = sampleValue(option);
        if (value !== undefined) return value;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** A string that satisfies a string schema's own checks. */
function sampleString(def: { checks?: unknown[] }): string | undefined {
  for (const check of def.checks ?? []) {
    const pattern = (check as { pattern?: RegExp }).pattern;
    if (pattern) {
      // The only patterns the document's strings carry are the two quiet-hours
      // clock times.
      if (pattern.source === '^([01]?\\d|2[0-3]):[0-5]\\d$') return '00:00';
      return undefined;
    }
    const format = (check as { def?: { format?: string } }).def?.format;
    if (format === 'url') return 'https://example.com';
  }
  return 'sample';
}

/** A number that satisfies a number schema's own bounds. */
function sampleNumber(def: { checks?: unknown[] }): number {
  let value = 1;
  let integer = false;
  for (const check of def.checks ?? []) {
    const bound = check as {
      minimum?: number;
      maximum?: number;
      inclusive?: boolean;
      def?: { format?: string };
    };
    if (bound.def?.format === 'safeint') integer = true;
    if (typeof bound.minimum === 'number') {
      value = Math.max(value, bound.inclusive === false ? bound.minimum + 1 : bound.minimum);
    }
    if (typeof bound.maximum === 'number') {
      value = Math.min(value, bound.inclusive === false ? bound.maximum - 1 : bound.maximum);
    }
  }
  return integer ? Math.round(value) : value;
}

describe('the settings document', () => {
  it('names the 183 keys the target accepts', () => {
    expect(SETTINGS_DOCUMENT_KEYS).toHaveLength(183);
    // The first and the last of the target's own listing.
    expect(SETTINGS_DOCUMENT_KEYS[0]).toBe('$schema');
    expect(SETTINGS_DOCUMENT_KEYS[SETTINGS_DOCUMENT_KEYS.length - 1]).toBe(
      'agentPushNotifEnabled',
    );
    // The key names are the target's, so a settings file written for the
    // target is a settings file for this implementation.
    expect(SETTINGS_DOCUMENT_KEYS).toContain('syncClaudeAiSkills');
    expect(SETTINGS_DOCUMENT_KEYS).toContain('claudeMd');
    expect(SETTINGS_DOCUMENT_KEYS).toContain('disableAutoMode');
  });

  it('accepts every key the target accepts', () => {
    const shape = settingsDocumentSchema.shape as Record<string, unknown>;
    const document: Record<string, unknown> = {};
    const omitted: string[] = [];
    for (const key of SETTINGS_DOCUMENT_KEYS) {
      const value = sampleValue(shape[key]);
      if (value === undefined) {
        omitted.push(key);
        continue;
      }
      document[key] = value;
    }

    // Every key of the document has a representative value, and a document
    // that carries all of them parses.
    expect(omitted).toEqual([]);
    const result = parseSettingsDocument(document);
    expect(result.ok).toBe(true);
  });

  it('requires none of its keys, because the target never rejects a document for omitting one', () => {
    const result = parseSettingsDocument({});
    expect(result.ok).toBe(true);
  });

  it('rejects a known key whose type is wrong', () => {
    const result = parseSettingsDocument({ cleanupPeriodDays: 'thirty' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join('; ')).toContain('cleanupPeriodDays');
  });

  it('rejects a value outside the bound the target states', () => {
    // The target's own description: "Minimum 1". The target does not catch
    // this one, so a document that breaks the bound is refused.
    expect(parseSettingsDocument({ cleanupPeriodDays: 0 }).ok).toBe(false);
    // The target's own description: "Minimum 40". This one the target
    // **catches**: the value is dropped and the document is accepted, which is
    // a different behaviour and is reproduced as such.
    expect(parseSettingsDocument({ maxProseWidth: 39 }).ok).toBe(true);
    expect(parseSettingsDocument({ maxProseWidth: 40 }).ok).toBe(true);
  });

  it('describes every key with a prose of its own', () => {
    const shape = settingsDocumentSchema.shape as Record<
      string,
      { description?: string } | undefined
    >;
    for (const key of SETTINGS_DOCUMENT_KEYS) {
      // The target describes every key of its document except `sandbox`,
      // which it describes through its own sub-schema.
      if (key === 'sandbox') continue;
      const description = shape[key]?.description;
      expect(typeof description, `the description of ${key}`).toBe('string');
      expect((description ?? '').length, `the description of ${key}`).toBeGreaterThan(0);
    }
    // The sandbox block is described through its own members.
    const sandbox = sandboxSchema.shape as Record<string, { description?: string } | undefined>;
    for (const key of ['enabled', 'failIfUnavailable', 'allowUnsandboxedCommands']) {
      expect(typeof sandbox[key]?.description, `the description of sandbox.${key}`).toBe('string');
    }
  });

  it('names no target product name in any description', () => {
    const shape = settingsDocumentSchema.shape as Record<
      string,
      { description?: string } | undefined
    >;
    for (const key of SETTINGS_DOCUMENT_KEYS) {
      const description = shape[key]?.description ?? '';
      expect(description, `the description of ${key}`).not.toMatch(/Claude Code/);
      expect(description, `the description of ${key}`).not.toMatch(/\bClaude\b/);
    }
  });

  it("accepts 'manual' as an alias for 'default'", () => {
    const result = parseSettingsDocument({ permissions: { defaultMode: 'manual' } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const permissions = result.value['permissions'] as { defaultMode?: string };
      expect(permissions.defaultMode).toBe('default');
    }
  });

  it('rejects a permission rule that is malformed', () => {
    expect(parseSettingsDocument({ permissions: { allow: ['Bash('] } }).ok).toBe(false);
    expect(parseSettingsDocument({ permissions: { allow: ['Bash()'] } }).ok).toBe(false);
    expect(parseSettingsDocument({ permissions: { allow: [''] } }).ok).toBe(false);
    expect(parseSettingsDocument({ permissions: { allow: ['bash(ls)'] } }).ok).toBe(false);
    expect(parseSettingsDocument({ permissions: { allow: ['Bash(ls)'] } }).ok).toBe(true);
  });
});

describe('the gated blocks', () => {
  it('contributes the seven keys the target adds outside the 183', () => {
    expect(GATED_SETTINGS_KEYS).toHaveLength(7);
    const shape = settingsDocumentSchema.shape as Record<string, unknown>;
    for (const key of GATED_SETTINGS_KEYS) {
      expect(Object.hasOwn(shape, key), `the gated key ${key}`).toBe(true);
    }
    // The gated keys are not part of the 183.
    for (const key of GATED_SETTINGS_KEYS) {
      expect(SETTINGS_DOCUMENT_KEYS as readonly string[]).not.toContain(key);
    }
  });

  it('contributes disableAutoMode to the permissions block', () => {
    const result = parseSettingsDocument({ permissions: { disableAutoMode: 'disable' } });

    expect(result.ok).toBe(true);
    expect(parseSettingsDocument({ permissions: { disableAutoMode: 'off' } }).ok).toBe(false);
  });
});

describe('the permissions block', () => {
  it('has the seven keys the target names, plus the one the gated block adds', () => {
    const permissions = permissionsSchema.shape as Record<string, unknown>;

    // The target's own permissions sub-schema names seven keys, and the
    // `autoMode` gated block contributes an eighth — `disableAutoMode`, the
    // same key the top level carries.
    expect(Object.keys(permissions).sort()).toEqual(
      [
        'additionalDirectories',
        'allow',
        'ask',
        'blockReadsOutsideWorkingDirectories',
        'defaultMode',
        'deny',
        'disableAutoMode',
        'disableBypassPermissionsMode',
      ].sort(),
    );
  });
});

describe('the sandbox block', () => {
  it('has the sixteen keys the target names', () => {
    const sandbox = sandboxSchema.shape as Record<string, unknown>;

    expect(Object.keys(sandbox).sort()).toEqual(
      [
        'allowAppleEvents',
        'allowUnsandboxedCommands',
        'autoAllowBashIfSandboxed',
        'bwrapPath',
        'credentials',
        'enableWeakerNestedSandbox',
        'enableWeakerNetworkIsolation',
        'enabled',
        'enabledPlatforms',
        'excludedCommands',
        'failIfUnavailable',
        'filesystem',
        'ignoreViolations',
        'network',
        'ripgrep',
        'socatPath',
      ].sort(),
    );
  });
});

describe('the defaults of the settings document', () => {
  it('distinguishes a key with no default from a key whose default is false', () => {
    // The target's own description: "(default: true)".
    expect(settingsDefault('respectGitignore')).toBe(true);
    // The target's own description: "Defaults to padded-countdown".
    expect(settingsDefault('totalTokensReminder')).toBe('padded-countdown');
    // The target says nothing about a default for this one, so it has none.
    // That is not the same as a default of `false`.
    expect(settingsDefault('verbose')).toBeUndefined();
    expect(settingsDefault('prefersReducedMotion')).toBeUndefined();
  });

  it('reads a key that names an Object.prototype member as having no default', () => {
    expect(settingsDefault('constructor')).toBeUndefined();
    expect(settingsDefault('toString')).toBeUndefined();
    expect(settingsDefault('__proto__')).toBeUndefined();
  });

  it('falls back to the default when a document does not carry the key', () => {
    expect(effectiveSettingValue({ model: 'x' }, 'respectGitignore')).toBe(true);
    expect(effectiveSettingValue({ respectGitignore: false }, 'respectGitignore')).toBe(false);
    expect(effectiveSettingValue({}, 'cleanupPeriodDays')).toBe(30);
    expect(effectiveSettingValue({ cleanupPeriodDays: 7 }, 'cleanupPeriodDays')).toBe(7);
    expect(effectiveSettingValue({}, 'verbose')).toBeUndefined();
  });
});

describe('the two sibling config systems', () => {
  it('the workspace config is a separate document with 28 keys', () => {
    expect(WORKSPACE_CONFIG_KEYS).toHaveLength(28);
    const shape = workspaceConfigSchema.shape as Record<string, unknown>;
    for (const key of WORKSPACE_CONFIG_KEYS) {
      expect(Object.hasOwn(shape, key), `the workspace key ${key}`).toBe(true);
    }
  });

  it('the flat managed config is a separate document with 22 keys', () => {
    expect(FLAT_MANAGED_CONFIG_KEYS).toHaveLength(22);
    const shape = flatManagedConfigSchema.shape as Record<string, unknown>;
    for (const key of FLAT_MANAGED_CONFIG_KEYS) {
      expect(Object.hasOwn(shape, key), `the managed-config key ${key}`).toBe(true);
    }
  });

  it('keeps the sibling documents apart from the settings document', () => {
    // The documents are separate: they are separate schemas with separate
    // keys, and a key of one is not a key of the other.
    expect(workspaceConfigSchema).not.toBe(settingsDocumentSchema);
    expect(flatManagedConfigSchema).not.toBe(settingsDocumentSchema);

    const settings = new Set<string>(SETTINGS_DOCUMENT_KEYS);
    const workspace = new Set<string>(WORKSPACE_CONFIG_KEYS);
    // A key only the workspace config has.
    expect(settings.has('organizationInstructions')).toBe(false);
    expect(workspace.has('organizationInstructions')).toBe(true);
    // A key only the settings document has.
    expect(settings.has('cleanupPeriodDays')).toBe(true);
    expect(workspace.has('cleanupPeriodDays')).toBe(false);
  });

  it('validates the workspace config on its own', () => {
    const result = parseWorkspaceConfig({
      disableBundledSkills: true,
      organizationInstructions: 'do the thing',
    });

    expect(result.ok).toBe(true);
    expect(parseWorkspaceConfig({ organizationInstructions: '' }).ok).toBe(false);
  });

  it('expands a flat managed-config document into the nested shape', () => {
    const nested = materializeFlatManagedConfig({
      'inference.provider': 'bedrock',
      'workspace.disableBundledSkills': true,
    });

    expect(nested).toEqual({
      inference: { provider: 'bedrock' },
      workspace: { disableBundledSkills: true },
    });
  });

  it('parses a flat managed-config document through the nested schema', () => {
    const result = parseFlatManagedConfig({ 'workspace.disableBundledSkills': true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value['workspace'] as { disableBundledSkills?: boolean }).disableBundledSkills).toBe(
        true,
      );
    }
  });

  it('reads a managed-config section from the machine-admin tier only', () => {
    const tiers = new Map<SettingsSource, unknown>([
      ['policySettings', { workspace: { disableBundledSkills: true } }],
      ['userSettings', { workspace: { disableBundledSkills: false } }],
      ['localSettings', { workspace: { disableBundledSkills: false } }],
    ]);

    expect(readManagedConfigSection(tiers, 'workspace')).toEqual({
      source: 'policySettings',
      value: { disableBundledSkills: true },
    });
  });
});

describe('the managed config the loader is handed', () => {
  it('keeps a well-formed managed config', () => {
    const workspace = makeWorkspace();
    const result = loadSettings({
      cwd: workspace.cwd,
      configDir: workspace.configDir,
      restricted: false,
      managedConfig: { 'workspace.disableBundledSkills': true },
    });

    expect(result.managedConfigIssues ?? []).toEqual([]);
    expect(result.managedConfig).not.toBeNull();
  });

  it('reports a malformed managed config without failing the settings load', () => {
    const workspace = makeWorkspace();
    writeJson(path.join(workspace.configDir, 'settings.json'), { model: 'user-model' });

    const result = loadSettings({
      cwd: workspace.cwd,
      configDir: workspace.configDir,
      restricted: false,
      managedConfig: { 'workspace.organizationInstructions': '' },
    });

    expect((result.managedConfigIssues ?? []).length).toBeGreaterThan(0);
    // The settings themselves still load.
    expect(result.tiers.get('userSettings')?.value).toEqual({ model: 'user-model' });
  });
});

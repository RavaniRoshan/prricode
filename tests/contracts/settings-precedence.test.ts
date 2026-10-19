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
} from '../../src/config/tiers.js';
import { loadSettings } from '../../src/config/loader.js';
import {
  BOOLEAN_FLAG_SOURCES,
  POLICY_AND_USER_SOURCES,
  SCOPE_BY_SOURCE,
  SOURCE_ENUMERATION_ORDER,
  me,
  readBooleanFlag,
  readPerTier,
  readUserOnly,
  scopeFor,
} from '../../src/config/scope.js';
import {
  canonicalizePath,
  parseSettingsDocument,
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

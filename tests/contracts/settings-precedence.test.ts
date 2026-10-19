/**
 * Contract test for the settings tier model and precedence.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.7 (Configuration).
 *
 * The test pins the two **distinct** orderings the target declares, the tier
 * degradation and suppression rules, the scope separation, and the read modes.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  MERGED_KEY_ORDER,
  PROJECT_SIDE_SOURCES,
  TOP_LEVEL_KEY_ORDER,
  effectiveSource,
  resolveMergedKey,
  resolveTopLevelKey,
  type SettingsSource,
} from '../../src/config/tiers.js';
import { loadSettings, writeSandboxSettings } from '../../src/config/loader.js';
import {
  BOOLEAN_FLAG_SOURCES,
  POLICY_AND_USER_SOURCES,
  me,
  readBooleanFlag,
  readPerTier,
  readUserOnly,
  scopeFor,
} from '../../src/config/scope.js';
import { parseSettingsDocument } from '../../src/config/schema.js';

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
});

describe('settings scope separation', () => {
  it('suppresses exactly the project-side sources when personal config is restricted', () => {
    expect(me('projectSettings', true)).toBeNull();
    expect(me('localSettings', true)).toBeNull();
    expect(me('userSettings', true)).toBe('user');

    expect(me('projectSettings', false)).toBe('project');
    expect(me('localSettings', false)).toBe('local');
    expect(scopeFor('policySettings')).toBeNull();
    expect(scopeFor('flagSettings')).toBeNull();
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

  it('merges local settings over the legacy local settings file with the local file winning', () => {
    const workspace = makeWorkspace();
    const projectDir = makeProjectDir(workspace);
    writeJson(path.join(workspace.configDir, 'settings.local.json'), {
      model: 'legacy-model',
      legacyOnly: true,
      permissions: { allow: ['Bash'] },
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
    // The local block applies as a whole over the legacy block.
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
      permissions: { allow: ['Bash(ls:*)'], deny: ['Read(./secret)'], ask: [], defaultMode: 'plan' },
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

/**
 * Contract test for the extension surface: skills, subagents, plugins,
 * marketplaces, the extension-point registry, the skill-save protocol and the
 * IDE bridge.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("MCP, plugins, and
 * hooks") and `docs/compatibility/extension-surface.md` ("Skills", "Plugins",
 * "The extension-point registry"), and the `CC-013` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * The test pins:
 *
 *   - the four skill discovery sources (project, user, plugin, mcp) and the
 *     shared `discover()` shape (`{ name, source, path }`);
 *   - the skill override resolution: the four modes, the order (merged settings,
 *     session, policy, flag) and the prototype-key guard;
 *   - the frontmatter rule and the target's exact error text;
 *   - the extension-point registry: the fixed set of points, the generated
 *     `tool_use_id` and the default telemetry destination;
 *   - the skill-save protocol: the five guidance modes, their wording, and the
 *     rule that selects the mode;
 *   - the plugin manifest schema (directory keys, file keys, the
 *     top-level/`experimental` split, the string/array value shapes), the
 *     `broken` reason and the **candidate order**;
 *   - the plugin command discovery rules: the three naming shapes, the
 *     empty-directory warning, the byte limit and the body interning;
 *   - the marketplace install flow: refused versus failed, the two disable
 *     reasons, the enable hint, the version transition and the orphan marker;
 *   - the plugin **path boundary**: a manifest path that leaves the plugin
 *     root — lexically or through a symlink — is refused, for the commands,
 *     skills, agents and every other manifest-declared key; each of the six
 *     checks that holds that boundary is pinned **on its own**, so removing
 *     one of them fails the suite;
 *   - a refused path also lands in the manifest's own `problems`, so the
 *     manifest record is self-describing;
 *   - the **collisions** between two plugins that provide the same skill or
 *     subagent name: they are reported, not dropped silently — and **one**
 *     plugin that provides a name twice is reported as that, not as two
 *     plugins colliding;
 *   - the **collision semantics of a contributed name**: a conflict between
 *     two providers names the **other** provider in `collidesWith` and never
 *     the winner's own, a duplication by one provider names **no** provider,
 *     a provider that merely lost the precedence order is not a collision at
 *     all, a provider is named once however many paths it shipped the name
 *     under, and the `apply()` path reports the duplication and contributes
 *     the name **once**;
 *   - a declared path that **does not exist** is reported — in the log and in
 *     the manifest's own problems — for every key, rather than dropped
 *     silently;
 *   - the **discovery precedence** — `project > local > user > plugin > mcp`;
 *   - the **byte caps** on the skill and subagent definition files;
 *   - the IDE bridge's **action** validation: an action is a single path
 *     segment — empty, `.`, `..`, `/`, `\` and NUL are all refused.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SettingsSource, SettingsTierMap } from '../../src/config/tiers.js';
import {
  SKILL_OVERRIDE_MODES,
  SkillOverrideError,
  createSkillSessionStore,
  resolveSkillOverrideMode,
  type SkillOverrideMode,
} from '../../src/extensions/skills/overrides.js';
import {
  SkillFrontmatterError,
  assertSkillFrontmatter,
  parseFrontmatter,
  skillFrontmatterProblem,
} from '../../src/extensions/skills/frontmatter.js';
import {
  SKILL_SAVE_CAPABILITIES,
  SKILL_SAVE_MODES,
  SKILL_SYNCED_FOLDER_NOTE,
  SKILL_TELEMETRY_EVENTS,
  isSkillSaveMode,
  proposeSkillReadCheck,
  selectSkillSaveMode,
  skillSaveGuidance,
} from '../../src/extensions/skills/save.js';
import {
  createSkillRegistry,
  isReservedSkillName,
  RESERVED_SKILL_DIRECTORY_NAME,
  RESERVED_SKILL_NAMES,
  SKILL_FILE_BYTE_LIMIT,
  SKILL_FILE_NAME,
  type DiscoverySource,
  type Skill,
  type SkillContribution,
  type SkillRoot,
} from '../../src/extensions/skills/registry.js';
import {
  createSubagentRegistry,
  isValidSubagentName,
  subagentUnavailableMessage,
  SUBAGENT_FILE_BYTE_LIMIT,
  SUBAGENT_NAME_MAX_LENGTH,
  SUBAGENT_TIER_PRECEDENCE,
} from '../../src/extensions/subagents/registry.js';
import {
  EXTENSION_POINTS,
  createExtensionPointRegistry,
} from '../../src/extensions/plugins/extension-points.js';
import {
  PLUGIN_COMMAND_BYTE_LIMIT,
  discoverPluginCommands,
  type PluginCommandMetadata,
} from '../../src/extensions/plugins/commands.js';
import {
  PLUGIN_DIRECTORY_KEYS,
  PLUGIN_FILE_KEYS,
  parsePluginManifest,
} from '../../src/extensions/plugins/manifest.js';
import {
  createPluginManager,
  type PluginInstallRequest,
} from '../../src/extensions/plugins/registry.js';
import {
  createHttpIdeTransport,
  createIdeBridge,
  IDE_ACTIONS,
  isIdeAction,
  type IdeIntegration,
} from '../../src/integration/ide/bridge.js';

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'prricode-ext-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeFile(filePath: string, content: string): string {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

/** A skill directory: `<root>/<name>/SKILL.md`. */
function writeSkill(root: string, name: string, description = 'A skill.'): string {
  const dir = path.join(root, name);
  writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nThe body of ${name}.\n`,
  );
  return dir;
}

function tierMap(entries: Partial<Record<SettingsSource, unknown>>): SettingsTierMap {
  const tiers = new Map<SettingsSource, unknown>();
  for (const [source, value] of Object.entries(entries)) {
    tiers.set(source as SettingsSource, value);
  }
  return tiers;
}

// ---------------------------------------------------------------------------
// Skills: the four discovery sources
// ---------------------------------------------------------------------------

describe('skill discovery', () => {
  it('discovers a project skill, a user skill, a plugin skill and an MCP skill, each with its own source', () => {
    const cwd = tempDir();
    const configDir = tempDir();
    writeSkill(path.join(cwd, '.claude', 'skills'), 'project-skill');
    writeSkill(path.join(configDir, 'skills'), 'user-skill');

    const registry = createSkillRegistry({
      cwd,
      configDir,
      contributions: [
        {
          name: 'plugin-skill',
          source: 'plugin',
          path: '/plugins/demo/skills/plugin-skill/SKILL.md',
          provider: 'demo',
        },
        {
          name: 'mcp-skill',
          source: 'mcp',
          path: 'mcp://memory/mcp-skill',
          provider: 'memory',
        },
      ],
    });

    const byName = new Map(registry.list().map((skill) => [skill.name, skill]));
    expect(byName.get('project-skill')?.source).toBe('project');
    expect(byName.get('user-skill')?.source).toBe('user');
    expect(byName.get('plugin-skill')?.source).toBe('plugin');
    expect(byName.get('mcp-skill')?.source).toBe('mcp');

    // The plugin and MCP skills are contributed, not scanned.
    expect(byName.get('plugin-skill')?.path).toBe('/plugins/demo/skills/plugin-skill/SKILL.md');
    expect(byName.get('mcp-skill')?.path).toBe('mcp://memory/mcp-skill');
  });

  it('gives every discovered item the shared { name, source, path } shape', () => {
    const cwd = tempDir();
    const configDir = tempDir();
    writeSkill(path.join(cwd, '.claude', 'skills'), 'project-skill');

    const registry = createSkillRegistry({ cwd, configDir });
    const discovered = registry.discover();

    expect(discovered.length).toBe(1);
    expect(Object.keys(discovered[0] ?? {}).sort()).toEqual(['name', 'path', 'source']);
    expect(discovered[0]?.name).toBe('project-skill');
    expect(discovered[0]?.source).toBe('project');
    expect(discovered[0]?.path).toBe(path.join(cwd, '.claude', 'skills', 'project-skill', 'SKILL.md'));
  });

  it('resolves a skill by name and reports nothing for an unknown name', () => {
    const cwd = tempDir();
    const configDir = tempDir();
    writeSkill(path.join(cwd, '.claude', 'skills'), 'project-skill');

    const registry = createSkillRegistry({ cwd, configDir });
    expect(registry.resolve('project-skill')?.name).toBe('project-skill');
    expect(registry.resolve('nope')).toBeUndefined();
  });

  it('never resolves a skill name to an inherited member of Object.prototype', () => {
    const cwd = tempDir();
    const configDir = tempDir();
    writeSkill(path.join(cwd, '.claude', 'skills'), 'project-skill');

    const registry = createSkillRegistry({ cwd, configDir });
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(registry.resolve(name)).toBeUndefined();
    }
    expect(registry.list().map((skill) => skill.name)).toEqual(['project-skill']);
  });

  it('surfaces a skill whose frontmatter is malformed instead of dropping it', () => {
    const cwd = tempDir();
    const configDir = tempDir();
    writeFile(
      path.join(cwd, '.claude', 'skills', 'broken-skill', 'SKILL.md'),
      '---\ndescription: 42\n---\n\nBody.\n',
    );

    const registry = createSkillRegistry({ cwd, configDir });
    const skill = registry.resolve('broken-skill');
    expect(skill).toBeDefined();
    expect(skill?.problem).toBeDefined();
  });

  it('takes a plugin-provided skill from the plugin manager', () => {
    const pluginRoot = tempDir();
    writeFile(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', skills: 'skills' }),
    );
    writeFile(path.join(pluginRoot, 'SKILL.md'), '---\ndescription: Demo.\n---\n\nBody.\n');
    writeSkill(path.join(pluginRoot, 'skills'), 'plugin-skill');

    const manager = createPluginManager();
    manager.load(pluginRoot);

    const registry = createSkillRegistry({
      contributions: manager.skills(),
    });

    const skill = registry.resolve('plugin-skill');
    expect(skill?.source).toBe('plugin');
    expect(skill?.provider).toBe('demo');
  });

  it('never lets a skill directory named "__proto__" reach the prototype', () => {
    const root = tempDir();
    writeSkill(root, '__proto__');

    const registry = createSkillRegistry({ roots: [{ path: root, source: 'project' }] });

    expect(registry.list().map((skill) => skill.name)).toEqual([]);
    expect(registry.resolve('__proto__')).toBeUndefined();
    expect(({} as Record<string, unknown>)['__proto__']).toBe(Object.prototype);
  });

  it('resolves a name two sources provide by the precedence order: project, local, user, plugin, mcp', () => {
    const base = tempDir();
    const roots: SkillRoot[] = (['project', 'local', 'user'] as const).map((source) => {
      const root = path.join(base, source);
      writeSkill(root, 'shared');
      return { path: root, source };
    });
    const plugin: SkillContribution = {
      name: 'shared',
      source: 'plugin',
      path: '/plugins/demo/skills/shared/SKILL.md',
      provider: 'demo',
    };
    const mcp: SkillContribution = {
      name: 'shared',
      source: 'mcp',
      path: 'mcp://memory/shared',
      provider: 'memory',
    };

    const winner = (
      keptRoots: number,
      kept: readonly SkillContribution[],
    ): DiscoverySource | undefined =>
      createSkillRegistry({
        roots: roots.slice(roots.length - keptRoots),
        contributions: kept,
      }).resolve('shared')?.source;

    expect(winner(3, [plugin, mcp])).toBe('project');
    expect(winner(2, [plugin, mcp])).toBe('local');
    expect(winner(1, [plugin, mcp])).toBe('user');
    expect(winner(0, [plugin, mcp])).toBe('plugin');
    expect(winner(0, [mcp])).toBe('mcp');
  });

  it('skips a skill file over the byte limit', () => {
    const root = tempDir();
    const skillDir = path.join(root, 'huge');
    mkdirSync(skillDir, { recursive: true });
    writeFile(path.join(skillDir, 'SKILL.md'), 'x'.repeat(SKILL_FILE_BYTE_LIMIT + 1));

    const registry = createSkillRegistry({ roots: [{ path: root, source: 'project' }] });
    const skill = registry.resolve('huge');

    // REA observed: a `SKILL.md` over 1 000 000 bytes is **skipped** — the
    // target never reads it — and the skip is reported.
    expect(skill).toBeUndefined();
    const refusal = registry.refusals().find((entry) => entry.name === 'huge');
    expect(refusal?.level).toBe('warn');
    expect(refusal?.reason).toContain(
      `[skills] skipping ${path.join(skillDir, 'SKILL.md')}: ${SKILL_FILE_BYTE_LIMIT + 1} bytes exceeds ${SKILL_FILE_BYTE_LIMIT} byte limit`,
    );
  });

  it('reports a skill name two plugins provide, instead of dropping one silently', () => {
    const registry = createSkillRegistry({
      contributions: [
        {
          name: 'shared',
          source: 'plugin',
          path: '/plugins/first/skills/shared/SKILL.md',
          provider: 'first',
        },
        {
          name: 'shared',
          source: 'plugin',
          path: '/plugins/second/skills/shared/SKILL.md',
          provider: 'second',
        },
      ],
    });

    const skill = registry.resolve('shared');
    expect(skill?.provider).toBe('first');
    expect(skill?.collidesWith).toEqual(['second']);
  });
});

// ---------------------------------------------------------------------------
// The standalone skill directory scan
// ---------------------------------------------------------------------------

describe('the standalone skill directory scan', () => {
  /** A skills root that holds one skill per name. */
  function skillsRoot(names: readonly string[]): string {
    const root = tempDir();
    for (const name of names) writeSkill(root, name);
    return root;
  }

  it('scans a root one level deep, and takes the fixed file name SKILL.md', () => {
    const root = tempDir();
    writeSkill(root, 'alpha');
    // A nested definition is not found: the scan is **one level deep**.
    writeFile(
      path.join(root, 'alpha', 'nested', 'SKILL.md'),
      '---\nname: nested\ndescription: N.\n---\n\nBody.\n',
    );
    // The file name is fixed, with that exact case.
    writeFile(
      path.join(root, 'beta', 'skill.md'),
      '---\nname: beta\ndescription: B.\n---\n\nBody.\n',
    );

    const registry = createSkillRegistry({ roots: [{ path: root, source: 'project' }] });

    expect(registry.list().map((skill) => skill.name)).toEqual(['alpha']);
    expect(registry.resolve('nested')).toBeUndefined();
    expect(registry.resolve('beta')).toBeUndefined();
    expect(SKILL_FILE_NAME).toBe('SKILL.md');
  });

  it('skips an entry that is not a directory or a symlink', () => {
    const root = tempDir();
    // A file beside the skill folders is not a skill.
    writeFile(path.join(root, 'notes.md'), 'not a skill');
    writeSkill(root, 'alpha');

    const registry = createSkillRegistry({ roots: [{ path: root, source: 'project' }] });

    expect(registry.list().map((skill) => skill.name)).toEqual(['alpha']);
  });

  it('follows a symlinked skill directory', () => {
    const root = tempDir();
    const elsewhere = tempDir();
    writeSkill(elsewhere, 'alpha');
    symlinkSync(path.join(elsewhere, 'alpha'), path.join(root, 'alpha'), 'dir');

    const registry = createSkillRegistry({ roots: [{ path: root, source: 'project' }] });

    expect(registry.resolve('alpha')?.path).toBe(path.join(root, 'alpha', 'SKILL.md'));
  });

  it('skips the reserved entry name "synced"', () => {
    const root = tempDir();
    writeSkill(root, 'synced');
    writeSkill(root, 'alpha');

    const registry = createSkillRegistry({ roots: [{ path: root, source: 'project' }] });

    expect(registry.list().map((skill) => skill.name)).toEqual(['alpha']);
    const refusal = registry.refusals().find((entry) => entry.name === 'synced');
    expect(refusal?.level).toBe('warn');
    expect(refusal?.reason).toContain(
      `[skills] skipping reserved dir name 'synced' under ${root}: 'synced' is the sync-owned root`,
    );
    expect(RESERVED_SKILL_DIRECTORY_NAME).toBe('synced');
  });

  it('skips an entry whose name contains ":" in the synced scan', () => {
    const root = tempDir();
    writeSkill(root, 'a:b');
    writeSkill(root, 'alpha');

    // The synced scan skips the entry with a colon …
    const synced = createSkillRegistry({
      roots: [{ path: root, source: 'user', tier: 'syncedSkills' }],
    });
    expect(synced.list().map((skill) => skill.name)).toEqual(['alpha']);
    const refusal = synced.refusals().find((entry) => entry.name === 'a:b');
    expect(refusal?.reason).toContain(
      `[skills] skipping 'a:b' under ${root}: its name contains ':', which the sync never writes, so it is not a synced skill`,
    );

    // … and a plain scan does not.
    const plain = createSkillRegistry({ roots: [{ path: root, source: 'project' }] });
    expect(plain.list().map((skill) => skill.name).sort()).toEqual(['a:b', 'alpha']);
  });

  it('skips an entry whose plugin is disabled', () => {
    const root = tempDir();
    const owned = path.join(root, 'owned');
    writeFile(path.join(owned, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo' }));
    writeFile(
      path.join(owned, 'SKILL.md'),
      '---\nname: owned\ndescription: Owned by a plugin.\n---\n\nBody.\n',
    );
    writeSkill(root, 'alpha');

    // The plugin that owns the entry is disabled: the entry is skipped.
    const disabled = createSkillRegistry({
      roots: [{ path: root, source: 'project' }],
      disabledPlugins: ['demo'],
    });
    expect(disabled.list().map((skill) => skill.name)).toEqual(['alpha']);
    const refusal = disabled.refusals().find((entry) => entry.name === 'owned');
    expect(refusal?.reason).toContain("the plugin that owns it, 'demo', is disabled");

    // Another plugin is disabled: the entry is offered.
    const other = createSkillRegistry({
      roots: [{ path: root, source: 'project' }],
      disabledPlugins: ['another'],
    });
    expect(other.list().map((skill) => skill.name).sort()).toEqual(['alpha', 'owned']);
  });

  it('skips a SKILL.md that is not a regular file', () => {
    const root = tempDir();
    // The definition file is a directory, not a file.
    mkdirSync(path.join(root, 'alpha', 'SKILL.md'), { recursive: true });
    writeSkill(root, 'beta');

    const registry = createSkillRegistry({ roots: [{ path: root, source: 'project' }] });

    expect(registry.list().map((skill) => skill.name)).toEqual(['beta']);
    const refusal = registry.refusals().find((entry) => entry.name === 'alpha');
    expect(refusal?.level).toBe('warn');
    expect(refusal?.reason).toContain(
      `[skills] skipping ${path.join(root, 'alpha', 'SKILL.md')}: not a regular file`,
    );
  });

  it('skips a skill whose own name is reserved', () => {
    const root = tempDir();
    // The folder is named after the reserved name …
    writeSkill(root, 'anthropic-skills');
    // … and so is this one's frontmatter.
    writeFile(
      path.join(root, 'beta', 'SKILL.md'),
      '---\nname: anthropic-skills\ndescription: Reserved.\n---\n\nBody.\n',
    );
    writeSkill(root, 'alpha');

    const registry = createSkillRegistry({ roots: [{ path: root, source: 'project' }] });

    expect(registry.list().map((skill) => skill.name)).toEqual(['alpha']);
    const refusal = registry.refusals().find((entry) => entry.name === 'anthropic-skills');
    expect(refusal?.level).toBe('warn');
    expect(refusal?.reason).toContain(
      'that name uses "anthropic-skills", a name reserved for the skills synced from your claude.ai account',
    );
    expect(RESERVED_SKILL_NAMES).toEqual(['anthropic-skills']);
    expect(isReservedSkillName('anthropic-skills')).toBe(true);
    expect(isReservedSkillName('anthropic-skills:inner')).toBe(true);
    expect(isReservedSkillName('alpha')).toBe(false);
  });

  it('loads a skill whose frontmatter does not parse, ignoring the frontmatter', () => {
    const root = tempDir();
    writeFile(
      path.join(root, 'broken', 'SKILL.md'),
      '---\ndescription A skill.\n---\n\nThe body.\n',
    );

    const registry = createSkillRegistry({ roots: [{ path: root, source: 'project' }] });
    const skill = registry.resolve('broken');

    // A frontmatter that does not parse is **not** a skip: the skill still
    // loads, without its frontmatter.
    expect(skill).toBeDefined();
    expect(skill?.description).toBeUndefined();
    const refusal = registry.refusals().find((entry) => entry.path.endsWith('SKILL.md'));
    expect(refusal?.level).toBe('error');
    expect(refusal?.reason).toContain('failed to parse and was ignored');
  });

  it('reports a skills directory it cannot read, and scans the other roots', () => {
    const unreadable = tempDir();
    const readable = skillsRoot(['alpha']);
    chmodSync(unreadable, 0o000);

    try {
      const registry = createSkillRegistry({
        roots: [
          { path: unreadable, source: 'project' },
          { path: readable, source: 'project' },
        ],
      });

      // The directory that cannot be read yields nothing, and the scan goes on.
      expect(registry.list().map((skill) => skill.name)).toEqual(['alpha']);
      const refusal = registry.refusals().find((entry) => entry.path === unreadable);
      expect(refusal?.level).toBe('error');
      expect(refusal?.reason).toContain(`Failed to read skills directory ${unreadable}`);
    } finally {
      chmodSync(unreadable, 0o700);
    }
  });

  it('keeps the standalone skills and the plugin skills apart, and merges the standalone first', () => {
    const root = skillsRoot(['alpha']);

    const registry = createSkillRegistry({
      roots: [{ path: root, source: 'project' }],
      contributions: [
        {
          name: 'beta',
          source: 'plugin',
          path: '/plugins/demo/skills/beta/SKILL.md',
          provider: 'demo',
        },
      ],
    });

    // The two lists stay apart …
    expect(registry.roots().map((entry) => entry.path)).toEqual([root]);
    expect(registry.contributions().map((entry) => entry.name)).toEqual(['beta']);
    // … and the standalone skills come **first** in the merge.
    expect(registry.list().map((skill) => skill.name)).toEqual(['alpha', 'beta']);
  });

  it('caches the scan, and re-reads it after a reload', () => {
    const root = skillsRoot(['alpha']);
    const registry = createSkillRegistry({ roots: [{ path: root, source: 'project' }] });

    expect(registry.list().map((skill) => skill.name)).toEqual(['alpha']);

    writeSkill(root, 'beta');
    // The catalogue is cached, as the target's is.
    expect(registry.list().map((skill) => skill.name)).toEqual(['alpha']);

    registry.reload();
    expect(registry.list().map((skill) => skill.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('re-reads the skills across a restart', () => {
    const root = skillsRoot(['alpha']);
    const first = createSkillRegistry({ roots: [{ path: root, source: 'project' }] });
    expect(first.list()).toHaveLength(1);

    writeSkill(root, 'beta');

    // A new process: a new registry, with a cold cache.
    const second = createSkillRegistry({ roots: [{ path: root, source: 'project' }] });
    expect(second.list().map((skill) => skill.name).sort()).toEqual(['alpha', 'beta']);
  });
});

// ---------------------------------------------------------------------------
// Skills: the override resolution
// ---------------------------------------------------------------------------

describe('the skill override resolution', () => {
  it('has exactly four override modes', () => {
    expect([...SKILL_OVERRIDE_MODES].sort()).toEqual([
      'name-only',
      'off',
      'on',
      'user-invocable-only',
    ]);
  });

  it('reports a local override of a synced skill with own: false and preserves the sync source', () => {
    const synced = tempDir();
    const local = tempDir();
    writeSkill(synced, 'shared-skill');
    writeSkill(local, 'shared-skill');

    const roots: SkillRoot[] = [
      { path: local, source: 'local' },
      { path: synced, source: 'user', synced: true },
    ];

    const registry = createSkillRegistry({ roots });
    const skill = registry.resolve('shared-skill');

    expect(skill?.own).toBe(false);
    expect(skill?.source).toBe('user');
  });

  it('reports a skill that only the sync owns with own: false', () => {
    const synced = tempDir();
    writeSkill(synced, 'synced-only');

    const registry = createSkillRegistry({
      roots: [{ path: synced, source: 'user', synced: true }],
    });

    expect(registry.resolve('synced-only')?.own).toBe(false);
  });

  it('reports a skill the user owns with own: true', () => {
    const cwd = tempDir();
    const configDir = tempDir();
    writeSkill(path.join(cwd, '.claude', 'skills'), 'project-skill');

    const registry = createSkillRegistry({ cwd, configDir });
    expect(registry.resolve('project-skill')?.own).toBe(true);
  });

  it('resolves the override in the order: merged settings, session, policy, flag', () => {
    const tiers = tierMap({
      projectSettings: { skillOverrides: { alpha: 'name-only' } },
      userSettings: { skillOverrides: { alpha: 'off' } },
      policySettings: { skillOverrides: { alpha: 'on', beta: 'user-invocable-only', gamma: 'on' } },
      flagSettings: { skillOverrides: { alpha: 'off', beta: 'off', gamma: 'off' } },
    });
    const session = createSkillSessionStore({
      skillOverrides: { alpha: 'off', beta: 'off' },
    });

    // The merged settings win over the session and over the policy tier.
    expect(resolveSkillOverrideMode('alpha', { tiers, session })).toBe('name-only');
    // The session wins over the policy tier.
    expect(resolveSkillOverrideMode('beta', { tiers, session })).toBe('off');
    // The policy tier wins over the flag tier.
    expect(resolveSkillOverrideMode('gamma', { tiers, session })).toBe('on');
  });

  it('resolves the merged settings through MERGED_KEY_ORDER', () => {
    const tiers = tierMap({
      localSettings: { skillOverrides: { alpha: 'on' } },
      projectSettings: { skillOverrides: { alpha: 'name-only' } },
      userSettings: { skillOverrides: { alpha: 'off' } },
    });

    // Local beats project beats user, so the merged settings say `on`.
    expect(resolveSkillOverrideMode('alpha', { tiers })).toBe('on');
  });

  it('yields no override for a skill nobody defines', () => {
    const tiers = tierMap({ userSettings: { skillOverrides: { alpha: 'off' } } });
    expect(resolveSkillOverrideMode('beta', { tiers })).toBeUndefined();
  });

  it('yields no override when there is no source at all', () => {
    expect(resolveSkillOverrideMode('alpha', {})).toBeUndefined();
  });

  it('refuses "__proto__" as a skill name', () => {
    const tiers = tierMap({
      userSettings: { skillOverrides: { alpha: 'off' } },
    });
    const session = createSkillSessionStore({
      skillOverrides: { alpha: 'off' } as Record<string, SkillOverrideMode>,
    });

    expect(resolveSkillOverrideMode('__proto__', { tiers, session })).toBeUndefined();
    expect(() =>
      session.setOverride('__proto__', 'off'),
    ).toThrow(SkillOverrideError);
  });

  it('carries the resolved mode on the skill the registry reports', () => {
    const cwd = tempDir();
    const configDir = tempDir();
    writeSkill(path.join(cwd, '.claude', 'skills'), 'project-skill');

    const registry = createSkillRegistry({
      cwd,
      configDir,
      tiers: tierMap({ userSettings: { skillOverrides: { 'project-skill': 'off' } } }),
    });

    expect(registry.resolve('project-skill')?.mode).toBe('off');
  });

  it('defaults a skill with no override to the "on" mode', () => {
    const cwd = tempDir();
    const configDir = tempDir();
    writeSkill(path.join(cwd, '.claude', 'skills'), 'project-skill');

    const registry = createSkillRegistry({ cwd, configDir });
    expect(registry.resolve('project-skill')?.mode).toBe('on');
  });

  it('merges the skillOverrides block per leaf, so a user tier survives a local tier', () => {
    const tiers = tierMap({
      localSettings: { skillOverrides: { alpha: 'off' } },
      userSettings: { skillOverrides: { beta: 'name-only' } },
    });

    // The audit's "the first source that defines a key wins" is a **per-key**
    // order, so the local block would replace the user block whole. This implementation
    // merges per leaf (CC-003's model), so `beta` survives.
    expect(resolveSkillOverrideMode('alpha', { tiers })).toBe('off');
    expect(resolveSkillOverrideMode('beta', { tiers })).toBe('name-only');
  });

  it('keeps the session store shape: read, brought and skillOverrides', () => {
    const session = createSkillSessionStore();
    expect(session.read).toBe(false);
    expect(session.brought.size).toBe(0);
    expect(session.skillOverrides).toEqual({});

    session.markRead();
    session.bring('alpha');
    session.setOverride('alpha', 'name-only');

    expect(session.read).toBe(true);
    expect(session.brought.has('alpha')).toBe(true);
    expect(session.skillOverrides['alpha']).toBe('name-only');
  });

  it('applies the skills a session may use, and drops the disabled ones', () => {
    const cwd = tempDir();
    const configDir = tempDir();
    writeSkill(path.join(cwd, '.claude', 'skills'), 'enabled-skill');
    writeSkill(path.join(cwd, '.claude', 'skills'), 'disabled-skill');
    writeSkill(path.join(cwd, '.claude', 'skills'), 'named-skill');
    writeSkill(path.join(cwd, '.claude', 'skills'), 'user-skill');

    const registry = createSkillRegistry({
      cwd,
      configDir,
      tiers: tierMap({
        userSettings: {
          skillOverrides: {
            'disabled-skill': 'off',
            'named-skill': 'name-only',
            'user-skill': 'user-invocable-only',
          },
        },
      }),
    });

    const applied = registry.apply();
    const byName = new Map(applied.map((skill) => [skill.name, skill]));

    expect(byName.has('disabled-skill')).toBe(false);
    expect(byName.get('enabled-skill')).toMatchObject({
      invocable: true,
      autoInvocable: true,
    });
    expect(byName.get('named-skill')).toMatchObject({
      invocable: false,
      autoInvocable: false,
    });
    expect(byName.get('user-skill')).toMatchObject({
      invocable: true,
      autoInvocable: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Skills: the frontmatter rule
// ---------------------------------------------------------------------------

describe('the skill frontmatter rule', () => {
  it('throws the target\'s exact message when a frontmatter field is not text', () => {
    expect(() => assertSkillFrontmatter({ source: 42 })).toThrow(
      '$.skill.prompt: called with a frontmatter that source is no text',
    );
    expect(() => assertSkillFrontmatter({ pluginName: {} })).toThrow(
      '$.skill.prompt: called with a frontmatter that pluginName is no text',
    );
    expect(() => assertSkillFrontmatter({ path: 1 })).toThrow(
      '$.skill.prompt: called with a frontmatter that path is no text',
    );
    expect(() => assertSkillFrontmatter({ frontmatterProblem: false })).toThrow(
      '$.skill.prompt: called with a frontmatter that frontmatterProblem is no text',
    );
  });

  it('throws when the frontmatter is itself a plain string', () => {
    expect(() => assertSkillFrontmatter('description: a skill')).toThrow(
      '$.skill.prompt: called with a frontmatter that is no text',
    );
  });

  it('checks the fields in the target\'s order', () => {
    expect(() => assertSkillFrontmatter({ source: 1, path: 2 })).toThrow(
      /source is no text/,
    );
  });

  it('accepts a frontmatter whose fields are all text', () => {
    expect(() =>
      assertSkillFrontmatter({
        source: 'plugin',
        pluginName: 'demo',
        path: '/tmp/SKILL.md',
        frontmatterProblem: 'the description is not text',
      }),
    ).not.toThrow();
  });

  it('treats a present-but-undefined frontmatter field as absent', () => {
    // The audit's literal reading — "the first of … whose value is not a
    // string" — would throw for an `undefined` value. This implementation skips it.
    expect(() => assertSkillFrontmatter({ source: undefined })).not.toThrow();
  });

  it('parses the frontmatter with key normalization and reports the problem', () => {
    const parsed = parseFrontmatter(
      '---\nDescription: A skill.\nArgument Hint: <x>\n---\n\nThe body.\n',
    );

    expect(parsed.frontmatter['description']).toBe('A skill.');
    expect(parsed.frontmatter['argument-hint']).toBe('<x>');
    expect(parsed.body.trim()).toBe('The body.');
    expect(parsed.problem).toBeUndefined();
  });

  it('reports a malformed frontmatter rather than dropping it', () => {
    const parsed = parseFrontmatter('---\ndescription A skill.\n---\n\nBody.\n');
    expect(parsed.problem).toBeDefined();
  });

  it('reports a frontmatter with no text description', () => {
    const parsed = parseFrontmatter('---\nname: a-skill\n---\n\nBody.\n');
    expect(skillFrontmatterProblem(parsed.frontmatter)).toBe('the description is not text');
  });

  it('reports a description that is not text', () => {
    const parsed = parseFrontmatter('---\ndescription: 42\n---\n\nBody.\n');
    expect(skillFrontmatterProblem(parsed.frontmatter)).toBe('the description is not text');
  });
});

// ---------------------------------------------------------------------------
// The extension-point registry
// ---------------------------------------------------------------------------

describe('the extension-point registry', () => {
  it('exposes the target\'s fixed set of extension points', () => {
    expect([...EXTENSION_POINTS]).toEqual([
      'tool.call',
      'tool.check',
      'tool.describe',
      'command.run',
      'command.describe',
      'config.set',
      'config.describe',
      'telemetry.log',
      'telemetry.mark',
      'prompt.submit',
      'prompt.fill',
      'prompt.edit',
      'prompt.change',
      'prompt.autocomplete',
      'prompt.suggest',
      'prompt.section',
      'prompt.context',
      'prompt.attachment',
      'prompt.mention',
      'prompt.compose',
      'agent.offer',
      'agent.spawn',
      'skill.prompt',
      'attribution.text',
      'session.start',
      'session.receive',
      'session.append',
      'session.send',
      'session.compact',
      'session.attach',
      'session.detach',
      'session.measure',
      'session.end',
      'turn.start',
      'turn.step',
      'turn.complete',
      'ui.scroll',
      'ui.focus',
    ]);
  });

  it('gives tool.call a generated tool_use_id when the caller supplied none', async () => {
    const registry = createExtensionPointRegistry();
    let seen: Record<string, unknown> = {};
    registry.register('tool.call', (payload) => {
      seen = payload;
      return 'ok';
    });

    await registry.invoke('tool.call', { tool: 'Bash' });

    expect(typeof seen['tool_use_id']).toBe('string');
    expect(seen['tool_use_id']).toMatch(/^toolu_[0-9a-f]{32}$/);
  });

  it('keeps a caller-supplied tool_use_id', async () => {
    const registry = createExtensionPointRegistry();
    let seen: Record<string, unknown> = {};
    registry.register('tool.call', (payload) => {
      seen = payload;
      return 'ok';
    });

    await registry.invoke('tool.call', { tool: 'Bash', tool_use_id: 'toolu_abc' });

    expect(seen['tool_use_id']).toBe('toolu_abc');
  });

  it('defaults telemetry.log to the anthropic destination', async () => {
    const registry = createExtensionPointRegistry();
    let seen: Record<string, unknown> = {};
    registry.register('telemetry.log', (payload) => {
      seen = payload;
      return 'ok';
    });

    await registry.invoke('telemetry.log', { event: 'x' });

    expect(seen['destination']).toBe('anthropic');
  });

  it('keeps the collector destination when the caller asked for it', async () => {
    const registry = createExtensionPointRegistry();
    let seen: Record<string, unknown> = {};
    registry.register('telemetry.log', (payload) => {
      seen = payload;
      return 'ok';
    });

    await registry.invoke('telemetry.log', { event: 'x', destination: 'collector' });

    expect(seen['destination']).toBe('collector');
  });

  it('normalizes any other telemetry destination to anthropic', async () => {
    const registry = createExtensionPointRegistry();
    let seen: Record<string, unknown> = {};
    registry.register('telemetry.log', (payload) => {
      seen = payload;
      return 'ok';
    });

    await registry.invoke('telemetry.log', { event: 'x', destination: 'somewhere-else' });

    expect(seen['destination']).toBe('anthropic');
  });

  it('validates the frontmatter at the skill.prompt extension point', async () => {
    const registry = createExtensionPointRegistry();
    registry.register('skill.prompt', () => 'prompt');

    await expect(
      registry.invoke('skill.prompt', { frontmatter: { source: 7 } }),
    ).rejects.toThrow('$.skill.prompt: called with a frontmatter that source is no text');
  });

  it('resolves a skill through skill.prompt with a source defaulting to built-in', async () => {
    const registry = createExtensionPointRegistry();
    registry.register('skill.prompt', (payload) => ({
      name: payload['name'],
      body: 'Body.',
    }));

    const resolved = await registry.invoke('skill.prompt', {
      name: 'a-skill',
      frontmatter: { description: 'A skill.' },
    });

    expect(resolved).toMatchObject({ name: 'a-skill', source: 'built-in' });
  });

  it('keeps the source the skill.prompt frontmatter carries', async () => {
    const registry = createExtensionPointRegistry();
    registry.register('skill.prompt', (payload) => ({
      name: payload['name'],
      body: 'Body.',
    }));

    const resolved = await registry.invoke('skill.prompt', {
      name: 'a-skill',
      frontmatter: { description: 'A skill.', source: 'plugin' },
    });

    expect(resolved).toMatchObject({ name: 'a-skill', source: 'plugin' });
  });
});

// ---------------------------------------------------------------------------
// The skill-save protocol
// ---------------------------------------------------------------------------

describe('the skill-save protocol', () => {
  const cloudTool = { name: 'SaveSkill', capabilities: ['cloud'] as const };
  const cardTool = { name: 'ProposeSkill', capabilities: ['card'] as const };
  const linkTool = { name: 'SendFile', capabilities: ['linked'] as const };

  it('has exactly the five guidance modes and the five capabilities', () => {
    expect([...SKILL_SAVE_MODES].sort()).toEqual([
      'no_save_tool',
      'propose_tool',
      'report_unsaved',
      'save_tool',
      'send_file',
    ]);
    expect([...SKILL_SAVE_CAPABILITIES].sort()).toEqual([
      'card',
      'cloud',
      'linked',
      'policy',
      'review',
    ]);
  });

  it('reports unsaved for a remote call', () => {
    const mode = selectSkillSaveMode({
      files: ['/tmp/skill/SKILL.md'],
      remote: true,
      tools: [cloudTool],
    });
    expect(mode).toBe('report_unsaved');
  });

  it('reports unsaved for a call with an agent id', () => {
    const mode = selectSkillSaveMode({
      files: ['/tmp/skill/SKILL.md'],
      agentId: 'agent-1',
      tools: [cloudTool],
    });
    expect(mode).toBe('report_unsaved');
  });

  it('reports unsaved when the file list holds no skill.md', () => {
    const mode = selectSkillSaveMode({
      files: ['/tmp/skill/README.md'],
      tools: [cloudTool],
    });
    expect(mode).toBe('report_unsaved');
  });

  it('matches skill.md case-insensitively by basename', () => {
    const mode = selectSkillSaveMode({
      files: ['/tmp/skill/Skill.MD'],
      tools: [cloudTool],
    });
    expect(mode).toBe('save_tool');
  });

  it('uses the save_tool wording when the session can save to the account', () => {
    const guidance = skillSaveGuidance({
      files: ['/tmp/skill/SKILL.md'],
      tools: [cloudTool],
    });

    expect(guidance.mode).toBe('save_tool');
    expect(guidance.guidance).toBe(
      'To save a skill change for the user, use the `SaveSkill` tool.',
    );
  });

  it('uses the propose_tool wording when the session can only propose', () => {
    const guidance = skillSaveGuidance({
      files: ['/tmp/skill/SKILL.md'],
      tools: [cardTool],
    });

    expect(guidance.mode).toBe('propose_tool');
    expect(guidance.guidance).toBe(
      'To let the user save this change, call `ProposeSkill` with the complete SKILL.md.',
    );
  });

  it('uses the send_file wording when the session can only send the file', () => {
    const guidance = skillSaveGuidance({
      files: ['/tmp/skill/SKILL.md'],
      tools: [linkTool],
    });

    expect(guidance.mode).toBe('send_file');
    expect(guidance.guidance).toBe(
      'To pass this change to the user, send them the complete SKILL.md with the `SendFile` tool.',
    );
  });

  it('falls back to no_save_tool when there is no send-capable tool', () => {
    const guidance = skillSaveGuidance({
      files: ['/tmp/skill/SKILL.md'],
      tools: [],
    });

    expect(guidance.mode).toBe('no_save_tool');
    expect(guidance.guidance).toBe(
      'This session has no tool that saves a skill to the user\'s account: tell the user that this change is not saved, and point them to their claude.ai settings, where skills are managed.',
    );
  });

  it('uses the report_unsaved wording', () => {
    const guidance = skillSaveGuidance({
      files: ['/tmp/skill/SKILL.md'],
      remote: true,
      tools: [cloudTool],
    });

    expect(guidance.mode).toBe('report_unsaved');
    expect(guidance.guidance).toBe(
      'Say in your reply that this change is not saved to the user\'s account.',
    );
  });

  it('appends the synced-folder note only inside the synced folder', () => {
    const inside = skillSaveGuidance({
      files: ['/tmp/skill/SKILL.md'],
      tools: [cloudTool],
      inSyncedFolder: true,
    });
    const outside = skillSaveGuidance({
      files: ['/tmp/skill/SKILL.md'],
      tools: [cloudTool],
      inSyncedFolder: false,
    });

    expect(inside.note).toBe(SKILL_SYNCED_FOLDER_NOTE);
    expect(inside.guidance.endsWith(SKILL_SYNCED_FOLDER_NOTE)).toBe(true);
    expect(outside.note).toBeUndefined();
  });

  it('always selects a known guidance mode, so the note\'s "known mode" rule holds', () => {
    const requests = [
      { files: ['/tmp/skill/SKILL.md'], tools: [cloudTool] },
      { files: ['/tmp/skill/SKILL.md'], tools: [cardTool] },
      { files: ['/tmp/skill/SKILL.md'], tools: [linkTool] },
      { files: ['/tmp/skill/SKILL.md'], tools: [] },
      { files: ['/tmp/skill/SKILL.md'], tools: [cloudTool], remote: true },
      { files: ['/tmp/skill/SKILL.md'], tools: [cloudTool], agentId: 'agent-1' },
      { files: ['/tmp/other.md'], tools: [cloudTool] },
    ];

    for (const request of requests) {
      const mode = selectSkillSaveMode(request);
      expect(isSkillSaveMode(mode)).toBe(true);
      expect(skillSaveGuidance(request).mode).toBe(mode);
    }
  });

  it('states the note the target appends', () => {
    expect(SKILL_SYNCED_FOLDER_NOTE).toBe(
      'Note: this file is inside the folder that holds synced copies of the user\'s account skills. A change or new file here is not saved to their account, so do not report it as saved, and the next sync from their account can overwrite or remove it.',
    );
  });

  it('names the skill telemetry events the target emits', () => {
    expect([...SKILL_TELEMETRY_EVENTS]).toEqual([
      'tengu_propose_skills',
      'tengu_propose_skills_read_check',
      'tengu_propose_skills_kept_lines',
      'skills_load_ms',
    ]);
  });

  it('refuses a proposal whose file it cannot stat or read', () => {
    const missing = path.join(tempDir(), 'missing.md');
    expect(proposeSkillReadCheck(missing).ok).toBe(false);

    const readable = path.join(tempDir(), 'SKILL.md');
    writeFile(readable, '---\ndescription: A.\n---\n\nBody.\n');
    expect(proposeSkillReadCheck(readable).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Plugins: the manifest schema
// ---------------------------------------------------------------------------

describe('the plugin manifest schema', () => {
  it('splits the manifest keys into directory keys and file keys', () => {
    expect([...PLUGIN_DIRECTORY_KEYS].sort()).toEqual([
      'agents',
      'commands',
      'monitors',
      'outputStyles',
      'skills',
      'themes',
      'workflows',
    ]);
    expect([...PLUGIN_FILE_KEYS].sort()).toEqual(['hooks', 'lspServers', 'mcpServers']);
  });

  it('accepts a single path string and an array of path strings', () => {
    const parsed = parsePluginManifest(
      { name: 'demo', commands: 'commands', agents: ['agents/a', 'agents/b'] },
      '/plugins/demo/.claude-plugin/plugin.json',
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.manifest?.directories['commands']).toEqual(['commands']);
    expect(parsed.manifest?.directories['agents']).toEqual(['agents/a', 'agents/b']);
  });

  it('reads the experimental section as well as the top level', () => {
    const parsed = parsePluginManifest(
      {
        name: 'demo',
        commands: 'commands',
        experimental: { themes: 'themes', hooks: 'hooks/hooks.json' },
      },
      '/plugins/demo/.claude-plugin/plugin.json',
    );

    expect(parsed.manifest?.directories['themes']).toEqual(['themes']);
    expect(parsed.manifest?.files['hooks']).toEqual(['hooks/hooks.json']);
    expect(parsed.manifest?.directories['commands']).toEqual(['commands']);
  });

  it('marks a manifest that is not a JSON object broken with the target\'s reason', () => {
    for (const raw of ['[]', '"a string"', '42', 'null']) {
      const parsed = parsePluginManifest(raw, '/plugins/demo/.claude-plugin/plugin.json');
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toBe('it is not a JSON object');
    }
  });

  it('reads the commands object form as command metadata', () => {
    const parsed = parsePluginManifest(
      {
        name: 'demo',
        commands: {
          greeting: { source: 'commands/hello.md' },
          inline: { content: 'Say hi.' },
        },
      },
      '/plugins/demo/.claude-plugin/plugin.json',
    );

    expect(parsed.manifest?.commands).toEqual([
      { key: 'greeting', source: 'commands/hello.md' },
      { key: 'inline', content: 'Say hi.' },
    ]);
  });

  it('never resolves a manifest key to an inherited member of Object.prototype', () => {
    const parsed = parsePluginManifest(
      { name: 'demo', commands: 'commands' },
      '/plugins/demo/.claude-plugin/plugin.json',
    );

    const directories = parsed.manifest?.directories as
      | Record<string, string[] | undefined>
      | undefined;
    const files = parsed.manifest?.files as Record<string, string[] | undefined> | undefined;

    expect(directories?.['constructor']).toBeUndefined();
    expect(directories?.['__proto__']).toBeUndefined();
    expect(files?.['toString']).toBeUndefined();
    expect(Object.hasOwn(directories ?? {}, 'commands')).toBe(true);
  });

  it('marks a plugin ok when a SKILL.md exists at its root', () => {
    const root = tempDir();
    writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', commands: 'commands' }),
    );
    writeFile(path.join(root, 'SKILL.md'), '---\ndescription: Demo.\n---\n\nBody.\n');

    const manager = createPluginManager();
    const plugin = manager.load(root);

    expect(plugin.status).toBe('ok');
    expect(plugin.name).toBe('demo');
    expect(plugin.source).toBe('plugin');
  });

  it('marks a plugin broken when its manifest is not a JSON object', () => {
    const root = tempDir();
    writeFile(path.join(root, '.claude-plugin', 'plugin.json'), '[]');
    writeFile(path.join(root, 'SKILL.md'), '---\ndescription: Demo.\n---\n\nBody.\n');

    const manager = createPluginManager();
    const plugin = manager.load(root);

    expect(plugin.status).toBe('broken');
    expect(plugin.reason).toBe('it is not a JSON object');
  });

  it('accepts either of the manifest candidates', () => {
    const manager = createPluginManager();

    const withDotDirectory = tempDir();
    writeFile(
      path.join(withDotDirectory, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'first' }),
    );
    writeFile(path.join(withDotDirectory, 'SKILL.md'), '---\ndescription: A.\n---\n\nBody.\n');

    const atTheRoot = tempDir();
    writeFile(path.join(atTheRoot, 'plugin.json'), JSON.stringify({ name: 'second' }));
    writeFile(path.join(atTheRoot, 'SKILL.md'), '---\ndescription: B.\n---\n\nBody.\n');

    expect(manager.load(withDotDirectory).name).toBe('first');
    expect(manager.load(atTheRoot).name).toBe('second');
  });

  it('prefers the .claude-plugin/plugin.json candidate over plugin.json', () => {
    const root = tempDir();
    writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'first' }),
    );
    writeFile(path.join(root, 'plugin.json'), JSON.stringify({ name: 'second' }));
    writeFile(path.join(root, 'SKILL.md'), '---\ndescription: A.\n---\n\nBody.\n');

    const manager = createPluginManager();
    const plugin = manager.load(root);

    expect(plugin.name).toBe('first');
  });

  it('applies what a plugin contributes', () => {
    const root = tempDir();
    writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', commands: 'commands', skills: 'skills' }),
    );
    writeFile(path.join(root, 'SKILL.md'), '---\ndescription: Demo.\n---\n\nBody.\n');
    writeFile(path.join(root, 'commands', 'hello.md'), '---\ndescription: Hi.\n---\n\nHello.\n');
    writeSkill(path.join(root, 'skills'), 'plugin-skill');

    const manager = createPluginManager();
    manager.load(root);

    const applied = manager.apply('demo');
    expect(applied.plugin).toBe('demo');
    expect(applied.commands.map((command) => command.name)).toEqual(['demo:hello']);
    expect(applied.skills.map((skill) => skill.name)).toEqual(['plugin-skill']);
  });

  it('resolves a plugin by name and refuses an inherited member', () => {
    const root = tempDir();
    writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo' }),
    );
    writeFile(path.join(root, 'SKILL.md'), '---\ndescription: Demo.\n---\n\nBody.\n');

    const manager = createPluginManager();
    manager.load(root);

    expect(manager.resolve('demo')?.name).toBe('demo');
    expect(manager.resolve('__proto__')).toBeUndefined();
    expect(manager.resolve('constructor')).toBeUndefined();
  });

  it('discovers the plugins under the plugins root', () => {
    const pluginsRoot = tempDir();
    writeFile(
      path.join(pluginsRoot, 'demo', '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo' }),
    );
    writeFile(
      path.join(pluginsRoot, 'demo', 'SKILL.md'),
      '---\ndescription: A.\n---\n\nBody.\n',
    );
    writeFile(path.join(pluginsRoot, 'notes.txt'), 'not a plugin');

    const manager = createPluginManager({ pluginsRoot });
    const discovered = manager.discover();

    expect(discovered.map((entry) => entry.name)).toEqual(['demo']);
    expect(discovered[0]?.source).toBe('plugin');
    expect(discovered[0]?.path).toBe(path.join(pluginsRoot, 'demo'));
  });

  it('discovers nothing when there is no plugins root', () => {
    expect(createPluginManager().discover()).toEqual([]);
  });

  it('contributes both values when a key is declared at the top level and under experimental', () => {
    const parsed = parsePluginManifest(
      {
        name: 'demo',
        commands: 'commands',
        experimental: { commands: 'more-commands' },
      },
      '/plugins/demo/.claude-plugin/plugin.json',
    );

    expect(parsed.manifest?.directories['commands']).toEqual([
      'commands',
      'more-commands',
    ]);
  });

  it('reports a skill name two plugins provide, instead of dropping one silently', () => {
    const first = tempDir();
    const second = tempDir();

    writeFile(
      path.join(first, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'first', skills: 'skills' }),
    );
    writeFile(path.join(first, 'SKILL.md'), '---\ndescription: A.\n---\n\nBody.\n');
    writeSkill(path.join(first, 'skills'), 'shared');

    writeFile(
      path.join(second, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'second', skills: 'skills' }),
    );
    writeFile(path.join(second, 'SKILL.md'), '---\ndescription: B.\n---\n\nBody.\n');
    writeSkill(path.join(second, 'skills'), 'shared');

    const manager = createPluginManager();
    manager.load(first);
    manager.load(second);

    // The manager contributes both — the collision is reported, not dropped.
    const skills = manager.skills();
    expect(skills.map((skill) => skill.provider)).toEqual(['first', 'second']);

    const warning = manager.logs().find((log) => log.level === 'warn');
    expect(warning?.message).toContain('shared');
    expect(warning?.message).toContain('first');
    expect(warning?.message).toContain('second');

    // The registry resolves the collision and names the other provider.
    const registry = createSkillRegistry({ contributions: skills });
    expect(registry.resolve('shared')?.collidesWith).toEqual(['second']);
  });

  it('reports a subagent name two plugins provide, instead of dropping one silently', () => {
    const first = tempDir();
    const second = tempDir();

    writeFile(
      path.join(first, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'first', agents: 'agents' }),
    );
    writeFile(path.join(first, 'SKILL.md'), '---\ndescription: A.\n---\n\nBody.\n');
    writeFile(
      path.join(first, 'agents', 'planner.md'),
      '---\ndescription: P.\n---\n\nBody.\n',
    );

    writeFile(
      path.join(second, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'second', agents: 'agents' }),
    );
    writeFile(path.join(second, 'SKILL.md'), '---\ndescription: B.\n---\n\nBody.\n');
    writeFile(
      path.join(second, 'agents', 'planner.md'),
      '---\ndescription: P.\n---\n\nBody.\n',
    );

    const manager = createPluginManager();
    manager.load(first);
    manager.load(second);

    // The manager contributes both — the collision is reported, not dropped.
    const agents = manager.agents();
    expect(agents.map((agent) => agent.provider)).toEqual(['first', 'second']);

    const warning = manager.logs().find((log) => log.level === 'warn');
    expect(warning?.message).toContain('planner');
    expect(warning?.message).toContain('first');
    expect(warning?.message).toContain('second');

    // The registry resolves the collision and names the other provider.
    const registry = createSubagentRegistry({ contributions: agents });
    expect(registry.resolve('planner')?.collidesWith).toEqual(['second']);
  });
});

// ---------------------------------------------------------------------------
// Plugins: the collision report
// ---------------------------------------------------------------------------

describe('the plugin collision report', () => {
  it('names the one plugin that provides a skill name twice', () => {
    const root = tempDir();
    writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', skills: ['skills', 'more-skills'] }),
    );
    writeFile(path.join(root, 'SKILL.md'), '---\ndescription: A.\n---\n\nBody.\n');
    writeSkill(path.join(root, 'skills'), 'shared');
    writeSkill(path.join(root, 'more-skills'), 'shared');

    const manager = createPluginManager();
    manager.load(root);

    // Both are contributed — the collision is reported, not dropped.
    const skills = manager.skills();
    expect(skills.map((skill) => skill.provider)).toEqual(['demo', 'demo']);

    const warning = manager.logs().find((log) => log.level === 'warn');
    expect(warning?.message).toContain('demo');
    expect(warning?.message).toContain('shared');
    // One plugin providing the name twice is **not** two plugins colliding.
    expect(warning?.message).not.toContain('Two plugins');
    expect(warning?.message).not.toContain('demo, demo');
  });

  it('names the one plugin that provides a subagent name twice', () => {
    const root = tempDir();
    writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', agents: ['agents', 'more-agents'] }),
    );
    writeFile(path.join(root, 'SKILL.md'), '---\ndescription: A.\n---\n\nBody.\n');
    writeFile(path.join(root, 'agents', 'planner.md'), '---\ndescription: P.\n---\n\nBody.\n');
    writeFile(path.join(root, 'more-agents', 'planner.md'), '---\ndescription: P.\n---\n\nBody.\n');

    const manager = createPluginManager();
    manager.load(root);

    const agents = manager.agents();
    expect(agents.map((agent) => agent.provider)).toEqual(['demo', 'demo']);

    const warning = manager.logs().find((log) => log.level === 'warn');
    expect(warning?.message).toContain('demo');
    expect(warning?.message).toContain('planner');
    expect(warning?.message).not.toContain('Two plugins');
    expect(warning?.message).not.toContain('demo, demo');
  });
});

// ---------------------------------------------------------------------------
// The collision semantics of a contributed name
// ---------------------------------------------------------------------------

describe('the collision semantics of a contributed name', () => {
  /** A plugin root that declares two skills directories. */
  function pluginWithTwoSkillDirectories(): string {
    const root = tempDir();
    writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', skills: ['skills', 'more-skills'] }),
    );
    writeFile(path.join(root, 'SKILL.md'), '---\ndescription: A.\n---\n\nBody.\n');
    writeSkill(path.join(root, 'skills'), 'shared');
    writeSkill(path.join(root, 'more-skills'), 'shared');
    return root;
  }

  /** A plugin root that declares two agents directories. */
  function pluginWithTwoAgentDirectories(): string {
    const root = tempDir();
    writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', agents: ['agents', 'more-agents'] }),
    );
    writeFile(path.join(root, 'SKILL.md'), '---\ndescription: A.\n---\n\nBody.\n');
    writeFile(path.join(root, 'agents', 'planner.md'), '---\ndescription: P.\n---\n\nBody.\n');
    writeFile(
      path.join(root, 'more-agents', 'planner.md'),
      '---\ndescription: P.\n---\n\nBody.\n',
    );
    return root;
  }

  it('reports a plugin that provides the same skill name twice, with both paths, and names no provider', () => {
    const root = pluginWithTwoSkillDirectories();

    const manager = createPluginManager();
    manager.load(root);

    const skills = manager.skills();
    expect(skills.map((skill) => skill.provider)).toEqual(['demo', 'demo']);

    // The report names the plugin and the **two paths** it shipped the name
    // under — the situation is a packaging bug, not a conflict.
    const warning = manager.logs().find((log) => log.level === 'warn');
    expect(warning?.message).toContain('demo');
    expect(warning?.message).toContain('shared');
    expect(warning?.message).toContain(path.join(root, 'skills', 'shared', 'SKILL.md'));
    expect(warning?.message).toContain(path.join(root, 'more-skills', 'shared', 'SKILL.md'));
    expect(warning?.message).not.toContain('Two plugins');

    // The resolved record names **no** provider: the winner's own provider is
    // never beside itself, so a conflict and a duplication are told apart.
    const registry = createSkillRegistry({ contributions: skills });
    const skill = registry.resolve('shared');
    expect(skill?.provider).toBe('demo');
    expect(skill?.collidesWith).toEqual([]);
  });

  it('reports a plugin that provides the same subagent name twice, with both paths, and names no provider', () => {
    const root = pluginWithTwoAgentDirectories();

    const manager = createPluginManager();
    manager.load(root);

    const agents = manager.agents();
    expect(agents.map((agent) => agent.provider)).toEqual(['demo', 'demo']);

    const warning = manager.logs().find((log) => log.level === 'warn');
    expect(warning?.message).toContain('demo');
    expect(warning?.message).toContain('planner');
    expect(warning?.message).toContain(path.join(root, 'agents', 'planner.md'));
    expect(warning?.message).toContain(path.join(root, 'more-agents', 'planner.md'));
    expect(warning?.message).not.toContain('Two plugins');

    const registry = createSubagentRegistry({ contributions: agents });
    const definition = registry.resolve('planner');
    expect(definition?.provider).toBe('demo');
    expect(definition?.collidesWith).toEqual([]);
  });

  it('reports a conflict between two plugins with both providers, and names the other one in the field', () => {
    const first = tempDir();
    const second = tempDir();

    writeFile(
      path.join(first, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'first', skills: 'skills' }),
    );
    writeFile(path.join(first, 'SKILL.md'), '---\ndescription: A.\n---\n\nBody.\n');
    writeSkill(path.join(first, 'skills'), 'shared');

    writeFile(
      path.join(second, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'second', skills: 'skills' }),
    );
    writeFile(path.join(second, 'SKILL.md'), '---\ndescription: B.\n---\n\nBody.\n');
    writeSkill(path.join(second, 'skills'), 'shared');

    const manager = createPluginManager();
    manager.load(first);
    manager.load(second);

    const skills = manager.skills();

    // The report names **both** providers: the two plugins disagree.
    const warning = manager.logs().find((log) => log.level === 'warn');
    expect(warning?.message).toContain('Two plugins');
    expect(warning?.message).toContain('first');
    expect(warning?.message).toContain('second');

    // The field names the **other** provider, and never the winner's own.
    const registry = createSkillRegistry({ contributions: skills });
    const skill = registry.resolve('shared');
    expect(skill?.provider).toBe('first');
    expect(skill?.collidesWith).toEqual(['second']);
    expect(skill?.collidesWith).not.toContain('first');
  });

  it('reports a duplication and a conflict separately, when one plugin duplicates a name another plugin ships', () => {
    const first = tempDir();
    const second = tempDir();

    // `first` ships the name twice …
    writeFile(
      path.join(first, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', skills: ['skills', 'more-skills'] }),
    );
    writeFile(path.join(first, 'SKILL.md'), '---\ndescription: A.\n---\n\nBody.\n');
    writeSkill(path.join(first, 'skills'), 'shared');
    writeSkill(path.join(first, 'more-skills'), 'shared');

    // … and `second` ships it once.
    writeFile(
      path.join(second, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'second', skills: 'skills' }),
    );
    writeFile(path.join(second, 'SKILL.md'), '---\ndescription: B.\n---\n\nBody.\n');
    writeSkill(path.join(second, 'skills'), 'shared');

    const manager = createPluginManager();
    manager.load(first);
    manager.load(second);

    const skills = manager.skills();
    expect(skills.map((skill) => skill.provider)).toEqual(['demo', 'demo', 'second']);

    const warnings = manager.logs().filter((log) => log.level === 'warn');

    // The duplication is reported with its two paths …
    const duplication = warnings.find((log) => log.message.includes('more than once'));
    expect(duplication?.message).toContain('demo');
    expect(duplication?.message).toContain(path.join(first, 'skills', 'shared', 'SKILL.md'));
    expect(duplication?.message).toContain(path.join(first, 'more-skills', 'shared', 'SKILL.md'));

    // … and the conflict names both providers, each of them once.
    const conflict = warnings.find((log) => log.message.includes('Two plugins'));
    expect(conflict?.message).toContain('demo');
    expect(conflict?.message).toContain('second');
    expect(conflict?.message).not.toContain('demo, demo');

    // The field names the **other** provider only.
    const registry = createSkillRegistry({ contributions: skills });
    const skill = registry.resolve('shared');
    expect(skill?.provider).toBe('demo');
    expect(skill?.collidesWith).toEqual(['second']);
  });

  it('does not report a provider that merely lost the precedence order as a collision', () => {
    const root = tempDir();
    writeSkill(root, 'shared');

    const registry = createSkillRegistry({
      roots: [{ path: root, source: 'project' }],
      contributions: [
        {
          name: 'shared',
          source: 'plugin',
          path: '/plugins/demo/skills/shared/SKILL.md',
          provider: 'demo',
        },
      ],
    });

    // The project skill wins on precedence; the plugin's skill merely lost
    // the order, which is not a collision.
    const skill = registry.resolve('shared');
    expect(skill?.source).toBe('project');
    expect(skill?.collidesWith).toBeUndefined();
  });

  it('names a provider once, however many paths it shipped the name under', () => {
    const first = tempDir();
    const second = tempDir();

    writeFile(
      path.join(first, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'first', skills: 'skills' }),
    );
    writeFile(path.join(first, 'SKILL.md'), '---\ndescription: A.\n---\n\nBody.\n');
    writeSkill(path.join(first, 'skills'), 'shared');

    writeFile(
      path.join(second, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'second', skills: ['skills', 'more-skills'] }),
    );
    writeFile(path.join(second, 'SKILL.md'), '---\ndescription: B.\n---\n\nBody.\n');
    writeSkill(path.join(second, 'skills'), 'shared');
    writeSkill(path.join(second, 'more-skills'), 'shared');

    const manager = createPluginManager();
    manager.load(first);
    manager.load(second);

    const skills = manager.skills();
    expect(skills.map((skill) => skill.provider)).toEqual(['first', 'second', 'second']);

    // The provider that shipped the name twice is named **once**.
    const registry = createSkillRegistry({ contributions: skills });
    const skill = registry.resolve('shared');
    expect(skill?.provider).toBe('first');
    expect(skill?.collidesWith).toEqual(['second']);
  });

  it('reports the duplication and contributes the name once on the apply() path', () => {
    const root = pluginWithTwoSkillDirectories();

    const manager = createPluginManager();
    manager.load(root);

    const applied = manager.apply('demo');

    // The plugin contributes the name **once** — the first path wins.
    expect(applied.skills.map((skill) => skill.name)).toEqual(['shared']);
    expect(applied.skills[0]?.path).toBe(path.join(root, 'skills', 'shared', 'SKILL.md'));

    // … and the duplication is reported on this path too.
    const warning = manager.logs().find((log) => log.level === 'warn');
    expect(warning?.message).toContain('demo');
    expect(warning?.message).toContain('shared');
    expect(warning?.message).toContain(path.join(root, 'skills', 'shared', 'SKILL.md'));
    expect(warning?.message).toContain(path.join(root, 'more-skills', 'shared', 'SKILL.md'));
  });

  it('reports the duplication and contributes the name once on the apply() path for a subagent', () => {
    const root = pluginWithTwoAgentDirectories();

    const manager = createPluginManager();
    manager.load(root);

    const applied = manager.apply('demo');

    expect(applied.agents.map((agent) => agent.name)).toEqual(['planner']);
    expect(applied.agents[0]?.path).toBe(path.join(root, 'agents', 'planner.md'));

    const warning = manager.logs().find((log) => log.level === 'warn');
    expect(warning?.message).toContain('demo');
    expect(warning?.message).toContain('planner');
    expect(warning?.message).toContain(path.join(root, 'agents', 'planner.md'));
    expect(warning?.message).toContain(path.join(root, 'more-agents', 'planner.md'));
  });

  it('reports a declared path that does not exist, in the log and in the manifest problems', () => {
    const root = tempDir();
    writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', skills: 'missing-skills', agents: 'missing-agents' }),
    );
    writeFile(path.join(root, 'SKILL.md'), '---\ndescription: A.\n---\n\nBody.\n');

    const manager = createPluginManager();
    const plugin = manager.load(root);

    // The log names the paths that are not there — a missing path is never
    // dropped silently.
    const warnings = manager.logs().filter((log) => log.level === 'warn');
    expect(warnings.some((log) => log.message.includes('missing-skills'))).toBe(true);
    expect(warnings.some((log) => log.message.includes('missing-agents'))).toBe(true);
    expect(warnings.every((log) => log.message.includes('does not exist'))).toBe(true);

    // … and the manifest record is self-describing.
    const problems = plugin.manifest?.problems ?? [];
    expect(problems.some((entry) => entry.includes('missing-skills'))).toBe(true);
    expect(problems.some((entry) => entry.includes('missing-agents'))).toBe(true);

    // The path is kept, so a plugin that ships its content later still works.
    expect(plugin.manifest?.directories['skills']).toEqual(['missing-skills']);
    expect(plugin.manifest?.directories['agents']).toEqual(['missing-agents']);
  });
});

// ---------------------------------------------------------------------------
// Plugins: the command discovery rules
// ---------------------------------------------------------------------------

describe('the plugin command discovery rules', () => {
  it('names a command after the file basename', () => {
    const root = tempDir();
    writeFile(path.join(root, 'commands', 'hello.md'), '---\ndescription: Hi.\n---\n\nHello.\n');

    const discovery = discoverPluginCommands({
      plugin: 'demo',
      root,
      commandsPaths: ['commands'],
    });

    expect(discovery.commands.map((command) => command.name)).toEqual(['demo:hello']);
    expect(discovery.commands[0]?.path).toBe(path.join(root, 'commands', 'hello.md'));
  });

  it('names a command after the metadata key when the metadata source resolves to the same path', () => {
    const root = tempDir();
    writeFile(path.join(root, 'commands', 'hello.md'), '---\ndescription: Hi.\n---\n\nHello.\n');

    const metadata: Record<string, PluginCommandMetadata> = {
      greeting: { source: 'commands/hello.md' },
    };

    const discovery = discoverPluginCommands({
      plugin: 'demo',
      root,
      commandsPaths: ['commands'],
      commandsMetadata: metadata,
    });

    expect(discovery.commands.map((command) => command.name)).toEqual(['demo:greeting']);
  });

  it('gives an inline command the pseudo-path', () => {
    const metadata: Record<string, PluginCommandMetadata> = {
      inline: { content: 'Say hi.' },
    };

    const discovery = discoverPluginCommands({
      plugin: 'demo',
      root: tempDir(),
      commandsPaths: [],
      commandsMetadata: metadata,
    });

    expect(discovery.commands[0]?.name).toBe('demo:inline');
    expect(discovery.commands[0]?.path).toBe('<inline:demo:inline>');
    expect(discovery.commands[0]?.inline).toBe(true);
  });

  it('does not treat a metadata entry with both a source and content as an inline command', () => {
    const root = tempDir();
    writeFile(path.join(root, 'commands', 'hello.md'), '---\ndescription: Hi.\n---\n\nHello.\n');

    const discovery = discoverPluginCommands({
      plugin: 'demo',
      root,
      commandsPaths: ['commands'],
      commandsMetadata: {
        greeting: { source: 'commands/hello.md', content: 'Inline body.' },
      },
    });

    // The entry names the **file** command; the inline body is not a command
    // of its own.
    expect(discovery.commands.map((command) => command.name)).toEqual(['demo:greeting']);
    expect(discovery.commands[0]?.inline).toBe(false);
    expect(discovery.commands[0]?.body).not.toContain('Inline body.');
  });

  it('warns, rather than errors, for a directory with no commands', () => {
    const root = tempDir();
    mkdirSync(path.join(root, 'commands'), { recursive: true });
    const commandDir = path.join(root, 'commands');

    const discovery = discoverPluginCommands({
      plugin: 'demo',
      root,
      commandsPaths: ['commands'],
    });

    expect(discovery.warnings).toContain(
      `Warning: No commands found in plugin \`demo\` custom directory: \`${commandDir}\`. Expected .md files or SKILL.md in subdirectories.`,
    );
    expect(discovery.commands).toHaveLength(0);
  });

  it('does not warn for a directory that holds a SKILL.md in a subdirectory', () => {
    const root = tempDir();
    writeFile(path.join(root, 'commands', 'nested', 'SKILL.md'), '---\ndescription: N.\n---\n\nBody.\n');

    const discovery = discoverPluginCommands({
      plugin: 'demo',
      root,
      commandsPaths: ['commands'],
    });

    expect(discovery.warnings).toHaveLength(0);
  });

  it('skips a command file over the byte limit', () => {
    const root = tempDir();
    const big = path.join(root, 'commands', 'big.md');
    writeFile(big, 'x'.repeat(10_001));

    const discovery = discoverPluginCommands({
      plugin: 'demo',
      root,
      commandsPaths: ['commands'],
    });

    // The limit is pinned with a literal, and the message carries the limit
    // in backticks — the target's exact wording.
    expect(discovery.warnings).toContain(
      `Skipping plugin command \`${big}\`: exceeds \`10000\` byte limit`,
    );
    expect(discovery.commands).toHaveLength(0);
  });

  it('pins the command byte limit at 10000 bytes', () => {
    expect(PLUGIN_COMMAND_BYTE_LIMIT).toBe(10_000);
  });

  it('interns identical skill bodies', () => {
    const root = tempDir();
    writeFile(path.join(root, 'commands', 'a.md'), '---\ndescription: A.\n---\n\nSame body.\n');
    writeFile(path.join(root, 'commands', 'b.md'), '---\ndescription: B.\n---\n\nSame body.\n');

    const discovery = discoverPluginCommands({
      plugin: 'demo',
      root,
      commandsPaths: ['commands'],
    });

    expect(discovery.commands).toHaveLength(2);
    expect(discovery.commands[0]?.bodyId).toBe(discovery.commands[1]?.bodyId);
    expect(discovery.interner.size).toBe(1);
  });

  it('surfaces a malformed frontmatter alongside the command', () => {
    const root = tempDir();
    writeFile(path.join(root, 'commands', 'bad.md'), '---\ndescription A.\n---\n\nBody.\n');

    const discovery = discoverPluginCommands({
      plugin: 'demo',
      root,
      commandsPaths: ['commands'],
    });

    expect(discovery.commands).toHaveLength(1);
    expect(discovery.commands[0]?.frontmatterProblem).toBeDefined();
  });

  it('never resolves a command name to an inherited member of Object.prototype', () => {
    // `JSON.parse` builds an **own** `__proto__` property, which an object
    // literal would not: a literal would set the prototype instead.
    const metadata = JSON.parse('{"__proto__": {"content": "nope"}}') as Record<
      string,
      PluginCommandMetadata
    >;

    const discovery = discoverPluginCommands({
      plugin: 'demo',
      root: tempDir(),
      commandsPaths: [],
      commandsMetadata: metadata,
    });

    expect(discovery.commands).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Plugins: the path boundary
// ---------------------------------------------------------------------------

describe('the plugin path boundary', () => {
  /** A plugin root and a directory beside it that the plugin may not read. */
  function pluginAndOutside(): { base: string; root: string; outside: string } {
    const base = tempDir();
    const root = path.join(base, 'plugin');
    const outside = path.join(base, 'outside');
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFile(path.join(root, 'SKILL.md'), '---\ndescription: Demo.\n---\n\nBody.\n');
    return { base, root, outside };
  }

  it('refuses a manifest commands path that escapes the plugin root', () => {
    const { root, outside } = pluginAndOutside();
    writeFile(path.join(outside, 'secret.md'), 'TOP SECRET BODY');
    writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'evil', commands: '../outside' }),
    );

    const manager = createPluginManager();
    manager.load(root);

    expect(manager.commands('evil')).toHaveLength(0);
    const warning = manager.logs().find((log) => log.message.includes('outside the plugin root'));
    expect(warning).toBeDefined();
    expect(warning?.level).toBe('warn');
    expect(manager.logs().some((log) => log.message.includes('TOP SECRET'))).toBe(false);
  });

  it('refuses a manifest commands file path that escapes the plugin root', () => {
    const { root, outside } = pluginAndOutside();
    writeFile(path.join(outside, 'secret.md'), 'TOP SECRET BODY');
    writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'evil', commands: '../outside/secret.md' }),
    );

    const manager = createPluginManager();
    manager.load(root);

    expect(manager.commands('evil')).toHaveLength(0);
    expect(
      manager.logs().some((log) => log.message.includes('outside the plugin root')),
    ).toBe(true);
  });

  it('refuses a manifest skills path that escapes the plugin root', () => {
    const { root, outside } = pluginAndOutside();
    writeSkill(outside, 'stolen');
    writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'evil', skills: '../outside/skills' }),
    );

    const manager = createPluginManager();
    manager.load(root);

    expect(manager.skills()).toHaveLength(0);
    expect(
      manager.logs().some((log) => log.message.includes('outside the plugin root')),
    ).toBe(true);
  });

  it('refuses a manifest agents path that escapes the plugin root', () => {
    const { root, outside } = pluginAndOutside();
    writeFile(path.join(outside, 'planner.md'), '---\ndescription: Plans.\n---\n\nBody.\n');
    writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'evil', agents: '../outside/agents' }),
    );

    const manager = createPluginManager();
    manager.load(root);

    expect(manager.agents()).toHaveLength(0);
    expect(
      manager.logs().some((log) => log.message.includes('outside the plugin root')),
    ).toBe(true);
  });

  it('refuses a symlink inside the plugin root that points outside it', () => {
    const { root, outside } = pluginAndOutside();
    writeFile(path.join(outside, 'secret.md'), 'TOP SECRET BODY');
    symlinkSync(outside, path.join(root, 'commands'), 'dir');
    writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'evil', commands: 'commands' }),
    );

    const manager = createPluginManager();
    manager.load(root);

    expect(manager.commands('evil')).toHaveLength(0);
    const warning = manager.logs().find((log) => log.message.includes('outside the plugin root'));
    expect(warning).toBeDefined();
    expect(warning?.message).toContain('symlink');
  });

  it('refuses a symlinked command file inside the plugin root that points outside it', () => {
    const { root, outside } = pluginAndOutside();
    writeFile(path.join(outside, 'secret.md'), 'TOP SECRET BODY');
    mkdirSync(path.join(root, 'commands'), { recursive: true });
    symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'commands', 'leak.md'));
    writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'evil', commands: 'commands' }),
    );

    const manager = createPluginManager();
    manager.load(root);

    expect(manager.commands('evil')).toHaveLength(0);
    expect(
      manager.logs().some((log) => log.message.includes('outside the plugin root')),
    ).toBe(true);
  });

  it('refuses a symlinked skill subdirectory that points outside the plugin root', () => {
    const { root, outside } = pluginAndOutside();
    // The plugin's skills directory is inside its own root …
    mkdirSync(path.join(root, 'skills'), { recursive: true });
    writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'evil', skills: 'skills' }),
    );

    const manager = createPluginManager();
    manager.load(root);

    // … and one of the skill directories inside it is a symlink that points
    // outside the root.
    writeSkill(path.join(outside, 'skills'), 'stolen');
    symlinkSync(path.join(outside, 'skills', 'stolen'), path.join(root, 'skills', 'stolen'), 'dir');

    // The outside skill is not discovered …
    expect(manager.skills()).toHaveLength(0);
    // … and the refusal names the escape.
    const warning = manager.logs().find((log) => log.message.includes('outside the plugin root'));
    expect(warning).toBeDefined();
    expect(warning?.message).toContain('symlink');
    expect(manager.logs().some((log) => log.message.includes('The body of stolen'))).toBe(
      false,
    );
  });

  it('refuses a symlinked agent file inside the plugin root that points outside it', () => {
    const { root, outside } = pluginAndOutside();
    writeFile(path.join(outside, 'planner.md'), '---\ndescription: Plans.\n---\n\nBody.\n');
    mkdirSync(path.join(root, 'agents'), { recursive: true });
    symlinkSync(path.join(outside, 'planner.md'), path.join(root, 'agents', 'leak.md'));
    writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'evil', agents: 'agents' }),
    );

    const manager = createPluginManager();
    manager.load(root);

    // The outside agent is not discovered …
    expect(manager.agents()).toHaveLength(0);
    // … and the refusal names the escape.
    const warning = manager.logs().find((log) => log.message.includes('outside the plugin root'));
    expect(warning).toBeDefined();
    expect(warning?.message).toContain('symlink');
  });

  it('refuses a skills directory that escapes the plugin root, and names the directory', () => {
    const { root, outside } = pluginAndOutside();
    // The skills directory is inside the root when the plugin is loaded …
    writeSkill(path.join(root, 'skills'), 'inside');
    writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'evil', skills: 'skills' }),
    );

    const manager = createPluginManager();
    manager.load(root);

    // … and turns into a symlink that points outside it afterwards.
    writeSkill(path.join(outside, 'skills'), 'stolen');
    rmSync(path.join(root, 'skills'), { recursive: true, force: true });
    symlinkSync(path.join(outside, 'skills'), path.join(root, 'skills'), 'dir');

    expect(manager.skills()).toHaveLength(0);
    const warning = manager.logs().find((log) => log.message.includes('outside the plugin root'));
    expect(warning).toBeDefined();
    // The refusal names the **directory** that escaped, not a file inside it.
    expect(warning?.message).toContain(`\`${path.join(root, 'skills')}\``);
  });

  it('refuses an agents directory that escapes the plugin root, and names the directory', () => {
    const { root, outside } = pluginAndOutside();
    mkdirSync(path.join(root, 'agents'), { recursive: true });
    writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'evil', agents: 'agents' }),
    );

    const manager = createPluginManager();
    manager.load(root);

    writeFile(path.join(outside, 'agents', 'planner.md'), '---\ndescription: P.\n---\n\nBody.\n');
    rmSync(path.join(root, 'agents'), { recursive: true, force: true });
    symlinkSync(path.join(outside, 'agents'), path.join(root, 'agents'), 'dir');

    expect(manager.agents()).toHaveLength(0);
    const warning = manager.logs().find((log) => log.message.includes('outside the plugin root'));
    expect(warning).toBeDefined();
    // The refusal names the **directory** that escaped, not a file inside it.
    expect(warning?.message).toContain(`\`${path.join(root, 'agents')}\``);
  });

  it('refuses a commands directory that escapes the plugin root, and never walks it', () => {
    const { root, outside } = pluginAndOutside();
    writeFile(path.join(outside, 'commands', 'leak.md'), 'TOP SECRET BODY');

    const discovery = discoverPluginCommands({
      plugin: 'evil',
      root,
      commandsPaths: ['../outside/commands'],
    });

    expect(discovery.commands).toHaveLength(0);
    const warning = discovery.warnings.find((entry) => entry.includes('outside the plugin root'));
    expect(warning).toBeDefined();
    // The refusal names the **directory** that escaped …
    expect(warning).toContain(`\`${path.join(outside, 'commands')}\``);
    // … and nothing inside it is ever read.
    expect(discovery.warnings.some((entry) => entry.includes('leak.md'))).toBe(false);
  });

  it('refuses a commands metadata source that escapes the plugin root, and reports it', () => {
    const { root, outside } = pluginAndOutside();
    writeFile(path.join(outside, 'secret.md'), 'TOP SECRET BODY');
    writeFile(
      path.join(root, 'commands', 'hello.md'),
      '---\ndescription: Hi.\n---\n\nHello.\n',
    );

    const discovery = discoverPluginCommands({
      plugin: 'evil',
      root,
      commandsPaths: ['commands'],
      commandsMetadata: { greeting: { source: '../outside/secret.md' } },
    });

    // The escaping source never names a command …
    expect(discovery.commands.map((command) => command.name)).toEqual(['evil:hello']);
    // … and the refusal is reported.
    const warning = discovery.warnings.find((entry) => entry.includes('greeting'));
    expect(warning).toBeDefined();
    expect(warning).toContain('outside the plugin root');
  });

  it('records a refused manifest path in the manifest problems', () => {
    const { root, outside } = pluginAndOutside();
    writeSkill(path.join(outside, 'skills'), 'stolen');
    writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'evil', skills: '../outside/skills' }),
    );

    const manager = createPluginManager();
    const plugin = manager.load(root);

    // The manifest record is self-describing: it names the path it dropped …
    const problems = plugin.manifest?.problems ?? [];
    const problem = problems.find((entry) => entry.includes('skills'));
    expect(problem).toBeDefined();
    expect(problem).toContain('../outside/skills');
    expect(problem).toContain('outside the plugin root');
    // … and the log record is kept.
    expect(
      manager.logs().some((log) => log.message.includes('outside the plugin root')),
    ).toBe(true);
  });

  it('refuses every other manifest-declared path that escapes the plugin root', () => {
    const { root, outside } = pluginAndOutside();
    writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'evil',
        mcpServers: '../outside/mcp.json',
        lspServers: '../outside/lsp.json',
        hooks: '../outside/hooks.json',
        outputStyles: '../outside/styles',
        themes: '../outside/themes',
        workflows: '../outside/workflows',
        monitors: '../outside/monitors',
      }),
    );

    const manager = createPluginManager();
    const plugin = manager.load(root);

    const escaped = manager.logs().filter((log) => log.message.includes('outside the plugin root'));
    expect(escaped.length).toBe(7);

    const files = plugin.manifest?.files as
      | Record<string, string[] | undefined>
      | undefined;
    const directories = plugin.manifest?.directories as
      | Record<string, string[] | undefined>
      | undefined;

    for (const key of ['mcpServers', 'lspServers', 'hooks']) {
      expect(escaped.some((log) => log.message.includes(`\`${key}\``))).toBe(true);
      expect(files?.[key] ?? []).toEqual([]);
    }
    for (const key of ['outputStyles', 'themes', 'workflows', 'monitors']) {
      expect(escaped.some((log) => log.message.includes(`\`${key}\``))).toBe(true);
      expect(directories?.[key] ?? []).toEqual([]);
    }
  });

  it('refuses an escaping path handed straight to the command discovery', () => {
    const { root, outside } = pluginAndOutside();
    writeFile(path.join(outside, 'secret.md'), 'TOP SECRET BODY');

    const discovery = discoverPluginCommands({
      plugin: 'evil',
      root,
      commandsPaths: ['../outside/secret.md'],
    });

    expect(discovery.commands).toHaveLength(0);
    expect(
      discovery.warnings.some((warning) => warning.includes('outside the plugin root')),
    ).toBe(true);
  });

  it('refuses a commands metadata source that escapes the plugin root', () => {
    const { root, outside } = pluginAndOutside();
    writeFile(path.join(outside, 'secret.md'), 'TOP SECRET BODY');
    writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'evil',
        commands: { greeting: { source: '../outside/secret.md' } },
      }),
    );

    const manager = createPluginManager();
    const plugin = manager.load(root);

    expect(plugin.manifest?.commands).toEqual([]);
    expect(manager.commands('evil')).toHaveLength(0);
    expect(
      manager.logs().some((log) => log.message.includes('outside the plugin root')),
    ).toBe(true);
  });

  it('keeps a manifest path that stays inside the plugin root', () => {
    const { root } = pluginAndOutside();
    writeFile(path.join(root, 'commands', 'hello.md'), '---\ndescription: Hi.\n---\n\nHello.\n');
    writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', commands: 'commands' }),
    );

    const manager = createPluginManager();
    manager.load(root);

    expect(manager.commands('demo').map((command) => command.name)).toEqual(['demo:hello']);
    expect(
      manager.logs().some((log) => log.message.includes('outside the plugin root')),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Plugins: the marketplace install flow
// ---------------------------------------------------------------------------

describe('the marketplace install flow', () => {
  function installRequest(
    overrides: Partial<PluginInstallRequest> = {},
  ): PluginInstallRequest {
    return {
      plugin: {
        id: 'demo@marketplace',
        name: 'demo',
        version: '1.2.3',
        commandSources: ['trusted'],
      },
      marketplace: 'marketplace',
      installSource: 'ui-suggestion',
      trigger: 'suggestion-click',
      surface: 'settings',
      trustedCommandSources: ['trusted'],
      ...overrides,
    };
  }

  it('records the version, the install source, the trigger and the surface', async () => {
    const manager = createPluginManager();
    const result = await manager.installFromMarketplace(installRequest());

    expect(result.success).toBe(true);
    const record = manager.installations()[0];
    expect(record?.pluginId).toBe('demo@marketplace');
    expect(record?.version).toBe('1.2.3');
    expect(record?.installSource).toBe('ui-suggestion');
    expect(record?.trigger).toBe('suggestion-click');
    expect(record?.surface).toBe('settings');
  });

  it('succeeds while the plugin stays disabled by default, reported as by-default', async () => {
    const manager = createPluginManager();
    const result = await manager.installFromMarketplace(
      installRequest({ disabledByDefault: true }),
    );

    expect(result.success).toBe(true);
    expect(result.installedDisabledByDefault).toBe(true);
    expect(result.installedDisabled).toBe(false);
    expect(result.disableReason).toBe('by-default');
    expect(result.message).toContain('by-default');
  });

  it('reports a plugin a setting turned off as in-settings', async () => {
    const manager = createPluginManager();
    const result = await manager.installFromMarketplace(
      installRequest({ disabledInSettings: true }),
    );

    expect(result.success).toBe(true);
    expect(result.installedDisabled).toBe(true);
    expect(result.installedDisabledByDefault).toBe(false);
    expect(result.disableReason).toBe('in-settings');
    expect(result.message).toContain('in-settings');
  });

  it('returns the enable hint', async () => {
    const manager = createPluginManager();
    const result = await manager.installFromMarketplace(installRequest());

    expect(result.enableHint).toBe('enable it in /plugin');
  });

  it('returns the enable hint with a command when one is known', async () => {
    const manager = createPluginManager();
    const result = await manager.installFromMarketplace(
      installRequest({ enableCommand: '/demo enable' }),
    );

    expect(result.enableHint).toBe('enable it in /plugin or run: /demo enable');
  });

  it('refuses an install whose command source is not trusted, and logs it at info level', async () => {
    const manager = createPluginManager();
    const result = await manager.installFromMarketplace(
      installRequest({
        plugin: {
          id: 'demo@marketplace',
          name: 'demo',
          version: '1.2.3',
          commandSources: ['untrusted'],
        },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.refused).toBe(true);
    expect(result.failureReason).toBe('command-source-refused');
    expect(result.telemetry?.reason).toBe('command-source-refused');

    const log = manager.logs().at(-1);
    expect(log?.level).toBe('info');
    expect(log?.message).toBe(
      'installPluginFromMarketplace refused for demo: untrusted command source: untrusted',
    );
  });

  it('logs a genuine failure at error level', async () => {
    const manager = createPluginManager();
    const result = await manager.installFromMarketplace(
      installRequest({
        failure: { code: 'disk-full', kind: 'io', message: 'no space left' },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.refused).toBe(false);
    expect(result.failureReason).toBe('failed');
    expect(result.telemetry?.reason).toBe('failureCode');
    expect(result.telemetry?.failureCode).toBe('disk-full');
    expect(result.telemetry?.errorKind).toBe('io');

    const log = manager.logs().at(-1);
    expect(log?.level).toBe('error');
    expect(log?.message).toContain('failed');
  });

  it('carries the plugin id, the marketplace, the trigger and the surface in the telemetry', async () => {
    const manager = createPluginManager();
    await manager.installFromMarketplace(
      installRequest({
        failure: { message: 'boom' },
      }),
    );

    const telemetry = manager.logs().at(-1)?.telemetry;
    expect(telemetry?.pluginId).toBe('demo@marketplace');
    expect(telemetry?.marketplace).toBe('marketplace');
    expect(telemetry?.trigger).toBe('suggestion-click');
    expect(telemetry?.surface).toBe('settings');
    expect(telemetry?.reason).toBe('unexpected-error');
  });

  it('computes the version transition', async () => {
    const manager = createPluginManager();
    const result = await manager.installFromMarketplace(
      installRequest({ fromVersion: '1.0.0' }),
    );

    expect(result.versionTransition).toEqual({ from: '1.0.0', to: '1.2.3' });
  });

  it('drops a stray orphan marker from the staged plugin', async () => {
    const stage = tempDir();
    const marker = path.join(stage, '.orphan');
    writeFile(marker, 'marker');
    const manager = createPluginManager();

    await manager.installFromMarketplace(installRequest({ stagedPath: stage }));

    // The marker is gone — not merely unreported.
    expect(existsSync(marker)).toBe(false);
    expect(manager.logs().some((log) => log.message.includes('orphan marker'))).toBe(false);
  });

  it('reports the dependency note and the other-projects note', async () => {
    const manager = createPluginManager();
    const result = await manager.installFromMarketplace(
      installRequest({
        plugin: {
          id: 'demo@marketplace',
          name: 'demo',
          version: '1.2.3',
          commandSources: ['trusted'],
          dependencies: ['left-pad'],
        },
        otherProjects: true,
      }),
    );

    expect(result.depNote).toBe('This plugin needs left-pad.');
    expect(result.otherProjectsNote).toBe(
      'This plugin is also installed for your other projects.',
    );
  });

  it('reports no dependency note and no other-projects note when there are none', async () => {
    const manager = createPluginManager();
    const result = await manager.installFromMarketplace(installRequest());

    expect(result.depNote).toBeUndefined();
    expect(result.otherProjectsNote).toBeUndefined();
  });

  it('warns when it cannot drop the stray orphan marker', async () => {
    const stage = tempDir();
    writeFile(path.join(stage, '.orphan', 'keep.txt'), 'marker');
    const manager = createPluginManager();

    await manager.installFromMarketplace(installRequest({ stagedPath: stage }));

    const warning = manager.logs().find((log) => log.level === 'warn');
    expect(warning?.message).toContain(
      'Could not drop a stray orphan marker from the staged plugin:',
    );
  });
});

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

describe('the subagent registry', () => {
  it('discovers a project subagent and a plugin subagent', () => {
    const cwd = tempDir();
    const configDir = tempDir();
    writeFile(
      path.join(cwd, '.claude', 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: Reviews code.\n---\n\nReview it.\n',
    );

    const registry = createSubagentRegistry({
      cwd,
      configDir,
      contributions: [
        {
          name: 'planner',
          source: 'plugin',
          path: '/plugins/demo/agents/planner.md',
          description: 'Plans work.',
          body: 'Plan it.',
          provider: 'demo',
        },
      ],
    });

    const byName = new Map(registry.list().map((agent) => [agent.name, agent]));
    expect(byName.get('reviewer')?.source).toBe('project');
    expect(byName.get('reviewer')?.description).toBe('Reviews code.');
    expect(byName.get('planner')?.source).toBe('plugin');

    const discovered = registry.discover();
    expect(Object.keys(discovered[0] ?? {}).sort()).toEqual(['name', 'path', 'source']);
  });

  it('resolves a subagent by name and refuses an inherited member', () => {
    const cwd = tempDir();
    const configDir = tempDir();
    writeFile(
      path.join(cwd, '.claude', 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: Reviews code.\n---\n\nReview it.\n',
    );

    const registry = createSubagentRegistry({ cwd, configDir });
    expect(registry.resolve('reviewer')?.name).toBe('reviewer');
    expect(registry.resolve('__proto__')).toBeUndefined();
  });

  it('applies the subagents a session may use', () => {
    const cwd = tempDir();
    const configDir = tempDir();
    writeFile(
      path.join(cwd, '.claude', 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: Reviews code.\n---\n\nReview it.\n',
    );
    writeFile(
      path.join(cwd, '.claude', 'agents', 'planner.md'),
      '---\nname: planner\ndescription: Plans work.\n---\n\nPlan it.\n',
    );

    const registry = createSubagentRegistry({
      cwd,
      configDir,
      tiers: tierMap({ userSettings: { skillOverrides: { planner: 'off' } } }),
    });

    const applied = registry.apply();
    expect(applied.map((agent) => agent.name)).toEqual(['reviewer']);
    expect(applied[0]).toMatchObject({ invocable: true, autoInvocable: true });
  });

  it('skips a subagent file over the byte limit', () => {
    const cwd = tempDir();
    const configDir = tempDir();
    const agents = path.join(cwd, '.claude', 'agents');
    mkdirSync(agents, { recursive: true });
    writeFile(path.join(agents, 'huge.md'), 'x'.repeat(SUBAGENT_FILE_BYTE_LIMIT + 1));

    const registry = createSubagentRegistry({ cwd, configDir });
    const definition = registry.resolve('huge');

    // REA observed: the markdown scan skips a file that is not a regular file
    // or that is over the byte limit, and it never reads it.
    expect(definition).toBeUndefined();
    const refusal = registry.refusals().find((entry) => entry.path.endsWith('huge.md'));
    expect(refusal?.level).toBe('warn');
    expect(refusal?.reason).toContain(
      `loadMarkdownFilesFromDir: skipping ${path.join(agents, 'huge.md')}: not a regular file or exceeds ${SUBAGENT_FILE_BYTE_LIMIT} byte limit`,
    );
  });

  it('reports a subagent name two plugins provide, instead of dropping one silently', () => {
    const registry = createSubagentRegistry({
      contributions: [
        {
          name: 'planner',
          source: 'plugin',
          path: '/plugins/first/agents/planner.md',
          provider: 'first',
        },
        {
          name: 'planner',
          source: 'plugin',
          path: '/plugins/second/agents/planner.md',
          provider: 'second',
        },
      ],
    });

    const definition = registry.resolve('planner');
    expect(definition?.provider).toBe('first');
    expect(definition?.collidesWith).toEqual(['second']);
  });
});

// ---------------------------------------------------------------------------
// The subagent definition lifecycle
// ---------------------------------------------------------------------------

describe('the subagent definition lifecycle', () => {
  /** A definition file: the frontmatter carries the name and the description. */
  function definition(name: string, description = 'Does the work.'): string {
    return `---\nname: ${name}\ndescription: ${description}\n---\n\nThe body of ${name}.\n`;
  }

  /** An agents root that holds one definition per name. */
  function agentsRoot(names: readonly string[]): string {
    const root = tempDir();
    for (const name of names) {
      writeFile(path.join(root, `${name}.md`), definition(name));
    }
    return root;
  }

  it('takes the agent name from the frontmatter, not from the file name', () => {
    const root = tempDir();
    // The file name is free-form.
    writeFile(path.join(root, 'anything-at-all.md'), definition('reviewer'));

    const registry = createSubagentRegistry({ roots: [{ path: root, source: 'project' }] });

    expect(registry.list().map((agent) => agent.name)).toEqual(['reviewer']);
    expect(registry.resolve('reviewer')?.description).toBe('Does the work.');
    expect(registry.resolve('anything-at-all')).toBeUndefined();
  });

  it('scans an agents directory recursively, for markdown files only', () => {
    const root = tempDir();
    writeFile(path.join(root, 'reviewer.md'), definition('reviewer'));
    writeFile(path.join(root, 'nested', 'deeper', 'planner.md'), definition('planner'));
    // A file that is not markdown is not a definition.
    writeFile(path.join(root, 'notes.txt'), 'not a definition');

    const registry = createSubagentRegistry({ roots: [{ path: root, source: 'project' }] });

    expect(registry.list().map((agent) => agent.name).sort()).toEqual(['planner', 'reviewer']);
  });

  it('refuses a definition without a description, by name', () => {
    const root = tempDir();
    writeFile(path.join(root, 'reviewer.md'), '---\nname: reviewer\n---\n\nReview it.\n');

    const registry = createSubagentRegistry({ roots: [{ path: root, source: 'project' }] });

    // The description is required, so the definition is refused — and the
    // refusal names it.
    expect(registry.resolve('reviewer')).toBeUndefined();
    const refusal = registry.refusals().find((entry) => entry.name === 'reviewer');
    expect(refusal?.level).toBe('warn');
    expect(refusal?.reason).toContain(
      `Agent file ${path.join(root, 'reviewer.md')} is missing required 'description' in frontmatter`,
    );
  });

  it('refuses a definition whose name the target refuses', () => {
    const root = tempDir();
    writeFile(path.join(root, 'leading-dash.md'), definition('-reviewer'));
    writeFile(path.join(root, 'colon.md'), definition('review:er'));
    writeFile(path.join(root, 'long.md'), definition('x'.repeat(SUBAGENT_NAME_MAX_LENGTH + 1)));

    const registry = createSubagentRegistry({ roots: [{ path: root, source: 'project' }] });

    expect(registry.list()).toEqual([]);
    const reasons = registry.refusals().map((entry) => entry.reason).join('\n');
    expect(reasons).toContain("names must not start with '-'");
    expect(reasons).toContain(
      "names must not contain ':' (reserved for plugin namespacing)",
    );
    expect(reasons).toContain(`names must be at most ${SUBAGENT_NAME_MAX_LENGTH} characters`);
    expect(isValidSubagentName('-reviewer')).toBe(false);
    expect(isValidSubagentName('reviewer')).toBe(true);
  });

  it('reads the frontmatter fields the target\'s definition carries', () => {
    const root = tempDir();
    writeFile(
      path.join(root, 'reviewer.md'),
      [
        '---',
        'name: reviewer',
        'description: Reviews code.',
        'model: opus',
        'tools: Read, Grep',
        'disallowedTools: Write',
        'skills: review, audit',
        'initialPrompt: Start here.',
        'permissionMode: plan',
        'maxTurns: 12',
        '---',
        '',
        'Review it.',
        '',
      ].join('\n'),
    );

    const registry = createSubagentRegistry({ roots: [{ path: root, source: 'project' }] });
    const definition = registry.resolve('reviewer');

    expect(definition).toMatchObject({
      name: 'reviewer',
      description: 'Reviews code.',
      model: 'opus',
      tools: ['Read', 'Grep'],
      disallowedTools: ['Write'],
      skills: ['review', 'audit'],
      initialPrompt: 'Start here.',
      permissionMode: 'plan',
      maxTurns: 12,
    });
    expect(definition?.body.trim()).toBe('Review it.');
  });

  it('resolves a name two sources define by the target\'s precedence', () => {
    const base = tempDir();
    const pluginRoot = path.join(base, 'plugin');
    const userRoot = path.join(base, 'user');
    const projectRoot = path.join(base, 'project');
    writeFile(path.join(pluginRoot, 'shared.md'), definition('shared'));
    writeFile(path.join(userRoot, 'shared.md'), definition('shared'));
    writeFile(path.join(projectRoot, 'shared.md'), definition('shared'));

    // The target's order: built-in, plugin, user settings, project settings,
    // feature flags, machine policy — the later wins.
    const registry = createSubagentRegistry({
      roots: [
        { path: pluginRoot, source: 'plugin' },
        { path: userRoot, source: 'user' },
        { path: projectRoot, source: 'project' },
      ],
    });

    expect(registry.resolve('shared')?.source).toBe('project');

    // The order of the roots does not change the outcome.
    const reordered = createSubagentRegistry({
      roots: [
        { path: projectRoot, source: 'project' },
        { path: userRoot, source: 'user' },
        { path: pluginRoot, source: 'plugin' },
      ],
    });
    expect(reordered.resolve('shared')?.source).toBe('project');
    expect(SUBAGENT_TIER_PRECEDENCE).toEqual([
      'built-in',
      'plugin',
      'userSettings',
      'local',
      'projectSettings',
      'flagSettings',
      'policySettings',
    ]);
  });

  it('lets a runtime registration beat a project definition', () => {
    const projectRoot = agentsRoot(['shared']);
    const registry = createSubagentRegistry({
      roots: [{ path: projectRoot, source: 'project' }],
      contributions: [
        {
          name: 'shared',
          source: 'mcp',
          path: 'mcp://memory/shared',
          body: 'The body.',
        },
      ],
    });

    // A runtime registration is the target's flag tier, which is above the
    // project's.
    expect(registry.resolve('shared')?.source).toBe('mcp');
  });

  it('caches the catalogue, and re-reads it after a reload', () => {
    const root = agentsRoot(['reviewer']);
    const registry = createSubagentRegistry({ roots: [{ path: root, source: 'project' }] });

    expect(registry.list().map((agent) => agent.name)).toEqual(['reviewer']);

    writeFile(path.join(root, 'planner.md'), definition('planner'));
    // The catalogue is cached, as the target's is.
    expect(registry.list().map((agent) => agent.name)).toEqual(['reviewer']);

    registry.reload();
    expect(registry.list().map((agent) => agent.name).sort()).toEqual(['planner', 'reviewer']);
  });

  it('re-reads the catalogue across a restart', () => {
    const root = agentsRoot(['reviewer']);
    const first = createSubagentRegistry({ roots: [{ path: root, source: 'project' }] });
    expect(first.list()).toHaveLength(1);

    writeFile(path.join(root, 'planner.md'), definition('planner'));

    // A new process: a new registry, with a cold cache.
    const second = createSubagentRegistry({ roots: [{ path: root, source: 'project' }] });
    expect(second.list().map((agent) => agent.name).sort()).toEqual(['planner', 'reviewer']);
  });

  it('reconstructs an agent by name against the freshly read catalogue', () => {
    const root = agentsRoot(['reviewer']);
    const registry = createSubagentRegistry({ roots: [{ path: root, source: 'project' }] });

    const reconstruction = registry.reconstruct('reviewer');

    expect(reconstruction.available).toBe(true);
    expect(reconstruction.name).toBe('reviewer');
    expect(reconstruction.definition?.name).toBe('reviewer');
    expect(reconstruction.message).toBeUndefined();
  });

  it('says so when the agent is no longer available', () => {
    const registry = createSubagentRegistry({ roots: [] });

    const reconstruction = registry.reconstruct('gone');

    expect(reconstruction.available).toBe(false);
    expect(reconstruction.definition).toBeUndefined();
    expect(reconstruction.message).toContain('gone');
    expect(reconstruction.message).toBe(subagentUnavailableMessage('gone'));
  });
});

// ---------------------------------------------------------------------------
// The IDE bridge
// ---------------------------------------------------------------------------

describe('the IDE bridge', () => {
  /** An integration the default transport can be handed. */
  function integration(name: string): IdeIntegration {
    return {
      name,
      transport: 'http',
      endpoint: 'http://127.0.0.1:1234',
      lockPath: `/config/ide/${name}.lock`,
      alive: true,
      source: 'local',
    };
  }

  it('lists the IDE integrations it discovers and resolves one by name', () => {
    const configDir = tempDir();
    writeFile(
      path.join(configDir, 'ide', 'vscode.lock'),
      JSON.stringify({ ide: 'vscode', port: 1234, workspacePath: '/work' }),
    );

    const bridge = createIdeBridge({ configDir });
    const integrations = bridge.list();

    expect(integrations.map((integration) => integration.name)).toEqual(['vscode']);
    expect(bridge.resolve('vscode')?.workspacePath).toBe('/work');
    expect(bridge.resolve('nope')).toBeUndefined();
    expect(bridge.resolve('__proto__')).toBeUndefined();

    const discovered = bridge.discover();
    expect(Object.keys(discovered[0] ?? {}).sort()).toEqual(['name', 'path', 'source']);
  });

  it('applies a request to the resolved IDE', async () => {
    const configDir = tempDir();
    writeFile(
      path.join(configDir, 'ide', 'vscode.lock'),
      JSON.stringify({ ide: 'vscode', port: 1234 }),
    );

    const seen: unknown[] = [];
    const bridge = createIdeBridge({
      configDir,
      transport: {
        send: async (integration: IdeIntegration, request) => {
          seen.push({ ide: integration.name, action: request.action });
          return { ok: true };
        },
      },
    });

    const response = await bridge.apply({
      ide: 'vscode',
      action: 'executeCode',
      argument: 'print(1)',
    });

    expect(response.ok).toBe(true);
    expect(seen).toEqual([{ ide: 'vscode', action: 'executeCode' }]);
  });

  it('refuses a request for an IDE it cannot resolve', async () => {
    const bridge = createIdeBridge({ configDir: tempDir() });
    const response = await bridge.apply({ ide: 'nope', action: 'getDiagnostics' });

    expect(response.ok).toBe(false);
    expect(response.error).toContain('nope');
  });

  it('names the two observed IDE actions', () => {
    expect([...IDE_ACTIONS]).toEqual(['executeCode', 'getDiagnostics']);
    expect(isIdeAction('executeCode')).toBe(true);
    expect(isIdeAction('getDiagnostics')).toBe(true);
    expect(isIdeAction('somethingElse')).toBe(false);
    expect(isIdeAction(42)).toBe(false);
  });

  it('refuses an action that is not a single path segment', async () => {
    const configDir = tempDir();
    writeFile(
      path.join(configDir, 'ide', 'vscode.lock'),
      JSON.stringify({ ide: 'vscode', port: 1234 }),
    );

    const seen: unknown[] = [];
    const bridge = createIdeBridge({
      configDir,
      transport: {
        send: async (_integration: IdeIntegration, request) => {
          seen.push(request.action);
          return { ok: true };
        },
      },
    });

    const response = await bridge.apply({ ide: 'vscode', action: '../../admin' });

    expect(response.ok).toBe(false);
    expect(response.error).toContain('action');
    expect(seen).toHaveLength(0);
  });

  it('refuses an action that carries a path separator', async () => {
    const configDir = tempDir();
    writeFile(
      path.join(configDir, 'ide', 'vscode.lock'),
      JSON.stringify({ ide: 'vscode', port: 1234 }),
    );

    const bridge = createIdeBridge({
      configDir,
      transport: { send: async () => ({ ok: true }) },
    });

    const response = await bridge.apply({ ide: 'vscode', action: 'a/b' });

    expect(response.ok).toBe(false);
    expect(response.error).toContain('action');
  });

  it('refuses an action that is empty, a dot, a dot-dot, or carries a separator or a NUL', async () => {
    const configDir = tempDir();
    writeFile(
      path.join(configDir, 'ide', 'vscode.lock'),
      JSON.stringify({ ide: 'vscode', port: 1234 }),
    );

    const seen: unknown[] = [];
    const bridge = createIdeBridge({
      configDir,
      transport: {
        send: async (_integration: IdeIntegration, request) => {
          seen.push(request.action);
          return { ok: true };
        },
      },
    });

    // Every shape the single-path-segment rule refuses.
    for (const action of ['', '.', '..', 'a/b', 'a\\b', 'a\0b']) {
      const response = await bridge.apply({ ide: 'vscode', action });

      expect(response.ok).toBe(false);
      expect(response.error).toContain('action');
    }
    // Nothing was sent.
    expect(seen).toHaveLength(0);
  });

  it('applies an action outside the observed set, as a single path segment', async () => {
    const configDir = tempDir();
    writeFile(
      path.join(configDir, 'ide', 'vscode.lock'),
      JSON.stringify({ ide: 'vscode', port: 1234 }),
    );

    const seen: unknown[] = [];
    const bridge = createIdeBridge({
      configDir,
      transport: {
        send: async (_integration: IdeIntegration, request) => {
          seen.push(request.action);
          return { ok: true };
        },
      },
    });

    const response = await bridge.apply({ ide: 'vscode', action: 'formatDocument' });

    expect(response.ok).toBe(true);
    expect(seen).toEqual(['formatDocument']);
  });

  it('refuses to send an IDE request to a host that is not a loopback address', async () => {
    const transport = createHttpIdeTransport();

    await expect(
      transport.send(
        { ...integration('vscode'), endpoint: 'http://example.com:1234' },
        { ide: 'vscode', action: 'executeCode' },
      ),
    ).rejects.toThrow(/Refusing to send an IDE request to example\.com/);
  });

  it('refuses to send an IDE request whose action is not a single path segment', async () => {
    const transport = createHttpIdeTransport();

    await expect(
      transport.send(integration('vscode'), { ide: 'vscode', action: '../../admin' }),
    ).rejects.toThrow(/single path segment/);
  });
});

/**
 * Contract test: the **plugin and marketplace protocol** — the source types, the
 * plugin manifest, the frontmatter, the catalogue, and the autoupdater.
 *
 * Evidence: `chunk-c9s0jh80.js:105243` (the marketplace source schema),
 * `:116671` (the plugin source schema), `:124812` and `:120783` (the catalogue
 * entries), `:128721` (the marketplace manifest), `:102436` (the plugin manifest),
 * `chunk-4jsg44k7.js:4156876` (`K1`), `:4155409` (`HPt`), `:4481234` (`iss`),
 * `:724143`/`:725756`/`:728221`/`:730964`/`:731474` (the frontmatter schemas),
 * `chunk-wqmf3c8h.js:2646` (the autoupdater), `chunk-4420d0hq.js:102585` (the
 * update operation), and the record at
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-marketplace.md`.
 */

import { describe, expect, it } from 'vitest';

import {
  MARKETPLACE_SOURCE_TYPES,
  MARKETPLACE_POLICY_SOURCE_TYPES,
  describeMarketplaceSource,
  formatMarketplaceSource,
  marketplaceSourceCapability,
  marketplaceSourceType,
  resolveMarketplaceSource,
  type MarketplaceSource,
} from '../../src/extensions/plugins/marketplaceSources.js';
import {
  PLUGIN_SOURCE_KINDS,
  PLUGIN_SOURCE_TYPES,
  describePluginSource,
  pluginSourceCapability,
  pluginSourceKind,
  resolvePluginSource,
} from '../../src/extensions/plugins/pluginSources.js';
import {
  MARKETPLACE_MANIFEST_KEYS,
  parseMarketplaceManifest,
} from '../../src/extensions/plugins/catalogue.js';
import {
  PLUGIN_MANIFEST_KEYS,
  PLUGIN_MANIFEST_KEY_SPECS,
  validatePluginManifest,
} from '../../src/extensions/plugins/manifestSchema.js';
import {
  AGENT_FRONTMATTER_KEYS,
  OUTPUT_STYLE_FRONTMATTER_KEYS,
  SKILL_FRONTMATTER_KEYS,
  validateFrontmatter,
} from '../../src/extensions/plugins/frontmatterSchema.js';
import {
  AUTOUPDATE_BLOCK_TYPES,
  AUTOUPDATE_FAILURE_CODES,
  AUTOUPDATE_SKIP_REASONS,
  classifyAutoupdate,
  pluginUpdateOperationOf,
} from '../../src/extensions/plugins/autoupdate.js';

/* -------------------------------------------------------------------------- */
/* The marketplace source types                                                 */
/* -------------------------------------------------------------------------- */

describe('the marketplace source types', () => {
  it('carries the target\'s ten declarable types, in the target\'s order', () => {
    expect([...MARKETPLACE_SOURCE_TYPES]).toEqual([
      'url',
      'github',
      'git',
      'npm',
      'file',
      'directory',
      'skills-dir',
      'hostPattern',
      'pathPattern',
      'settings',
    ]);
  });

  it('adds the built-in directory to the policy list, and only there', () => {
    expect(MARKETPLACE_POLICY_SOURCE_TYPES).toHaveLength(MARKETPLACE_SOURCE_TYPES.length + 1);
    expect(MARKETPLACE_POLICY_SOURCE_TYPES[0]).toBe('pluginDirectory');
    expect(MARKETPLACE_SOURCE_TYPES).not.toContain('pluginDirectory');
  });

  it('discriminates a source by its own `source` key', () => {
    expect(marketplaceSourceType({ source: 'github', repo: 'a/b' })).toBe('github');
    expect(marketplaceSourceType({ source: 'not-a-source' })).toBeUndefined();
    expect(marketplaceSourceType('github')).toBeUndefined();
    expect(marketplaceSourceType(undefined)).toBeUndefined();
  });

  it('never resolves a key to an inherited member', () => {
    // `constructor` is on Object.prototype; a source must not be read from it.
    expect(marketplaceSourceType({ source: 'constructor' })).toBeUndefined();
    expect(marketplaceSourceType({ source: 'toString' })).toBeUndefined();
  });
});

describe('the canonical form of a marketplace source', () => {
  it('is the target\'s form for every declarable type', () => {
    expect(formatMarketplaceSource({ source: 'github', repo: 'owner/repo' })).toBe('github:owner/repo');
    expect(formatMarketplaceSource({ source: 'github', repo: 'owner/repo', ref: 'v1' })).toBe(
      'github:owner/repo@v1',
    );
    expect(formatMarketplaceSource({ source: 'url', url: 'https://example.test/m.json' })).toBe(
      'https://example.test/m.json',
    );
    expect(formatMarketplaceSource({ source: 'git', url: 'https://example.test/r.git' })).toBe(
      'git:https://example.test/r.git',
    );
    expect(formatMarketplaceSource({ source: 'git', url: 'https://example.test/r.git', ref: 'main' })).toBe(
      'git:https://example.test/r.git@main',
    );
    expect(formatMarketplaceSource({ source: 'npm', package: '@acme/market' })).toBe('npm:@acme/market');
    expect(formatMarketplaceSource({ source: 'file', path: '/tmp/m.json' })).toBe('file:/tmp/m.json');
    expect(formatMarketplaceSource({ source: 'directory', path: '/tmp/market' })).toBe('dir:/tmp/market');
    expect(formatMarketplaceSource({ source: 'hostPattern', hostPattern: '^github\\.corp$' })).toBe(
      'hostPattern:^github\\.corp$',
    );
    expect(formatMarketplaceSource({ source: 'pathPattern', pathPattern: '^/opt/' })).toBe(
      'pathPattern:^/opt/',
    );
    expect(formatMarketplaceSource({ source: 'skills-dir' })).toBe('skills-dir');
  });

  it('counts the plugins of a settings source', () => {
    const one: MarketplaceSource = { source: 'settings', name: 'team', plugins: [] };
    const two: MarketplaceSource = { source: 'settings', name: 'team', plugins: [oneEntry()] };
    expect(formatMarketplaceSource(one)).toBe('settings:team (0 plugins)');
    expect(formatMarketplaceSource(two)).toBe('settings:team (1 plugin)');
  });

  it('has a form for the runtime-only sources', () => {
    expect(formatMarketplaceSource({ source: 'claudeai' })).toBe('claude.ai');
    expect(formatMarketplaceSource({ source: 'pluginDirectory' })).toBe('Anthropic Directory');
  });

  it('falls back to "unknown source" for a source it does not know', () => {
    expect(formatMarketplaceSource(unknownSource())).toBe('unknown source');
  });
});

describe('the description of a marketplace source', () => {
  it('is the target\'s description for the types the target describes', () => {
    expect(describeMarketplaceSource({ source: 'github', repo: 'owner/repo' })).toBe('owner/repo');
    expect(describeMarketplaceSource({ source: 'file', path: '/tmp/m.json' })).toBe('/tmp/m.json');
    expect(describeMarketplaceSource({ source: 'directory', path: '/tmp/market' })).toBe('/tmp/market');
    expect(describeMarketplaceSource({ source: 'settings', name: 'team', plugins: [] })).toBe(
      'settings:team',
    );
    expect(describeMarketplaceSource({ source: 'claudeai' })).toBe('claude.ai');
    expect(describeMarketplaceSource({ source: 'pluginDirectory' })).toBe('Built in');
  });

  it('is "Unknown source" for the types the target does not describe', () => {
    expect(describeMarketplaceSource({ source: 'npm', package: 'p' })).toBe('Unknown source');
    expect(describeMarketplaceSource({ source: 'skills-dir' })).toBe('Unknown source');
    expect(describeMarketplaceSource({ source: 'hostPattern', hostPattern: 'x' })).toBe(
      'Unknown source',
    );
    expect(describeMarketplaceSource({ source: 'pathPattern', pathPattern: 'x' })).toBe(
      'Unknown source',
    );
  });
});

describe('a marketplace source that is resolved', () => {
  it('names the capability a source needs when it is refused', () => {
    const git = resolveMarketplaceSource({ source: 'github', repo: 'owner/repo' });
    expect(git.ok).toBe(false);
    if (git.ok) throw new Error('unreachable');
    expect(git.capability).toBe('git-clone');
    expect(git.reason).toContain('git-clone');

    const npm = resolveMarketplaceSource({ source: 'npm', package: '@acme/market' });
    expect(npm.ok).toBe(false);
    if (npm.ok) throw new Error('unreachable');
    expect(npm.capability).toBe('npm-registry');
    expect(npm.reason).toContain('not yet implemented');
  });

  it('refuses every source it cannot reach, and names the capability', () => {
    for (const source of [
      { source: 'url', url: 'https://example.test/m.json' },
      { source: 'github', repo: 'owner/repo' },
      { source: 'git', url: 'https://example.test/r.git' },
      { source: 'npm', package: 'p' },
      { source: 'file', path: '/tmp/m.json' },
      { source: 'directory', path: '/tmp/market' },
    ] as const) {
      const result = resolveMarketplaceSource(source);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.capability).toBeTruthy();
      expect(result.reason).toContain(result.capability);
    }
  });

  it('names the capability of every source type', () => {
    expect(marketplaceSourceCapability({ source: 'url', url: 'u' })).toBe('http-fetch');
    expect(marketplaceSourceCapability({ source: 'github', repo: 'r' })).toBe('git-clone');
    expect(marketplaceSourceCapability({ source: 'git', url: 'u' })).toBe('git-clone');
    expect(marketplaceSourceCapability({ source: 'npm', package: 'p' })).toBe('npm-registry');
    expect(marketplaceSourceCapability({ source: 'file', path: 'p' })).toBe('filesystem');
    expect(marketplaceSourceCapability({ source: 'directory', path: 'p' })).toBe('filesystem');
    expect(marketplaceSourceCapability({ source: 'skills-dir' })).toBe('skills-directory');
    expect(marketplaceSourceCapability({ source: 'hostPattern', hostPattern: 'x' })).toBe('policy-list');
    expect(marketplaceSourceCapability({ source: 'pathPattern', pathPattern: 'x' })).toBe('policy-list');
    expect(marketplaceSourceCapability({ source: 'settings', name: 'n', plugins: [] })).toBe(
      'settings-file',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The plugin source types                                                     */
/* -------------------------------------------------------------------------- */

describe('the plugin source types', () => {
  it('carries the target\'s seven named types and the placeholder', () => {
    expect([...PLUGIN_SOURCE_TYPES]).toEqual([
      'npm',
      'url',
      'github',
      'git-subdir',
      'archive',
      'command',
      'unsupported',
    ]);
  });

  it('canonicalises a source into the target\'s eight kinds', () => {
    expect([...PLUGIN_SOURCE_KINDS]).toEqual([
      'local',
      'npm',
      'github',
      'git',
      'subdir',
      'archive',
      'command',
      'unknown',
    ]);
    expect(pluginSourceKind('./plugins/one')).toBe('local');
    expect(pluginSourceKind({ source: 'npm', package: 'p' })).toBe('npm');
    expect(pluginSourceKind({ source: 'github', repo: 'a/b' })).toBe('github');
    expect(pluginSourceKind({ source: 'url', url: 'u' })).toBe('git');
    expect(pluginSourceKind({ source: 'git-subdir', url: 'u', path: 'p' })).toBe('subdir');
    expect(pluginSourceKind({ source: 'archive', url: 'https://x.test/a.zip' })).toBe('archive');
    expect(pluginSourceKind({ source: 'command', command: 'c' })).toBe('command');
    expect(pluginSourceKind({ source: 'not-a-source' } as unknown as Parameters<typeof pluginSourceKind>[0])).toBe('unknown');
  });

  it('names the capability a plugin source needs', () => {
    expect(pluginSourceCapability('./plugins/one')).toBe('filesystem');
    expect(pluginSourceCapability({ source: 'npm', package: 'p' })).toBe('npm-registry');
    expect(pluginSourceCapability({ source: 'url', url: 'u' })).toBe('git-clone');
    expect(pluginSourceCapability({ source: 'github', repo: 'a/b' })).toBe('git-clone');
    expect(pluginSourceCapability({ source: 'git-subdir', url: 'u', path: 'p' })).toBe(
      'sparse-git-clone',
    );
    expect(pluginSourceCapability({ source: 'archive', url: 'https://x.test/a.zip' })).toBe(
      'https-archive',
    );
    expect(pluginSourceCapability({ source: 'command', command: 'c' })).toBe('command-runner');
    expect(pluginSourceCapability({ source: 'unsupported' })).toBe('unsupported-source');
  });

  it('describes a plugin source', () => {
    expect(describePluginSource('./plugins/one')).toBe('./plugins/one');
    expect(describePluginSource({ source: 'github', repo: 'a/b' })).toBe('github:a/b');
    expect(describePluginSource({ source: 'unsupported', error: 'why' })).toBe('unsupported: why');
  });

  it('refuses to install a plugin, and names the capability it needs', () => {
    const archive = resolvePluginSource({ source: 'archive', url: 'https://x.test/a.zip' });
    expect(archive.ok).toBe(false);
    if (archive.ok) throw new Error('unreachable');
    expect(archive.capability).toBe('https-archive');
    expect(archive.reason).toContain('https-archive');

    const local = resolvePluginSource('./plugins/one');
    expect(local.ok).toBe(false);
    if (local.ok) throw new Error('unreachable');
    expect(local.capability).toBe('filesystem');
    expect(local.reason).toContain('filesystem');
  });
});

/* -------------------------------------------------------------------------- */
/* The catalogue                                                               */
/* -------------------------------------------------------------------------- */

describe('the marketplace manifest', () => {
  it('carries the target\'s ten keys', () => {
    expect([...MARKETPLACE_MANIFEST_KEYS]).toEqual([
      '$schema',
      'name',
      'version',
      'description',
      'owner',
      'plugins',
      'forceRemoveDeletedPlugins',
      'metadata',
      'allowCrossMarketplaceDependenciesOn',
      'renames',
    ]);
  });

  it('reads a manifest with its owner and its plugins', () => {
    const parsed = parseMarketplaceManifest({
      name: 'team-market',
      owner: { name: 'The Team' },
      plugins: [{ name: 'one', source: { source: 'github', repo: 'a/b' } }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.manifest?.name).toBe('team-market');
    expect(parsed.manifest?.owner.name).toBe('The Team');
    expect(parsed.manifest?.plugins).toHaveLength(1);
    expect(parsed.manifest?.plugins[0]?.name).toBe('one');
  });

  it('refuses a manifest that is not an object', () => {
    const parsed = parseMarketplaceManifest('not a manifest');
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBeTruthy();
  });

  it('refuses a manifest with no name, and one with no owner', () => {
    expect(parseMarketplaceManifest({ owner: { name: 'x' } }).ok).toBe(false);
    expect(parseMarketplaceManifest({ name: 'x' }).ok).toBe(false);
  });

  it('stubs an entry it cannot parse, and keeps the entry', () => {
    const parsed = parseMarketplaceManifest({
      name: 'team-market',
      owner: { name: 'The Team' },
      plugins: [{ name: 'one', source: { source: 'not-a-source' } }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    const entry = parsed.manifest?.plugins[0];
    expect(entry?.name).toBe('one');
    expect(entry?.source).toEqual({ source: 'unsupported' });
  });

  it('drops an entry it cannot parse when the entry has no name', () => {
    const parsed = parseMarketplaceManifest({
      name: 'team-market',
      owner: { name: 'The Team' },
      plugins: [{ source: { source: 'not-a-source' } }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.manifest?.plugins).toHaveLength(0);
    expect(parsed.problems.length).toBeGreaterThan(0);
  });

  it('carries the renames map, and drops a malformed one', () => {
    const parsed = parseMarketplaceManifest({
      name: 'team-market',
      owner: { name: 'The Team' },
      plugins: [],
      renames: { old: 'new', gone: null },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.manifest?.renames).toEqual({ old: 'new', gone: null });

    const malformed = parseMarketplaceManifest({
      name: 'team-market',
      owner: { name: 'The Team' },
      plugins: [],
      renames: 'not a map',
    });
    expect(malformed.ok).toBe(true);
    if (!malformed.ok) throw new Error('unreachable');
    expect(malformed.manifest?.renames).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* The plugin manifest                                                         */
/* -------------------------------------------------------------------------- */

describe('the plugin manifest', () => {
  it('carries the target\'s twenty-nine keys', () => {
    expect(PLUGIN_MANIFEST_KEYS).toHaveLength(29);
    expect(PLUGIN_MANIFEST_KEYS).toContain('name');
    expect(PLUGIN_MANIFEST_KEYS).toContain('defaultEnabled');
    expect(PLUGIN_MANIFEST_KEYS).toContain('commands');
    expect(PLUGIN_MANIFEST_KEYS).toContain('mcpServers');
    expect(PLUGIN_MANIFEST_KEYS).toContain('userConfig');
    expect(PLUGIN_MANIFEST_KEYS).toContain('experimental');
  });

  it('makes the name the only required key', () => {
    const required = PLUGIN_MANIFEST_KEY_SPECS.filter((spec) => spec.required);
    expect(required.map((spec) => spec.key)).toEqual(['name']);
  });

  it('gives defaultEnabled the target\'s default', () => {
    const spec = PLUGIN_MANIFEST_KEY_SPECS.find((entry) => entry.key === 'defaultEnabled');
    expect(spec?.default).toBe('true');
  });

  it('accepts a manifest that carries only its name', () => {
    const result = validatePluginManifest({ name: 'my-plugin' });
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it('refuses a manifest with no name', () => {
    const result = validatePluginManifest({ description: 'no name' });
    expect(result.ok).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it('refuses a name that carries a space', () => {
    const result = validatePluginManifest({ name: 'my plugin' });
    expect(result.ok).toBe(false);
  });

  it('reports a key it does not know', () => {
    const result = validatePluginManifest({ name: 'my-plugin', notAKey: 1 });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('notAKey');
  });

  it('refuses a key whose type is wrong', () => {
    const result = validatePluginManifest({ name: 'my-plugin', version: 3 });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('version');
  });

  it('reads the keys the target declares', () => {
    const result = validatePluginManifest({
      name: 'my-plugin',
      version: '1.0.0',
      description: 'A plugin',
      keywords: ['one', 'two'],
      defaultEnabled: false,
      dependencies: ['other'],
      commands: './commands',
      agents: ['./agents'],
      skills: './skills',
      mcpServers: './.mcp.json',
      experimental: { evals: 'evals' },
    });
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The frontmatter                                                             */
/* -------------------------------------------------------------------------- */

describe('the frontmatter', () => {
  it('carries the target\'s key sets', () => {
    expect(SKILL_FRONTMATTER_KEYS).toHaveLength(42);
    expect(AGENT_FRONTMATTER_KEYS).toHaveLength(22);
    expect(OUTPUT_STYLE_FRONTMATTER_KEYS).toHaveLength(4);
    expect(OUTPUT_STYLE_FRONTMATTER_KEYS.map((spec) => spec.key)).toEqual([
      'name',
      'description',
      'keep-coding-instructions',
      'force-for-plugin',
    ]);
  });

  it('accepts a frontmatter whose keys the schema declares', () => {
    const result = validateFrontmatter('skill', { name: 'one', description: 'Two' });
    expect(result.ok).toBe(true);
    expect(result.unknownKeys).toEqual([]);
  });

  it('refuses a key the schema does not declare', () => {
    const result = validateFrontmatter('skill', { name: 'one', notAKey: 1 });
    expect(result.ok).toBe(false);
    expect(result.unknownKeys).toEqual(['notAKey']);
  });

  it('gives the output-style frontmatter its four keys only', () => {
    const result = validateFrontmatter('output-style', { name: 'one', allowedTools: 'Bash' });
    expect(result.ok).toBe(false);
    expect(result.unknownKeys).toEqual(['allowedTools']);
  });

  it('refuses an agent frontmatter with no name', () => {
    const result = validateFrontmatter('agent', { description: 'Two' });
    expect(result.ok).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The autoupdater                                                             */
/* -------------------------------------------------------------------------- */

describe('the plugin autoupdater', () => {
  it('carries the target\'s skip reasons', () => {
    expect([...AUTOUPDATE_SKIP_REASONS]).toEqual([
      'pinner_blocked',
      'entry_helper_deferred',
      'snapshot_file_refused',
    ]);
  });

  it('carries the target\'s block types', () => {
    expect([...AUTOUPDATE_BLOCK_TYPES]).toEqual([
      'autoupdate-deferred-entry-helper',
      'autoupdate-blocked-by-pinner',
      'autoupdate-disabled-by-policy',
      'generic-error',
    ]);
  });

  it('carries the failure codes the plugin surface raises', () => {
    expect(AUTOUPDATE_FAILURE_CODES).toContain('not_found');
    expect(AUTOUPDATE_FAILURE_CODES).toContain('not_cached');
    expect(AUTOUPDATE_FAILURE_CODES).toContain('plugin_policy_blocked');
    expect(AUTOUPDATE_FAILURE_CODES).toContain('command_source_refused');
    expect(AUTOUPDATE_FAILURE_CODES).toContain('command_source_inactive');
    expect(AUTOUPDATE_FAILURE_CODES).toContain('entry_helper_organization_unanswered');
    expect(AUTOUPDATE_FAILURE_CODES).toContain('entry_helper_not_inlined');
  });

  it('reports an update as updated', () => {
    const result = classifyAutoupdate({
      outcome: 'updated',
      pluginId: 'one@market',
      oldVersion: '1.0.0',
      newVersion: '1.1.0',
    });
    expect(result.updated).toBe('one@market');
    expect(result.failed).toBe(false);
    expect(result.blocked).toBeUndefined();
  });

  it('defers a headersHelper update', () => {
    const result = classifyAutoupdate({
      outcome: 'skipped',
      pluginId: 'one@market',
      oldVersion: '1.0.0',
      skipReason: 'entry_helper_deferred',
      message: 'Skipped',
    });
    expect(result.blocked?.type).toBe('autoupdate-deferred-entry-helper');
    expect(result.failed).toBe(false);
  });

  it('reports a pin that blocks the update', () => {
    const result = classifyAutoupdate({
      outcome: 'skipped',
      pluginId: 'one@market',
      oldVersion: '1.0.0',
      skipReason: 'pinner_blocked',
      message: 'Skipped',
      blockedBy: ['other@market'],
    });
    expect(result.blocked?.type).toBe('autoupdate-blocked-by-pinner');
    if (result.blocked?.type !== 'autoupdate-blocked-by-pinner') throw new Error('unreachable');
    expect(result.blocked.heldAt).toBe('1.0.0');
    expect(result.blocked.blockedBy).toEqual(['other']);
  });

  it('reports a policy refusal as disabled by policy', () => {
    const result = classifyAutoupdate({
      outcome: 'failed',
      pluginId: 'one@market',
      message: 'blocked',
      failureCode: 'plugin_policy_blocked',
    });
    expect(result.blocked?.type).toBe('autoupdate-disabled-by-policy');
    expect(result.failed).toBe(false);
  });

  it('reports an ordinary failure as failed', () => {
    const result = classifyAutoupdate({
      outcome: 'failed',
      pluginId: 'one@market',
      message: 'boom',
      failureCode: 'not_found',
    });
    expect(result.failed).toBe(true);
    expect(result.blocked).toBeUndefined();
    expect(result.notFound).toBe(true);
  });

  it('reports an up-to-date plugin as nothing', () => {
    const result = classifyAutoupdate({
      outcome: 'up_to_date',
      pluginId: 'one@market',
      oldVersion: '1.0.0',
      newVersion: '1.0.0',
    });
    expect(result.updated).toBeUndefined();
    expect(result.failed).toBe(false);
    expect(result.blocked).toBeUndefined();
  });

  it('reads an update result out of a caller-supplied record', () => {
    const operation = pluginUpdateOperationOf({
      outcome: 'skipped',
      pluginId: 'one@market',
      oldVersion: '1.0.0',
      skipReason: 'pinner_blocked',
      blockedBy: ['other@market'],
    });
    expect(operation?.outcome).toBe('skipped');
    expect(operation?.skipReason).toBe('pinner_blocked');
    expect(operation?.blockedBy).toEqual(['other@market']);
  });

  it('reads no update result out of a record that names no outcome', () => {
    expect(pluginUpdateOperationOf({ pluginId: 'one@market' })).toBeUndefined();
    expect(pluginUpdateOperationOf({ outcome: 'not-an-outcome' })).toBeUndefined();
    expect(pluginUpdateOperationOf('not a record')).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* A helper                                                                     */
/* -------------------------------------------------------------------------- */

/** A source the target does not know. */
function unknownSource(): MarketplaceSource {
  return { source: 'not-a-source' } as unknown as MarketplaceSource;
}

function oneEntry(): {
  name: string;
  source: { source: 'github'; repo: string };
} {
  return { name: 'one', source: { source: 'github', repo: 'a/b' } };
}

/**
 * The plugin manager: loading a plugin from disk, and installing one from a
 * marketplace.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 and the `CC-013`
 * milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## What a plugin is
 *
 * A plugin is a directory. Its **manifest** declares its content (see
 * `./manifest.ts`), and a plugin is **`ok`** when a **`SKILL.md` exists at the
 * plugin root**. A manifest that is not a JSON object makes the plugin
 * **`broken`** with the reason *"it is not a JSON object"*.
 *
 * ## Implementation choices (the audit does not pin them)
 *
 *   - The **manifest candidates** are `.claude-plugin/plugin.json` and
 *     `plugin.json`, tried in that order; the first that exists is the
 *     manifest.
 *   - A manifest that **cannot be parsed as JSON** makes the plugin broken with
 *     the reason `it is not valid JSON`; a plugin with **no manifest at all**
 *     is broken with the reason `it has no plugin manifest`.
 *   - The **command bodies** of every plugin share one interner, so identical
 *     bodies are stored once across the whole session.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import type { SkillContribution } from '../skills/registry.js';
import { isSafeLookupName } from '../skills/source.js';
import type { SubagentContribution } from '../subagents/registry.js';
import type { DiscoverySource } from '../skills/source.js';

import {
  SkillBodyInterner,
  discoverPluginCommands,
  type PluginCommand,
  type PluginCommandMetadata,
} from './commands.js';
import {
  PLUGIN_MANIFEST_CANDIDATES,
  PLUGIN_MISSING_MANIFEST_REASON,
  PLUGIN_MISSING_SKILL_REASON,
  parsePluginManifest,
  type PluginManifest,
} from './manifest.js';
import {
  installPluginFromMarketplace,
  type PluginInstallRecord,
  type PluginInstallRequest,
  type PluginInstallResult,
  type PluginLogRecord,
} from './marketplace.js';

export type {
  PluginInstallRecord,
  PluginInstallRequest,
  PluginInstallResult,
  PluginLogRecord,
} from './marketplace.js';
export type { PluginCommand, PluginCommandMetadata } from './commands.js';
export type { PluginManifest } from './manifest.js';

/** The reason a manifest that cannot be parsed makes a plugin broken. */
export const PLUGIN_MANIFEST_INVALID_JSON_REASON = 'it is not valid JSON';

/** A plugin the manager holds. */
export interface PluginRecord {
  /** The plugin's name. */
  name: string;
  /** The plugin's root directory. */
  root: string;
  /** Whether the plugin is usable. */
  status: 'ok' | 'broken';
  /** Why the plugin is broken, when it is. */
  reason?: string;
  /** Where the plugin came from. */
  source: DiscoverySource;
  /** The plugin's manifest, when it has one. */
  manifest?: PluginManifest;
  /** The path of the manifest, when there is one. */
  manifestPath?: string;
  /** The plugin's version, when the manifest declares one. */
  version?: string;
}

/** What a plugin contributes to a session. */
export interface PluginApplication {
  /** The plugin's name. */
  plugin: string;
  /** The commands the plugin contributes. */
  commands: readonly PluginCommand[];
  /** The skills the plugin contributes. */
  skills: readonly SkillContribution[];
  /** The subagents the plugin contributes. */
  agents: readonly SubagentContribution[];
}

/** The plugin manager. */
export interface PluginManager {
  /** Every plugin the manager holds. */
  list(): readonly PluginRecord[];
  /** The plugin with that name, or `undefined` when there is none. */
  resolve(name: string): PluginRecord | undefined;
  /** The plugins discovered under the plugins root. */
  discover(): readonly { name: string; source: DiscoverySource; path: string }[];
  /** Load the plugin rooted at a directory. */
  load(root: string): PluginRecord;
  /** The commands a plugin contributes. */
  commands(plugin: string): PluginCommand[];
  /** The skills the plugins contribute. */
  skills(): SkillContribution[];
  /** The subagents the plugins contribute. */
  agents(): SubagentContribution[];
  /** Everything a plugin contributes. */
  apply(plugin: string): PluginApplication;
  /** Install a plugin from a marketplace. */
  installFromMarketplace(request: PluginInstallRequest): Promise<PluginInstallResult>;
  /** The records the installs left behind. */
  installations(): readonly PluginInstallRecord[];
  /** The log records the manager raised. */
  logs(): readonly PluginLogRecord[];
}

/** The options a plugin manager is created with. */
export interface PluginManagerOptions {
  /** The directory the installed plugins live in. */
  pluginsRoot?: string;
  /** The interner the command bodies go into. */
  interner?: SkillBodyInterner;
  /** The logger every record is also sent to. */
  logger?: (record: PluginLogRecord) => void;
}

function isDirectory(candidatePath: string): boolean {
  try {
    return statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Find the manifest a plugin presents.
 *
 * The candidates are tried in order; the first that exists is the manifest.
 */
export function findPluginManifest(root: string): string | undefined {
  for (const candidate of PLUGIN_MANIFEST_CANDIDATES) {
    const manifestPath = path.join(root, candidate);
    if (existsSync(manifestPath)) return manifestPath;
  }
  return undefined;
}

/**
 * Create a plugin manager.
 */
export function createPluginManager(options: PluginManagerOptions = {}): PluginManager {
  const plugins = new Map<string, PluginRecord>();
  const interner = options.interner ?? new SkillBodyInterner();
  const logs: PluginLogRecord[] = [];
  const installations: PluginInstallRecord[] = [];

  const record = (log: PluginLogRecord): void => {
    logs.push(log);
    options.logger?.(log);
  };

  const load = (root: string): PluginRecord => {
    const manifestPath = findPluginManifest(root);

    if (manifestPath === undefined) {
      const broken: PluginRecord = {
        name: path.basename(root),
        root,
        status: 'broken',
        reason: PLUGIN_MISSING_MANIFEST_REASON,
        source: 'plugin',
      };
      plugins.set(broken.name, broken);
      return broken;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      const broken: PluginRecord = {
        name: path.basename(root),
        root,
        status: 'broken',
        reason: PLUGIN_MANIFEST_INVALID_JSON_REASON,
        source: 'plugin',
        manifestPath,
      };
      plugins.set(broken.name, broken);
      return broken;
    }

    const parsed = parsePluginManifest(raw, manifestPath);

    if (!parsed.ok || !parsed.manifest) {
      const broken: PluginRecord = {
        name: path.basename(root),
        root,
        status: 'broken',
        reason: parsed.reason ?? PLUGIN_MISSING_MANIFEST_REASON,
        source: 'plugin',
        manifestPath,
      };
      plugins.set(broken.name, broken);
      return broken;
    }

    const manifest = parsed.manifest;
    const name = manifest.name ?? path.basename(root);
    const hasRootSkill = existsSync(path.join(root, 'SKILL.md'));

    const plugin: PluginRecord = {
      name,
      root,
      status: hasRootSkill ? 'ok' : 'broken',
      ...(hasRootSkill ? {} : { reason: PLUGIN_MISSING_SKILL_REASON }),
      source: 'plugin',
      manifest,
      manifestPath,
      ...(manifest.version === undefined ? {} : { version: manifest.version }),
    };

    plugins.set(name, plugin);
    return plugin;
  };

  const metadataOf = (plugin: PluginRecord): Record<string, PluginCommandMetadata> => {
    const metadata: Record<string, PluginCommandMetadata> = {};
    for (const entry of plugin.manifest?.commands ?? []) {
      if (!Object.hasOwn(metadata, entry.key)) {
        Object.defineProperty(metadata, entry.key, {
          value: {
            ...(entry.source === undefined ? {} : { source: entry.source }),
            ...(entry.content === undefined ? {} : { content: entry.content }),
          },
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    return metadata;
  };

  const commandsOf = (plugin: PluginRecord): PluginCommand[] => {
    const paths = plugin.manifest?.directories['commands'] ?? [];
    const discovery = discoverPluginCommands({
      plugin: plugin.name,
      root: plugin.root,
      commandsPaths: paths,
      commandsMetadata: metadataOf(plugin),
      interner,
    });
    for (const warning of discovery.warnings) {
      record({ level: 'warn', message: warning });
    }
    return discovery.commands;
  };

  const skillsOf = (plugin: PluginRecord): SkillContribution[] => {
    const contributions: SkillContribution[] = [];
    for (const declared of plugin.manifest?.directories['skills'] ?? []) {
      const skillsDir = path.resolve(plugin.root, declared);
      if (!isDirectory(skillsDir)) continue;
      let entries: string[] = [];
      try {
        entries = readdirSync(skillsDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const skillFile = path.join(skillsDir, entry, 'SKILL.md');
        if (!existsSync(skillFile)) continue;
        contributions.push({
          name: entry,
          source: 'plugin',
          path: skillFile,
          provider: plugin.name,
        });
      }
    }
    return contributions;
  };

  const agentsOf = (plugin: PluginRecord): SubagentContribution[] => {
    const contributions: SubagentContribution[] = [];
    for (const declared of plugin.manifest?.directories['agents'] ?? []) {
      const agentsDir = path.resolve(plugin.root, declared);
      if (!isDirectory(agentsDir)) continue;
      let entries: string[] = [];
      try {
        entries = readdirSync(agentsDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const agentFile = path.join(agentsDir, entry);
        if (!existsSync(agentFile)) continue;
        contributions.push({
          name: entry.slice(0, -'.md'.length),
          source: 'plugin',
          path: agentFile,
          provider: plugin.name,
        });
      }
    }
    return contributions;
  };

  const pluginsRoot = options.pluginsRoot;

  return {
    list(): readonly PluginRecord[] {
      return [...plugins.values()];
    },
    resolve(name: string): PluginRecord | undefined {
      // A plugin name is caller-supplied data, so it never resolves an
      // inherited member of `Object.prototype`.
      if (!isSafeLookupName(name)) return undefined;
      return plugins.get(name);
    },
    discover(): readonly { name: string; source: DiscoverySource; path: string }[] {
      if (pluginsRoot === undefined) return [];
      let entries: string[] = [];
      try {
        entries = readdirSync(pluginsRoot);
      } catch {
        return [];
      }
      return entries
        .filter((entry) => isDirectory(path.join(pluginsRoot, entry)))
        .map((entry) => ({
          name: entry,
          source: 'plugin' as DiscoverySource,
          path: path.join(pluginsRoot, entry),
        }));
    },
    load(root: string): PluginRecord {
      return load(root);
    },
    commands(plugin: string): PluginCommand[] {
      const record_ = plugins.get(plugin);
      if (!record_) return [];
      return commandsOf(record_);
    },
    skills(): SkillContribution[] {
      return [...plugins.values()].flatMap((plugin) => skillsOf(plugin));
    },
    agents(): SubagentContribution[] {
      return [...plugins.values()].flatMap((plugin) => agentsOf(plugin));
    },
    apply(plugin: string): PluginApplication {
      const found = plugins.get(plugin);
      return {
        plugin,
        commands: found ? commandsOf(found) : [],
        skills: found ? skillsOf(found) : [],
        agents: found ? agentsOf(found) : [],
      };
    },
    async installFromMarketplace(
      request: PluginInstallRequest,
    ): Promise<PluginInstallResult> {
      const outcome = installPluginFromMarketplace(request);
      for (const log of outcome.logs) record(log);
      if (outcome.record) installations.push(outcome.record);
      return outcome.result;
    },
    installations(): readonly PluginInstallRecord[] {
      return [...installations];
    },
    logs(): readonly PluginLogRecord[] {
      return [...logs];
    },
  };
}

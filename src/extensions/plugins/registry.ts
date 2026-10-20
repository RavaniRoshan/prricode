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
 *   - The **path boundary**: every path a manifest declares is resolved
 *     against the plugin root and **refused** when it leaves it — the lexical
 *     escape and the symlink escape alike. The rule, its named reasons and its
 *     implementation-choice status live in `./manifest.ts`; this module applies it when
 *     a plugin is loaded, so a refused path is dropped from the manifest the
 *     record holds, and again when a command, a skill or an agent is read.
 *     A refused path is **reported twice**: as a problem on the manifest the
 *     record holds — so the record is self-describing — and as a log record.
 *   - A declared path that **does not exist** is **reported** the same way
 *     for every key: a log record and a problem on the manifest the record
 *     holds. The path itself is **kept** — a plugin may ship its content
 *     after it is loaded — but it is never dropped **silently**: before this,
 *     a declared `skills` or `agents` path that was not there was dropped
 *     without a word, while the `commands` key reported *"it does not
 *     exist"*. The `commands` key is reported **twice** now: once here, at
 *     load time, and once by the command discovery, which names the resolved
 *     path at the point the commands are read.
 *   - A **collision** between two plugins that provide a skill — or a
 *     subagent — under the same name is **reported**, not dropped silently:
 *     the manager logs a warning naming the providers, and the resolved
 *     record carries the other providers in `collidesWith`. The names stay
 *     **un-namespaced**: a plugin's skill is named after the skill directory
 *     inside the plugin's own skills directory (and a plugin's subagent after
 *     its file's basename), and the plugin's name does not become a prefix.
 *
 *     A collision is one of **two** situations, and the report says which:
 *     two **different** plugins providing the name is a **conflict** between
 *     them, while **one** plugin providing it twice — two `skills`
 *     directories in one plugin, say — is a **packaging bug**, and it is
 *     reported with the two paths rather than as a conflict. The resolved
 *     record's `collidesWith` names the **other** provider, never the
 *     winner's own, and is empty for the packaging bug.
 *
 *     The `apply()` path reports the collision too, and a plugin that
 *     provides a name twice contributes it **once**: the first path wins,
 *     exactly as the registry's precedence picks the first declared
 *     contribution.
 *
 *     The justification is this implementation's **no-silent-drop** rule: nothing the
 *     extension surface resolves is dropped without a report — a malformed
 *     frontmatter is surfaced, a refused path is reported, an over-limit file
 *     is surfaced. §2.8 says **nothing** about how a plugin's skill is
 *     named, and nothing about what happens when two plugins ship the same
 *     name, so both the naming and the collision handling are this implementation's
 *     choices; the audit is cited for neither.
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
  PLUGIN_DIRECTORY_KEYS,
  PLUGIN_FILE_KEYS,
  PLUGIN_MANIFEST_CANDIDATES,
  PLUGIN_MISSING_MANIFEST_REASON,
  PLUGIN_MISSING_SKILL_REASON,
  parsePluginManifest,
  resolvePluginPath,
  type PluginDirectoryKey,
  type PluginFileKey,
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
  /**
   * The skills the plugin contributes.
   *
   * A plugin that provides the same skill name twice contributes it **once**
   * — the first path wins — and the duplication is reported.
   */
  skills: readonly SkillContribution[];
  /**
   * The subagents the plugin contributes.
   *
   * A plugin that provides the same subagent name twice contributes it
   * **once** — the first path wins — and the duplication is reported.
   */
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
  /**
   * Everything a plugin contributes.
   *
   * A name the plugin provides twice is reported — the duplication is a
   * packaging bug, not a conflict between two providers — and the plugin
   * contributes it **once**: the first path wins.
   */
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
 * The first contribution of each name, in declaration order.
 *
 * A name is caller-supplied data — it is a directory name in a plugin — so
 * the names are kept in a `Set` rather than in a plain object, and the
 * **first** contribution of a name wins: the same precedence the registries
 * resolve a contributed name with.
 */
function firstByName<T extends { name: string }>(contributions: readonly T[]): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const contribution of contributions) {
    if (seen.has(contribution.name)) continue;
    seen.add(contribution.name);
    kept.push(contribution);
  }
  return kept;
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
 * The manifest of a plugin, with every path that leaves the root dropped.
 *
 * The manifest is **untrusted input**, so every path it declares — the
 * directory keys, the file keys and the command metadata's `source` — is
 * resolved against the plugin root and refused when it leaves it. A refused
 * path is **dropped** from the manifest the record holds, so no later
 * consumer can pick it up, and it is reported with its named reason — twice:
 * as a **problem** on the manifest the record holds, so the record is
 * self-describing, and as a **warning** the manager logs.
 *
 * A path that **does not exist** is not refused — the path is kept, because a
 * plugin may ship its content after it is loaded — but it is **reported** the
 * same way: a **problem** on the manifest and a **warning** the manager
 * logs. Every declared path is checked the same way, whatever its key, so a
 * missing `skills` or `agents` directory is never dropped silently.
 *
 * Implementation choice — see the file header.
 */
export function containPluginPaths(
  root: string,
  manifest: PluginManifest,
): { manifest: PluginManifest; warnings: string[] } {
  const warnings: string[] = [];
  // The manifest's own problems, plus the refusals this pass makes.
  const problems = [...manifest.problems];

  const keep = (key: string, paths: readonly string[]): string[] => {
    const kept: string[] = [];
    for (const declared of paths) {
      const resolution = resolvePluginPath(root, declared);
      if (!resolution.ok) {
        warnings.push(
          `Refusing the plugin's \`${key}\` path \`${declared}\`: ${resolution.reason}`,
        );
        problems.push(
          `the plugin's \`${key}\` path \`${declared}\` was refused: ${resolution.reason}`,
        );
        continue;
      }
      // A path that is not there is reported, not dropped: the path is kept
      // — the plugin may ship its content later — and the fact that it is
      // missing lands in the log and in the manifest's own problems.
      if (!existsSync(resolution.path)) {
        warnings.push(`The plugin's \`${key}\` path \`${declared}\` does not exist`);
        problems.push(`the plugin's \`${key}\` path \`${declared}\` does not exist`);
      }
      kept.push(declared);
    }
    return kept;
  };

  const directories = Object.create(null) as Partial<
    Record<PluginDirectoryKey, string[]>
  >;
  for (const key of PLUGIN_DIRECTORY_KEYS) {
    const declared = manifest.directories[key];
    if (declared === undefined) continue;
    const kept = keep(key, declared);
    if (kept.length > 0) directories[key] = kept;
  }

  const files = Object.create(null) as Partial<Record<PluginFileKey, string[]>>;
  for (const key of PLUGIN_FILE_KEYS) {
    const declared = manifest.files[key];
    if (declared === undefined) continue;
    const kept = keep(key, declared);
    if (kept.length > 0) files[key] = kept;
  }

  const commands: PluginManifest['commands'] = [];
  for (const entry of manifest.commands) {
    if (entry.source === undefined) {
      commands.push(entry);
      continue;
    }
    const resolution = resolvePluginPath(root, entry.source);
    if (!resolution.ok) {
      warnings.push(
        `Refusing the plugin's \`commands\` path \`${entry.source}\`: ${resolution.reason}`,
      );
      problems.push(
        `the plugin's \`commands\` path \`${entry.source}\` was refused: ${resolution.reason}`,
      );
      continue;
    }
    // A metadata source that is not there is reported the same way a missing
    // directory is: the entry is kept, and the fact is recorded.
    if (!existsSync(resolution.path)) {
      warnings.push(`The plugin's \`commands\` path \`${entry.source}\` does not exist`);
      problems.push(`the plugin's \`commands\` path \`${entry.source}\` does not exist`);
    }
    commands.push(entry);
  }

  return {
    manifest: { ...manifest, directories, files, commands, problems },
    warnings,
  };
}

/**
 * Create a plugin manager.
 */
export function createPluginManager(options: PluginManagerOptions = {}): PluginManager {
  const plugins = new Map<string, PluginRecord>();
  const interner = options.interner ?? new SkillBodyInterner();
  const logs: PluginLogRecord[] = [];
  const installations: PluginInstallRecord[] = [];
  const reportedCollisions = new Set<string>();

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

    // A manifest is untrusted input: every path it declares is checked
    // against the plugin root, and a path that leaves it is dropped from the
    // manifest the record holds and reported.
    const contained = containPluginPaths(root, parsed.manifest);
    for (const warning of contained.warnings) {
      record({ level: 'warn', message: warning });
    }
    const manifest = contained.manifest;
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
      // Defence in depth: the manifest containment (`containPluginPaths`)
      // already dropped a declared skills path that leaves the root, and the
      // per-skill-file check below refuses a skill file that does. This check
      // is what refuses a skills **directory** that is no longer inside the
      // root when the plugin is read — the directory is never walked.
      const resolution = resolvePluginPath(plugin.root, declared);
      if (!resolution.ok) {
        record({
          level: 'warn',
          message: `Skipping plugin skill \`${resolution.path}\`: ${resolution.reason}`,
        });
        continue;
      }
      const skillsDir = resolution.path;
      if (!isDirectory(skillsDir)) continue;
      let entries: string[] = [];
      try {
        entries = readdirSync(skillsDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        // A skill directory's name is caller-supplied data, so it may never
        // be a prototype key.
        if (!isSafeLookupName(entry)) continue;
        const skillFile = path.join(skillsDir, entry, 'SKILL.md');
        // Defence in depth: the skills-directory check above refuses a
        // directory that leaves the root, and the manifest containment drops
        // a declared path that leaves it. This check is what refuses a
        // **skill file** reached through a symlinked subdirectory.
        const fileResolution = resolvePluginPath(plugin.root, skillFile);
        if (!fileResolution.ok) {
          record({
            level: 'warn',
            message: `Skipping plugin skill \`${fileResolution.path}\`: ${fileResolution.reason}`,
          });
          continue;
        }
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
      // Defence in depth: the manifest containment (`containPluginPaths`)
      // already dropped a declared agents path that leaves the root, and the
      // per-agent-file check below refuses an agent file that does. This check
      // is what refuses an agents **directory** that is no longer inside the
      // root when the plugin is read — the directory is never walked.
      const resolution = resolvePluginPath(plugin.root, declared);
      if (!resolution.ok) {
        record({
          level: 'warn',
          message: `Skipping plugin agent \`${resolution.path}\`: ${resolution.reason}`,
        });
        continue;
      }
      const agentsDir = resolution.path;
      if (!isDirectory(agentsDir)) continue;
      let entries: string[] = [];
      try {
        entries = readdirSync(agentsDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const agentName = entry.slice(0, -'.md'.length);
        if (!isSafeLookupName(agentName)) continue;
        const agentFile = path.join(agentsDir, entry);
        // Defence in depth: the agents-directory check above refuses a
        // directory that leaves the root, and the manifest containment drops
        // a declared path that leaves it. This check is what refuses an
        // **agent file** that is a symlink out of the root.
        const fileResolution = resolvePluginPath(plugin.root, agentFile);
        if (!fileResolution.ok) {
          record({
            level: 'warn',
            message: `Skipping plugin agent \`${fileResolution.path}\`: ${fileResolution.reason}`,
          });
          continue;
        }
        if (!existsSync(agentFile)) continue;
        contributions.push({
          name: agentName,
          source: 'plugin',
          path: agentFile,
          provider: plugin.name,
        });
      }
    }
    return contributions;
  };

  const pluginsRoot = options.pluginsRoot;

  /**
   * Report a name two providers claim.
   *
   * The names stay un-namespaced — a plugin's skill is named after the skill
   * directory inside the plugin's own skills directory — so two providers can
   * ship the same name. The collision is **reported** rather than dropped
   * silently; the first contribution wins, and the skill registry carries the
   * other providers in `collidesWith`.
   *
   * The report names the **situation**: two plugins that provide the same
   * name, and the different case of **one** plugin that provides it twice —
   * two `skills` directories in one plugin, say — which is a different
   * problem and is reported as such, with the two paths it shipped the name
   * under.
   *
   * Implementation choice — see the file header. §2.8 says nothing about how a
   * plugin's skill is named, nor about what happens when two providers ship
   * the same name, so neither the naming nor the reporting is the target's.
   */
  const reportCollisions = (
    contributions: readonly { name: string; provider?: string; path: string }[],
    kind: 'skill' | 'subagent',
  ): void => {
    const byName = new Map<string, { name: string; provider?: string; path: string }[]>();
    for (const contribution of contributions) {
      const bucket = byName.get(contribution.name);
      if (bucket) bucket.push(contribution);
      else byName.set(contribution.name, [contribution]);
    }
    for (const [name, bucket] of byName) {
      if (bucket.length < 2) continue;

      // The contributions each provider shipped the name under.
      const byProvider = new Map<string, { name: string; provider?: string; path: string }[]>();
      for (const contribution of bucket) {
        const provider = contribution.provider ?? contribution.path;
        const group = byProvider.get(provider);
        if (group) group.push(contribution);
        else byProvider.set(provider, [contribution]);
      }

      // One provider that ships the name twice is not two providers
      // colliding: it is a packaging bug, and it is reported with the paths
      // it shipped the name under.
      for (const [provider, group] of byProvider) {
        if (group.length < 2) continue;
        const key = `${kind}:${name}:duplicate:${provider}`;
        if (reportedCollisions.has(key)) continue;
        reportedCollisions.add(key);
        record({
          level: 'warn',
          message: `The plugin \`${provider}\` provides the ${kind} \`${name}\` more than once (${group
            .map((contribution) => `\`${contribution.path}\``)
            .join(', ')}); only the first one is used.`,
        });
      }

      // Two providers that ship the name is a conflict between them, and the
      // report names both.
      if (byProvider.size < 2) continue;
      const key = `${kind}:${name}:conflict`;
      if (reportedCollisions.has(key)) continue;
      reportedCollisions.add(key);
      const providers = [...byProvider.keys()];
      record({
        level: 'warn',
        message: `Two plugins provide the ${kind} \`${name}\` (${providers.join(
          ', ',
        )}); only the first one is used.`,
      });
    }
  };

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
      const contributions = [...plugins.values()].flatMap((plugin) => skillsOf(plugin));
      reportCollisions(contributions, 'skill');
      return contributions;
    },
    agents(): SubagentContribution[] {
      const contributions = [...plugins.values()].flatMap((plugin) => agentsOf(plugin));
      reportCollisions(contributions, 'subagent');
      return contributions;
    },
    apply(plugin: string): PluginApplication {
      const found = plugins.get(plugin);
      if (!found) {
        return { plugin, commands: [], skills: [], agents: [] };
      }
      const commands = commandsOf(found);
      const skills = skillsOf(found);
      const agents = agentsOf(found);
      // A plugin that provides the same name twice is a packaging bug: it is
      // reported here as well as on the aggregate path, and the plugin
      // contributes the name **once** — the first path wins, exactly as the
      // registry's precedence picks the first declared contribution.
      reportCollisions(skills, 'skill');
      reportCollisions(agents, 'subagent');
      return {
        plugin,
        commands,
        skills: firstByName(skills),
        agents: firstByName(agents),
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

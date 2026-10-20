/**
 * The skill registry: where skills come from, and which one wins.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 and the `CC-013`
 * milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## What is observed and what is not
 *
 * The audit's §2.8 closes with:
 *
 * > **Partial:** the **subagent definition lifecycle** — where a subagent's
 * > definition is found, parsed and registered — and the standalone
 * > (non-plugin) skill directory scan were not traced to resolved relations.
 * > Their names and storage are observed; their behavior was not.
 *
 * So the split is:
 *
 *   - **Observed** — the *names* and the *storage* of a skill: a skill lives in
 *     a directory named after it and holds a `SKILL.md`; and the **origins**
 *     the plan's Step 1 names — `project`, `local`, `user`, `plugin` and
 *     `mcp`.
 *   - **A implementation choice** — the *behavior* of the standalone (non-plugin) skill
 *     directory scan, because §2.8 marks that scan **partial**. The mechanics
 *     below — a `SKILL.md` per subdirectory, the `description` read from its
 *     frontmatter, the `own` flag, the precedence, the byte limit — are the
 *     implementation's. This implementation models the scan on the plugin command discovery,
 *     whose rules §2.8 *does* observe.
 *
 * ## The four discovery sources
 *
 * The plan's Step 1: "a skill in a project `.claude/skills` directory is
 * discovered and its source is `project`; a skill in `~/.claude/skills` has
 * source `user`; a **plugin**-provided skill has source `plugin`; an
 * **MCP**-provided skill has source `mcp`."
 *
 * The four registries share a `discover()` shape returning
 * `{ name, source, path }` — that is `DiscoveredItem` in `./source.ts`.
 *
 * ## The override of a synced skill
 *
 * The plan's Step 5: "a local skill override of a synced skill is reported with
 * `own: false` and the sync source is preserved, matching the target's
 * `skillOverrides` behavior."
 *
 * A root may be marked `synced`: it holds **synced copies of the user's
 * account skills**. A skill that comes from such a root is not the user's own
 * (`own: false`). When the **local** scope shadows such a skill, the record
 * keeps the sync's `source` and reports `own: false`, because the skill itself
 * is still the account's — only the file that provides it is local.
 *
 * Implementation choice (the audit does not pin the rule): the **path** of such a record
 * is the overriding file, because that is the file the session reads.
 *
 * ## The precedence
 *
 * A name two roots provide is won by the earlier source in the order
 * `project > local > user > plugin > mcp`; two roots of the same source are
 * won by the order they were declared in.
 *
 * Implementation choice: the plan **names** the five origins but does not order them,
 * and the audit marks the scan partial — so the order is this implementation's. It is
 * load-bearing: `local` beating `user` is exactly what makes the plan's Step 5
 * work.
 *
 * A name two **contributed** skills provide — two plugins that ship a skill
 * with the same name — is a **collision**: the winner is the first one
 * declared, and the other providers are reported in `collidesWith` rather
 * than dropped silently.
 *
 * ## The cost of a lookup (a implementation choice)
 *
 * The registry is **re-scanned** every time it is asked for its skills, so a
 * skill written after the registry was created is found. A `resolve(name)`
 * therefore costs a directory walk of every root, a `stat` of every
 * `SKILL.md`, and — for a file that changed — a read and a parse; the parse
 * is **cached** by size and modification time, so an unchanged file is not
 * read twice. The tiers are merged once per resolved skill, so resolving N
 * skills merges the settings N times.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';

import type { SettingsTierMap } from '../../config/tiers.js';

import {
  frontmatterValue,
  isTextScalar,
  parseFrontmatter,
  skillFrontmatterProblem,
} from './frontmatter.js';
import {
  resolveSkillOverrideMode,
  skillInvocability,
  type SkillInvocability,
  type SkillOverrideMode,
  type SkillSessionStore,
} from './overrides.js';
import {
  discoverySourceRank,
  isSafeLookupName,
  type DiscoveredItem,
  type DiscoverySource,
} from './source.js';

export type { DiscoveredItem, DiscoverySource, SkillSource } from './source.js';

/**
 * The byte limit a skill file may not exceed.
 *
 * Implementation choice — see the file header. The plugin command path caps a command
 * file at 10 000 bytes; a skill definition is a longer document, so the
 * implementation's cap is 1 MiB. A file over the cap is **surfaced** with a problem
 * rather than read.
 */
export const SKILL_FILE_BYTE_LIMIT = 1_048_576;

/**
 * A directory the registry scans for skills.
 */
export interface SkillRoot {
  /** The directory to scan. Each subdirectory that holds a `SKILL.md` is a skill. */
  path: string;
  /** Where the skills in this root come from. */
  source: DiscoverySource;
  /**
   * Whether this root holds **synced copies of the user's account skills**.
   *
   * A skill from such a root is not the user's own (`own: false`), and a local
   * skill that shadows it keeps the sync's `source`.
   */
  synced?: boolean;
}

/**
 * A skill that is **contributed** rather than scanned.
 *
 * A plugin contributes the skills it ships; an MCP server contributes the
 * skills it advertises. Neither is a directory the registry walks.
 */
export interface SkillContribution {
  /** The skill's name. */
  name: string;
  /** Where the contribution comes from. */
  source: 'plugin' | 'mcp';
  /** The path the contribution is at. */
  path: string;
  /** The description, when the contributor supplied one. */
  description?: string;
  /** The plugin or the MCP server that contributes the skill. */
  provider?: string;
}

/** A skill the registry resolved. */
export interface Skill {
  /** The skill's name — the directory it was found in. */
  name: string;
  /** Where the skill came from. */
  source: DiscoverySource;
  /** The path of the skill's `SKILL.md`, or the contribution's path. */
  path: string;
  /** Whether this record is the user's own skill. */
  own: boolean;
  /** The description, when the frontmatter carries a text one. */
  description?: string;
  /** The problem with the skill, when there is one. */
  problem?: string;
  /** The resolved override mode. A skill with no override is `on`. */
  mode: SkillOverrideMode;
  /** The plugin or the MCP server that contributes the skill, when one does. */
  provider?: string;
  /**
   * The other providers that provide a skill with this name.
   *
   * A name two **contributed** skills provide is a collision: the winner is
   * the first one declared, and the losers are reported here rather than
   * dropped silently.
   */
  collidesWith?: string[];
}

/** A skill the session may use. */
export interface AppliedSkill extends Skill, SkillInvocability {}

/** The registry of skills. */
export interface SkillRegistry {
  /** Every resolved skill. */
  list(): readonly Skill[];
  /** The skill with that name, or `undefined` when there is none. */
  resolve(name: string): Skill | undefined;
  /** The discovered items, in the shared `{ name, source, path }` shape. */
  discover(): readonly DiscoveredItem[];
  /**
   * The skills a session may use.
   *
   * A skill whose resolved mode is `off` is **not** applied, and the applied
   * skill carries the invocability its mode implies.
   */
  apply(session?: SkillSessionStore): readonly AppliedSkill[];
  /** The roots the registry scans. */
  roots(): readonly SkillRoot[];
  /** The contributions the registry holds. */
  contributions(): readonly SkillContribution[];
}

/** The options a skill registry is created with. */
export interface SkillRegistryOptions {
  /** The project working directory. */
  cwd?: string;
  /** The user's configuration directory (`~/.claude`). */
  configDir?: string;
  /**
   * The roots to scan.
   *
   * When the caller supplies them, they replace the defaults entirely — the
   * defaults are `<cwd>/.claude/skills` (source `project`) and
   * `<configDir>/skills` (source `user`).
   */
  roots?: readonly SkillRoot[];
  /** The skills contributed by plugins and MCP servers. */
  contributions?: readonly SkillContribution[];
  /** The settings tiers, for the override resolution. */
  tiers?: SettingsTierMap;
  /** The session's skill store, for the override resolution. */
  session?: SkillSessionStore;
}

interface Candidate {
  name: string;
  source: DiscoverySource;
  path: string;
  own: boolean;
  description?: string;
  problem?: string;
  provider?: string;
  /** The rank of the candidate: the source's rank, then the declaration order. */
  order: number;
  /** Whether the candidate came from a synced root. */
  synced: boolean;
}

/**
 * The default roots.
 *
 * The project root is `<cwd>/.claude/skills` and the user root is
 * `<configDir>/skills` — the plan's Step 1 names both.
 *
 * Neither default root is a **synced** root: the user's own hand-authored
 * skills live in the user root, and the folder that holds the *synced copies*
 * of their account skills is a separate root the account sync declares. A
 * hand-authored skill therefore reports `own: true`.
 */
export function defaultSkillRoots(cwd: string, configDir: string): SkillRoot[] {
  return [
    { path: path.join(cwd, '.claude', 'skills'), source: 'project' },
    { path: path.join(configDir, 'skills'), source: 'user' },
  ];
}

/** What a skill file's read found. */
interface SkillFileContent {
  /** The description, when the frontmatter carries a text one. */
  description?: string;
  /** The problem with the skill, when there is one. */
  problem?: string;
}

/** A skill file that was read, with the stat that proved it is current. */
interface CachedSkillFile {
  /** The size of the file when it was read. */
  size: number;
  /** The modification time of the file when it was read. */
  mtimeMs: number;
  /** What the read found. */
  content: SkillFileContent;
}

/**
 * Whether a path is a directory.
 */
function isDirectory(candidatePath: string): boolean {
  try {
    return statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Create a skill registry.
 *
 * The registry is built from the roots it was given (or the defaults) and the
 * contributions it was given, and it is **re-scanned** every time it is asked
 * for its skills, so a skill written after the registry was created is found.
 */
export function createSkillRegistry(options: SkillRegistryOptions = {}): SkillRegistry {
  const roots: readonly SkillRoot[] =
    options.roots ??
    (options.cwd !== undefined && options.configDir !== undefined
      ? defaultSkillRoots(options.cwd, options.configDir)
      : []);
  const contributions: SkillContribution[] = [...(options.contributions ?? [])];

  // The read cache: a skill file that has not changed is not read twice.
  const fileCache = new Map<string, CachedSkillFile>();

  const readSkillFile = (filePath: string): SkillFileContent => {
    let stats: Stats;
    try {
      stats = statSync(filePath);
    } catch {
      return { problem: 'the skill file could not be read' };
    }

    // A file over the byte limit is surfaced, not read.
    if (stats.size > SKILL_FILE_BYTE_LIMIT) {
      return { problem: 'the skill file is over the byte limit' };
    }

    const cached = fileCache.get(filePath);
    if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
      return cached.content;
    }

    let text: string;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch {
      return { problem: 'the skill file could not be read' };
    }
    const parsed = parseFrontmatter(text);
    const problem = parsed.problem ?? skillFrontmatterProblem(parsed.frontmatter);
    const rawDescription = frontmatterValue(parsed.frontmatter, 'description');
    const description = isTextScalar(rawDescription) ? rawDescription : undefined;
    const content: SkillFileContent = {
      ...(description === undefined ? {} : { description }),
      ...(problem === undefined ? {} : { problem }),
    };
    fileCache.set(filePath, {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      content,
    });
    return content;
  };

  const collect = (): Candidate[] => {
    const candidates: Candidate[] = [];
    let order = 0;

    for (const root of roots) {
      const rootOrder = order;
      order += 1;
      if (!isDirectory(root.path)) continue;

      let entries: string[] = [];
      try {
        entries = readdirSync(root.path);
      } catch {
        continue;
      }

      for (const entry of entries) {
        const skillDir = path.join(root.path, entry);
        if (!isDirectory(skillDir)) continue;
        const filePath = path.join(skillDir, 'SKILL.md');
        if (!existsSync(filePath)) continue;

        const parsed = readSkillFile(filePath);
        candidates.push({
          name: entry,
          source: root.source,
          path: filePath,
          own: root.synced !== true,
          synced: root.synced === true,
          order: rootOrder,
          ...parsed,
        });
      }
    }

    for (const contribution of contributions) {
      candidates.push({
        name: contribution.name,
        source: contribution.source,
        path: contribution.path,
        own: true,
        synced: false,
        order: order,
        ...(contribution.description === undefined
          ? {}
          : { description: contribution.description }),
        ...(contribution.provider === undefined ? {} : { provider: contribution.provider }),
      });
      order += 1;
    }

    return candidates;
  };

  const resolveAll = (session?: SkillSessionStore): Skill[] => {
    const candidates = collect();
    const byName = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
      if (!isSafeLookupName(candidate.name)) continue;
      const bucket = byName.get(candidate.name);
      if (bucket) bucket.push(candidate);
      else byName.set(candidate.name, [candidate]);
    }

    const skills: Skill[] = [];
    for (const [name, bucket] of byName) {
      const sorted = [...bucket].sort(
        (left, right) =>
          discoverySourceRank(left.source) - discoverySourceRank(right.source) ||
          left.order - right.order,
      );
      const winner = sorted[0];
      if (!winner) continue;

      // A local override of a synced skill keeps the sync's source and reports
      // that the skill is not the user's own.
      const synced = sorted.find((candidate) => candidate.synced);
      const shadowed =
        winner.source === 'local' && synced !== undefined && synced.source !== winner.source;

      const source = shadowed ? (synced?.source ?? winner.source) : winner.source;
      const own = shadowed ? false : winner.own;

      // A name two **contributed** skills provide is a collision: the losers
      // are reported rather than dropped silently.
      const collidesWith = sorted
        .slice(1)
        .filter((candidate) => candidate.source === winner.source)
        .map((candidate) => candidate.provider ?? candidate.path)
        .filter((provider, index, all) => all.indexOf(provider) === index);

      const mode =
        resolveSkillOverrideMode(name, {
          tiers: options.tiers,
          session: session ?? options.session,
        }) ?? 'on';

      skills.push({
        name,
        source,
        path: winner.path,
        own,
        mode,
        ...(winner.description === undefined ? {} : { description: winner.description }),
        ...(winner.problem === undefined ? {} : { problem: winner.problem }),
        ...(winner.provider === undefined ? {} : { provider: winner.provider }),
        ...(collidesWith.length === 0 ? {} : { collidesWith }),
      });
    }

    return skills;
  };

  return {
    list(): readonly Skill[] {
      return resolveAll();
    },
    resolve(name: string): Skill | undefined {
      if (!isSafeLookupName(name)) return undefined;
      return resolveAll().find((skill) => skill.name === name);
    },
    discover(): readonly DiscoveredItem[] {
      return resolveAll().map((skill) => ({
        name: skill.name,
        source: skill.source,
        path: skill.path,
      }));
    },
    apply(session?: SkillSessionStore): readonly AppliedSkill[] {
      return resolveAll(session)
        .filter((skill) => skill.mode !== 'off')
        .map((skill) => ({ ...skill, ...skillInvocability(skill.mode) }));
    },
    roots(): readonly SkillRoot[] {
      return [...roots];
    },
    contributions(): readonly SkillContribution[] {
      return [...contributions];
    },
  };
}

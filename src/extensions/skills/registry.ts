/**
 * The skill registry: where skills come from, and which one wins.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 and the `CC-011b`
 * milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## What is observed and what is not
 *
 * The audit's §2.8 used to close with:
 *
 * > **Partial:** the **subagent definition lifecycle** — where a subagent's
 * > definition is found, parsed and registered — and the standalone
 * > (non-plugin) skill directory scan were not traced to resolved relations.
 * > Their names and storage are observed; their behavior was not.
 *
 * The residual was closed by **reading the target's own source** (the REA
 * record `analysis/findings-extension-lifecycles.md`), so the **scan's rules
 * are observed** and this module implements them:
 *
 *   - the scan of a root is a **single `readdir`** — **depth 1, not recursive**;
 *   - each entry must be a **directory or a symlink**;
 *   - the skill file is the **fixed name `SKILL.md`**, with that exact case,
 *     directly inside the entry;
 *   - the **skips**: an entry that is not a directory or a symlink; the reserved
 *     entry name `synced`; an entry whose name contains `:` in the synced scan;
 *     an entry whose plugin is disabled; a `SKILL.md` that is **not a regular
 *     file**; a `SKILL.md` over **1 000 000 bytes**; a skill whose own name is
 *     reserved; and a directory that cannot be read;
 *   - **a frontmatter parse failure is not a skip**: it is reported at error
 *     level and the frontmatter is **ignored** — the skill still loads, without
 *     its frontmatter. Any *other* failure while building a skill skips **that
 *     one skill**, and the scan continues;
 *   - the result is **cached per process** and invalidated by the same reload
 *     path the agent catalogue uses (`reload()`, below).
 *
 * What is **still** this implementation's own:
 *
 *   - the **precedence** between the sources (`project > local > user > plugin >
 *     mcp`) and the meaning of `local`;
 *   - the **`own` flag** and the way a local override of a synced skill keeps
 *     the sync's source;
 *   - the **override modes** and their resolution;
 *   - the **merge**: the standalone scan and the plugin skills are two separate
 *     lists, and the standalone skills come **first** in the merge — that *is*
 *     the target's order, but the way a name two lists provide is resolved here
 *     is this implementation's.
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
 * declared, and the other providers are reported in `collidesWith` rather than
 * dropped silently.
 *
 * ## The two situations a collision can be
 *
 * A collision is one of two things, and the resolved record tells them apart:
 *
 *   - **a conflict** — two *different* providers ship the name. The field
 *     names the **other** provider, never the winner's own: the `provider`
 *     field says who won, and `collidesWith` says who disagreed.
 *   - **a duplication** — *one* provider ships the name twice (a plugin with
 *     two `skills` directories that hold the same skill, say). That is a
 *     packaging bug rather than a disagreement between two providers, so the
 *     field names **no provider**: it is present and empty.
 *
 * A name that did not collide carries no field at all, so the record itself
 * says which of the three situations it is in.
 *
 * A candidate that merely **lost the precedence order** — a plugin's skill
 * against a project skill — is not a collision at all, and the field says
 * nothing: only the losers that share the **winner's source** are considered.
 *
 * ## The cost of a lookup (the target's rule)
 *
 * The target **caches** the scan per process and drops the cache on a
 * file-watch event, on the `/agents` command and on a plugin reload. This
 * implementation has no file watcher, so the single invalidation point is the
 * explicit **`reload()`** — the analogue of the target's three paths, and the
 * same path the agent catalogue uses. A registry that is **not** reloaded
 * therefore keeps the catalogue it read, and a **new** registry — a new
 * process — reads the disk again.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
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
 * The **fixed name** of a skill's definition file.
 *
 * REA observed: the scan addresses the file as `<root>/<entry>/SKILL.md` — the
 * name is fixed, with that exact case, and it sits **directly** inside the
 * entry. There is no recursion into the entry and no search for a nested
 * `SKILL.md`.
 */
export const SKILL_FILE_NAME = 'SKILL.md';

/**
 * The byte limit a skill file may not exceed.
 *
 * REA observed: the target's limit is `1e6` — **1 000 000** bytes — and a file
 * over it is **skipped** with a warning:
 *
 * > `[skills] skipping <path>: <n> bytes exceeds 1000000 byte limit`
 *
 * The limit used to be this implementation's own (1 MiB, and the file was
 * *surfaced* rather than skipped); the target's rule replaces it.
 */
export const SKILL_FILE_BYTE_LIMIT = 1_000_000;

/**
 * The names a skill may not carry.
 *
 * REA observed: the target reserves the names "reserved for the skills synced
 * from your claude.ai account". The reserved list is exactly one name, and a
 * skill whose own name is it is **dropped** with a warning:
 *
 * > `[skills] not loading "<name>": that name uses "anthropic-skills", a name
 * > reserved for the skills synced from your claude.ai account; rename it`
 */
export const RESERVED_SKILL_NAMES: readonly string[] = ['anthropic-skills'];

/**
 * The **reserved entry name** of a skills root.
 *
 * REA observed: the target skips an entry called `synced` in a plain skills
 * root, because `synced` is the sync-owned root:
 *
 * > `[skills] skipping reserved dir name 'synced' under <root>: 'synced' is the
 * > sync-owned root`
 *
 * The comparison folds the case and strips trailing dots and spaces, so
 * `Synced` and `synced.` are the same name.
 */
export const RESERVED_SKILL_DIRECTORY_NAME = 'synced';

/**
 * The **tier** a skills root stands for.
 *
 * REA observed: the target reads its skill roots separately and tags each one
 * — `policySettings` (the managed directory), `userSettings` (the user's own
 * `skills` directory), `syncedSkills` (the synced subtree beneath it) and
 * `projectSettings` (every project ancestor's `.claude/skills`, and each
 * additional working directory's).
 *
 * The tier decides two of the scan's rules: the **synced** scan skips an entry
 * whose name contains `:`, and only the **user** and **project** roots are
 * checked against the disabled plugins.
 */
export type SkillTier = 'policySettings' | 'userSettings' | 'syncedSkills' | 'projectSettings';

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
  /**
   * The tier this root stands for.
   *
   * Defaults to the tier the root's `source` names. A root that stands for the
   * **synced** subtree is scanned with the synced rules.
   */
  tier?: SkillTier;
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
   *
   * The field names the **other** provider — never the winner's own — so a
   * conflict between two providers is told apart from **one** provider that
   * ships the name twice, which is a packaging bug rather than a conflict and
   * leaves the field present and empty. The field is absent when the name did
   * not collide at all.
   */
  collidesWith?: string[];
}

/** A skill the session may use. */
export interface AppliedSkill extends Skill, SkillInvocability {}

/**
 * A refusal the scan reported.
 *
 * The target logs every skip — a warning for a skipped entry, an error for a
 * failed directory or a frontmatter that did not parse. This implementation
 * keeps the same record, so a skip is never silent.
 */
export interface SkillRefusal {
  /** The path the refusal is about. */
  path: string;
  /** The name of the entry, when it had one. */
  name?: string;
  /** The reason, in the target's wording. */
  reason: string;
  /** The severity: a warning for a skip, an error for a failure. */
  level: 'warn' | 'error';
}

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
  /**
   * Drop the cached catalogue, so the next read scans the disk again.
   *
   * This is the invalidation point the target has in three places — a
   * file-watch event, the `/agents` command and a plugin reload. The agent
   * catalogue uses the same path.
   */
  reload(): void;
  /** The refusals the last scan reported. */
  refusals(): readonly SkillRefusal[];
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
  /**
   * The plugins that are turned off.
   *
   * REA observed: an entry whose **owning plugin** is disabled is skipped.
   * The owner is the `name` in the entry's own `.claude-plugin/plugin.json`;
   * an entry with no such manifest is owned by the entry's own name. The check
   * runs only for the **user** and **project** roots — the two roots the
   * target checks — and only when this list is not empty.
   */
  disabledPlugins?: readonly string[];
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

/**
 * The tier a root's source names.
 *
 * The target's tags are `policySettings`, `userSettings`, `syncedSkills` and
 * `projectSettings`. This implementation's taxonomy has five origins rather
 * than the target's four roots, so the origins that have no counterpart — the
 * local scope, and the two contributed sources — stand in the **project**
 * tier.
 */
export function defaultSkillTier(source: DiscoverySource): SkillTier {
  switch (source) {
    case 'user':
      return 'userSettings';
    case 'project':
    case 'local':
    case 'plugin':
    case 'mcp':
    default:
      return 'projectSettings';
  }
}

/**
 * Fold a name the way the target folds one.
 *
 * REA observed: the target strips the zero-width and bidirectional characters,
 * maps `ẞ` to `ß`, normalizes to NFD and case-folds. The fold is what makes
 * the reserved-name comparisons case- and width-insensitive.
 */
function foldName(name: string): string {
  return name
    .replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, '')
    .replace(/\u1e9e/g, '\u00df')
    .normalize('NFD')
    .toUpperCase()
    .toLowerCase();
}

/**
 * Strip the trailing dots and spaces the target strips.
 */
function stripTrailingDotsAndSpaces(name: string): string {
  return name.replace(/[. ]+$/, '');
}

/**
 * Whether an entry name is the **reserved** directory name.
 *
 * REA observed: the target compares the folded name, with the trailing dots
 * and spaces stripped, against `synced`.
 */
export function isReservedSkillDirectoryName(name: string): boolean {
  return foldName(stripTrailingDotsAndSpaces(name)) === RESERVED_SKILL_DIRECTORY_NAME;
}

/**
 * Whether a name is one of the **reserved** skill names.
 *
 * REA observed: the target matches the folded name against the reserved name
 * exactly, or against the reserved name followed by a `:` (the plugin
 * namespaced form). A name that carries characters outside the printable ASCII
 * range is matched as a **subsequence** of the reserved name as well.
 */
export function isReservedSkillName(name: string): boolean {
  const folded = foldName(name);
  for (const reserved of RESERVED_SKILL_NAMES) {
    if (folded === reserved) return true;
    if (folded.startsWith(`${reserved}:`)) return true;
  }
  // The target's fuzzy case: a name that is not printable ASCII is matched
  // against the reserved names as a subsequence.
  if (!/^[ -~]*$/.test(name)) {
    for (const reserved of RESERVED_SKILL_NAMES) {
      if (isSubsequence(folded, reserved)) return true;
    }
  }
  return false;
}

/**
 * Whether every character of `needle` appears in `haystack`, in order.
 */
function isSubsequence(haystack: string, needle: string): boolean {
  let index = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, index);
    if (found === -1) return false;
    index = found + 1;
  }
  return true;
}

/**
 * The reason the target gives for a reserved name.
 */
export function reservedSkillNameReason(name: string): string {
  const folded = foldName(name);
  for (const reserved of RESERVED_SKILL_NAMES) {
    if (folded === reserved || folded.startsWith(`${reserved}:`)) {
      return `uses "${reserved}", a name reserved for the skills synced from your claude.ai account`;
    }
  }
  return `uses ${RESERVED_SKILL_NAMES.map((reserved) => `"${reserved}"`).join(' or ')}, the names reserved for the skills synced from your claude.ai account`;
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
 * The plugin that owns a skill entry.
 *
 * REA observed: the target reads the entry's own `.claude-plugin/plugin.json`
 * and takes its `name` as the owner. An entry with no manifest — or with a
 * manifest that carries no name — is owned by the **entry's own name**.
 */
function owningPluginName(skillDir: string, entryName: string): string {
  const manifestPath = path.join(skillDir, '.claude-plugin', 'plugin.json');
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    return entryName;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && Object.hasOwn(parsed, 'name')) {
      const name = (parsed as { name?: unknown }).name;
      if (typeof name === 'string' && name.length > 0) return name;
    }
    return entryName;
  } catch {
    return entryName;
  }
}

/**
 * Create a skill registry.
 *
 * The registry is built from the roots it was given (or the defaults) and the
 * contributions it was given. The **scan is cached** — the target caches it
 * per process — and `reload()` drops the cache, so the next read scans the
 * disk again.
 */
export function createSkillRegistry(options: SkillRegistryOptions = {}): SkillRegistry {
  const roots: readonly SkillRoot[] =
    options.roots ??
    (options.cwd !== undefined && options.configDir !== undefined
      ? defaultSkillRoots(options.cwd, options.configDir)
      : []);
  const contributions: SkillContribution[] = [...(options.contributions ?? [])];
  const disabledPlugins = new Set(options.disabledPlugins ?? []);

  // The scan cache: the target holds the raw scan and the parsed catalogue in
  // an in-memory cache and drops it on a reload.
  let candidates: Candidate[] | undefined;
  let refusals: SkillRefusal[] = [];

  const readSkillFile = (
    filePath: string,
  ): { description?: string; problem?: string; frontmatterName?: string } => {
    let text: string;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch {
      return { problem: 'the skill file could not be read' };
    }
    const parsed = parseFrontmatter(text);
    // REA observed: a frontmatter that does not parse is **not** a skip — it
    // is reported at error level and the frontmatter is **ignored**, so the
    // skill still loads, without its frontmatter.
    if (parsed.problem !== undefined) {
      refusals.push({
        path: filePath,
        reason: `[skills] YAML frontmatter in ${filePath} failed to parse and was ignored: ${parsed.problem}`,
        level: 'error',
      });
    }
    const problem = parsed.problem ?? skillFrontmatterProblem(parsed.frontmatter);
    const rawDescription = frontmatterValue(parsed.frontmatter, 'description');
    const description = isTextScalar(rawDescription) ? rawDescription : undefined;
    const rawName = frontmatterValue(parsed.frontmatter, 'name');
    const frontmatterName = typeof rawName === 'string' && rawName.length > 0 ? rawName : undefined;
    return {
      ...(description === undefined ? {} : { description }),
      ...(problem === undefined ? {} : { problem }),
      ...(frontmatterName === undefined ? {} : { frontmatterName }),
    };
  };

  const scanRoot = (root: SkillRoot, rootOrder: number): Candidate[] => {
    const found: Candidate[] = [];
    const tier = root.tier ?? defaultSkillTier(root.source);
    const synced = root.synced === true || tier === 'syncedSkills';
    // The target checks the disabled plugins on the **user** and **project**
    // roots only.
    const pluginScoped = tier === 'userSettings' || tier === 'projectSettings';

    // A **single** `readdir` — depth 1, not recursive.
    let entries: Dirent[];
    try {
      entries = readdirSync(root.path, { withFileTypes: true });
    } catch (error) {
      if (!isMissingPath(error)) {
        refusals.push({
          path: root.path,
          reason: `Failed to read skills directory ${root.path}: ${errorMessage(error)}`,
          level: 'error',
        });
      }
      return found;
    }

    for (const entry of entries) {
      // Each entry must be a directory or a symlink.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

      if (!synced && isReservedSkillDirectoryName(entry.name)) {
        refusals.push({
          path: path.join(root.path, entry.name),
          name: entry.name,
          reason: `[skills] skipping reserved dir name '${entry.name}' under ${root.path}: '${RESERVED_SKILL_DIRECTORY_NAME}' is the sync-owned root`,
          level: 'warn',
        });
        continue;
      }

      if (synced && entry.name.includes(':')) {
        refusals.push({
          path: path.join(root.path, entry.name),
          name: entry.name,
          reason: `[skills] skipping '${entry.name}' under ${root.path}: its name contains ':', which the sync never writes, so it is not a synced skill`,
          level: 'warn',
        });
        continue;
      }

      const skillDir = path.join(root.path, entry.name);
      const filePath = path.join(skillDir, SKILL_FILE_NAME);

      // An entry whose **owning plugin** is disabled is skipped.
      if (disabledPlugins.size > 0 && pluginScoped) {
        const owner = owningPluginName(skillDir, entry.name);
        if (disabledPlugins.has(owner)) {
          refusals.push({
            path: skillDir,
            name: entry.name,
            reason: `[skills] skipping ${skillDir}: the plugin that owns it, '${owner}', is disabled`,
            level: 'warn',
          });
          continue;
        }
      }

      // The `SKILL.md` must be a regular file.
      let stats: Stats;
      try {
        stats = statSync(filePath);
      } catch {
        refusals.push({
          path: filePath,
          name: entry.name,
          reason: `[skills] failed to read ${filePath}: the file could not be read`,
          level: 'warn',
        });
        continue;
      }
      if (!stats.isFile()) {
        refusals.push({
          path: filePath,
          name: entry.name,
          reason: `[skills] skipping ${filePath}: not a regular file`,
          level: 'warn',
        });
        continue;
      }

      // The byte limit.
      if (stats.size > SKILL_FILE_BYTE_LIMIT) {
        refusals.push({
          path: filePath,
          name: entry.name,
          reason: `[skills] skipping ${filePath}: ${stats.size} bytes exceeds ${SKILL_FILE_BYTE_LIMIT} byte limit`,
          level: 'warn',
        });
        continue;
      }

      const parsed = readSkillFile(filePath);

      // A skill whose **own name** is reserved is dropped.
      const { frontmatterName, ...content } = parsed;
      const ownName = frontmatterName ?? entry.name;
      if (isReservedSkillName(entry.name) || isReservedSkillName(ownName)) {
        refusals.push({
          path: filePath,
          name: ownName,
          reason: `[skills] not loading "${ownName}": that name ${reservedSkillNameReason(ownName)}; rename it`,
          level: 'warn',
        });
        continue;
      }

      found.push({
        name: entry.name,
        source: root.source,
        path: filePath,
        own: !synced,
        synced,
        order: rootOrder,
        ...content,
      });
    }

    return found;
  };

  const collect = (): Candidate[] => {
    if (candidates !== undefined) return candidates;

    const collected: Candidate[] = [];
    const reported: SkillRefusal[] = [];
    refusals = reported;
    let order = 0;

    for (const root of roots) {
      const rootOrder = order;
      order += 1;
      collected.push(...scanRoot(root, rootOrder));
    }

    for (const contribution of contributions) {
      collected.push({
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

    candidates = collected;
    return candidates;
  };

  const resolveAll = (session?: SkillSessionStore): Skill[] => {
    const collected = collect();
    const byName = new Map<string, Candidate[]>();
    for (const candidate of collected) {
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
      //
      // The **same-source filter** is load-bearing: a candidate that merely
      // lost the precedence order — a plugin's skill against a project skill —
      // is not a collision, so only the losers that share the winner's source
      // are considered.
      const losers = sorted.slice(1).filter((candidate) => candidate.source === winner.source);

      // The **other** providers, never the winner's own: one provider that
      // ships the name twice is a packaging bug rather than a conflict
      // between two providers, so the field names no provider there.
      const collidesWith = losers
        .map((candidate) => candidate.provider ?? candidate.path)
        .filter((who) => who !== winner.provider)
        // The dedupe: a provider is named once, however many paths it shipped
        // the name under.
        .filter((who, index, all) => all.indexOf(who) === index);

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
        // The field is present whenever the name collided — it is empty when
        // the collision is the winner's own duplication — and absent when
        // there was no collision at all.
        ...(losers.length === 0 ? {} : { collidesWith }),
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
    reload(): void {
      candidates = undefined;
      refusals = [];
    },
    refusals(): readonly SkillRefusal[] {
      return [...refusals];
    },
  };
}

/**
 * Whether an error says the path is not there.
 */
function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * The message an error carries.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

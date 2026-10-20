/**
 * The subagent registry: where a subagent's definition is found, and which one
 * wins.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 (the
 * **subagent definition lifecycle** — closed by reading the target's own
 * source; the REA record is `analysis/findings-extension-lifecycles.md`) and
 * the `CC-011b` milestone of the plan.
 *
 * ## What is observed and what is not
 *
 * The audit used to record the subagent definition lifecycle as *"Partial … not
 * traced"*. The residual was closed by **reading the target's own source**, so
 * the lifecycle's rules are observed and this module implements them:
 *
 *   - a subagent is a **markdown file with YAML frontmatter** inside an
 *     **`agents/` directory**. The **file name is free-form**: the agent's
 *     name comes from the **frontmatter**, not from the file's name;
 *   - discovery is a **recursive `*.md` scan** of each `agents/` directory,
 *     with a **bounded timeout**, **following symlinks** and **skipping a
 *     directory it has already visited**;
 *   - parsing requires a `name` **and** a `description`; a file without the
 *     description is **refused by name**;
 *   - a name that starts with a dash, is longer than **256** characters, or
 *     contains a colon is refused too;
 *   - **nothing is persisted.** The raw scan and the parsed catalogue live in
 *     an **in-memory cache**, and both are dropped on a file-watch event, on
 *     the `/agents` command and on a plugin reload. Across a **restart**
 *     everything is re-read from disk, and a resumed session's main-thread
 *     agent is **reconstructed by name** against the freshly read catalogue;
 *   - when two sources define the same name, the later one wins, in the order
 *     **built-in, plugin, user settings, project settings, feature flags,
 *     machine policy**.
 *
 * What is **still** this implementation's own:
 *
 *   - the way a name two definitions of the **same** tier provide is resolved
 *     (the **first** declared wins — the target's own rule is a last-writer
 *     one, which would change the plugin-collision report);
 *   - the **message** the reconstruction reports when the agent is no longer
 *     available: the target says so, but the findings do not carry its
 *     wording;
 *   - the **extra frontmatter fields** this implementation reads are the
 *     target's, but only the subset the audit names.
 *
 * ## The sources
 *
 * The target's roots are the **managed** directory, the user's own `agents/`
 * directory, every **ancestor** of the working directory (up to the project
 * root) and every **additional** working directory; the plugin `agents/`
 * directories are read too. This implementation's roots are supplied by the
 * caller, and each one names the **tier** it stands for — the tier is what
 * decides the precedence.
 *
 * ## The precedence
 *
 * The target's order is **built-in, plugin, user settings, project settings,
 * feature flags, machine policy** — the later wins. This implementation's
 * taxonomy has five origins rather than the target's six tiers, so the origins
 * are mapped onto the tier they stand for, and the `local` origin — which the
 * target does not have — sits between the user's and the project's, exactly
 * where the skill registry's precedence puts it.
 *
 * A name two **contributed** subagents provide — two plugins that ship a
 * subagent with the same name — is a **collision**: the winner is the first one
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
 *     two `agents` directories that hold the same subagent, say). That is a
 *     packaging bug rather than a disagreement between two providers, so the
 *     field names **no provider**: it is present and empty.
 *
 * A name that did not collide carries no field at all, so the record itself
 * says which of the three situations it is in.
 *
 * A candidate that merely **lost the precedence order** — a plugin's subagent
 * against a project subagent — is not a collision at all, and the field says
 * nothing: only the losers that share the **winner's source** are considered.
 *
 * ## The cost of a lookup (the target's rule)
 *
 * The target **caches** the raw scan and the parsed catalogue per process and
 * drops the cache on a file-watch event, on the `/agents` command and on a
 * plugin reload. This implementation has no file watcher, so the single
 * invalidation point is the explicit **`reload()`** — the analogue of the
 * target's three paths, and the same path the skill catalogue uses. A
 * registry that is **not** reloaded keeps the catalogue it read, and a **new**
 * registry — a new process — reads the disk again.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';

import type { SettingsTierMap } from '../../config/tiers.js';

import { frontmatterValue, parseFrontmatter } from '../skills/frontmatter.js';
import {
  resolveSkillOverrideMode,
  skillInvocability,
  type SkillInvocability,
  type SkillOverrideMode,
  type SkillSessionStore,
} from '../skills/overrides.js';
import {
  discoverySourceRank,
  isSafeLookupName,
  type DiscoveredItem,
  type DiscoverySource,
} from '../skills/source.js';

export type { DiscoveredItem, DiscoverySource } from '../skills/source.js';

/**
 * The byte limit a subagent definition file may not exceed.
 *
 * REA observed: the target's markdown scan skips a file that "is not a regular
 * file or exceeds 1048576 byte limit", so the limit is **1 MiB** and a file
 * over it is **skipped** rather than read.
 */
export const SUBAGENT_FILE_BYTE_LIMIT = 1_048_576;

/**
 * The timeout the recursive scan runs under.
 *
 * REA observed: the target's scan runs under an `AbortSignal.timeout(3000)`.
 */
export const SUBAGENT_SCAN_TIMEOUT_MS = 3_000;

/**
 * The longest name a subagent may carry.
 *
 * REA observed: the target refuses a name longer than 256 characters.
 */
export const SUBAGENT_NAME_MAX_LENGTH = 256;

/**
 * The **tier** a subagent root stands for.
 *
 * REA observed: the target's per-source precedence is **built-in, plugin, user
 * settings, project settings, feature flags, machine policy** — the later wins.
 * `local` is this implementation's own origin and sits between the user's and
 * the project's.
 */
export type SubagentTier =
  | 'built-in'
  | 'plugin'
  | 'userSettings'
  | 'local'
  | 'projectSettings'
  | 'flagSettings'
  | 'policySettings';

/**
 * The tiers, lowest precedence first.
 *
 * The target's six tiers, in the target's order, with this implementation's
 * `local` origin inserted between the user's and the project's.
 */
export const SUBAGENT_TIER_PRECEDENCE: readonly SubagentTier[] = [
  'built-in',
  'plugin',
  'userSettings',
  'local',
  'projectSettings',
  'flagSettings',
  'policySettings',
];

/** A directory the registry scans for subagent definitions. */
export interface SubagentRoot {
  /** The directory to scan. */
  path: string;
  /** Where the subagents in this root come from. */
  source: DiscoverySource;
  /**
   * The tier this root stands for.
   *
   * Defaults to the tier the root's `source` names.
   */
  tier?: SubagentTier;
}

/**
 * A subagent that is **contributed** rather than scanned.
 *
 * A plugin contributes the subagents it ships.
 */
export interface SubagentContribution {
  /** The subagent's name. */
  name: string;
  /** Where the contribution comes from. */
  source: 'plugin' | 'mcp';
  /** The path the contribution is at. */
  path: string;
  /** The description, when the contributor supplied one. */
  description?: string;
  /** The body of the subagent's prompt. */
  body?: string;
  /** The plugin or the MCP server that contributes the subagent. */
  provider?: string;
  /** The tier the contribution competes in. */
  tier?: SubagentTier;
}

/** A resolved subagent definition. */
export interface SubagentDefinition {
  /** The subagent's name — the frontmatter's `name`. */
  name: string;
  /** Where the definition came from. */
  source: DiscoverySource;
  /** The path of the definition. */
  path: string;
  /** The description, when the frontmatter carries a text one. */
  description?: string;
  /** The model the subagent runs on, when the frontmatter names one. */
  model?: string;
  /** The tools the subagent may use, when the frontmatter names them. */
  tools?: string[];
  /** The tools the subagent may not use, when the frontmatter names them. */
  disallowedTools?: string[];
  /** The skills the subagent loads, when the frontmatter names them. */
  skills?: string[];
  /** The prompt the subagent starts with, when the frontmatter carries one. */
  initialPrompt?: string;
  /** The permission mode the subagent runs under, when the frontmatter names one. */
  permissionMode?: string;
  /** The effort the subagent runs at, when the frontmatter names one. */
  effort?: string;
  /** The colour the subagent is reported in, when the frontmatter names one. */
  color?: string;
  /** The turn ceiling, when the frontmatter names one. */
  maxTurns?: number;
  /** The body of the subagent's prompt. */
  body: string;
  /** The problem with the definition, when there is one. */
  problem?: string;
  /** The plugin or the MCP server that contributes the subagent, when one does. */
  provider?: string;
  /**
   * The other providers that provide a subagent with this name.
   *
   * A name two **contributed** subagents provide is a collision: the winner is
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
  /** The resolved override mode. A subagent with no override is `on`. */
  mode: SkillOverrideMode;
}

/** A subagent the session may use. */
export interface AppliedSubagent extends SubagentDefinition, SkillInvocability {}

/**
 * A refusal the scan reported.
 *
 * The target logs every refusal — a definition without a `description`, a name
 * that fails validation, a file it could not read. This implementation keeps
 * the same record, so a refusal is never silent.
 */
export interface SubagentRefusal {
  /** The path the refusal is about. */
  path: string;
  /** The name the refusal is about, when the file carried one. */
  name?: string;
  /** The reason, in the target's wording. */
  reason: string;
  /**
   * The severity: a warning for a refusal, an error for a failure.
   *
   * `info` marks the case the target drops **silently** — a file with no
   * `name` in its frontmatter — which this implementation reports anyway, so
   * that nothing is dropped without a word.
   */
  level: 'info' | 'warn' | 'error';
}

/**
 * The result of reconstructing an agent by name.
 *
 * REA observed: "a resumed session's main-thread agent is **reconstructed by
 * name** against the freshly read catalogue — the target says so when the
 * agent is no longer available."
 */
export interface SubagentReconstruction {
  /** The name that was reconstructed. */
  name: string;
  /** Whether the catalogue still has the agent. */
  available: boolean;
  /** The definition, when the catalogue has the agent. */
  definition?: SubagentDefinition;
  /** The message, when the agent is no longer available. */
  message?: string;
}

/** The registry of subagents. */
export interface SubagentRegistry {
  /** Every resolved subagent. */
  list(): readonly SubagentDefinition[];
  /** The subagent with that name, or `undefined` when there is none. */
  resolve(name: string): SubagentDefinition | undefined;
  /** The discovered items, in the shared `{ name, source, path }` shape. */
  discover(): readonly DiscoveredItem[];
  /**
   * The subagents a session may use.
   *
   * A subagent whose resolved override mode is `off` is **not** applied.
   */
  apply(session?: SkillSessionStore): readonly AppliedSubagent[];
  /** The roots the registry scans. */
  roots(): readonly SubagentRoot[];
  /**
   * Drop the cached catalogue, so the next read scans the disk again.
   *
   * This is the invalidation point the target has in three places — a
   * file-watch event, the `/agents` command and a plugin reload. The skill
   * catalogue uses the same path.
   */
  reload(): void;
  /** The refusals the last scan reported. */
  refusals(): readonly SubagentRefusal[];
  /**
   * Reconstruct an agent by name against the catalogue.
   *
   * The name is the caller's: this implementation's transcript vocabulary has
   * **no record that carries the main-thread agent's name**, so the rule
   * fires only when the caller supplies one.
   */
  reconstruct(name: string): SubagentReconstruction;
}

/** The options a subagent registry is created with. */
export interface SubagentRegistryOptions {
  /** The project working directory. */
  cwd?: string;
  /** The user's configuration directory (`~/.claude`). */
  configDir?: string;
  /** The roots to scan. When supplied, they replace the defaults. */
  roots?: readonly SubagentRoot[];
  /** The subagents contributed by plugins and MCP servers. */
  contributions?: readonly SubagentContribution[];
  /** The settings tiers, for the override resolution. */
  tiers?: SettingsTierMap;
  /** The session's skill store, for the override resolution. */
  session?: SkillSessionStore;
}

interface Candidate extends Omit<SubagentDefinition, 'mode'> {
  /** The rank of the candidate: the source's rank, then the declaration order. */
  order: number;
  /** The tier the candidate competes in. */
  tier: SubagentTier;
}

/** What a definition file's read found. */
interface DefinitionContent {
  name?: string;
  description?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  color?: string;
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  initialPrompt?: string;
  maxTurns?: number;
  body: string;
}

/**
 * The default roots.
 *
 * The project root is `<cwd>/.claude/agents` and the user root is
 * `<configDir>/agents`.
 */
export function defaultSubagentRoots(cwd: string, configDir: string): SubagentRoot[] {
  return [
    { path: path.join(cwd, '.claude', 'agents'), source: 'project' },
    { path: path.join(configDir, 'agents'), source: 'user' },
  ];
}

/**
 * The tier an origin stands for.
 *
 * The target's sources are the built-in agents, the plugin agents, the user's
 * own directory, the project directories, the runtime registrations (the
 * `--agents` flag and the programmatic hook) and the machine policy. This
 * implementation's origins map onto them, and an MCP contribution — a runtime
 * registration — stands in the flag tier.
 */
export function defaultSubagentTier(source: DiscoverySource): SubagentTier {
  switch (source) {
    case 'plugin':
      return 'plugin';
    case 'user':
      return 'userSettings';
    case 'local':
      return 'local';
    case 'project':
      return 'projectSettings';
    case 'mcp':
    default:
      return 'flagSettings';
  }
}

/**
 * Whether a name is one the target accepts.
 *
 * REA observed: a name that starts with a dash, is longer than 256 characters,
 * or contains a colon is refused.
 */
export function isValidSubagentName(name: string): boolean {
  if (name.startsWith('-')) return false;
  if (name.length > SUBAGENT_NAME_MAX_LENGTH) return false;
  if (name.normalize('NFKC').includes(':')) return false;
  return true;
}

/**
 * The reason a name is refused.
 */
export function subagentNameRefusal(name: string): string | undefined {
  if (name.startsWith('-')) return "names must not start with '-'";
  if (name.length > SUBAGENT_NAME_MAX_LENGTH) {
    return `names must be at most ${SUBAGENT_NAME_MAX_LENGTH} characters`;
  }
  if (name.normalize('NFKC').includes(':')) {
    return "names must not contain ':' (reserved for plugin namespacing)";
  }
  return undefined;
}

/**
 * The message the target reports when the agent is no longer available.
 *
 * The target says so; the wording is **this implementation's**, because the
 * REA findings do not carry the target's text.
 */
export function subagentUnavailableMessage(name: string): string {
  return `The agent \`${name}\` is no longer available: the catalogue that was just read does not define it.`;
}

/**
 * Create a subagent registry.
 *
 * The registry is built from the roots it was given (or the defaults) and the
 * contributions it was given. The **scan is cached** — the target caches it per
 * process — and `reload()` drops the cache, so the next read scans the disk
 * again.
 */
export function createSubagentRegistry(options: SubagentRegistryOptions = {}): SubagentRegistry {
  const roots: readonly SubagentRoot[] =
    options.roots ??
    (options.cwd !== undefined && options.configDir !== undefined
      ? defaultSubagentRoots(options.cwd, options.configDir)
      : []);
  const contributions: SubagentContribution[] = [...(options.contributions ?? [])];

  // The catalogue cache: the target holds the raw scan and the parsed
  // catalogue in memory and drops them on a reload.
  let candidates: Candidate[] | undefined;
  let refusals: SubagentRefusal[] = [];

  /**
   * The **recursive** `*.md` scan of one root.
   *
   * REA observed: the scan is recursive, follows symlinks, skips a directory
   * it has already visited, and runs under a bounded timeout.
   */
  const scanRoot = (root: SubagentRoot): string[] => {
    const found: string[] = [];
    const visited = new Set<string>();
    const deadline = Date.now() + SUBAGENT_SCAN_TIMEOUT_MS;

    const walk = (directory: string): void => {
      if (Date.now() > deadline) {
        refusals.push({
          path: directory,
          reason: `loadMarkdownFilesFromDir: the scan of ${root.path} timed out`,
          level: 'error',
        });
        return;
      }

      // The identity of the directory: the target skips one it has already
      // visited, so a circular symlink cannot make the scan loop.
      let identity: string;
      try {
        identity = realpathSync(directory);
      } catch {
        identity = directory;
      }
      if (visited.has(identity)) {
        refusals.push({
          path: directory,
          reason: `Skipping already visited directory (circular symlink): ${directory}`,
          level: 'warn',
        });
        return;
      }
      visited.add(identity);

      let entries: Dirent[];
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch (error) {
        // A directory that is not there is not a failure: the roots are
        // optional.
        if (!isMissingPath(error)) {
          refusals.push({
            path: directory,
            reason: `Failed to read directory ${directory}: ${errorMessage(error)}`,
            level: 'error',
          });
        }
        return;
      }

      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        let isDirectory = entry.isDirectory();
        let isFile = entry.isFile();

        // A symlink is followed.
        if (entry.isSymbolicLink()) {
          try {
            const stats = statSync(full);
            isDirectory = stats.isDirectory();
            isFile = stats.isFile();
          } catch (error) {
            refusals.push({
              path: full,
              reason: `Failed to follow symlink ${full}: ${errorMessage(error)}`,
              level: 'warn',
            });
            continue;
          }
        }

        if (isDirectory) {
          walk(full);
          continue;
        }
        // The file name is free-form, but only a markdown file is a definition.
        if (isFile && entry.name.endsWith('.md')) found.push(full);
      }
    };

    walk(root.path);
    return found;
  };

  const readDefinition = (filePath: string): DefinitionContent | undefined => {
    let stats: Stats;
    try {
      stats = statSync(filePath);
    } catch {
      refusals.push({
        path: filePath,
        reason: `Failed to read/parse markdown file:  ${filePath}: the file could not be read`,
        level: 'error',
      });
      return undefined;
    }

    // REA observed: a file that is not a regular file, or that is over the
    // byte limit, is skipped by the scan.
    if (!stats.isFile() || stats.size > SUBAGENT_FILE_BYTE_LIMIT) {
      refusals.push({
        path: filePath,
        reason: `loadMarkdownFilesFromDir: skipping ${filePath}: not a regular file or exceeds ${SUBAGENT_FILE_BYTE_LIMIT} byte limit`,
        level: 'warn',
      });
      return undefined;
    }

    let text: string;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch (error) {
      refusals.push({
        path: filePath,
        reason: `Failed to read/parse markdown file:  ${filePath}: ${errorMessage(error)}`,
        level: 'error',
      });
      return undefined;
    }

    const parsed = parseFrontmatter(text);
    const frontmatter = parsed.frontmatter;
    // REA observed: a frontmatter that does not parse is reported and
    // **ignored** — the file still loads, with an empty frontmatter.
    if (parsed.problem !== undefined) {
      refusals.push({
        path: filePath,
        reason: `YAML frontmatter in ${filePath} failed to parse and was ignored: ${parsed.problem}`,
        level: 'error',
      });
    }

    const name = frontmatterValue(frontmatter, 'name');
    const description = frontmatterValue(frontmatter, 'description');
    const model = frontmatterValue(frontmatter, 'model');
    const effort = frontmatterValue(frontmatter, 'effort');
    const color = frontmatterValue(frontmatter, 'color');
    // The frontmatter parser **normalizes** the keys — it lower-cases them
    // and folds the runs of spaces and underscores into a dash — so the
    // multi-word keys are looked up in their normalized form.
    const permissionMode = frontmatterValue(frontmatter, 'permissionmode');
    const initialPrompt = frontmatterValue(frontmatter, 'initialprompt');
    const maxTurns = turnCeiling(frontmatterValue(frontmatter, 'maxturns'));
    const tools = toolList(frontmatterValue(frontmatter, 'tools'));
    const disallowedTools = toolList(frontmatterValue(frontmatter, 'disallowedtools'));
    const skills = toolList(frontmatterValue(frontmatter, 'skills'));

    return {
      ...(typeof name === 'string' && name.length > 0 ? { name } : {}),
      ...(typeof description === 'string' && description.length > 0 ? { description } : {}),
      ...(typeof model === 'string' && model.length > 0 ? { model } : {}),
      ...(typeof effort === 'string' && effort.length > 0 ? { effort } : {}),
      ...(typeof permissionMode === 'string' && permissionMode.length > 0
        ? { permissionMode }
        : {}),
      ...(typeof color === 'string' && color.length > 0 ? { color } : {}),
      ...(typeof initialPrompt === 'string' && initialPrompt.length > 0 ? { initialPrompt } : {}),
      ...(maxTurns === undefined ? {} : { maxTurns }),
      ...(tools === undefined ? {} : { tools }),
      ...(disallowedTools === undefined ? {} : { disallowedTools }),
      ...(skills === undefined ? {} : { skills }),
      body: parsed.body,
    };
  };

  const collect = (): Candidate[] => {
    if (candidates !== undefined) return candidates;

    const collected: Candidate[] = [];
    const reported: SubagentRefusal[] = [];
    refusals = reported;
    let order = 0;

    for (const root of roots) {
      const rootOrder = order;
      order += 1;
      const tier = root.tier ?? defaultSubagentTier(root.source);

      for (const filePath of scanRoot(root)) {
        const parsed = readDefinition(filePath);
        if (parsed === undefined) continue;

        // The name comes from the **frontmatter**; the file's name is
        // free-form. A file without a name is dropped.
        if (parsed.name === undefined) {
          refusals.push({
            path: filePath,
            reason: `Agent file ${filePath} has no 'name' in its frontmatter`,
            level: 'info',
          });
          continue;
        }

        // A name that fails the target's validation is refused.
        const nameRefusal = subagentNameRefusal(parsed.name);
        if (nameRefusal !== undefined) {
          refusals.push({
            path: filePath,
            name: parsed.name,
            reason: `Agent file ${filePath} has invalid name '${parsed.name}': ${nameRefusal}`,
            level: 'error',
          });
          continue;
        }

        // The description is **required**.
        if (parsed.description === undefined) {
          refusals.push({
            path: filePath,
            name: parsed.name,
            reason: `Agent file ${filePath} is missing required 'description' in frontmatter`,
            level: 'warn',
          });
          continue;
        }

        collected.push({
          name: parsed.name,
          source: root.source,
          path: filePath,
          body: parsed.body,
          order: rootOrder,
          tier,
          ...(parsed.description === undefined ? {} : { description: parsed.description }),
          ...(parsed.model === undefined ? {} : { model: parsed.model }),
          ...(parsed.effort === undefined ? {} : { effort: parsed.effort }),
          ...(parsed.permissionMode === undefined
            ? {}
            : { permissionMode: parsed.permissionMode }),
          ...(parsed.color === undefined ? {} : { color: parsed.color }),
          ...(parsed.initialPrompt === undefined
            ? {}
            : { initialPrompt: parsed.initialPrompt }),
          ...(parsed.maxTurns === undefined ? {} : { maxTurns: parsed.maxTurns }),
          ...(parsed.tools === undefined ? {} : { tools: parsed.tools }),
          ...(parsed.disallowedTools === undefined
            ? {}
            : { disallowedTools: parsed.disallowedTools }),
          ...(parsed.skills === undefined ? {} : { skills: parsed.skills }),
        });
      }
    }

    for (const contribution of contributions) {
      collected.push({
        name: contribution.name,
        source: contribution.source,
        path: contribution.path,
        body: contribution.body ?? '',
        order,
        tier: contribution.tier ?? defaultSubagentTier(contribution.source),
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

  const resolveAll = (session?: SkillSessionStore): SubagentDefinition[] => {
    const collected = collect();
    const byName = new Map<string, Candidate[]>();
    for (const candidate of collected) {
      if (!isSafeLookupName(candidate.name)) continue;
      const bucket = byName.get(candidate.name);
      if (bucket) bucket.push(candidate);
      else byName.set(candidate.name, [candidate]);
    }

    const definitions: SubagentDefinition[] = [];
    for (const [name, bucket] of byName) {
      // REA observed: the later tier wins — **built-in, plugin, user settings,
      // project settings, feature flags, machine policy**.
      const sorted = [...bucket].sort(
        (left, right) =>
          SUBAGENT_TIER_PRECEDENCE.indexOf(right.tier) -
            SUBAGENT_TIER_PRECEDENCE.indexOf(left.tier) ||
          discoverySourceRank(left.source) - discoverySourceRank(right.source) ||
          left.order - right.order,
      );
      const winner = sorted[0];
      if (!winner) continue;
      const { order: _order, tier: _tier, ...definition } = winner;

      // A name two **contributed** subagents provide is a collision: the
      // losers are reported rather than dropped silently.
      //
      // The **same-source filter** is load-bearing: a candidate that merely
      // lost the precedence order — a plugin's subagent against a project
      // subagent — is not a collision, so only the losers that share the
      // winner's source are considered.
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
      definitions.push({
        ...definition,
        mode,
        // The field is present whenever the name collided — it is empty when
        // the collision is the winner's own duplication — and absent when
        // there was no collision at all.
        ...(losers.length === 0 ? {} : { collidesWith }),
      });
    }

    return definitions;
  };

  return {
    list(): readonly SubagentDefinition[] {
      return resolveAll();
    },
    resolve(name: string): SubagentDefinition | undefined {
      if (!isSafeLookupName(name)) return undefined;
      return resolveAll().find((definition) => definition.name === name);
    },
    discover(): readonly DiscoveredItem[] {
      return resolveAll().map((definition) => ({
        name: definition.name,
        source: definition.source,
        path: definition.path,
      }));
    },
    apply(session?: SkillSessionStore): readonly AppliedSubagent[] {
      return resolveAll(session)
        .filter((definition) => definition.mode !== 'off')
        .map((definition) => ({
          ...definition,
          ...skillInvocability(definition.mode),
        }));
    },
    roots(): readonly SubagentRoot[] {
      return [...roots];
    },
    reload(): void {
      candidates = undefined;
      refusals = [];
    },
    refusals(): readonly SubagentRefusal[] {
      return [...refusals];
    },
    reconstruct(name: string): SubagentReconstruction {
      if (!isSafeLookupName(name)) {
        return { name, available: false, message: subagentUnavailableMessage(name) };
      }
      const definition = resolveAll().find((candidate) => candidate.name === name);
      if (definition === undefined) {
        return { name, available: false, message: subagentUnavailableMessage(name) };
      }
      return { name, available: true, definition };
    },
  };
}

/**
 * The message an error carries.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
 * Read a list of names out of a frontmatter value.
 *
 * The target accepts a string or a list of strings for the tool lists; a
 * single string is split on its commas.
 */
function toolList(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    const names = value
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    return names.length === 0 ? undefined : names;
  }
  if (!Array.isArray(value)) return undefined;
  const names = value.filter((name): name is string => typeof name === 'string');
  return names.length === 0 ? undefined : names;
}

/**
 * Read the turn ceiling out of a frontmatter value.
 *
 * The target's ceiling is a positive integer; the frontmatter parser keeps the
 * raw text, so the number is read out of it.
 */
function turnCeiling(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const turns = Number.parseInt(trimmed, 10);
  return turns > 0 ? turns : undefined;
}

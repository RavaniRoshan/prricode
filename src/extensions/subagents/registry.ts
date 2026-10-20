/**
 * The subagent registry: where a subagent's definition is found, and which one
 * wins.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("**Partial:** the
 * **subagent definition lifecycle** — where a subagent's definition is found,
 * parsed and registered — and the standalone (non-plugin) skill directory scan
 * were not traced to resolved relations. Their names and storage are observed;
 * their behavior was not.") and the `CC-013` milestone of the plan.
 *
 * ## What is observed and what is not
 *
 * The audit is explicit that the subagent definition lifecycle was **not**
 * traced: the names and the storage are observed, the behavior is not. So the
 * whole of this module's *behavior* is a **implementation choice**, and it is modelled on
 * the skill registry, whose lifecycle **is** observed:
 *
 *   - a subagent is a **markdown file** whose frontmatter carries a `name` and
 *     a `description`;
 *   - the file's **basename** is the subagent's name, and the frontmatter's
 *     `name` overrides it when it carries one;
 *   - a project subagent lives in `<cwd>/.claude/agents`, a user subagent in
 *     `<configDir>/agents`, and a plugin's subagents live in the plugin's
 *     `agents` directory (declared by the plugin manifest's `agents` key);
 *   - the sources are the same discovery origins the skill registry uses.
 *
 * ## The precedence
 *
 * A name two roots provide is won by the earlier source in the order
 * `project > local > user > plugin > mcp`, and the registry follows that
 * order.
 *
 * Implementation choice: the plan **names** the five origins but does not order them,
 * and the audit marks the subagent lifecycle partial — so the order is the
 * implementation's, and the whole registry follows the skill registry's model.
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
 * ## The cost of a lookup (a implementation choice)
 *
 * The registry is **re-scanned** every time it is asked for its subagents, so
 * a definition written after the registry was created is found. A
 * `resolve(name)` therefore costs a directory walk of every root, a `stat` of
 * every definition file, and — for a file that changed — a read and a parse;
 * the parse is **cached** by size and modification time, so an unchanged file
 * is not read twice. The tiers are merged once per resolved subagent.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
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
 * Implementation choice — see the file header. A definition is a long document, so the
 * implementation's cap is 1 MiB; a file over the cap is **surfaced** with a problem
 * rather than read.
 */
export const SUBAGENT_FILE_BYTE_LIMIT = 1_048_576;

/** A directory the registry scans for subagent definitions. */
export interface SubagentRoot {
  /** The directory to scan. */
  path: string;
  /** Where the subagents in this root come from. */
  source: DiscoverySource;
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
}

/** A resolved subagent definition. */
export interface SubagentDefinition {
  /** The subagent's name. */
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
}

/** What a definition file's read found. */
interface DefinitionContent {
  name?: string;
  description?: string;
  model?: string;
  tools?: string[];
  body: string;
  problem?: string;
}

/** A definition file that was read, with the stat that proved it is current. */
interface CachedDefinitionFile {
  /** The size of the file when it was read. */
  size: number;
  /** The modification time of the file when it was read. */
  mtimeMs: number;
  /** What the read found. */
  content: DefinitionContent;
}

function isDirectory(candidatePath: string): boolean {
  try {
    return statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
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
 * Create a subagent registry.
 *
 * The registry re-scans its roots every time it is asked for its subagents, so
 * a definition written after the registry was created is found.
 */
export function createSubagentRegistry(options: SubagentRegistryOptions = {}): SubagentRegistry {
  const roots: readonly SubagentRoot[] =
    options.roots ??
    (options.cwd !== undefined && options.configDir !== undefined
      ? defaultSubagentRoots(options.cwd, options.configDir)
      : []);
  const contributions: SubagentContribution[] = [...(options.contributions ?? [])];

  // The read cache: a definition file that has not changed is not read twice.
  const fileCache = new Map<string, CachedDefinitionFile>();

  const readDefinition = (filePath: string): DefinitionContent => {
    let stats: Stats;
    try {
      stats = statSync(filePath);
    } catch {
      return { body: '', problem: 'the subagent file could not be read' };
    }

    // A file over the byte limit is surfaced, not read.
    if (stats.size > SUBAGENT_FILE_BYTE_LIMIT) {
      return { body: '', problem: 'the subagent file is over the byte limit' };
    }

    const cached = fileCache.get(filePath);
    if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
      return cached.content;
    }

    let text: string;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch {
      return { body: '', problem: 'the subagent file could not be read' };
    }
    const parsed = parseFrontmatter(text);
    const frontmatter = parsed.frontmatter;
    const description = frontmatterValue(frontmatter, 'description');
    const model = frontmatterValue(frontmatter, 'model');
    const rawTools = frontmatterValue(frontmatter, 'tools');
    const tools =
      typeof rawTools === 'string'
        ? rawTools
            .split(',')
            .map((tool) => tool.trim())
            .filter((tool) => tool.length > 0)
        : undefined;
    const name = frontmatterValue(frontmatter, 'name');

    const problem =
      parsed.problem ??
      (typeof description === 'string' ? undefined : 'the description is not text');

    const content: DefinitionContent = {
      ...(typeof name === 'string' ? { name } : {}),
      ...(typeof description === 'string' ? { description } : {}),
      ...(typeof model === 'string' ? { model } : {}),
      ...(tools === undefined ? {} : { tools }),
      body: parsed.body,
      ...(problem === undefined ? {} : { problem }),
    };
    fileCache.set(filePath, { size: stats.size, mtimeMs: stats.mtimeMs, content });
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
        if (!entry.endsWith('.md')) continue;
        const filePath = path.join(root.path, entry);
        if (!existsSync(filePath)) continue;
        const parsed = readDefinition(filePath);
        candidates.push({
          name: parsed.name ?? entry.slice(0, -'.md'.length),
          source: root.source,
          path: filePath,
          body: parsed.body,
          order: rootOrder,
          ...(parsed.description === undefined ? {} : { description: parsed.description }),
          ...(parsed.model === undefined ? {} : { model: parsed.model }),
          ...(parsed.tools === undefined ? {} : { tools: parsed.tools }),
          ...(parsed.problem === undefined ? {} : { problem: parsed.problem }),
        });
      }
    }

    for (const contribution of contributions) {
      candidates.push({
        name: contribution.name,
        source: contribution.source,
        path: contribution.path,
        body: contribution.body ?? '',
        order,
        ...(contribution.description === undefined
          ? {}
          : { description: contribution.description }),
        ...(contribution.provider === undefined ? {} : { provider: contribution.provider }),
      });
      order += 1;
    }

    return candidates;
  };

  const resolveAll = (session?: SkillSessionStore): SubagentDefinition[] => {
    const candidates = collect();
    const byName = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
      if (!isSafeLookupName(candidate.name)) continue;
      const bucket = byName.get(candidate.name);
      if (bucket) bucket.push(candidate);
      else byName.set(candidate.name, [candidate]);
    }

    const definitions: SubagentDefinition[] = [];
    for (const [name, bucket] of byName) {
      const sorted = [...bucket].sort(
        (left, right) =>
          discoverySourceRank(left.source) - discoverySourceRank(right.source) ||
          left.order - right.order,
      );
      const winner = sorted[0];
      if (!winner) continue;
      const { order: _order, ...definition } = winner;

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
  };
}

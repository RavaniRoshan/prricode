/**
 * The discovery-origin taxonomy shared by the extension registries.
 *
 * Evidence: the `CC-013` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`
 * ("each returns items whose `source` is the discovery origin (project, local,
 * user, plugin, mcp)") and `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8.
 *
 * ## The taxonomy
 *
 * ```
 * project  the project's shared `.claude` directory
 * local    the local scope: a directory that is not shared with anyone else
 * user     the user's own configuration directory (`~/.claude`)
 * plugin   a plugin that contributes the item
 * mcp      an MCP server that contributes the item
 * ```
 *
 * The **plan** fixes the five names, and the audit fixes the four the skill
 * discovery paths actually use: a skill in a project's `.claude/skills` is
 * `project`, a skill in `~/.claude/skills` is `user`, a plugin-provided skill
 * is `plugin` and an MCP-provided skill is `mcp`.
 *
 * ## `local` is the local scope
 *
 * Implementation choice (the audit does not define the name): `local` is the scope of
 * an item that belongs to **this machine and this user** and is not shared
 * with the project. The concrete case the plan names is the **local skill
 * override** of a synced skill — a skill the user wrote locally that shadows a
 * copy synced from their account. The override takes precedence (the plan
 * orders the sources `project, local, user, plugin, mcp`), but the record it
 * produces keeps the **sync's** `source` and reports `own: false`, because the
 * skill itself is still the account's.
 *
 * ## A resolved skill may be `built-in`
 *
 * The audit records that "the resolved skill then carries a `source`, defaulting
 * to `built-in`". That is a different axis from the discovery origin — it is
 * where the skill's *prompt* came from once the extension points have run — so
 * it is a separate type (`SkillSource`) rather than a sixth discovery origin.
 */

/** Where an extension item was discovered. */
export type DiscoverySource = 'project' | 'local' | 'user' | 'plugin' | 'mcp';

/**
 * Where a *resolved* skill came from.
 *
 * A resolved skill carries the origin it was discovered at, or `built-in` when
 * it was not discovered at all but supplied by the host.
 */
export type SkillSource = DiscoverySource | 'built-in';

/**
 * The shape the four registries share for a discovered item.
 *
 * The plan fixes it: "`discover()` shape returning `{ name, source, path }`".
 */
export interface DiscoveredItem {
  /** The item's name. */
  name: string;
  /** Where the item was discovered. */
  source: DiscoverySource;
  /** The path the item was found at. */
  path: string;
}

/**
 * The order the sources take precedence in.
 *
 * The plan lists them as "(project, local, user, plugin, mcp)", and the order
 * is what decides which of two candidates for the same name wins.
 */
export const DISCOVERY_SOURCE_ORDER: readonly DiscoverySource[] = [
  'project',
  'local',
  'user',
  'plugin',
  'mcp',
];

/**
 * The rank of a discovery source: lower wins.
 *
 * A source the plan does not name ranks after every named one.
 */
export function discoverySourceRank(source: DiscoverySource): number {
  const index = DISCOVERY_SOURCE_ORDER.indexOf(source);
  return index === -1 ? DISCOVERY_SOURCE_ORDER.length : index;
}

/**
 * The names the target refuses as a skill name.
 *
 * The audit is explicit: "the target itself **guards against `__proto__`** as a
 * skill name — the same prototype-key hazard this implementation's permission engine had
 * to be hardened against". A skill name is caller-supplied data, so it may
 * never resolve to an inherited member of `Object.prototype`.
 */
const PROTOTYPE_KEY_NAMES: ReadonlySet<string> = new Set(['__proto__']);

/** Whether a name is safe to use as a key in a plain object. */
export function isSafeLookupName(name: string): boolean {
  return !PROTOTYPE_KEY_NAMES.has(name);
}

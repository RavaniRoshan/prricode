/**
 * Settings tier model.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.7 (Configuration) and
 * `docs/reverse-engineering/reference-agent-2.1.303-partial.md` (settings store record).
 *
 * The target declares **four** distinct orderings as literals in the settings store
 * (`chunk-4sn6hdt2.js`, constants exported from `chunk-16tfbg7w.js`). Two of them
 * decide *which tier wins a key* and they are **not** the same rule:
 *
 *   - `C7s` = ["policySettings", "flagSettings", "userSettings"] — resolution order
 *     for a **top-level** settings key, highest first. A key defined by a project or
 *     local tier is therefore *not* part of a top-level resolution at all.
 *   - `Ble` = ["localSettings", "projectSettings", "userSettings"] — per-key merge
 *     order for **merged** settings (skill overrides and friends), highest first.
 *   - `D_`  = ["userSettings", "projectSettings", "localSettings"] — source
 *     enumeration order; it carries the scope map `{user, project, local}` and lives
 *     in `scope.ts` because it is a scope question rather than a precedence one.
 *   - `VD`  = ["projectSettings", "localSettings"] — the project-side tiers, i.e.
 *     exactly the set the "restrict personal config" restriction suppresses.
 *
 * A third rule applies at **block** granularity rather than key granularity: a higher
 * tier's block applies as a whole over any lower tier and is never merged key by key
 * ("the spellcheck block in `<source>` applies (as a whole, over any lower tier)").
 *
 * Implementation choices (the audit does not pin them, so they are marked as such here):
 *
 *   - `TIER_PRECEDENCE` is the *composition* used for the whole-block rule. It is
 *     consistent with both observed orderings (policy > flag > user, and
 *     local > project > user) but the audit does not state a block ordering, so this
 *     ordering is a reimplementation decision and is not claimed as target-verified.
 *   - `resolveTopLevelKey` reads a *literal top-level* key; `resolveMergedKey`
 *     accepts a dotted path so that a merged setting can be resolved per leaf
 *     (`skills.my-skill`).
 *   - The resolvers accept a map whose entries are either a raw settings document or
 *     a `SettingsTier` wrapper (`{source, value}`), so that a `SettingsLoadResult`
 *     (`Map<SettingsSource, SettingsTier>`) can be passed straight in.
 */

/** The five settings sources the target names. */
export type SettingsSource =
  | 'policySettings'
  | 'flagSettings'
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings';

/** Every source, in a stable enumeration order. */
export const ALL_SOURCES: readonly SettingsSource[] = [
  'policySettings',
  'flagSettings',
  'userSettings',
  'projectSettings',
  'localSettings',
];

/**
 * `C7s` — resolution order for a **top-level** settings key, highest first.
 * Machine policy beats feature flags, which beat user settings.
 */
export const TOP_LEVEL_KEY_ORDER: readonly SettingsSource[] = [
  'policySettings',
  'flagSettings',
  'userSettings',
];

/**
 * `Ble` — per-key merge order for **merged** settings, highest first.
 * Local settings beat project settings, which beat user settings.
 */
export const MERGED_KEY_ORDER: readonly SettingsSource[] = [
  'localSettings',
  'projectSettings',
  'userSettings',
];

/**
 * `VD` (a.k.a. `ef`) — the project-side tiers. This is exactly the set that the
 * "restrict personal config" restriction suppresses.
 */
export const PROJECT_SIDE_SOURCES: readonly SettingsSource[] = [
  'projectSettings',
  'localSettings',
];

/**
 * Composition used for whole-block overrides. Consistent with both observed
 * orderings, but **not** itself observed in the target — see the file header.
 */
export const TIER_PRECEDENCE: readonly SettingsSource[] = [
  'policySettings',
  'flagSettings',
  'localSettings',
  'projectSettings',
  'userSettings',
];

/** A single tier's contribution for a key. */
export interface SettingsTier {
  source: SettingsSource;
  value: unknown;
}

/** A map of source -> settings document (or -> `SettingsTier` wrapper). */
export type SettingsTierMap = Map<SettingsSource, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when the map entry is a `SettingsTier` wrapper rather than a raw document.
 * The check is deliberately narrow: the object must have exactly the keys
 * `source` and `value`, and `source` must name the tier it is filed under.
 */
function isTierWrapper(entry: unknown, source: SettingsSource): entry is SettingsTier {
  if (!isPlainObject(entry)) return false;
  const keys = Object.keys(entry);
  if (keys.length > 2) return false;
  if (!keys.includes('value') || !keys.includes('source')) return false;
  return entry['source'] === source;
}

/** The settings document carried by a map entry, unwrapping a tier if needed. */
export function documentOf(entry: unknown, source: SettingsSource): unknown {
  return isTierWrapper(entry, source) ? entry.value : entry;
}

interface PathLookup {
  found: boolean;
  value: unknown;
}

function lookupPath(document: unknown, segments: readonly string[]): PathLookup {
  let current: unknown = document;
  for (const segment of segments) {
    if (!isPlainObject(current)) return { found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false, value: undefined };
    }
    current = current[segment];
  }
  return { found: true, value: current };
}

function splitPath(key: string): string[] {
  return key.split('.').filter((segment) => segment.length > 0);
}

function tiersDefining(
  tiers: SettingsTierMap,
  key: string,
  order: readonly SettingsSource[],
  path: readonly string[],
): SettingsTier[] {
  const resolved: SettingsTier[] = [];
  for (const source of order) {
    if (!tiers.has(source)) continue;
    const document = documentOf(tiers.get(source), source);
    const lookup = lookupPath(document, path);
    if (lookup.found) resolved.push({ source, value: lookup.value });
  }
  return resolved;
}

/**
 * Resolve a **top-level** settings key through `TOP_LEVEL_KEY_ORDER`.
 *
 * Returns every tier that defines the key, highest first; the first entry is the
 * effective one. Tiers outside `TOP_LEVEL_KEY_ORDER` (project, local) never take
 * part in a top-level resolution — that is the observed model, not an oversight.
 */
export function resolveTopLevelKey(tiers: SettingsTierMap, key: string): SettingsTier[] {
  return tiersDefining(tiers, key, TOP_LEVEL_KEY_ORDER, [key]);
}

/**
 * Resolve a **merged** settings key through `MERGED_KEY_ORDER`.
 *
 * The key may be a dotted path (`skills.my-skill`) so that a merged setting can be
 * resolved per leaf. Returns every tier that defines the key, highest first.
 */
export function resolveMergedKey(tiers: SettingsTierMap, key: string): SettingsTier[] {
  return tiersDefining(tiers, key, MERGED_KEY_ORDER, splitPath(key));
}

/**
 * The tier that supplies a top-level key, or `null` when no tier defines it.
 *
 * Uses the top-level ordering, which is the target's default resolution path for a
 * plain settings key. Use `effectiveMergedSource` for merged settings.
 */
export function effectiveSource(tiers: SettingsTierMap, key: string): SettingsSource | null {
  return resolveTopLevelKey(tiers, key)[0]?.source ?? null;
}

/** The tier that supplies a merged key, or `null` when no tier defines it. */
export function effectiveMergedSource(tiers: SettingsTierMap, key: string): SettingsSource | null {
  return resolveMergedKey(tiers, key)[0]?.source ?? null;
}

/**
 * Whole-block override: the highest tier that defines the block wins **as a whole**
 * and the block is never merged key by key with a lower tier.
 */
export function resolveBlock(tiers: SettingsTierMap, key: string): SettingsTier | undefined {
  for (const source of TIER_PRECEDENCE) {
    if (!tiers.has(source)) continue;
    const document = documentOf(tiers.get(source), source);
    const lookup = lookupPath(document, [key]);
    if (lookup.found) return { source, value: lookup.value };
  }
  return undefined;
}

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

/**
 * Merge two documents key by key. A key defined by `high` replaces the value from
 * `low`; two plain objects are merged recursively so that e.g. two tiers that each
 * define a different skill both survive.
 */
export function mergeDocuments(
  low: Record<string, unknown>,
  high: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...low };
  for (const [key, value] of Object.entries(high)) {
    const existing = merged[key];
    if (isPlainObjectRecord(existing) && isPlainObjectRecord(value)) {
      merged[key] = mergeDocuments(existing, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Merge two documents at **block** granularity: a key defined by `high` replaces the
 * value from `low` entirely. This is the rule the target states for a higher tier's
 * block, and it is what the legacy local settings merge uses.
 */
export function mergeBlockwise(
  low: Record<string, unknown>,
  high: Record<string, unknown>,
): Record<string, unknown> {
  return { ...low, ...high };
}

/**
 * The merged-settings document: every merged key takes the value of the first source
 * in `MERGED_KEY_ORDER` that defines it.
 */
export function mergeMergedSettings(tiers: SettingsTierMap): Record<string, unknown> {
  let merged: Record<string, unknown> = {};
  // Fold from the lowest tier upwards so the highest tier wins per key.
  for (const source of [...MERGED_KEY_ORDER].reverse()) {
    if (!tiers.has(source)) continue;
    const document = documentOf(tiers.get(source), source);
    if (!isPlainObject(document)) continue;
    merged = mergeDocuments(merged, document);
  }
  return merged;
}

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
 * The audit's §2.7 final line is explicit about what is *not* known: "the per-key
 * merge for ordinary (non-merged, non-top-level) settings keys is not derived". The
 * ordinary-key path is therefore an **open gap in the evidence**, and this module
 * never claims otherwise.
 *
 * Implementation choices (the audit does not pin them, so they are marked as such here):
 *
 *   - `TIER_PRECEDENCE` is the *composition* used for the whole-block rule. It is
 *     consistent with both observed orderings (policy > flag > user, and
 *     local > project > user) but the audit does not state a block ordering, so this
 *     ordering is a reimplementation decision and is not claimed as target-verified.
 *   - `effectiveOrdinarySource` resolves an **ordinary** key (neither a top-level nor
 *     a merged key). The target's per-key merge for ordinary keys is **not derived**
 *     from the target — see the audit's §2.7 final line — so this function is an
 *     **underived implementation choice**: this implementation applies the one precedence rule the audit
 *     *does* state (the whole-block rule) to the tiers the two observed orderings do
 *     not cover. It is not a claim about the target.
 *   - `effectiveSource` resolves through the **observed** top-level order only. It
 *     says nothing about ordinary keys; a caller that wants the ordinary path must
 *     ask for it explicitly with `effectiveOrdinarySource`.
 *   - `resolveTopLevelKey` reads a *literal top-level* key; `resolveMergedKey`
 *     accepts a dotted path so that a merged setting can be resolved per leaf
 *     (`skills.my-skill`).
 *   - `SETTINGS_SOURCES` is a **membership list, not an ordering**. It is a reimplementation
 *     convenience for iterating the five sources; it is not a fifth observed
 *     ordering.
 *   - A tier wrapper is a `SettingsTierEntry` **instance**. The resolvers unwrap
 *     instances only, so a legal settings document is never mistaken for a wrapper
 *     (the target preserves unknown keys, so `{"source": ..., "value": ...}` is a
 *     legal document).
 */

/** The five settings sources the target names. */
export type SettingsSource =
  | 'policySettings'
  | 'flagSettings'
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings';

/**
 * The five sources as a **membership list**. The array order is *not* meaningful:
 * the audit observes four orderings (`TOP_LEVEL_KEY_ORDER`, `MERGED_KEY_ORDER`,
 * `D_` and `VD`) and this is not one of them. Implementation convenience, not observed.
 */
export const SETTINGS_SOURCES: readonly SettingsSource[] = [
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

/**
 * Per-key scope restrictions, as observed in the target.
 *
 * The target's own message states that "a spellcheck block in project or local
 * settings is ignored, whatever else is configured; set it in your user settings
 * instead", so `spellcheck` resolves from the user tier only. The block resolver and
 * the scope readers both consult this table, so they cannot disagree.
 */
export const KEY_SCOPE_RESTRICTIONS: Readonly<Record<string, readonly SettingsSource[]>> = {
  spellcheck: ['userSettings'],
};

/** A single tier's contribution for a key. */
export interface SettingsTier {
  source: SettingsSource;
  value: unknown;
}

/**
 * The concrete tier wrapper.
 *
 * The class is the *type* discriminator between a tier wrapper and a raw settings
 * document: a settings document is always a plain object, so a legal document such
 * as `{"source": "userSettings", "value": {...}}` is never mistaken for a wrapper.
 */
export class SettingsTierEntry implements SettingsTier {
  readonly source: SettingsSource;
  readonly value: unknown;

  constructor(source: SettingsSource, value: unknown) {
    this.source = source;
    this.value = value;
  }
}

/** A map of source -> settings document (or -> `SettingsTier` wrapper). */
export type SettingsTierMap = Map<SettingsSource, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The settings document carried by a map entry.
 *
 * Only a `SettingsTierEntry` instance is unwrapped. A plain object is always a
 * settings document, so a document that happens to carry `source` and `value` keys
 * is never discarded.
 */
export function documentOf(entry: unknown): unknown {
  return entry instanceof SettingsTierEntry ? entry.value : entry;
}

/**
 * The documents of a tier map whose entries are tier wrappers.
 *
 * Use this when a caller built its tier entries as plain `{source, value}` objects
 * rather than as `SettingsTierEntry` instances.
 */
export function documentsOf(tiers: ReadonlyMap<SettingsSource, SettingsTier>): Map<SettingsSource, unknown> {
  const documents = new Map<SettingsSource, unknown>();
  for (const [source, entry] of tiers) {
    if (entry instanceof SettingsTierEntry) {
      documents.set(source, entry.value);
      continue;
    }
    if (isPlainObject(entry) && Object.prototype.hasOwnProperty.call(entry, 'value')) {
      documents.set(source, entry['value']);
      continue;
    }
    documents.set(source, entry);
  }
  return documents;
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
    const document = documentOf(tiers.get(source));
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
 * The tier that supplies a **top-level** key, or `null` when no tier defines it.
 *
 * This resolves through the *observed* top-level order (`policySettings`,
 * `flagSettings`, `userSettings`) and nothing else. It says **nothing** about
 * ordinary keys: the target's per-key merge for ordinary keys is not derived
 * (audit §2.7, final line), so this function must not be read as "the tier the
 * target would use for any key".
 *
 * Use `effectiveOrdinarySource` for an ordinary key — that path is an explicitly
 * underived implementation choice — and `resolveMergedKey` for a merged key.
 */
export function effectiveSource(tiers: SettingsTierMap, key: string): SettingsSource | null {
  return resolveTopLevelKey(tiers, key)[0]?.source ?? null;
}

/**
 * The tier that supplies an **ordinary** key — one that is neither a top-level key
 * nor a merged key.
 *
 * The target's per-key merge for ordinary keys is **not derived** from the target
 * (audit §2.7, final line: "the per-key merge for ordinary (non-merged,
 * non-top-level) settings keys is not derived"). This function is therefore an
 * **underived implementation choice**, not an observed behaviour: this implementation resolves an
 * ordinary key with the whole-block rule — the one precedence rule the audit *does*
 * state — applied over the tiers the two observed orderings do not cover, and it
 * honours the observed per-key scope restrictions (`spellcheck` is user-only).
 */
export function effectiveOrdinarySource(tiers: SettingsTierMap, key: string): SettingsSource | null {
  return resolveBlock(tiers, key)?.source ?? null;
}

/**
 * Whole-block override: the highest tier that defines the block wins **as a whole**
 * and the block is never merged key by key with a lower tier.
 *
 * A key with an observed scope restriction (`spellcheck`) only resolves from a tier
 * the restriction allows, so a spellcheck block in project or local settings is
 * ignored exactly as the target's own message says.
 */
export function resolveBlock(tiers: SettingsTierMap, key: string): SettingsTier | undefined {
  const allowed = KEY_SCOPE_RESTRICTIONS[key];
  for (const source of TIER_PRECEDENCE) {
    if (allowed && !allowed.includes(source)) continue;
    if (!tiers.has(source)) continue;
    const document = documentOf(tiers.get(source));
    const lookup = lookupPath(document, [key]);
    if (lookup.found) return { source, value: lookup.value };
  }
  return undefined;
}

/** Keys that must never be copied onto a merged object. */
const UNSAFE_MERGE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Merge two documents key by key. A key defined by `high` replaces the value from
 * `low`; two plain objects are merged recursively so that e.g. two tiers that each
 * define a different skill both survive.
 *
 * `__proto__`, `constructor` and `prototype` are never copied: a settings file is
 * attacker-influenced data and must not be able to replace the prototype of the
 * object it is merged into.
 */
export function mergeDocuments(
  low: Record<string, unknown>,
  high: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...low };
  for (const [key, value] of Object.entries(high)) {
    if (UNSAFE_MERGE_KEYS.has(key)) continue;
    const existing = merged[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
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
  const merged: Record<string, unknown> = { ...low };
  for (const [key, value] of Object.entries(high)) {
    if (UNSAFE_MERGE_KEYS.has(key)) continue;
    merged[key] = value;
  }
  return merged;
}

/**
 * The merged-settings document: every merged key takes the value of the first source
 * in `MERGED_KEY_ORDER` that defines it.
 *
 * Implementation choice (not observed): the audit says "the first source that defines a key
 * wins" but does not define the granularity of a merged key. This implementation merges per
 * **leaf**, so two tiers that define different skills both survive, and the higher
 * tier wins the leaves it defines.
 */
export function mergeMergedSettings(tiers: SettingsTierMap): Record<string, unknown> {
  let merged: Record<string, unknown> = {};
  // Fold from the lowest tier upwards so the highest tier wins per key.
  for (const source of [...MERGED_KEY_ORDER].reverse()) {
    if (!tiers.has(source)) continue;
    const document = documentOf(tiers.get(source));
    if (!isPlainObject(document)) continue;
    merged = mergeDocuments(merged, document);
  }
  return merged;
}

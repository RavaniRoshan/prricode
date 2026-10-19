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
 *     legal document). `documentsOf` is the single, explicit exception: it is an
 *     escape hatch for callers that built their tier entries as plain
 *     `{source, value}` objects.
 *   - A key with a **scope restriction** may only be supplied by the tiers the
 *     restriction names, on **every** path (top-level, merged, block and per-tier).
 *     A project or local definition of a restricted key is therefore *ignored
 *     entirely* rather than merely out-ranked.
 *   - Every lookup that indexes a plain object with a caller-supplied key uses an
 *     **own-property** check. The target preserves unknown keys, so a legal
 *     settings document may carry a key named `constructor` (or any other
 *     `Object.prototype` member); such a key is simply unrestricted, never a crash.
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
 * instead", so `spellcheck` resolves from the user tier only. The audit records
 * the same separation: `spellcheck` is scoped to a single tier, the user tier.
 *
 * This table is the **single place** a restriction is declared. Every path that
 * resolves a key from the tiers — the top-level, merged, block and per-tier
 * resolvers — consults it through `keyScopeRestriction`, so they cannot disagree.
 *
 * The table is a plain object, so a lookup must never be a bare index: the target
 * preserves unknown keys, and a legal settings document may therefore carry a key
 * named `constructor` (or any other `Object.prototype` member). `keyScopeRestriction`
 * reads the table with an own-property check, so such a key is *unrestricted*
 * rather than a crash.
 */
export const KEY_SCOPE_RESTRICTIONS: Readonly<Record<string, readonly SettingsSource[]>> = {
  spellcheck: ['userSettings'],
};

/**
 * The scope restriction that applies to a key, or `undefined` when the key is
 * unrestricted.
 *
 * The lookup is an **own-property** check, so a key that names an
 * `Object.prototype` member (`constructor`, `toString`, `hasOwnProperty`,
 * `valueOf`, `__proto__`) is reported as unrestricted instead of resolving to the
 * inherited member.
 */
export function keyScopeRestriction(key: string): readonly SettingsSource[] | undefined {
  if (!Object.hasOwn(KEY_SCOPE_RESTRICTIONS, key)) return undefined;
  const allowed = KEY_SCOPE_RESTRICTIONS[key];
  return Array.isArray(allowed) ? allowed : undefined;
}

/**
 * Whether a tier may supply a key.
 *
 * A key with no restriction may come from any tier; a restricted key may only
 * come from a tier the restriction names, so a restricted key that a project or
 * local tier defines is ignored **entirely** rather than out-ranked.
 */
export function isSourceAllowedForKey(key: string, source: SettingsSource): boolean {
  const allowed = keyScopeRestriction(key);
  if (!allowed) return true;
  return allowed.includes(source);
}

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
 * Whether a plain object is a **wrapper** in the `{source, value}` shape.
 *
 * A wrapper must carry **both** a `source` and a `value` own key, and the `source`
 * must name one of the settings sources. Requiring the `source` key is what keeps
 * a legal settings document that merely carries a `value` key from being mistaken
 * for a wrapper.
 */
function isPlainTierWrapper(entry: unknown): entry is { source: SettingsSource; value: unknown } {
  if (!isPlainObject(entry)) return false;
  if (!Object.hasOwn(entry, 'source') || !Object.hasOwn(entry, 'value')) return false;
  const source = entry['source'];
  return typeof source === 'string' && (SETTINGS_SOURCES as readonly string[]).includes(source);
}

/**
 * The documents of a tier map whose entries are tier wrappers.
 *
 * Use this when a caller built its tier entries as plain `{source, value}` objects
 * rather than as `SettingsTierEntry` instances. This is the **only** place in the
 * module that recognises a plain wrapper object, and it recognises one only when
 * the object carries a `source` *and* a `value` own key and the `source` names a
 * settings source. A settings document that carries only a `value` key is never
 * unwrapped.
 *
 * A document that carries *both* a `source` and a `value` key is ambiguous and is
 * unwrapped here; the resolvers use `documentOf`, which unwraps `SettingsTierEntry`
 * instances only and therefore never mistakes such a document for a wrapper.
 */
export function documentsOf(tiers: ReadonlyMap<SettingsSource, unknown>): Map<SettingsSource, unknown> {
  const documents = new Map<SettingsSource, unknown>();
  for (const [source, entry] of tiers) {
    if (entry instanceof SettingsTierEntry) {
      documents.set(source, entry.value);
      continue;
    }
    if (isPlainTierWrapper(entry)) {
      documents.set(source, entry.value);
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
  restrictionKey: string,
): SettingsTier[] {
  const resolved: SettingsTier[] = [];
  for (const source of order) {
    // A restricted key is ignored entirely for a tier the restriction does not
    // name, so it never takes part in the resolution at all.
    if (!isSourceAllowedForKey(restrictionKey, source)) continue;
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
 *
 * A key with a scope restriction (`spellcheck`) may only be supplied by a tier the
 * restriction names, so the restriction is honoured here as well.
 */
export function resolveTopLevelKey(tiers: SettingsTierMap, key: string): SettingsTier[] {
  return tiersDefining(tiers, key, TOP_LEVEL_KEY_ORDER, [key], key);
}

/**
 * Resolve a **merged** settings key through `MERGED_KEY_ORDER`.
 *
 * The key may be a dotted path (`skills.my-skill`) so that a merged setting can be
 * resolved per leaf. Returns every tier that defines the key, highest first.
 *
 * A key with a scope restriction (`spellcheck`) may only be supplied by a tier the
 * restriction names. The restriction is declared against the **root** key of the
 * path, so `skills.my-skill` is restricted by a restriction on `skills`.
 */
export function resolveMergedKey(tiers: SettingsTierMap, key: string): SettingsTier[] {
  const path = splitPath(key);
  const restrictionKey = path[0] ?? key;
  return tiersDefining(tiers, key, MERGED_KEY_ORDER, path, restrictionKey);
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
  for (const source of TIER_PRECEDENCE) {
    if (!isSourceAllowedForKey(key, source)) continue;
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
 * The part of a document a source may contribute: every key the source is allowed
 * to supply, and nothing else.
 *
 * A restricted key is **ignored entirely** for a source the restriction does not
 * name — it is not merely out-ranked — so a project or local `spellcheck` block
 * never reaches the merged document.
 *
 * The keys are defined rather than assigned, so that a key named `__proto__`
 * becomes an own data property instead of replacing the prototype of the object.
 */
function restrictDocument(
  document: Record<string, unknown>,
  source: SettingsSource,
): Record<string, unknown> {
  const allowed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (!isSourceAllowedForKey(key, source)) continue;
    Object.defineProperty(allowed, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return allowed;
}

/**
 * The merged-settings document: every merged key takes the value of the first source
 * in `MERGED_KEY_ORDER` that defines it.
 *
 * Implementation choice (not observed): the audit says "the first source that defines a key
 * wins" but does not define the granularity of a merged key. This implementation merges per
 * **leaf**, so two tiers that define different skills both survive, and the higher
 * tier wins the leaves it defines.
 *
 * A key with a scope restriction (`spellcheck`) is honoured here as well: a project
 * or local definition of a restricted key is ignored entirely, so only a tier the
 * restriction names contributes it.
 */
export function mergeMergedSettings(tiers: SettingsTierMap): Record<string, unknown> {
  let merged: Record<string, unknown> = {};
  // Fold from the lowest tier upwards so the highest tier wins per key.
  for (const source of [...MERGED_KEY_ORDER].reverse()) {
    if (!tiers.has(source)) continue;
    const document = documentOf(tiers.get(source));
    if (!isPlainObject(document)) continue;
    merged = mergeDocuments(merged, restrictDocument(document, source));
  }
  return merged;
}

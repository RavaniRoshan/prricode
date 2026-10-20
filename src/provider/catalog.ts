/**
 * The provider-owned model catalog.
 *
 * **What is observed and reproduced here.** The target's model catalog is a
 * **built-in, provider-owned table** — a hand-maintained literal in
 * `chunk-w4f5s3e0.js` with `schema_version: 1`, a `pricing_tiers` table and a
 * `models` array (audit §2.1, "Model catalog"). Each row carries one logical
 * model id and a per-provider model id for each of the eight provider routes.
 *
 * **What is a project extension.** The *connection registry* is the extension
 * (`src/provider/registry.ts`); the catalog itself is the target's, and the
 * implementation reproduces it. The one thing this implementation adds here is the ability to
 * *import* a catalog from another source (`importCatalog`) so a connection may
 * declare `catalogSource: 'file' | 'url'`; the built-in table itself is a
 * transcription of the target's literal.
 *
 * ## The one load-bearing distinction: "not served" is not "unknown"
 *
 * In the target's literal, `provider_ids` has one key per provider and a
 * **`null`** value means *this provider does not serve this model*. That is a
 * **fact**, and the target's route selector uses it: `wd(model)` falls back to
 * `mantle` when the selected route's entry is `null` while `mantle`'s is not
 * (audit §2.1). This implementation keeps the same information with the same
 * **three** states:
 *
 * ```ts
 * providerIds: Partial<Record<ProviderRoute, string | null>>;
 * //  a string  → the route serves the model, with that id
 * //  null      → the route does not serve the model (the target's marker)
 * //  absent    → the target's literal does not carry the key at all
 * ```
 *
 * The third state is **not** "unknown" in the sense of "we do not know": it is
 * the target's own literal, which omits exactly one key (`claude-haiku-5-5`
 * carries no `gateway` key). The target's predicate is
 * `provider_ids[route] === null`, and an omitted key is **not** `null`, so the
 * target does not treat that row as unserved by `gateway`.
 *
 * {@link notServedOn} is that predicate, verbatim, and
 * {@link resolveRouteForModel} applies it.
 *
 * ## The two provider naming schemes
 *
 * The target's catalog keys its providers in **snake_case**
 * (`first_party`, `anthropic_aws`, `anthropic_google_cloud`, …). This implementation's
 * routes are **camelCase** (`firstParty`, `anthropicAws`,
 * `anthropicGoogleCloud`, …). The mapping between them is **explicit** — see
 * `PROVIDER_ID_KEYS` — and is not left to coincidence: `importCatalog`
 * translates the target's keys, and it **rejects** an unknown key rather than
 * dropping it.
 *
 * ## The per-model override: both halves of the target's rule
 *
 * `wd(model)` in the target layers a per-model override on top of the route
 * selector, and the rule has **two** halves (audit §2.1):
 *
 *   (a) *"with Bedrock and Mantle both enabled, an `anthropic.*` model
 *       resolves to `mantle`"* — **target-observed, and implemented**;
 *   (b) *"otherwise, if the catalog has no id for the selected route but has
 *       one for `mantle`, the model resolves to `mantle`"* — implemented.
 *
 * Half (b) is `resolveModel`; `resolveModelRoute` reports the route it
 * resolved to. `providerIdFor` deliberately does **not** fall back: it is the
 * strict per-route lookup — it answers with the route's id or with nothing —
 * and it is what the usable-model list is built from.
 *
 * ### Half (a): the enabled-flag set
 *
 * Half (a) needs the **enabled-flag set** — which of the provider flags the
 * user turned on — so this module now takes one: `resolveRouteForModel` has
 * an optional third argument, the set of routes the user's configuration
 * turned on (`enabledRoutes` in `src/provider/routes.ts`). When that set
 * holds `bedrock` **and** `mantle`, an `anthropic.*` model resolves to
 * `mantle`, and the redirect is applied **before** the half-(b) fallback,
 * because the target's rule reads "with Bedrock and Mantle both enabled ...
 * otherwise, if the catalog has no id for the selected route ...".
 *
 * The rule was **not implemented** while this module resolved a model against
 * a route and nothing else: nothing here knew which flags the user had
 * turned on, so the override was left out and labelled rather than silently
 * approximated. The argument that carries the **enabled-flag set** is what
 * made it implementable, and it is the wiring point for it —
 * `resolveRouteForModel` is the single function that `resolveModel`,
 * `resolveModelRoute` and `normalizeModel` all go through for the route
 * decision.
 *
 * The argument is **optional** and the override is **off** when it is absent,
 * so every caller that does not pass the set keeps exactly the behaviour it
 * had. A caller that owns the set (the driver layer, CC-006) passes it in.
 *
 * **What an `anthropic.*` model is.** The target's Mantle model ids are the
 * `anthropic.`-prefixed ones (`anthropic.claude-haiku-4-5`,
 * `anthropic.claude-sonnet-5`, …) and no other route's id carries the prefix,
 * so the model is one when the **mantle** route serves it under such an id.
 * Ten of the target's 22 rows are such models.
 *
 * **The override is decided by the enabled-flag set alone**, exactly as the
 * audit states the rule; the route the selector picked does not enter into it.
 * In the target the two always agree — Bedrock is enabled, so the selector
 * picks it — so the difference cannot be observed there. This implementation's own
 * `gateway` setting is the one case where they can differ, because the
 * gateway wins the dispatch order while the rule is about the Bedrock and
 * Mantle pair.
 *
 * ## "Not served" is the target's own predicate
 *
 * The audit states half (b) as `provider_ids[route] === null` while
 * `provider_ids[mantle] !== null`, and that is the predicate this
 * implementation applies:
 *
 *   - an explicit `null` in the target's literal — every "not served" entry
 *     but one — is the audited case, and this implementation's test matches it;
 *   - the target's literal **omits** the `gateway` key for exactly one row
 *     (`claude-haiku-5-5`). An omitted key is not `null`, so the target's
 *     predicate does **not** fire for it: the target does not treat that row
 *     as unserved by `gateway`, and neither does this implementation.
 *
 * The three states are kept apart, so the predicate is the target's rather than
 * a superset of it. See {@link notServedOn}.
 */

import { ROUTE_NAMES, isProviderRoute, type ProviderRoute } from './routes.js';
import BUILTIN_CATALOG_JSON from './catalogs/builtin.json' with { type: 'json' };

/** The catalog schema version this build understands. */
export const CATALOG_SCHEMA_VERSION = 1;

/**
 * The connection id a catalog carries when it is not bound to a connection.
 *
 * The built-in catalog is shared by every connection, so it is not owned by
 * one; `builtinCatalogFor` stamps a connection id onto a copy when a caller
 * needs one.
 */
export const DEFAULT_CATALOG_CONNECTION_ID = 'builtin';

/**
 * The **explicit** map from the target's `provider_ids` key names to the
 * implementation's route names.
 *
 * The two schemes differ (`first_party` vs `firstParty`), so the translation
 * is written out rather than derived. A lookup goes through
 * `routeForProviderKey`, which performs an **own-property** check, so a key
 * that collides with an `Object.prototype` member (`constructor`, `toString`,
 * `__proto__`, …) is reported as unknown instead of resolving to the inherited
 * member.
 */
export const PROVIDER_ID_KEYS: Readonly<Record<string, ProviderRoute>> = Object.freeze({
  first_party: 'firstParty',
  bedrock: 'bedrock',
  vertex: 'vertex',
  foundry: 'foundry',
  anthropic_aws: 'anthropicAws',
  anthropic_google_cloud: 'anthropicGoogleCloud',
  mantle: 'mantle',
  gateway: 'gateway',
});

/**
 * The reverse map, as a `Map` so that a lookup can never resolve an inherited
 * `Object.prototype` member.
 */
export const PROVIDER_KEY_BY_ROUTE: ReadonlyMap<ProviderRoute, string> = new Map<ProviderRoute, string>(
  (Object.entries(PROVIDER_ID_KEYS) as Array<[string, ProviderRoute]>).map(
    ([key, route]) => [route, key] as [ProviderRoute, string],
  ),
);

/**
 * The route a target `provider_ids` key names, or `undefined` for a key the
 * target's catalog does not use.
 */
export function routeForProviderKey(key: string): ProviderRoute | undefined {
  if (!Object.hasOwn(PROVIDER_ID_KEYS, key)) return undefined;
  return PROVIDER_ID_KEYS[key];
}

/** The target's `provider_ids` key for a route, or `undefined` for an unknown route. */
export function providerKeyForRoute(route: ProviderRoute): string | undefined {
  return PROVIDER_KEY_BY_ROUTE.get(route);
}

/**
 * One row of the catalog: a logical model and the provider-specific ids it
 * carries.
 *
 * The plan's interface, widened with the extra fields the target's catalog
 * carries (`advisor_rank`, `context`, `default_effort`, `effort_cost_index`,
 * `fallback_3p`, `image_limits`) so that nothing is dropped in the
 * transcription.
 *
 * Two widenings of the plan's first draft are deliberate:
 *
 *   - `context.supports1mSuffix` — the target's `context` objects carry a
 *     `supports_1m_suffix` flag next to `native_1m` and `supports_1m_beta`,
 *     and dropping it would lose observed data;
 *   - `effortCostIndex` is `number | Record<string, number>` — the plan's
 *     first draft wrote `number`, but the target's `effort_cost_index` is a
 *     **table** keyed by effort level (`low`, `medium`, `high`, `xhigh`,
 *     `max`). `number` is still a valid value, so a plan-conforming consumer
 *     keeps type-checking.
 */
export interface CatalogModel {
  /** The logical model id, e.g. `claude-haiku-4-5`. */
  id: string;
  /** The model family: `haiku`, `sonnet`, `opus`, `fable` or `mythos`. */
  family: string;
  /** The display name, e.g. `Haiku 4.5`. */
  displayName: string;
  /** The knowledge cutoff, as the target writes it (e.g. `February 2025`). */
  knowledgeCutoff?: string;
  /**
   * The provider-specific model ids, keyed by route.
   *
   * The map is the target's own `provider_ids`, translated key by key:
   *
   *   - a **string** is the provider's id for the model — the route serves it;
   *   - **`null`** is the target's "this provider does not serve this model" —
   *     the marker the target's own route selector tests (`provider_ids[route]
   *     === null`, audit §2.1);
   *   - an **absent** key is a key the target's literal does not carry. The
   *     target's own literal omits exactly one (`claude-haiku-5-5` has no
   *     `gateway` key), and an omitted key is **not** `null`: the target's
   *     predicate does not fire for it.
   *
   * The three states are therefore distinct, and `null` is never "unknown" —
   * it is the target's own "not served".
   */
  providerIds: Partial<Record<ProviderRoute, string | null>>;
  /** Whether a route streams the request body eagerly. */
  eagerInputStreaming: Partial<Record<ProviderRoute, boolean>>;
  /** The environment variable that carries the Vertex region for this model. */
  vertexRegionEnvVar?: string;
  /** The default and the upper bound of the model's output tokens. */
  maxOutputTokens: { default: number; upper: number };
  /** The pricing tier key into the catalog's `pricing_tiers` table. */
  pricing?: string;
  /** The target's capability names for this model. */
  capabilities: string[];
  /** Additional fields the target's catalog carries; preserved rather than dropped. */
  advisorRank?: number;
  context?: {
    window: number;
    native1m?: boolean;
    supports1mBeta?: boolean;
    supports1mSuffix?: boolean;
  };
  defaultEffort?: string;
  effortCostIndex?: number | Record<string, number>;
  fallback3p?: string;
  imageLimits?: Record<string, unknown>;
}

/** One pricing tier of the catalog's `pricing_tiers` table. */
export interface PricingTier {
  input: number;
  output: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  cacheRead?: number;
  webSearch?: number;
  longPrompt?: {
    abovePromptTokens: number;
    input: number;
    output: number;
    cacheWrite5m?: number;
    cacheWrite1h?: number;
    cacheRead?: number;
  };
}

/** A family alias: the default model and the per-provider overrides. */
export interface CatalogAlias {
  default: string;
  perProvider?: Partial<Record<ProviderRoute, string>>;
}

/**
 * A model catalog.
 *
 * The first three members are the plan's interface. The rest preserve the
 * target's other tables (`pricing_tiers`, `aliases`, `defaults`, `best`,
 * `latest_per_family`, `alias_migration`) instead of dropping them, and are
 * therefore optional.
 */
export interface ModelCatalog {
  /** The connection this catalog belongs to. */
  connectionId: string;
  /** The catalog schema version. */
  schemaVersion: number;
  /** The catalog rows. */
  models: CatalogModel[];
  /** The target's pricing tiers, preserved. */
  pricingTiers?: Record<string, PricingTier>;
  /** The target's family aliases, preserved. */
  aliases?: Record<string, CatalogAlias>;
  /** The target's `defaults` table, preserved. */
  defaults?: Record<string, unknown>;
  /** The target's `best` family, preserved. */
  best?: string;
  /** The target's `latest_per_family` table, preserved. */
  latestPerFamily?: Record<string, string>;
  /** The target's `alias_migration` table, preserved. */
  aliasMigration?: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Copies                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A deep copy of a JSON-shaped value.
 *
 * The catalog is a table of plain data — strings, numbers, booleans, arrays
 * and plain objects — so a structural copy is enough to make a value
 * unreachable from the copy it was taken from.
 */
function copyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => copyValue(entry));
  if (typeof value === 'object' && value !== null) {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) copy[key] = copyValue(entry);
    return copy;
  }
  return value;
}

/**
 * A deep copy of one catalog row.
 *
 * The row's own maps (`providerIds`, `eagerInputStreaming`), its
 * `max_output_tokens` table, its capability list and its `context` are copied
 * as well, so a caller that edits one of them cannot reach the row it came
 * from.
 */
function copyModel(model: CatalogModel): CatalogModel {
  return copyValue(model) as CatalogModel;
}

/** A deep copy of a whole catalog. */
function copyCatalog(catalog: ModelCatalog): ModelCatalog {
  return copyValue(catalog) as ModelCatalog;
}

/**
 * Freeze a value and everything it holds.
 *
 * The built-in catalog is a module-level singleton shared by every
 * connection, so it is frozen: a caller cannot corrupt the shared table by
 * editing the exported object. Callers that need to change a catalog take a
 * copy (`builtinCatalogFor`, `listModels`).
 */
function deepFreeze(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
    Object.freeze(value);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
}

/* -------------------------------------------------------------------------- */
/* Lookups                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The provider-specific model id for a route, or `undefined` when the route
 * does not serve the model.
 *
 * The lookup is **strict**: it answers with the id, or with nothing. A `null`
 * entry — the target's "not served" — and an absent entry both answer with
 * nothing, and the two are told apart by {@link notServedOn}. An own-property
 * check guards the lookup, so a route name that collides with an
 * `Object.prototype` member never resolves to the inherited member.
 */
export function providerIdFor(model: CatalogModel, route: ProviderRoute): string | undefined {
  const ids = model.providerIds;
  if (ids === null || typeof ids !== 'object') return undefined;
  if (!Object.hasOwn(ids, route)) return undefined;
  const value = ids[route];
  if (typeof value !== 'string' || value === '') return undefined;
  return value;
}

/**
 * Whether the route **does not serve** the model.
 *
 * **This is the target's own predicate**: `provider_ids[route] === null`
 * (audit §2.1, "Route selection"). The target's literal marks a route it does
 * not serve with `null`, and its route selector tests exactly that.
 *
 * An **absent** key is **not** "not served": the target's own literal omits
 * one key (`claude-haiku-5-5` carries no `gateway` key), and an omitted key
 * is not `null`, so the target's predicate does not fire for it. This
 * implementation keeps the three states apart, so the predicate is the
 * target's and not a superset of it.
 */
export function notServedOn(model: CatalogModel, route: ProviderRoute): boolean {
  const ids = model.providerIds;
  if (ids === null || typeof ids !== 'object') return false;
  if (!Object.hasOwn(ids, route)) return false;
  return ids[route] === null;
}

/** The catalog row with a logical model id, or `undefined`. */
export function findModel(catalog: ModelCatalog, modelId: string): CatalogModel | undefined {
  if (!Array.isArray(catalog.models)) return undefined;
  return catalog.models.find((model) => model.id === modelId);
}

/**
 * The prefix the target's `anthropic.*` model ids carry.
 *
 * The target's Mantle model ids are the `anthropic.`-prefixed ones
 * (`anthropic.claude-haiku-4-5`, `anthropic.claude-sonnet-5`, …), and the
 * target's per-model override names a model by that prefix (audit §2.1). It is
 * the **mantle** id that carries it: no other route's id does.
 */
const ANTHROPIC_MODEL_PREFIX = 'anthropic.';

/**
 * Whether the model is one of the target's `anthropic.*` models.
 *
 * A model is one when the **mantle** route serves it under an
 * `anthropic.`-prefixed id. An absent mantle id means the mantle route does
 * not serve the model at all, and such a model is not an `anthropic.*` one.
 */
function isAnthropicModel(model: CatalogModel): boolean {
  const mantleId = providerIdFor(model, 'mantle');
  return mantleId !== undefined && mantleId.startsWith(ANTHROPIC_MODEL_PREFIX);
}

/**
 * The route a model resolves to for a selected route.
 *
 * This is the target's `wd(model)` override (audit §2.1), which has **two**
 * halves:
 *
 *   (a) *"with Bedrock and Mantle both enabled, an `anthropic.*` model
 *       resolves to `mantle`"* — applied when `enabled` holds both `bedrock`
 *       and `mantle`, and **before** the fallback below;
 *   (b) *"otherwise, if the catalog has no id for the selected route but has
 *       one for `mantle`, the model resolves to `mantle`"* — the fallback.
 *
 * `enabled` is the **enabled-flag set** — the routes the user's configuration
 * turned on (`enabledRoutes` in `src/provider/routes.ts`). It is **optional**,
 * and the override is **off** when it is absent, so a caller that does not
 * pass the set keeps exactly the behaviour it had.
 *
 * `undefined` means the model is not served by the selected route and has no
 * `mantle` id either.
 */
export function resolveRouteForModel(
  model: CatalogModel,
  route: ProviderRoute,
  enabled?: ReadonlySet<ProviderRoute>,
): ProviderRoute | undefined {
  // Half (a) — the target's Bedrock+Mantle override. It is evaluated first,
  // because the target's rule reads "with Bedrock+Mantle enabled ...
  // otherwise, if the catalog has no id for the selected route ...".
  if (
    enabled !== undefined &&
    enabled.has('bedrock') &&
    enabled.has('mantle') &&
    isAnthropicModel(model)
  ) {
    return 'mantle';
  }
  // Half (b) — the mantle fallback, with the target's **own** predicate:
  // `provider_ids[route] === null` while `provider_ids[mantle] !== null`.
  // An **omitted** key is not `null`, so a route the target's literal does not
  // mention is not "not served" and the model stays on it.
  if (!notServedOn(model, route)) return route;
  if (route !== 'mantle' && !notServedOn(model, 'mantle')) return 'mantle';
  return undefined;
}

/**
 * The route a model resolves to for a selected route, looked up in a catalog.
 *
 * `undefined` means the catalog has no such model.
 *
 * `enabled` is the **enabled-flag set**; it is optional and the Bedrock+Mantle
 * override is off when it is absent.
 */
export function resolveModelRoute(
  catalog: ModelCatalog,
  modelId: string,
  route: ProviderRoute,
  enabled?: ReadonlySet<ProviderRoute>,
): ProviderRoute | undefined {
  const model = findModel(catalog, modelId);
  if (model === undefined) return undefined;
  return resolveRouteForModel(model, route, enabled);
}

/**
 * The provider-specific model id for a model on a route, or `undefined` when
 * the model is not served there.
 *
 * The target's `mantle` fallback applies: when the selected route has no id
 * for the model but `mantle` does, the model resolves to `mantle` and the
 * `mantle` id is returned. Use `resolveModelRoute` when the caller needs to
 * know *which* route the id belongs to, and `providerIdFor` when it needs the
 * strict per-route answer.
 *
 * The "no id for the route" test is the target's own predicate,
 * `provider_ids[route] === null` — see {@link notServedOn} and the module
 * header.
 *
 * `enabled` is the **enabled-flag set**; it is optional, and the
 * Bedrock+Mantle `anthropic.*` override is off when it is absent.
 */
export function resolveModel(
  catalog: ModelCatalog,
  modelId: string,
  route: ProviderRoute,
  enabled?: ReadonlySet<ProviderRoute>,
): string | undefined {
  const model = findModel(catalog, modelId);
  if (model === undefined) return undefined;
  const effectiveRoute = resolveRouteForModel(model, route, enabled);
  if (effectiveRoute === undefined) return undefined;
  return providerIdFor(model, effectiveRoute);
}

/**
 * The catalog rows, optionally filtered.
 *
 * `family` matches the family exactly (case-insensitively); `query` is a
 * case-insensitive substring match against the model id and the display name.
 * The returned array and its rows are **deep copies**, so a caller cannot
 * mutate the catalog through them.
 */
export function listModels(
  catalog: ModelCatalog,
  filter?: { family?: string; query?: string },
): CatalogModel[] {
  if (!Array.isArray(catalog.models)) return [];
  let models = [...catalog.models];

  if (filter?.family !== undefined) {
    const family = filter.family.trim().toLowerCase();
    models = models.filter((model) => model.family.toLowerCase() === family);
  }

  if (filter?.query !== undefined) {
    const query = filter.query.trim().toLowerCase();
    if (query !== '') {
      models = models.filter(
        (model) =>
          model.id.toLowerCase().includes(query) || model.displayName.toLowerCase().includes(query),
      );
    }
  }

  return models.map(copyModel);
}

/* -------------------------------------------------------------------------- */
/* Import                                                                     */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownValue(raw: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (Object.hasOwn(raw, name)) return raw[name];
  }
  return undefined;
}

function ownString(raw: Record<string, unknown>, ...names: string[]): string | undefined {
  const value = ownValue(raw, ...names);
  return typeof value === 'string' ? value : undefined;
}

function ownNumber(raw: Record<string, unknown>, ...names: string[]): number | undefined {
  const value = ownValue(raw, ...names);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function ownBoolean(raw: Record<string, unknown>, ...names: string[]): boolean | undefined {
  const value = ownValue(raw, ...names);
  return typeof value === 'boolean' ? value : undefined;
}

function ownRecord(raw: Record<string, unknown>, ...names: string[]): Record<string, unknown> | undefined {
  const value = ownValue(raw, ...names);
  return isRecord(value) ? value : undefined;
}

/**
 * The route a provider-id key names, in either naming scheme.
 *
 * The target's catalog keys its providers in snake_case (`first_party`); the
 * implementation's catalogs may use the route names themselves (`firstParty`). Both are
 * accepted, and a key that names neither is an error.
 */
function routeForProviderIdKey(key: string): ProviderRoute | undefined {
  const mapped = routeForProviderKey(key);
  if (mapped !== undefined) return mapped;
  if (isProviderRoute(key)) return key;
  return undefined;
}

/**
 * Convert a target-shaped `provider_ids` map into this implementation's route-keyed
 * map.
 *
 * The map is translated key by key, and the **values are kept as they are**:
 * a string is the provider's id and a `null` is the target's "this provider
 * does not serve this model" — the marker the target's own route selector
 * tests. A key the target's literal does not carry stays **absent**, because
 * an omitted key is not `null` and the target's predicate does not fire for
 * it.
 *
 * An unknown key is an error rather than a silent drop, so a typo in a
 * hand-maintained catalog is caught at import time.
 */
function convertProviderIds(
  raw: Record<string, unknown>,
  modelId: string,
): Partial<Record<ProviderRoute, string | null>> {
  const providerIds: Partial<Record<ProviderRoute, string | null>> = {};
  for (const [key, value] of Object.entries(raw)) {
    const route = routeForProviderIdKey(key);
    if (route === undefined) {
      throw new Error(`catalog model "${modelId}" has an unknown provider id key "${key}"`);
    }
    if (value === null) {
      // The target's "not served" marker, kept as it is.
      providerIds[route] = null;
      continue;
    }
    if (typeof value !== 'string' || value === '') {
      throw new Error(`catalog model "${modelId}" has a malformed provider id for "${key}"`);
    }
    providerIds[route] = value;
  }
  return providerIds;
}

function convertEagerInputStreaming(
  raw: Record<string, unknown> | undefined,
  modelId: string,
): Partial<Record<ProviderRoute, boolean>> {
  const eager: Partial<Record<ProviderRoute, boolean>> = {};
  if (raw === undefined) return eager;
  for (const [key, value] of Object.entries(raw)) {
    const route = routeForProviderIdKey(key);
    if (route === undefined) {
      throw new Error(`catalog model "${modelId}" has an unknown eager-input-streaming key "${key}"`);
    }
    if (typeof value !== 'boolean') {
      throw new Error(
        `catalog model "${modelId}" has a malformed eager-input-streaming value for "${key}"`,
      );
    }
    eager[route] = value;
  }
  return eager;
}

function convertContext(
  raw: Record<string, unknown> | undefined,
  modelId: string,
): CatalogModel['context'] | undefined {
  if (raw === undefined) return undefined;
  const window = ownNumber(raw, 'window');
  if (window === undefined) {
    throw new Error(`catalog model "${modelId}" has a context without a window`);
  }
  const context: NonNullable<CatalogModel['context']> = { window };
  const native1m = ownBoolean(raw, 'native_1m', 'native1m');
  if (native1m !== undefined) context.native1m = native1m;
  const supports1mBeta = ownBoolean(raw, 'supports_1m_beta', 'supports1mBeta');
  if (supports1mBeta !== undefined) context.supports1mBeta = supports1mBeta;
  const supports1mSuffix = ownBoolean(raw, 'supports_1m_suffix', 'supports1mSuffix');
  if (supports1mSuffix !== undefined) context.supports1mSuffix = supports1mSuffix;
  return context;
}

function convertEffortCostIndex(
  raw: unknown,
  modelId: string,
): CatalogModel['effortCostIndex'] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'number') return raw;
  if (!isRecord(raw)) {
    throw new Error(`catalog model "${modelId}" has a malformed effort cost index`);
  }
  const table: Record<string, number> = {};
  for (const [effort, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`catalog model "${modelId}" has a malformed effort cost index for "${effort}"`);
    }
    table[effort] = value;
  }
  return table;
}

/** Convert one target-shaped catalog row into this implementation's `CatalogModel`. */
function convertModel(raw: unknown, index: number): CatalogModel {
  if (!isRecord(raw)) {
    throw new Error(`catalog model #${index} is not an object`);
  }

  const id = ownString(raw, 'id');
  if (id === undefined || id.trim() === '') {
    throw new Error(`catalog model #${index} has no id`);
  }

  const family = ownString(raw, 'family');
  if (family === undefined || family === '') {
    throw new Error(`catalog model "${id}" has no family`);
  }

  const displayName = ownString(raw, 'display_name', 'displayName');
  if (displayName === undefined || displayName === '') {
    throw new Error(`catalog model "${id}" has no display name`);
  }

  const providerIdsRaw = ownRecord(raw, 'provider_ids', 'providerIds');
  if (providerIdsRaw === undefined) {
    throw new Error(`catalog model "${id}" has no provider ids`);
  }
  const providerIds = convertProviderIds(providerIdsRaw, id);

  const maxRaw = ownRecord(raw, 'max_output_tokens', 'maxOutputTokens');
  if (maxRaw === undefined) {
    throw new Error(`catalog model "${id}" has no max output tokens`);
  }
  const maxDefault = ownNumber(maxRaw, 'default');
  const maxUpper = ownNumber(maxRaw, 'upper');
  if (maxDefault === undefined || maxUpper === undefined) {
    throw new Error(`catalog model "${id}" has malformed max output tokens`);
  }

  const capabilitiesRaw = ownValue(raw, 'capabilities');
  let capabilities: string[] = [];
  if (capabilitiesRaw !== undefined) {
    if (!Array.isArray(capabilitiesRaw)) {
      throw new Error(`catalog model "${id}" has malformed capabilities`);
    }
    capabilities = capabilitiesRaw.map((entry) => {
      if (typeof entry !== 'string') {
        throw new Error(`catalog model "${id}" has a malformed capability`);
      }
      return entry;
    });
  }

  const model: CatalogModel = {
    id,
    family,
    displayName,
    providerIds,
    eagerInputStreaming: convertEagerInputStreaming(
      ownRecord(raw, 'eager_input_streaming', 'eagerInputStreaming'),
      id,
    ),
    maxOutputTokens: { default: maxDefault, upper: maxUpper },
    capabilities,
  };

  const knowledgeCutoff = ownString(raw, 'knowledge_cutoff', 'knowledgeCutoff');
  if (knowledgeCutoff !== undefined) model.knowledgeCutoff = knowledgeCutoff;

  const vertexRegionEnvVar = ownString(raw, 'vertex_region_env_var', 'vertexRegionEnvVar');
  if (vertexRegionEnvVar !== undefined) model.vertexRegionEnvVar = vertexRegionEnvVar;

  const pricing = ownString(raw, 'pricing');
  if (pricing !== undefined) model.pricing = pricing;

  const advisorRank = ownNumber(raw, 'advisor_rank', 'advisorRank');
  if (advisorRank !== undefined) model.advisorRank = advisorRank;

  const context = convertContext(ownRecord(raw, 'context'), id);
  if (context !== undefined) model.context = context;

  const defaultEffort = ownString(raw, 'default_effort', 'defaultEffort');
  if (defaultEffort !== undefined) model.defaultEffort = defaultEffort;

  const effortCostIndex = convertEffortCostIndex(
    ownValue(raw, 'effort_cost_index', 'effortCostIndex'),
    id,
  );
  if (effortCostIndex !== undefined) model.effortCostIndex = effortCostIndex;

  const fallback3p = ownString(raw, 'fallback_3p', 'fallback3p');
  if (fallback3p !== undefined) model.fallback3p = fallback3p;

  const imageLimits = ownRecord(raw, 'image_limits', 'imageLimits');
  if (imageLimits !== undefined) model.imageLimits = { ...imageLimits };

  return model;
}

function convertPricingTiers(
  raw: Record<string, unknown> | undefined,
): Record<string, PricingTier> | undefined {
  if (raw === undefined) return undefined;
  const tiers: Record<string, PricingTier> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      throw new Error(`pricing tier "${name}" is not an object`);
    }
    const input = ownNumber(value, 'input');
    const output = ownNumber(value, 'output');
    if (input === undefined || output === undefined) {
      throw new Error(`pricing tier "${name}" has no input/output price`);
    }
    const tier: PricingTier = { input, output };
    const cacheWrite5m = ownNumber(value, 'cache_write_5m', 'cacheWrite5m');
    if (cacheWrite5m !== undefined) tier.cacheWrite5m = cacheWrite5m;
    const cacheWrite1h = ownNumber(value, 'cache_write_1h', 'cacheWrite1h');
    if (cacheWrite1h !== undefined) tier.cacheWrite1h = cacheWrite1h;
    const cacheRead = ownNumber(value, 'cache_read', 'cacheRead');
    if (cacheRead !== undefined) tier.cacheRead = cacheRead;
    const webSearch = ownNumber(value, 'web_search', 'webSearch');
    if (webSearch !== undefined) tier.webSearch = webSearch;

    const longPromptRaw = ownRecord(value, 'long_prompt', 'longPrompt');
    if (longPromptRaw !== undefined) {
      const abovePromptTokens = ownNumber(longPromptRaw, 'above_prompt_tokens', 'abovePromptTokens');
      const longInput = ownNumber(longPromptRaw, 'input');
      const longOutput = ownNumber(longPromptRaw, 'output');
      if (abovePromptTokens === undefined || longInput === undefined || longOutput === undefined) {
        throw new Error(`pricing tier "${name}" has a malformed long prompt table`);
      }
      const longPrompt: NonNullable<PricingTier['longPrompt']> = {
        abovePromptTokens,
        input: longInput,
        output: longOutput,
      };
      const longCacheWrite5m = ownNumber(longPromptRaw, 'cache_write_5m', 'cacheWrite5m');
      if (longCacheWrite5m !== undefined) longPrompt.cacheWrite5m = longCacheWrite5m;
      const longCacheWrite1h = ownNumber(longPromptRaw, 'cache_write_1h', 'cacheWrite1h');
      if (longCacheWrite1h !== undefined) longPrompt.cacheWrite1h = longCacheWrite1h;
      const longCacheRead = ownNumber(longPromptRaw, 'cache_read', 'cacheRead');
      if (longCacheRead !== undefined) longPrompt.cacheRead = longCacheRead;
      tier.longPrompt = longPrompt;
    }

    tiers[name] = tier;
  }
  return tiers;
}

function convertAliases(
  raw: Record<string, unknown> | undefined,
): Record<string, CatalogAlias> | undefined {
  if (raw === undefined) return undefined;
  const aliases: Record<string, CatalogAlias> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      throw new Error(`alias "${name}" is not an object`);
    }
    const defaultModel = ownString(value, 'default');
    if (defaultModel === undefined) {
      throw new Error(`alias "${name}" has no default model`);
    }
    const alias: CatalogAlias = { default: defaultModel };
    const perProviderRaw = ownRecord(value, 'per_provider', 'perProvider');
    if (perProviderRaw !== undefined) {
      const perProvider: Partial<Record<ProviderRoute, string>> = {};
      for (const [key, modelId] of Object.entries(perProviderRaw)) {
        const route = routeForProviderIdKey(key);
        if (route === undefined) {
          throw new Error(`alias "${name}" has an unknown provider key "${key}"`);
        }
        if (typeof modelId !== 'string' || modelId === '') {
          throw new Error(`alias "${name}" has a malformed model id for "${key}"`);
        }
        perProvider[route] = modelId;
      }
      alias.perProvider = perProvider;
    }
    aliases[name] = alias;
  }
  return aliases;
}

/**
 * Import a catalog from a raw document.
 *
 * The document may use the **target's** shape (`schema_version`, `models` with
 * `display_name` and `provider_ids` keyed by the target's provider names) or
 * the **implementation's** shape (`schemaVersion`, `displayName`, `providerIds` keyed by
 * route). Both are accepted, because a connection may declare a catalog from a
 * file or a URL (the extension), and the built-in table is the target's shape.
 *
 * The import **validates**:
 *
 *   - `schema_version` must be a number, and must be the version this build
 *     supports (`1`);
 *   - every row must carry an id, a family, a display name, provider ids and
 *     a `max_output_tokens` table;
 *   - every provider key must be one the target's catalog uses — an unknown
 *     key is an error, not a silent drop;
 *   - model ids must be unique.
 *
 * @param raw The document to import.
 * @param connectionId The connection the imported catalog belongs to.
 */
export function importCatalog(
  raw: unknown,
  connectionId: string = DEFAULT_CATALOG_CONNECTION_ID,
): ModelCatalog {
  if (!isRecord(raw)) {
    throw new Error('a model catalog must be an object');
  }

  const version = ownNumber(raw, 'schema_version', 'schemaVersion');
  if (version === undefined) {
    throw new Error('a model catalog must declare a schema version');
  }
  if (version !== CATALOG_SCHEMA_VERSION) {
    throw new Error(
      `unsupported model catalog schema version ${version}: this build supports ${CATALOG_SCHEMA_VERSION}`,
    );
  }

  const modelsRaw = ownValue(raw, 'models');
  if (!Array.isArray(modelsRaw)) {
    throw new Error('a model catalog must carry a models array');
  }

  const models = modelsRaw.map((entry, index) => convertModel(entry, index));
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.id)) {
      throw new Error(`the model catalog declares "${model.id}" more than once`);
    }
    seen.add(model.id);
  }

  const catalog: ModelCatalog = {
    connectionId,
    schemaVersion: version,
    models,
  };

  const pricingTiers = convertPricingTiers(ownRecord(raw, 'pricing_tiers', 'pricingTiers'));
  if (pricingTiers !== undefined) catalog.pricingTiers = pricingTiers;

  const aliases = convertAliases(ownRecord(raw, 'aliases'));
  if (aliases !== undefined) catalog.aliases = aliases;

  const defaults = ownRecord(raw, 'defaults');
  if (defaults !== undefined) catalog.defaults = { ...defaults };

  const best = ownString(raw, 'best');
  if (best !== undefined) catalog.best = best;

  const latestPerFamily = ownRecord(raw, 'latest_per_family', 'latestPerFamily');
  if (latestPerFamily !== undefined) {
    const table: Record<string, string> = {};
    for (const [family, modelId] of Object.entries(latestPerFamily)) {
      if (typeof modelId !== 'string' || modelId === '') {
        throw new Error(`the latest model for family "${family}" is malformed`);
      }
      table[family] = modelId;
    }
    catalog.latestPerFamily = table;
  }

  const aliasMigration = ownRecord(raw, 'alias_migration', 'aliasMigration');
  if (aliasMigration !== undefined) catalog.aliasMigration = { ...aliasMigration };

  return catalog;
}

/* -------------------------------------------------------------------------- */
/* The built-in catalog                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The target's catalog, transcribed.
 *
 * The file keeps the target's **own** key names (`schema_version`,
 * `provider_ids` keyed by `first_party` / `anthropic_aws` / …) and its `null`
 * provider ids, so the transcription can be compared against the target's
 * literal field by field. `importCatalog` performs the translation into the
 * implementation's route-keyed shape.
 */
export const BUILTIN_CATALOG_RAW: unknown = BUILTIN_CATALOG_JSON;

/** The target's catalog, imported into this implementation's shape. */
const importedBuiltinCatalog: ModelCatalog = importCatalog(BUILTIN_CATALOG_RAW);

/**
 * The target's catalog, in this implementation's shape.
 *
 * The table is **frozen**: it is a module-level singleton shared by every
 * connection, so a caller must not be able to corrupt it. `builtinCatalogFor`
 * and `listModels` hand out deep copies.
 */
export const builtinCatalog: ModelCatalog = importedBuiltinCatalog;

deepFreeze(builtinCatalog);

/**
 * A copy of the built-in catalog, stamped with the connection it serves.
 *
 * The copy is **deep** — the rows are copies too — so the caller cannot reach
 * the shared table through it.
 */
export function builtinCatalogFor(connectionId: string): ModelCatalog {
  const copy = copyCatalog(builtinCatalog);
  copy.connectionId = connectionId;
  return copy;
}

/**
 * The routes the built-in catalog can serve, derived from the catalog itself
 * rather than written out: every route that at least one model carries an id
 * for. It is a convenience for the UI; the route set itself lives in
 * `src/provider/routes.ts`.
 */
export function routesServedBy(catalog: ModelCatalog = builtinCatalog): ProviderRoute[] {
  const served = new Set<ProviderRoute>();
  for (const model of catalog.models) {
    for (const route of ROUTE_NAMES) {
      if (providerIdFor(model, route) !== undefined) served.add(route);
    }
  }
  return ROUTE_NAMES.filter((route) => served.has(route));
}

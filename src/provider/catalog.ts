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
 * (audit §2.1). This implementation keeps the same information with an **absent key**
 * instead of a `null` value:
 *
 * ```ts
 * providerIds: Partial<Record<ProviderRoute, string>>;  // absent key = not served
 * ```
 *
 * There is therefore **no representation for "unknown"** anywhere in this
 * module: a key is either present with a provider model id, or absent because
 * the provider does not serve the model. A nullable field would conflate the
 * two, which is exactly the confusion the target's `null` avoids.
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
 * ## The mantle fallback
 *
 * `wd(model)` in the target layers a per-model override on top of the route
 * selector: if the catalog has no id for the selected route but has one for
 * `mantle`, the model resolves to `mantle`. `resolveModel` implements that
 * fallback, and `resolveModelRoute` reports the route it resolved to.
 * `providerIdFor` deliberately does **not** fall back: it is the strict
 * per-route lookup, and an absent key means "this route does not serve the
 * model" — which is what the usable-model list is built from.
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
   * An **absent key** means "this provider does not serve this model". There
   * is no representation for "unknown".
   */
  providerIds: Partial<Record<ProviderRoute, string>>;
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
/* Lookups                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The provider-specific model id for a route, or `undefined` when the route
 * does not serve the model.
 *
 * The lookup is **strict**: an absent key is "not served", and there is no
 * "unknown" case to confuse it with. An own-property check guards the lookup,
 * so a route name that collides with an `Object.prototype` member never
 * resolves to the inherited member.
 */
export function providerIdFor(model: CatalogModel, route: ProviderRoute): string | undefined {
  const ids = model.providerIds;
  if (ids === null || typeof ids !== 'object') return undefined;
  if (!Object.hasOwn(ids, route)) return undefined;
  const value = ids[route];
  if (typeof value !== 'string' || value === '') return undefined;
  return value;
}

/** The catalog row with a logical model id, or `undefined`. */
export function findModel(catalog: ModelCatalog, modelId: string): CatalogModel | undefined {
  if (!Array.isArray(catalog.models)) return undefined;
  return catalog.models.find((model) => model.id === modelId);
}

/**
 * The route a model resolves to for a selected route.
 *
 * This is the target's `wd(model)` override (audit §2.1): if the selected
 * route has no id for the model but `mantle` does, the model resolves to
 * `mantle`. `undefined` means the model is not served by the selected route
 * and has no `mantle` id either.
 */
export function resolveRouteForModel(
  model: CatalogModel,
  route: ProviderRoute,
): ProviderRoute | undefined {
  if (providerIdFor(model, route) !== undefined) return route;
  if (route !== 'mantle' && providerIdFor(model, 'mantle') !== undefined) return 'mantle';
  return undefined;
}

/**
 * The route a model resolves to for a selected route, looked up in a catalog.
 *
 * `undefined` means the catalog has no such model.
 */
export function resolveModelRoute(
  catalog: ModelCatalog,
  modelId: string,
  route: ProviderRoute,
): ProviderRoute | undefined {
  const model = findModel(catalog, modelId);
  if (model === undefined) return undefined;
  return resolveRouteForModel(model, route);
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
 */
export function resolveModel(
  catalog: ModelCatalog,
  modelId: string,
  route: ProviderRoute,
): string | undefined {
  const model = findModel(catalog, modelId);
  if (model === undefined) return undefined;
  const direct = providerIdFor(model, route);
  if (direct !== undefined) return direct;
  if (route === 'mantle') return undefined;
  return providerIdFor(model, 'mantle');
}

/**
 * The catalog rows, optionally filtered.
 *
 * `family` matches the family exactly (case-insensitively); `query` is a
 * case-insensitive substring match against the model id and the display name.
 * The returned array is a copy, so a caller cannot mutate the catalog through
 * it.
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

  return models;
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
 * A `null` value — the target's "this provider does not serve this model" —
 * becomes an **absent key**. An unknown key is an error rather than a silent
 * drop, so a typo in a hand-maintained catalog is caught at import time.
 */
function convertProviderIds(
  raw: Record<string, unknown>,
  modelId: string,
): Partial<Record<ProviderRoute, string>> {
  const providerIds: Partial<Record<ProviderRoute, string>> = {};
  for (const [key, value] of Object.entries(raw)) {
    const route = routeForProviderIdKey(key);
    if (route === undefined) {
      throw new Error(`catalog model "${modelId}" has an unknown provider id key "${key}"`);
    }
    if (value === null) continue; // "not served" — an absent key, never a null value
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
export const builtinCatalog: ModelCatalog = importCatalog(BUILTIN_CATALOG_RAW);

/** A copy of the built-in catalog, stamped with the connection it serves. */
export function builtinCatalogFor(connectionId: string): ModelCatalog {
  return { ...builtinCatalog, connectionId };
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

/**
 * Contract test for the provider-owned model catalog.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.1 (Providers and
 * model catalogs) — the built-in catalog literal in `chunk-w4f5s3e0.js`, the
 * `provider_ids` map with one key per provider, and the `null` value that
 * marks a provider that does not serve a model. Conformance table:
 * `docs/compatibility/provider-catalog.md`.
 *
 * What this test pins:
 *   - **"not served" is not "unknown"**: an absent `providerIds` key means the
 *     provider does not serve the model, and the API has no representation for
 *     "unknown" (the type is `string`, never `string | null`);
 *   - the **explicit** map between the target's snake_case `provider_ids` keys
 *     and this implementation's route names;
 *   - the built-in catalog's shape: `schema_version: 1`, 22 rows, a row served
 *     by all eight routes and a row that omits at least one, with the target's
 *     extra fields preserved;
 *   - the target's `mantle` fallback: a model the selected route does not
 *     serve resolves to `mantle` when `mantle` does serve it;
 *   - the driver-agnostic capability object: eager input streaming per route,
 *     the `max_output_tokens` upper bound, and the usable-model list.
 *
 * The catalog itself is the **target's**, reproduced by this implementation. The
 * implementation-owned extension is the connection registry, not the catalog.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  BUILTIN_CATALOG_RAW,
  PROVIDER_ID_KEYS,
  builtinCatalog,
  builtinCatalogFor,
  importCatalog,
  listModels,
  providerIdFor,
  providerKeyForRoute,
  resolveModel,
  resolveModelRoute,
  routeForProviderKey,
  routesServedBy,
  type CatalogModel,
} from '../../src/provider/catalog.js';
import { createProviderRegistry, type Connection } from '../../src/provider/registry.js';
import { ROUTE_NAMES, type ProviderRoute } from '../../src/provider/routes.js';
import {
  clampMaxTokens,
  normalizeModel,
  usableModels,
} from '../../src/provider/normalize.js';

/**
 * A model served by two of the eight routes.
 *
 * `bedrock` is **absent**: the model is not served there. That absence is a
 * fact, and it is what distinguishes "not served" from "unknown".
 */
const twoRouteModel: CatalogModel = {
  id: 'claude-haiku-4-5',
  family: 'haiku',
  displayName: 'Haiku 4.5',
  providerIds: {
    firstParty: 'claude-haiku-4-5-20251001',
    vertex: 'claude-haiku-4-5@20251001',
  },
  eagerInputStreaming: {},
  maxOutputTokens: { default: 32000, upper: 64000 },
  capabilities: ['context_management'],
};

/**
 * Compile-time pin: the catalog's provider-id type is `string`, never
 * `string | null`.
 *
 * There is deliberately **no** representation for "unknown" — a provider id
 * is either present (the provider serves the model) or absent (it does not).
 * A nullable field would conflate the two, which is exactly what the target's
 * `null` avoids.
 */
// @ts-expect-error - `null` is not assignable: "unknown" is not representable.
const unknownIsNotRepresentable: CatalogModel['providerIds']['bedrock'] = null;
void unknownIsNotRepresentable;

describe('the provider-owned model catalog', () => {
  it('reports a route the model does not serve as absent, not as unknown', () => {
    // The model has no `bedrock` key at all.
    expect(Object.hasOwn(twoRouteModel.providerIds, 'bedrock')).toBe(false);
    expect(twoRouteModel.providerIds.bedrock).toBeUndefined();

    // The lookup therefore reports "not served" ...
    expect(providerIdFor(twoRouteModel, 'bedrock')).toBeUndefined();
    // ... and never a `null`, which would mean "unknown" in a nullable design.
    expect(providerIdFor(twoRouteModel, 'bedrock')).not.toBeNull();

    // A route that *is* served reports its provider-specific id.
    expect(providerIdFor(twoRouteModel, 'firstParty')).toBe('claude-haiku-4-5-20251001');
    expect(providerIdFor(twoRouteModel, 'vertex')).toBe('claude-haiku-4-5@20251001');
  });

  it('does not resolve inherited Object.prototype members as provider ids', () => {
    const empty: CatalogModel = { ...twoRouteModel, providerIds: {} };
    // `constructor`, `toString` and `__proto__` are not among the eight
    // routes and are not own keys of the map, so the own-property check keeps
    // the lookup from resolving the inherited member.
    expect(providerIdFor(empty, 'constructor' as unknown as ProviderRoute)).toBeUndefined();
    expect(providerIdFor(empty, 'toString' as unknown as ProviderRoute)).toBeUndefined();
    expect(providerIdFor(empty, '__proto__' as unknown as ProviderRoute)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* The built-in catalog                                                       */
/* -------------------------------------------------------------------------- */

/** The built-in catalog file, read from disk and parsed. */
const builtinFile = JSON.parse(
  readFileSync(new URL('../../src/provider/catalogs/builtin.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('the built-in model catalog', () => {
  it('parses and declares schema version 1', () => {
    expect(builtinFile.schema_version).toBe(1);
    expect(builtinCatalog.schemaVersion).toBe(1);
    expect(importCatalog(BUILTIN_CATALOG_RAW).schemaVersion).toBe(1);
  });

  it('carries every row of the target catalog', () => {
    // The target's literal holds 22 models.
    expect(builtinCatalog.models).toHaveLength(22);
    expect(builtinFile.models).toHaveLength(22);
  });

  it('serves one model by all eight routes', () => {
    const complete = builtinCatalog.models.filter(
      (model) => ROUTE_NAMES.every((route) => providerIdFor(model, route) !== undefined),
    );
    expect(complete.length).toBeGreaterThanOrEqual(1);
    // The target's `claude-haiku-4-5` row carries all eight provider ids.
    expect(complete.map((model) => model.id)).toContain('claude-haiku-4-5');
  });

  it('omits at least one route for another model', () => {
    const incomplete = builtinCatalog.models.filter(
      (model) => ROUTE_NAMES.some((route) => providerIdFor(model, route) === undefined),
    );
    expect(incomplete.length).toBeGreaterThanOrEqual(1);
    // The target's `claude-mythos-5` row is first-party only.
    const mythos = builtinCatalog.models.find((model) => model.id === 'claude-mythos-5');
    expect(mythos).toBeDefined();
    expect(providerIdFor(mythos as CatalogModel, 'firstParty')).toBe('claude-mythos-5');
    expect(providerIdFor(mythos as CatalogModel, 'bedrock')).toBeUndefined();
    expect(providerIdFor(mythos as CatalogModel, 'mantle')).toBeUndefined();
  });

  it('keeps the target\'s own provider_ids key names and its nulls', () => {
    const rows = builtinFile.models as Array<Record<string, unknown>>;
    const first = rows[0] as Record<string, unknown>;
    const providerIds = first.provider_ids as Record<string, unknown>;

    // The target's provider names are snake_case, not this implementation's route names.
    expect(Object.keys(providerIds).sort()).toEqual(
      [
        'anthropic_aws',
        'anthropic_google_cloud',
        'bedrock',
        'first_party',
        'foundry',
        'gateway',
        'mantle',
        'vertex',
      ].sort(),
    );

    // A `null` id means "this provider does not serve this model".
    const nulls = rows.flatMap((row) =>
      Object.values(row.provider_ids as Record<string, unknown>).filter(
        (value) => value === null,
      ),
    );
    expect(nulls.length).toBeGreaterThanOrEqual(1);

    // ... and it becomes an ABSENT key in this implementation's model, never a null value.
    const imported = importCatalog(builtinFile);
    for (const model of imported.models) {
      for (const route of ROUTE_NAMES) {
        const value = model.providerIds[route];
        expect(value === undefined || typeof value === 'string').toBe(true);
      }
    }
  });

  it('maps the target\'s provider ids onto the routes explicitly', () => {
    expect(PROVIDER_ID_KEYS).toEqual({
      first_party: 'firstParty',
      bedrock: 'bedrock',
      vertex: 'vertex',
      foundry: 'foundry',
      anthropic_aws: 'anthropicAws',
      anthropic_google_cloud: 'anthropicGoogleCloud',
      mantle: 'mantle',
      gateway: 'gateway',
    });

    // Every route has a target key, and every target key names a route.
    for (const route of ROUTE_NAMES) {
      expect(providerKeyForRoute(route)).toBeDefined();
      expect(routeForProviderKey(providerKeyForRoute(route) as string)).toBe(route);
    }
    expect(Object.keys(PROVIDER_ID_KEYS)).toHaveLength(ROUTE_NAMES.length);

    // An unknown key is unknown, not an inherited `Object.prototype` member.
    expect(routeForProviderKey('constructor')).toBeUndefined();
    expect(routeForProviderKey('toString')).toBeUndefined();
  });

  it('preserves the target\'s extra model fields and families', () => {
    const sonnet55 = builtinCatalog.models.find((model) => model.id === 'claude-sonnet-5-5');
    expect(sonnet55).toBeDefined();
    const model = sonnet55 as CatalogModel;

    expect(model.advisorRank).toBe(6);
    expect(model.context?.window).toBe(1_000_000);
    expect(model.context?.native1m).toBe(true);
    expect(model.context?.supports1mBeta).toBe(true);
    expect(model.defaultEffort).toBe('medium');
    expect(model.effortCostIndex).toEqual({
      low: 0.49,
      medium: 0.54,
      high: 1,
      xhigh: 1.87,
      max: 5.5,
    });
    expect(model.fallback3p).toBe('claude-sonnet-5');
    expect(model.imageLimits).toEqual({ maxWidth: 2576, maxHeight: 2576, maxImageTokens: 4784 });
    expect(model.vertexRegionEnvVar).toBe('VERTEX_REGION_CLAUDE_5_5_SONNET');
    expect(model.knowledgeCutoff).toBe('June 2026');

    // The families go beyond haiku/sonnet/opus.
    const families = new Set(builtinCatalog.models.map((entry) => entry.family));
    expect([...families].sort()).toEqual(['fable', 'haiku', 'mythos', 'opus', 'sonnet']);
  });

  it('cites the target module it was transcribed from', () => {
    const provenance = builtinFile._provenance as Record<string, unknown>;
    expect(provenance.source_module).toBe('chunk-w4f5s3e0.js');
    expect(provenance.source_symbol).toBe('N$r');
    expect(provenance.source_byte_range).toEqual([950, 20263]);
    expect(String(provenance.evidence)).toContain('COVERAGE-AUDIT.md');
  });

  it('transcribes the target\'s literal without changing it', () => {
    // The file is the target's literal, plus the `_provenance` block.
    const { _provenance: _ignored, ...literal } = builtinFile;
    expect(literal).toEqual({
      '//': 'Hand-maintained baked-in model catalog — the source of truth for per-model provider IDs and metadata. On model launch add one entry to `models` below; `bun run generate:model-catalog` validates this file against the schema and formats it.',
      schema_version: 1,
      pricing_tiers: expect.any(Object),
      models: expect.any(Array),
      aliases: expect.any(Object),
      defaults: {},
      best: 'fable',
      latest_per_family: expect.any(Object),
      alias_migration: {},
    });
  });

  it('preserves the target\'s pricing tiers and family aliases', () => {
    expect(Object.keys(builtinCatalog.pricingTiers ?? {})).toHaveLength(11);
    expect(builtinCatalog.pricingTiers?.tier_2_10).toEqual({
      input: 2,
      output: 10,
      cacheWrite5m: 2.5,
      cacheWrite1h: 4,
      cacheRead: 0.2,
      webSearch: 0.01,
    });

    expect(builtinCatalog.aliases?.opus?.default).toBe('claude-opus-5-5');
    expect(builtinCatalog.aliases?.opus?.perProvider?.bedrock).toBe('claude-opus-5-5');
    expect(builtinCatalog.aliases?.sonnet?.perProvider?.foundry).toBe('claude-sonnet-4-5');
    expect(builtinCatalog.aliases?.haiku?.perProvider?.anthropicGoogleCloud).toBe('claude-haiku-4-5');
    expect(builtinCatalog.aliases?.fable?.perProvider?.gateway).toBe('claude-fable-5');

    expect(builtinCatalog.best).toBe('fable');
    expect(builtinCatalog.latestPerFamily?.opus).toBe('claude-opus-5-5');
    expect(builtinCatalog.latestPerFamily?.fable).toBe('claude-fable-5-1');
  });

  it('is served by every one of the eight routes', () => {
    expect(routesServedBy(builtinCatalog)).toEqual([...ROUTE_NAMES]);
  });
});

describe('model resolution', () => {
  it('resolves the provider id of the selected route', () => {
    expect(resolveModel(builtinCatalog, 'claude-sonnet-5-5', 'firstParty')).toBe('claude-sonnet-5-5');
    expect(resolveModel(builtinCatalog, 'claude-sonnet-5-5', 'bedrock')).toBe(
      'us.anthropic.claude-sonnet-5-5',
    );
    expect(resolveModel(builtinCatalog, 'claude-mythos-5', 'firstParty')).toBe('claude-mythos-5');
  });

  it('falls back to mantle when the selected route does not serve the model', () => {
    // The target's `wd(model)`: no id for the route, one for mantle.
    expect(resolveModel(builtinCatalog, 'claude-haiku-5-5', 'gateway')).toBe(
      'anthropic.claude-haiku-5-5',
    );
    expect(resolveModelRoute(builtinCatalog, 'claude-haiku-5-5', 'gateway')).toBe('mantle');

    // No fallback when mantle does not serve it either.
    expect(resolveModel(builtinCatalog, 'claude-mythos-5', 'bedrock')).toBeUndefined();
    expect(resolveModelRoute(builtinCatalog, 'claude-mythos-5', 'bedrock')).toBeUndefined();

    // An unknown model resolves to nothing.
    expect(resolveModel(builtinCatalog, 'claude-nope', 'firstParty')).toBeUndefined();
    expect(resolveModelRoute(builtinCatalog, 'claude-nope', 'firstParty')).toBeUndefined();
  });

  it('filters the model list by family and by query', () => {
    expect(listModels(builtinCatalog, { family: 'haiku' }).map((model) => model.id)).toEqual([
      'claude-3-5-haiku',
      'claude-haiku-4-5',
      'claude-haiku-5-5',
    ]);
    expect(listModels(builtinCatalog, { query: 'haiku 4.5' }).map((model) => model.id)).toEqual([
      'claude-haiku-4-5',
    ]);
    expect(listModels(builtinCatalog, { query: 'claude-opus' })).toHaveLength(8);
    expect(listModels(builtinCatalog)).toHaveLength(22);
  });

  it('rejects a catalog this build cannot read', () => {
    expect(() => importCatalog({ schema_version: 2, models: [] })).toThrow(/schema version/);
    expect(() => importCatalog({ models: [] })).toThrow(/schema version/);
    expect(() => importCatalog({ schema_version: 1 })).toThrow(/models/);
    expect(() => importCatalog({ schema_version: 1, models: [{ id: 'x' }] })).toThrow(/family/);
    expect(() =>
      importCatalog({
        schema_version: 1,
        models: [
          {
            id: 'x',
            family: 'haiku',
            display_name: 'X',
            provider_ids: { not_a_provider: 'x' },
            max_output_tokens: { default: 1, upper: 1 },
            capabilities: [],
          },
        ],
      }),
    ).toThrow(/unknown provider id key/);
    expect(() =>
      importCatalog({
        schema_version: 1,
        models: [
          {
            id: 'x',
            family: 'haiku',
            display_name: 'X',
            provider_ids: { first_party: null },
            max_output_tokens: { default: 1, upper: 1 },
            capabilities: [],
          },
          {
            id: 'x',
            family: 'haiku',
            display_name: 'X',
            provider_ids: { first_party: 'x' },
            max_output_tokens: { default: 1, upper: 1 },
            capabilities: [],
          },
        ],
      }),
    ).toThrow(/more than once/);
  });

  it('imports a catalog written in this implementation\'s own shape', () => {
    const imported = importCatalog({
      schemaVersion: 1,
      models: [
        {
          id: 'agent-test',
          family: 'haiku',
          displayName: 'Test',
          providerIds: { firstParty: 'agent-test' },
          eagerInputStreaming: { firstParty: true },
          maxOutputTokens: { default: 100, upper: 200 },
          capabilities: ['effort'],
        },
      ],
    });
    expect(imported.schemaVersion).toBe(1);
    expect(imported.models[0]?.displayName).toBe('Test');
    expect(imported.models[0]?.providerIds).toEqual({ firstParty: 'agent-test' });
    expect(imported.models[0]?.eagerInputStreaming).toEqual({ firstParty: true });
  });
});

/* -------------------------------------------------------------------------- */
/* The catalog never touches a credential                                       */
/* -------------------------------------------------------------------------- */

describe('the catalog and the credential', () => {
  it('never reads a credential', () => {
    // The catalog is a table of facts. It must not select or read a secret,
    // and it must not choose a destination for one.
    for (const file of ['catalog.ts', 'normalize.ts']) {
      const source = readFileSync(new URL(`../../src/provider/${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/credentials\.js/);
      expect(source).not.toMatch(/resolveCredential/);
      expect(source).not.toMatch(/credentialStatus/);
    }
  });

  it('gives a connection without a credential its catalog anyway', () => {
    const secret = 'catalog-secret-value';
    process.env.CATALOG_TEST_KEY = secret;
    try {
      const withCredential: Connection = {
        id: 'configured',
        name: 'Configured',
        route: 'firstParty',
        credential: { kind: 'env', name: 'CATALOG_TEST_KEY' },
        catalogSource: 'builtin',
        enabled: true,
      };
      const withoutCredential: Connection = {
        id: 'unconfigured',
        name: 'Unconfigured',
        route: 'bedrock',
        credential: { kind: 'env', name: 'CATALOG_TEST_MISSING_KEY' },
        catalogSource: 'builtin',
        enabled: false,
      };
      const registry = createProviderRegistry([withCredential, withoutCredential]);

      // The connection with no credential still has a model list: the catalog
      // does not depend on the credential being present.
      const unconfigured = registry.get('unconfigured');
      expect(unconfigured).toBeDefined();
      const models = usableModels(builtinCatalogFor((unconfigured as Connection).route), 'bedrock');
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((model) => model.modelId === 'claude-mythos-5')).toBe(false);

      // The unusable connection is not the active one, so nothing routes to it.
      expect(registry.active()?.id).toBe('configured');

      // And no secret ever reaches the catalog, even with one in the
      // environment.
      expect(JSON.stringify(builtinCatalog)).not.toContain(secret);
      expect(JSON.stringify(models)).not.toContain(secret);
    } finally {
      delete process.env.CATALOG_TEST_KEY;
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Capability normalization                                                    */
/* -------------------------------------------------------------------------- */

describe('capability normalization', () => {
  it('reports eager input streaming for the route that declares it', () => {
    const model = builtinCatalog.models.find((entry) => entry.id === 'claude-3-5-haiku');
    expect(model).toBeDefined();
    const row = model as CatalogModel;

    // The target's row declares `eager_input_streaming.vertex`.
    expect(row.eagerInputStreaming).toEqual({ vertex: true });

    const onVertex = normalizeModel(row, 'vertex');
    expect(onVertex?.eagerInputStreaming).toBe(true);
    expect(onVertex?.route).toBe('vertex');
    expect(onVertex?.providerId).toBe('claude-3-5-haiku@20241022');

    // A route that does not declare it does not get it.
    const onBedrock = normalizeModel(row, 'bedrock');
    expect(onBedrock?.eagerInputStreaming).toBe(false);
  });

  it('bounds the request max_tokens at the model\'s upper limit', () => {
    const model = builtinCatalog.models.find((entry) => entry.id === 'claude-sonnet-5-5');
    expect(model).toBeDefined();
    const row = model as CatalogModel;

    expect(row.maxOutputTokens).toEqual({ default: 128000, upper: 128000 });
    expect(clampMaxTokens(row, 4096)).toBe(4096);
    expect(clampMaxTokens(row, 1_000_000)).toBe(row.maxOutputTokens.upper);
    // A request that asks for nothing usable falls back to the default.
    expect(clampMaxTokens(row, 0)).toBe(row.maxOutputTokens.default);
    expect(clampMaxTokens(row, Number.NaN)).toBe(row.maxOutputTokens.default);
  });

  it('filters a model the active route does not serve out of the usable list', () => {
    const bedrockModels = usableModels(builtinCatalog, 'bedrock');

    // The target's `claude-mythos-5` row is first-party only.
    expect(bedrockModels.some((model) => model.modelId === 'claude-mythos-5')).toBe(false);
    // ... while a model the route does serve is listed.
    expect(bedrockModels.some((model) => model.modelId === 'claude-sonnet-5-5')).toBe(true);

    // Every listed model carries the route's own provider id.
    for (const model of bedrockModels) {
      expect(model.route).toBe('bedrock');
      expect(model.providerId).toBe(
        providerIdFor(
          builtinCatalog.models.find((entry) => entry.id === model.modelId) as CatalogModel,
          'bedrock',
        ),
      );
    }

    // The first-party list holds the model the bedrock list does not.
    const firstPartyModels = usableModels(builtinCatalog, 'firstParty');
    expect(firstPartyModels.some((model) => model.modelId === 'claude-mythos-5')).toBe(true);
  });

  it('resolves a model the route does not serve through mantle', () => {
    // The target's `claude-haiku-5-5` row has no gateway id but does have one
    // for mantle, so the target's `wd(model)` resolves it to mantle.
    const row = builtinCatalog.models.find((entry) => entry.id === 'claude-haiku-5-5') as CatalogModel;
    expect(providerIdFor(row, 'gateway')).toBeUndefined();
    expect(providerIdFor(row, 'mantle')).toBe('anthropic.claude-haiku-5-5');

    const resolved = normalizeModel(row, 'gateway');
    expect(resolved?.route).toBe('mantle');
    expect(resolved?.providerId).toBe('anthropic.claude-haiku-5-5');

    // A model no route serves resolves to nothing.
    const mythos = builtinCatalog.models.find((entry) => entry.id === 'claude-mythos-5') as CatalogModel;
    expect(normalizeModel(mythos, 'mantle')).toBeUndefined();
    expect(normalizeModel(mythos, 'gateway')).toBeUndefined();
  });
});



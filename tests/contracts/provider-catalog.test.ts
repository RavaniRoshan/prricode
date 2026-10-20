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
 *   - **the fidelity of the transcription**: the built-in file is checked
 *     against a SHA-256 digest of the *target's own* extracted literal (a
 *     literal in this file, never one computed from the file under test), and
 *     every model id, every per-provider model id, every pricing-tier key and
 *     every alias key is spelled out here;
 *   - **the target's own three states**: a string (the route serves the model),
 *     `null` (the route does not — the target's own marker) and an absent key
 *     (the target's literal does not carry it), and the "not served"
 *     predicate is the target's `provider_ids[route] === null`;
 *   - the **explicit** map between the target's snake_case `provider_ids` keys
 *     and this implementation's route names;
 *   - the built-in catalog's shape: `schema_version: 1`, 22 rows, a row served
 *     by all eight routes and a row that omits at least one, with the target's
 *     extra fields preserved;
 *   - the target's `mantle` fallback: a model the selected route marks as
 *     `null` resolves to `mantle` when `mantle` does serve it — and the fact
 *     that a route whose key the target's literal **omits** is not "not
 *     served", so the predicate is the target's and not a superset of it;
 *   - the **half of the target's `wd(model)` rule that is not implemented**:
 *     the Bedrock+Mantle `anthropic.*` override needs the enabled-flag set,
 *     which this API does not take;
 *   - the driver-agnostic capability object: eager input streaming per route,
 *     the `max_output_tokens` upper bound, and the usable-model list.
 *
 * The catalog itself is the **target's**, reproduced by this implementation. The
 * implementation-owned extension is the connection registry, not the catalog.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import {
  BUILTIN_CATALOG_RAW,
  PROVIDER_ID_KEYS,
  builtinCatalog,
  builtinCatalogFor,
  findModel,
  importCatalog,
  listModels,
  notServedOn,
  providerIdFor,
  providerKeyForRoute,
  resolveModel,
  resolveModelRoute,
  resolveRouteForModel,
  routeForProviderKey,
  routesServedBy,
  type CatalogModel,
  type ModelCatalog,
} from '../../src/provider/catalog.js';
import { enabledRoutes } from '../../src/provider/routes.js';
import { createProviderRegistry, type Connection } from '../../src/provider/registry.js';
import { setKeychainBackend, type KeychainBackend } from '../../src/provider/credentials.js';
import { ROUTE_NAMES, type ProviderRoute } from '../../src/provider/routes.js';
import {
  clampMaxTokens,
  normalizeModel,
  usableModels,
} from '../../src/provider/normalize.js';

/**
 * A model served by two of the eight routes.
 *
 * `bedrock` is **absent**: the target's literal does not carry the key at all.
 * The absence is a fact of its own, and it is distinct from `null` — the
 * target's "this provider does not serve this model".
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
 * Compile-time pin: the catalog's provider-id type carries the target's own
 * `null` — the marker for "this provider does not serve this model" — and it
 * is **not** "unknown".
 *
 * The target's `provider_ids` has three states per route: a string (the route
 * serves the model), `null` (it does not) and an absent key (the target's
 * literal does not carry it). The type keeps all three apart.
 */
const notServedIsNull: CatalogModel['providerIds']['bedrock'] = null;
void notServedIsNull;

describe('the provider-owned model catalog', () => {
  it('reports a route the model does not serve as the target does', () => {
    // The model has no `bedrock` key at all.
    expect(Object.hasOwn(twoRouteModel.providerIds, 'bedrock')).toBe(false);
    expect(twoRouteModel.providerIds.bedrock).toBeUndefined();

    // The lookup answers with the id, or with nothing — and it answers with
    // nothing for both a `null` entry and an absent one.
    expect(providerIdFor(twoRouteModel, 'bedrock')).toBeUndefined();

    // The **predicate** is the target's: `provider_ids[route] === null`. An
    // absent key is not `null`, so an absent key is **not** "not served".
    expect(notServedOn(twoRouteModel, 'bedrock')).toBe(false);

    // A route that is explicitly `null` **is** "not served".
    const notServed: CatalogModel = {
      ...twoRouteModel,
      providerIds: { ...twoRouteModel.providerIds, bedrock: null },
    };
    expect(providerIdFor(notServed, 'bedrock')).toBeUndefined();
    expect(notServedOn(notServed, 'bedrock')).toBe(true);

    // A route that *is* served reports its provider-specific id.
    expect(providerIdFor(twoRouteModel, 'firstParty')).toBe('claude-haiku-4-5-20251001');
    expect(providerIdFor(twoRouteModel, 'vertex')).toBe('claude-haiku-4-5@20251001');
    expect(notServedOn(twoRouteModel, 'firstParty')).toBe(false);
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

/**
 * The target's literal, without this implementation's `_provenance` block.
 *
 * The block is this implementation's own annotation of where the literal came from; the
 * literal itself is the target's.
 */
function builtinLiteral(): Record<string, unknown> {
  const { _provenance: _ignored, ...literal } = builtinFile;
  return literal;
}

/**
 * The **module header** of a source file — the leading block comment.
 *
 * The header is where a module states what it does *not* do, so a claim like
 * "this half of the rule is not implemented" has to live there and not only
 * in a function's doc comment.
 */
function moduleHeader(file: string): string {
  const source = readFileSync(new URL(`../../src/provider/${file}`, import.meta.url), 'utf8');
  const end = source.indexOf('*/');
  return end === -1 ? source : source.slice(0, end);
}

/**
 * Canonical JSON: object keys sorted, arrays in their own order.
 *
 * The canonical form is what makes a digest comparable: it removes the two
 * things a transcription may legitimately differ in — key order and
 * whitespace — and keeps everything else, including a `null` and an **absent**
 * key.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The SHA-256 of the canonical JSON of a catalog literal. */
function catalogDigest(literal: unknown): string {
  return createHash('sha256').update(canonicalJson(literal), 'utf8').digest('hex');
}

/**
 * The SHA-256 of the canonical JSON of the **target's** literal.
 *
 * This is a **literal**, not a digest computed from the file under test: it
 * was taken from the target's own extracted literal
 * (`/home/shiva/opt/reference-agent-rea/analysis/target-model-catalog.json`), so
 * the built-in file is checked against the *target* and not against itself.
 */
const TARGET_CATALOG_DIGEST = '77b3c0cadfe76ee1dccaadc617edf8ad9c7d488d50e05782087be987cf91a8f8';

/**
 * The target's model ids, in the target's own order.
 */
const EXPECTED_MODEL_IDS: readonly string[] = [
  'claude-3-5-haiku',
  'claude-haiku-4-5',
  'claude-haiku-5-5',
  'claude-3-5-sonnet',
  'claude-3-7-sonnet',
  'claude-sonnet-4-0',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'claude-sonnet-5-5',
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-fable-5',
  'claude-fable-5-1',
  'claude-mythos-5',
  'claude-mythos-5-1',
];

/**
 * The target's `provider_ids` for every model, in the target's **own** key
 * names.
 *
 * A `null` value is the target's "this provider does not serve the model" — a
 * fact, not an absence of knowledge. An **absent key** is the target's own
 * literal omitting the provider, which happens in exactly one place in the
 * whole table: `claude-haiku-5-5` has no `gateway` key at all.
 */
const EXPECTED_PROVIDER_IDS: Readonly<Record<string, Readonly<Record<string, string | null>>>> = {
  'claude-3-5-haiku': {
    first_party: 'claude-3-5-haiku-20241022',
    bedrock: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
    vertex: 'claude-3-5-haiku@20241022',
    foundry: 'claude-3-5-haiku',
    anthropic_aws: 'claude-3-5-haiku-20241022',
    anthropic_google_cloud: null,
    mantle: null,
    gateway: 'claude-3-5-haiku-20241022',
  },
  'claude-haiku-4-5': {
    first_party: 'claude-haiku-4-5-20251001',
    bedrock: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    vertex: 'claude-haiku-4-5@20251001',
    foundry: 'claude-haiku-4-5',
    anthropic_aws: 'claude-haiku-4-5-20251001',
    anthropic_google_cloud: 'claude-haiku-4-5-20251001',
    mantle: 'anthropic.claude-haiku-4-5',
    gateway: 'claude-haiku-4-5-20251001',
  },
  // The one row whose `gateway` key the target's literal **omits**.
  'claude-haiku-5-5': {
    first_party: 'claude-haiku-5-5',
    bedrock: 'us.anthropic.claude-haiku-5-5',
    vertex: 'claude-haiku-5-5',
    foundry: 'claude-haiku-5-5',
    anthropic_aws: 'claude-haiku-5-5',
    anthropic_google_cloud: 'claude-haiku-5-5',
    mantle: 'anthropic.claude-haiku-5-5',
  },
  'claude-3-5-sonnet': {
    first_party: 'claude-3-5-sonnet-20241022',
    bedrock: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
    vertex: 'claude-3-5-sonnet-v2@20241022',
    foundry: 'claude-3-5-sonnet',
    anthropic_aws: 'claude-3-5-sonnet-20241022',
    anthropic_google_cloud: null,
    mantle: null,
    gateway: 'claude-3-5-sonnet-20241022',
  },
  'claude-3-7-sonnet': {
    first_party: 'claude-3-7-sonnet-20250219',
    bedrock: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
    vertex: 'claude-3-7-sonnet@20250219',
    foundry: 'claude-3-7-sonnet',
    anthropic_aws: 'claude-3-7-sonnet-20250219',
    anthropic_google_cloud: null,
    mantle: null,
    gateway: 'claude-3-7-sonnet-20250219',
  },
  'claude-sonnet-4-0': {
    first_party: 'claude-sonnet-4-20250514',
    bedrock: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
    vertex: 'claude-sonnet-4@20250514',
    foundry: 'claude-sonnet-4',
    anthropic_aws: 'claude-sonnet-4-20250514',
    anthropic_google_cloud: null,
    mantle: null,
    gateway: 'claude-sonnet-4-20250514',
  },
  'claude-sonnet-4-5': {
    first_party: 'claude-sonnet-4-5-20250929',
    bedrock: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    vertex: 'claude-sonnet-4-5@20250929',
    foundry: 'claude-sonnet-4-5',
    anthropic_aws: 'claude-sonnet-4-5-20250929',
    anthropic_google_cloud: 'claude-sonnet-4-5-20250929',
    mantle: null,
    gateway: 'claude-sonnet-4-5-20250929',
  },
  'claude-sonnet-4-6': {
    first_party: 'claude-sonnet-4-6',
    bedrock: 'us.anthropic.claude-sonnet-4-6',
    vertex: 'claude-sonnet-4-6',
    foundry: 'claude-sonnet-4-6',
    anthropic_aws: 'claude-sonnet-4-6',
    anthropic_google_cloud: 'claude-sonnet-4-6',
    mantle: null,
    gateway: 'claude-sonnet-4-6',
  },
  'claude-sonnet-5': {
    first_party: 'claude-sonnet-5',
    bedrock: 'us.anthropic.claude-sonnet-5',
    vertex: 'claude-sonnet-5',
    foundry: 'claude-sonnet-5',
    anthropic_aws: 'claude-sonnet-5',
    anthropic_google_cloud: 'claude-sonnet-5',
    mantle: 'anthropic.claude-sonnet-5',
    gateway: 'claude-sonnet-5',
  },
  'claude-sonnet-5-5': {
    first_party: 'claude-sonnet-5-5',
    bedrock: 'us.anthropic.claude-sonnet-5-5',
    vertex: 'claude-sonnet-5-5',
    foundry: 'claude-sonnet-5-5',
    anthropic_aws: 'claude-sonnet-5-5',
    anthropic_google_cloud: 'claude-sonnet-5-5',
    mantle: 'anthropic.claude-sonnet-5-5',
    gateway: 'claude-sonnet-5-5',
  },
  'claude-opus-4-0': {
    first_party: 'claude-opus-4-20250514',
    bedrock: 'us.anthropic.claude-opus-4-20250514-v1:0',
    vertex: 'claude-opus-4@20250514',
    foundry: 'claude-opus-4',
    anthropic_aws: 'claude-opus-4-20250514',
    anthropic_google_cloud: null,
    mantle: null,
    gateway: 'claude-opus-4-20250514',
  },
  'claude-opus-4-1': {
    first_party: 'claude-opus-4-1-20250805',
    bedrock: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
    vertex: 'claude-opus-4-1@20250805',
    foundry: 'claude-opus-4-1',
    anthropic_aws: 'claude-opus-4-1-20250805',
    anthropic_google_cloud: null,
    mantle: null,
    gateway: 'claude-opus-4-1-20250805',
  },
  'claude-opus-4-5': {
    first_party: 'claude-opus-4-5-20251101',
    bedrock: 'us.anthropic.claude-opus-4-5-20251101-v1:0',
    vertex: 'claude-opus-4-5@20251101',
    foundry: 'claude-opus-4-5',
    anthropic_aws: 'claude-opus-4-5-20251101',
    anthropic_google_cloud: 'claude-opus-4-5-20251101',
    mantle: null,
    gateway: 'claude-opus-4-5-20251101',
  },
  'claude-opus-4-6': {
    first_party: 'claude-opus-4-6',
    bedrock: 'us.anthropic.claude-opus-4-6-v1',
    vertex: 'claude-opus-4-6',
    foundry: 'claude-opus-4-6',
    anthropic_aws: 'claude-opus-4-6',
    anthropic_google_cloud: 'claude-opus-4-6',
    mantle: null,
    gateway: 'claude-opus-4-6',
  },
  'claude-opus-4-7': {
    first_party: 'claude-opus-4-7',
    bedrock: 'us.anthropic.claude-opus-4-7',
    vertex: 'claude-opus-4-7',
    foundry: 'claude-opus-4-7',
    anthropic_aws: 'claude-opus-4-7',
    anthropic_google_cloud: 'claude-opus-4-7',
    mantle: 'anthropic.claude-opus-4-7',
    gateway: 'claude-opus-4-7',
  },
  'claude-opus-4-8': {
    first_party: 'claude-opus-4-8',
    bedrock: 'us.anthropic.claude-opus-4-8',
    vertex: 'claude-opus-4-8',
    foundry: 'claude-opus-4-8',
    anthropic_aws: 'claude-opus-4-8',
    anthropic_google_cloud: 'claude-opus-4-8',
    mantle: 'anthropic.claude-opus-4-8',
    gateway: 'claude-opus-4-8',
  },
  'claude-opus-5': {
    first_party: 'claude-opus-5',
    bedrock: 'us.anthropic.claude-opus-5',
    vertex: 'claude-opus-5',
    foundry: 'claude-opus-5',
    anthropic_aws: 'claude-opus-5',
    anthropic_google_cloud: 'claude-opus-5',
    mantle: 'anthropic.claude-opus-5',
    gateway: 'claude-opus-5',
  },
  'claude-opus-5-5': {
    first_party: 'claude-opus-5-5',
    bedrock: 'us.anthropic.claude-opus-5-5',
    vertex: 'claude-opus-5-5',
    foundry: 'claude-opus-5-5',
    anthropic_aws: 'claude-opus-5-5',
    anthropic_google_cloud: 'claude-opus-5-5',
    mantle: 'anthropic.claude-opus-5-5',
    gateway: 'claude-opus-5-5',
  },
  'claude-fable-5': {
    first_party: 'claude-fable-5',
    bedrock: 'us.anthropic.claude-fable-5',
    vertex: 'claude-fable-5',
    foundry: 'claude-fable-5',
    anthropic_aws: 'claude-fable-5',
    anthropic_google_cloud: 'claude-fable-5',
    mantle: 'anthropic.claude-fable-5',
    gateway: 'claude-fable-5',
  },
  'claude-fable-5-1': {
    first_party: 'claude-fable-5-1',
    bedrock: 'us.anthropic.claude-fable-5-1',
    vertex: 'claude-fable-5-1',
    foundry: 'claude-fable-5-1',
    anthropic_aws: 'claude-fable-5-1',
    anthropic_google_cloud: 'claude-fable-5-1',
    mantle: 'anthropic.claude-fable-5-1',
    gateway: 'claude-fable-5-1',
  },
  'claude-mythos-5': {
    first_party: 'claude-mythos-5',
    bedrock: null,
    vertex: null,
    foundry: null,
    anthropic_aws: null,
    anthropic_google_cloud: null,
    mantle: null,
    gateway: null,
  },
  'claude-mythos-5-1': {
    first_party: 'claude-mythos-5-1',
    bedrock: null,
    vertex: null,
    foundry: null,
    anthropic_aws: null,
    anthropic_google_cloud: null,
    mantle: null,
    gateway: null,
  },
};

/** The target's pricing-tier keys, in the target's own order. */
const EXPECTED_PRICING_TIER_KEYS: readonly string[] = [
  'tier_2_10',
  'tier_2_10_cache_read_0_10',
  'tier_3_15',
  'tier_5_25',
  'tier_15_75',
  'tier_10_50',
  'tier_10_50_cache_read_0_25',
  'tier_4_20_cache_read_0_20',
  'haiku_35',
  'haiku_45',
  'haiku_55',
];

/** The target's alias keys, in the target's own order. */
const EXPECTED_ALIAS_KEYS: readonly string[] = ['opus', 'sonnet', 'haiku', 'fable'];

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
    // The split is exact: nine of the target's 22 rows carry all eight
    // provider ids.
    expect(complete.map((model) => model.id)).toEqual([
      'claude-haiku-4-5',
      'claude-sonnet-5',
      'claude-sonnet-5-5',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-opus-5-5',
      'claude-fable-5',
      'claude-fable-5-1',
    ]);
  });

  it('omits at least one route for another model', () => {
    const incomplete = builtinCatalog.models.filter(
      (model) => ROUTE_NAMES.some((route) => providerIdFor(model, route) === undefined),
    );
    // The other thirteen of the target's 22 rows omit at least one route.
    expect(incomplete).toHaveLength(13);
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

    // ... and it is kept as the target's own marker: a `null` entry means
    // "this provider does not serve this model".
    const imported = importCatalog(builtinFile);
    for (const model of imported.models) {
      for (const route of ROUTE_NAMES) {
        const value = model.providerIds[route];
        expect(value === undefined || typeof value === 'string' || value === null).toBe(true);
      }
    }

    // The imported rows carry the target's `null` markers, and the predicate
    // reads them as "not served".
    const mythos = imported.models.find((model) => model.id === 'claude-mythos-5') as CatalogModel;
    expect(mythos.providerIds.mantle).toBeNull();
    expect(notServedOn(mythos, 'mantle')).toBe(true);
    expect(providerIdFor(mythos, 'mantle')).toBeUndefined();
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
    // The map holds exactly the eight target provider names — an independent
    // count, not the implementation's own route list.
    expect(Object.keys(PROVIDER_ID_KEYS)).toHaveLength(8);
    expect(Object.keys(PROVIDER_ID_KEYS).sort()).toEqual([
      'anthropic_aws',
      'anthropic_google_cloud',
      'bedrock',
      'first_party',
      'foundry',
      'gateway',
      'mantle',
      'vertex',
    ]);

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

  it('is the target\'s literal, digest for digest', () => {
    // The digest is a **literal** taken from the target's own extracted
    // literal, so this compares the built-in file with the *target* and not
    // with itself. A placeholder model row, a changed provider id or a
    // dropped pricing tier all change the digest.
    expect(catalogDigest(builtinLiteral())).toBe(TARGET_CATALOG_DIGEST);
  });

  it('changes the pinned digest when a model id or a provider id changes', () => {
    // The sensitivity of the digest pin: it is what makes the fidelity test
    // above able to fail.
    const renamedModel = structuredClone(builtinLiteral()) as {
      models: Array<{ id: string }>;
    };
    renamedModel.models[0]!.id = 'claude-3-5-haiku-renamed';
    expect(catalogDigest(renamedModel)).not.toBe(TARGET_CATALOG_DIGEST);

    const renamedProvider = structuredClone(builtinLiteral()) as {
      models: Array<{ provider_ids: Record<string, unknown> }>;
    };
    renamedProvider.models[0]!.provider_ids['first_party'] = 'claude-3-5-haiku-99999999';
    expect(catalogDigest(renamedProvider)).not.toBe(TARGET_CATALOG_DIGEST);
  });

  it('pins every model id and every provider id of the target\'s literal', () => {
    const rows = builtinFile.models as Array<Record<string, unknown>>;

    // The model ids, in the target's own order.
    expect(rows.map((row) => row.id)).toEqual([...EXPECTED_MODEL_IDS]);

    // The per-provider model ids, in the target's own key names. A `null` is
    // the target's "not served"; the one **absent** key is the target's own
    // omission, and `toEqual` tells the two apart.
    const actual: Record<string, Record<string, string | null>> = {};
    for (const row of rows) {
      actual[row.id as string] = row.provider_ids as Record<string, string | null>;
    }
    expect(actual).toEqual(EXPECTED_PROVIDER_IDS);

    // This implementation's own rows carry the target's `provider_ids` map
    // key for key: the same keys, the same values — a string for a route that
    // serves the model, `null` for one that does not, and no key at all for
    // the one the target's literal omits.
    const imported = importCatalog(builtinFile);
    expect(imported.models.map((model) => model.id)).toEqual([...EXPECTED_MODEL_IDS]);
    for (const model of imported.models) {
      const expected: Record<string, string | null> = {};
      for (const [key, value] of Object.entries(EXPECTED_PROVIDER_IDS[model.id] ?? {})) {
        const route = routeForProviderKey(key);
        if (route === undefined) throw new Error(`unknown target provider key "${key}"`);
        expected[route] = value;
      }
      expect(model.providerIds).toEqual(expected);
    }
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

  it('pins the pricing-tier keys and the alias keys', () => {
    // In the target's own literal ...
    expect(Object.keys(builtinFile.pricing_tiers as Record<string, unknown>)).toEqual([
      ...EXPECTED_PRICING_TIER_KEYS,
    ]);
    expect(Object.keys(builtinFile.aliases as Record<string, unknown>)).toEqual([
      ...EXPECTED_ALIAS_KEYS,
    ]);

    // ... and in this implementation's imported catalog.
    expect(Object.keys(builtinCatalog.pricingTiers ?? {})).toEqual([...EXPECTED_PRICING_TIER_KEYS]);
    expect(Object.keys(builtinCatalog.aliases ?? {})).toEqual([...EXPECTED_ALIAS_KEYS]);
  });

  it('is served by every one of the eight routes', () => {
    expect(routesServedBy(builtinCatalog)).toEqual([...ROUTE_NAMES]);
  });
});

/* -------------------------------------------------------------------------- */
/* Model resolution                                                           */
/* -------------------------------------------------------------------------- */

describe('model resolution', () => {
  it('resolves the provider id of the selected route', () => {
    expect(resolveModel(builtinCatalog, 'claude-sonnet-5-5', 'firstParty')).toBe('claude-sonnet-5-5');
    expect(resolveModel(builtinCatalog, 'claude-sonnet-5-5', 'bedrock')).toBe(
      'us.anthropic.claude-sonnet-5-5',
    );
    expect(resolveModel(builtinCatalog, 'claude-mythos-5', 'firstParty')).toBe('claude-mythos-5');
  });

  it('falls back to mantle when the selected route does not serve the model', () => {
    // The target's `wd(model)`: `provider_ids[route] === null` while
    // `provider_ids[mantle] !== null`.
    const mythos = builtinCatalog.models.find((model) => model.id === 'claude-mythos-5') as CatalogModel;
    expect(notServedOn(mythos, 'bedrock')).toBe(true);
    expect(resolveModel(builtinCatalog, 'claude-mythos-5', 'bedrock')).toBeUndefined();
    expect(resolveModelRoute(builtinCatalog, 'claude-mythos-5', 'bedrock')).toBeUndefined();

    // A row the target's literal marks as `null` on one route and serves on
    // `mantle` falls back to `mantle`.
    const imported = importCatalog({
      schema_version: 1,
      models: [
        {
          id: 'agent-test',
          family: 'haiku',
          display_name: 'Test',
          provider_ids: { gateway: null, mantle: 'anthropic.agent-test' },
          max_output_tokens: { default: 1, upper: 2 },
          capabilities: [],
        },
      ],
    });
    expect(resolveModelRoute(imported, 'agent-test', 'gateway')).toBe('mantle');
    expect(resolveModel(imported, 'agent-test', 'gateway')).toBe('anthropic.agent-test');

    // An unknown model resolves to nothing.
    expect(resolveModel(builtinCatalog, 'claude-nope', 'firstParty')).toBeUndefined();
    expect(resolveModelRoute(builtinCatalog, 'claude-nope', 'firstParty')).toBeUndefined();
  });

  it('does not fall back for a route whose key the target\'s literal omits', () => {
    // The target's own literal OMITS the `gateway` key for `claude-haiku-5-5`.
    // An omitted key is not `null`, so the target's predicate does not fire:
    // the target does not treat that row as unserved by `gateway`.
    const raw = (builtinFile.models as Array<Record<string, unknown>>).find(
      (row) => row.id === 'claude-haiku-5-5',
    ) as Record<string, unknown>;
    const providerIds = raw.provider_ids as Record<string, unknown>;
    expect(Object.hasOwn(providerIds, 'gateway')).toBe(false);
    expect(providerIds.gateway).toBeUndefined();

    const row = builtinCatalog.models.find((model) => model.id === 'claude-haiku-5-5') as CatalogModel;
    expect(Object.hasOwn(row.providerIds, 'gateway')).toBe(false);
    expect(notServedOn(row, 'gateway')).toBe(false);

    // So the model stays on the selected route — and the route carries no id
    // for it, so there is nothing to resolve.
    expect(resolveModelRoute(builtinCatalog, 'claude-haiku-5-5', 'gateway')).toBe('gateway');
    expect(resolveModel(builtinCatalog, 'claude-haiku-5-5', 'gateway')).toBeUndefined();
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

  it('matches the family and the query case-insensitively', () => {
    // The family is matched case-insensitively, and trimmed.
    const haiku = ['claude-3-5-haiku', 'claude-haiku-4-5', 'claude-haiku-5-5'];
    expect(listModels(builtinCatalog, { family: 'HAIKU' }).map((model) => model.id)).toEqual(haiku);
    expect(listModels(builtinCatalog, { family: 'Haiku' }).map((model) => model.id)).toEqual(haiku);
    expect(listModels(builtinCatalog, { family: '  haiku  ' }).map((model) => model.id)).toEqual(haiku);
    expect(listModels(builtinCatalog, { family: 'MIXED CASE' })).toEqual([]);

    // The query is a case-insensitive substring match against the model id
    // and the display name.
    expect(listModels(builtinCatalog, { query: 'HAIKU 4.5' }).map((model) => model.id)).toEqual([
      'claude-haiku-4-5',
    ]);
    expect(listModels(builtinCatalog, { query: 'OPUS 5.5' }).map((model) => model.id)).toEqual([
      'claude-opus-5-5',
    ]);
    expect(listModels(builtinCatalog, { query: 'CLAUDE-FABLE-5' }).map((model) => model.id)).toEqual([
      'claude-fable-5',
      'claude-fable-5-1',
    ]);
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

  it('rejects an unknown eager-input-streaming key', () => {
    // An unknown key is an error, not a silent drop: the same rule the
    // `provider_ids` map follows.
    expect(() =>
      importCatalog({
        schema_version: 1,
        models: [
          {
            id: 'x',
            family: 'haiku',
            display_name: 'X',
            provider_ids: { first_party: 'x' },
            eager_input_streaming: { not_a_provider: true },
            max_output_tokens: { default: 1, upper: 1 },
            capabilities: [],
          },
        ],
      }),
    ).toThrow(/unknown eager-input-streaming key/);

    // A known key with a malformed value is an error too.
    expect(() =>
      importCatalog({
        schema_version: 1,
        models: [
          {
            id: 'x',
            family: 'haiku',
            display_name: 'X',
            provider_ids: { first_party: 'x' },
            eager_input_streaming: { first_party: 'yes' },
            max_output_tokens: { default: 1, upper: 1 },
            capabilities: [],
          },
        ],
      }),
    ).toThrow(/malformed eager-input-streaming value/);
  });

  it('rejects a malformed alias per_provider key', () => {
    // An unknown provider key in an alias is an error, not a silent drop.
    expect(() =>
      importCatalog({
        schema_version: 1,
        models: [],
        aliases: {
          opus: { default: 'claude-opus-5-5', per_provider: { not_a_provider: 'claude-opus-5-5' } },
        },
      }),
    ).toThrow(/unknown provider key/);

    // A known key with a malformed model id is an error as well.
    expect(() =>
      importCatalog({
        schema_version: 1,
        models: [],
        aliases: { opus: { default: 'claude-opus-5-5', per_provider: { bedrock: 7 } } },
      }),
    ).toThrow(/malformed model id/);
  });

  it('rejects a context without a window', () => {
    // A context that carries no window is not a context: the import refuses it
    // rather than importing a row whose window is unknown.
    expect(() =>
      importCatalog({
        schema_version: 1,
        models: [
          {
            id: 'x',
            family: 'haiku',
            display_name: 'X',
            provider_ids: { first_party: 'x' },
            context: { native_1m: true },
            max_output_tokens: { default: 1, upper: 1 },
            capabilities: [],
          },
        ],
      }),
    ).toThrow(/context without a window/);
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
/* The mantle fallback: what the target does, and what this implementation does         */
/* -------------------------------------------------------------------------- */

describe('the target\'s per-model route override', () => {
  it('implements the mantle half of the target\'s rule', () => {
    // The audited predicate: `provider_ids[route] === null` while
    // `provider_ids[mantle] !== null`. The target's `null` is kept as the
    // target's own marker, and the fallback fires.
    const imported = importCatalog({
      schema_version: 1,
      models: [
        {
          id: 'agent-test',
          family: 'haiku',
          display_name: 'Test',
          provider_ids: { gateway: null, mantle: 'anthropic.agent-test' },
          max_output_tokens: { default: 1, upper: 2 },
          capabilities: [],
        },
      ],
    });
    const row = imported.models[0] as CatalogModel;
    expect(row.providerIds.gateway).toBeNull();
    expect(notServedOn(row, 'gateway')).toBe(true);
    expect(resolveModelRoute(imported, 'agent-test', 'gateway')).toBe('mantle');
    expect(resolveModel(imported, 'agent-test', 'gateway')).toBe('anthropic.agent-test');
  });

  it('uses the audited predicate, and not a superset of it', () => {
    // The target's predicate is `provider_ids[route] === null`. This
    // implementation's predicate is that predicate, so the two agree on every
    // row of the built-in table — and on the one row whose key the target's
    // literal **omits**.
    // The audited case (an explicit `null` on the route and a string on
    // `mantle`) has **no instance** in the built-in table — every built-in row
    // with a `null` route also has a `null` mantle — so a synthetic row
    // carries it into the sweep and keeps the assertion below from being
    // vacuous.
    const auditedCatalog = importCatalog({
      schema_version: 1,
      models: [
        {
          id: 'claude-audited-null',
          family: 'haiku',
          display_name: 'Audited null',
          provider_ids: {
            first_party: 'claude-audited-null',
            bedrock: 'claude-audited-null',
            vertex: 'claude-audited-null',
            foundry: 'claude-audited-null',
            anthropic_aws: 'claude-audited-null',
            anthropic_google_cloud: 'claude-audited-null',
            gateway: null,
            mantle: 'anthropic.claude-audited-null',
          },
          max_output_tokens: { default: 1, upper: 1 },
          capabilities: [],
        },
      ],
    });

    const cases: Array<{
      id: string;
      providerIds: Record<string, string | null>;
      catalog: ModelCatalog;
    }> = [];
    for (const raw of builtinFile.models as Array<Record<string, unknown>>) {
      cases.push({
        id: raw.id as string,
        providerIds: raw.provider_ids as Record<string, string | null>,
        catalog: builtinCatalog,
      });
    }
    cases.push({
      id: 'claude-audited-null',
      providerIds: {
        first_party: 'claude-audited-null',
        bedrock: 'claude-audited-null',
        vertex: 'claude-audited-null',
        foundry: 'claude-audited-null',
        anthropic_aws: 'claude-audited-null',
        anthropic_google_cloud: 'claude-audited-null',
        gateway: null,
        mantle: 'anthropic.claude-audited-null',
      },
      catalog: auditedCatalog,
    });

    const mismatched: string[] = [];
    let auditedCases = 0;

    for (const { id, providerIds, catalog } of cases) {
      const mantleId = providerIds.mantle;
      const model = findModel(catalog, id) as CatalogModel;
      for (const route of ROUTE_NAMES) {
        const targetKey = providerKeyForRoute(route) as string;
        // The audited predicate.
        const audited = providerIds[targetKey] === null && typeof mantleId === 'string';
        // This implementation's own behaviour, **observed** rather than recomputed.
        // The fallback is a move *to* `mantle`, so a route that already **is**
        // `mantle` never falls back.
        const implementationFallsBack =
          route !== 'mantle' && resolveModelRoute(catalog, id, route) === 'mantle';

        if (audited) {
          auditedCases += 1;
          expect(implementationFallsBack).toBe(true);
        }
        if (implementationFallsBack !== audited) {
          mismatched.push(`${id}@${route}`);
        }
      }
    }

    // The audited predicate does fire in the sweep, so the assertion above is
    // not vacuous ...
    expect(auditedCases).toBeGreaterThan(0);
    // ... and the two agree on **every** row: the predicate is the target's,
    // not a superset of it.
    expect(mismatched).toEqual([]);
  });

  it('implements the Bedrock+Mantle anthropic.* override, and says so', () => {
    // The target's rule has two halves (audit §2.1). The second half is the
    // mantle fallback above. The FIRST half — "with Bedrock and Mantle both
    // enabled, an `anthropic.*` model resolves to `mantle`" — is implemented
    // through the **enabled-flag set** the route layer hands in.
    const header = moduleHeader('catalog.ts');

    // The **module header** must say so, and must name the wiring.
    expect(header).toContain('Bedrock and Mantle');
    expect(header).toContain('anthropic.*');
    expect(header).toContain('enabled-flag set');
    expect(header).toContain('resolveRouteForModel');

    // And this implementation does redirect: an `anthropic.*` model on the bedrock
    // route goes to `mantle` when **both** routes are enabled — and stays on
    // bedrock when the enabled-flag set is absent, so the two-argument
    // callers keep their behavior.
    const row = builtinCatalog.models.find((model) => model.id === 'claude-haiku-5-5') as CatalogModel;
    expect(providerIdFor(row, 'mantle')).toBe('anthropic.claude-haiku-5-5');
    expect(resolveRouteForModel(row, 'bedrock')).toBe('bedrock');
    expect(
      resolveRouteForModel(
        row,
        'bedrock',
        enabledRoutes({ CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_MANTLE: '1' }),
      ),
    ).toBe('mantle');
    expect(resolveModel(builtinCatalog, 'claude-haiku-5-5', 'bedrock')).toBe('us.anthropic.claude-haiku-5-5');
  });
});

/* -------------------------------------------------------------------------- */
/* The shared catalog                                                         */
/* -------------------------------------------------------------------------- */

describe('the shared built-in catalog', () => {
  it('hands out copies, so a caller cannot corrupt the shared table', () => {
    const before = JSON.stringify(builtinCatalog);

    const catalog = builtinCatalogFor('conn-copy');

    // The copy is **deep**: the rows are not the shared rows.
    expect(catalog.models[0]).not.toBe(builtinCatalog.models[0]);
    expect(catalog.models[0]?.providerIds).not.toBe(builtinCatalog.models[0]?.providerIds);
    expect(catalog.models[0]?.maxOutputTokens).not.toBe(builtinCatalog.models[0]?.maxOutputTokens);
    expect(catalog.models[0]?.capabilities).not.toBe(builtinCatalog.models[0]?.capabilities);

    // Mutating the returned array does not touch the shared one.
    catalog.models.push(catalog.models[0] as CatalogModel);
    expect(catalog.models).toHaveLength(23);
    expect(builtinCatalog.models).toHaveLength(22);

    // Mutating a returned row does not touch the shared one either.
    const row = catalog.models[0] as CatalogModel;
    row.id = 'mutated';
    row.displayName = 'mutated';
    row.providerIds.firstParty = 'mutated';
    row.maxOutputTokens.upper = 1;
    row.capabilities.push('mutated');
    expect(builtinCatalog.models[0]?.id).toBe('claude-3-5-haiku');
    expect(builtinCatalog.models[0]?.displayName).toBe('Haiku 3.5');
    expect(builtinCatalog.models[0]?.providerIds.firstParty).toBe('claude-3-5-haiku-20241022');
    expect(builtinCatalog.models[0]?.maxOutputTokens.upper).toBe(8192);
    expect(builtinCatalog.models[0]?.capabilities).toEqual([]);

    // The same for the rows a caller gets from `listModels`.
    const listed = listModels(builtinCatalog);
    expect(listed[0]).not.toBe(builtinCatalog.models[0]);
    (listed[0] as CatalogModel).displayName = 'mutated';
    listed.push(listed[0] as CatalogModel);
    expect(listed).toHaveLength(23);
    expect(builtinCatalog.models).toHaveLength(22);
    expect(builtinCatalog.models[0]?.displayName).toBe('Haiku 3.5');

    // The shared table is untouched throughout.
    expect(JSON.stringify(builtinCatalog)).toBe(before);
  });

  it('stamps the connection id onto the copy it hands out', () => {
    const catalog = builtinCatalogFor('conn-42');
    expect(catalog.connectionId).toBe('conn-42');
    // The shared catalog keeps its own id: the stamp is on the copy.
    expect(builtinCatalog.connectionId).toBe('builtin');
  });
});

/* -------------------------------------------------------------------------- */
/* The catalog never touches a credential                                       */
/* -------------------------------------------------------------------------- */

describe('the catalog and the credential', () => {
  afterEach(() => {
    // The spy backend never outlives the test that installed it.
    setKeychainBackend(null);
  });

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

  it('never reads the credential store while the catalog is listed, imported, normalized or resolved', async () => {
    // The credential store is spied on: a lookup is the only way a secret can
    // be read, so "the lookup was never called" is the whole claim.
    const secret = 'catalog-secret-value';
    const lookup = vi.fn(async () => ({ found: true, value: secret }));
    const backend: KeychainBackend = { name: 'spy', lookup };
    setKeychainBackend(backend);

    try {
      const withCredential: Connection = {
        id: 'configured',
        name: 'Configured',
        route: 'firstParty',
        credential: { kind: 'keychain', service: 'prricode', account: 'configured' },
        catalogSource: 'builtin',
        enabled: true,
      };
      const withoutCredential: Connection = {
        id: 'unconfigured',
        name: 'Unconfigured',
        route: 'bedrock',
        credential: { kind: 'keychain', service: 'prricode', account: 'unconfigured' },
        catalogSource: 'builtin',
        enabled: false,
      };
      const registry = createProviderRegistry([withCredential, withoutCredential]);

      const active = registry.active();
      expect(active?.id).toBe('configured');
      const unusable = registry.get('unconfigured');
      expect(unusable).toBeDefined();

      // Every catalog operation, for **both** connections — the one with a
      // credential and the one without.
      for (const conn of [active, unusable]) {
        if (conn === undefined) throw new Error('missing connection');
        const catalog = builtinCatalogFor(conn.id);

        // List ...
        expect(listModels(catalog).length).toBe(22);
        // ... import ...
        expect(importCatalog(BUILTIN_CATALOG_RAW).models).toHaveLength(22);
        // ... normalize ...
        expect(usableModels(catalog, conn.route).length).toBeGreaterThan(0);
        // ... and resolve.
        expect(resolveModel(catalog, 'claude-sonnet-5-5', conn.route)).toBeDefined();
        expect(resolveModelRoute(catalog, 'claude-sonnet-5-5', conn.route)).toBeDefined();
      }

      // The credential store was never touched.
      expect(lookup).not.toHaveBeenCalled();

      // And the two connections do not resolve the same provider id: the
      // active connection's route and the unusable connection's route name
      // different provider models.
      const activeId = resolveModel(builtinCatalogFor('configured'), 'claude-sonnet-5-5', 'firstParty');
      const unusableId = resolveModel(builtinCatalogFor('unconfigured'), 'claude-sonnet-5-5', 'bedrock');
      expect(activeId).toBe('claude-sonnet-5-5');
      expect(unusableId).toBe('us.anthropic.claude-sonnet-5-5');
      expect(unusableId).not.toBe(activeId);
    } finally {
      setKeychainBackend(null);
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

  it('normalizes a model that declares no context', () => {
    const model = builtinCatalog.models.find((entry) => entry.id === 'claude-3-5-haiku');
    expect(model).toBeDefined();
    const row = model as CatalogModel;
    expect(row.context).toBeUndefined();

    const normalized = normalizeModel(row, 'firstParty');
    expect(normalized).toBeDefined();
    // No context means no window and no one-million-token flags — the
    // normalized object says "not declared", it does not invent a value.
    expect(normalized?.contextWindow).toBeUndefined();
    expect(normalized?.native1m).toBe(false);
    expect(normalized?.supports1mBeta).toBe(false);
    expect(normalized?.supports1mSuffix).toBe(false);
    expect(normalized?.providerId).toBe('claude-3-5-haiku-20241022');
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
    // The target's predicate: `provider_ids[route] === null` while
    // `provider_ids[mantle] !== null`. A row the target's literal marks as
    // `null` on the route resolves to `mantle`.
    const imported = importCatalog({
      schema_version: 1,
      models: [
        {
          id: 'agent-test',
          family: 'haiku',
          display_name: 'Test',
          provider_ids: { gateway: null, mantle: 'anthropic.agent-test' },
          max_output_tokens: { default: 1, upper: 2 },
          capabilities: [],
        },
      ],
    });
    const row = imported.models[0] as CatalogModel;
    expect(providerIdFor(row, 'gateway')).toBeUndefined();
    expect(providerIdFor(row, 'mantle')).toBe('anthropic.agent-test');

    const resolved = normalizeModel(row, 'gateway');
    expect(resolved?.route).toBe('mantle');
    expect(resolved?.providerId).toBe('anthropic.agent-test');

    // A model no route serves resolves to nothing.
    const mythos = builtinCatalog.models.find((entry) => entry.id === 'claude-mythos-5') as CatalogModel;
    expect(normalizeModel(mythos, 'mantle')).toBeUndefined();
    expect(normalizeModel(mythos, 'gateway')).toBeUndefined();
  });
});

/**
 * Contract test for provider route selection, the connection registry, and the
 * per-provider endpoint policy.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.1 (Providers and model
 * catalogs) — the route set, the dispatch order of the target's route selector
 * (`xe()`), and the per-provider endpoint-policy literal (`E`).
 *
 * What this test pins:
 *   - the eight route names, exactly;
 *   - the dispatch order (`gateway` first, then `bedrock`, `foundry`, `anthropicAws`,
 *     `anthropicGoogleCloud`, `mantle`, `vertex`, else `firstParty`);
 *   - the per-provider base-URL environment variables and the `ownHost` shapes;
 *   - the Foundry base-URL/resource conflict: the resolved value reports the
 *     variables that are in conflict, because the target's own adapter throws on
 *     them (audit §2.2a) and this implementation must not swallow the conflict;
 *   - the port is part of the vendor-host comparison, so the vendor's host name
 *     on a non-standard port is a user-supplied endpoint;
 *   - the registry's single-active invariant, its duplicate-id rejection, and the
 *     fact that two connections may share a route;
 *   - the untrusted-endpoint guard: a user-supplied base URL does not receive the
 *     credential unless the connection opts in, and the refusal names the host.
 *
 * The connection registry itself is a **project extension** — the target has no
 * user-managed registry of provider connections (audit §2.1, "Important negative
 * finding"). The route set, the dispatch order and the endpoint policy are
 * observed; the registry is not.
 */

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

import {
  DEFAULT_BASE_URLS,
  ENDPOINT_POLICIES,
  FOUNDRY_MISSING_BASE_URL_ERROR,
  FOUNDRY_MUTUALLY_EXCLUSIVE_ERROR,
  ROUTE_FLAG_ORDER,
  ROUTE_NAMES,
  ROUTE_ORDER,
  isProviderRoute,
  resolveBaseUrl,
  selectRoute,
  type ProviderRoute,
} from '../../src/provider/routes.js';
import {
  assertCredentialDelivery,
  checkCredentialDelivery,
  createProviderRegistry,
  resolveConnectionCredential,
  resolveConnectionEndpoint,
  useConnection,
  type Connection,
  type ProviderRegistry,
} from '../../src/provider/registry.js';
import type { SettingsTierMap } from '../../src/config/tiers.js';
import { SettingsTierEntry } from '../../src/config/tiers.js';

/**
 * The provider flag each route is selected by, in dispatch order.
 *
 * These are the **behavioral** pins of the route names: every one of the eight
 * names is produced by `selectRoute` for a documented input, so the names are
 * pinned by observable behavior rather than by a copied list.
 */
const PROVIDER_FLAG_CASES: ReadonlyArray<readonly [string, ProviderRoute]> = [
  ['CLAUDE_CODE_USE_BEDROCK', 'bedrock'],
  ['CLAUDE_CODE_USE_FOUNDRY', 'foundry'],
  ['CLAUDE_CODE_USE_ANTHROPIC_AWS', 'anthropicAws'],
  ['CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'anthropicGoogleCloud'],
  ['CLAUDE_CODE_USE_MANTLE', 'mantle'],
  ['CLAUDE_CODE_USE_VERTEX', 'vertex'],
];

/**
 * A **compile-time** pin on the eight route names.
 *
 * The runtime tests derive the route list from the implementation (so the test
 * cannot drift from the source), which leaves the exact spelling of the names
 * pinned only by this type-level assertion: `npx tsc --noEmit` fails if a name
 * is added, removed or renamed.
 */
type ExpectedRouteName =
  | 'firstParty'
  | 'gateway'
  | 'bedrock'
  | 'foundry'
  | 'anthropicAws'
  | 'anthropicGoogleCloud'
  | 'mantle'
  | 'vertex';

type AssertSameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const ROUTE_NAMES_MATCH_THE_TARGET_SET: AssertSameUnion<ProviderRoute, ExpectedRouteName> = true;

function tiersWith(entries: Record<string, unknown>): SettingsTierMap {
  const tiers: SettingsTierMap = new Map();
  tiers.set('userSettings', entries);
  return tiers;
}

describe('route set', () => {
  it('names exactly the eight routes the target declares', () => {
    expect(ROUTE_NAMES_MATCH_THE_TARGET_SET).toBe(true);
    expect(ROUTE_NAMES).toHaveLength(8);
    expect(new Set(ROUTE_NAMES).size).toBe(8);
    expect(ROUTE_NAMES.every((route) => isProviderRoute(route))).toBe(true);
  });

  it('reaches every declared route through the selector', () => {
    const reachable = new Set<ProviderRoute>([selectRoute({}, undefined)]);
    for (const [variable, route] of PROVIDER_FLAG_CASES) {
      reachable.add(selectRoute({ [variable]: '1' }, undefined));
    }
    reachable.add(selectRoute({}, tiersWith({ useGateway: true })));
    expect([...reachable].sort()).toEqual([...ROUTE_NAMES].sort());
  });

  it('keeps the target dispatch order, with gateway first and firstParty last', () => {
    expect(ROUTE_ORDER).toEqual([
      'gateway',
      'bedrock',
      'foundry',
      'anthropicAws',
      'anthropicGoogleCloud',
      'mantle',
      'vertex',
      'firstParty',
    ]);
  });

  it('derives the dispatch order from the flag order, so the two cannot drift', () => {
    // `selectRoute` walks `ROUTE_FLAG_ORDER`, so the published dispatch order is
    // derived from it rather than written out a second time.
    expect(ROUTE_ORDER).toEqual(['gateway', ...ROUTE_FLAG_ORDER, 'firstParty']);
    expect(ROUTE_FLAG_ORDER).not.toContain('gateway');
    expect(ROUTE_FLAG_ORDER).not.toContain('firstParty');
  });

  it('recognises a route name and rejects anything else', () => {
    expect(isProviderRoute('vertex')).toBe(true);
    expect(isProviderRoute('firstParty')).toBe(true);
    expect(isProviderRoute('Vertex')).toBe(false);
    expect(isProviderRoute('constructor')).toBe(false);
    expect(isProviderRoute('toString')).toBe(false);
    expect(isProviderRoute(undefined)).toBe(false);
    expect(isProviderRoute(42)).toBe(false);
  });
});

describe('selectRoute', () => {
  it('falls back to firstParty when no provider flag is set', () => {
    expect(selectRoute({}, undefined)).toBe('firstParty');
  });

  it('returns gateway when the gateway flag is set in settings', () => {
    const tiers = tiersWith({ useGateway: true });
    expect(selectRoute({}, tiers)).toBe('gateway');
  });

  it('reads the gateway flag through a settings accessor as well', () => {
    expect(selectRoute({}, () => true)).toBe('gateway');
    expect(selectRoute({}, () => undefined)).toBe('firstParty');
  });

  it('prefers gateway over every provider flag', () => {
    const tiers = tiersWith({ useGateway: true });
    const env = {
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
    };
    expect(selectRoute(env, tiers)).toBe('gateway');
  });

  it('selects each provider from its own environment flag', () => {
    for (const [variable, route] of PROVIDER_FLAG_CASES) {
      expect(selectRoute({ [variable]: '1' }, undefined)).toBe(route);
    }
  });

  it('resolves competing provider flags in the target dispatch order', () => {
    const all = {
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_FOUNDRY: '1',
      CLAUDE_CODE_USE_ANTHROPIC_AWS: '1',
      CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '1',
      CLAUDE_CODE_USE_MANTLE: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
    };
    expect(selectRoute(all, undefined)).toBe('bedrock');
    expect(selectRoute({ ...all, CLAUDE_CODE_USE_BEDROCK: undefined }, undefined)).toBe('foundry');
    expect(
      selectRoute({ ...all, CLAUDE_CODE_USE_BEDROCK: undefined, CLAUDE_CODE_USE_FOUNDRY: undefined }, undefined),
    ).toBe('anthropicAws');
    expect(
      selectRoute(
        {
          ...all,
          CLAUDE_CODE_USE_BEDROCK: undefined,
          CLAUDE_CODE_USE_FOUNDRY: undefined,
          CLAUDE_CODE_USE_ANTHROPIC_AWS: undefined,
        },
        undefined,
      ),
    ).toBe('anthropicGoogleCloud');
    expect(
      selectRoute(
        {
          ...all,
          CLAUDE_CODE_USE_BEDROCK: undefined,
          CLAUDE_CODE_USE_FOUNDRY: undefined,
          CLAUDE_CODE_USE_ANTHROPIC_AWS: undefined,
          CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: undefined,
        },
        undefined,
      ),
    ).toBe('mantle');
    expect(
      selectRoute(
        {
          ...all,
          CLAUDE_CODE_USE_BEDROCK: undefined,
          CLAUDE_CODE_USE_FOUNDRY: undefined,
          CLAUDE_CODE_USE_ANTHROPIC_AWS: undefined,
          CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: undefined,
          CLAUDE_CODE_USE_MANTLE: undefined,
        },
        undefined,
      ),
    ).toBe('vertex');
  });

  it('does not treat an explicitly disabled flag as set', () => {
    expect(selectRoute({ CLAUDE_CODE_USE_BEDROCK: '0' }, undefined)).toBe('firstParty');
    expect(selectRoute({ CLAUDE_CODE_USE_BEDROCK: 'false' }, undefined)).toBe('firstParty');
    expect(selectRoute({ CLAUDE_CODE_USE_BEDROCK: '' }, undefined)).toBe('firstParty');
  });

  it('does not let a project tier supply the top-level gateway key', () => {
    // The gateway flag is a top-level settings key, so only the policy, flag and
    // user tiers can supply it (audit §2.7 top-level resolution order).
    const tiers: SettingsTierMap = new Map();
    tiers.set('projectSettings', { useGateway: true });
    expect(selectRoute({}, tiers)).toBe('firstParty');
  });

  it('reads the gateway flag out of the tier wrappers the settings loader produces', () => {
    // `loadSettings` returns `Map<SettingsSource, SettingsTier>` whose entries are
    // `SettingsTierEntry` wrappers, so the selector has to unwrap them.
    const tiers: SettingsTierMap = new Map();
    tiers.set('userSettings', new SettingsTierEntry('userSettings', { useGateway: true }));
    expect(selectRoute({}, tiers)).toBe('gateway');
  });
});

function connection(overrides: Partial<Connection> & { id: string }): Connection {
  return {
    name: overrides.id,
    route: 'firstParty',
    credential: { kind: 'env', name: 'ANTHROPIC_API_KEY' },
    catalogSource: 'builtin',
    enabled: false,
    ...overrides,
  };
}

/**
 * A registry that hands out **copies** of its records.
 *
 * The plan's `ProviderRegistry` interface does not require `list()` to return
 * live records, so a conforming implementation may return copies — and a switch
 * that only mutates the objects `list()` returned would then silently do
 * nothing.
 */
function copyingRegistry(connections: readonly Connection[]): ProviderRegistry {
  const store = new Map<string, Connection>();
  for (const conn of connections) store.set(conn.id, { ...conn });
  return {
    list: () => [...store.values()].map((conn) => ({ ...conn })),
    get: (id) => {
      const conn = store.get(id);
      return conn === undefined ? undefined : { ...conn };
    },
    add: () => {
      throw new Error('this registry does not support add');
    },
    remove: () => false,
    active: () => {
      const enabled = [...store.values()].filter((conn) => conn.enabled);
      const first = enabled[0];
      if (enabled.length !== 1 || first === undefined) {
        throw new Error('no enabled provider connection');
      }
      return { ...first };
    },
  };
}

describe('the connection registry', () => {
  it('lists the connections it holds', () => {
    const registry = createProviderRegistry([
      connection({ id: 'first', name: 'First' }),
      connection({ id: 'second', name: 'Second', route: 'bedrock' }),
    ]);
    expect(registry.list().map((conn) => conn.id)).toEqual(['first', 'second']);
    expect(registry.get('second')?.route).toBe('bedrock');
  });

  it('returns undefined for an unknown id', () => {
    const registry = createProviderRegistry();
    expect(registry.get('nope')).toBeUndefined();
  });

  it('rejects a duplicate id', () => {
    const registry = createProviderRegistry([connection({ id: 'first' })]);
    expect(() => registry.add(connection({ id: 'first' }))).toThrow(/already exists/);
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects a connection whose route is not one of the eight', () => {
    const registry = createProviderRegistry();
    expect(() =>
      registry.add(connection({ id: 'bogus', route: 'constructor' as unknown as ProviderRoute })),
    ).toThrow(/unknown provider route/);
    expect(registry.list()).toHaveLength(0);
  });

  it('accepts every route the implementation declares', () => {
    // The registry's notion of a route must be the implementation's: a route
    // added to (or renamed in) `src/provider/routes.ts` is accepted here too.
    const registry = createProviderRegistry();
    for (const route of ROUTE_NAMES) {
      expect(() => registry.add(connection({ id: route, route }))).not.toThrow();
    }
    expect(registry.list().map((conn) => conn.route)).toEqual([...ROUTE_NAMES]);
  });

  it('validates the route through the shared predicate, not a second list of names', async () => {
    // The registry must not keep its own copy of the eight route names: a route
    // renamed in `src/provider/routes.ts` would then be silently rejected here.
    const source = await readFile(new URL('../../src/provider/registry.ts', import.meta.url), 'utf8');
    expect(source).toContain('isProviderRoute');
    expect(source).not.toMatch(/anthropicGoogleCloud/);
  });

  it('rejects a connection whose enabled flag is not a boolean', () => {
    const registry = createProviderRegistry();
    expect(() => registry.add(connection({ id: 'bogus', enabled: undefined }))).toThrow(/non-boolean enabled/);
    expect(registry.list()).toHaveLength(0);
  });

  it('removes a known id and reports an unknown one as not removed', () => {
    const registry = createProviderRegistry([connection({ id: 'first' })]);
    expect(registry.remove('nope')).toBe(false);
    expect(registry.remove('first')).toBe(true);
    expect(registry.list()).toHaveLength(0);
  });

  it('returns the single enabled connection as the active one', () => {
    const registry = createProviderRegistry([
      connection({ id: 'first', enabled: true }),
      connection({ id: 'second', route: 'bedrock' }),
    ]);
    expect(registry.active()?.id).toBe('first');
  });

  it('throws when no connection is enabled', () => {
    const registry = createProviderRegistry([connection({ id: 'first' })]);
    expect(() => registry.active()).toThrow(/no enabled/i);
  });

  it('throws when more than one connection is enabled', () => {
    const registry = createProviderRegistry([
      connection({ id: 'first', enabled: true }),
      connection({ id: 'second', route: 'bedrock', enabled: true }),
    ]);
    expect(() => registry.active()).toThrow(/multiple enabled/i);
  });

  it('lets two connections share the same route', () => {
    // A connection is keyed by a free-form name, not by a provider type, so
    // several connections may exist for the same protocol.
    const registry = createProviderRegistry([
      connection({ id: 'prod', name: 'Production', route: 'bedrock' }),
      connection({ id: 'staging', name: 'Staging', route: 'bedrock' }),
    ]);
    expect(registry.list()).toHaveLength(2);
    expect(registry.get('prod')?.route).toBe('bedrock');
    expect(registry.get('staging')?.route).toBe('bedrock');
  });

  it('switches the active connection', () => {
    const registry = createProviderRegistry([
      connection({ id: 'first', enabled: true }),
      connection({ id: 'second', route: 'bedrock' }),
    ]);
    const active = useConnection(registry, 'second');
    expect(active.id).toBe('second');
    expect(registry.active()?.id).toBe('second');
  });

  it('refuses to switch to an unknown id', () => {
    const registry = createProviderRegistry([connection({ id: 'first', enabled: true })]);
    expect(() => useConnection(registry, 'nope')).toThrow(/nope/);
  });

  it('fails loudly when the registry does not apply the switch', () => {
    // A registry that returns copies of its records is conforming: the plan's
    // interface does not require `list()` to hand out live records. The switch
    // must therefore be *verified*, not merely attempted.
    const registry = copyingRegistry([
      connection({ id: 'first', enabled: true }),
      connection({ id: 'second', route: 'bedrock' }),
    ]);
    expect(() => useConnection(registry, 'second')).toThrow(/did not report it as the enabled connection/);
    expect(registry.list().find((conn) => conn.enabled)?.id).toBe('first');
  });
});

describe('the endpoint policy', () => {
  it('declares one policy per route with the target base-URL variables', () => {
    const variables = new Map(ENDPOINT_POLICIES.map((policy) => [policy.route, policy.baseUrlVariables]));
    expect(ENDPOINT_POLICIES).toHaveLength(8);
    expect(variables.get('firstParty')).toEqual([]);
    expect(variables.get('gateway')).toEqual([]);
    expect(variables.get('bedrock')).toEqual([
      'ANTHROPIC_BEDROCK_BASE_URL',
      'AWS_ENDPOINT_URL_BEDROCK_RUNTIME',
      'AWS_ENDPOINT_URL_BEDROCK',
      'AWS_ENDPOINT_URL',
    ]);
    expect(variables.get('mantle')).toEqual(['ANTHROPIC_BEDROCK_MANTLE_BASE_URL']);
    expect(variables.get('anthropicAws')).toEqual(['ANTHROPIC_AWS_BASE_URL']);
    expect(variables.get('vertex')).toEqual(['ANTHROPIC_VERTEX_BASE_URL']);
    expect(variables.get('anthropicGoogleCloud')).toEqual(['ANTHROPIC_GOOGLE_CLOUD_BASE_URL']);
    expect(variables.get('foundry')).toEqual(['ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_RESOURCE']);
  });

  it('gives every route an https default base URL', () => {
    for (const route of ROUTE_NAMES) {
      expect(DEFAULT_BASE_URLS[route].startsWith('https://')).toBe(true);
    }
  });

  it('picks up the Bedrock base URL and refuses to call a foreign host a vendor host', () => {
    const env = { ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock-proxy.example.com' };
    const resolved = resolveBaseUrl('bedrock', env);
    expect(resolved.baseUrl).toBe('https://bedrock-proxy.example.com');
    expect(resolved.isVendorHost).toBe(false);
  });

  it('recognises a Bedrock regional host as the vendor host', () => {
    const env = { ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock-runtime.us-east-1.amazonaws.com' };
    expect(resolveBaseUrl('bedrock', env).isVendorHost).toBe(true);
  });

  it('reads the Bedrock base URL from the other declared variables too', () => {
    expect(
      resolveBaseUrl('bedrock', { AWS_ENDPOINT_URL_BEDROCK_RUNTIME: 'https://bedrock.us-west-2.amazonaws.com' })
        .baseUrl,
    ).toBe('https://bedrock.us-west-2.amazonaws.com');
    expect(resolveBaseUrl('bedrock', { AWS_ENDPOINT_URL_BEDROCK: 'https://bedrock.eu-west-1.amazonaws.com' }).baseUrl)
      .toBe('https://bedrock.eu-west-1.amazonaws.com');
    expect(resolveBaseUrl('bedrock', { AWS_ENDPOINT_URL: 'https://bedrock.us-east-2.amazonaws.com' }).baseUrl).toBe(
      'https://bedrock.us-east-2.amazonaws.com',
    );
  });

  it('resolves the Bedrock base URL through its four variables in the declared order', () => {
    // The audit declares four Bedrock base-URL variables; this implementation reads them in
    // that order, so the first one that is set wins.
    const all = {
      ANTHROPIC_BEDROCK_BASE_URL: 'https://one.example.com',
      AWS_ENDPOINT_URL_BEDROCK_RUNTIME: 'https://two.example.com',
      AWS_ENDPOINT_URL_BEDROCK: 'https://three.example.com',
      AWS_ENDPOINT_URL: 'https://four.example.com',
    };
    expect(resolveBaseUrl('bedrock', all).baseUrl).toBe('https://one.example.com');
    expect(resolveBaseUrl('bedrock', { ...all, ANTHROPIC_BEDROCK_BASE_URL: undefined }).baseUrl).toBe(
      'https://two.example.com',
    );
    expect(
      resolveBaseUrl('bedrock', {
        ...all,
        ANTHROPIC_BEDROCK_BASE_URL: undefined,
        AWS_ENDPOINT_URL_BEDROCK_RUNTIME: undefined,
      }).baseUrl,
    ).toBe('https://three.example.com');
    expect(
      resolveBaseUrl('bedrock', {
        ...all,
        ANTHROPIC_BEDROCK_BASE_URL: undefined,
        AWS_ENDPOINT_URL_BEDROCK_RUNTIME: undefined,
        AWS_ENDPOINT_URL_BEDROCK: undefined,
      }).baseUrl,
    ).toBe('https://four.example.com');
  });

  it('picks up the Vertex base URL', () => {
    const env = { ANTHROPIC_VERTEX_BASE_URL: 'https://us-aiplatform.googleapis.com' };
    const resolved = resolveBaseUrl('vertex', env);
    expect(resolved.baseUrl).toBe('https://us-aiplatform.googleapis.com');
    expect(resolved.isVendorHost).toBe(true);
  });

  it('derives the Foundry base URL from the resource name', () => {
    // **Observed** (audit §2.2a): the base URL is built as
    // `https://<resource>.services.ai.azure.com/anthropic/` — with a trailing
    // slash. The route-policy layer resolves it to the audited URL, so that
    // the driver has nothing to rebuild.
    const env = { ANTHROPIC_FOUNDRY_RESOURCE: 'my-deployment' };
    const resolved = resolveBaseUrl('foundry', env);
    expect(resolved.baseUrl).toBe('https://my-deployment.services.ai.azure.com/anthropic/');
    expect(resolved.isVendorHost).toBe(true);
  });

  it('recognises the audited Foundry host shape as the vendor\'s own host', () => {
    // The audited base URL carries the `/anthropic/` segment; the host — the
    // part the `ownHost` pattern matches — is the deployment's own host.
    expect(resolveBaseUrl('foundry', {}, 'https://my-deployment.services.ai.azure.com/anthropic/').isVendorHost).toBe(
      true,
    );
    expect(resolveBaseUrl('foundry', {}, 'https://my-deployment.services.ai.azure.com').isVendorHost).toBe(true);
    expect(resolveBaseUrl('foundry', {}, 'https://elsewhere.example.com/anthropic/').isVendorHost).toBe(false);
  });

  it('prefers the Foundry base URL over the Foundry resource name', () => {
    // **Implementation choice.** The target's own Foundry adapter (`chunk-m5c0c57d.js`,
    // audit §2.2a) treats the two variables as *mutually exclusive* and throws
    // `baseURL and resource are mutually exclusive` — it states the rule and
    // picks **no** winner. Which variable this implementation's route-policy layer
    // prefers (the declared variable order: the base URL wins) is therefore a
    // implementation choice, and the conflict is reported rather than swallowed (see the
    // next test).
    const env = {
      ANTHROPIC_FOUNDRY_BASE_URL: 'https://from-base-url.services.ai.azure.com',
      ANTHROPIC_FOUNDRY_RESOURCE: 'from-resource',
    };
    expect(resolveBaseUrl('foundry', env).baseUrl).toBe('https://from-base-url.services.ai.azure.com');
  });

  it('reports the Foundry base-URL conflict so the driver layer can raise the target\'s error', () => {
    // The target's adapter throws `baseURL and resource are mutually exclusive`
    // when both are supplied (audit §2.2a). This implementation's route-policy layer
    // resolves a base URL anyway, so it must not erase the evidence: the
    // resolved value carries the variables that are in conflict, and they are
    // **exactly** the ones that were supplied.
    const resolved = resolveBaseUrl('foundry', {
      ANTHROPIC_FOUNDRY_BASE_URL: 'https://from-base-url.services.ai.azure.com',
      ANTHROPIC_FOUNDRY_RESOURCE: 'from-resource',
    });
    expect(resolved.conflictingVariables).toEqual([
      'ANTHROPIC_FOUNDRY_BASE_URL',
      'ANTHROPIC_FOUNDRY_RESOURCE',
    ]);
    expect(resolved.suppliedBaseUrlVariables).toEqual([
      'ANTHROPIC_FOUNDRY_BASE_URL',
      'ANTHROPIC_FOUNDRY_RESOURCE',
    ]);
  });

  it('carries the target\'s exact Foundry error strings for the driver layer', () => {
    // The target's bundled adapter throws these verbatim (audit §2.2a). The
    // driver layer (CC-006) raises them, so the strings are pinned here.
    expect(FOUNDRY_MUTUALLY_EXCLUSIVE_ERROR).toBe('baseURL and resource are mutually exclusive');
    expect(FOUNDRY_MISSING_BASE_URL_ERROR).toBe(
      "Must provide one of the 'baseURL' or 'resource' arguments, or the ANTHROPIC_FOUNDRY_RESOURCE environment variable",
    );
  });

  it('reports the losing Foundry variable too, so the conflict survives the winner', () => {
    // The base URL wins in this implementation, so the *resource* variable is exactly the
    // evidence that must survive the resolution.
    const resolved = resolveBaseUrl('foundry', {
      ANTHROPIC_FOUNDRY_BASE_URL: 'https://from-base-url.services.ai.azure.com',
      ANTHROPIC_FOUNDRY_RESOURCE: 'from-resource',
    });
    expect(resolved.conflictingVariables).toContain('ANTHROPIC_FOUNDRY_RESOURCE');
  });

  it('reports no conflict when only one Foundry base-URL variable is supplied', () => {
    expect(
      resolveBaseUrl('foundry', { ANTHROPIC_FOUNDRY_BASE_URL: 'https://x.services.ai.azure.com' })
        .conflictingVariables,
    ).toBeUndefined();
    expect(resolveBaseUrl('foundry', { ANTHROPIC_FOUNDRY_RESOURCE: 'from-resource' }).conflictingVariables)
      .toBeUndefined();
    expect(resolveBaseUrl('foundry', {}).conflictingVariables).toBeUndefined();
  });

  it('reports the conflict when an explicit base URL meets the Foundry resource variable', () => {
    // The target's adapter sees a `baseURL` and a `resource` whichever way the
    // base URL was supplied, so the explicit one conflicts too. An explicit
    // base URL is not an environment variable, so it is not listed.
    const resolved = resolveBaseUrl(
      'foundry',
      { ANTHROPIC_FOUNDRY_RESOURCE: 'from-resource' },
      'https://explicit.services.ai.azure.com',
    );
    expect(resolved.conflictingVariables).toEqual(['ANTHROPIC_FOUNDRY_RESOURCE']);
  });

  it('carries the Foundry conflict through the registry\'s endpoint resolution', () => {
    // The driver layer may resolve an endpoint through the registry rather
    // than through `resolveBaseUrl`, so the conflict must survive that path
    // too — otherwise the target's error could never be raised.
    const conn = connection({ id: 'foundry', name: 'Foundry', route: 'foundry' });
    const env = {
      ANTHROPIC_FOUNDRY_BASE_URL: 'https://from-base-url.services.ai.azure.com',
      ANTHROPIC_FOUNDRY_RESOURCE: 'from-resource',
    };
    const endpoint = resolveConnectionEndpoint(conn, env);
    expect(endpoint.baseUrl).toBe('https://from-base-url.services.ai.azure.com');
    expect(endpoint.conflictingVariables).toEqual([
      'ANTHROPIC_FOUNDRY_BASE_URL',
      'ANTHROPIC_FOUNDRY_RESOURCE',
    ]);
  });

  it('reports no conflict for a route whose variables the target does not make exclusive', () => {
    // Bedrock declares four base-URL variables and the audit records no
    // mutual exclusion for them: the first one that is set simply wins.
    const resolved = resolveBaseUrl('bedrock', {
      ANTHROPIC_BEDROCK_BASE_URL: 'https://one.example.com',
      AWS_ENDPOINT_URL_BEDROCK_RUNTIME: 'https://two.example.com',
    });
    expect(resolved.conflictingVariables).toBeUndefined();
    expect(resolved.suppliedBaseUrlVariables).toEqual([
      'ANTHROPIC_BEDROCK_BASE_URL',
      'AWS_ENDPOINT_URL_BEDROCK_RUNTIME',
    ]);
  });

  it('accepts a Foundry resource name that contains an underscore or a dot', () => {
    // The target builds `https://<resource>.services.ai.azure.com/anthropic/`
    // from whatever string it is given (audit §2.2a), so a working Foundry
    // configuration must not be rejected by this implementation.
    const underscored = resolveBaseUrl('foundry', { ANTHROPIC_FOUNDRY_RESOURCE: 'my_deployment' });
    expect(underscored.baseUrl).toBe('https://my_deployment.services.ai.azure.com/anthropic/');
    expect(underscored.isVendorHost).toBe(true);

    const dotted = resolveBaseUrl('foundry', { ANTHROPIC_FOUNDRY_RESOURCE: 'my.deployment' });
    expect(dotted.baseUrl).toBe('https://my.deployment.services.ai.azure.com/anthropic/');
    expect(dotted.isVendorHost).toBe(true);
  });

  it('rejects a Foundry resource that is URL-shaped or an absolute path', () => {
    // A URL or a path in that variable would put a foreign endpoint into the
    // route's base URL, so this implementation refuses it loudly and names the variable.
    expect(() => resolveBaseUrl('foundry', { ANTHROPIC_FOUNDRY_RESOURCE: 'https://evil.example.com' })).toThrow(
      /ANTHROPIC_FOUNDRY_RESOURCE/,
    );
    expect(() => resolveBaseUrl('foundry', { ANTHROPIC_FOUNDRY_RESOURCE: '/etc/passwd' })).toThrow(
      /ANTHROPIC_FOUNDRY_RESOURCE/,
    );
    // **Implementation choice** (the research report's "bare resource name", not the
    // REA record): a value with characters a host label cannot carry is
    // refused too, rather than turned into a malformed vendor host.
    expect(() => resolveBaseUrl('foundry', { ANTHROPIC_FOUNDRY_RESOURCE: 'not a resource name' })).toThrow(
      /ANTHROPIC_FOUNDRY_RESOURCE/,
    );
  });

  it('does not treat a non-standard port on the vendor host as the vendor host', () => {
    // `URL.hostname` drops the port, so `https://api.anthropic.com:8443` would
    // compare equal to the canonical host and a credential would be delivered
    // to a non-standard port. The port is part of the comparison.
    expect(resolveBaseUrl('firstParty', {}, 'https://api.anthropic.com:8443').isVendorHost).toBe(false);
    expect(resolveBaseUrl('firstParty', {}, 'https://api.anthropic.com').isVendorHost).toBe(true);
    expect(
      resolveBaseUrl('bedrock', {}, 'https://bedrock-runtime.us-east-1.amazonaws.com:8443').isVendorHost,
    ).toBe(false);
  });

  it('treats the default port of the scheme as no port at all', () => {
    // `URL` normalises the default port away, so the canonical host still
    // matches when the port is written out.
    expect(resolveBaseUrl('firstParty', {}, 'https://api.anthropic.com:443').isVendorHost).toBe(true);
  });

  it('reports the vendor default host for a route that declares no base-URL variable', () => {
    const resolved = resolveBaseUrl('firstParty', {});
    expect(resolved.baseUrl).toBe('https://api.anthropic.com');
    expect(resolved.isVendorHost).toBe(true);
  });

  it('lets an explicit base URL win over the environment', () => {
    const env = { ANTHROPIC_VERTEX_BASE_URL: 'https://us-aiplatform.googleapis.com' };
    const resolved = resolveBaseUrl('vertex', env, 'https://eu-aiplatform.googleapis.com');
    expect(resolved.baseUrl).toBe('https://eu-aiplatform.googleapis.com');
  });

  it('treats a whitespace-only explicit base URL as absent', () => {
    const env = { ANTHROPIC_VERTEX_BASE_URL: 'https://us-aiplatform.googleapis.com' };
    expect(resolveBaseUrl('vertex', env, '   ').baseUrl).toBe('https://us-aiplatform.googleapis.com');
    expect(resolveBaseUrl('firstParty', {}, '   ').baseUrl).toBe('https://api.anthropic.com');
  });

  it('treats a host that matches no vendor pattern as a user-supplied endpoint', () => {
    expect(resolveBaseUrl('mantle', { ANTHROPIC_BEDROCK_MANTLE_BASE_URL: 'https://elsewhere.example.com' }).isVendorHost)
      .toBe(false);
    expect(resolveBaseUrl('anthropicAws', { ANTHROPIC_AWS_BASE_URL: 'https://elsewhere.example.com' }).isVendorHost)
      .toBe(false);
    expect(
      resolveBaseUrl('anthropicGoogleCloud', { ANTHROPIC_GOOGLE_CLOUD_BASE_URL: 'https://elsewhere.example.com' })
        .isVendorHost,
    ).toBe(false);
    expect(resolveBaseUrl('foundry', { ANTHROPIC_FOUNDRY_BASE_URL: 'https://elsewhere.example.com' }).isVendorHost).toBe(
      false,
    );
  });

  it('never treats a cleartext base URL as a vendor host', () => {
    // Implementation security posture: only an `https:` endpoint may be vendor-trusted,
    // so a credential can never be delivered in cleartext to the vendor's own
    // host.
    expect(resolveBaseUrl('firstParty', {}, 'http://api.anthropic.com').isVendorHost).toBe(false);
    expect(
      resolveBaseUrl('bedrock', {}, 'http://bedrock-runtime.us-east-1.amazonaws.com').isVendorHost,
    ).toBe(false);
  });
});

describe('the untrusted-endpoint guard', () => {
  it('refuses to deliver a credential to a user-supplied endpoint', () => {
    const conn = connection({
      id: 'proxy',
      name: 'Proxy',
      baseUrl: 'https://proxy.internal.example',
    });
    const decision = checkCredentialDelivery(conn, {});
    expect(decision.allowed).toBe(false);
    expect(decision.host).toBe('proxy.internal.example');
    expect(decision.reason).toContain('proxy.internal.example');
  });

  it('delivers a credential to the vendor host', () => {
    const conn = connection({
      id: 'bedrock',
      name: 'Bedrock',
      route: 'bedrock',
      baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    });
    const decision = checkCredentialDelivery(conn, {});
    expect(decision.allowed).toBe(true);
    expect(decision.host).toBe('bedrock-runtime.us-east-1.amazonaws.com');
  });

  it('delivers a credential when the connection names no base URL at all', () => {
    const conn = connection({ id: 'first-party', name: 'First party' });
    const decision = checkCredentialDelivery(conn, {});
    expect(decision.allowed).toBe(true);
    expect(decision.host).toBe('api.anthropic.com');
  });

  it('treats a whitespace-only base URL on the connection as absent', () => {
    const conn = connection({ id: 'first-party', name: 'First party', baseUrl: '   ' });
    const endpoint = resolveConnectionEndpoint(conn, {});
    expect(endpoint.baseUrl).toBe('https://api.anthropic.com');
    expect(endpoint.host).toBe('api.anthropic.com');
    expect(endpoint.isVendorHost).toBe(true);
  });

  it('accepts the canonical first-party host as the vendor host', () => {
    const conn = connection({
      id: 'first-party',
      name: 'First party',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(checkCredentialDelivery(conn, {}).allowed).toBe(true);
  });

  it('refuses to deliver a credential to the vendor host on a non-standard port', () => {
    // The port is part of the vendor-host comparison, so the same host name on
    // another port is a user-supplied endpoint and the refusal names it.
    const conn = connection({
      id: 'first-party',
      name: 'First party',
      baseUrl: 'https://api.anthropic.com:8443',
    });
    const decision = checkCredentialDelivery(conn, {});
    expect(decision.allowed).toBe(false);
    expect(decision.host).toBe('api.anthropic.com:8443');
    expect(decision.reason).toContain('api.anthropic.com:8443');
  });

  it('refuses to deliver a credential in cleartext to the canonical host', () => {
    const conn = connection({
      id: 'first-party',
      name: 'First party',
      baseUrl: 'http://api.anthropic.com',
    });
    const decision = checkCredentialDelivery(conn, {});
    expect(decision.allowed).toBe(false);
    expect(decision.host).toBe('api.anthropic.com');
    expect(decision.reason).toContain('api.anthropic.com');
  });

  it('delivers a credential to a user-supplied endpoint when the connection opts in', () => {
    const conn = connection({
      id: 'proxy',
      name: 'Proxy',
      baseUrl: 'https://proxy.internal.example',
      allowUntrustedEndpoint: true,
    });
    expect(checkCredentialDelivery(conn, {}).allowed).toBe(true);
  });

  it('throws with the host named when the delivery is refused', () => {
    const conn = connection({ id: 'proxy', name: 'Proxy', baseUrl: 'https://proxy.internal.example' });
    expect(() => assertCredentialDelivery(conn, {})).toThrow(/proxy\.internal\.example/);
  });

  it('refuses an endpoint that the environment supplied, not only an explicit one', () => {
    const conn = connection({ id: 'bedrock', name: 'Bedrock', route: 'bedrock' });
    const env = { ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock-proxy.example.com' };
    expect(checkCredentialDelivery(conn, env).allowed).toBe(false);
    expect(resolveConnectionEndpoint(conn, env).host).toBe('bedrock-proxy.example.com');
  });

  it('treats any Google host as a vendor host for the two Google routes', () => {
    // Documented consequence of the audit's `*.googleapis.com` alternative: the
    // untrusted-endpoint guard does **not** protect these two routes. The test
    // pins the current behaviour so a future change to it is deliberate.
    expect(
      resolveBaseUrl('vertex', { ANTHROPIC_VERTEX_BASE_URL: 'https://attacker.googleapis.com' }).isVendorHost,
    ).toBe(true);
    expect(
      resolveBaseUrl('anthropicGoogleCloud', {
        ANTHROPIC_GOOGLE_CLOUD_BASE_URL: 'https://attacker.googleapis.com',
      }).isVendorHost,
    ).toBe(true);

    const conn = connection({
      id: 'vertex',
      name: 'Vertex',
      route: 'vertex',
      baseUrl: 'https://attacker.googleapis.com',
    });
    expect(checkCredentialDelivery(conn, {}).allowed).toBe(true);
  });
});

describe('the guarded credential resolution', () => {
  it('resolves the credential of a vendor endpoint', async () => {
    const conn = connection({
      id: 'first-party',
      name: 'First party',
      credential: { kind: 'env', name: 'PRRICODE_TEST_KEY' },
    });
    const resolved = await resolveConnectionCredential(conn, { PRRICODE_TEST_KEY: 'sk-test' });
    expect(resolved).toEqual({ present: true, value: 'sk-test' });
  });

  it('refuses to resolve the credential of a user-supplied endpoint, naming the host', async () => {
    const conn = connection({
      id: 'proxy',
      name: 'Proxy',
      baseUrl: 'https://proxy.internal.example',
      credential: { kind: 'env', name: 'PRRICODE_TEST_KEY' },
    });
    await expect(resolveConnectionCredential(conn, { PRRICODE_TEST_KEY: 'sk-test' })).rejects.toThrow(
      /proxy\.internal\.example/,
    );
  });

  it('refuses to resolve the credential of a cleartext endpoint', async () => {
    const conn = connection({
      id: 'first-party',
      name: 'First party',
      baseUrl: 'http://api.anthropic.com',
      credential: { kind: 'env', name: 'PRRICODE_TEST_KEY' },
    });
    await expect(resolveConnectionCredential(conn, { PRRICODE_TEST_KEY: 'sk-test' })).rejects.toThrow(
      /api\.anthropic\.com/,
    );
  });
});

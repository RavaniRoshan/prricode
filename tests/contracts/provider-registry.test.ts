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

import {
  ROUTE_ORDER,
  ROUTE_NAMES,
  ENDPOINT_POLICIES,
  resolveBaseUrl,
  selectRoute,
  type ProviderRoute,
} from '../../src/provider/routes.js';
import {
  assertCredentialDelivery,
  checkCredentialDelivery,
  createProviderRegistry,
  resolveConnectionEndpoint,
  useConnection,
  type Connection,
} from '../../src/provider/registry.js';
import type { SettingsTierMap } from '../../src/config/tiers.js';
import { SettingsTierEntry } from '../../src/config/tiers.js';

const ALL_ROUTES: readonly ProviderRoute[] = [
  'firstParty',
  'gateway',
  'bedrock',
  'foundry',
  'anthropicAws',
  'anthropicGoogleCloud',
  'mantle',
  'vertex',
];

function tiersWith(entries: Record<string, unknown>): SettingsTierMap {
  const tiers: SettingsTierMap = new Map();
  tiers.set('userSettings', entries);
  return tiers;
}

describe('route set', () => {
  it('names exactly the eight routes the target declares', () => {
    expect([...ROUTE_NAMES].sort()).toEqual([...ALL_ROUTES].sort());
    expect(ROUTE_NAMES).toHaveLength(8);
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
    const cases: ReadonlyArray<readonly [string, ProviderRoute]> = [
      ['CLAUDE_CODE_USE_BEDROCK', 'bedrock'],
      ['CLAUDE_CODE_USE_FOUNDRY', 'foundry'],
      ['CLAUDE_CODE_USE_ANTHROPIC_AWS', 'anthropicAws'],
      ['CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'anthropicGoogleCloud'],
      ['CLAUDE_CODE_USE_MANTLE', 'mantle'],
      ['CLAUDE_CODE_USE_VERTEX', 'vertex'],
    ];
    for (const [variable, route] of cases) {
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

  it('ignores a provider flag that a project tier sets for the gateway decision', () => {
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

  it('picks up the Vertex base URL', () => {
    const env = { ANTHROPIC_VERTEX_BASE_URL: 'https://us-aiplatform.googleapis.com' };
    const resolved = resolveBaseUrl('vertex', env);
    expect(resolved.baseUrl).toBe('https://us-aiplatform.googleapis.com');
    expect(resolved.isVendorHost).toBe(true);
  });

  it('derives the Foundry base URL from the resource name', () => {
    const env = { ANTHROPIC_FOUNDRY_RESOURCE: 'my-deployment' };
    const resolved = resolveBaseUrl('foundry', env);
    expect(resolved.baseUrl).toBe('https://my-deployment.services.ai.azure.com');
    expect(resolved.isVendorHost).toBe(true);
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

  it('accepts the canonical first-party host as the vendor host', () => {
    const conn = connection({
      id: 'first-party',
      name: 'First party',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(checkCredentialDelivery(conn, {}).allowed).toBe(true);
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
});

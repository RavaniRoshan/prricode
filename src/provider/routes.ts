/**
 * Provider route selection and the per-provider endpoint policy.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.1 (Providers and model
 * catalogs) — the route set, the dispatch order of the target's route selector
 * (`xe()` in `chunk-w4f5s3e0.js`), and the per-provider endpoint-policy literal (`E`).
 *
 * What is **observed** and reproduced here:
 *
 *   - the eight route names, exactly: `firstParty`, `gateway`, `bedrock`, `foundry`,
 *     `anthropicAws`, `anthropicGoogleCloud`, `mantle`, `vertex`;
 *   - the dispatch order: `gateway` first (when the gateway condition holds), then
 *     `bedrock`, `foundry`, `anthropicAws`, `anthropicGoogleCloud`, `mantle`,
 *     `vertex`, and `firstParty` otherwise;
 *   - the per-provider base-URL environment variables;
 *   - the `ownHost` host shapes, which are what distinguishes a *vendor* endpoint
 *     from a **user-supplied** one.
 *
 * What is a **implementation choice** (the target does not pin it, so this implementation does not
 * claim compatibility):
 *
 *   - The gateway condition. The target's selector is `if (Br() || aet() || cet())
 *     return "gateway"`, and the REA record does not resolve those three
 *     predicates. This implementation therefore reads **one explicit settings key**,
 *     `useGateway` (see `GATEWAY_SETTINGS_KEY`), and a truthy value selects the
 *     gateway route. The route *set* and the dispatch *order* are observed.
 *   - The truthiness rules for the environment flags and for the settings flag
 *     (see `flagEnabled`).
 *   - The default base URL of a route (`DEFAULT_BASE_URLS`). The region- and
 *     resource-derived hosts are **templates**: the target computes them at
 *     client-construction time from the deployment's region (audit §2.1) and the
 *     implementation's driver layer (CC-006) resolves the placeholder.
 *   - The precedence between `ANTHROPIC_FOUNDRY_BASE_URL` and
 *     `ANTHROPIC_FOUNDRY_RESOURCE`. The target does not state it, so this implementation
 *     uses the declared variable order (the base URL wins) and does not claim
 *     compatibility.
 *
 * **Signature note.** The plan writes `selectRoute(env, settings: SettingsSource)`.
 * A bare settings-source *name* cannot carry a value, and the plan's own
 * "Consumes" line requires `effectiveSource` from `src/config/tiers.ts`, which
 * takes the tier map. This implementation therefore keeps the parameter name and the
 * arity and accepts either a `SettingsTierMap` or a settings **accessor**
 * function. Both readings are supported, so a caller that has a tier map and a
 * caller that has a lookup function can both use the same selector.
 *
 * This module contains **no** connection-management logic: the target has no
 * user-managed registry of provider connections (audit §2.1, "Important negative
 * finding"). The registry is this implementation's deliberate product extension and lives
 * in `src/provider/registry.ts`.
 */

import {
  effectiveSource,
  resolveTopLevelKey,
  type SettingsSource,
  type SettingsTierMap,
} from '../config/tiers.js';

/** The eight provider routes the target declares. */
export type ProviderRoute =
  | 'firstParty'
  | 'gateway'
  | 'bedrock'
  | 'foundry'
  | 'anthropicAws'
  | 'anthropicGoogleCloud'
  | 'mantle'
  | 'vertex';

/**
 * The eight routes as a **membership list**, in the order the plan's Global
 * Constraints list them. The order is *not* meaningful; use `ROUTE_ORDER` for
 * the dispatch order.
 */
export const ROUTE_NAMES: readonly ProviderRoute[] = [
  'firstParty',
  'gateway',
  'bedrock',
  'foundry',
  'anthropicAws',
  'anthropicGoogleCloud',
  'mantle',
  'vertex',
];

/**
 * The target's dispatch order (audit §2.1): the gateway first, then the
 * provider flags in the order `bedrock`, `foundry`, `anthropicAws`,
 * `anthropicGoogleCloud`, `mantle`, `vertex`, and `firstParty` as the fallback.
 */
export const ROUTE_ORDER: readonly ProviderRoute[] = [
  'gateway',
  'bedrock',
  'foundry',
  'anthropicAws',
  'anthropicGoogleCloud',
  'mantle',
  'vertex',
  'firstParty',
];

/**
 * The routes that a single environment flag selects, in dispatch order. The
 * `gateway` route is **not** in this list: its condition is not an environment
 * flag in this implementation (see the file header).
 */
export const ROUTE_FLAG_ORDER: readonly ProviderRoute[] = [
  'bedrock',
  'foundry',
  'anthropicAws',
  'anthropicGoogleCloud',
  'mantle',
  'vertex',
];

/**
 * The environment variable that selects each flag-driven route. A `Map` rather
 * than a plain object so that a lookup can never resolve an inherited
 * `Object.prototype` member.
 */
export const ROUTE_ENV_VARS: ReadonlyMap<ProviderRoute, string> = new Map<ProviderRoute, string>([
  ['bedrock', 'CLAUDE_CODE_USE_BEDROCK'],
  ['foundry', 'CLAUDE_CODE_USE_FOUNDRY'],
  ['anthropicAws', 'CLAUDE_CODE_USE_ANTHROPIC_AWS'],
  ['anthropicGoogleCloud', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD'],
  ['mantle', 'CLAUDE_CODE_USE_MANTLE'],
  ['vertex', 'CLAUDE_CODE_USE_VERTEX'],
]);

/**
 * The settings key that turns on the `gateway` route.
 *
 * **Implementation choice.** The target's gateway condition (`Br() || aet() || cet()`) is
 * not resolved in the REA record, so this implementation names the flag explicitly instead
 * of guessing at the target's three predicates. It is a **top-level** settings
 * key, so only the policy, flag and user tiers can supply it (audit §2.7).
 */
export const GATEWAY_SETTINGS_KEY = 'useGateway';

/** A settings lookup: the key in, the value out. */
export type SettingsAccessor = (key: string) => unknown;

/**
 * What `selectRoute` accepts as its settings argument: the tier map itself, or a
 * lookup function over the resolved settings.
 */
export type RouteSettings = SettingsTierMap | SettingsAccessor;

/**
 * Whether a settings value counts as "on".
 *
 * **Implementation choice.** The target's truthiness rules for these flags are not in the
 * REA record. This implementation accepts `true`, a non-zero number, and a non-empty
 * string that is not one of the explicit false-like tokens (`false`, `0`, `no`,
 * `off`); everything else — including `undefined`, `null`, `''`, an object and an
 * array — is off.
 */
export function flagEnabled(value: unknown): boolean {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const token = value.trim().toLowerCase();
    if (token === '') return false;
    if (token === 'false' || token === '0' || token === 'no' || token === 'off') return false;
    return true;
  }
  return false;
}

/**
 * Read an environment variable through an **own-property** check, so a name that
 * collides with an `Object.prototype` member (`constructor`, `toString`, …) is
 * reported as unset rather than resolving to the inherited member.
 */
function readEnvValue(env: NodeJS.ProcessEnv | undefined, name: string): string | undefined {
  if (!env) return undefined;
  if (!Object.hasOwn(env, name)) return undefined;
  const value = env[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * A settings accessor over a tier map that resolves **top-level** keys through
 * the observed order (`policySettings` → `flagSettings` → `userSettings`).
 */
export function settingsAccessor(tiers: SettingsTierMap): SettingsAccessor {
  return (key: string) => resolveTopLevelKey(tiers, key)[0]?.value;
}

/**
 * The settings tier that supplies the gateway flag, or `null` when no tier
 * defines it. Useful for telling the user *where* the gateway came from.
 */
export function gatewayFlagSource(settings: RouteSettings | undefined): SettingsSource | null {
  if (settings === undefined || typeof settings === 'function') return null;
  return effectiveSource(settings, GATEWAY_SETTINGS_KEY);
}

function gatewayEnabled(settings: RouteSettings | undefined): boolean {
  if (settings === undefined) return false;
  if (typeof settings === 'function') return flagEnabled(settings(GATEWAY_SETTINGS_KEY));
  const source = effectiveSource(settings, GATEWAY_SETTINGS_KEY);
  if (source === null) return false;
  const effective = resolveTopLevelKey(settings, GATEWAY_SETTINGS_KEY)[0];
  return flagEnabled(effective?.value);
}

/**
 * Select the active route.
 *
 * The gateway wins over every provider flag; otherwise the first provider flag
 * in `ROUTE_FLAG_ORDER` wins; otherwise the route is `firstParty`. This mirrors
 * the target's dispatch order exactly (audit §2.1).
 */
export function selectRoute(env: NodeJS.ProcessEnv, settings?: RouteSettings): ProviderRoute {
  if (gatewayEnabled(settings)) return 'gateway';
  for (const route of ROUTE_FLAG_ORDER) {
    const variable = ROUTE_ENV_VARS.get(route);
    if (variable === undefined) continue;
    if (flagEnabled(readEnvValue(env, variable))) return route;
  }
  return 'firstParty';
}

/** Whether a value names one of the eight routes. */
export function isProviderRoute(value: unknown): value is ProviderRoute {
  return typeof value === 'string' && (ROUTE_NAMES as readonly string[]).includes(value);
}

/**
 * The per-provider endpoint policy.
 *
 * `baseUrlVariables` are the environment variables the target declares for the
 * provider, in the order this implementation reads them. `ownHost` matches that
 * provider's **own** vendor host: a base URL that matches it is a normal
 * deployment, and one that does not is a **user-supplied endpoint** that the
 * implementation treats as untrusted.
 */
export interface EndpointPolicy {
  route: ProviderRoute;
  baseUrlVariables: string[];
  ownHost?: RegExp;
}

/**
 * The endpoint policies the target declares (audit §2.1, the `E` literal).
 *
 * The two Google shapes overlap on purpose: the audit records Vertex's host shape
 * as "`aiplatform` / `*.googleapis.com`" and Anthropic-on-Google-Cloud's as
 * "`claude` / `*.googleapis.com`", and each therefore carries a service-label
 * alternative **and** the broad `*.googleapis.com` alternative. This implementation
 * reproduces both alternatives rather than narrowing them, because the audit
 * calls the variable list and the host patterns "the observable contract".
 */
export const ENDPOINT_POLICIES: readonly EndpointPolicy[] = [
  {
    route: 'firstParty',
    baseUrlVariables: [],
  },
  {
    route: 'gateway',
    baseUrlVariables: [],
  },
  {
    route: 'bedrock',
    baseUrlVariables: [
      'ANTHROPIC_BEDROCK_BASE_URL',
      'AWS_ENDPOINT_URL_BEDROCK_RUNTIME',
      'AWS_ENDPOINT_URL_BEDROCK',
      'AWS_ENDPOINT_URL',
    ],
    ownHost: /^bedrock(?:-runtime)?\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/,
  },
  {
    route: 'mantle',
    baseUrlVariables: ['ANTHROPIC_BEDROCK_MANTLE_BASE_URL'],
    ownHost: /^bedrock-mantle\.[a-z0-9-]+\.(?:amazonaws\.com(?:\.cn)?|api\.aws)$/,
  },
  {
    route: 'anthropicAws',
    baseUrlVariables: ['ANTHROPIC_AWS_BASE_URL'],
    ownHost: /^aws-external-anthropic\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/,
  },
  {
    route: 'vertex',
    baseUrlVariables: ['ANTHROPIC_VERTEX_BASE_URL'],
    ownHost:
      /^(?:[a-z0-9-]+\.)*aiplatform(?:\.[a-z0-9-]+)*\.googleapis\.com$|^(?:[a-z0-9-]+\.)+googleapis\.com$/,
  },
  {
    route: 'anthropicGoogleCloud',
    baseUrlVariables: ['ANTHROPIC_GOOGLE_CLOUD_BASE_URL'],
    ownHost:
      /^(?:[a-z0-9-]+\.)*claude(?:\.[a-z0-9-]+)*\.googleapis\.com$|^(?:[a-z0-9-]+\.)+googleapis\.com$/,
  },
  {
    route: 'foundry',
    baseUrlVariables: ['ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_RESOURCE'],
    ownHost: /^[a-z0-9-]+\.services\.ai\.azure\.com$/,
  },
];

/**
 * The base URL of a route when nothing configures one.
 *
 * **Implementation choice.** `firstParty` is the Anthropic API host. `gateway` falls back
 * to the same host because the target's pinned gateway URL is **not** in the
 * audit (§2.1 records it only as "<pinned gateway url>" and §2.3 records the
 * gateway's relationship to the catalog route as not established) — this is an
 * explicit gap, not a claim. The remaining hosts are **templates**: the target
 * derives them from the deployment's region (or the Foundry resource name) at
 * client-construction time, and this implementation's driver layer resolves the
 * placeholder.
 */
export const DEFAULT_BASE_URLS: Readonly<Record<ProviderRoute, string>> = Object.freeze({
  firstParty: 'https://api.anthropic.com',
  gateway: 'https://api.anthropic.com',
  bedrock: 'https://bedrock-runtime.{region}.amazonaws.com',
  mantle: 'https://bedrock-mantle.{region}.api.aws/anthropic',
  anthropicAws: 'https://aws-external-anthropic.{region}.amazonaws.com',
  vertex: 'https://aiplatform.googleapis.com',
  anthropicGoogleCloud: 'https://claude.googleapis.com',
  foundry: 'https://{resource}.services.ai.azure.com',
});

/** The endpoint policy of a route, or `undefined` for a route that is not one of the eight. */
export function endpointPolicyFor(route: ProviderRoute): EndpointPolicy | undefined {
  return ENDPOINT_POLICIES.find((policy) => policy.route === route);
}

/** The default base URL of a route, or `undefined` for a route that is not one of the eight. */
export function defaultBaseUrlFor(route: ProviderRoute): string | undefined {
  if (!Object.hasOwn(DEFAULT_BASE_URLS, route)) return undefined;
  return DEFAULT_BASE_URLS[route];
}

/**
 * The host of a base URL, or the empty string when the value cannot be parsed.
 *
 * A value without a scheme is normalized to `https://` first, so a bare host such
 * as `aiplatform.googleapis.com` is still recognised. An unparseable value
 * yields the empty string, which never matches a vendor pattern — this implementation
 * fails closed.
 */
export function hostOfBaseUrl(baseUrl: string): string {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Normalize a base URL: a missing scheme becomes `https://`. */
function normalizeBaseUrl(baseUrl: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
}

/**
 * The base URL of the Foundry route derived from `ANTHROPIC_FOUNDRY_RESOURCE`.
 * The target rejects a URL in that variable (the value must be a bare resource
 * name); this implementation ignores such a value and falls through to the next candidate.
 */
function foundryBaseUrlFromResource(resource: string): string | undefined {
  if (resource.includes('://') || resource.startsWith('/')) return undefined;
  if (!/^[a-z0-9-]+$/i.test(resource)) return undefined;
  return `https://${resource}.services.ai.azure.com`;
}

/**
 * Whether a host is the vendor's own host for a route.
 *
 * A route that declares an `ownHost` pattern uses it. A route that declares
 * none (`firstParty`, `gateway`) has no way to recognise a vendor host other
 * than its own default host, so anything else is a user-supplied endpoint.
 */
function isVendorHostFor(route: ProviderRoute, policy: EndpointPolicy, host: string): boolean {
  if (host === '') return false;
  if (policy.ownHost) return policy.ownHost.test(host);
  const fallback = defaultBaseUrlFor(route);
  if (fallback === undefined) return false;
  return host === hostOfBaseUrl(fallback);
}

/** The effective base URL of a route, and whether it is the vendor's own host. */
export interface ResolvedBaseUrl {
  baseUrl: string;
  isVendorHost: boolean;
}

/**
 * Resolve the base URL of a route.
 *
 * Precedence: an **explicit** URL (the connection's own) wins, then the route's
 * declared base-URL environment variables in the order the policy lists them,
 * then the route's default base URL.
 *
 * `isVendorHost` is `true` for the route's own default (a vendor deployment by
 * construction), and otherwise reports whether the resolved host matches the
 * provider's `ownHost` pattern. A host that does not match is a **user-supplied
 * endpoint**, and this implementation treats it as untrusted.
 */
export function resolveBaseUrl(
  route: ProviderRoute,
  env: NodeJS.ProcessEnv,
  explicit?: string,
): ResolvedBaseUrl {
  const policy = endpointPolicyFor(route);
  if (!policy) {
    throw new Error(`unknown provider route "${String(route)}"`);
  }

  const explicitValue = typeof explicit === 'string' ? explicit.trim() : '';
  if (explicitValue !== '') {
    const baseUrl = normalizeBaseUrl(explicitValue);
    return { baseUrl, isVendorHost: isVendorHostFor(route, policy, hostOfBaseUrl(baseUrl)) };
  }

  for (const variable of policy.baseUrlVariables) {
    const raw = readEnvValue(env, variable);
    if (raw === undefined) continue;
    const value = variable === 'ANTHROPIC_FOUNDRY_RESOURCE' ? foundryBaseUrlFromResource(raw) : raw;
    if (value === undefined) continue;
    const baseUrl = normalizeBaseUrl(value);
    return { baseUrl, isVendorHost: isVendorHostFor(route, policy, hostOfBaseUrl(baseUrl)) };
  }

  const fallback = defaultBaseUrlFor(route);
  if (fallback === undefined) {
    throw new Error(`unknown provider route "${String(route)}"`);
  }
  return { baseUrl: fallback, isVendorHost: true };
}

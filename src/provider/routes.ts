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
 *     from a **user-supplied** one;
 *   - the target's own Foundry rule that the base URL and the resource variable
 *     are **mutually exclusive** (audit §2.2a, the target's bundled adapter
 *     `chunk-m5c0c57d.js`) — this implementation *reports* that conflict rather than
 *     silently resolving it.
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
 *   - The **environment-level winner** between `ANTHROPIC_FOUNDRY_BASE_URL` and
 *     `ANTHROPIC_FOUNDRY_RESOURCE` — that is, which of the two this implementation's
 *     route-policy layer reads when both are set. The **target's** rule is
 *     stated by the target itself: its own bundled Foundry adapter
 *     (`chunk-m5c0c57d.js`, audit §2.2a) treats the two as **mutually
 *     exclusive**, throws `baseURL and resource are mutually exclusive` when
 *     both are supplied, and throws
 *     `Must provide one of the 'baseURL' or 'resource' arguments, or the
 *     ANTHROPIC_FOUNDRY_RESOURCE environment variable` when neither is. The
 *     target therefore states the rule and picks **no** winner. This implementation picks
 *     one (the declared variable order: the base URL wins) so that a driver can
 *     still be built, and it **reports** the conflict in the resolved value
 *     (`conflictingVariables`) so the driver layer (CC-006) can raise the
 *     target's own error. The winner itself is a implementation choice, not target
 *     behavior.
 *   - The **transport rule**: only an `https:` base URL may be vendor-trusted.
 *     The audit records host *shapes* only, so the requirement that a
 *     cleartext `http://` endpoint is never the vendor's own host is the
 *     implementation's own security posture, not a target behaviour. It is what keeps a
 *     credential from being delivered in cleartext to the canonical host.
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
 * The target's dispatch order (audit §2.1): the gateway first, then the
 * provider flags in the order `bedrock`, `foundry`, `anthropicAws`,
 * `anthropicGoogleCloud`, `mantle`, `vertex`, and `firstParty` as the fallback.
 *
 * **Derived**, not written out a second time: `selectRoute` walks
 * `ROUTE_FLAG_ORDER`, so the published dispatch order is computed from it and
 * the two cannot drift apart.
 */
export const ROUTE_ORDER: readonly ProviderRoute[] = Object.freeze([
  'gateway',
  ...ROUTE_FLAG_ORDER,
  'firstParty',
]);

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
 *
 * This is the **single** environment reader of the provider module:
 * `src/provider/credentials.ts` imports it, so the two modules cannot disagree
 * about what a value counts as set or about how it is trimmed.
 *
 * The value is **trimmed**: a variable that holds only whitespace counts as
 * unset, and a value that carries surrounding whitespace yields the trimmed
 * text, so a secret pasted with a trailing newline never travels to a provider
 * with the newline attached.
 */
export function readEnvValue(env: NodeJS.ProcessEnv | undefined, name: string): string | undefined {
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
  // The gateway key is a **top-level** settings key, so only a tier the
  // top-level resolution names (policy, flag, user) can supply it: a project or
  // local tier never turns the gateway on.
  if (gatewayFlagSource(settings) === null) return false;
  return flagEnabled(settingsAccessor(settings)(GATEWAY_SETTINGS_KEY));
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
 *
 * ## Security consequence of the `*.googleapis.com` alternative
 *
 * **The untrusted-endpoint guard does not protect the two Google routes.** The
 * broad alternative matches *any* host under `*.googleapis.com`, so a base URL
 * such as `https://attacker.googleapis.com` is reported as a **vendor host**:
 *
 *   - `resolveBaseUrl('vertex', { ANTHROPIC_VERTEX_BASE_URL: 'https://attacker.googleapis.com' })`
 *     yields `isVendorHost: true`;
 *   - the same holds for `anthropicGoogleCloud`;
 *   - `checkCredentialDelivery` therefore *allows* the delivery, because the
 *     host is (by the target's own pattern) the vendor's own.
 *
 * The shape is the target's, so this implementation keeps it — but the consequence is
 * documented here rather than left implicit, and a test pins the current
 * behaviour so that a future change to it is deliberate.
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
    // The `<name>` label is matched with the same character set this implementation
    // accepts for a resource name, because the target builds the host from
    // whatever string the variable holds (`https://<resource>.services.ai.azure.com`,
    // audit §2.2a). A resource name with `_` or `.` is a working Foundry
    // deployment, not a foreign host.
    ownHost: /^[a-z0-9._-]+\.services\.ai\.azure\.com$/,
  },
];

/**
 * The target's Foundry adapter's exact error strings.
 *
 * **Observed** (audit §2.2a, the target's bundled `chunk-m5c0c57d.js`): the
 * adapter treats `baseURL` and `resource` as mutually exclusive. This implementation does
 * not throw them here — `resolveBaseUrl` is the route-policy layer, and it
 * *reports* the conflict instead — so the strings live here for the driver
 * layer (CC-006) to raise verbatim.
 */
export const FOUNDRY_MUTUALLY_EXCLUSIVE_ERROR = 'baseURL and resource are mutually exclusive';

/**
 * The target's error for a Foundry client that is given neither a base URL nor
 * a resource.
 *
 * **Observed** (audit §2.2a). This implementation's Foundry route has a `{resource}`
 * template default, so this error belongs to the driver layer (CC-006), which
 * knows whether a resource was actually resolved.
 */
export const FOUNDRY_MISSING_BASE_URL_ERROR =
  "Must provide one of the 'baseURL' or 'resource' arguments, or the ANTHROPIC_FOUNDRY_RESOURCE environment variable";

/**
 * The base-URL variables the target treats as **mutually exclusive**, per route.
 *
 * **Observed.** The target's own bundled Foundry adapter throws
 * `baseURL and resource are mutually exclusive` when it is given both a base
 * URL and a resource (audit §2.2a), so the two Foundry variables are the pair
 * the target refuses. No other route declares an exclusive pair: Bedrock
 * declares four base-URL variables and the audit records no exclusion rule for
 * them, so the first one that is set simply wins.
 */
const MUTUALLY_EXCLUSIVE_BASE_URL_VARIABLES: ReadonlyMap<
  ProviderRoute,
  Readonly<{ baseUrl: string; resource: string }>
> = new Map([['foundry', { baseUrl: 'ANTHROPIC_FOUNDRY_BASE_URL', resource: 'ANTHROPIC_FOUNDRY_RESOURCE' }]]);

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
 * The host of a base URL — **with the port** when the URL carries a non-default
 * one — or the empty string when the value cannot be parsed.
 *
 * A value without a scheme is normalized to `https://` first, so a bare host such
 * as `aiplatform.googleapis.com` is still recognised. An unparseable value
 * yields the empty string, which never matches a vendor pattern — this implementation
 * fails closed.
 *
 * **The port is part of the host.** `URL.hostname` drops it, so
 * `https://api.anthropic.com:8443` would compare equal to the canonical
 * `https://api.anthropic.com` and a credential would be delivered to a
 * **non-standard port** of the vendor's own name. `URL` normalises the default
 * port of the scheme away (`https://x:443` reports no port at all), so the
 * canonical host still compares equal to itself.
 */
export function hostOfBaseUrl(baseUrl: string): string {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    return url.port === '' ? host : `${host}:${url.port}`;
  } catch {
    return '';
  }
}

/** Normalize a base URL: a missing scheme becomes `https://`. */
function normalizeBaseUrl(baseUrl: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
}

/**
 * Whether a base URL is an `https:` URL.
 *
 * **Implementation security posture.** The audit records host *shapes*, not transports, so
 * the requirement that a credential is never delivered in cleartext to the
 * vendor's own host is this implementation's own rule. A value without a scheme is
 * normalized to `https://` first, so a bare host counts as secure; an
 * unparseable value does not.
 */
export function isSecureBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(normalizeBaseUrl(baseUrl)).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The base URL of the Foundry route derived from `ANTHROPIC_FOUNDRY_RESOURCE`.
 *
 * The target builds `https://<resource>.services.ai.azure.com` from whatever
 * string the variable holds (audit §2.2a), so a **working** resource name must
 * not be rejected: the earlier `^[a-z0-9-]+$` posture refused names the target
 * accepts, such as `my_deployment` or `my.deployment`.
 *
 * What this implementation refuses, and why:
 *
 *   - a value that looks like a **URL** (it contains `://`) or an **absolute
 *     path** (it starts with `/`): such a value would put a foreign endpoint
 *     into the route's base URL. The external research report records that the
 *     documented variable takes a bare resource name and that a URL there is
 *     rejected with a specific message — that is **product context**, not the
 *     REA record, so this implementation cites it as such;
 *   - a value with characters a **host label cannot carry** (whitespace and the
 *     like). This character posture is a **implementation choice** — the research
 *     report's "bare resource name" — and **not** target behavior: the target
 *     simply interpolates the string.
 *
 * Refusing loudly is deliberate: silently falling through would leave the
 * route's *default* base URL in place, and that default is a `{resource}`
 * template, so a malformed value would otherwise be reported as a vendor host
 * it does not match.
 */
function foundryBaseUrlFromResource(resource: string): string {
  if (resource.includes('://') || resource.startsWith('/')) {
    throw new Error(
      'ANTHROPIC_FOUNDRY_RESOURCE must be a bare resource name (for example "my-deployment"), ' +
        `not a URL or a path: "${resource}"`,
    );
  }
  if (!/^[A-Za-z0-9._-]+$/.test(resource)) {
    throw new Error(
      'ANTHROPIC_FOUNDRY_RESOURCE must be a bare resource name (for example "my-deployment"), ' +
        `not a value with characters a host label cannot carry: "${resource}"`,
    );
  }
  return `https://${resource}.services.ai.azure.com`;
}

/**
 * Whether a host is the vendor's own host for a route.
 *
 * A route that declares an `ownHost` pattern uses it. A route that declares
 * none (`firstParty`, `gateway`) has no way to recognise a vendor host other
 * than its own default host, so anything else is a user-supplied endpoint.
 *
 * A base URL that is not `https:` is never vendor-trusted (implementation security
 * posture), so a cleartext endpoint to the canonical host is treated as a
 * user-supplied one.
 *
 * The comparison uses the host **with its port** (see `hostOfBaseUrl`), so the
 * vendor's host name on a non-standard port is a user-supplied endpoint.
 */
function isVendorHostFor(route: ProviderRoute, policy: EndpointPolicy, baseUrl: string): boolean {
  if (!isSecureBaseUrl(baseUrl)) return false;
  const host = hostOfBaseUrl(baseUrl);
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
  /**
   * Every base-URL **environment variable** of the route that was supplied, in
   * the order the policy lists them.
   *
   * **Additive.** The plan fixes the resolved value as `{ baseUrl, isVendorHost }`
   * (CC-004), and that shape still works: this field is optional and carries no
   * information the plan's shape lacks.
   */
  suppliedBaseUrlVariables?: string[];
  /**
   * The supplied base-URL variables that are in **conflict** under the target's
   * own rule, in the order the policy lists them.
   *
   * The target's Foundry adapter treats the base URL and the resource variable
   * as mutually exclusive and throws `baseURL and resource are mutually
   * exclusive` when both are supplied (audit §2.2a). This implementation's route-policy
   * layer resolves a base URL anyway — so that a driver can still be built — and
   * therefore **reports** the conflict here instead of swallowing it: the
   * driver layer (CC-006) can raise the target's own error from this field.
   *
   * The listed variables are exactly the ones that were supplied; an explicit
   * base URL is not a variable and is therefore not listed, though it does
   * trigger the conflict.
   */
  conflictingVariables?: string[];
}

/**
 * The base-URL variables of a route that were supplied.
 */
function suppliedBaseUrlVariables(route: ProviderRoute, env: NodeJS.ProcessEnv): string[] {
  const policy = endpointPolicyFor(route);
  if (!policy) return [];
  return policy.baseUrlVariables.filter((name) => readEnvValue(env, name) !== undefined);
}

/**
 * The supplied base-URL variables that the target treats as mutually exclusive.
 *
 * The target's Foundry adapter refuses a client that is given both a base URL
 * and a resource (audit §2.2a), so this implementation reports the same pair. A route
 * with no exclusive pair never reports a conflict.
 */
function conflictingBaseUrlVariables(
  route: ProviderRoute,
  env: NodeJS.ProcessEnv,
  explicitSupplied: boolean,
): string[] {
  const pair = MUTUALLY_EXCLUSIVE_BASE_URL_VARIABLES.get(route);
  if (pair === undefined) return [];
  const baseUrlSupplied = explicitSupplied || readEnvValue(env, pair.baseUrl) !== undefined;
  const resourceSupplied = readEnvValue(env, pair.resource) !== undefined;
  if (!baseUrlSupplied || !resourceSupplied) return [];
  return [pair.baseUrl, pair.resource].filter((name) => readEnvValue(env, name) !== undefined);
}

/**
 * Resolve the base URL of a route.
 *
 * Precedence: an **explicit** URL (the connection's own) wins, then the route's
 * declared base-URL environment variables in the order the policy lists them,
 * then the route's default base URL. An explicit value that is empty or only
 * whitespace counts as **absent**, so it falls through to the environment.
 *
 * `isVendorHost` is `true` for the route's own default (a vendor deployment by
 * construction), and otherwise reports whether the resolved host matches the
 * provider's `ownHost` pattern **and** the base URL is an `https:` one. A host
 * that does not match is a **user-supplied endpoint**, and this implementation treats it
 * as untrusted. The **port** is part of the comparison, so the vendor's host
 * name on a non-standard port is not the vendor's own host.
 *
 * `suppliedBaseUrlVariables` and `conflictingVariables` report what the
 * environment supplied and whether the target's own mutual-exclusion rule is
 * violated, so the driver layer (CC-006) can raise the target's error instead
 * of this implementation silently picking a winner.
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
  const supplied = suppliedBaseUrlVariables(route, env);
  const conflicting = conflictingBaseUrlVariables(route, env, explicitValue !== '');
  const reported = {
    ...(supplied.length > 0 ? { suppliedBaseUrlVariables: supplied } : {}),
    ...(conflicting.length > 0 ? { conflictingVariables: conflicting } : {}),
  };

  if (explicitValue !== '') {
    const baseUrl = normalizeBaseUrl(explicitValue);
    return { baseUrl, isVendorHost: isVendorHostFor(route, policy, baseUrl), ...reported };
  }

  for (const variable of policy.baseUrlVariables) {
    const raw = readEnvValue(env, variable);
    if (raw === undefined) continue;
    const value = variable === 'ANTHROPIC_FOUNDRY_RESOURCE' ? foundryBaseUrlFromResource(raw) : raw;
    const baseUrl = normalizeBaseUrl(value);
    return { baseUrl, isVendorHost: isVendorHostFor(route, policy, baseUrl), ...reported };
  }

  const fallback = defaultBaseUrlFor(route);
  if (fallback === undefined) {
    throw new Error(`unknown provider route "${String(route)}"`);
  }
  // A route's own default is a vendor deployment by construction, so it is
  // vendor-trusted without consulting the host pattern (the Foundry default is
  // a `{resource}` template that the driver layer resolves).
  return { baseUrl: fallback, isVendorHost: isSecureBaseUrl(fallback), ...reported };
}

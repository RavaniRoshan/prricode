/**
 * Provider route selection, the per-provider endpoint policy, the **endpoint
 * catalogue** and the **corporate-proxy** surface.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.1 (Providers and model
 * catalogs) — the route set, the dispatch order of the target's route selector
 * (`xe()` in `chunk-w4f5s3e0.js`), and the per-provider endpoint-policy literal (`E`).
 *
 * The **endpoint catalogue** and the **corporate proxy** are a different surface
 * from the per-provider policy, and they are read out of the target's own source
 * rather than from the audit — every claim carries a file and a byte offset in
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-endpoint-catalogue.md`.
 * The milestone is `CC-038` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`; the
 * conformance table is `docs/compatibility/provider-catalog.md`.
 *
 * What is **observed** and reproduced here:
 *
 *   - the eight route names, exactly: `firstParty`, `gateway`, `bedrock`, `foundry`,
 *     `anthropicAws`, `anthropicGoogleCloud`, `mantle`, `vertex`;
 *   - the dispatch order: `gateway` first (when the gateway condition holds), then
 *     `bedrock`, `foundry`, `anthropicAws`, `anthropicGoogleCloud`, `mantle`,
 *     `vertex`, and `firstParty` otherwise;
 *   - the **enabled-flag set** (`enabledRoutes`): every route the user's
 *     configuration turns on, derived from the same environment variables, the
 *     same settings and the same truthiness rule the selector uses, so the two
 *     cannot disagree. The target's selector returns exactly **one** route, but
 *     the target's per-model override (audit §2.1) needs to know that **two**
 *     of them are on: "with Bedrock and Mantle both enabled, an `anthropic.*`
 *     model resolves to `mantle`". The override itself lives in
 *     `src/provider/catalog.ts`, which is where a model resolves its route;
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
  documentOf,
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
 * **Derived**, not written out a second time: the order is `ROUTE_FLAG_ORDER`
 * with the gateway in front of it and `firstParty` behind it, and
 * `selectRoute` walks **this** list, so the published dispatch order is the
 * one the selector uses and the two cannot drift apart.
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
 * The routes the user's configuration turns on.
 *
 * The target's selector returns **exactly one** route, but the target's
 * per-model override needs to know that **two** of them are on: "with Bedrock
 * and Mantle both enabled, an `anthropic.*` model resolves to `mantle`"
 * (audit §2.1). This set is that knowledge.
 *
 * It is derived from **the same rules `selectRoute` uses** — the same
 * environment variables, the same `RouteSettings`, the same truthiness rule —
 * and `selectRoute` is implemented **on top of** it: the selector walks the
 * dispatch order and returns the first route the set holds. The two therefore
 * cannot disagree: a route `selectRoute` would have picked is always in the
 * set, and the environment is read **once** to build it.
 *
 * The set holds every route the configuration turns on, and — when the
 * configuration turns on nothing at all — the default route `firstParty`, so
 * that the route the selector picks is in the set in every case.
 */
export function enabledRoutes(
  env: NodeJS.ProcessEnv,
  settings?: RouteSettings,
): ReadonlySet<ProviderRoute> {
  const enabled = new Set<ProviderRoute>();
  if (gatewayEnabled(settings)) enabled.add('gateway');
  for (const route of ROUTE_FLAG_ORDER) {
    const variable = ROUTE_ENV_VARS.get(route);
    if (variable === undefined) continue;
    if (flagEnabled(readEnvValue(env, variable))) enabled.add(route);
  }
  // Nothing was turned on: the default route is the one in play.
  if (enabled.size === 0) enabled.add('firstParty');
  return enabled;
}

/**
 * Select the active route.
 *
 * The gateway wins over every provider flag; otherwise the first provider flag
 * in `ROUTE_FLAG_ORDER` wins; otherwise the route is `firstParty`. This mirrors
 * the target's dispatch order exactly (audit §2.1).
 *
 * The route is the **first route of the dispatch order** the enabled-flag set
 * holds, so the selector and the set are one derivation and not two.
 */
export function selectRoute(env: NodeJS.ProcessEnv, settings?: RouteSettings): ProviderRoute {
  const enabled = enabledRoutes(env, settings);
  for (const route of ROUTE_ORDER) {
    if (enabled.has(route)) return route;
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
    // whatever string the variable holds: the audited base URL is
    // `https://<resource>.services.ai.azure.com/anthropic/` (audit §2.2a), and
    // the **host** is the part this pattern matches. A resource name with `_`
    // or `.` is a working Foundry deployment, not a foreign host.
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
  foundry: 'https://{resource}.services.ai.azure.com/anthropic/',
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
 * The target builds `https://<resource>.services.ai.azure.com/anthropic/` —
 * **with a trailing slash** — from whatever string the variable holds (audit
 * §2.2a), so a **working** resource name must not be rejected: the earlier
 * `^[a-z0-9-]+$` posture refused names the target accepts, such as
 * `my_deployment` or `my.deployment`.
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
 *
 * The URL this returns is the **audited** one — the base URL the Anthropic
 * endpoint lives at, with the `/anthropic/` segment and the trailing slash —
 * so the driver layer has nothing to rebuild.
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
  return `https://${resource}.services.ai.azure.com/anthropic/`;
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

/* -------------------------------------------------------------------------- */
/* The endpoint catalogue                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The **endpoint catalogue**: the table of every host the product talks to, the
 * purpose each host serves, and the toggle that switches the service off.
 *
 * **Observed.** The target's own module is `Jw` in `chunk-z6a1zj5w.js` (the
 * gateway chunk), starting at byte offset **1 253 389**; the catalogue literal
 * `EGRESS_SERVICES` runs from offset **1 256 200** to **1 259 100**. The host
 * constants it is built from live in the module `pr` in the same file, at offset
 * **663 198**.
 *
 * The catalogue is **data**, and it is the target's data: the eleven services,
 * their keys, their toggle keys, their group labels, their endpoint hosts, their
 * paths, their origins, their CSP directives, their `firewallAlso` companions and
 * the platform a service is restricted to. The only thing this implementation
 * changes is the target's own product name in the two purpose strings that name
 * it — a name is not reproduced; a datum is.
 */

/** Where a request to an endpoint is made from. */
export type EgressOrigin = 'renderer' | 'main' | 'subprocess';

/**
 * The four toggles a catalogue service can be switched off by.
 *
 * The target's `toggleKey` values, exactly (`chunk-z6a1zj5w.js:1 256 200`).
 */
export type EgressToggleKey =
  | 'disableAutoUpdates'
  | 'disableEssentialTelemetry'
  | 'disableNonessentialTelemetry'
  | 'disableNonessentialServices';

/** The eleven services the catalogue holds. */
export type EgressServiceKey =
  | 'vm-bundle'
  | 'model-catalog'
  | 'updater'
  | 'sentry'
  | 'datadog-rum'
  | 'anthropic-telemetry'
  | 'connector-favicons'
  | 'artifact-sandbox'
  | 'mcp-app-sandbox'
  | 'spellcheck-dictionary'
  | 'dictation';

/** One endpoint of the catalogue. */
export interface EgressEndpoint {
  /** The host the request goes to. */
  readonly host: string;
  /** The path prefix, when the endpoint names one. */
  readonly path?: string;
  /** The path suffix, when the endpoint names one. */
  readonly pathSuffix?: string;
  /** Whether the path must match exactly. */
  readonly exactPath?: boolean;
  /** Whether redirects are followed. */
  readonly followRedirects?: boolean;
  /** Where the request is made from. */
  readonly origin: EgressOrigin;
  /** What the endpoint is for, in the target's own words. */
  readonly purpose?: string;
  /** The CSP directive the endpoint belongs to. */
  readonly cspDirective?: string | readonly string[];
  /** The CSP scheme, for a `connect-src` endpoint that carries one. */
  readonly cspScheme?: string;
  /** The hosts the firewall must also allow for this endpoint. */
  readonly firewallAlso?: readonly string[];
  /** What the `firewallAlso` hosts are for. */
  readonly firewallAlsoPurpose?: string;
  /**
   * Whether an endpoint that is not declared is answered with a 503.
   *
   * The target spells this `undeliveredAs503` (`chunk-z6a1zj5w.js:1 257 830`).
   */
  readonly undeliveredAs503?: boolean;
  /** The platforms the endpoint exists on; every platform when absent. */
  readonly platforms?: readonly string[];
}

/**
 * The context a service's endpoints are resolved against.
 *
 * The target's "host context" (`asHostContext`, `chunk-z6a1zj5w.js:1 253 900`): a
 * plain string is shorthand for `{anthropicHost}`.
 */
export interface EgressHostContext {
  /** The host the first-party API is reached at. */
  readonly anthropicHost?: string;
  /** The host the artifact preview iframe is served from. */
  readonly artifactIframeHost?: string;
  /** Whether the update feed is read from the updates host. */
  readonly updateViaUpdatesHost?: boolean;
  /** The dictation service's connect-src source, when there is one. */
  readonly dictationCsp?: { readonly host: string; readonly scheme: string } | null;
  /** The platform the endpoints are resolved for. */
  readonly platform?: string;
}

/** One service of the catalogue. */
export interface EgressService {
  /** The service's key. */
  readonly key: EgressServiceKey;
  /**
   * The toggle that switches the service off, or `null` when the service is
   * always on.
   */
  readonly toggleKey: EgressToggleKey | null;
  /** The group the service is listed under. */
  readonly label: string;
  /** The service's endpoints, or the function that computes them. */
  readonly endpoints:
    | readonly EgressEndpoint[]
    | ((context: EgressHostContext) => readonly EgressEndpoint[]);
}

/**
 * The group label of the services that are always on.
 *
 * The target's own text (`chunk-z6a1zj5w.js:1 253 500`) names the product, so
 * this implementation names its own: a **name** is not reproduced, a datum is.
 */
export const EGRESS_CORE_GROUP_LABEL = 'Core (VM bundle + PRRICODE CLI binary)';

/**
 * The host constants the catalogue and the egress rules are built from.
 *
 * **Observed** — the module `pr` in `chunk-z6a1zj5w.js`, offsets **667 780** –
 * **672 300**.
 */
export const EGRESS_HOSTS = Object.freeze({
  VM_BUNDLE_HOST: 'downloads.claude.ai',
  UPDATE_FEED_HOST: 'releases.claude.com',
  ANTHROPIC_API_HOST: 'api.anthropic.com',
  CLAUDE_AI_HOST: 'claude.ai',
  GCS_SIGNED_URL_HOST: 'storage.googleapis.com',
  PLATFORM_CLAUDE_HOST: 'platform.claude.com',
  FAVICON_PROXY_HOST: 'www.google.com',
  GSTATIC_WILDCARD: '*.gstatic.com',
  ARTIFACT_IFRAME_HOST: 'www.claudeusercontent.com',
  FRAME_ARTIFACT_CONTENT_HOSTS: Object.freeze([
    '*.frame.claudeusercontent.com',
    '*.frame.staging.claudeusercontent.com',
  ]),
  MCP_APP_SANDBOX_WILDCARD_HOST: '*.claudemcpcontent.com',
  MCP_APP_SANDBOX_BASE_HOST: 'sandbox.claudemcpcontent.com',
  ANTHROPIC_ASSETS_HOST: 'assets.claude.ai',
  SENTRY_WILDCARD_HOST: '*.sentry.io',
  SENTRY_INGEST_HOST: 'o1158394.ingest.us.sentry.io',
  SPELLCHECK_DICTIONARY_HOST: 'redirector.gvt1.com',
  SPELLCHECK_DICTIONARY_WILDCARD: '*.gvt1.com',
  MICROSOFT_LOGIN_HOST: 'login.microsoftonline.com',
  GOOGLE_ACCOUNTS_HOST: 'accounts.google.com',
  GOOGLE_OAUTH2_HOST: 'oauth2.googleapis.com',
  GOOGLE_STS_HOST: 'sts.googleapis.com',
  GOOGLE_IAMCRED_HOST: 'iamcredentials.googleapis.com',
  DATADOG_INTAKE_HOSTS: Object.freeze([
    'browser-intake-datadoghq.com',
    'browser-intake-us3-datadoghq.com',
    'browser-intake-us5-datadoghq.com',
    'browser-intake-ap1-datadoghq.com',
    'browser-intake-ap2-datadoghq.com',
    'browser-intake-datadoghq.eu',
    'browser-intake-ddog-gov.com',
  ]),
  VERTEX_AUTH_HOSTS: Object.freeze([
    'oauth2.googleapis.com',
    'sts.googleapis.com',
    'accounts.google.com',
    'iamcredentials.googleapis.com',
  ]),
});

/**
 * The domains the smallest possible egress needs.
 *
 * **Observed** — `chunk-z6a1zj5w.js:667 780`.
 */
export const MINIMAL_EGRESS_DOMAINS: readonly string[] = Object.freeze([
  '*.anthropic.com',
  'anthropic.com',
  'claude.com',
  '*.claude.com',
]);

/**
 * The hosts a package install may reach.
 *
 * **Observed** — `chunk-z6a1zj5w.js:671 990`. This is what the catalogue's
 * `allowedEgressHosts` requirement names when the list is the wildcard `*`.
 */
export const DEPENDENCY_INSTALL_DOMAINS: readonly string[] = Object.freeze([
  'registry.npmjs.org',
  'npmjs.com',
  'www.npmjs.com',
  'npmjs.org',
  'www.npmjs.org',
  'yarnpkg.com',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'pythonhosted.org',
  'github.com',
  'objects.githubusercontent.com',
  'archive.ubuntu.com',
  'security.ubuntu.com',
  'crates.io',
  'index.crates.io',
  'static.crates.io',
  'playwright.download.prss.microsoft.com',
  'cdn.playwright.dev',
]);

/**
 * The hosts a Python extension's runtime may reach.
 *
 * **Observed** — `chunk-z6a1zj5w.js:671 900`.
 */
export const PYTHON_EXTENSION_RUNTIME_HOSTS: readonly string[] = Object.freeze([
  'github.com',
  'objects.githubusercontent.com',
  'pypi.org',
  'files.pythonhosted.org',
]);

/**
 * The catalogue itself — **eleven** services, in the target's declaration order.
 *
 * **Observed** — `chunk-z6a1zj5w.js:1 256 200` – `1 259 100`.
 */
export const EGRESS_SERVICES: readonly EgressService[] = Object.freeze([
  {
    key: 'vm-bundle',
    toggleKey: null,
    label: EGRESS_CORE_GROUP_LABEL,
    endpoints: [
      {
        host: EGRESS_HOSTS.VM_BUNDLE_HOST,
        origin: 'main',
        purpose:
          'VM workspace bundle and PRRICODE CLI binary, fetched in the background or at session start',
      },
    ],
  },
  {
    key: 'model-catalog',
    toggleKey: null,
    label: EGRESS_CORE_GROUP_LABEL,
    endpoints: [
      {
        host: EGRESS_HOSTS.VM_BUNDLE_HOST,
        origin: 'main',
        purpose: 'PRRICODE model catalog (signed picker metadata), polled every 5–15 minutes',
      },
    ],
  },
  {
    key: 'updater',
    toggleKey: 'disableAutoUpdates',
    label: 'Auto-updates',
    endpoints: (context) =>
      context.updateViaUpdatesHost
        ? [
            {
              host: EGRESS_HOSTS.UPDATE_FEED_HOST,
              path: '/api/desktop/',
              pathSuffix: '/update',
              origin: 'main',
              purpose: 'Update feed',
            },
            {
              host: EGRESS_HOSTS.VM_BUNDLE_HOST,
              path: '/releases/',
              followRedirects: true,
              origin: 'main',
              purpose: 'Update binaries',
            },
          ]
        : [
            {
              host: context.anthropicHost ?? EGRESS_HOSTS.CLAUDE_AI_HOST,
              path: '/api/desktop/',
              pathSuffix: '/update',
              origin: 'renderer',
              purpose: 'Update feed',
            },
            {
              host: EGRESS_HOSTS.ANTHROPIC_API_HOST,
              path: '/api/desktop/',
              pathSuffix: '/update',
              origin: 'renderer',
              purpose:
                'Update feed (releases.claude.com when updateViaUpdatesHost is set)',
            },
            {
              host: EGRESS_HOSTS.VM_BUNDLE_HOST,
              path: '/releases/',
              followRedirects: true,
              origin: 'main',
              purpose: 'Update binaries',
            },
          ],
  },
  {
    key: 'sentry',
    toggleKey: 'disableEssentialTelemetry',
    label: 'Essential telemetry',
    endpoints: [
      {
        host: EGRESS_HOSTS.SENTRY_WILDCARD_HOST,
        origin: 'renderer',
        purpose: 'Crash and error reporting',
        firewallAlso: ['*.ingest.us.sentry.io'],
      },
      {
        host: 'sentry.io',
        origin: 'renderer',
        purpose: 'Crash and error reporting',
      },
    ],
  },
  {
    key: 'datadog-rum',
    toggleKey: 'disableEssentialTelemetry',
    label: 'Essential telemetry',
    endpoints: (context) => [
      {
        host: context.anthropicHost ?? EGRESS_HOSTS.CLAUDE_AI_HOST,
        path: '/api/v2/rum',
        exactPath: true,
        origin: 'renderer',
        cspDirective: [],
        undeliveredAs503: true,
        purpose: 'Performance timing',
      },
      ...EGRESS_HOSTS.DATADOG_INTAKE_HOSTS.map((host) => ({
        host,
        origin: 'renderer' as const,
        purpose: 'Performance timing',
      })),
    ],
  },
  {
    key: 'anthropic-telemetry',
    toggleKey: 'disableNonessentialTelemetry',
    label: 'Nonessential telemetry',
    endpoints: (context) => [
      {
        host: context.anthropicHost ?? EGRESS_HOSTS.CLAUDE_AI_HOST,
        path: '/api/event_logging/',
        origin: 'renderer',
        purpose: 'Analytics events',
      },
      {
        host: EGRESS_HOSTS.ANTHROPIC_API_HOST,
        path: '/api/event_logging/',
        origin: 'subprocess',
        purpose: 'PRRICODE usage telemetry, sent from inside the agent sandbox',
      },
    ],
  },
  {
    key: 'connector-favicons',
    toggleKey: 'disableNonessentialServices',
    label: 'Nonessential services',
    endpoints: [
      {
        host: EGRESS_HOSTS.FAVICON_PROXY_HOST,
        path: '/s2/favicons',
        followRedirects: true,
        origin: 'renderer',
        cspDirective: 'img-src',
        purpose: 'Connector favicons',
      },
      {
        host: EGRESS_HOSTS.GSTATIC_WILDCARD,
        path: '/faviconV2',
        origin: 'renderer',
        cspDirective: 'img-src',
        purpose: 'Connector favicons',
      },
    ],
  },
  {
    key: 'artifact-sandbox',
    toggleKey: 'disableNonessentialServices',
    label: 'Nonessential services',
    endpoints: (context) => [
      {
        host: context.artifactIframeHost ?? EGRESS_HOSTS.ARTIFACT_IFRAME_HOST,
        origin: 'renderer',
        cspDirective: 'frame-src',
        purpose: 'Artifact preview iframe',
        firewallAlso: ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'cdn.jsdelivr.net'],
        firewallAlsoPurpose: 'Artifact preview asset CDNs',
      },
    ],
  },
  {
    key: 'mcp-app-sandbox',
    toggleKey: 'disableNonessentialServices',
    label: 'Nonessential services',
    endpoints: [
      {
        host: EGRESS_HOSTS.MCP_APP_SANDBOX_WILDCARD_HOST,
        origin: 'renderer',
        cspDirective: 'frame-src',
        purpose: 'MCP App widget iframe',
        firewallAlso: [EGRESS_HOSTS.ANTHROPIC_ASSETS_HOST],
        firewallAlsoPurpose: 'Fonts loaded by MCP App widget iframes',
      },
    ],
  },
  {
    key: 'spellcheck-dictionary',
    toggleKey: 'disableNonessentialServices',
    label: 'Nonessential services',
    endpoints: [
      {
        host: EGRESS_HOSTS.SPELLCHECK_DICTIONARY_HOST,
        origin: 'main',
        platforms: ['linux'],
        purpose: 'Spellcheck dictionary download (Linux)',
        firewallAlso: [EGRESS_HOSTS.SPELLCHECK_DICTIONARY_WILDCARD],
        firewallAlsoPurpose: 'Redirect targets of the spellcheck dictionary download (Linux)',
      },
    ],
  },
  {
    key: 'dictation',
    toggleKey: null,
    label: EGRESS_CORE_GROUP_LABEL,
    endpoints: (context) =>
      context.dictationCsp
        ? [
            {
              host: context.dictationCsp.host,
              origin: 'renderer',
              cspDirective: 'connect-src',
              cspScheme: context.dictationCsp.scheme,
            },
          ]
        : [],
  },
]);

/**
 * The service keys, in the target's declaration order.
 *
 * The target's `egressServiceKeys` is `Object.keys(EGRESS_SERVICES)`, so the order
 * is the object's own.
 */
export const EGRESS_SERVICE_KEYS: readonly EgressServiceKey[] = Object.freeze(
  EGRESS_SERVICES.map((service) => service.key),
);

/** The service of a key, or `undefined` for a key that is not one of the eleven. */
export function egressServiceFor(key: EgressServiceKey): EgressService | undefined {
  return EGRESS_SERVICES.find((service) => service.key === key);
}

/**
 * The endpoints of a service, resolved against a host context.
 *
 * **Observed** — `resolveEndpoints`, `chunk-z6a1zj5w.js:1 258 990`. A service
 * whose endpoints are a function is called with the context; the result is then
 * filtered by the context's `platform`, and an endpoint that names no platform is
 * kept on every platform.
 */
export function resolveEgressEndpoints(
  key: EgressServiceKey,
  context: EgressHostContext | string = {},
): readonly EgressEndpoint[] {
  const service = egressServiceFor(key);
  if (service === undefined) return [];
  const hostContext: EgressHostContext =
    typeof context === 'string' ? { anthropicHost: context } : context;
  const endpoints =
    typeof service.endpoints === 'function' ? service.endpoints(hostContext) : service.endpoints;
  const platform = hostContext.platform;
  if (platform === undefined) return endpoints;
  return endpoints.filter(
    (endpoint) => endpoint.platforms === undefined || endpoint.platforms.includes(platform),
  );
}

/**
 * The hosts a service needs, **including** the `firewallAlso` companions.
 *
 * **Observed** — `hostsForService`, `chunk-z6a1zj5w.js:1 259 100`.
 */
export function egressHostsForService(
  key: EgressServiceKey,
  context: EgressHostContext | string = {},
): string[] {
  return resolveEgressEndpoints(key, context).flatMap((endpoint) => [
    endpoint.host,
    ...(endpoint.firewallAlso ?? []),
  ]);
}

/**
 * The configuration the catalogue's toggles are read from.
 *
 * The target reads the **managed** configuration, which carries the nested
 * `autoUpdate.disabled` and `telemetry.disable*` forms as well as the flat
 * `disable*` forms. This implementation's settings document carries the same two
 * forms, so the shape is the target's.
 */
export interface EgressConfig {
  readonly autoUpdate?: {
    readonly disabled?: unknown;
    readonly viaUpdatesHost?: unknown;
  };
  readonly telemetry?: {
    readonly disableEssential?: unknown;
    readonly disableNonessential?: unknown;
    readonly disableNonessentialServices?: unknown;
  };
  readonly workspace?: {
    readonly userContentRendererUrl?: string;
  };
  readonly disableAutoUpdates?: unknown;
  readonly disableEssentialTelemetry?: unknown;
  readonly disableNonessentialTelemetry?: unknown;
  readonly disableNonessentialServices?: unknown;
}

/**
 * The host context a configuration and a context together make.
 *
 * **Observed** — the target's `computeEgressRequirements` builds the context
 * itself (`chunk-z6a1zj5w.js:1 260 480`): the update feed comes from
 * `autoUpdate.viaUpdatesHost`, and the artifact iframe host is the egress
 * address of `workspace.userContentRendererUrl`. A caller that names a value in
 * the context keeps it.
 */
export function resolveEgressContext(
  config: EgressConfig,
  context: EgressHostContext | string = {},
): EgressHostContext {
  const hostContext: EgressHostContext =
    typeof context === 'string' ? { anthropicHost: context } : context;
  const updateViaUpdatesHost =
    hostContext.updateViaUpdatesHost ?? (config.autoUpdate?.viaUpdatesHost === true ? true : undefined);
  const artifactIframeHost =
    hostContext.artifactIframeHost ?? egressAddress(config.workspace?.userContentRendererUrl);
  return {
    ...hostContext,
    ...(updateViaUpdatesHost === undefined ? {} : { updateViaUpdatesHost }),
    ...(artifactIframeHost === undefined ? {} : { artifactIframeHost }),
  };
}

/**
 * Whether a toggle is switched on.
 *
 * **Observed** — the target's own resolver, `chunk-z6a1zj5w.js:1 259 300`. The
 * nested form wins over the flat one (`autoUpdate.disabled` over
 * `disableAutoUpdates`, `telemetry.disableEssential` over
 * `disableEssentialTelemetry`), and the value must be **exactly** `true`: a
 * truthy string or a number does not switch a service off.
 */
export function egressToggleDisabled(config: EgressConfig, toggleKey: EgressToggleKey): boolean {
  switch (toggleKey) {
    case 'disableAutoUpdates':
      return (config.autoUpdate?.disabled ?? config.disableAutoUpdates) === true;
    case 'disableEssentialTelemetry':
      return (
        (config.telemetry?.disableEssential ?? config.disableEssentialTelemetry) === true
      );
    case 'disableNonessentialTelemetry':
      return (
        (config.telemetry?.disableNonessential ?? config.disableNonessentialTelemetry) === true
      );
    case 'disableNonessentialServices':
      return (
        (config.telemetry?.disableNonessentialServices ?? config.disableNonessentialServices) ===
        true
      );
  }
}

/**
 * The services a configuration leaves enabled.
 *
 * **Observed** — `enabledServicesFromConfig`, `chunk-z6a1zj5w.js:1 259 400`. A
 * service with **no** toggle is always enabled; a service with a toggle is
 * enabled until that toggle is switched on.
 */
export function enabledEgressServices(config: EgressConfig): EgressServiceKey[] {
  return EGRESS_SERVICE_KEYS.filter((key) => {
    const toggleKey = egressServiceFor(key)?.toggleKey ?? null;
    return toggleKey === null || !egressToggleDisabled(config, toggleKey);
  });
}

/**
 * One host of the firewall list, with the toggle that governs it.
 *
 * The toggle is `null` for a service that has none — the target's "core" group.
 */
export interface EgressFirewallHost {
  readonly host: string;
  readonly toggleKey: EgressToggleKey | null;
}

/**
 * The hosts the firewall must allow, for the services a configuration leaves
 * enabled.
 *
 * **Observed** — `firewallHostsForServices`, `chunk-z6a1zj5w.js:1 259 600`.
 */
export function firewallHostsForEgressServices(
  config: EgressConfig,
  context: EgressHostContext | string = {},
): EgressFirewallHost[] {
  const hostContext = resolveEgressContext(config, context);
  return enabledEgressServices(config).flatMap((key) => {
    const toggleKey = egressServiceFor(key)?.toggleKey ?? null;
    return egressHostsForService(key, hostContext).map((host) => ({ host, toggleKey }));
  });
}

/**
 * The hosts the **subprocess** (the agent inside the sandbox) may reach.
 *
 * **Observed** — `subprocessHostsForServices`, `chunk-z6a1zj5w.js:1 259 800`.
 */
export function egressSubprocessHosts(
  config: EgressConfig,
  context: EgressHostContext | string = {},
): string[] {
  const hostContext = resolveEgressContext(config, context);
  return enabledEgressServices(config).flatMap((key) =>
    resolveEgressEndpoints(key, hostContext)
      .filter((endpoint) => endpoint.origin === 'subprocess')
      .map((endpoint) => endpoint.host),
  );
}

/**
 * One egress rule of the renderer.
 */
export interface RendererEgressRule {
  readonly host: string;
  readonly path?: string;
  readonly pathSuffix?: string;
  readonly exactPath?: boolean;
  readonly followRedirects?: boolean;
  readonly undeliveredAs503?: boolean;
}

/**
 * The **renderer** egress rules of a list of services.
 *
 * **Observed** — `rendererEgressRules`, `chunk-z6a1zj5w.js:1 259 950`. The rule
 * keeps only the fields the renderer needs; the purpose, the CSP directive and
 * the `firewallAlso` companions are not part of a rule.
 */
export function rendererEgressRules(
  services: readonly EgressServiceKey[],
  context: EgressHostContext | string = {},
): RendererEgressRule[] {
  return services.flatMap((key) =>
    resolveEgressEndpoints(key, context)
      .filter((endpoint) => endpoint.origin === 'renderer')
      .map((endpoint) => ({
        host: endpoint.host,
        ...(endpoint.path === undefined ? {} : { path: endpoint.path }),
        ...(endpoint.pathSuffix === undefined ? {} : { pathSuffix: endpoint.pathSuffix }),
        ...(endpoint.exactPath === undefined ? {} : { exactPath: endpoint.exactPath }),
        ...(endpoint.followRedirects === undefined
          ? {}
          : { followRedirects: endpoint.followRedirects }),
        ...(endpoint.undeliveredAs503 === undefined
          ? {}
          : { undeliveredAs503: endpoint.undeliveredAs503 }),
      })),
  );
}

/**
 * The group label a toggle key is listed under.
 *
 * **Observed** — `serviceLabelForToggleKey`, `chunk-z6a1zj5w.js:1 260 200`. The
 * core label is the label of a toggle that names no service, and a toggle that
 * names none has no label at all.
 */
export function egressServiceLabel(toggleKey: EgressToggleKey | null): string | undefined {
  if (toggleKey === null) return EGRESS_CORE_GROUP_LABEL;
  for (const key of EGRESS_SERVICE_KEYS) {
    const service = egressServiceFor(key);
    if (service?.toggleKey === toggleKey) return service.label;
  }
  return undefined;
}

/**
 * The label an egress requirement is reported under.
 *
 * **Observed** — `egressRequirementLabel`, `chunk-z6a1zj5w.js:1 260 900`. The
 * target resolves a requirement's field key to the **service** label when the key
 * is a toggle key, and to the managed field's own label otherwise; this
 * implementation has no managed-config field-meta table, so a key that is
 * neither yields no label.
 */
export function egressRequirementLabel(fieldKey: string): string | undefined {
  if (fieldKey === 'core') return EGRESS_CORE_GROUP_LABEL;
  return egressServiceLabel(fieldKey as EgressToggleKey);
}

/**
 * One host an egress requirement names.
 */
export interface EgressRequirement {
  readonly host: string;
  readonly fieldKey: string;
}

/**
 * The hosts the deployment must be able to reach.
 *
 * **Observed** — `computeEgressRequirements`, `chunk-z6a1zj5w.js:1 260 480`. The
 * target walks the enabled services and then the **managed** fields whose
 * `egressRequirements` name hosts, and it de-duplicates by host, keeping the
 * first field key that named a host.
 *
 * **What this implementation does not reproduce.** The target's second half walks
 * the managed-configuration field-meta table, which this implementation does not
 * have: the two producers the target declares for the fields this
 * implementation's own settings document carries — `singleHostEgress` and the
 * `allowedEgressHosts` rule — are implemented as
 * {@link singleHostEgress} and {@link allowedEgressHostsRequirement}, and a
 * caller supplies their output.
 */
export function computeEgressRequirements(
  config: EgressConfig,
  context: EgressHostContext | string = {},
  managedRequirements: readonly EgressRequirement[] = [],
): EgressRequirement[] {
  const hostContext = resolveEgressContext(config, context);
  const seen = new Set<string>();
  const requirements: EgressRequirement[] = [];
  const add = (host: string, fieldKey: string): void => {
    if (host === '' || seen.has(host)) return;
    seen.add(host);
    requirements.push({ host, fieldKey });
  };
  for (const entry of firewallHostsForEgressServices(config, hostContext)) {
    add(entry.host, entry.toggleKey ?? 'core');
  }
  for (const entry of managedRequirements) {
    add(entry.host, entry.fieldKey);
  }
  return requirements;
}

/**
 * The one host a URL-valued egress field requires.
 *
 * **Observed** — `singleHostEgress`, `chunk-z6a1zj5w.js:692 000`.
 */
export function singleHostEgress(value: string | undefined): string[] {
  const address = egressAddress(value);
  return address === undefined ? [] : [address];
}

/**
 * The hosts the `allowedEgressHosts` field requires.
 *
 * **Observed** — `chunk-z6a1zj5w.js:1 045 400`. A list that includes the
 * wildcard `*` requires the whole dependency-install domain list; any other list
 * requires **itself**.
 */
export function allowedEgressHostsRequirement(hosts: readonly string[] | undefined): string[] {
  if (hosts === undefined) return [];
  return hosts.includes('*') ? [...DEPENDENCY_INSTALL_DOMAINS] : [...hosts];
}

/* -------------------------------------------------------------------------- */
/* The egress-address helpers                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The grammar an egress host entry follows.
 *
 * **Observed** — `EGRESS_ENTRY_GRAMMAR`, `chunk-z6a1zj5w.js:672 200`.
 */
export const EGRESS_ENTRY_GRAMMAR =
  '`*`, `localhost`, `host[:port]`, or `*.host[:port]` (port 1-65535; no port on bare `*`; no scheme, path, or IPv6 literal)';

/** A parsed egress host entry. */
export interface EgressHostEntry {
  /** The host, lowercased. */
  readonly host: string;
  /** The port, when the entry carries one. */
  readonly port?: number;
}

const EGRESS_HOST_LABEL = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i;
const EGRESS_PORT = /^[1-9][0-9]{0,4}$/;

/**
 * Parse an egress host entry.
 *
 * **Observed** — `parseEgressHostEntry`, `chunk-z6a1zj5w.js:672 250`. The entry
 * is `*`, `localhost`, `host[:port]` or `*.host[:port]`; the port is 1–65535; a
 * bare `*` may **not** carry a port; and an entry with a scheme, a path or an
 * IPv6 literal is refused.
 */
export function parseEgressHostEntry(entry: string): EgressHostEntry | null {
  let host = entry;
  let port: number | undefined;
  const separator = entry.lastIndexOf(':');
  if (separator !== -1) {
    const text = entry.slice(separator + 1);
    if (!EGRESS_PORT.test(text)) return null;
    const value = Number(text);
    if (value > 65535) return null;
    port = value;
    host = entry.slice(0, separator);
  }
  if (host === '*') return port === undefined ? { host } : null;
  const bare = host.startsWith('*.') ? host.slice(2) : host;
  const acceptable = bare === 'localhost' || (EGRESS_HOST_LABEL.test(bare) && bare.includes('.'));
  if (!acceptable) return null;
  return port === undefined ? { host: host.toLowerCase() } : { host: host.toLowerCase(), port };
}

/**
 * The host of an egress entry, without its port.
 *
 * **Observed** — `stripEgressEntryPort`, `chunk-z6a1zj5w.js:672 400`. An entry
 * that does not parse is returned unchanged.
 */
export function stripEgressEntryPort(entry: string): string {
  return parseEgressHostEntry(entry)?.host ?? entry;
}

/**
 * The entries that do **not** carry a port.
 *
 * **Observed** — `dropPortScopedEgressEntries`, `chunk-z6a1zj5w.js:672 460`. An
 * entry that parses with a port is dropped; an entry that does not parse at all
 * is kept, unless it carries a colon.
 */
export function dropPortScopedEgressEntries(entries: readonly string[]): string[] {
  return entries.filter((entry) => {
    const parsed = parseEgressHostEntry(entry);
    if (parsed !== null) return parsed.port === undefined;
    return !entry.includes(':');
  });
}

/**
 * The host of a URL, for an egress list.
 *
 * **Observed** — `egressAddress`, `chunk-z6a1zj5w.js:671 250`. A cleartext URL
 * keeps its scheme, so the list says `http://host`; a secure URL is reduced to
 * its host. A value that is not a URL, or a URL that carries user information,
 * yields nothing.
 *
 * **A named gap.** The target also refuses a URL whose authority matches one of
 * the ten credential-family key patterns it declares (`sk-ant-`, `sk-…`,
 * `xoxp-`, `gh…_`, `github_pat_`, `sk_live_`, `AIza`, a signed token, …). That
 * table belongs to the credential-redaction surface, and this implementation
 * refuses user information only.
 */
export function egressAddress(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.username !== '' || url.password !== '') return undefined;
  if (url.host === '') return undefined;
  return url.protocol === 'http:' ? `http://${url.host}` : url.host;
}

/**
 * Whether a host is the API vendor's own.
 *
 * **Observed** — `isAnthropicHost`, `chunk-z6a1zj5w.js:667 930`.
 */
export function isAnthropicHost(host: string): boolean {
  const name = host.replace(/\.$/, '').toLowerCase();
  return name === 'anthropic.com' || name.endsWith('.anthropic.com');
}

/**
 * Whether a host is one of the first-party hosts.
 *
 * **Observed** — `isAnthropicFirstPartyHost`, `chunk-z6a1zj5w.js:668 100`: the
 * host is `anthropic.com`, `claude.ai` or `claude.com`, or a subdomain of one
 * of them.
 */
export function isAnthropicFirstPartyHost(host: string): boolean {
  const name = host.replace(/\.$/, '').toLowerCase();
  return ['anthropic.com', 'claude.ai', 'claude.com'].some(
    (domain) => name === domain || name.endsWith(`.${domain}`),
  );
}

/* -------------------------------------------------------------------------- */
/* The corporate proxy                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The environment variables a proxy URL is read from, **in the target's order**.
 *
 * **Observed** — `chunk-3q7vcbxf.js:42 592`. The lower-case name comes first, so
 * `https_proxy` beats `HTTPS_PROXY`, which beats `http_proxy`, which beats
 * `HTTP_PROXY`.
 */
export const PROXY_ENVIRONMENT_VARIABLES: readonly string[] = Object.freeze([
  'https_proxy',
  'HTTPS_PROXY',
  'http_proxy',
  'HTTP_PROXY',
]);

/**
 * The proxy URL the environment names, and the variable that named it.
 *
 * **Observed** — `L2`, `chunk-3q7vcbxf.js:42 620`. The first variable that holds
 * a **truthy** value wins; an empty value counts as unset.
 */
export function resolveProxyUrl(
  env: NodeJS.ProcessEnv = process.env,
): { value: string; source: string } | undefined {
  for (const name of PROXY_ENVIRONMENT_VARIABLES) {
    if (!Object.hasOwn(env, name)) continue;
    const value = env[name];
    if (typeof value !== 'string' || value === '') continue;
    return { value, source: name };
  }
  return undefined;
}

/**
 * The bypass list the environment names.
 *
 * **Observed** — `zze` and `EUr`, `chunk-3q7vcbxf.js:43 300`. A list of `"*"`
 * bypasses every host; otherwise the lower-case and the upper-case variable are
 * **both** used when they differ, and the one that is set when they agree.
 */
export function resolveNoProxy(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const lower = env['no_proxy'];
  const upper = env['NO_PROXY'];
  if (lower === '*' || upper === '*') return '*';
  if (lower && upper && lower !== upper) return `${lower},${upper}`;
  return lower || upper;
}

/**
 * Whether a URL is covered by a bypass list.
 *
 * **Observed** — `e_`, `chunk-3q7vcbxf.js:43 450`. The list is split on commas
 * and whitespace; an entry that carries a colon is compared against
 * `host:port`; an entry that starts with a dot matches the host itself or any
 * name **ending** with it; any other entry must equal the host.
 *
 * **The difference from the sandbox allowlist.** Here a leading `*` is **not** a
 * wildcard, and a bare entry is an **exact** match.
 */
export function matchesNoProxy(url: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  if (noProxy === '*') return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  const port = parsed.port !== '' ? parsed.port : secure ? '443' : '80';
  const key = `${host}:${port}`;
  return noProxy
    .split(/[,\s]+/)
    .filter((entry) => entry.length > 0)
    .some((raw) => {
      const entry = raw.toLowerCase().trim();
      if (entry.includes(':')) return key === entry;
      if (entry.startsWith('.')) return host === entry.slice(1) || host.endsWith(entry);
      return host === entry;
    });
}

/**
 * The target's own message for a proxy URL that cannot be parsed.
 *
 * **Observed** — `E1t`, `chunk-3q7vcbxf.js:42 790`. The value's control
 * characters are stripped before it is quoted. The last line names the product,
 * so this implementation names its own.
 */
export function proxyUrlError(source: string, value: string): string {
  const shown = value.replace(/\p{Cc}/gu, '');
  return (
    `Invalid proxy URL in ${source}: "${shown}" cannot be parsed as a URL.\n` +
    'Proxy settings must be a complete URL including the scheme, e.g. "http://proxy.example.com:8080".\n' +
    `Fix or unset ${source} and restart PRRICODE.`
  );
}

/**
 * How long a proxy-auth helper's value is cached, in milliseconds.
 *
 * **Observed** — `Pr` and `vr`, `chunk-3q7vcbxf.js:45 100`: the environment
 * variable wins when it names a number that is not negative, and the default is
 * five minutes.
 */
export const PROXY_AUTH_HELPER_TTL_MS = 300000;

/**
 * The cache lifetime of a proxy-auth helper's value.
 *
 * **Observed** — `vr`, `chunk-3q7vcbxf.js:45 130`.
 */
export function proxyAuthHelperTtl(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['CLAUDE_CODE_PROXY_AUTH_HELPER_TTL_MS'];
  if (raw === undefined) return PROXY_AUTH_HELPER_TTL_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return PROXY_AUTH_HELPER_TTL_MS;
  return value;
}

/**
 * The environment variable that switches the proxy-auth helper on.
 *
 * **Observed** — `Gze`, `chunk-3q7vcbxf.js:45 060`: without it, the helper is
 * never run, whatever the settings say.
 */
export const PROXY_AUTH_HELPER_ENABLED_VARIABLE = 'CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER';

/**
 * The message the target prints when a **project** set the proxy-auth helper.
 *
 * **Observed** — `chunk-8659jdnp.js` (the whole file).
 */
export const PROXY_AUTH_HELPER_PROJECT_MESSAGE =
  'a proxy helper set by this project is not run by this command\n';

/**
 * The message the target prints when the proxy setting is refused.
 *
 * **Observed** — `chunk-8659jdnp.js` (the whole file).
 */
export const PROXY_SETTING_REFUSED_MESSAGE = 'Error: the proxy setting named above is refused.';

/**
 * The proxy-auth helper's configuration.
 *
 * **Observed** — `chunk-8659jdnp.js` (the whole file). The helper is the
 * **policy** tier's, or the **user** tier's; it is flagged as coming from a
 * project or a local tier when the policy tier has none, the user tier has one,
 * and the project or the local tier carries **the same** string.
 */
export interface ProxyAuthHelperConfig {
  /** The shell command that prints the `Proxy-Authorization` value. */
  readonly helper?: string;
  /** Whether the helper came from a project or a local tier. */
  readonly fromProjectOrLocal: boolean;
  /** Whether the workspace trust that the helper needs has been accepted. */
  readonly trustAccepted: () => boolean;
  /** Where the helper may come from. */
  readonly sources: 'personAndPolicy';
}

function tierHelper(tiers: ReadonlyMap<string, unknown>, source: string): string | undefined {
  if (!tiers.has(source)) return undefined;
  const document = documentOf(tiers.get(source));
  if (typeof document !== 'object' || document === null) return undefined;
  const record = document as Record<string, unknown>;
  if (!Object.hasOwn(record, 'proxyAuthHelper')) return undefined;
  const value = record['proxyAuthHelper'];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Read the proxy-auth helper's configuration out of the settings tiers.
 *
 * **Observed** — `chunk-8659jdnp.js`. The policy tier wins over the user tier,
 * and a project or local tier that carries the **same** helper is what makes the
 * helper "from a project or a local tier" — a project that carries a *different*
 * helper does not.
 */
export function readProxyAuthHelperConfig(
  tiers: ReadonlyMap<string, unknown>,
  trustAccepted: () => boolean = () => false,
): ProxyAuthHelperConfig {
  const policy = tierHelper(tiers, 'policySettings');
  const user = tierHelper(tiers, 'userSettings');
  const project = tierHelper(tiers, 'projectSettings');
  const local = tierHelper(tiers, 'localSettings');
  const helper = policy ?? user;
  const fromProjectOrLocal =
    policy === undefined &&
    user !== undefined &&
    (project === user || local === user);
  return { helper, fromProjectOrLocal, trustAccepted, sources: 'personAndPolicy' };
}

/**
 * The capability a corporate proxy needs.
 *
 * This implementation reaches the network through the provider driver, and it has
 * **no corporate proxy**: no outbound proxy agent, no `Proxy-Authorization`
 * header, and no proxy-auth helper. The refusal names what is missing.
 */
export const CORPORATE_PROXY_CAPABILITY =
  'an outbound HTTP proxy agent that can carry a Proxy-Authorization header';

/**
 * The refusal a corporate-proxy operation raises.
 *
 * The pattern is the one the IDE surface uses: the refusal names the capability
 * the operation needed, so a reader can tell what is missing.
 */
export class CorporateProxyCapabilityError extends Error {
  /** The stable code of the refusal. */
  readonly code = 'corporate_proxy_unavailable';

  /** The capability the operation needed. */
  readonly capability: string;

  constructor(capability: string, operation: string) {
    super(
      `${operation} needs ${capability}, which this session does not have, so it was not attempted.`,
    );
    this.name = 'CorporateProxyCapabilityError';
    this.capability = capability;
  }
}

/**
 * Install the corporate proxy's agents on the HTTP client.
 *
 * **This implementation's** entry point, and the one that **refuses**. The target
 * installs a proxy agent on the API client and a global dispatcher on the fetch
 * client, and it runs the proxy-auth helper to fill the `Proxy-Authorization`
 * header. This implementation has no corporate proxy, so the operation refuses
 * and names the capability it needed.
 */
export function installCorporateProxyAgent(
  _env: NodeJS.ProcessEnv = process.env,
): never {
  throw new CorporateProxyCapabilityError(CORPORATE_PROXY_CAPABILITY, 'Installing a corporate proxy');
}

/* -------------------------------------------------------------------------- */
/* The enterprise gateway's internal-network allowlist                         */
/* -------------------------------------------------------------------------- */

/**
 * The stand-in the target puts in a list it could not read.
 *
 * **Observed** — `chunk-c9s0jh80.js`: `kFr = "(unreadable)"`. The
 * `gatewayInternalNetworks` setting carries it when its value could not be
 * parsed, and the gateway sign-in then refuses.
 */
export const GATEWAY_INTERNAL_NETWORKS_UNREADABLE = '(unreadable)';

/**
 * The shortest prefix a gateway block may carry.
 *
 * **Observed** — `chunk-dt3pd9ft.js:148 950` (`ed = 8`).
 */
export const GATEWAY_INTERNAL_NETWORKS_MIN_PREFIX = 8;

/**
 * The most blocks a gateway list may carry.
 *
 * **Observed** — `chunk-dt3pd9ft.js:148 950` (`z_ = 4`).
 */
export const GATEWAY_INTERNAL_NETWORKS_MAX_BLOCKS = 4;

/**
 * The private address space a gateway block may not overlap.
 *
 * **Observed** — `chunk-dt3pd9ft.js:149 500` (`Zu`).
 */
export const GATEWAY_PRIVATE_NETWORKS: readonly string[] = Object.freeze([
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '100.64.0.0/10',
]);

/**
 * The documentation ranges a gateway block may not overlap.
 *
 * **Observed** — `chunk-dt3pd9ft.js:149 500` (`th`).
 */
export const GATEWAY_DOCUMENTATION_NETWORKS: readonly string[] = Object.freeze([
  '192.0.2.0/24',
  '198.51.100.0/24',
  '203.0.113.0/24',
]);

/**
 * The shared address space a gateway block may not overlap.
 *
 * **Observed** — `chunk-dt3pd9ft.js:149 500` (`Cx`): the two ranges that VPN
 * and NAT64 clients use locally, plus the documentation ranges.
 */
export const GATEWAY_SHARED_NETWORKS: readonly string[] = Object.freeze([
  '198.18.0.0/15',
  '192.0.0.0/24',
  ...GATEWAY_DOCUMENTATION_NETWORKS,
]);

/**
 * The reserved address space a gateway block may not overlap.
 *
 * **Observed** — `chunk-dt3pd9ft.js:149 500` (`j_`).
 */
export const GATEWAY_RESERVED_NETWORKS: readonly string[] = Object.freeze([
  '0.0.0.0/8',
  '192.88.99.0/24',
  '224.0.0.0/4',
]);

/**
 * The error code the target raises for an invalid gateway network list.
 *
 * **Observed** — `chunk-dt3pd9ft.js:148 950`.
 */
export const GATEWAY_INTERNAL_NETWORKS_ERROR_CODE = 'gateway login: invalid gatewayInternalNetworks';

/**
 * The result of validating a gateway network list.
 *
 * The target **throws**; this implementation returns the shape, so a caller can
 * report the target's own reason without catching an exception.
 */
export interface GatewayInternalNetworksResult {
  /** Whether the list is usable. */
  readonly ok: boolean;
  /** The validated blocks, in the target's order, de-duplicated. */
  readonly networks: readonly string[];
  /** The target's own reason, when the list is not usable. */
  readonly reason?: string;
  /** The target's own message, when the list is not usable. */
  readonly message?: string;
}

/** The bytes of a dotted-quad IPv4 address, or `undefined` when it is not one. */
function ipv4Bytes(address: string): number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    if (part.length > 1 && part.startsWith('0')) return undefined;
    const value = Number.parseInt(part, 10);
    if (value > 255) return undefined;
    bytes.push(value);
  }
  return bytes;
}

/** Whether the first `prefix` bits of two byte strings are equal. */
function bytesMatch(left: readonly number[], right: readonly number[], prefix: number): boolean {
  const wholeBytes = prefix >> 3;
  for (let index = 0; index < wholeBytes; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  const spareBits = prefix & 7;
  if (spareBits === 0) return true;
  const mask = (255 << (8 - spareBits)) & 255;
  return ((left[wholeBytes] ?? 0) & mask) === ((right[wholeBytes] ?? 0) & mask);
}

/**
 * Whether an address is inside a block.
 *
 * **Observed** — the target's `H2`, `chunk-3q7vcbxf.js:35 560`. The block is
 * `address/prefix`; the prefix must be a number, the block's address must
 * parse, and the first `prefix` bits of the two addresses must be equal.
 *
 * **The scope.** The target's helper also understands IPv6; the gateway list is
 * IPv4 only (the target requires `isIPv4` of the address part), so this
 * implementation parses IPv4 only.
 */
export function cidrContains(block: string, address: string): boolean {
  const separator = block.lastIndexOf('/');
  if (separator < 0) return false;
  const prefixText = block.slice(separator + 1);
  if (!/^\d+$/.test(prefixText)) return false;
  const prefix = Number.parseInt(prefixText, 10);
  const base = ipv4Bytes(block.slice(0, separator));
  if (base === undefined) return false;
  const target = ipv4Bytes(address);
  if (target === undefined) return false;
  const bits = base.length * 8;
  if (prefix < 0 || prefix > bits) return false;
  return bytesMatch(target, base, prefix);
}

/** The address part of a block — the target's `nt`, the text before the first "/". */
function blockAddress(block: string): string {
  const separator = block.indexOf('/');
  return separator === -1 ? block : block.slice(0, separator);
}

/**
 * Validate the enterprise gateway's internal-network list.
 *
 * **Observed** — the target's `nh`, `chunk-dt3pd9ft.js:148 943`. The rules, in
 * the target's own order:
 *
 *   1. a list that carries the unreadable stand-in is refused outright;
 *   2. every entry is an IPv4 block written as **first-address/prefix**, with a
 *      prefix of at least /8 and at most /32;
 *   3. no entry may overlap the private, the shared, the documentation or the
 *      reserved address space;
 *   4. the list may carry at most four blocks;
 *   5. no two entries may overlap each other.
 *
 * The target's own reason texts are reproduced verbatim; the target's own
 * message is `gatewayInternalNetworks in managed settings <reason>.`
 */
export function validateGatewayInternalNetworks(
  entries: readonly string[] | undefined,
): GatewayInternalNetworksResult {
  const fail = (reason: string): GatewayInternalNetworksResult => ({
    ok: false,
    networks: [],
    reason,
    message: `gatewayInternalNetworks in managed settings ${reason}.`,
  });

  if (entries === undefined) return { ok: true, networks: [] };
  if (entries.includes(GATEWAY_INTERNAL_NETWORKS_UNREADABLE)) {
    return fail('is not a list of CIDR strings; sign-in is refused until it is fixed');
  }

  const networks: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    const [address = '', prefixText = ''] = entry.split('/');
    const prefix = Number(prefixText);
    const value = address
      .split('.')
      .reduce((accumulator, part) => accumulator * 256 + Number(part), 0);
    const parses = ipv4Bytes(address) !== undefined;
    const inside = parses && cidrContains(entry, address);
    const canonical = Number.isFinite(prefix) && value % 2 ** (32 - prefix) === 0;
    if (!parses || !inside || prefix < GATEWAY_INTERNAL_NETWORKS_MIN_PREFIX || !canonical) {
      return fail(
        `entry "${entry}" is not an IPv4 block written as first-address/prefix, ` +
          `/${GATEWAY_INTERNAL_NETWORKS_MIN_PREFIX} to /32 (like 203.0.113.0/24, but your own)`,
      );
    }
    const block = `${address}/${prefix}`;
    const overlap = [
      ...GATEWAY_PRIVATE_NETWORKS,
      ...GATEWAY_SHARED_NETWORKS,
      ...GATEWAY_RESERVED_NETWORKS,
    ].find((candidate) => cidrContains(candidate, address) || cidrContains(block, blockAddress(candidate)));
    if (overlap !== undefined) {
      if (GATEWAY_PRIVATE_NETWORKS.includes(overlap)) {
        return fail(
          `entry "${entry}" overlaps private address space (${overlap}), where /login accepts a ` +
            'gateway without this key; declare only the public block your network is numbered from',
        );
      }
      if (GATEWAY_DOCUMENTATION_NETWORKS.includes(overlap)) {
        return fail(
          `entry "${entry}" overlaps ${overlap}, a documentation example range that is no one's network`,
        );
      }
      if (GATEWAY_RESERVED_NETWORKS.includes(overlap)) {
        return fail(
          `entry "${entry}" overlaps ${overlap}, reserved address space no network is numbered from`,
        );
      }
      return fail(
        `entry "${entry}" overlaps ${overlap}, which VPN and NAT64 clients use locally`,
      );
    }
    networks.push(block);
  }

  const unique = [...new Set(networks)];
  if (unique.length > GATEWAY_INTERNAL_NETWORKS_MAX_BLOCKS) {
    return fail(
      `lists ${unique.length} blocks; at most ${GATEWAY_INTERNAL_NETWORKS_MAX_BLOCKS} are accepted`,
    );
  }
  for (let index = 0; index < unique.length; index += 1) {
    const entry = unique[index];
    if (entry === undefined) continue;
    const other = unique.find(
      (candidate, candidateIndex) =>
        candidateIndex > index &&
        (cidrContains(candidate, blockAddress(entry)) || cidrContains(entry, blockAddress(candidate))),
    );
    if (other !== undefined) {
      return fail(`entries "${entry}" and "${other}" overlap; list disjoint blocks`);
    }
  }

  return { ok: true, networks: unique };
}

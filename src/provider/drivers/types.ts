/**
 * The provider protocol drivers' shared vocabulary and helpers.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.2 (Provider request
 * construction), §2.2a (the provider adapters' wire shapes, re-derived from the
 * pinned binary) and §2.3 (the local gateway).
 *
 * ## What this module is
 *
 * Every one of the target's eight routes speaks an **Anthropic-shaped** protocol
 * (audit §2.1: the client factory turns the route into an Anthropic SDK client
 * or one of its platform subclasses). The routes differ in *four* places, and
 * only four:
 *
 *   1. the **URL** the request goes to;
 *   2. the **body mutations** the platform adapter applies;
 *   3. the **auth** shape;
 *   4. the **beta dialect** — the spelling of a beta flag differs per platform,
 *      and Bedrock rejects the **whole** request for a flag it does not know.
 *
 * This module therefore holds the shared Anthropic-native shape (the type
 * vocabulary, the body and header builders, the response parser, the error
 * classifier and the timeout policy) and the small per-platform configuration
 * that varies it. The eight drivers live in their own files, and the **SSE
 * parser** — the frame parser, the chunk parser and the event mapper — lives
 * in `sse.ts`, whose public surface is re-exported from here.
 *
 * ## The two seams a transport depends on
 *
 * A driver never signs a request and never acquires a token: the transport
 * does both. Two members of the request carry what the transport needs, and
 * the **driver writes them**:
 *
 *   - `AwsRequestContext.service` — the SigV4 **service name** (Bedrock signs
 *     with `bedrock`, Mantle with `bedrock-mantle`); a transport cannot learn
 *     it from the URL;
 *   - `ProviderRequest.tokenScope` — the OAuth2 **scope** the bearer token is
 *     acquired with (`cloud-platform`, `https://ai.azure.com/.default`).
 *
 * ## What is observed and what is a implementation choice
 *
 * Observed (audit §2.2, §2.2a):
 *
 *   - `anthropic-version: 2023-06-01` (Global Constraints);
 *   - the retry rule: `408`, `409`, `429` and every status `>= 500` are
 *     retryable, and a `401` whose request used a cached token is retryable
 *     after that token has been invalidated;
 *   - the `x-should-retry` response header is honoured **in both directions**;
 *   - the default `parseResponse` branches: SSE for a streaming request, `null`
 *     for a `204`, the raw response for a binary response, `buildMessage` for a
 *     JSON response, and `response.text()` otherwise;
 *   - `buildMessage` attaches the **non-enumerable** `_request_id` (from the
 *     `request-id` header) and `_workspace_id` (from the
 *     `anthropic-workspace-id` header);
 *   - the first-party header set: `Accept`, `User-Agent` (`Anthropic/JS
 *     <version>`), `X-Stainless-Retry-Count` and `X-Stainless-Timeout` (in
 *     seconds);
 *   - the SSE parser accepts an **extended event vocabulary** beyond the public
 *     API — `agent.*`, `session.*`, `span.*`, `user.*`, plus `event_start`,
 *     `event_delta`, `system.message` and a legacy `completion` — and this implementation
 *     must **tolerate** those events rather than fail on them;
 *   - the non-streaming timeout fallback of `600000` ms.
 *
 * Implementation choices (the audit does not pin them, so they are marked as such):
 *
 *   - the **per-token generation rate** used to derive the non-streaming
 *     timeout from `max_tokens`, and the constant overhead added to it;
 *   - the **version string** the `Anthropic/JS <version>` user agent carries
 *     (the audit records the shape, not the version);
 *   - the **beta dialect table**'s contents beyond the one spelling the
 *     research report records (see `BETA_FLAG_TRANSLATIONS`);
 *   - the marker this implementation uses for the target's "the request used a cached
 *     token that has since been invalidated" condition (see
 *     `CACHED_TOKEN_REFRESHED_FLAG`) — the target's flag lives in its auth
 *     state, not in the error body, so this implementation's driver needs a wire-visible
 *     carrier for it;
 *   - the **AWS signing context** shape (`AwsRequestContext`). This implementation does
 *     not ship an AWS credential chain (that would need a dependency, and the
 *     driver may not read the environment), so the driver owns the *request
 *     shape* — the `host` replacement, the `connection` deletion, the query
 *     preservation, and the service name — and the transport supplies the
 *     signed headers.
 */

import type { ProviderRoute, ResolvedBaseUrl } from '../routes.js';
import { sseEventsFromText } from './sse.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** The Anthropic API version the target sends on every request. */
export const ANTHROPIC_VERSION = '2023-06-01';

/** The header the Anthropic beta flags travel in. */
export const ANTHROPIC_BETA_HEADER = 'anthropic-beta';

/** The header that carries a workspace id. */
export const WORKSPACE_ID_HEADER = 'anthropic-workspace-id';

/**
 * The search parameter that marks the target's **beta path variant**.
 *
 * Observed (audit §2.2a): the target's own path set contains both
 * `/v1/messages` and `/v1/messages?beta=true` as **distinct literals**, and
 * the Bedrock and Vertex adapters both **delete** this search parameter on the
 * way out. The marker is therefore a path *variant*, not a property of a
 * request: the first-party routes keep it, the rewriting adapters drop it.
 */
export const BETA_SEARCH_PARAM = 'beta';

/**
 * The target's two first-party path variants.
 *
 * **Both** are implemented. The audit records that the pinned binary contains
 * both literals and explicitly corrects the earlier external research, which
 * had described the marker as a conditional on the beta flags (audit §2.2a, and
 * the research report's own "Corrections" section: "the plan's
 * `/v1/messages?beta=true` conditional was an invention; the target's source
 * shows both a plain and a `?beta=true` variant").
 *
 * This implementation selects between them through `anthropicPathFor`, which keeps the
 * two literals in one table so that the variant is a *value* rather than a
 * string spliced into a conditional.
 */
export const ANTHROPIC_MESSAGE_PATHS = Object.freeze({
  /** The standard path. */
  messages: '/v1/messages',
  /** The beta path variant. */
  betaMessages: '/v1/messages?beta=true',
});

/** The fallback non-streaming request timeout, in milliseconds. */
export const NONSTREAMING_TIMEOUT_FALLBACK_MS = 600_000;

/* -------------------------------------------------------------------------- */
/* The first-party header set                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The version this implementation's `Anthropic/JS <version>` user agent carries.
 *
 * **Implementation choice.** The audit records the **shape** of the user agent
 * (`Anthropic/JS <version>`) but not the version string it carries. This implementation
 * uses the pinned target's version — the same one the gateway's user agent
 * carries — so that the two are consistent and the gateway's user agent is
 * the base one **extended**, as the audit describes.
 */
export const SDK_USER_AGENT_VERSION = '2.1.303';

/** The first-party user agent. **Observed shape** (audit §2.2). */
export const SDK_USER_AGENT = `Anthropic/JS ${SDK_USER_AGENT_VERSION}`;

/** The header that carries the transport's retry count. */
export const STAINLESS_RETRY_COUNT_HEADER = 'x-stainless-retry-count';

/** The header that carries the request's timeout, in seconds. */
export const STAINLESS_TIMEOUT_HEADER = 'x-stainless-timeout';

/**
 * The target's error for a client that was given neither a region nor the
 * matching environment variable.
 *
 * **Observed** (audit §2.2a): "A missing region throws `Expected 'awsRegion'
 * option to be passed to the client or the 'AWS_REGION' environment variable`".
 */
export const AWS_REGION_REQUIRED_ERROR =
  "Expected 'awsRegion' option to be passed to the client or the 'AWS_REGION' environment variable";

/**
 * This implementation's wire-visible marker for the target's "the request used a cached
 * token that has since been invalidated" condition.
 *
 * The target's `shouldRetry` "retries on `401` when the response used a cached
 * token that has not already been refreshed" (audit §2.2). In the target that
 * fact lives in the client's auth state; the driver only sees the error body,
 * so this implementation needs a carrier for it. **Implementation choice** — the marker is
 * documented here rather than invented silently.
 */
export const CACHED_TOKEN_REFRESHED_FLAG = 'cached_token_refreshed';

/* -------------------------------------------------------------------------- */
/* Request and event vocabulary                                                */
/* -------------------------------------------------------------------------- */

/**
 * How a credential authenticates.
 *
 * The plan fixes `buildHeaders(req, cred)` to take the credential as a single
 * string, so the *kind* has to travel with the request. It is a request member
 * because the same route supports more than one kind — Bedrock takes either a
 * bearer token or a SigV4-signed request, Foundry takes either an API key or
 * an Azure AD token (audit §2.2a) — and because the routes disagree about
 * which kind is the default.
 */
export type CredentialKind = 'apiKey' | 'bearer' | 'awsSigV4';

/**
 * One content block of a message.
 *
 * The shape is the Anthropic-native one, because every route is
 * Anthropic-shaped (audit §2.1).
 */
export type ProviderContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean };

/** One message of a conversation. */
export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: string | ProviderContentBlock[];
}

/** One tool the model may call. */
export interface ProviderTool {
  name: string;
  description?: string;
  /** The JSON Schema of the tool's input. */
  inputSchema: Record<string, unknown>;
}

/** Token accounting for a turn. */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/** Why a model stopped. */
export type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'refusal';

/**
 * The AWS signing context a SigV4 route needs.
 *
 * **Implementation choice.** This implementation ships no AWS credential chain and the driver may
 * not read the environment, so the *shape* of a SigV4 request lives here and
 * the *signature* is supplied by the transport. See `AwsRequestContext`.
 */
export interface AwsRequestContext {
  /** The AWS region, e.g. `us-east-1`. */
  region: string;
  /** The SigV4 service name, when the route does not fix it. */
  service?: string;
  /** The `x-amz-date` value, when the transport computed one. */
  date?: string;
  /** The session token, when the credential chain supplied one. */
  sessionToken?: string;
  /** A pre-computed SigV4 `Authorization` header. */
  authorization?: string;
}

/** The Vertex routing a request needs. */
export interface VertexRequestContext {
  /** The Google Cloud project id. */
  projectId: string;
  /** The location, e.g. `us-central1`. */
  location: string;
  /**
   * The **region** the endpoint is served from, e.g. `global`, `us` or `eu`.
   *
   * The regional host convention (research §1, not superseded by audit §2.2a)
   * selects the *host*; the `location` selects the *path segment*. The two
   * are different things: a request to `us-central1` is served by the `us`
   * regional endpoint.
   */
  region?: string;
}

/**
 * The credential **sources** a request supplies.
 *
 * The target's Foundry adapter treats its `apiKey` and its
 * `azureADTokenProvider` arguments as **mutually exclusive** and throws when
 * both or neither are given (audit §2.2a). This implementation's driver receives one
 * *resolved* credential, so the **set** of sources travels on the request and
 * the driver validates it.
 */
export interface ProviderCredentialSources {
  /** The API key the connection supplies. */
  apiKey?: string;
  /** The Azure AD (Entra ID) token the connection supplies. */
  azureADToken?: string;
}

/**
 * A request to a provider.
 *
 * The plan fixes the first block of members. The rest are **additive optional**
 * members, so a plan-conforming consumer keeps type-checking and a
 * plan-conforming producer keeps compiling.
 */
export interface ProviderRequest {
  model: string;
  maxTokens: number;
  messages: ProviderMessage[];
  system?: string;
  tools: ProviderTool[];
  stream: boolean;
  temperature?: number;
  thinking?: { type: 'enabled' | 'adaptive' | 'disabled'; budgetTokens?: number };
  betaFlags?: string[];
  extraHeaders?: Record<string, string>;

  /* --- additive, optional members --------------------------------------- */

  /** How the credential authenticates. Defaults to the driver's own default. */
  credentialKind?: CredentialKind;
  /**
   * The resolved endpoint of the connection.
   *
   * The route-policy layer (`resolveBaseUrl` in `src/provider/routes.ts`)
   * reports the base-URL variables that were supplied and the ones that are in
   * conflict under the target's own mutual-exclusion rule; the driver reads
   * both from here, so the Foundry driver can raise the target's own error.
   */
  endpoint?: ResolvedBaseUrl;
  /** A workspace id, when the connection is bound to one. */
  workspaceId?: string;
  /** The AWS signing context, for the SigV4 routes. */
  aws?: AwsRequestContext;
  /** The Vertex routing, for the Vertex route. */
  vertex?: VertexRequestContext;
  /** An explicit timeout, in milliseconds. */
  timeout?: number;
  /**
   * Which operation the request performs.
   */
  operation?: 'messages' | 'count_tokens';
  /**
   * Which first-party **path variant** the request uses.
   *
   * The two variants are distinct literals in the target's own path set
   * (audit §2.2a), not a marker spliced into a conditional. This member makes
   * the variant selectable **directly**, so either variant is reachable
   * independently of the beta flags; when it is absent the variant follows the
   * beta flags, which is what the plan's Step 1 requires.
   */
  pathVariant?: 'messages' | 'betaMessages';
  /**
   * The OAuth2 scope a bearer token for this request must be acquired with.
   *
   * **The scope seam.** The route's scope is a *route* property, and a
   * transport — not a driver — acquires the token. The driver therefore
   * **writes** its own scope here and the transport **reads** it:
   *
   *   - `vertex` and `anthropicGoogleCloud` → `cloud-platform`;
   *   - `foundry` → `https://ai.azure.com/.default`.
   *
   * The member is written by the driver (see `applyTokenScope`), so a caller
   * that inspects the request after `buildHeaders` sees the scope that the
   * token must be acquired with.
   */
  tokenScope?: string;
  /**
   * The credential **sources** the connection supplies.
   *
   * The Foundry driver validates them (the target's mutual exclusion) and
   * uses them: the API key and the Azure AD token are never both sent.
   */
  credentialSources?: ProviderCredentialSources;
  /**
   * The retry count the transport reports.
   *
   * It travels in the `x-stainless-retry-count` header (audit §2.2). The
   * implementation's driver does not retry — the transport does — so the count is `0`
   * unless the caller sets it.
   */
  retryCount?: number;
  /**
   * The Foundry resource (deployment) name, when the connection supplies one.
   *
   * The driver builds the **audited** base URL from it:
   * `https://<resource>.services.ai.azure.com/anthropic/`.
   */
  foundryResource?: string;
}

/**
 * One event of a provider turn.
 *
 * The plan fixes the union. `message_stop` carries an **optional** `usage`:
 * the wire's `message_delta` usage is **cumulative** (audit §2.2 and the
 * research report's streaming note), and the only place a consumer can see the
 * final total without reaching into the opaque parse state is the last event
 * of the turn.
 */
export type ProviderEvent =
  | { type: 'message_start'; messageId: string; model: string; role?: string; usage?: Usage }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; content: unknown; isError: boolean }
  | {
      type: 'message_stop';
      stopReason: StopReason;
      /** The cumulative usage the stream reported. */
      usage?: Usage;
    }
  | { type: 'error'; message: string; status?: number; retryable: boolean };

/**
 * The one interface every route implements.
 *
 * The plan fixes these members exactly. The implementation may accept *extra
 * optional* arguments (a function with more optional parameters is assignable
 * to one with fewer), which is how the drivers honour the `x-should-retry`
 * response header without changing the interface.
 */
export interface ProviderDriver {
  readonly route: ProviderRoute;
  buildUrl(req: ProviderRequest, baseUrl?: string): string;
  buildHeaders(req: ProviderRequest, cred: string | undefined): Record<string, string>;
  buildBody(req: ProviderRequest, cred: string | undefined): { body: unknown; headers: Record<string, string> };
  parseStream(chunk: string, state: unknown): { events: ProviderEvent[]; state: unknown };
  parseNonStreaming(body: unknown): { events: ProviderEvent[] };
  classifyError(status: number, body: unknown, options?: ErrorClassificationOptions): { message: string; retryable: boolean };
  calculateNonstreamingTimeout(maxTokens: number, modelLimit: number | undefined): number;
  betaFlagsFor(flags: string[]): string[];
}

/* -------------------------------------------------------------------------- */
/* Small shared helpers                                                        */
/* -------------------------------------------------------------------------- */

/** Whether a value is a plain object (not an array, not `null`). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read an own string member.
 *
 * **Own-property** on purpose: a member name is caller-supplied data, and
 * `Object.prototype` carries members called `constructor`, `toString`,
 * `valueOf` and `hasOwnProperty`. A bare index would resolve one of those
 * instead of reporting "absent".
 */
export function ownString(record: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** Read an own finite number member. */
export function ownNumber(record: Record<string, unknown>, key: string): number | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Read an own boolean member. */
export function ownBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** Read an own object member. */
export function ownRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

/** Read an own array member. */
export function ownArray(record: Record<string, unknown>, key: string): unknown[] | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}

/**
 * Join a base URL and a path.
 *
 * The base's trailing slashes and the path's leading slashes are collapsed, so
 * a base that ends in `/` (the Foundry target builds its base *with* a trailing
 * slash) does not produce a doubled separator.
 */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.replace(/^\/+/, '');
  return suffix === '' ? base : `${base}/${suffix}`;
}

/**
 * Delete the `beta` search parameter from a path, keeping every other
 * parameter — including a repeated one — **byte for byte**.
 *
 * **Observed** (audit §2.2a): the Bedrock and Vertex adapters both "delete the
 * `beta` search parameter" on the way out. The other parameters survive, which
 * is the same requirement the SigV4 signer has ("multi-valued query parameters
 * preserved").
 *
 * The surviving query is **not** re-serialized: a `URLSearchParams` round trip
 * would rewrite `%20` as `+` and `%2F` as `%2F`, and a SigV4 signature covers
 * the **canonical query** — so a re-encoded query would not match the
 * signature the transport computed. The parameter is therefore removed
 * textually and every other byte is left alone.
 */
export function stripBetaSearchParam(path: string): string {
  const separator = path.indexOf('?');
  if (separator === -1) return path;
  const base = path.slice(0, separator);
  const query = path.slice(separator + 1);
  if (query === '') return base;

  const kept = query.split('&').filter((pair) => !isBetaParam(pair));
  return kept.length === 0 ? base : `${base}?${kept.join('&')}`;
}

/**
 * Whether one `name=value` pair of a query string is the `beta` parameter.
 *
 * The name is compared **decoded** (so a percent-encoded spelling is caught)
 * and **exactly** (so a parameter whose name merely starts with `beta`
 * survives).
 */
function isBetaParam(pair: string): boolean {
  const equals = pair.indexOf('=');
  const raw = equals === -1 ? pair : pair.slice(0, equals);
  if (raw === BETA_SEARCH_PARAM) return true;
  try {
    return decodeURIComponent(raw) === BETA_SEARCH_PARAM;
  } catch {
    return false;
  }
}

/**
 * Split a comma-separated header value into its trimmed, non-empty parts.
 *
 * **Observed** (audit §2.2a): the Bedrock adapter moves the `anthropic-beta`
 * **header** into the body's `anthropic_beta` array, "split on `,` and
 * **trimmed**".
 */
export function splitCommaList(value: string): string[] {
  const parts: string[] = [];
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    if (trimmed !== '') parts.push(trimmed);
  }
  return parts;
}

/**
 * The first-party path variant a request uses.
 *
 * The two literals live in `ANTHROPIC_MESSAGE_PATHS`; this function picks
 * between them. A request that names a variant explicitly gets that variant;
 * otherwise a request with no beta flags uses the standard path, and a request
 * that carries beta flags uses the beta variant.
 */
export function anthropicPathFor(req: ProviderRequest): string {
  const variant = req.pathVariant;
  if (variant === 'messages' || variant === 'betaMessages') return ANTHROPIC_MESSAGE_PATHS[variant];
  const flags = req.betaFlags;
  if (!Array.isArray(flags) || flags.length === 0) return ANTHROPIC_MESSAGE_PATHS.messages;
  return ANTHROPIC_MESSAGE_PATHS.betaMessages;
}

/* -------------------------------------------------------------------------- */
/* Beta dialects                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The per-platform spelling of a beta flag.
 *
 * **Observed in part** (research report §"Beta flags are not portable", which
 * the audit does not supersede for this point): "Bedrock rejects the **whole**
 * request with `400 "invalid beta flag"` for an unrecognized flag, and
 * Bedrock's spelling of some betas differs from Anthropic's
 * (`advanced-tool-use-2025-11-20` versus `tool-search-tool-2025-10-19`)". The
 * canonical (first-party) spelling is therefore `tool-search-tool-2025-10-19`
 * and Bedrock's is `advanced-tool-use-2025-11-20`.
 *
 * The table is keyed by the **canonical** name and carries the per-dialect
 * spelling, so a driver translates rather than copies a flag verbatim.
 */
export const BETA_FLAG_TRANSLATIONS: ReadonlyMap<
  string,
  Readonly<Partial<Record<ProviderRoute, string>>>
> = new Map<string, Readonly<Partial<Record<ProviderRoute, string>>>>([
  [
    'tool-search-tool-2025-10-19',
    Object.freeze({
      bedrock: 'advanced-tool-use-2025-11-20',
    }),
  ],
  [
    'advanced-tool-use-2025-11-20',
    Object.freeze({
      firstParty: 'tool-search-tool-2025-10-19',
      gateway: 'tool-search-tool-2025-10-19',
      mantle: 'tool-search-tool-2025-10-19',
      vertex: 'tool-search-tool-2025-10-19',
      foundry: 'tool-search-tool-2025-10-19',
      anthropicAws: 'tool-search-tool-2025-10-19',
      anthropicGoogleCloud: 'tool-search-tool-2025-10-19',
    }),
  ],
]);

/**
 * Translate one beta flag into a dialect's spelling.
 *
 * The lookup is an own-property check on the per-dialect record, so a dialect
 * name that collides with an `Object.prototype` member never resolves to the
 * inherited member.
 */
export function translateBetaName(name: string, dialect: ProviderRoute): string {
  const entry = BETA_FLAG_TRANSLATIONS.get(name);
  if (entry === undefined) return name;
  if (!Object.hasOwn(entry, dialect)) return name;
  const translated = entry[dialect];
  return typeof translated === 'string' && translated !== '' ? translated : name;
}

/**
 * Translate a list of beta flags into a dialect's spelling.
 *
 * Every flag is **trimmed**, empty flags are dropped, and a duplicate is
 * dropped after translation — so the list that reaches the body array is
 * trimmed before it is placed there (the plan's Step 13b assertion).
 */
export function translateBetaFlags(flags: readonly string[], dialect: ProviderRoute): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const flag of flags) {
    if (typeof flag !== 'string') continue;
    const trimmed = flag.trim();
    if (trimmed === '') continue;
    const translated = translateBetaName(trimmed, dialect);
    if (translated === '' || seen.has(translated)) continue;
    seen.add(translated);
    result.push(translated);
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                       */
/* -------------------------------------------------------------------------- */

/** The statuses the target's `shouldRetry` retries on. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 409, 429]);

/**
 * Whether a status is retryable under the target's rule.
 *
 * **Observed** (audit §2.2): "retries `408`, `409`, `429`, and any status
 * `>= 500`".
 */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status) || status >= 500;
}

/**
 * Whether an error body reports that the request used a cached token that has
 * since been invalidated.
 *
 * **Implementation choice** — see `CACHED_TOKEN_REFRESHED_FLAG`. The marker is read
 * from the error object or from the body's top level.
 */
export function cachedTokenRefreshed(body: unknown): boolean {
  if (!isRecord(body)) return false;
  if (ownBoolean(body, CACHED_TOKEN_REFRESHED_FLAG) === true) return true;
  const error = ownRecord(body, 'error');
  if (error !== undefined && ownBoolean(error, CACHED_TOKEN_REFRESHED_FLAG) === true) return true;
  return false;
}

/**
 * The message an error body carries.
 */
export function errorMessageFor(status: number, body: unknown): string {
  if (isRecord(body)) {
    const error = ownRecord(body, 'error');
    if (error !== undefined) {
      const message = ownString(error, 'message');
      if (message !== undefined && message !== '') return message;
    }
    const message = ownString(body, 'message');
    if (message !== undefined && message !== '') return message;
  }
  if (typeof body === 'string' && body !== '') return body;
  return `HTTP ${status}`;
}

/** The options a classifier accepts. */
export interface ErrorClassificationOptions {
  /**
   * The response headers, when the caller has them.
   *
   * **Observed** (audit §2.2): the target "honours the `x-should-retry`
   * response header in both directions".
   */
  headers?: Record<string, string>;
  /**
   * Whether the request used a cached token that has since been invalidated.
   *
   * The explicit form of the marker `cachedTokenRefreshed` reads out of the
   * body; a caller that knows the fact from its own auth state passes it here.
   */
  cachedTokenRefreshed?: boolean;
}

/**
 * Classify an HTTP error.
 *
 * The rule set is **shared** by every driver (the plan's Step 6), because the
 * target's retry rule lives in the SDK's shared client, not in a platform
 * adapter.
 */
export function classifyErrorStatus(
  status: number,
  body: unknown,
  options: ErrorClassificationOptions = {},
): { message: string; retryable: boolean } {
  const message = errorMessageFor(status, body);

  const headers = options.headers;
  if (headers !== undefined) {
    // The header is honoured in **both** directions, so it overrides the
    // status rules.
    const shouldRetry = readHeader(headers, 'x-should-retry');
    if (shouldRetry === 'false') return { message, retryable: false };
    if (shouldRetry === 'true') return { message, retryable: true };
  }

  if (status === 401) {
    const refreshed = options.cachedTokenRefreshed ?? cachedTokenRefreshed(body);
    return { message, retryable: refreshed };
  }

  return { message, retryable: isRetryableStatus(status) };
}

/**
 * Read a header, case-insensitively.
 *
 * A header name is caller-supplied data, so the lookup is an **own-property**
 * check and never resolves an `Object.prototype` member.
 */
export function readHeader(headers: Record<string, string>, name: string): string | undefined {
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) return value;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Timeouts                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The milliseconds this implementation assumes one output token takes.
 *
 * **Implementation choice.** The audit records only that the target computes a timeout
 * from `max_tokens` and a per-model limit and falls back to `600000` ms; it
 * does not record the rate. This implementation assumes 40 output tokens per second
 * (25 ms per token), which is a conservative generation rate.
 */
export const NONSTREAMING_MS_PER_OUTPUT_TOKEN = 25;

/**
 * The fixed overhead this implementation adds to a computed timeout.
 *
 * **Implementation choice.** It covers the connection set-up and the time to read the
 * prompt.
 */
export const NONSTREAMING_BASE_MS = 10_000;

/**
 * Compute the non-streaming request timeout.
 *
 * **Observed in part** (audit §2.2): the client "computes one from the model's
 * output-token limit and the requested `max_tokens`", and falls back to
 * `600000` ms. The **cap** is observed; the **rate** is this implementation's (§ above).
 *
 * `modelLimit` is the model's own timeout limit in milliseconds — the target's
 * `modelTimeoutTable` entry. It bounds the computed value from above, and the
 * `600000` ms fallback bounds it in every case.
 */
export function calculateNonstreamingTimeoutMs(maxTokens: number, modelLimit: number | undefined): number {
  const tokens = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.ceil(maxTokens) : 0;
  const estimated = tokens * NONSTREAMING_MS_PER_OUTPUT_TOKEN + NONSTREAMING_BASE_MS;
  const bounded =
    modelLimit !== undefined && Number.isFinite(modelLimit) && modelLimit > 0 ? Math.min(estimated, modelLimit) : estimated;
  return Math.min(bounded, NONSTREAMING_TIMEOUT_FALLBACK_MS);
}

/**
 * The timeout a request uses.
 *
 * **Observed** (audit §2.2): the client computes `options.timeout ?? client
 * ._options.timeout`, so an **explicit** timeout is used unchanged and is never
 * clamped by the fallback.
 */
export function resolveRequestTimeout(req: ProviderRequest, modelLimit: number | undefined): number {
  if (req.timeout !== undefined && Number.isFinite(req.timeout) && req.timeout > 0) return req.timeout;
  return calculateNonstreamingTimeoutMs(req.maxTokens, modelLimit);
}

/* -------------------------------------------------------------------------- */
/* The Anthropic-native body and headers                                       */
/* -------------------------------------------------------------------------- */

/** How a driver shapes the Anthropic-native body. */
export interface AnthropicBodyOptions {
  /** Whether the body carries `model`. Default `true`. */
  includeModel?: boolean;
  /** Whether the body carries `stream`. Default `true`. */
  includeStream?: boolean;
  /**
   * The `anthropic_version` literal to set when the body does not already
   * carry one.
   */
  anthropicVersion?: string;
  /**
   * Whether the request **counts tokens**.
   *
   * A `count_tokens` body carries the prompt and the tools, and **none** of
   * the generation knobs: no `max_tokens`, no `stream`, no `temperature` and
   * no `thinking`. A count-tokens request that carried them would be a
   * messages request wearing a count-tokens URL.
   */
  countTokens?: boolean;
}

/**
 * Build the Anthropic-native body.
 *
 * The shape is the public Anthropic Messages shape: `model`, `max_tokens`,
 * `messages`, `system`, `tools`, `stream`, `temperature` and `thinking`
 * (audit §2.2 and the research report's first-party bullet).
 */
export function buildAnthropicBody(
  req: ProviderRequest,
  options: AnthropicBodyOptions = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messages: req.messages.map((message) => ({ role: message.role, content: message.content })),
    tools: req.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      input_schema: tool.inputSchema,
    })),
  };

  if (options.countTokens !== true) {
    body['max_tokens'] = req.maxTokens;
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.thinking !== undefined) {
      body['thinking'] =
        req.thinking.budgetTokens !== undefined
          ? { type: req.thinking.type, budget_tokens: req.thinking.budgetTokens }
          : { type: req.thinking.type };
    }
  }

  if (options.includeModel !== false) body['model'] = req.model;
  if (options.includeStream !== false && options.countTokens !== true) body['stream'] = req.stream;
  if (req.system !== undefined) body['system'] = req.system;

  if (options.anthropicVersion !== undefined && !Object.hasOwn(body, 'anthropic_version')) {
    body['anthropic_version'] = options.anthropicVersion;
  }

  return body;
}

/** How a driver shapes the Anthropic-native headers. */
export interface AnthropicHeaderOptions {
  /** The auth mode used when the request does not name one. */
  credentialKind?: CredentialKind;
  /** Whether the `anthropic-workspace-id` header is sent. */
  workspaceHeader?: boolean;
  /** Whether the `anthropic-version` header is sent. Default `true`. */
  anthropicVersion?: boolean;
  /** The route whose beta spelling this route uses. */
  betaDialect?: ProviderRoute;
  /** Extra headers, merged last. */
  extraHeaders?: Record<string, string>;
}

/**
 * The credential kind a request uses: the request's own, else the driver's
 * default.
 *
 * The member is caller-supplied, so the value is checked against the closed
 * vocabulary before it is used.
 */
export function resolveCredentialKind(req: ProviderRequest, fallback: CredentialKind): CredentialKind {
  const kind = req.credentialKind;
  if (kind === 'apiKey' || kind === 'bearer' || kind === 'awsSigV4') return kind;
  return fallback;
}

/**
 * Build the Anthropic-native headers.
 *
 * **Observed** (audit §2.2, `buildHeaders`): `Accept: application/json`,
 * `User-Agent` (`Anthropic/JS <version>`), `X-Stainless-Retry-Count`,
 * `X-Stainless-Timeout` (seconds), `anthropic-version: 2023-06-01`, then the
 * auth headers, then the client default headers, then the per-call headers.
 *
 * The header bag is a **null-prototype** object: a caller-supplied header
 * name is caller-supplied *data*, and `'__proto__'` must not silently vanish
 * into the prototype chain (and `'constructor'` must not shadow an inherited
 * member in a way a later lookup cannot tell apart from an own member).
 */
export function buildAnthropicHeaders(
  req: ProviderRequest,
  cred: string | undefined,
  options: AnthropicHeaderOptions = {},
): Record<string, string> {
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  headers['accept'] = 'application/json';
  headers['content-type'] = 'application/json';
  headers['user-agent'] = SDK_USER_AGENT;
  headers[STAINLESS_RETRY_COUNT_HEADER] = String(req.retryCount ?? 0);
  headers[STAINLESS_TIMEOUT_HEADER] = String(timeoutSecondsFor(req));

  if (options.anthropicVersion !== false) headers['anthropic-version'] = ANTHROPIC_VERSION;

  const dialect = options.betaDialect ?? 'firstParty';
  const betaFlags = translateBetaFlags(req.betaFlags ?? [], dialect);
  if (betaFlags.length > 0) headers[ANTHROPIC_BETA_HEADER] = betaFlags.join(',');

  if (options.workspaceHeader === true && typeof req.workspaceId === 'string' && req.workspaceId !== '') {
    headers[WORKSPACE_ID_HEADER] = req.workspaceId;
  }

  applyCredential(headers, req, cred, options.credentialKind ?? 'apiKey');

  const extra = options.extraHeaders ?? req.extraHeaders;
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) {
      headers[key.toLowerCase()] = value;
    }
  }

  return headers;
}

/**
 * The request's timeout, in **seconds** — the unit the
 * `x-stainless-timeout` header carries.
 *
 * **Observed** (audit §2.2): the header carries the timeout in seconds. The
 * timeout itself is the explicit one when there is one, and otherwise the
 * computed non-streaming timeout (the model limit is not known to the driver).
 */
export function timeoutSecondsFor(req: ProviderRequest): number {
  const ms = resolveRequestTimeout(req, undefined);
  return Math.max(0, Math.ceil(ms / 1000));
}

/**
 * Apply the auth headers for a credential kind.
 *
 * An API key and a bearer token are **never both** sent (audit §2.2a: the
 * first-party route sends "headers `x-api-key` **or** `authorization: Bearer`,
 * never both"; the Foundry route says the same).
 *
 * The SigV4 mode adds no auth header of its own: the signature is the
 * transport's, and the driver only carries the signing *context*.
 */
export function applyCredential(
  headers: Record<string, string>,
  req: ProviderRequest,
  cred: string | undefined,
  kind: CredentialKind,
): void {
  if (kind === 'awsSigV4') {
    applyAwsSigningContext(headers, req);
    return;
  }
  if (typeof cred !== 'string' || cred === '') return;
  if (kind === 'bearer') {
    headers['authorization'] = `Bearer ${cred}`;
    return;
  }
  headers['x-api-key'] = cred;
}

/**
 * Add the SigV4 signing context to the headers.
 *
 * **Observed** (audit §2.2a): "A missing region throws `Expected 'awsRegion'
 * option to be passed to the client or the 'AWS_REGION' environment variable`".
 * The region is required for a SigV4 request, so the driver raises the target's
 * own error when it is absent.
 */
export function applyAwsSigningContext(headers: Record<string, string>, req: ProviderRequest): void {
  const aws = req.aws;
  if (aws === undefined || typeof aws.region !== 'string' || aws.region.trim() === '') {
    throw new Error(AWS_REGION_REQUIRED_ERROR);
  }
  if (typeof aws.date === 'string' && aws.date !== '') headers['x-amz-date'] = aws.date;
  if (typeof aws.sessionToken === 'string' && aws.sessionToken !== '') {
    headers['x-amz-security-token'] = aws.sessionToken;
  }
  if (typeof aws.authorization === 'string' && aws.authorization !== '') {
    headers['authorization'] = aws.authorization;
  }
}

/**
 * Write the route's **SigV4 service name** into the request's signing context.
 *
 * **The service-name seam.** This implementation ships no AWS credential chain: the
 * *driver* owns the request's shape and the *transport* computes the
 * signature. The service name is the one thing the transport cannot learn
 * from the request's other parts — Bedrock signs with `bedrock`, Mantle with
 * `bedrock-mantle` — so the driver writes it into the signing context it
 * hands the transport (`AwsRequestContext.service`).
 *
 * A request with no signing context is left alone: the region error is raised
 * by `applyAwsSigningContext`, which is where the target raises it.
 */
export function applySigV4Service(req: ProviderRequest, service: string): void {
  const aws = req.aws;
  if (aws === undefined) return;
  aws.service = service;
}

/**
 * Write the route's **OAuth2 scope** into the request's token context.
 *
 * **The scope seam.** The bearer token for the Google and Azure routes is
 * acquired with a scope: `cloud-platform` for Vertex and Anthropic-on-Google-
 * Cloud, `https://ai.azure.com/.default` for Foundry (audit §2.2a). The driver
 * owns the route, so the driver owns the scope; the *transport* acquires the
 * token and therefore reads the scope from the request.
 */
export function applyTokenScope(req: ProviderRequest, scope: string): void {
  req.tokenScope = scope;
}

/**
 * Apply the target's documented SigV4 **header mutations**.
 *
 * **Observed** (audit §2.2a): "the `host` header replaced by the URL's host,
 * the `connection` header deleted, and multi-valued query parameters
 * preserved".
 *
 * The `host` replacement is the reason this is a free function and not a
 * method of the driver: the driver builds the headers *before* the URL is
 * known, so the signing step — which does know it — is where the replacement
 * happens.
 */
export function applyAwsSigningHeaders(
  headers: Record<string, string>,
  url: string,
): Record<string, string> {
  const result: Record<string, string> = { ...headers };
  delete result['connection'];
  const host = hostOf(url);
  if (host !== '') result['host'] = host;
  return result;
}

/**
 * The host of a URL, with its port when it carries a non-default one.
 */
export function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port === '' ? parsed.hostname.toLowerCase() : `${parsed.hostname.toLowerCase()}:${parsed.port}`;
  } catch {
    return '';
  }
}

/**
 * Resolve a `{region}` placeholder in a base URL.
 *
 * **Implementation choice** (the route-policy layer's own note): the route defaults are
 * *templates*, and the driver layer resolves the placeholder. A placeholder
 * that cannot be resolved is reported by the caller.
 */
export function resolveRegionTemplate(template: string, region: string | undefined): string {
  if (region === undefined || region.trim() === '') return template;
  return template.replace(/\{region\}/g, region.trim());
}

/* -------------------------------------------------------------------------- */
/* Usage and stop reasons                                                       */
/* -------------------------------------------------------------------------- */

/** Map the wire's usage onto this implementation's `Usage`. */
export function usageFromWire(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: Usage = {};
  const input = ownNumber(value, 'input_tokens');
  if (input !== undefined) usage.inputTokens = input;
  const output = ownNumber(value, 'output_tokens');
  if (output !== undefined) usage.outputTokens = output;
  const cacheCreation = ownNumber(value, 'cache_creation_input_tokens');
  if (cacheCreation !== undefined) usage.cacheCreationInputTokens = cacheCreation;
  const cacheRead = ownNumber(value, 'cache_read_input_tokens');
  if (cacheRead !== undefined) usage.cacheReadInputTokens = cacheRead;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** Map the wire's stop reason onto this implementation's `StopReason`. */
export function stopReasonFromWire(value: unknown): StopReason {
  switch (value) {
    case 'end_turn':
      return 'end_turn';
    case 'max_tokens':
      return 'max_tokens';
    case 'tool_use':
      return 'tool_use';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'refusal':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

/* -------------------------------------------------------------------------- */
/* The local token estimate                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The number of characters per token this implementation assumes.
 *
 * **Implementation choice.** The target computes a token count locally for a Bedrock
 * upstream (audit §2.3); the audit does not record its estimator, so this implementation
 * uses the conventional four-characters-per-token approximation.
 */
export const LOCAL_TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;

/**
 * The token count of a number of **characters**.
 *
 * The count is computed from the length alone: this implementation never materialises a
 * copy of the prompt to measure it (a prompt can be megabytes long, and the
 * copy would double the memory the turn needs).
 */
export function estimateTokenCountForCharacters(characters: number): number {
  if (!Number.isFinite(characters) || characters <= 0) return 0;
  return Math.ceil(characters / LOCAL_TOKEN_ESTIMATE_CHARS_PER_TOKEN);
}

/**
 * The number of characters a prompt occupies.
 *
 * The system prompt and every message's text (or thinking) count towards the
 * local token estimate.
 */
export function promptCharacterCount(messages: unknown, system: unknown): number {
  let characters = 0;
  if (typeof system === 'string') characters += system.length;
  const list = Array.isArray(messages) ? messages : [];
  for (const message of list) {
    if (!isRecord(message)) continue;
    const content = Object.hasOwn(message, 'content') ? message['content'] : undefined;
    if (typeof content === 'string') {
      characters += content.length;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block)) continue;
      const text = ownString(block, 'text') ?? ownString(block, 'thinking');
      if (text !== undefined) characters += text.length;
    }
  }
  return characters;
}

/* -------------------------------------------------------------------------- */
/* Response parsing                                                             */
/* -------------------------------------------------------------------------- */

/** The response headers `parseResponse` reads. */
export interface ProviderResponseHeaders {
  /** The value of a header, or `null` when it is absent. */
  get(name: string): string | null | undefined;
}

/**
 * The response shape `parseResponse` accepts.
 *
 * It is the subset of the platform `Response` the SDK's own `parseResponse`
 * uses: the status, the headers, `json()` and `text()`.
 */
export interface ProviderResponseLike {
  /** The response status. */
  readonly status: number;
  /** The response headers. */
  readonly headers: ProviderResponseHeaders;
  /** The body, parsed as JSON. */
  json(): Promise<unknown>;
  /** The body, as text. */
  text(): Promise<string>;
}

/** The options `parseResponse` takes. */
export interface ParseResponseOptions {
  /** Whether the request was a **streaming** one. */
  stream?: boolean;
  /** Whether the caller asked for the raw (binary) response. */
  binaryResponse?: boolean;
}

/**
 * Parse a provider response — the default `parseResponse`.
 *
 * **Observed** (audit §2.2): the SDK's default `parseResponse` is read in
 * full, and its branch set is exactly:
 *
 * ```
 * if (options.stream)            -> SSEParser.fromSSEResponse(response, …)
 * if (response.status === 204)   -> null
 * if (options.__binaryResponse)  -> the raw response
 * if (content-type is application/json or *+json):
 *                                  if (content-length === "0") -> undefined
 *                                  else -> buildMessage(await response.json(), response)
 * otherwise                      -> await response.text()
 * ```
 *
 * This implementation's streaming branch returns an **async iterable of this implementation's
 * `ProviderEvent`s** — the analogue of the target's SSE parser — and the JSON
 * branch attaches the two **non-enumerable** properties `buildMessage`
 * attaches: `_request_id` (from the `request-id` header) and `_workspace_id`
 * (from the `anthropic-workspace-id` header).
 */
export async function parseResponse(
  response: ProviderResponseLike,
  options: ParseResponseOptions = {},
): Promise<unknown> {
  if (options.stream === true) {
    const text = await response.text();
    return sseEventsFromText(text);
  }
  if (response.status === 204) {
    return null;
  }
  if (options.binaryResponse === true) {
    return response;
  }
  if (isJsonContentType(response.headers.get('content-type'))) {
    if (response.headers.get('content-length') === '0') {
      return undefined;
    }
    return buildMessage(await response.json(), response);
  }
  return response.text();
}

/**
 * Whether a content type is a JSON one.
 *
 * **Observed** (audit §2.2): "content-type is `application/json` or `*+json`".
 * The content type's parameters (`charset` and the like) are not part of the
 * media type, so they are stripped before the test.
 */
export function isJsonContentType(contentType: string | null | undefined): boolean {
  if (typeof contentType !== 'string') return false;
  const media = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return media === 'application/json' || media.endsWith('+json');
}

/**
 * Attach the response's identifiers to a parsed body.
 *
 * **Observed** (audit §2.2): `buildMessage` (the `hn` helper) attaches two
 * **non-enumerable** properties — `_request_id` from the `request-id` header
 * and `_workspace_id` from the `anthropic-workspace-id` header. They are
 * non-enumerable because they are **not** part of the message: a consumer that
 * serialises the body must not write them onto the wire.
 */
export function buildMessage(body: unknown, response: ProviderResponseLike): unknown {
  if (!isRecord(body)) return body;
  const requestId = response.headers.get('request-id');
  const workspaceId = response.headers.get('anthropic-workspace-id');
  if (typeof requestId === 'string') defineHidden(body, '_request_id', requestId);
  if (typeof workspaceId === 'string') defineHidden(body, '_workspace_id', workspaceId);
  return body;
}

/** Define a **non-enumerable** own member. */
function defineHidden(target: Record<string, unknown>, key: string, value: string): void {
  Object.defineProperty(target, key, { value, enumerable: false, configurable: true, writable: true });
}

/* -------------------------------------------------------------------------- */
/* The SSE parser and its event mapper                                         */
/* -------------------------------------------------------------------------- */

/**
 * The SSE parser and the event mapper live in their own module.
 *
 * The shared vocabulary holds the **types**, the **builders**, the **error
 * classifier** and the **timeout policy**; the streaming logic — the frame
 * parser, the chunk parser and the event mapper — lives in `sse.ts`. The
 * public surface is re-exported **here**, so that every importer of
 * `drivers/types.js` keeps working unchanged.
 */
export {
  CORE_SSE_EVENTS,
  EXTENDED_SSE_EVENTS,
  isKnownSseEvent,
  createStreamState,
  isAnthropicStreamState,
  splitSseFrames,
  parseSseFrame,
  parseSseChunk,
  sseEventsFromText,
  eventsFromSseFrame,
  errorEventFrom,
  sseErrorTypeStatus,
  eventsFromMessage,
} from './sse.js';

export type { AnthropicStreamState, PendingToolBlock, SseFrame } from './sse.js';

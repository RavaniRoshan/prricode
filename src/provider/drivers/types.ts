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
 * This module therefore holds the shared Anthropic-native shape (body, headers,
 * SSE parsing, error classification, timeouts) and the small per-platform
 * configuration that varies it. The eight drivers live in their own files.
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
 *     preservation — and the transport supplies the signed headers.
 */

import type { ProviderRoute, ResolvedBaseUrl } from '../routes.js';

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

/** The two first-party path variants, as a list. */
export const ANTHROPIC_MESSAGE_PATH_VARIANTS: readonly (keyof typeof ANTHROPIC_MESSAGE_PATHS)[] = Object.freeze([
  'messages',
  'betaMessages',
]);

/** The fallback non-streaming request timeout, in milliseconds. */
export const NONSTREAMING_TIMEOUT_FALLBACK_MS = 600_000;

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
  | { type: 'message_start'; messageId: string; model: string; usage?: Usage }
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
 * parameter — including a repeated one.
 *
 * **Observed** (audit §2.2a): the Bedrock and Vertex adapters both "delete the
 * `beta` search parameter" on the way out. The other parameters survive, which
 * is the same requirement the SigV4 signer has ("multi-valued query parameters
 * preserved").
 */
export function stripBetaSearchParam(path: string): string {
  const separator = path.indexOf('?');
  if (separator === -1) return path;
  const base = path.slice(0, separator);
  const params = new URLSearchParams(path.slice(separator + 1));
  params.delete(BETA_SEARCH_PARAM);
  const rest = params.toString();
  return rest === '' ? base : `${base}?${rest}`;
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
    max_tokens: req.maxTokens,
    messages: req.messages.map((message) => ({ role: message.role, content: message.content })),
    tools: req.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      input_schema: tool.inputSchema,
    })),
  };

  if (options.includeModel !== false) body['model'] = req.model;
  if (options.includeStream !== false) body['stream'] = req.stream;
  if (req.system !== undefined) body['system'] = req.system;
  if (req.temperature !== undefined) body['temperature'] = req.temperature;
  if (req.thinking !== undefined) {
    body['thinking'] =
      req.thinking.budgetTokens !== undefined
        ? { type: req.thinking.type, budget_tokens: req.thinking.budgetTokens }
        : { type: req.thinking.type };
  }

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
 * `anthropic-version: 2023-06-01`, then the auth headers, then the client
 * default headers, then the per-call headers.
 */
export function buildAnthropicHeaders(
  req: ProviderRequest,
  cred: string | undefined,
  options: AnthropicHeaderOptions = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  };

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
/* The SSE parser                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The Anthropic **core** SSE events.
 *
 * **Observed** (audit §2.2): the pinned SDK's SSE parser accepts a broader
 * event vocabulary than the public API documents.
 *
 * `error` is part of the core set: the plan's Step 8 requires that "a `data:`
 * frame carrying an `error` object emits `{ type: 'error' }`", and the
 * Anthropic API delivers a stream failure as an `event: error` frame.
 */
export const CORE_SSE_EVENTS: ReadonlySet<string> = new Set([
  'message_start',
  'message_delta',
  'message_stop',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message',
  'error',
]);

/**
 * The **extended** SSE events the pinned SDK accepts.
 *
 * **Observed** (audit §2.2): `agent.*`, `user.*`, `session.*`, `span.*`, plus
 * `event_start`, `event_delta`, `system.message` and a legacy `completion`.
 *
 * This implementation **tolerates** them: a frame whose event is in this set is parsed
 * and never fails the stream.
 */
export const EXTENDED_SSE_EVENTS: ReadonlySet<string> = new Set([
  // agent
  'agent.message',
  'agent.thinking',
  'agent.tool_use',
  'agent.tool_result',
  'agent.mcp_tool_use',
  'agent.mcp_tool_result',
  'agent.custom_tool_use',
  'agent.thread_context_compacted',
  'agent.thread_message_received',
  'agent.thread_message_sent',
  'agent.session_thread_message_received',
  'agent.session_thread_message_sent',
  // user
  'user.message',
  'user.interrupt',
  'user.tool_confirmation',
  'user.custom_tool_result',
  'user.tool_result',
  'user.define_outcome',
  // session
  'session.status_running',
  'session.status_idle',
  'session.status_rescheduled',
  'session.status_terminated',
  'session.error',
  'session.deleted',
  'session.updated',
  'session.thread_created',
  'session.thread_status_created',
  'session.thread_status_running',
  'session.thread_status_idle',
  'session.thread_status_rescheduled',
  'session.thread_status_terminated',
  // span / outcome
  'span.model_request_start',
  'span.model_request_end',
  'span.outcome_evaluation_start',
  'span.outcome_evaluation_ongoing',
  'span.outcome_evaluation_end',
  // misc
  'event_start',
  'event_delta',
  'system.message',
  'completion',
]);

/** Whether an event name is in the pinned SDK's accepted vocabulary. */
export function isKnownSseEvent(name: string): boolean {
  return CORE_SSE_EVENTS.has(name) || EXTENDED_SSE_EVENTS.has(name);
}

/**
 * The parse state of an Anthropic SSE stream.
 *
 * The state is **explicit** (the plan's Step 9) so that a chunk boundary in the
 * middle of a frame does not lose data: the unparsed remainder is carried
 * forward.
 */
export interface AnthropicStreamState {
  /** The unparsed remainder of the last chunk. */
  buffer: string;
  /** Whether a `message_start` has already been emitted. */
  started: boolean;
  /** The latest **cumulative** usage the stream reported. */
  usage?: Usage;
  /** The stop reason the stream reported. */
  stopReason?: StopReason;
  /** The tool blocks that are still accumulating their JSON input. */
  pendingTools: Map<number, PendingToolBlock>;
}

/** A tool block whose input is still arriving. */
export interface PendingToolBlock {
  id: string;
  name: string;
  /** The accumulated partial JSON. */
  json: string;
  /** The input the block carried at its start, when it carried one. */
  input?: unknown;
}

/** A fresh parse state. */
export function createStreamState(): AnthropicStreamState {
  return { buffer: '', started: false, pendingTools: new Map() };
}

/** Whether an opaque parse state is an Anthropic stream state. */
export function isAnthropicStreamState(state: unknown): state is AnthropicStreamState {
  if (!isRecord(state)) return false;
  if (typeof state['buffer'] !== 'string') return false;
  return true;
}

/**
 * The SSE frame separator: a blank line, with either line ending.
 */
const FRAME_SEPARATOR = /\r?\n\r?\n/;

/**
 * Split a buffer into complete frames and the remainder.
 *
 * The remainder is the partial frame at the end of the buffer, which the caller
 * carries forward.
 */
export function splitSseFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let rest = buffer;
  for (;;) {
    const match = FRAME_SEPARATOR.exec(rest);
    if (match === null) break;
    frames.push(rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);
  }
  return { frames, rest };
}

/** One parsed SSE frame. */
export interface SseFrame {
  /** The `event:` name, when the frame carried one. */
  event?: string;
  /** The concatenated `data:` payload. */
  data: string;
  /** The raw frame, for an error message. */
  raw: string;
}

/**
 * Parse one SSE frame.
 *
 * A frame with no `data:` line (a keep-alive comment, for instance) yields
 * `undefined`.
 */
export function parseSseFrame(frame: string): SseFrame | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      event = value;
      continue;
    }
    if (field === 'data') {
      data.push(value);
      continue;
    }
    // `id:` and `retry:` carry no meaning for this implementation.
  }
  if (data.length === 0) return undefined;
  return event !== undefined ? { event, data: data.join('\n'), raw: frame } : { data: data.join('\n'), raw: frame };
}

/**
 * Parse a chunk of an Anthropic SSE stream.
 *
 * A frame whose payload is not JSON throws with the offending data and the raw
 * frame — **observed** (audit §2.2): "a parse failure throws with the
 * offending data and raw chunk".
 */
export function parseSseChunk(
  chunk: string,
  state: AnthropicStreamState,
): { events: ProviderEvent[]; state: AnthropicStreamState } {
  const { frames, rest } = splitSseFrames(state.buffer + chunk);
  const events: ProviderEvent[] = [];
  const next: AnthropicStreamState = {
    buffer: rest,
    started: state.started,
    pendingTools: state.pendingTools,
  };
  if (state.usage !== undefined) next.usage = state.usage;
  if (state.stopReason !== undefined) next.stopReason = state.stopReason;

  for (const frame of frames) {
    const parsed = parseSseFrame(frame);
    if (parsed === undefined) continue;
    events.push(...eventsFromSseFrame(parsed, next));
  }

  return { events, state: next };
}

/**
 * Turn one SSE frame into this implementation's events.
 *
 * The **extended** vocabulary is tolerated: a frame whose event is in
 * `EXTENDED_SSE_EVENTS` never fails the stream. The tool-shaped extended
 * events are surfaced, because the plan's `ProviderEvent` union has a
 * `tool_result` member that would otherwise be unreachable; every other
 * extended event is ignored.
 */
export function eventsFromSseFrame(frame: SseFrame, state: AnthropicStreamState): ProviderEvent[] {
  let payload: unknown;
  try {
    payload = JSON.parse(frame.data);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to parse the SSE payload ${JSON.stringify(frame.data)} (frame ${JSON.stringify(frame.raw)}): ${reason}`,
    );
  }

  const type = isRecord(payload) ? (ownString(payload, 'type') ?? frame.event ?? '') : (frame.event ?? '');

  if (!isKnownSseEvent(type)) {
    // An event the pinned SDK does not know is not a failure: this implementation
    // tolerates what it does not recognise.
    return [];
  }

  if (EXTENDED_SSE_EVENTS.has(type) && !CORE_SSE_EVENTS.has(type)) {
    return extendedEventToEvents(type, payload);
  }

  return coreEventToEvents(type, payload, state);
}

/**
 * Map an extended event onto this implementation's events.
 *
 * Only the tool-shaped events are surfaced; the rest are ignored (this implementation
 * tolerates them).
 */
function extendedEventToEvents(type: string, payload: unknown): ProviderEvent[] {
  if (!isRecord(payload)) return [];
  if (type === 'agent.tool_use' || type === 'agent.mcp_tool_use' || type === 'agent.custom_tool_use') {
    const id = ownString(payload, 'tool_use_id') ?? ownString(payload, 'id') ?? '';
    const name = ownString(payload, 'name') ?? '';
    if (id === '' || name === '') return [];
    const input = Object.hasOwn(payload, 'input') ? payload['input'] : {};
    return [{ type: 'tool_use', id, name, input }];
  }
  if (
    type === 'agent.tool_result' ||
    type === 'agent.mcp_tool_result' ||
    type === 'user.tool_result' ||
    type === 'user.custom_tool_result'
  ) {
    const id = ownString(payload, 'tool_use_id') ?? ownString(payload, 'id') ?? '';
    if (id === '') return [];
    const content = Object.hasOwn(payload, 'content') ? payload['content'] : '';
    const isError = ownBoolean(payload, 'is_error') ?? ownBoolean(payload, 'isError') ?? false;
    return [{ type: 'tool_result', id, content, isError }];
  }
  return [];
}

/**
 * Map a core event onto this implementation's events.
 */
function coreEventToEvents(type: string, payload: unknown, state: AnthropicStreamState): ProviderEvent[] {
  if (!isRecord(payload)) return [];

  switch (type) {
    case 'message_start': {
      if (state.started) return [];
      state.started = true;
      const message = ownRecord(payload, 'message');
      const messageId = message !== undefined ? (ownString(message, 'id') ?? '') : (ownString(payload, 'id') ?? '');
      const model = message !== undefined ? (ownString(message, 'model') ?? '') : (ownString(payload, 'model') ?? '');
      const usage = message !== undefined ? usageFromWire(message['usage']) : usageFromWire(payload['usage']);
      if (usage !== undefined) state.usage = usage;
      return [
        {
          type: 'message_start',
          messageId,
          model,
          ...(usage !== undefined ? { usage } : {}),
        },
      ];
    }
    case 'message_delta': {
      // **The usage in a `message_delta` is cumulative, not incremental**
      // (audit §2.2 and the research report's streaming note). It therefore
      // *replaces* the state's usage rather than being added to it.
      const usage = usageFromWire(payload['usage']);
      if (usage !== undefined) state.usage = usage;
      const delta = ownRecord(payload, 'delta');
      if (delta !== undefined) {
        const stopReason = ownString(delta, 'stop_reason');
        if (stopReason !== undefined) state.stopReason = stopReasonFromWire(stopReason);
      }
      return [];
    }
    case 'message_stop': {
      const stopReason = state.stopReason ?? 'end_turn';
      const usage = state.usage;
      return [{ type: 'message_stop', stopReason, ...(usage !== undefined ? { usage } : {}) }];
    }
    case 'content_block_start': {
      const block = ownRecord(payload, 'content_block');
      if (block === undefined) return [];
      const blockType = ownString(block, 'type');
      const index = ownNumber(payload, 'index') ?? 0;
      if (blockType === 'tool_use') {
        const id = ownString(block, 'id') ?? '';
        const name = ownString(block, 'name') ?? '';
        const pending: PendingToolBlock = { id, name, json: '' };
        if (Object.hasOwn(block, 'input')) pending.input = block['input'];
        state.pendingTools.set(index, pending);
        return [];
      }
      return [];
    }
    case 'content_block_delta': {
      const index = ownNumber(payload, 'index') ?? 0;
      const delta = ownRecord(payload, 'delta');
      if (delta === undefined) return [];
      const deltaType = ownString(delta, 'type');
      if (deltaType === 'text_delta') {
        const text = ownString(delta, 'text');
        return text === undefined ? [] : [{ type: 'text_delta', text }];
      }
      if (deltaType === 'thinking_delta') {
        const text = ownString(delta, 'thinking');
        return text === undefined ? [] : [{ type: 'thinking_delta', text }];
      }
      if (deltaType === 'input_json_delta') {
        const pending = state.pendingTools.get(index);
        if (pending === undefined) return [];
        const partial = ownString(delta, 'partial_json');
        if (partial !== undefined) pending.json += partial;
        return [];
      }
      return [];
    }
    case 'content_block_stop': {
      const index = ownNumber(payload, 'index') ?? 0;
      const pending = state.pendingTools.get(index);
      if (pending === undefined) return [];
      state.pendingTools.delete(index);
      return [{ type: 'tool_use', id: pending.id, name: pending.name, input: toolInputOf(pending) }];
    }
    case 'message': {
      // A whole message delivered over SSE.
      return eventsFromMessage(payload);
    }
    case 'error': {
      return [errorEventFrom(payload)];
    }
    default:
      return [];
  }
}

/**
 * The input of a tool block: the block's own input when it carried one, else
 * the accumulated partial JSON.
 */
function toolInputOf(pending: PendingToolBlock): unknown {
  if (pending.input !== undefined) return pending.input;
  const trimmed = pending.json.trim();
  if (trimmed === '') return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

/**
 * The error event of a wire error payload.
 *
 * **Observed** (audit §2.2 and the plan's Step 8): the retryability is
 * derived from the status.
 */
export function errorEventFrom(payload: unknown): ProviderEvent {
  if (!isRecord(payload)) {
    return { type: 'error', message: 'unknown provider error', retryable: false };
  }
  const error = ownRecord(payload, 'error');
  const source = error ?? payload;
  const message = ownString(source, 'message') ?? 'unknown provider error';
  const explicitStatus = ownNumber(source, 'status');
  const status = explicitStatus ?? sseErrorTypeStatus(ownString(source, 'type'));
  const classification = classifyErrorStatus(status ?? 0, payload);
  return {
    type: 'error',
    message,
    ...(status !== undefined ? { status } : {}),
    retryable: status !== undefined ? classification.retryable : false,
  };
}

/**
 * The status a well-known SSE error type implies.
 */
export function sseErrorTypeStatus(type: string | undefined): number | undefined {
  switch (type) {
    case 'overloaded_error':
      return 529;
    case 'api_error':
      return 500;
    case 'rate_limit_error':
      return 429;
    case 'authentication_error':
      return 401;
    case 'permission_error':
      return 403;
    case 'not_found_error':
      return 404;
    case 'invalid_request_error':
      return 400;
    default:
      return undefined;
  }
}

/**
 * The events of a whole Anthropic message.
 *
 * Used by the non-streaming parser and by the SSE `message` event.
 */
export function eventsFromMessage(body: unknown): ProviderEvent[] {
  if (!isRecord(body)) {
    return [{ type: 'error', message: 'the provider returned a body that is not a JSON object', retryable: false }];
  }
  if (ownString(body, 'type') === 'error') {
    return [errorEventFrom(body)];
  }

  const usage = usageFromWire(body['usage']);
  const events: ProviderEvent[] = [
    {
      type: 'message_start',
      messageId: ownString(body, 'id') ?? '',
      model: ownString(body, 'model') ?? '',
      ...(usage !== undefined ? { usage } : {}),
    },
  ];

  const content = ownArray(body, 'content');
  for (const block of content ?? []) {
    if (!isRecord(block)) continue;
    const blockType = ownString(block, 'type');
    if (blockType === 'text') {
      const text = ownString(block, 'text');
      if (text !== undefined) events.push({ type: 'text_delta', text });
      continue;
    }
    if (blockType === 'thinking') {
      const thinking = ownString(block, 'thinking');
      if (thinking !== undefined) events.push({ type: 'thinking_delta', text: thinking });
      continue;
    }
    if (blockType === 'tool_use') {
      events.push({
        type: 'tool_use',
        id: ownString(block, 'id') ?? '',
        name: ownString(block, 'name') ?? '',
        input: Object.hasOwn(block, 'input') ? block['input'] : {},
      });
      continue;
    }
  }

  const stopReason = stopReasonFromWire(ownString(body, 'stop_reason'));
  events.push({ type: 'message_stop', stopReason, ...(usage !== undefined ? { usage } : {}) });
  return events;
}

/**
 * The provider transport.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.2 (Provider request
 * construction) and §2.2a (the provider adapters' wire shapes).
 *
 * ## What this module is
 *
 * The **consumer** the `CC-006` drivers were written for. A driver builds a
 * request — a URL, a header set and a body — and parses a response; the
 * transport is what puts the two together: it turns the driver's request into a
 * `fetch` call, and turns the response back into this implementation's `ProviderEvent`s.
 *
 * ## The rules this module follows
 *
 *   - **The transport never resolves a credential.** It *receives* one (the
 *     third argument of `sendProviderRequest`) and passes it to the driver,
 *     which puts it in the auth header. The single resolution point in the
 *     implementation is `resolveConnectionCredential` in `src/provider/registry.ts`.
 *   - **A secret never reaches a URL, a log line or an error message.** The
 *     credential only ever travels in a header, and the transport's own error
 *     messages never quote it.
 *   - **The `fetch` is injectable.** `TransportOptions.fetchImpl` replaces the
 *     global one, so the tests never reach the network.
 *   - **The response is parsed by the driver.** A streaming response goes
 *     through the driver's `parseStream`; a non-streaming one through the
 *     default `parseResponse` (which attaches the non-enumerable `_request_id`
 *     and `_workspace_id`) and then through the driver's `parseNonStreaming`.
 *   - **A request is bounded by a timeout.** The target's chain is
 *     `fetchWithTimeout -> fetch` and `fetchWithTimeout` owns an
 *     `AbortController` (audit §2.2); this implementation does the same, so a
 *     connection that stalls after the request was written cannot hang a turn
 *     forever.
 */

import {
  cachedTokenRefreshed,
  parseResponse,
  resolveRequestTimeout,
  type ProviderDriver,
  type ProviderEvent,
  type ProviderRequest,
} from '../drivers/types.js';
import { DEFAULT_MAX_RETRIES, readShouldRetry, retryDelayMs } from './retry.js';
import { buildSignedHeaders, escapeUriPath, parseAmzDate } from './sigv4.js';

/* -------------------------------------------------------------------------- */
/* The token-acquisition seam                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How a bearer token for a scope is acquired.
 *
 * The transport **never resolves a credential**: it cannot read an
 * environment variable, a file or a keychain, and it never performs an OAuth2
 * exchange. The caller owns that, and the transport asks for the token
 * through this callback.
 *
 * The **scope** is a *live* input: it is the scope the **driver** wrote into
 * the request (`ProviderRequest.tokenScope` — `cloud-platform` for Vertex and
 * Anthropic-on-Google-Cloud, `https://ai.azure.com/.default` for Foundry), so
 * the token is always acquired for the scope the route actually needs.
 */
export type TokenAcquirer = (scope: string) => Promise<string | undefined> | string | undefined;

/* -------------------------------------------------------------------------- */
/* The transport's errors                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The error a request that ran out of time raises.
 *
 * **Observed in shape** (audit §2.2): the target's `fetchWithTimeout` owns an
 * `AbortController`, so a request that never answers is abandoned rather than
 * waited on forever. This implementation raises this error instead, and it **names** the
 * timeout, so that a caller can tell a timeout from a provider error.
 */
export class ProviderTimeoutError extends Error {
  /** The timeout that fired, in milliseconds. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`the provider request timed out after ${timeoutMs} ms`);
    this.name = 'ProviderTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The error a request the caller aborted raises.
 *
 * The caller's own abort reason is carried through when it is an `Error`, so
 * that a caller sees the same failure it would see from a `fetch` that
 * honours the signal itself.
 */
export class ProviderAbortedError extends Error {
  constructor(message = 'the provider request was aborted') {
    super(message);
    this.name = 'ProviderAbortedError';
  }
}

/* -------------------------------------------------------------------------- */
/* The transport's options                                                      */
/* -------------------------------------------------------------------------- */

/**
 * How a request is sent.
 *
 * The plan fixes the first five members (`driver`, `fetchImpl`, `now`,
 * `sleep` and `signal`). The rest are **additive optional** members, so a
 * plan-conforming consumer keeps type-checking.
 */
export interface TransportOptions {
  /** The driver whose request shape and parsers are used. */
  driver: ProviderDriver;
  /** The `fetch` to use. Defaults to the global one. */
  fetchImpl?: typeof fetch;
  /** The clock, in milliseconds since the epoch. */
  now?: () => number;
  /** The sleep between two attempts. */
  sleep?: (ms: number) => Promise<void>;
  /** The abort signal the request carries. */
  signal?: AbortSignal;

  /* --- additive, optional members --------------------------------------- */

  /**
   * The base URL the request is sent to.
   *
   * It is the **resolved** base URL of the connection — the one the
   * route-policy layer produced — and it is handed to the driver's `buildUrl`,
   * which owns the path.
   */
  baseUrl?: string;
  /**
   * The number of **retries** a request gets.
   *
   * The plan's Step 5 says "retried up to the driver's `maxRetries`": a driver
   * may declare its own budget, and this member is the fallback for the
   * drivers that declare none. When neither says, the default is two
   * retries.
   */
  maxRetries?: number;
  /**
   * The timeout a request uses, in milliseconds.
   *
   * It is the transport-level default — the client-level timeout of the
   * target — and an **explicit** request timeout (`ProviderRequest.timeout`)
   * still wins over it.
   */
  timeoutMs?: number;
  /**
   * The model's own timeout limit, in milliseconds.
   *
   * It is the target's `modelTimeoutTable` entry: it bounds the computed
   * non-streaming timeout from above.
   */
  modelTimeoutLimit?: number;
  /**
   * Refresh a credential after a `401` that says the request used a cached
   * token that has since been invalidated.
   *
   * **The transport never resolves a credential** — it cannot read an
   * environment variable, a file or a keychain. The refresh is therefore a
   * **callback**: the caller owns the auth state and answers with a fresh
   * credential (or with nothing, when no refresh is possible).
   *
   * The callback is invoked at most **once** per request, and the request
   * makes **one** more attempt after it — the target's "retries on `401` when
   * the response used a cached token that has not already been refreshed". The
   * refresh **consumes the retry budget** like any other attempt.
   */
  refreshCredential?: (info: {
    /** The status of the response that asked for the refresh. */
    status: number;
    /** The parsed error body. */
    body: unknown;
    /** The OAuth2 scope the request declared, when it declared one. */
    scope?: string;
  }) => Promise<string | undefined> | string | undefined;
  /**
   * Whether the credential the caller supplied came from a **cache** that can
   * be refreshed.
   *
   * This is the **live** input of the cached-token path. The `cached_token_
   * refreshed` flag in the error body is a **implementation invention** — the
   * Anthropic API never sends it — so in production the refresh is driven by
   * this member, and a caller that knows the fact from its own auth state
   * declares it here.
   */
  credentialIsCached?: boolean;
  /**
   * The AWS credentials a SigV4 route signs with.
   *
   * The transport never resolves them — the caller owns the AWS credential
   * chain's result and hands it over, exactly as it hands over the API key.
   */
  awsCredentials?: {
    /** The AWS access key id. */
    accessKeyId: string;
    /** The AWS secret access key. */
    secretAccessKey: string;
    /** The AWS session token, when the chain supplied one. */
    sessionToken?: string;
  };
  /**
   * Acquire the bearer token a request needs.
   *
   * The transport invokes it when the **driver declares a scope** — the
   * Vertex and Foundry routes do — and the scope it is given is the one the
   * driver wrote, so the scope is a live input rather than a constant.
   *
   * The acquired token is a **bearer** token: a request that acquired one is
   * switched to the bearer kind, so that the Azure AD token is not sent as an
   * API key.
   */
  acquireToken?: TokenAcquirer;
}

/* -------------------------------------------------------------------------- */
/* The result                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a request produced.
 *
 * The plan fixes the first four members. `body` is an **additive optional**
 * member: the parsed body of a **non-streaming** response, which a caller
 * needs for a response that is not a turn (a `count_tokens` answer, for
 * instance).
 */
export interface SendResult {
  /** The events of the response. */
  events: ProviderEvent[];
  /** The response itself. */
  response: Response;
  /** The response status. */
  status: number;
  /** The `request-id` response header, when the response carried one. */
  requestId?: string;
  /** The parsed body of a non-streaming response. */
  body?: unknown;
}

/* -------------------------------------------------------------------------- */
/* The transport                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Send a request through a driver and parse the response.
 *
 * The credential is **received**, never resolved: the caller obtains it (the
 * only path to a secret is `resolveConnectionCredential`) and hands it over.
 *
 * The **retry loop** follows the target's rule (audit §2.2): a retryable
 * status is retried up to the retry budget, a non-retryable one is returned
 * immediately, and a `401` that says the request used a cached token triggers
 * a token refresh and **one** more attempt.
 */
export async function sendProviderRequest(
  opts: TransportOptions,
  req: ProviderRequest,
  credential?: string,
): Promise<SendResult> {
  const driver = opts.driver;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('no fetch implementation is available');
  }
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetries = resolveMaxRetries(driver, opts);
  const timeoutMs = resolveTimeoutMs(req, opts);

  const rawUrl = driver.buildUrl(req, opts.baseUrl);

  let effectiveCredential = credential;
  let refreshed = false;
  let acquired = false;
  let retriesUsed = 0;

  for (;;) {
    // The retry count travels in the `x-stainless-retry-count` header
    // (audit §2.2), so the headers are built per attempt.
    req.retryCount = retriesUsed;
    let built = driver.buildBody(req, effectiveCredential);
    let headerOnly = driver.buildHeaders(req, effectiveCredential);

    // The token-acquisition seam: the driver declares the scope, the
    // transport asks for the token, and the request is rebuilt with it.
    //
    // The scope is read **after** the header step, because that is where a
    // driver may write it: a driver that declared the scope in its body step
    // alone would be read just as well, but one that declared it in its
    // header step alone would be read as *no scope at all*.
    const scope = req.tokenScope;
    if (!acquired && scope !== undefined && scope !== '' && opts.acquireToken !== undefined) {
      acquired = true;
      const token = await opts.acquireToken(scope);
      if (typeof token === 'string' && token !== '') {
        effectiveCredential = token;
        // An acquired token is a **bearer** token by construction: an Azure AD
        // or Google token must never travel as an API key, whatever the
        // caller named the credential kind.
        req.credentialKind = 'bearer';
        built = driver.buildBody(req, effectiveCredential);
        headerOnly = driver.buildHeaders(req, effectiveCredential);
      }
    }

    // The **body** step's header set is the driver's final one: the Bedrock
    // adapter *moves* the `anthropic-beta` header into the body, and the
    // header must not survive alongside the body field. A driver whose body
    // step reports no headers at all falls back to the **header** step's set.
    const driverHeaders = Object.keys(built.headers).length > 0 ? built.headers : headerOnly;

    const bodyText = serialiseBody(built.body);
    // The AWS routes send the **escaped** path: the AWS SDK escapes the
    // values of the URI template's labels when it builds the request path,
    // so the Bedrock model id travels as `…-v1%3A0` and not as `…-v1:0`.
    const requestUrl = wireUrl(rawUrl, isSigV4Request(req));
    const headers = await signedHeaders(req, requestUrl, { ...driverHeaders }, bodyText, opts);

    const response = await fetchWithTimeout(
      fetchImpl,
      requestUrl,
      { method: 'POST', headers, body: bodyText },
      timeoutMs,
      opts.signal,
    );

    const status = response.status;
    const requestId = response.headers.get('request-id') ?? undefined;
    const requestIdField = requestId !== undefined ? { requestId } : {};

    if (response.ok) {
      if (req.stream) {
        const events = await readStreamEvents(driver, response);
        return { events, response, status, ...requestIdField };
      }

      // The default `parseResponse` attaches the non-enumerable `_request_id`
      // and `_workspace_id` to a JSON body (audit §2.2), so the parsed body —
      // not a re-parse of it — is what the driver turns into events. A `204`
      // carries no body at all and the target answers it with `null`; a JSON
      // response with `content-length: 0` is answered with `undefined`. Both
      // are **no** body, and neither is an error.
      const parsed = await parseResponse(response, { stream: false });
      const events = parsed === null || parsed === undefined ? [] : driver.parseNonStreaming(parsed).events;
      return { events, response, status, body: parsed, ...requestIdField };
    }

    const text = await response.text();
    const body = tryParseJson(text);
    const classification = driver.classifyError(status, body, {
      headers: headerRecord(response.headers),
      // Once the cached token has been refreshed, the target does not retry
      // the `401` again: the condition "a cached token that has not already
      // been refreshed" is no longer true.
      ...(refreshed ? { cachedTokenRefreshed: false } : {}),
    });

    // The cached-token trigger is the **implementation's own** marker: the
    // `cached_token_refreshed` body field is a **implementation invention** — the
    // Anthropic API never sends it, so in production this branch never
    // fires on the wire. The **live** input is the caller's own knowledge of
    // the auth state (`TransportOptions.credentialIsCached`); the body flag
    // is this implementation's stand-in for it.
    const cached = cachedTokenRefreshed(body) || opts.credentialIsCached === true;
    // The `x-should-retry` header overrides in **both** directions, so a
    // response that says it must not be retried is not refreshed either.
    if (
      status === 401 &&
      !refreshed &&
      cached &&
      readShouldRetry(response.headers) !== false &&
      retriesUsed < maxRetries
    ) {
      // The cached-token `401`: refresh the credential and make **one** more
      // attempt. The refresh is the target's own path, but it is **an**
      // attempt, so it spends the retry budget like any other one.
      //
      // The target's `retryRequest` **sleeps** before the next attempt, and
      // the refresh attempt is an attempt — so this implementation waits the same way,
      // with the same delay rule (the `retry-after` header when there is
      // one, else the exponential backoff). The wait itself spends
      // **nothing**: the budget is spent by the attempt that follows it.
      const delay = retryDelayMs(retriesUsed, { status, headers: response.headers }, currentTimeMs(opts));
      await sleep(delay);
      refreshed = true;
      const fresh = await opts.refreshCredential?.({
        status,
        body,
        ...(req.tokenScope !== undefined ? { scope: req.tokenScope } : {}),
      });
      if (typeof fresh === 'string' && fresh !== '') effectiveCredential = fresh;
      retriesUsed += 1;
      continue;
    }

    if (classification.retryable && retriesUsed < maxRetries) {
      // The same wait, with the same rule: the `retry-after` header when
      // there is one, else the exponential backoff.
      const delay = retryDelayMs(retriesUsed, { status, headers: response.headers }, currentTimeMs(opts));
      retriesUsed += 1;
      await sleep(delay);
      continue;
    }

    return {
      events: [
        {
          type: 'error',
          message: classification.message,
          status,
          retryable: classification.retryable,
        },
      ],
      response,
      status,
      ...requestIdField,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* The request timeout                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The timeout a request uses, in milliseconds.
 *
 * The order is the target's: an **explicit** request timeout wins, then the
 * transport's own timeout (the client-level default), and only then the
 * request's own rule — which is the computed non-streaming timeout for a
 * **non-streaming** request and the `600000` ms fallback for a **streaming**
 * one (audit §2.2: the target computes the timeout "when the call is
 * non-streaming with no explicit timeout", and issues the request with
 * "timeout: timeout ?? 600000").
 *
 * The model limit bounds the computed non-streaming timeout from above; a
 * streaming request ignores it, because the target does not compute a
 * timeout for a streaming call at all.
 */
function resolveTimeoutMs(req: ProviderRequest, opts: TransportOptions): number {
  const explicit = req.timeout;
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) return explicit;
  const configured = opts.timeoutMs;
  if (configured !== undefined && Number.isFinite(configured) && configured > 0) return configured;
  return resolveRequestTimeout(req, opts.modelTimeoutLimit);
}

/**
 * Run a `fetch` under a timeout.
 *
 * The request runs under an `AbortController` that is **combined** with the
 * caller's own signal: an abort from either cancels the request. The timeout
 * is armed on the controller, and the call is **raced** against it, so that a
 * `fetch` that never settles still ends the request — a stalled connection
 * cannot hang a turn forever.
 *
 * A timeout raises a `ProviderTimeoutError`, which names the timeout.
 */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  outerSignal: AbortSignal | undefined,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;

  // The abort promise is armed **before** the caller's signal is wired, so
  // that a signal which is already aborted still settles the request.
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      reject(timedOut ? new ProviderTimeoutError(timeoutMs) : abortReason(outerSignal));
    };
    if (controller.signal.aborted) {
      onAbort();
      return;
    }
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  // The abort promise is only ever observed through the race below; a
  // rejection that loses the race must not become an unhandled rejection.
  void aborted.catch(() => undefined);

  const onOuterAbort = (): void => {
    controller.abort(outerSignal?.reason);
  };
  if (outerSignal !== undefined) {
    if (outerSignal.aborted) controller.abort(outerSignal.reason);
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await Promise.race([fetchImpl(url, { ...init, signal: controller.signal }), aborted]);
  } catch (error) {
    // A `fetch` that honours the signal rejects with a bare `AbortError`;
    // the timeout is the more useful failure, so it wins.
    if (timedOut) throw new ProviderTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
    if (outerSignal !== undefined) outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * The error an aborted request raises.
 *
 * The caller's own abort reason is carried through when it is an `Error`, so
 * that a caller sees the same failure it would see from a `fetch` that
 * honours the signal itself.
 */
function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string' && reason !== '') return new ProviderAbortedError(reason);
  return new ProviderAbortedError();
}

/* -------------------------------------------------------------------------- */
/* The signing                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Whether a request is signed with SigV4.
 *
 * The **driver** decides: it writes the SigV4 service name into the request's
 * signing context (`AwsRequestContext.service`), and the transport reads it
 * from there. A transport that carried the service name as a constant could
 * not tell Bedrock (`bedrock`) from Mantle (`bedrock-mantle`).
 */
function isSigV4Request(req: ProviderRequest): boolean {
  if (req.credentialKind === 'awsSigV4') return true;
  const aws = req.aws;
  if (aws === undefined) return false;
  return typeof aws.service === 'string' && aws.service !== '';
}

/**
 * The URL a request goes to, with the AWS routes' path escaped.
 *
 * The AWS SDK builds the request path by escaping the values of the URI
 * template's labels, so the path on the wire is already percent-encoded: the
 * Bedrock model id `anthropic.claude-sonnet-4-5-20250929-v1:0` travels as
 * `anthropic.claude-sonnet-4-5-20250929-v1%3A0`. The escaping is idempotent,
 * so a path that is already escaped is left alone.
 *
 * Only the **AWS** routes are escaped: the audit records the other routes'
 * paths with their own spelling (the Vertex path keeps its raw `:suffix`),
 * and the target's own path builders for those routes are not the AWS SDK's.
 */
function wireUrl(rawUrl: string, escapePath: boolean): string {
  if (!escapePath) return rawUrl;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const escaped = escapeUriPath(parsed.pathname);
  if (escaped === parsed.pathname) return rawUrl;
  parsed.pathname = escaped;
  return parsed.toString();
}

/**
 * The headers a request goes out with, signed when it has to be.
 *
 * A request that already carries a pre-computed `authorization` header is sent
 * as it is; a SigV4 request without one is signed here.
 */
async function signedHeaders(
  req: ProviderRequest,
  requestUrl: string,
  headers: Record<string, string>,
  body: string | undefined,
  opts: TransportOptions,
): Promise<Record<string, string>> {
  if (!isSigV4Request(req)) return headers;
  const aws = req.aws;
  if (aws === undefined) {
    throw new Error(`the request needs an AWS signing context, and it has none (model: ${req.model})`);
  }
  if (typeof aws.authorization === 'string' && aws.authorization !== '') {
    // The request is already signed: the pre-computed header wins.
    return headers;
  }
  const service = aws.service;
  if (typeof service !== 'string' || service === '') {
    throw new Error(`the request declares no SigV4 service name (model: ${req.model})`);
  }
  const region = aws.region;
  if (typeof region !== 'string' || region === '') {
    throw new Error(`the request declares no AWS region (model: ${req.model})`);
  }
  const credentials = opts.awsCredentials;
  if (credentials === undefined) {
    throw new Error(`the request needs AWS credentials to be signed, and none were supplied (model: ${req.model})`);
  }
  const sessionToken = aws.sessionToken ?? credentials.sessionToken;
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    // The URL never carries a credential — the transport never puts one
    // there — so naming it leaks nothing.
    throw new Error(`the driver built a URL that cannot be parsed: ${requestUrl}`);
  }
  const date = requestDate(req, opts);
  return buildSignedHeaders({
    method: 'POST',
    url,
    headers,
    ...(body !== undefined ? { body } : {}),
    service,
    region,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    ...(sessionToken !== undefined ? { sessionToken } : {}),
    ...(date !== undefined ? { date } : {}),
  });
}

/**
 * The moment a request is signed at.
 *
 * The request's own `x-amz-date` wins — the driver may have put one there —
 * and the transport's clock answers otherwise.
 */
function requestDate(req: ProviderRequest, opts: TransportOptions): Date | undefined {
  const declared = req.aws?.date;
  if (typeof declared === 'string' && declared !== '') {
    const parsed = parseAmzDate(declared);
    if (parsed !== undefined) return parsed;
  }
  const now = opts.now;
  if (now === undefined) return undefined;
  return new Date(now());
}

/**
 * The number of retries a request gets.
 *
 * The order is the plan's: the **driver's** own budget wins, then the
 * transport's option, then the default of two retries.
 */
function resolveMaxRetries(driver: ProviderDriver, opts: TransportOptions): number {
  const declared = driver.maxRetries;
  if (typeof declared === 'number' && Number.isFinite(declared) && declared >= 0) {
    return Math.floor(declared);
  }
  const explicit = opts.maxRetries;
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 0) {
    return Math.floor(explicit);
  }
  return DEFAULT_MAX_RETRIES;
}

/** The default sleep between two attempts. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The current time, in milliseconds since the epoch.
 *
 * The transport's own clock answers when it has one; the wall clock answers
 * otherwise.
 */
function currentTimeMs(opts: TransportOptions): number {
  const now = opts.now;
  return now === undefined ? Date.now() : now();
}

/**
 * Serialise a driver's body for the wire.
 *
 * A body that is already a string is sent as it is; anything else is JSON.
 * A body that is `undefined` is sent as no body at all.
 */
function serialiseBody(body: unknown): string | undefined {
  if (body === undefined) return undefined;
  if (typeof body === 'string') return body;
  return JSON.stringify(body);
}

/**
 * Parse a body that is probably JSON, falling back to the text.
 */
function tryParseJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * The response headers as a plain record.
 *
 * The names are lowercased, and the record is **own-property only** — a
 * header name is caller-supplied data, so a lookup must never resolve an
 * inherited `Object.prototype` member.
 */
function headerRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of headers.entries()) {
    record[key.toLowerCase()] = value;
  }
  return record;
}

/**
 * Read a streaming response through the driver's `parseStream`.
 *
 * The body is read **incrementally**, so a frame that straddles two chunks is
 * not lost: the driver's parse state carries the remainder. A response whose
 * content type is a binary one (the Bedrock eventstream, for instance) is
 * decoded as **latin1**, so that every byte round-trips; a textual response is
 * decoded as UTF-8.
 */
async function readStreamEvents(driver: ProviderDriver, response: Response): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  const body = response.body;

  if (body === null || typeof body.getReader !== 'function') {
    // A response without a readable body is read whole.
    const text = await response.text();
    const parsed = driver.parseStream(text, undefined);
    return [...parsed.events];
  }

  const binary = isBinaryContentType(response.headers.get('content-type'));
  const decoder = binary ? undefined : new TextDecoder('utf-8');
  const reader = body.getReader();
  let state: unknown = undefined;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    const chunk = binary ? latin1Of(value) : (decoder?.decode(value, { stream: true }) ?? '');
    const parsed = driver.parseStream(chunk, state);
    state = parsed.state;
    events.push(...parsed.events);
  }

  if (!binary && decoder !== undefined) {
    const tail = decoder.decode();
    if (tail !== '') {
      const parsed = driver.parseStream(tail, state);
      events.push(...parsed.events);
    }
  }

  return events;
}

/**
 * Whether a content type is a binary one.
 *
 * The Bedrock streaming response is an `application/vnd.amazon.eventstream`
 * whose frames carry **bytes**, not text (audit §2.2a).
 */
function isBinaryContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const media = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (media === '') return false;
  return !media.startsWith('text/') && media !== 'application/json' && !media.endsWith('+json');
}

/** The latin1 text of a byte buffer: one character per byte. */
function latin1Of(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

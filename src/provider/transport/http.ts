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
 */

import {
  cachedTokenRefreshed,
  parseResponse,
  type ProviderDriver,
  type ProviderEvent,
  type ProviderRequest,
} from '../drivers/types.js';
import { DEFAULT_MAX_RETRIES, readShouldRetry, retryDelayMs } from './retry.js';
import { buildSignedHeaders } from './sigv4.js';

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
/* The transport's options                                                      */
/* -------------------------------------------------------------------------- */

/**
 * How a request is sent.
 *
 * The plan fixes the first four members. The rest are **additive optional**
 * members, so a plan-conforming consumer keeps type-checking.
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
   * may declare its own budget, and this member overrides it. When neither
   * says, the default is two retries.
   */
  maxRetries?: number;
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
   * the response used a cached token that has not already been refreshed".
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
   * This implementation's wire-visible marker for the target's condition is the
   * `cached_token_refreshed` flag in the error body; a caller that knows the
   * fact from its own auth state declares it here.
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
   * The acquired token is a **bearer** token: a request that does not name a
   * credential kind of its own is switched to the bearer kind, so that the
   * Azure AD token is not sent as an API key.
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

  const requestUrl = driver.buildUrl(req, opts.baseUrl);

  let effectiveCredential = credential;
  let refreshed = false;
  let acquired = false;
  let attempt = 0;
  let retriesUsed = 0;

  for (;;) {
    // The retry count travels in the `x-stainless-retry-count` header
    // (audit §2.2), so the headers are built per attempt.
    req.retryCount = attempt;
    let built = driver.buildBody(req, effectiveCredential);

    // The token-acquisition seam: the driver declares the scope, the
    // transport asks for the token, and the request is rebuilt with it.
    const scope = req.tokenScope;
    if (!acquired && scope !== undefined && scope !== '' && opts.acquireToken !== undefined) {
      acquired = true;
      const token = await opts.acquireToken(scope);
      if (typeof token === 'string' && token !== '') {
        effectiveCredential = token;
        if (req.credentialKind === undefined) req.credentialKind = 'bearer';
        built = driver.buildBody(req, effectiveCredential);
      }
    }

    // The **body** step's header set is the driver's final one: the Bedrock
    // adapter *moves* the `anthropic-beta` header into the body, and the
    // header must not survive alongside the body field. A driver whose body
    // step reports no headers at all falls back to the **header** step's set.
    const headerOnly = driver.buildHeaders(req, effectiveCredential);
    const driverHeaders = Object.keys(built.headers).length > 0 ? built.headers : headerOnly;

    const bodyText = serialiseBody(built.body);
    const headers = await signedHeaders(req, requestUrl, { ...driverHeaders }, bodyText, opts);

    const response = await fetchImpl(requestUrl, {
      method: 'POST',
      headers,
      body: bodyText,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

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
      // carries no body at all, and the target answers it with `null`.
      const parsed = await parseResponse(response, { stream: false });
      const { events } = parsed === null ? { events: [] } : driver.parseNonStreaming(parsed);
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

    const cached = cachedTokenRefreshed(body) || opts.credentialIsCached === true;
    // The `x-should-retry` header overrides in **both** directions, so a
    // response that says it must not be retried is not refreshed either.
    if (status === 401 && !refreshed && cached && readShouldRetry(response.headers) !== false) {
      // The cached-token `401`: refresh the credential and make **one** more
      // attempt. The refresh does not consume the retry budget — it is the
      // target's own separate path.
      refreshed = true;
      const fresh = await opts.refreshCredential?.({
        status,
        body,
        ...(req.tokenScope !== undefined ? { scope: req.tokenScope } : {}),
      });
      if (typeof fresh === 'string' && fresh !== '') effectiveCredential = fresh;
      attempt += 1;
      continue;
    }

    if (classification.retryable && retriesUsed < maxRetries) {
      retriesUsed += 1;
      await sleep(retryDelayMs(retriesUsed - 1, { status, headers: response.headers }));
      attempt += 1;
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
    throw new Error('the request needs an AWS signing context, and it has none');
  }
  if (typeof aws.authorization === 'string' && aws.authorization !== '') {
    // The request is already signed: the pre-computed header wins.
    return headers;
  }
  const service = aws.service;
  if (typeof service !== 'string' || service === '') {
    throw new Error('the request declares no SigV4 service name');
  }
  const region = aws.region;
  if (typeof region !== 'string' || region === '') {
    throw new Error('the request declares no AWS region');
  }
  const credentials = opts.awsCredentials;
  if (credentials === undefined) {
    throw new Error('the request needs AWS credentials to be signed, and none were supplied');
  }
  const sessionToken = aws.sessionToken ?? credentials.sessionToken;
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    throw new Error('the driver built a URL that cannot be parsed');
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
    const parsed = Date.parse(declared);
    if (!Number.isNaN(parsed)) return new Date(parsed);
  }
  const now = opts.now;
  if (now === undefined) return undefined;
  return new Date(now());
}

/**
 * The number of retries a request gets.
 *
 * The caller's own `maxRetries` wins; a driver that declares one is the
 * fallback; the default is two retries.
 */
function resolveMaxRetries(driver: ProviderDriver, opts: TransportOptions): number {
  const explicit = opts.maxRetries;
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 0) {
    return Math.floor(explicit);
  }
  const declared = driverMaxRetries(driver);
  if (declared !== undefined) return declared;
  return DEFAULT_MAX_RETRIES;
}

/**
 * The retry budget a driver declares.
 *
 * The driver interface does not carry a `maxRetries` member, so the lookup is
 * **own-property only**: a driver that inherits one from its prototype does
 * not get it read as its own.
 */
function driverMaxRetries(driver: ProviderDriver): number | undefined {
  if (!Object.hasOwn(driver, 'maxRetries')) return undefined;
  const value = (driver as ProviderDriver & { maxRetries?: unknown }).maxRetries;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

/** The default sleep between two attempts. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

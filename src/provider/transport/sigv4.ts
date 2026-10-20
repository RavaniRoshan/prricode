/**
 * The AWS SigV4 signer.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.2a — "Auth is
 * SigV4 with service `bedrock`, region `awsRegion`, and the `host` header
 * replaced by the URL's host, the `connection` header deleted, and multi-valued
 * query parameters preserved" (and the Mantle service name `bedrock-mantle`).
 *
 * ## Why the transport signs and the driver does not
 *
 * This implementation ships no AWS credential chain, so the **driver** owns the request's
 * *shape* and the **transport** owns the signature. Two things therefore
 * travel on the request (`ProviderRequest.aws`, an `AwsRequestContext`):
 *
 *   - the **service name** — `bedrock` for Bedrock, `bedrock-mantle` for
 *     Mantle. A transport cannot learn it from the URL, and the signer must
 *     not carry it as a constant;
 *   - the **region** — the `awsRegion` the client was built with.
 *
 * ## The three observed rules
 *
 *   - the `host` header is **replaced** with the URL's host;
 *   - the `connection` header is **deleted**;
 *   - the **multi-valued** query parameters are **preserved byte for byte** —
 *     every occurrence of a repeated parameter survives, and the query that is
 *     signed is the query that is sent.
 *
 * ## Which reference this implementation follows: the SDK, not the test suite
 *
 * The SigV4 **specification** says that every path segment must be
 * URI-encoded **twice** (except for Amazon S3), and the AWS SDK the target
 * runs — `@smithy/signature-v4` — implements exactly that. Its
 * `getCanonicalPath` normalises the path (dropping the empty segments, `.`
 * and `..`), escapes the **already-encoded** path a **second** time, and
 * restores `%2F` to `/`.
 *
 * The AWS **test suite** (the `.creq` files) encodes the path **once**. The
 * suite is the older reference; this implementation follows the **SDK**, because the
 * SDK is what the target runs. The observable difference is the Bedrock
 * route: the target sends the request target `/model/…-v1%3A0/invoke` and
 * signs the canonical URI `/model/…-v1%253A0/invoke`, while a single-encoded
 * signer signs `/model/…-v1%3A0/invoke` — a different signature **and** a
 * different request line.
 *
 * **What is observed and what is a implementation choice**
 *
 * Observed: the three rules above, and that the signature covers the method,
 * the path, the query, the headers and the body.
 *
 * Implementation choices (the audit does not pin them, so they are marked as such):
 *
 *   - the **canonical URI** follows the **SDK's double encoding** of the
 *     encoded path (see above) — this implementation follows the SDK rather than the
 *     test suite, and says so;
 *   - the **canonical query** is the query decoded and re-encoded with the
 *     same rules and sorted by the **encoded** name and then by the encoded
 *     value, as the SDK does;
 *   - the **unsignable headers** are the SDK's always-unsignable list
 *     (`authorization`, `cache-control`, `connection`, `user-agent`,
 *     `expect`, `pragma`, …) plus the SDK's `proxy-*` and `sec-*` patterns;
 *   - the **header values** are normalised the SDK's way: a CR or an LF
 *     becomes a space, a run of spaces or tabs collapses to one space, and
 *     the value is trimmed;
 *   - the **`x-amz-content-sha256` header is not sent**, and therefore not
 *     signed. The SDK's `applyChecksum` defaults to **true**, so the target's
 *     Bedrock requests carry the header and sign it: the target's
 *     `SignedHeaders` lists `x-amz-content-sha256`, and its signature
 *     therefore differs from this implementation's. The omission is harmless — AWS
 *     recomputes the canonical request from what it received, and Bedrock
 *     does not require the header — but the **signed-header set** differs
 *     from the target's on the Bedrock route, and this implementation says so rather
 *     than leaving the difference implicit;
 *   - the **wire path** is escaped **per segment**, and each segment is
 *     **decoded** before it is encoded again. The SDK escapes the **value of
 *     a URI-template label** — so a raw `%2F` travels as `%252F` and a raw
 *     `/` as `%2F` — while this implementation escapes the **path**, which it cannot
 *     split into labels and literals. The decoding is what makes the
 *     escaping idempotent, so a driver that escaped its own label is never
 *     encoded twice. The divergence is therefore confined to a label that
 *     carries a literal `%` or a `/`; a Bedrock model id carries neither.
 */

import { createHash, createHmac } from 'node:crypto';

import { hostOf } from '../drivers/types.js';

/* -------------------------------------------------------------------------- */
/* The input                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What a signed request is built from.
 *
 * The plan fixes these members exactly.
 */
export interface SigV4Input {
  /** The HTTP method. */
  method: string;
  /** The request URL. */
  url: URL;
  /** The headers the driver built. */
  headers: Record<string, string>;
  /** The request body, as it is sent. */
  body?: string;
  /** The SigV4 service name — the one the **driver** wrote. */
  service: string;
  /** The AWS region. */
  region: string;
  /** The AWS access key id. */
  accessKeyId: string;
  /** The AWS secret access key. */
  secretAccessKey: string;
  /** The AWS session token, when the credential chain supplied one. */
  sessionToken?: string;
  /** The timestamp of the signature. Defaults to now. */
  date?: Date;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                    */
/* -------------------------------------------------------------------------- */

/** The SigV4 algorithm. */
export const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256';

/** The header that carries the signature. */
export const AUTHORIZATION_HEADER = 'authorization';

/** The header that carries the timestamp. */
export const AMZ_DATE_HEADER = 'x-amz-date';

/** The header that carries the session token. */
export const AMZ_SECURITY_TOKEN_HEADER = 'x-amz-security-token';

/** The header that carries the request's host. */
export const HOST_HEADER = 'host';

/** The header the SigV4 rules delete. */
export const CONNECTION_HEADER = 'connection';

/**
 * The headers the AWS SDK never signs.
 *
 * The list is the SDK's always-unsignable set. `authorization` and
 * `connection` are handled separately (the first is replaced, the second is
 * deleted), and the rest are excluded from the signature.
 */
export const UNSIGNABLE_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'cache-control',
  'connection',
  'expect',
  'from',
  'keep-alive',
  'max-forwards',
  'pragma',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'x-amzn-trace-id',
]);

/**
 * The SDK's pattern for the headers that are never signed because they
 * belong to a proxy.
 */
export const PROXY_HEADER_PATTERN = /^proxy-/;

/**
 * The SDK's pattern for the headers that are never signed because they
 * belong to the browser's own security machinery.
 */
export const SEC_HEADER_PATTERN = /^sec-/;

/* -------------------------------------------------------------------------- */
/* The canonical request                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The canonical request of a signed request, in its parts.
 *
 * The parts are exposed so that a test can pin the **canonical request
 * string** itself and not only the signature that comes out of it: a signer
 * with a wrong canonicalisation produces a different string, and the string
 * is where the difference is visible.
 */
export interface CanonicalRequest {
  /** The HTTP method, upper-cased. */
  method: string;
  /** The canonical URI — the path, encoded twice. */
  canonicalUri: string;
  /** The canonical query string. */
  canonicalQuery: string;
  /** The canonical headers block; every line ends with a newline. */
  canonicalHeaders: string;
  /** The names of the signed headers, sorted and `;`-joined. */
  signedHeaders: string;
  /** The hex-encoded SHA-256 of the payload. */
  payloadHash: string;
  /** The canonical request itself. */
  canonicalRequest: string;
}

/* -------------------------------------------------------------------------- */
/* The signer                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Sign a request and return the headers that carry the signature.
 *
 * The returned header set is the input's, with the `host` header **replaced**
 * by the URL's host, the `connection` header **deleted**, the `x-amz-date` and
 * (when there is one) the `x-amz-security-token` header added, and the
 * `authorization` header carrying the SigV4 signature.
 *
 * The header bag is a **null-prototype** object: a header name is
 * caller-supplied data, so a header literally called `__proto__` must not
 * vanish into the prototype chain.
 */
export async function buildSignedHeaders(input: SigV4Input): Promise<Record<string, string>> {
  const date = input.date ?? new Date();
  const amzDate = formatAmzDate(date);
  const stamp = formatDateStamp(date);

  const headers = signingHeaders(input, amzDate);
  const canonical = buildCanonicalRequestFor(input, headers);

  const scope = signingScope(stamp, input.region, input.service);
  const stringToSign = [SIGV4_ALGORITHM, amzDate, scope, sha256Hex(canonical.canonicalRequest)].join('\n');
  const key = signingKey(input.secretAccessKey, stamp, input.region, input.service);
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');

  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of headers) result[name] = value;
  result[AUTHORIZATION_HEADER] =
    `${SIGV4_ALGORITHM} Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${canonical.signedHeaders}, Signature=${signature}`;
  return result;
}

/**
 * The canonical request of a request, in its parts.
 *
 * The function is the signer's own view of the request: it is what the
 * signature is computed over, so a test can compare it with the reference
 * implementation's canonical request.
 */
export function buildCanonicalRequest(input: SigV4Input): CanonicalRequest {
  const date = input.date ?? new Date();
  return buildCanonicalRequestFor(input, signingHeaders(input, formatAmzDate(date)));
}

/**
 * The headers that take part in the signature, with the SigV4 mutations
 * applied.
 *
 * The `host` header is **replaced** by the URL's host, the `connection`
 * header is **deleted**, the `authorization` header is the signature itself,
 * and the `x-amz-date` and (when there is one) the `x-amz-security-token`
 * headers are added.
 */
function signingHeaders(input: SigV4Input, amzDate: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(input.headers)) {
    const key = name.toLowerCase();
    // The `connection` header is deleted and the `host` header is replaced;
    // the `authorization` header is the signature itself.
    if (key === CONNECTION_HEADER || key === HOST_HEADER || key === AUTHORIZATION_HEADER) continue;
    headers.set(key, value);
  }
  headers.set(HOST_HEADER, hostOf(input.url.toString()));
  headers.set(AMZ_DATE_HEADER, amzDate);
  if (typeof input.sessionToken === 'string' && input.sessionToken !== '') {
    headers.set(AMZ_SECURITY_TOKEN_HEADER, input.sessionToken);
  }
  return headers;
}

/**
 * The canonical request of a request, computed over a header set.
 */
function buildCanonicalRequestFor(input: SigV4Input, headers: Map<string, string>): CanonicalRequest {
  const canonical = canonicalHeaders(headers);
  const signedHeaderNames = canonical.map(([name]) => name).join(';');
  const method = input.method.toUpperCase();
  const canonicalUri = canonicalUriPath(input.url);
  const canonicalQuery = canonicalQueryString(input.url);
  const canonicalHeaderBlock = canonical.map(([name, value]) => `${name}:${value}\n`).join('');
  const payloadHash = sha256Hex(input.body ?? '');
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaderBlock,
    signedHeaderNames,
    payloadHash,
  ].join('\n');

  return {
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders: canonicalHeaderBlock,
    signedHeaders: signedHeaderNames,
    payloadHash,
    canonicalRequest,
  };
}

/**
 * The headers that take part in the signature, sorted by name.
 *
 * The value is normalised the SDK's way: a CR or an LF becomes a space, a run
 * of spaces or tabs collapses to a **single** space, and the value is
 * trimmed. (The suite's `get-header-value-trim` vector is the reference: the
 * value `"a   b   c"` is signed as `"a b c"`.)
 */
function canonicalHeaders(headers: Map<string, string>): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const [name, value] of headers) {
    if (isUnsignable(name)) continue;
    entries.push([name, normaliseHeaderValue(value)]);
  }
  entries.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return entries;
}

/**
 * Whether a header is one the SDK never signs.
 */
function isUnsignable(name: string): boolean {
  return (
    UNSIGNABLE_HEADERS.has(name) ||
    PROXY_HEADER_PATTERN.test(name) ||
    SEC_HEADER_PATTERN.test(name)
  );
}

/**
 * Normalise a header value the SDK's way.
 *
 * The order matters: the line breaks become spaces **first**, so that a
 * folded value collapses like any other run of whitespace.
 */
export function normaliseHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, ' ').replace(/[ \t]+/g, ' ').replace(/^ | $/g, '');
}

/* -------------------------------------------------------------------------- */
/* The canonical URI                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The canonical URI of a request: its path, encoded **twice**.
 *
 * The rule is the AWS SDK's (`@smithy/signature-v4`'s `getCanonicalPath`),
 * which is what the target runs:
 *
 *   1. the path is **normalised** — the empty segments, `.` and `..` are
 *      dropped, and a `..` pops the segment before it;
 *   2. the path is **escaped** — and the path that is escaped is the
 *      **already-encoded** one (the wire path), so the encoding happens
 *      twice: the SigV4 specification's rule, and the SDK's;
 *   3. the `%2F` sequences are restored to `/`, so that the separators
 *      survive the second encoding.
 *
 * **Implementation choice.** This implementation follows the SDK rather than the AWS test
 * suite, whose `.creq` files encode the path only once. The difference is
 * visible on the Bedrock route: the canonical URI of
 * `/model/anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke` is
 * `/model/anthropic.claude-sonnet-4-5-20250929-v1%253A0/invoke`.
 */
export function canonicalUriPath(url: URL): string {
  const path = url.pathname === '' ? '/' : url.pathname;
  const normalised = normalisePath(path);
  return escapeUri(normalised).replace(/%2F/g, '/');
}

/**
 * The **wire** path of a request: its path, encoded once.
 *
 * The AWS SDK builds the request path by escaping the values of the URI
 * template's labels (`extendedEncodeURIComponent`), so the path that goes on
 * the wire is already percent-encoded — the Bedrock model id
 * `anthropic.claude-sonnet-4-5-20250929-v1:0` travels as
 * `anthropic.claude-sonnet-4-5-20250929-v1%3A0`.
 *
 * The encoding is **idempotent**: a path that is already encoded is left
 * alone, so the transport may apply it to a path that came from a driver
 * without knowing whether that driver escaped its own labels.
 *
 * **Divergence from the SDK** (a implementation choice, and a deliberate one). The SDK
 * escapes the **value of a label**, so a raw `%2F` travels as `%252F` and a
 * raw `/` travels as `%2F`. This implementation escapes the **path** — a transport
 * cannot know which parts of a path are labels and which are literals — and
 * it **decodes** each segment first, which is what keeps the escaping
 * idempotent. So a label that carries a literal `%` or a `/` is escaped
 * differently: this implementation sends `%2F` where the SDK sends `%252F`, and a `/`
 * in a label stays a separator where the SDK sends `%2F`. A Bedrock model id
 * carries neither, so the difference never shows on the route that matters.
 */
export function escapeUriPath(path: string): string {
  return path
    .split('/')
    .map((segment) => escapeUri(uriDecode(segment)))
    .join('/');
}

/**
 * Normalise a path the SDK's way.
 *
 * The empty segments, `.` and `..` are dropped, and a `..` pops the segment
 * before it. A leading `/` and a trailing `/` survive.
 */
export function normalisePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment.length === 0) continue;
    if (segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const prefix = path.startsWith('/') ? '/' : '';
  const suffix = segments.length > 0 && path.endsWith('/') ? '/' : '';
  return `${prefix}${segments.join('/')}${suffix}`;
}

/* -------------------------------------------------------------------------- */
/* The canonical query                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The canonical query string of a request.
 *
 * The query is **not** re-serialised through a `URLSearchParams`: a round trip
 * would rewrite `%20` as `+` and could drop a repeated parameter. Every
 * occurrence of every parameter is kept — the multi-valued parameters
 * survive **byte for byte** — and the pairs are sorted by the **encoded**
 * name and then by the encoded value, as the SigV4 specification requires.
 *
 * The sort key is the **encoded** name, because that is what the AWS SDK
 * sorts (`getCanonicalQuery` sorts `escapeUri(key)`): the two orders differ
 * for the names whose encoded and decoded spellings sort differently.
 */
export function canonicalQueryString(url: URL): string {
  const raw = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  if (raw === '') return '';

  const pairs: Array<{ name: string; value: string }> = [];
  for (const pair of raw.split('&')) {
    if (pair === '') continue;
    const equals = pair.indexOf('=');
    const name = equals === -1 ? pair : pair.slice(0, equals);
    const value = equals === -1 ? '' : pair.slice(equals + 1);
    pairs.push({ name: escapeUri(uriDecode(name)), value: escapeUri(uriDecode(value)) });
  }

  pairs.sort((left, right) => {
    if (left.name !== right.name) return left.name < right.name ? -1 : 1;
    if (left.value === right.value) return 0;
    return left.value < right.value ? -1 : 1;
  });

  return pairs.map((pair) => `${pair.name}=${pair.value}`).join('&');
}

/* -------------------------------------------------------------------------- */
/* The signature                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The `x-amz-date` value of a moment: `YYYYMMDDTHHMMSSZ`.
 */
export function formatAmzDate(date: Date): string {
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());
  return `${formatDateStamp(date)}T${hours}${minutes}${seconds}Z`;
}

/**
 * The date stamp of a moment: `YYYYMMDD`.
 */
export function formatDateStamp(date: Date): string {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

/**
 * Parse an `x-amz-date` value into the moment it names.
 *
 * The AWS format is the **basic** ISO 8601 one — `YYYYMMDDTHHMMSSZ` — and
 * `Date.parse` does not read it. The extended spelling
 * (`2026-01-02T03:04:05Z`) and any other date `Date.parse` understands are
 * accepted too.
 *
 * The value is `undefined` when it names no moment at all.
 */
export function parseAmzDate(value: string): Date | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (match !== null) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    if (![year, month, day, hour, minute, second].every((part) => Number.isFinite(part))) return undefined;
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed);
}

/**
 * The credential scope of a signature: `<date>/<region>/<service>/aws4_request`.
 */
export function signingScope(stamp: string, region: string, service: string): string {
  return `${stamp}/${region}/${service}/aws4_request`;
}

/**
 * The signing key of a request.
 */
export function signingKey(secretAccessKey: string, stamp: string, region: string, service: string): Buffer {
  const kDate = createHmac('sha256', `AWS4${secretAccessKey}`).update(stamp, 'utf8').digest();
  const kRegion = createHmac('sha256', kDate).update(region, 'utf8').digest();
  const kService = createHmac('sha256', kRegion).update(service, 'utf8').digest();
  return createHmac('sha256', kService).update('aws4_request', 'utf8').digest();
}

/**
 * The hex-encoded SHA-256 of a payload.
 */
export function sha256Hex(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/* -------------------------------------------------------------------------- */
/* The escaping rules                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Percent-decode a value, leaving it alone when it is not decodable.
 *
 * A `+` is **not** a space here: the SigV4 rules work on the RFC 3986
 * spelling, where a `+` is a literal plus.
 */
function uriDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Percent-encode a value with the SigV4 escaping rules.
 *
 * The unreserved characters survive; everything else — including `!`, `'`,
 * `(`, `)` and `*`, which `encodeURIComponent` leaves alone — is encoded.
 *
 * This is the AWS SDK's `escapeUri`, byte for byte.
 */
export function escapeUri(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** A two-digit number. */
function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

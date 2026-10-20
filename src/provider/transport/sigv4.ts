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
 * ## What is observed and what is a implementation choice
 *
 * Observed: the three rules above, and that the signature covers the method,
 * the path, the query, the headers and the body.
 *
 * Implementation choices (the audit does not pin them, so they are marked as such):
 *
 *   - the **canonical URI** is the path encoded **once**, with the SigV4
 *     escaping rules (the unreserved characters survive, everything else is
 *     percent-encoded) and the path segments kept apart;
 *   - the **canonical query** is the query decoded and re-encoded with the
 *     same rules, sorted by name and then by value, as the SigV4
 *     specification requires;
 *   - the **unsignable headers** are the AWS SDK's always-unsignable list
 *     (`authorization`, `connection`, `user-agent`, `expect`, …);
 *   - the **header values** are trimmed, and the internal whitespace of a
 *     value is left alone.
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
  'connection',
  'expect',
  'from',
  'keep-alive',
  'max-forwards',
  'proxy-authorization',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'x-amzn-trace-id',
]);

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
 */
export async function buildSignedHeaders(input: SigV4Input): Promise<Record<string, string>> {
  const date = input.date ?? new Date();
  const amzDate = formatAmzDate(date);
  const stamp = formatDateStamp(date);

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

  const canonical = canonicalHeaders(headers);
  const signedHeaderNames = canonical.map(([name]) => name).join(';');
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUriPath(input.url),
    canonicalQueryString(input.url),
    canonical.map(([name, value]) => `${name}:${value.trim()}\n`).join(''),
    signedHeaderNames,
    sha256Hex(input.body ?? ''),
  ].join('\n');

  const scope = signingScope(stamp, input.region, input.service);
  const stringToSign = [SIGV4_ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = signingKey(input.secretAccessKey, stamp, input.region, input.service);
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');

  const result: Record<string, string> = {};
  for (const [name, value] of headers) result[name] = value;
  result[AUTHORIZATION_HEADER] =
    `${SIGV4_ALGORITHM} Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaderNames}, Signature=${signature}`;
  return result;
}

/* -------------------------------------------------------------------------- */
/* The canonical request                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The headers that take part in the signature, sorted by name.
 */
function canonicalHeaders(headers: Map<string, string>): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const [name, value] of headers) {
    if (UNSIGNABLE_HEADERS.has(name)) continue;
    entries.push([name, value]);
  }
  entries.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return entries;
}

/**
 * The canonical URI of a request: its path, encoded once.
 *
 * The path segments are kept apart, and every segment is percent-encoded with
 * the SigV4 escaping rules — the unreserved characters (`A-Z`, `a-z`, `0-9`,
 * `-`, `_`, `.`, `~`) survive, everything else does not.
 */
export function canonicalUriPath(url: URL): string {
  const path = url.pathname === '' ? '/' : url.pathname;
  return path
    .split('/')
    .map((segment) => uriEscape(uriDecode(segment)))
    .join('/');
}

/**
 * The canonical query string of a request.
 *
 * The query is **not** re-serialised through a `URLSearchParams`: a round trip
 * would rewrite `%20` as `+` and could drop a repeated parameter. Every
 * occurrence of every parameter is kept — the multi-valued parameters
 * survive **byte for byte** — and the pairs are sorted by name and then by
 * value, as the SigV4 specification requires.
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
    pairs.push({ name: uriDecode(name), value: uriDecode(value) });
  }

  pairs.sort((left, right) => {
    if (left.name !== right.name) return left.name < right.name ? -1 : 1;
    if (left.value === right.value) return 0;
    return left.value < right.value ? -1 : 1;
  });

  return pairs.map((pair) => `${uriEscape(pair.name)}=${uriEscape(pair.value)}`).join('&');
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
 */
function uriEscape(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** A two-digit number. */
function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

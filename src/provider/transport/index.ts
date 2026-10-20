/**
 * The provider transport's public surface.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.2 (Provider request
 * construction) and §2.2a (the provider adapters' wire shapes).
 *
 * The transport is the **consumer** the `CC-006` drivers were written for: it
 * turns a driver's request into a `fetch` call and the response back into the
 * implementation's `ProviderEvent`s. The three modules behind it each own one
 * responsibility:
 *
 *   - `http.ts` — the transport itself: the request, the `fetch`, the response
 *     parsing and the retry loop;
 *   - `retry.ts` — the retry rule and the delay;
 *   - `sigv4.ts` — the AWS SigV4 signer.
 *
 * ## The two seams the transport owns
 *
 *   - the **token-acquisition seam** — `TransportOptions.acquireToken`: the
 *     transport asks for the bearer token a request needs, and the **scope** it
 *     hands over is the one the *driver* wrote into the request
 *     (`ProviderRequest.tokenScope`), so the scope is a live input rather than
 *     a constant. The transport never performs the acquisition itself: it
 *     cannot read an environment variable, a file or a keychain.
 *   - the **signing seam** — `TransportOptions.awsCredentials`: the transport
 *     signs a SigV4 request with the service name the *driver* wrote
 *     (`AwsRequestContext.service`), so Bedrock (`bedrock`) and Mantle
 *     (`bedrock-mantle`) are told apart by the request, not by a constant in
 *     the transport.
 *
 * ## The timeout the transport applies
 *
 * The order is the target's (audit §2.2): an **explicit** request timeout
 * wins, then the **client-level** timeout (`TransportOptions.timeoutMs`), and
 * only then the request's own rule — the **computed non-streaming** timeout
 * for a non-streaming request, and the target's `600000` ms fallback for a
 * **streaming** one. The computed timeout belongs to a non-streaming call
 * only: the target computes it "when the call is non-streaming with no
 * explicit timeout" and issues the request with "timeout: timeout ?? 600000".
 * A turn is a streaming request, so a default turn is bounded by the
 * `600000` ms fallback and not by the computed value.
 */

import type { TokenAcquirer } from './http.js';

export { ProviderAbortedError, ProviderTimeoutError, sendProviderRequest } from './http.js';
export type { SendResult, TokenAcquirer, TransportOptions } from './http.js';
export {
  DEFAULT_MAX_RETRIES,
  RETRY_AFTER_HEADER,
  RETRY_AFTER_MAX_DELAY_MS,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  SHOULD_RETRY_HEADER,
  backoffMs,
  parseRetryAfter,
  readShouldRetry,
  retryDelayMs,
} from './retry.js';
export type { RetryResponseLike } from './retry.js';
export {
  AMZ_DATE_HEADER,
  AMZ_SECURITY_TOKEN_HEADER,
  AUTHORIZATION_HEADER,
  CONNECTION_HEADER,
  HOST_HEADER,
  PROXY_HEADER_PATTERN,
  SEC_HEADER_PATTERN,
  SIGV4_ALGORITHM,
  UNSIGNABLE_HEADERS,
  buildCanonicalRequest,
  buildSignedHeaders,
  canonicalQueryString,
  canonicalUriPath,
  escapeUri,
  escapeUriPath,
  formatAmzDate,
  formatDateStamp,
  normaliseHeaderValue,
  normalisePath,
  parseAmzDate,
  sha256Hex,
  signingKey,
  signingScope,
} from './sigv4.js';
export type { CanonicalRequest, SigV4Input } from './sigv4.js';

/* -------------------------------------------------------------------------- */
/* The token-acquisition seam                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build a token acquirer from a table of **scope → token**.
 *
 * The scope the transport hands over is the one the **driver** wrote into the
 * request, so a table keyed by scope is a complete token source for the
 * implementation's token routes.
 *
 * The lookup is an **own-property** check: a scope is caller-supplied data,
 * and `Object.prototype` carries members called `constructor`, `toString` and
 * `hasOwnProperty`. A scope that is not in the table yields **no token** —
 * never an inherited member.
 */
export function tokenAcquirerFor(tokens: Readonly<Record<string, string>>): TokenAcquirer {
  return (scope: string): string | undefined => {
    if (!Object.hasOwn(tokens, scope)) return undefined;
    const token = tokens[scope];
    return typeof token === 'string' && token !== '' ? token : undefined;
  };
}

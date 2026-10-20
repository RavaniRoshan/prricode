/**
 * The four fetch variants.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("MCP, plugins, and
 * hooks" — "MCP transport"), and the `CC-011` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * This module owns **one** responsibility: the four ways this implementation reaches an
 * MCP endpoint over HTTP, and the headers each of them presents.
 *
 * The four variants are:
 *
 *   1. the **vendor's first-party proxy** — the request is routed through the proxy, and
 *      the caller's own credentials are **not** forwarded to the proxy host;
 *   2. the **first-party API** — the request goes to the endpoint as it is, and
 *      the token is presented in the first-party API's own key header, beside
 *      the observed API version header;
 *   3. the **CLI-owned bearer** — the CLI owns the token, so the caller's own
 *      `Authorization` header is replaced by the CLI's, never the other way
 *      round;
 *   4. the **CCR proxy** — the request is routed through the proxy, and the
 *      caller's own credentials are not forwarded to the proxy host.
 *
 * ## Implementation choices
 *
 * The audit does not pin these, so they are marked here:
 *
 *   - The **distinguishing rules** are this implementation's own, and they are the four
 *     markers the variants are told apart by:
 *
 *       | variant | URL | marker | credential |
 *       |---|---|---|---|
 *       | the vendor's first-party proxy | `<baseUrl>/mcp` | `x-claude-ai-proxy: 1` | the proxy's own bearer |
 *       | the first-party API | the endpoint as it is | `anthropic-version: 2023-06-01` | `x-api-key` |
 *       | the CLI-owned bearer | the endpoint as it is | — | `authorization`, the CLI's own |
 *       | the CCR proxy | `<baseUrl>/mcp` | `x-ccr-proxy: 1` | the proxy's own bearer |
 *
 *   - The **two proxy variants refuse to forward the caller's own credentials**
 *     to the proxy host: the caller's `authorization` and `x-api-key` headers
 *     are dropped before the proxy's own credential is added — and they stay
 *     dropped, whatever the configured headers say.
 *   - A **variant's own marker and credential win**: the headers this implementation
 *     configures are added before the variant's rules are applied, so a
 *     configured header cannot defeat a marker or re-add a dropped credential.
 *   - The **default endpoints** are `https://claude.ai/api` and
 *     `https://ccr.invalid` — the latter is deliberately not a real host.
 *   - The **header names are lower-cased** in the recorded headers, so a
 *     variant's marker is asserted the same way whatever the caller wrote.
 *   - The **header container** has a null prototype, so a header named
 *     `__proto__` is an ordinary header rather than a prototype assignment.
 */

/** A `fetch`-shaped function. */
export type McpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The options a fetch variant is created with. */
export interface McpFetchOptions {
  /** The endpoint the variant talks to. */
  baseUrl?: string;
  /** The token the variant presents. */
  token?: string;
  /** Extra headers. */
  headers?: Record<string, string>;
  /** The underlying fetch. */
  fetchImpl?: typeof fetch;
}

/** The header of the vendor's first-party proxy marker. */
export const CLAUDE_AI_PROXY_HEADER = 'x-claude-ai-proxy';

/** The header of the CCR proxy marker. */
export const CCR_PROXY_HEADER = 'x-ccr-proxy';

/** The first-party API's version header, and the value the target was seen with. */
export const ANTHROPIC_VERSION_HEADER = 'anthropic-version';

/** The first-party API's version the target was seen with. */
export const ANTHROPIC_VERSION = '2023-06-01';

/**
 * The headers a request carries, as a record.
 *
 * The container is a **null-prototype** object, so a header whose name is
 * `__proto__` is an ordinary own key rather than a prototype assignment: the
 * header is neither lost nor turned into a prototype.
 */
function headerRecord(init: RequestInit | undefined): Record<string, string> {
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  const raw = init?.headers;
  if (raw === undefined) return headers;
  if (raw instanceof Headers) {
    raw.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return headers;
  }
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const key = entry[0];
      const value = entry[1];
      if (typeof key === 'string' && typeof value === 'string') headers[key.toLowerCase()] = value;
    }
    return headers;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') headers[key.toLowerCase()] = value;
  }
  return headers;
}

/**
 * Add this implementation's own configured headers to a request's headers.
 *
 * The names are lower-cased, like every other recorded header, and the
 * configured headers are added **before** the variant's own rules are
 * applied — so a variant's marker and credential always win.
 */
function applyConfiguredHeaders(
  headers: Record<string, string>,
  extra: Record<string, string> | undefined,
): void {
  if (!extra) return;
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === 'string') headers[key.toLowerCase()] = value;
  }
}

function proxyUrl(baseUrl: string | undefined, fallback: string): string {
  const base = (baseUrl ?? fallback).replace(/\/+$/, '');
  return `${base}/mcp`;
}

/**
 * Build a fetch variant.
 *
 * The variant's own rules are applied **last**, so neither the caller's
 * headers nor this implementation's configured headers can defeat a variant's marker or
 * credential — and a header the variant drops stays dropped.
 */
function makeFetch(
  resolveUrl: (input: string | URL | Request) => string,
  applyRules: (headers: Record<string, string>) => void,
  options: McpFetchOptions,
): McpFetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (input, init) => {
    const headers = headerRecord(init);
    applyConfiguredHeaders(headers, options.headers);
    applyRules(headers);
    return fetchImpl(resolveUrl(input), { ...(init ?? {}), headers });
  };
}

/**
 * The vendor's first-party proxy fetch.
 *
 * The request is routed through the proxy, and the caller's own credentials are
 * **not** forwarded to the proxy host: the proxy presents its own bearer token.
 */
export function createFirstPartyProxyFetch(options: McpFetchOptions = {}): McpFetch {
  return makeFetch(
    (input) => proxyUrl(options.baseUrl, 'https://claude.ai/api'),
    (headers) => {
      // The caller's own credentials are dropped before the proxy's own
      // credential is added — and they stay dropped.
      delete headers['authorization'];
      delete headers['x-api-key'];
      headers[CLAUDE_AI_PROXY_HEADER] = '1';
      if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
    },
    options,
  );
}

/**
 * The first-party API fetch.
 *
 * The request goes to the endpoint as it is, and the token is presented in the
 * first-party API's own key header, beside the target's observed API version
 * header.
 */
export function createFirstPartyApiMcpFetch(options: McpFetchOptions = {}): McpFetch {
  return makeFetch(
    (input) => String(input),
    (headers) => {
      headers[ANTHROPIC_VERSION_HEADER] = ANTHROPIC_VERSION;
      if (options.token !== undefined) headers['x-api-key'] = options.token;
    },
    options,
  );
}

/**
 * The CLI-owned bearer fetch.
 *
 * The CLI owns the token: the caller's own `Authorization` header is replaced
 * by the CLI's, never the other way round.
 */
export function createCliOwnedBearerFetch(options: McpFetchOptions = {}): McpFetch {
  return makeFetch(
    (input) => String(input),
    (headers) => {
      headers['authorization'] =
        options.token !== undefined ? `Bearer ${options.token}` : (headers['authorization'] ?? '');
      if (headers['authorization'] === '') delete headers['authorization'];
    },
    options,
  );
}

/**
 * The CCR proxy fetch.
 *
 * The request is routed through the proxy, and the caller's own credentials are
 * not forwarded to the proxy host.
 */
export function createCcrProxyFetch(options: McpFetchOptions = {}): McpFetch {
  return makeFetch(
    (input) => proxyUrl(options.baseUrl, 'https://ccr.invalid'),
    (headers) => {
      delete headers['authorization'];
      delete headers['x-api-key'];
      headers[CCR_PROXY_HEADER] = '1';
      if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
    },
    options,
  );
}

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
 *   1. the **vendor first-party proxy** — the request is routed through the proxy, and
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
 *       | the vendor first-party proxy | `<baseUrl>/mcp` | `x-claude-ai-proxy: 1` | the proxy's own bearer |
 *       | the first-party API | the endpoint as it is | `anthropic-version: 2023-06-01` | `x-api-key` |
 *       | the CLI-owned bearer | the endpoint as it is | — | `authorization`, the CLI's own |
 *       | the CCR proxy | `<baseUrl>/mcp` | `x-ccr-proxy: 1` | the proxy's own bearer |
 *
 *   - The **two proxy variants refuse to forward the caller's own credentials**
 *     to the proxy host: the caller's `authorization` and `x-api-key` headers
 *     are dropped before the proxy's own credential is added.
 *   - The **default endpoints** are `https://claude.ai/api` and
 *     `https://ccr.invalid` — the latter is deliberately not a real host.
 *   - The **header names are lower-cased** in the recorded headers, so a
 *     variant's marker is asserted the same way whatever the caller wrote.
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

/** The header of the vendor first-party proxy marker. */
export const CLAUDE_AI_PROXY_HEADER = 'x-claude-ai-proxy';

/** The header of the CCR proxy marker. */
export const CCR_PROXY_HEADER = 'x-ccr-proxy';

/** The first-party API's version header, and the value the target was seen with. */
export const ANTHROPIC_VERSION_HEADER = 'anthropic-version';

/** The first-party API's version the target was seen with. */
export const ANTHROPIC_VERSION = '2023-06-01';

function headerRecord(init: RequestInit | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
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

function proxyUrl(baseUrl: string | undefined, fallback: string): string {
  const base = (baseUrl ?? fallback).replace(/\/+$/, '');
  return `${base}/mcp`;
}

function makeFetch(
  resolveUrl: (input: string | URL | Request) => string,
  buildHeaders: (headers: Record<string, string>) => Record<string, string>,
  options: McpFetchOptions,
): McpFetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (input, init) => {
    const headers = buildHeaders(headerRecord(init));
    return fetchImpl(resolveUrl(input), { ...(init ?? {}), headers });
  };
}

/**
 * The vendor first-party proxy fetch.
 *
 * The request is routed through the proxy, and the caller's own credentials are
 * **not** forwarded to the proxy host: the proxy presents its own bearer token.
 */
export function createAgentAiProxyFetch(options: McpFetchOptions = {}): McpFetch {
  return makeFetch(
    (input) => proxyUrl(options.baseUrl, 'https://claude.ai/api'),
    (headers) => {
      const next: Record<string, string> = { ...headers };
      delete next['authorization'];
      delete next['x-api-key'];
      next[CLAUDE_AI_PROXY_HEADER] = '1';
      if (options.token !== undefined) next['authorization'] = `Bearer ${options.token}`;
      return { ...next, ...(options.headers ?? {}) };
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
      const next: Record<string, string> = { ...headers };
      next[ANTHROPIC_VERSION_HEADER] = ANTHROPIC_VERSION;
      if (options.token !== undefined) next['x-api-key'] = options.token;
      return { ...next, ...(options.headers ?? {}) };
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
      const next: Record<string, string> = { ...headers };
      next['authorization'] =
        options.token !== undefined ? `Bearer ${options.token}` : (next['authorization'] ?? '');
      if (next['authorization'] === '') delete next['authorization'];
      return { ...next, ...(options.headers ?? {}) };
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
      const next: Record<string, string> = { ...headers };
      delete next['authorization'];
      delete next['x-api-key'];
      next[CCR_PROXY_HEADER] = '1';
      if (options.token !== undefined) next['authorization'] = `Bearer ${options.token}`;
      return { ...next, ...(options.headers ?? {}) };
    },
    options,
  );
}

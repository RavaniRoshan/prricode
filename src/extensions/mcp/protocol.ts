/**
 * The MCP protocol revisions and the two version-error contracts.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("MCP, plugins, and
 * hooks" — "MCP transport"), and the `CC-011` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * This module owns **one** responsibility: the protocol revisions themselves —
 * the two eras, the environment variable that selects between them, the HTTP
 * header that carries the negotiated version, and the two JSON-RPC error codes
 * the version negotiation turns on.
 *
 * ## The two protocol eras
 *
 * The modern revision (`2026-07-28`) is **stateless**: it retires the
 * `initialize`/`initialized` handshake, adds `server/discover`, and carries the
 * protocol version, the client identity and the capabilities in `_meta` on every
 * request. The previous stable revision (`2025-11-25`) is the **legacy** era,
 * which opens with `initialize`.
 *
 * ## The two version-error contracts
 *
 *   - the **server side** — an invalid or missing `MCP-Protocol-Version` header
 *     on an HTTP transport is an HTTP `400 Bad Request`
 *     (`checkMcpProtocolVersionHeader`);
 *   - the **client side** — an unsupported declared version is the JSON-RPC
 *     error `-32022` carrying a `supported` list, which the client retries.
 *
 * The **server side has no in-repo caller**: this implementation has no HTTP MCP
 * *server*, only a client. The check is therefore provided as a reusable
 * function — a caller that builds an HTTP MCP server asks it — and it is
 * exercised by the contract test rather than by a server in this repository.
 * This is stated here rather than implied by silence.
 *
 * ## Implementation choices
 *
 * The audit does not pin these, so they are marked here:
 *
 *   - The **legacy era's version set** is a closed list of five revisions
 *     (`2024-10-07`, `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25`).
 *     A `-32022` error that names one of them identifies a legacy-era server.
 *   - The **negotiation opt-out** is `MCP_PROTOCOL_NEGOTIATION=legacy`, read
 *     from the **client's** environment — not the server's.
 *   - The **header check** accepts every version this build speaks, so a
 *     legacy-era header is not a `400`.
 */

import { readRecord } from './records.js';

/* -------------------------------------------------------------------------- */
/* The revisions                                                               */
/* -------------------------------------------------------------------------- */

/** The current (modern, stateless) MCP revision. */
export const MODERN_PROTOCOL_VERSION = '2026-07-28';

/** The previous stable revision — the legacy era, which opens with `initialize`. */
export const LEGACY_PROTOCOL_VERSION = '2025-11-25';

/** The JSON-RPC error code an unsupported declared version produces. */
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** The JSON-RPC error code a method the server does not know produces. */
export const METHOD_NOT_FOUND = -32601;

/** The environment variable that selects the legacy negotiation path. */
export const MCP_PROTOCOL_NEGOTIATION_ENV = 'MCP_PROTOCOL_NEGOTIATION';

/** The HTTP header that carries the protocol version on an HTTP transport. */
export const MCP_PROTOCOL_VERSION_HEADER = 'MCP-Protocol-Version';

/** The two protocol eras. */
export type McpProtocolEra = 'modern' | 'legacy';

/**
 * The versions of the legacy era.
 *
 * A server that answers `-32022` with a `supported` list that names one of
 * these is a legacy-era server, and the client falls back to the `initialize`
 * handshake with that version.
 */
export const LEGACY_ERA_VERSIONS: ReadonlySet<string> = new Set([
  '2024-10-07',
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
]);

/**
 * The negotiation path.
 *
 * The modern revision is the default; `MCP_PROTOCOL_NEGOTIATION=legacy` is the
 * target's own opt-out, and this implementation provides the same opt-out.
 */
export function getMcpVersionNegotiation(env: NodeJS.ProcessEnv = process.env): McpProtocolEra {
  const value = env[MCP_PROTOCOL_NEGOTIATION_ENV];
  return value === 'legacy' ? 'legacy' : 'modern';
}

/* -------------------------------------------------------------------------- */
/* The server-side header contract                                             */
/* -------------------------------------------------------------------------- */

/**
 * The check an HTTP MCP **server** makes on the protocol-version header.
 *
 * An invalid or missing `MCP-Protocol-Version` header is an HTTP
 * `400 Bad Request` — the server-side version-error contract.
 */
export interface McpProtocolVersionHeaderCheck {
  /** Whether the header names a version this build speaks. */
  ok: boolean;
  /** The declared version, when the header names one. */
  version?: string;
  /** The HTTP status the server answers with, when the header is not usable. */
  status?: number;
  /** The message the server answers with, when the header is not usable. */
  error?: string;
}

/** Every protocol version this build speaks. */
const SUPPORTED_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set([
  MODERN_PROTOCOL_VERSION,
  ...LEGACY_ERA_VERSIONS,
]);

/**
 * Check the `MCP-Protocol-Version` header of an incoming HTTP request.
 *
 * A missing or unusable header is a `400 Bad Request`: the request cannot be
 * served, and the server says so rather than guessing a version.
 */
export function checkMcpProtocolVersionHeader(
  value: string | null | undefined,
): McpProtocolVersionHeaderCheck {
  if (value === null || value === undefined || value.trim() === '') {
    return {
      ok: false,
      status: 400,
      error: `the ${MCP_PROTOCOL_VERSION_HEADER} header is missing`,
    };
  }
  const version = value.trim();
  if (!SUPPORTED_PROTOCOL_VERSIONS.has(version)) {
    return {
      ok: false,
      status: 400,
      error: `the ${MCP_PROTOCOL_VERSION_HEADER} header names an unsupported version "${version}"`,
    };
  }
  return { ok: true, version };
}

/* -------------------------------------------------------------------------- */
/* The server identity                                                         */
/* -------------------------------------------------------------------------- */

/** The identity a server reports. */
export interface McpServerInfo {
  name?: string;
  version?: string;
}

/** The server identity, as a `serverInfo` payload carries it. */
export function readServerInfo(value: unknown): McpServerInfo | undefined {
  const record = readRecord(value);
  if (!record) return undefined;
  const info: McpServerInfo = {};
  if (typeof record['name'] === 'string') info.name = record['name'];
  if (typeof record['version'] === 'string') info.version = record['version'];
  return info;
}

/** The capabilities, as a `capabilities` payload carries them. */
export function readCapabilities(value: unknown): Record<string, unknown> {
  return readRecord(value) ?? {};
}

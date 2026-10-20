/**
 * The negotiation ladder.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("MCP, plugins, and
 * hooks" — "MCP transport"), and the `CC-011` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * This module owns **one** responsibility: deciding which protocol revision a
 * connection speaks, and how.
 *
 * The modern revision is probed **first**. The ladder is:
 *
 *   1. `server/discover` with the modern revision — the happy path;
 *   2. the server answers `-32601` (it does not know `server/discover`) — the
 *      **legacy** `initialize` handshake is the fallback;
 *   3. the server answers `-32022` (the version it declared is unsupported) and
 *      names the versions it supports — the client retries with one of them:
 *      a legacy version, which is the legacy handshake, or a modern version
 *      the client has **not** already probed, which is a **second
 *      `server/discover`** with that version;
 *   4. the server answers the modern probe with an HTTP `400` — it does not
 *      speak the modern revision, so the legacy handshake is the fallback.
 *
 * The ladder **never loops**: every edge goes strictly down, and the legacy
 * handshake is the floor.
 *
 * ## The version the transport presents
 *
 * The negotiation tells the transport which version to present **before** every
 * request it makes, so a legacy-era connection presents the legacy version from
 * its first request onwards.
 *
 * ## Implementation choices
 *
 * The audit does not pin these, so they are marked here:
 *
 *   - The **fallback ladder's exact shape** is this implementation's own. The audit pins
 *     the *default* — the modern revision is probed first and the legacy
 *     handshake is the fallback — and the `-32022` retry, but not the order of
 *     the branches nor the HTTP `400` edge.
 *   - The **`-32022` re-probe** picks the **first** supported version that is
 *     neither a legacy-era version nor one the client has already probed, and
 *     probes with it. It never probes twice for the same version: a server
 *     that names only the version the client has already probed gets the
 *     `-32022` error rather than a second, identical probe.
 *   - The **`-32022` legacy fallback** picks the **first** supported version
 *     that is a legacy-era version.
 *   - The **HTTP `400` edge** treats a `400` on the modern probe as "this
 *     server does not speak the modern revision", because that is what the
 *     server-side version contract answers when it cannot serve the request.
 */

import {
  LEGACY_ERA_VERSIONS,
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
  readCapabilities,
  readServerInfo,
  type McpProtocolEra,
  type McpServerInfo,
} from './protocol.js';
import { readRecord } from './records.js';
import {
  isMethodNotFoundError,
  isUnsupportedProtocolVersionError,
  type McpPeer,
} from './peer.js';
import { McpHttpStatusError } from './transport.js';
import type { McpTimeoutOptions } from './timeouts.js';

/** The client's own identity, as the modern revision carries it. */
const CLIENT_INFO = Object.freeze({ name: 'prricode', version: '0.1.0' });

/** The client's own capabilities, as the modern revision carries them. */
const CLIENT_CAPABILITIES = Object.freeze({ tools: {}, resources: {} });

/** The outcome of a negotiation. */
export interface NegotiationResult {
  /** The era the connection speaks. */
  era: McpProtocolEra;
  /** The negotiated protocol revision. */
  protocolVersion: string;
  /** The server's own identity, when it reported one. */
  serverInfo?: McpServerInfo;
  /** The server's capabilities, when it reported any. */
  capabilities: Record<string, unknown>;
}

/** Tells the transport which protocol version to present. */
export type ProtocolVersionPresenter = (version: string) => void;

/** The versions a `-32022` error says the server supports. */
function readSupportedVersions(error: unknown): string[] {
  if (!isUnsupportedProtocolVersionError(error)) return [];
  const data = readRecord((error as { data?: unknown }).data);
  if (!data) return [];
  for (const key of ['supported', 'protocolVersions', 'supportedProtocolVersions']) {
    const value = data[key];
    if (!Array.isArray(value)) continue;
    const versions = value.filter((entry): entry is string => typeof entry === 'string');
    if (versions.length > 0) return versions;
  }
  return [];
}

/**
 * Negotiate the protocol revision.
 *
 * The modern revision is probed first, and the ladder above is the fallback.
 */
export async function negotiate(
  peer: McpPeer,
  era: McpProtocolEra,
  timeouts: McpTimeoutOptions,
  present?: ProtocolVersionPresenter,
): Promise<NegotiationResult> {
  if (era === 'legacy') {
    return legacyHandshake(peer, LEGACY_PROTOCOL_VERSION, timeouts, present);
  }

  /**
   * The versions the client has already probed with.
   *
   * The ladder **never probes twice for the same version**: a version that is
   * in this set is never chosen again.
   */
  const probed = new Set<string>();

  /** The modern probe's parameters, for the version being probed. */
  const modernParams = (version: string): Record<string, unknown> => ({
    _meta: {
      protocolVersion: version,
      clientInfo: CLIENT_INFO,
      capabilities: CLIENT_CAPABILITIES,
    },
  });

  // The modern revision is probed **first**.
  present?.(MODERN_PROTOCOL_VERSION);
  probed.add(MODERN_PROTOCOL_VERSION);

  try {
    const result = await peer.request('server/discover', modernParams(MODERN_PROTOCOL_VERSION), {
      armedTimeoutMs: timeouts.armedRequestTimeoutMs,
      requestTimeoutMs: timeouts.requestTimeoutMs,
    });
    const record = readRecord(result) ?? {};
    const meta = readRecord(record['_meta']) ?? {};
    const version =
      typeof record['protocolVersion'] === 'string'
        ? record['protocolVersion']
        : typeof meta['protocolVersion'] === 'string'
          ? meta['protocolVersion']
          : MODERN_PROTOCOL_VERSION;
    return {
      era: 'modern',
      protocolVersion: version,
      serverInfo: readServerInfo(record['serverInfo']),
      capabilities: readCapabilities(record['capabilities']),
    };
  } catch (error) {
    if (isUnsupportedProtocolVersionError(error)) {
      // The client-side version-error contract: the server named the versions
      // it supports, and the client retries with one of them.
      const supported = readSupportedVersions(error);
      const legacyVersion = supported.find((version) => LEGACY_ERA_VERSIONS.has(version));
      if (legacyVersion) {
        return legacyHandshake(peer, legacyVersion, timeouts, present);
      }
      // The re-probe picks the **first** modern version the server names that
      // the client has not already probed: the ladder never probes twice for
      // the same version.
      const modernVersion = supported.find(
        (version) => !LEGACY_ERA_VERSIONS.has(version) && !probed.has(version),
      );
      if (modernVersion) {
        present?.(modernVersion);
        probed.add(modernVersion);
        const result = await peer.request('server/discover', modernParams(modernVersion), {
          armedTimeoutMs: timeouts.armedRequestTimeoutMs,
          requestTimeoutMs: timeouts.requestTimeoutMs,
        });
        const record = readRecord(result) ?? {};
        return {
          era: 'modern',
          protocolVersion:
            typeof record['protocolVersion'] === 'string'
              ? record['protocolVersion']
              : modernVersion,
          serverInfo: readServerInfo(record['serverInfo']),
          capabilities: readCapabilities(record['capabilities']),
        };
      }
      // The server named no version the client can use: the error stands.
      throw error;
    }
    if (isMethodNotFoundError(error)) {
      // The server does not know the modern probe: fall back to the legacy
      // handshake.
      return legacyHandshake(peer, LEGACY_PROTOCOL_VERSION, timeouts, present);
    }
    if (error instanceof McpHttpStatusError && error.status === 400) {
      // The server answered the modern probe with the server-side version
      // contract's `400`: it does not speak the modern revision.
      return legacyHandshake(peer, LEGACY_PROTOCOL_VERSION, timeouts, present);
    }
    throw error;
  }
}

/**
 * The legacy handshake.
 *
 * The `initialize` request carries the version, and the `initialized`
 * notification follows the answer.
 */
export async function legacyHandshake(
  peer: McpPeer,
  version: string,
  timeouts: McpTimeoutOptions,
  present?: ProtocolVersionPresenter,
): Promise<NegotiationResult> {
  present?.(version);
  const result = await peer.request(
    'initialize',
    {
      protocolVersion: version,
      capabilities: CLIENT_CAPABILITIES,
      clientInfo: CLIENT_INFO,
    },
    {
      armedTimeoutMs: timeouts.armedRequestTimeoutMs,
      requestTimeoutMs: timeouts.requestTimeoutMs,
    },
  );
  const record = readRecord(result) ?? {};
  const negotiated =
    typeof record['protocolVersion'] === 'string' ? record['protocolVersion'] : version;
  await peer.notify('notifications/initialized');
  return {
    era: 'legacy',
    protocolVersion: negotiated,
    serverInfo: readServerInfo(record['serverInfo']),
    capabilities: readCapabilities(record['capabilities']),
  };
}

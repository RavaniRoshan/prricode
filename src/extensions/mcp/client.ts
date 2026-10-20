/**
 * The MCP client: one connection to one MCP server.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("MCP, plugins, and
 * hooks" — "MCP transport" and "The MCP client lifecycle is observed"), and the
 * `CC-011` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## One responsibility per module
 *
 * The MCP client used to be one 2 278-line file with ten unrelated
 * responsibilities in it. It is now a set of modules that each own one:
 *
 *   | module | responsibility |
 *   |---|---|
 *   | `protocol.ts` | the protocol revisions and the two version-error contracts |
 *   | `records.ts` | the wire-shape readers |
 *   | `timeouts.ts` | the four timeouts and the timeout error |
 *   | `transport.ts` | the stdio and HTTP transports |
 *   | `peer.ts` | the JSON-RPC peer and the request correlation |
 *   | `negotiation.ts` | the negotiation ladder |
 *   | `connection.ts` | the live connection and the tool call |
 *   | `config.ts` | the server configuration and the server state |
 *   | `capabilities.ts` | the four capability listings |
 *   | `composition.ts` | the tool the model sees |
 *   | `fetch-variants.ts` | the four fetch variants |
 *   | `auth.ts` | the auth-failure classification |
 *   | `manager.ts` | the servers: connect, remember, hand out, tear down |
 *   | `control.ts` | the control-request surface |
 *
 * This module owns the **connect** itself: the options a connect runs with, the
 * credential the client uses, the connect memo, the teardown, the connection
 * events, the reconnect shape, the remote host lists and the tool-description
 * change.
 *
 * ## What is observed and reproduced here
 *
 *   - **The lifecycle.** `connectToServer` and `ensureConnectedClient` are the
 *     entry points; a connect result is memoized, and the memo is dropped when
 *     the credential identity epoch changes, when it goes stale, or explicitly.
 *     `hasLiveConnection` reports a live connection and `hasUnsettledDial` a
 *     connection attempt that is still in flight.
 *   - **The teardown** is detach-and-close, dispose-detached, and the clean-up
 *     of the connected clients.
 *   - **The host lists** and the **rug-pull detector** are here too.
 *
 * ## The two protocol eras
 *
 * The modern revision (`2026-07-28`) is **stateless**: it retires the
 * `initialize`/`initialized` handshake, adds `server/discover`, and carries the
 * protocol version, the client identity and the capabilities in `_meta` on every
 * request. This implementation therefore **probes for the modern revision first** and
 * falls back to the legacy `initialize` handshake only when the server does not
 * support it. `MCP_PROTOCOL_NEGOTIATION=legacy` is the opt-out, and it selects
 * the legacy path outright. The opt-out is read from the **client's**
 * environment — the server's own environment says nothing about how the client
 * negotiates.
 *
 * Neither may hang: every request carries a deadline.
 *
 * ## The server side of the version contract
 *
 * This implementation has **no HTTP MCP server**: it is a client. The server-side
 * version contract — an invalid or missing `MCP-Protocol-Version` header is a
 * `400` — is implemented as the reusable function
 * `checkMcpProtocolVersionHeader` in `protocol.ts`, and it has **no in-repo
 * caller**. A caller that builds an HTTP MCP server asks it.
 *
 * ## Implementation choices
 *
 * The audit does not pin these, so they are marked here:
 *
 *   - The **`http` and `sse` types** are a widening of the target's own
 *     `stdio`/`sdk` types: the target also speaks the two network transports,
 *     and this implementation keeps them so a configuration written for the target is not
 *     rejected. The widening and the transport behaviour are described in
 *     `transport.ts`.
 *   - The **fallback ladder's exact shape** is described in `negotiation.ts`.
 *   - The **four fetch variants' distinguishing rules** are described in
 *     `fetch-variants.ts`.
 *   - The **timeout values and their scoping** are described in `timeouts.ts`.
 *   - The **configuration identity** the memo is keyed on is this implementation's own:
 *     the type, the command, the arguments, the URL, the working directory, a
 *     **digest** of the server's environment, a **digest** of the credential,
 *     and the provider connection's id. A digest is used rather than the value
 *     itself so a secret never lands in a map key.
 *   - The **memoized failure** is retryable: a failed memo is evicted before
 *     the next connect is attempted.
 */

import { createHash } from 'node:crypto';

import { resolveConnectionCredential, type ProviderRegistry } from '../../provider/registry.js';
import type { ResolvedCredential } from '../../provider/credentials.js';

import {
  type McpConnection,
  McpServerConnection,
} from './connection.js';
import type { McpToolDefinition } from './capabilities.js';
import {
  type McpServerConfig,
  type McpServerState,
  type McpServerType,
  type McpToolDescriptionChange,
  type McpToolSummary,
} from './config.js';
import { negotiate } from './negotiation.js';
import { McpPeer } from './peer.js';
import { MODERN_PROTOCOL_VERSION, getMcpVersionNegotiation, type McpProtocolEra } from './protocol.js';
import { resolveMcpTimeouts, type McpTimeoutOptions } from './timeouts.js';
import {
  type McpTransport,
  type SpawnImpl,
  createHttpMcpTransport,
  createStdioTransport,
} from './transport.js';

/* -------------------------------------------------------------------------- */
/* The re-exports                                                             */
/* -------------------------------------------------------------------------- */

/*
 * Every name the module used to export is still exported here, so no caller
 * breaks. The modules below own them.
 */

export {
  LEGACY_ERA_VERSIONS,
  LEGACY_PROTOCOL_VERSION,
  MCP_PROTOCOL_NEGOTIATION_ENV,
  MCP_PROTOCOL_VERSION_HEADER,
  METHOD_NOT_FOUND,
  MODERN_PROTOCOL_VERSION,
  UNSUPPORTED_PROTOCOL_VERSION,
  checkMcpProtocolVersionHeader,
  getMcpVersionNegotiation,
  readCapabilities,
  readServerInfo,
} from './protocol.js';
export type {
  McpProtocolEra,
  McpProtocolVersionHeaderCheck,
  McpServerInfo,
} from './protocol.js';

export { readArray, readNumber, readRecord, readString } from './records.js';

export {
  DEFAULT_MCP_TIMEOUTS,
  MCP_CONNECT_TIMEOUT_ENV,
  MCP_TIMEOUT_ENV,
  McpTimeoutError,
  resolveMcpTimeouts,
} from './timeouts.js';
export type { McpTimeoutKind, McpTimeoutOptions, McpTimeoutResolutionOptions } from './timeouts.js';

export {
  McpHttpStatusError,
  createHttpMcpTransport,
  createStdioTransport,
} from './transport.js';
export type {
  HttpMcpTransportOptions,
  JsonRpcMessage,
  McpTransport,
  SpawnImpl,
  StdioTransportOptions,
} from './transport.js';

export {
  McpPeer,
  McpRpcError,
  isMethodNotFoundError,
  isUnsupportedProtocolVersionError,
} from './peer.js';
export type { PeerRequestOptions } from './peer.js';

export { legacyHandshake, negotiate } from './negotiation.js';
export type { NegotiationResult, ProtocolVersionPresenter } from './negotiation.js';

export {
  McpServerConnection,
  callMCPTool,
  callMCPToolWithUrlElicitationRetry,
  isUrlElicitationResult,
  normalizeToolCallResult,
  urlElicitationFromResult,
} from './connection.js';
export type {
  McpCallOptions,
  McpConnection,
  McpToolCallResult,
  McpUrlElicitation,
} from './connection.js';

export type {
  McpServerConfig,
  McpServerState,
  McpServerType,
  McpToolDescriptionChange,
  McpToolSummary,
} from './config.js';

export {
  fetchCommandsForClient,
  fetchResourceTemplatesForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
  getListingDiscoverPrior,
  getMcpToolsCommandsAndResources,
  getRememberedDiscoverPrior,
  hydrateCommandsFromListing,
  hydrateToolsFromListing,
  rememberDiscoverPrior,
} from './capabilities.js';
export type {
  McpCommandDefinition,
  McpListing,
  McpResourceDefinition,
  McpResourceTemplateDefinition,
  McpToolDefinition,
  McpToolsCommandsAndResources,
} from './capabilities.js';

export {
  IDE_MCP_TOOL_NAMES,
  MAX_MCP_INSTRUCTIONS_LENGTH,
  capMcpInstructions,
  composeMcpTool,
  isIdeMcpTool,
  mcpToolName,
  shouldHideMcpTool,
} from './composition.js';
export type { McpComposedTool } from './composition.js';

export {
  ANTHROPIC_VERSION,
  ANTHROPIC_VERSION_HEADER,
  CCR_PROXY_HEADER,
  CLAUDE_AI_PROXY_HEADER,
  createCcrProxyFetch,
  createCliOwnedBearerFetch,
  createAgentAiProxyFetch,
  createFirstPartyApiMcpFetch,
} from './fetch-variants.js';
export type { McpFetch, McpFetchOptions } from './fetch-variants.js';

export { classifyMcpAuthFailure, hasEraCodeInHttpErrorBody } from './auth.js';
export type { McpAuthFailureKind, McpHttpFailure } from './auth.js';

/* -------------------------------------------------------------------------- */
/* The connect options                                                        */
/* -------------------------------------------------------------------------- */

/** The options a connect runs with. */
export interface McpConnectOptions {
  /** The transport factory, for a server this implementation cannot spawn itself. */
  transportFactory?: (
    config: McpServerConfig,
    context: { credential?: ResolvedCredential },
  ) => McpTransport | Promise<McpTransport>;
  /** The spawn implementation of the stdio transport. */
  spawnImpl?: SpawnImpl;
  /** The four timeouts, or the ones to override. */
  timeouts?: Partial<McpTimeoutOptions>;
  /** The environment the negotiation and the batch sizes are read from. */
  env?: NodeJS.ProcessEnv;
  /** The negotiation path, when the caller wants to force one. */
  negotiation?: McpProtocolEra;
  /** The registry a credential is asked for. */
  registry?: ProviderRegistry;
  /** The credential, when the caller resolved one. */
  credential?: ResolvedCredential;
  /** Whether a failed memo is evicted before the connect is attempted. */
  retryFailed?: boolean;
  /**
   * The fetch implementation the HTTP transport uses.
   *
   * Without it the transport uses the global `fetch`.
   */
  fetchImpl?: typeof fetch;
}

/**
 * The credential the client uses.
 *
 * The client **receives** one, or asks the registry for one through
 * `resolveConnectionCredential`. It never resolves a credential itself and
 * never reads the environment, the filesystem or a keychain for a secret.
 */
async function resolveClientCredential(
  config: McpServerConfig,
  options: McpConnectOptions,
): Promise<ResolvedCredential | undefined> {
  if (config.credential) return config.credential;
  if (options.credential) return options.credential;
  const connectionId = config.connectionId;
  if (!options.registry || !connectionId) return undefined;
  const connection = options.registry.get(connectionId);
  if (!connection) return undefined;
  return resolveConnectionCredential(connection, options.env ?? process.env);
}

function validateConfig(config: McpServerConfig): void {
  if (typeof config !== 'object' || config === null) {
    throw new Error('an MCP server configuration must be an object');
  }
  if (typeof config.name !== 'string' || config.name.trim() === '') {
    throw new Error(
      `an MCP server configuration needs a non-empty name, but it got "${String(config.name)}"`,
    );
  }
  if (config.type === 'stdio' || config.type === 'sdk') {
    if (config.type === 'stdio' && (typeof config.command !== 'string' || config.command === '')) {
      throw new Error(`the MCP server "${config.name}" needs a command`);
    }
    return;
  }
  if (typeof config.url !== 'string' || config.url === '') {
    throw new Error(`the MCP server "${config.name}" needs a URL`);
  }
}

async function createTransport(
  config: McpServerConfig,
  options: McpConnectOptions,
  credential: ResolvedCredential | undefined,
): Promise<McpTransport> {
  if (options.transportFactory) {
    return await options.transportFactory(config, { credential });
  }
  if (config.type === 'stdio') {
    return createStdioTransport({
      command: config.command as string,
      args: config.args ?? [],
      cwd: config.cwd,
      env: config.env,
      spawnImpl: options.spawnImpl,
    });
  }
  if (config.type === 'http' || config.type === 'sse') {
    return createHttpMcpTransport({
      url: config.url as string,
      // The negotiation replaces this with the version it settled on.
      protocolVersion: MODERN_PROTOCOL_VERSION,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(credential?.present && credential.value !== undefined ? { token: credential.value } : {}),
    });
  }
  throw new Error(
    `the MCP server "${config.name}" has the type "${config.type}", which needs a transport factory`,
  );
}

/* -------------------------------------------------------------------------- */
/* Connecting                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Connect to an MCP server.
 *
 * The connect negotiates the protocol revision — the modern one first — and
 * returns the connection. It does **not** memoize: `ensureConnectedClient` is
 * the memoized entry point.
 */
export async function connectToServer(
  config: McpServerConfig,
  options: McpConnectOptions = {},
): Promise<McpConnection> {
  validateConfig(config);
  const env = options.env ?? process.env;
  const timeouts = resolveMcpTimeouts(options, env);
  const credential = await resolveClientCredential(config, options);
  const transport = await createTransport(config, options, credential);

  try {
    await transport.start();
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }

  const peer = new McpPeer(transport);
  const era = options.negotiation ?? getMcpVersionNegotiation(env);

  let negotiation;
  try {
    negotiation = await negotiate(peer, era, timeouts, (version) => {
      // The transport presents the version the negotiation is speaking.
      transport.setProtocolVersion?.(version);
    });
  } catch (error) {
    await peer.close().catch(() => undefined);
    throw error;
  }

  transport.setProtocolVersion?.(negotiation.protocolVersion);

  const connection: McpConnection = new McpServerConnection({
    name: config.name,
    config,
    era: negotiation.era,
    protocolVersion: negotiation.protocolVersion,
    serverInfo: negotiation.serverInfo,
    capabilities: negotiation.capabilities,
    timeouts,
    peer,
  });

  emitMcpServerConnectionEvent({
    type: 'connected',
    server: config.name,
    protocolVersion: connection.protocolVersion,
  });
  return connection;
}

/* -------------------------------------------------------------------------- */
/* The connect memo                                                           */
/* -------------------------------------------------------------------------- */

interface ConnectMemo {
  name: string;
  configKey: string;
  epoch: number;
  connection?: McpConnection;
  failure?: string;
  at: number;
}

const connectMemos = new Map<string, ConnectMemo>();
const unsettledDials = new Set<string>();
let identityEpoch = 0;

/**
 * A digest of a value.
 *
 * The digest is what lands in a map key, so a secret never does.
 */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/**
 * The identity of a server's own environment.
 *
 * The environment is **digested**, not copied: the memo's key is a map key, and
 * an environment may carry a secret.
 */
function environmentIdentity(env: Record<string, string> | undefined): string {
  if (!env) return '';
  const entries = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (entries.length === 0) return '';
  return digest(entries.map(([key, value]) => `${key}=${value}`).join('\n'));
}

/**
 * The identity of a server's credential.
 *
 * The credential's value is **digested**, never copied.
 */
function credentialIdentity(credential: ResolvedCredential | undefined): string {
  if (!credential) return '';
  if (!credential.present) return 'absent';
  if (credential.value === undefined) return 'present';
  return `present:${digest(credential.value)}`;
}

/**
 * The identity of a server's configuration, for the memo.
 *
 * Two servers whose configurations differ in **any** of these are two
 * different servers: a server that was given a different environment, or a
 * different credential, is connected again rather than reusing the connection
 * that was made for the old one.
 */
export function mcpConfigKey(config: McpServerConfig): string {
  return JSON.stringify({
    type: config.type,
    command: config.command,
    args: config.args ?? [],
    url: config.url,
    cwd: config.cwd,
    env: environmentIdentity(config.env),
    credential: credentialIdentity(config.credential),
    connectionId: config.connectionId,
  });
}

/** The credential identity epoch the memos are bound to. */
export function getMcpIdentityEpoch(): number {
  return identityEpoch;
}

/**
 * Drop every memoized connect result because the credential identity changed.
 *
 * A credential change invalidates the connection rather than reusing it.
 */
export function evictAllMcpMemosOnIdentityChange(): number {
  identityEpoch += 1;
  for (const [name, memo] of [...connectMemos.entries()]) {
    const connection = memo.connection;
    connectMemos.delete(name);
    if (connection) void closeMcpConnection(connection);
  }
  return identityEpoch;
}

/**
 * Evict a memoized **failed** connect result so the server is retried.
 *
 * A failed memo is stale once it is older than `maxAgeMs`; the default of `0`
 * makes every failed memo stale.
 */
export function evictStaleFailedConnectMemoForServe(name: string, maxAgeMs = 0): boolean {
  const memo = connectMemos.get(name);
  if (!memo) return false;
  if (memo.connection) return false;
  if (memo.failure === undefined) return false;
  if (Date.now() - memo.at < maxAgeMs) return false;
  connectMemos.delete(name);
  return true;
}

/** Drop the memoized connect result of a server. */
export function discardMemoizedConnectResult(name: string): boolean {
  const memo = connectMemos.get(name);
  if (!memo) return false;
  connectMemos.delete(name);
  if (memo.connection) void closeMcpConnection(memo.connection);
  return true;
}

/** Whether a server has a live connection. */
export function hasLiveConnection(name: string): boolean {
  const memo = connectMemos.get(name);
  return memo?.connection?.isLive() === true;
}

/** Whether a connection attempt is still in flight. */
export function hasUnsettledDial(name: string): boolean {
  return unsettledDials.has(name);
}

/** The memoized connection of a server, when there is one. */
export function memoizedConnection(name: string): McpConnection | undefined {
  const memo = connectMemos.get(name);
  if (!memo) return undefined;
  if (!memo.connection?.isLive()) return undefined;
  if (memo.epoch !== identityEpoch) return undefined;
  return memo.connection;
}

/**
 * Connect to a server, reusing the memoized result when it is still valid.
 *
 * The memo is dropped when the credential identity epoch changes, when it goes
 * stale, or explicitly.
 */
export async function ensureConnectedClient(
  config: McpServerConfig,
  options: McpConnectOptions = {},
): Promise<McpConnection> {
  const epoch = identityEpoch;
  const key = mcpConfigKey(config);
  const memo = connectMemos.get(config.name);

  if (memo) {
    if (memo.epoch !== epoch) {
      connectMemos.delete(config.name);
      if (memo.connection) void closeMcpConnection(memo.connection);
    } else if (memo.connection?.isLive() && memo.configKey === key) {
      return memo.connection;
    } else if (options.retryFailed && memo.failure !== undefined) {
      connectMemos.delete(config.name);
    }
  }

  if (unsettledDials.has(config.name)) {
    const pending = pendingConnects.get(config.name);
    if (pending) return pending;
  }

  const attempt = (async (): Promise<McpConnection> => {
    try {
      const connection = await connectToServer(config, options);
      connectMemos.set(config.name, {
        name: config.name,
        configKey: key,
        epoch: identityEpoch,
        connection,
        at: Date.now(),
      });
      return connection;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      connectMemos.set(config.name, {
        name: config.name,
        configKey: key,
        epoch: identityEpoch,
        failure: message,
        at: Date.now(),
      });
      emitMcpServerConnectionEvent({ type: 'failed', server: config.name, error: message });
      throw error;
    }
  })();

  pendingConnects.set(config.name, attempt);
  unsettledDials.add(config.name);
  try {
    return await attempt;
  } finally {
    unsettledDials.delete(config.name);
    if (pendingConnects.get(config.name) === attempt) pendingConnects.delete(config.name);
  }
}

const pendingConnects = new Map<string, Promise<McpConnection>>();

/* -------------------------------------------------------------------------- */
/* The teardown                                                               */
/* -------------------------------------------------------------------------- */

const closedConnections = new WeakSet<McpConnection>();

/**
 * Close a connection and report the close.
 *
 * A connection is closed once: the second close does not report a second
 * event. The event is published when the close is **carried out**, so a caller
 * that awaits the close has seen it.
 */
export async function closeMcpConnection(connection: McpConnection): Promise<void> {
  if (closedConnections.has(connection)) {
    await connection.close().catch(() => undefined);
    return;
  }
  closedConnections.add(connection);
  emitMcpServerConnectionEvent({ type: 'closed', server: connection.name });
  await connection.close().catch(() => undefined);
}

/**
 * Detach a connection from its owner and close it.
 *
 * The connection is removed from the memo first, so a later connect does not
 * hand the closed connection out again.
 */
export async function detachAndCloseConnection(connection: McpConnection): Promise<void> {
  discardMemoizedConnectResult(connection.name);
  await closeMcpConnection(connection);
}

/** Dispose a connection that is already detached. */
export async function disposeServerConnectionDetached(connection: McpConnection): Promise<void> {
  await closeMcpConnection(connection);
}

/** Close every connected client. */
export async function cleanupConnectedMcpClients(): Promise<void> {
  const connections = [...connectMemos.values()].map((memo) => memo.connection);
  connectMemos.clear();
  for (const connection of connections) {
    if (!connection) continue;
    await closeMcpConnection(connection);
  }
}

/* -------------------------------------------------------------------------- */
/* The events                                                                 */
/* -------------------------------------------------------------------------- */

/** A connection event. */
export interface McpServerConnectionEvent {
  /** What happened. */
  type: 'connected' | 'failed' | 'closed';
  /** The server it happened to. */
  server: string;
  /** The negotiated protocol revision, when there was one. */
  protocolVersion?: string;
  /** The failure, when the event is a failure. */
  error?: string;
  /** When it happened. */
  at: number;
}

const connectionEventListeners = new Set<(event: McpServerConnectionEvent) => void>();

/** Listen for connection events. */
export function onMcpServerConnectionEvent(
  listener: (event: McpServerConnectionEvent) => void,
): () => void {
  connectionEventListeners.add(listener);
  return () => {
    connectionEventListeners.delete(listener);
  };
}

/** Publish a connection event. */
export function emitMcpServerConnectionEvent(
  event: {
    type: McpServerConnectionEvent['type'];
    server: string;
    protocolVersion?: string;
    error?: string;
  },
): McpServerConnectionEvent {
  const published: McpServerConnectionEvent = { ...event, at: Date.now() };
  for (const listener of [...connectionEventListeners]) {
    try {
      listener(published);
    } catch {
      // A listener that throws must not break the connection.
    }
  }
  return published;
}

/* -------------------------------------------------------------------------- */
/* The reconnect                                                              */
/* -------------------------------------------------------------------------- */

/** The shape of a reconnect. */
export interface McpReconnectResult {
  /** Whether the server was reconnected. */
  reconnected: boolean;
  /** Whether the reconnect was deliberately inert. */
  inert: boolean;
  /** Why. */
  reason?: string;
}

/**
 * A reconnect that is deliberately inert.
 *
 * The target's reconnect is inert: it does not tear a working connection down
 * and rebuild it, so the shape says so.
 */
export function inertReconnectShape(server: string): McpReconnectResult {
  return {
    reconnected: false,
    inert: true,
    reason: `the reconnect of the MCP server "${server}" is deliberately inert`,
  };
}

/* -------------------------------------------------------------------------- */
/* The remote host lists                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Whether a host pattern matches a host.
 *
 * The match includes sub-domains: the pattern `example.com` matches
 * `api.example.com`.
 */
export function hostMatches(pattern: string, host: string): boolean {
  const normalizedPattern = pattern.trim().toLowerCase().replace(/^\*\./, '');
  const normalizedHost = host.trim().toLowerCase();
  if (normalizedPattern === '') return false;
  if (normalizedPattern === normalizedHost) return true;
  return normalizedHost.endsWith(`.${normalizedPattern}`);
}

/**
 * Whether a remote server's URL is allowed by the host's allow and deny lists.
 *
 * A deny list wins over an allow list.
 */
export function isRemoteHostAllowed(
  url: string,
  lists: { allow?: readonly string[]; deny?: readonly string[] } = {},
): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  for (const pattern of lists.deny ?? []) {
    if (hostMatches(pattern, host)) return false;
  }
  const allow = lists.allow ?? [];
  if (allow.length === 0) return true;
  return allow.some((pattern) => hostMatches(pattern, host));
}

/* -------------------------------------------------------------------------- */
/* The description changes                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The tools whose description changed.
 *
 * The target does **not** notify when a tool's description changes — the known
 * MCP gap — so this implementation computes the change and re-surfaces it, so a "rug
 * pull" cannot silently alter an approved tool's behaviour.
 */
export function detectToolDescriptionChanges(
  server: string,
  previous: readonly McpToolDefinition[],
  current: readonly McpToolDefinition[],
): McpToolDescriptionChange[] {
  const before = new Map<string, string>();
  for (const tool of previous) {
    if (typeof tool.name !== 'string') continue;
    before.set(tool.name, tool.description ?? '');
  }
  const changes: McpToolDescriptionChange[] = [];
  for (const tool of current) {
    if (typeof tool.name !== 'string') continue;
    if (!before.has(tool.name)) continue;
    const was = before.get(tool.name) ?? '';
    const now = tool.description ?? '';
    if (was === now) continue;
    changes.push({ server, tool: tool.name, previous: was, current: now });
  }
  return changes;
}

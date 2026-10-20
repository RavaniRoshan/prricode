/**
 * The MCP client: one connection to one MCP server.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("MCP, plugins, and
 * hooks" — "MCP transport" and "The MCP client lifecycle is observed"), and the
 * `CC-011` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## What is observed and reproduced here
 *
 *   - **The transport.** A stdio server is spawned with the configured command
 *     and `args`, with `cwd`, with `shell: false`, with `windowsHide` on
 *     Windows, with `stdio: ["pipe", "pipe", stderr ?? "inherit"]`, and with an
 *     environment merged from the parent environment plus the server's own `env`.
 *     A read error closes the transport.
 *   - **The protocol methods** are `initialize`, `tools/list` and `tools/call`.
 *   - **The tool naming** is `mcp__<server>__<tool>`, and `mcp__ide__executeCode`
 *     and `mcp__ide__getDiagnostics` are special-cased: they are exempt from the
 *     general "hide the `mcp__ide__` tools" filter.
 *   - **The lifecycle.** `connectToServer` and `ensureConnectedClient` are the
 *     entry points; a connect result is memoized, and the memo is dropped when
 *     the credential identity epoch changes, when it goes stale, or explicitly.
 *     `hasLiveConnection` reports a live connection and `hasUnsettledDial` a
 *     connection attempt that is still in flight.
 *   - **The capabilities** are fetched separately (`tools`, commands, resources,
 *     resource templates) and aggregated; a listing hydration path sits beside
 *     the fetch path, with a "discover prior" memo so a listing is not
 *     re-discovered.
 *   - **The tool composition** builds the tool the model sees and caps the
 *     instructions it carries.
 *   - **The auth failures** are classified, and the error body is inspected for
 *     a specific code.
 *   - **The four fetch variants** are the vendor first-party proxy, the first-party API,
 *     the CLI-owned bearer, and the CCR proxy.
 *   - **The four timeouts** are the armed-request timeout, the request timeout,
 *     the tool timeout and the tool *idle* timeout.
 *   - **The teardown** is detach-and-close, dispose-detached, and the clean-up of
 *     the connected clients.
 *
 * ## The two protocol eras
 *
 * The modern revision (`2026-07-28`) is **stateless**: it retires the
 * `initialize`/`initialized` handshake, adds `server/discover`, and carries the
 * protocol version, the client identity and the capabilities in `_meta` on every
 * request. This implementation therefore **probes for the modern revision first** and
 * falls back to the legacy `initialize` handshake only when the server does not
 * support it. `MCP_PROTOCOL_NEGOTIATION=legacy` is the opt-out, and it selects
 * the legacy path outright.
 *
 * The two version-error contracts are both implemented:
 *
 *   - the **server side** — an invalid or missing `MCP-Protocol-Version` header
 *     on an HTTP transport is an HTTP `400 Bad Request`
 *     (`checkMcpProtocolVersionHeader`);
 *   - the **client side** — an unsupported declared version is the JSON-RPC
 *     error `-32022` carrying a `supported` list, which the client retries
 *     (`McpRpcError` with `code === UNSUPPORTED_PROTOCOL_VERSION`).
 *
 * Neither may hang: every request carries a deadline.
 *
 * ## Implementation choices
 *
 * The audit does not pin these, so they are marked here:
 *
 *   - The **default timeouts** are `5 000` ms (armed request), `30 000` ms
 *     (request), `120 000` ms (tool) and `15 000` ms (tool idle). The request
 *     timeout's default is the research report's observed `MCP_TIMEOUT`; the
 *     others are this implementation's own.
 *   - The **instruction cap** is `2 000` characters.
 *   - The **fetch variants** are told apart by the URL they talk to and the
 *     headers they present; the two proxy variants refuse to forward the
 *     caller's own credentials to the proxy host.
 *   - The **listing hydration** records a "discover prior" for the server, so a
 *     listing that was already discovered is not discovered again.
 *
 * ## The credential
 *
 * **The client never resolves a credential itself.** It either receives one, or
 * asks the provider registry for one through `resolveConnectionCredential` — the
 * registry's guarded entry point, which is the only path to a secret. The client
 * never reads the environment, the filesystem or a keychain for a secret.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

import { resolveConnectionCredential, type ProviderRegistry } from '../../provider/registry.js';
import type { ResolvedCredential } from '../../provider/credentials.js';

/* -------------------------------------------------------------------------- */
/* The server configuration                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The server types this implementation accepts.
 *
 * The target's own types are `stdio` and `sdk` (audit §2.8); `http` and `sse`
 * are the **transports** the target also supports, and this implementation keeps them so
 * a configuration written for the target is not rejected.
 */
export type McpServerType = 'stdio' | 'sdk' | 'http' | 'sse';

/** A configured MCP server. */
export interface McpServerConfig {
  /** The server's name, as the configuration gives it. */
  name: string;
  /** How the server is reached. */
  type: McpServerType;
  /** The command to run, for a `stdio` server. */
  command?: string;
  /** The command's arguments. */
  args?: string[];
  /** The server's own environment, merged over the parent's. */
  env?: Record<string, string>;
  /** The endpoint, for an `http` or `sse` server. */
  url?: string;
  /** The working directory of the spawned process. */
  cwd?: string;
  /**
   * A credential the caller already resolved.
   *
   * **Additive** — the plan fixes the other members, and this one is how a
   * caller hands a secret to the client without the client resolving it.
   */
  credential?: ResolvedCredential;
  /**
   * The provider connection whose credential the client should ask the registry
   * for. The client never resolves a credential on its own.
   */
  connectionId?: string;
}

/** A tool the server exposes. */
export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  instructions?: string;
}

/** A command (prompt) the server exposes. */
export interface McpCommandDefinition {
  name: string;
  title?: string;
  description?: string;
}

/** A resource the server exposes. */
export interface McpResourceDefinition {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

/** A resource template the server exposes. */
export interface McpResourceTemplateDefinition {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

/** The capabilities of a server, fetched separately. */
export interface McpToolsCommandsAndResources {
  tools: McpToolDefinition[];
  commands: McpCommandDefinition[];
  resources: McpResourceDefinition[];
  resourceTemplates: McpResourceTemplateDefinition[];
}

/** A listing: everything the server exposes, known already. */
export interface McpListing extends McpToolsCommandsAndResources {
  /** The server the listing belongs to. */
  server: string;
}

/** A tool, as the model sees it. */
export interface McpToolSummary {
  name: string;
  title?: string;
}

/** The state of a configured server. */
export interface McpServerState {
  /** The server's name. */
  name: string;
  /** Where the server is in its lifecycle. */
  status: 'connecting' | 'ready' | 'failed' | 'disabled';
  /** The tools the model may call, by their composed name. */
  tools: McpToolSummary[];
  /** Why the server failed, when it did. */
  error?: string;
  /**
   * The negotiated protocol revision.
   *
   * **Additive** — the plan fixes the other members.
   */
  protocolVersion?: string;
  /**
   * The tool descriptions that changed under the model.
   *
   * **Additive.** This is this implementation's "rug pull" surfacing: the target does
   * *not* notify on a description change (the known MCP gap), so this implementation does.
   */
  descriptionChanges?: McpToolDescriptionChange[];
}

/** A tool whose description changed after the model saw it. */
export interface McpToolDescriptionChange {
  /** The server the tool belongs to. */
  server: string;
  /** The tool's name, as the server names it. */
  tool: string;
  /** The description the model saw. */
  previous: string;
  /** The description the server now advertises. */
  current: string;
}

/* -------------------------------------------------------------------------- */
/* The protocol revisions                                                     */
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
const LEGACY_ERA_VERSIONS: ReadonlySet<string> = new Set([
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
/* The timeouts                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The four timeouts, which are **distinct** from one another.
 *
 *   - the **armed-request timeout** is the deadline of the *connect* phase: the
 *     negotiation request is armed when it goes out and disarmed when its
 *     response arrives;
 *   - the **request timeout** is the deadline of an ordinary request
 *     (`tools/list`, `prompts/list`, `resources/list`);
 *   - the **tool timeout** is the deadline of a whole tool call;
 *   - the **tool idle timeout** is the longest a tool call may stay silent.
 *
 * Each of them bounds a different thing, so none of them is a second copy of
 * another.
 */
export interface McpTimeoutOptions {
  /** Armed when the connect request is sent, disarmed when its response arrives. */
  armedRequestTimeoutMs: number;
  /** The deadline of an ordinary request. */
  requestTimeoutMs: number;
  /** The deadline of a whole tool call. */
  toolTimeoutMs: number;
  /** The longest a tool call may stay silent. */
  toolIdleTimeoutMs: number;
}

/** This implementation's default timeouts. */
export const DEFAULT_MCP_TIMEOUTS: McpTimeoutOptions = Object.freeze({
  armedRequestTimeoutMs: 5_000,
  requestTimeoutMs: 30_000,
  toolTimeoutMs: 120_000,
  toolIdleTimeoutMs: 15_000,
});

/** The environment variable that carries the request timeout. */
export const MCP_TIMEOUT_ENV = 'MCP_TIMEOUT';

/** The environment variable that carries the connect timeout. */
export const MCP_CONNECT_TIMEOUT_ENV = 'MCP_CONNECT_TIMEOUT_MS';

/* -------------------------------------------------------------------------- */
/* The transport                                                              */
/* -------------------------------------------------------------------------- */

/** A JSON-RPC message on the wire. */
export interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/** A transport carries JSON-RPC messages. */
export interface McpTransport {
  /** Start the transport. */
  start(): Promise<void>;
  /** Send one message. */
  send(message: JsonRpcMessage): Promise<void>;
  /** Close the transport. */
  close(): Promise<void>;
  /** Called with every incoming message. */
  onmessage?: (message: JsonRpcMessage) => void;
  /** Called with a transport failure. */
  onerror?: (error: Error) => void;
  /** Called when the transport closes. */
  onclose?: () => void;
}

/** The process a stdio transport spawns. */
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * Wait for a spawned process to exit.
 *
 * The wait is bounded, so a process that ignores the kill signal cannot hang
 * the teardown.
 */
async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once('close', finish);
    const timer = setTimeout(finish, 1_000);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/** The options a stdio transport is created with. */
export interface StdioTransportOptions {
  /** The command to run. */
  command: string;
  /** The command's arguments. */
  args?: readonly string[];
  /** The working directory of the spawned process. */
  cwd?: string;
  /** The server's own environment, merged over the parent's. */
  env?: Record<string, string>;
  /** How the child's stderr is handled. */
  stderr?: 'pipe' | 'inherit';
  /** The spawn implementation, so a test can observe the spawn options. */
  spawnImpl?: SpawnImpl;
}

/**
 * The environment of a spawned server.
 *
 * It is the **parent's environment plus the server's own `env`**, exactly as the
 * target's `StdioClientTransport` builds it.
 */
function mergedEnvironment(own: Record<string, string> | undefined): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') merged[key] = value;
  }
  if (own) {
    for (const [key, value] of Object.entries(own)) {
      if (typeof value === 'string') merged[key] = value;
    }
  }
  return merged;
}

/**
 * The stdio transport.
 *
 * The process is spawned with `shell: false` — a server's command is never
 * handed to a shell — with `stdio: ["pipe", "pipe", stderr]`, and with the
 * merged environment. A read error closes the transport.
 */
export function createStdioTransport(options: StdioTransportOptions): McpTransport {
  const spawnImpl = options.spawnImpl ?? (nodeSpawn as unknown as SpawnImpl);
  let child: ChildProcess | undefined;
  let buffer = '';
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
  };

  const transport: McpTransport = {
    async start(): Promise<void> {
      const args = options.args ?? [];
      const spawned = spawnImpl(options.command, args, {
        cwd: options.cwd,
        env: mergedEnvironment(options.env),
        shell: false,
        windowsHide: process.platform === 'win32',
        stdio: ['pipe', 'pipe', options.stderr ?? 'inherit'],
      });
      child = spawned;

      const stdout = spawned.stdout;
      if (stdout) {
        stdout.setEncoding('utf8');
        stdout.on('data', (chunk: string) => {
          buffer += chunk;
          let newline = buffer.indexOf('\n');
          while (newline !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line.length > 0) {
              let message: JsonRpcMessage;
              try {
                message = JSON.parse(line) as JsonRpcMessage;
              } catch (error) {
                transport.onerror?.(
                  new Error(
                    `the MCP server wrote a line that is not JSON: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                );
                newline = buffer.indexOf('\n');
                continue;
              }
              transport.onmessage?.(message);
            }
            newline = buffer.indexOf('\n');
          }
        });
        stdout.on('error', (error: Error) => {
          // A read error closes the transport.
          transport.onerror?.(error);
          void transport.close();
        });
        stdout.on('end', () => {
          void transport.close();
        });
      }

      spawned.on('error', (error: Error) => {
        transport.onerror?.(error);
        void transport.close();
      });

      spawned.on('close', () => {
        void transport.close();
      });
    },

    async send(message: JsonRpcMessage): Promise<void> {
      const stdin = child?.stdin;
      if (!stdin || stdin.destroyed) {
        throw new Error('the MCP server process is not running');
      }
      stdin.write(`${JSON.stringify(message)}\n`);
    },

    async close(): Promise<void> {
      if (closed) return;
      close();
      const current = child;
      child = undefined;
      const stdin = current?.stdin;
      if (stdin && !stdin.destroyed) {
        stdin.end();
      }
      const stdout = current?.stdout;
      if (stdout && !stdout.destroyed) stdout.destroy();
      const stderr = current?.stderr;
      if (stderr && !stderr.destroyed) stderr.destroy();
      if (current && current.exitCode === null && current.signalCode === null) {
        current.kill();
      }
      if (current) await waitForExit(current);
      transport.onclose?.();
    },
  };

  return transport;
}

/** The options an HTTP transport is created with. */
export interface HttpMcpTransportOptions {
  /** The endpoint. */
  url: string;
  /** Extra headers. */
  headers?: Record<string, string>;
  /** The protocol version the client speaks. */
  protocolVersion?: string;
  /** The fetch implementation. */
  fetchImpl?: typeof fetch;
  /** The bearer token the client presents. */
  token?: string;
}

/**
 * The HTTP transport.
 *
 * It is the **stateless** shape the modern revision describes: every request is
 * a `POST` and the response is the reply. A `text/event-stream` response is
 * parsed as SSE; a `Mcp-Session-Id` the server hands out is echoed back.
 */
export function createHttpMcpTransport(options: HttpMcpTransportOptions): McpTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  let sessionId: string | undefined;
  let closed = false;

  const transport: McpTransport = {
    async start(): Promise<void> {
      closed = false;
    },

    async send(message: JsonRpcMessage): Promise<void> {
      if (closed) throw new Error('the MCP connection is closed');
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(options.headers ?? {}),
      };
      if (options.protocolVersion) headers[MCP_PROTOCOL_VERSION_HEADER] = options.protocolVersion;
      if (options.token) headers['authorization'] = `Bearer ${options.token}`;
      if (sessionId) headers['mcp-session-id'] = sessionId;

      const response = await fetchImpl(options.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
      });

      const handedOut = response.headers.get('mcp-session-id');
      if (handedOut) sessionId = handedOut;

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream')) {
        const body = await response.text();
        for (const payload of parseServerSentEvents(body)) {
          transport.onmessage?.(payload);
        }
        return;
      }

      const body = await response.text();
      if (body.trim() === '') return;
      try {
        transport.onmessage?.(JSON.parse(body) as JsonRpcMessage);
      } catch (error) {
        transport.onerror?.(
          new Error(
            `the MCP server answered with a body that is not JSON: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      transport.onclose?.();
    },
  };

  return transport;
}

/** The JSON-RPC payloads of an SSE body. */
function parseServerSentEvents(body: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  for (const block of body.split('\n\n')) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .join('\n');
    if (data === '') continue;
    try {
      messages.push(JSON.parse(data) as JsonRpcMessage);
    } catch {
      // A malformed event is ignored: it is not a protocol message.
    }
  }
  return messages;
}

/* -------------------------------------------------------------------------- */
/* The JSON-RPC peer                                                          */
/* -------------------------------------------------------------------------- */

/** A JSON-RPC error the server answered with. */
export class McpRpcError extends Error {
  /** The JSON-RPC error code. */
  readonly code: number;
  /** The error's data, when the server sent any. */
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'McpRpcError';
    this.code = code;
    this.data = data;
  }
}

/** A request that ran out of time. */
export class McpTimeoutError extends Error {
  /** Which of the four timeouts fired. */
  readonly kind: 'armedRequest' | 'request' | 'tool' | 'toolIdle';

  constructor(kind: McpTimeoutError['kind'], message: string) {
    super(message);
    this.name = 'McpTimeoutError';
    this.kind = kind;
  }
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PeerRequestOptions {
  armedTimeoutMs?: number;
  requestTimeoutMs?: number;
  idleTimeoutMs?: number;
}

/**
 * The JSON-RPC peer.
 *
 * It correlates responses with requests, arms the **armed-request timeout**
 * when a request goes out and disarms it when the response arrives, enforces
 * the **request timeout** as a deadline, and re-arms the **idle timeout** on
 * every message that arrives while a request is in flight.
 */
class McpPeer {
  readonly #transport: McpTransport;
  readonly #pending = new Map<string, PendingCall>();
  readonly #activityListeners = new Set<() => void>();
  #nextId = 1;
  #closed = false;
  #closeReason: string | undefined;

  constructor(transport: McpTransport) {
    this.#transport = transport;
    transport.onmessage = (message) => {
      this.#handle(message);
    };
    transport.onerror = (error) => {
      this.#failAll(error);
    };
    transport.onclose = () => {
      this.#closed = true;
      this.#closeReason = this.#closeReason ?? 'the MCP connection closed';
      this.#failAll(new Error(this.#closeReason));
    };
  }

  get closed(): boolean {
    return this.#closed;
  }

  request(method: string, params: unknown, options: PeerRequestOptions = {}): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error(this.#closeReason ?? 'the MCP connection is closed'));
    }
    const id = this.#nextId++;
    const key = String(id);

    return new Promise<unknown>((resolve, reject) => {
      let armed: NodeJS.Timeout | undefined;
      let deadline: NodeJS.Timeout | undefined;
      let idle: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        if (armed) clearTimeout(armed);
        if (deadline) clearTimeout(deadline);
        if (idle) clearTimeout(idle);
        this.#activityListeners.delete(onActivity);
      };

      const fail = (error: Error): void => {
        this.#pending.delete(key);
        cleanup();
        reject(error);
      };

      const onActivity = (): void => {
        if (!idle) return;
        clearTimeout(idle);
        idle = setTimeout(() => {
          fail(new McpTimeoutError('toolIdle', `the MCP request "${method}" was idle for too long`));
        }, options.idleTimeoutMs);
      };

      if (options.armedTimeoutMs !== undefined && options.armedTimeoutMs > 0) {
        armed = setTimeout(() => {
          fail(
            new McpTimeoutError(
              'armedRequest',
              `the MCP request "${method}" timed out after ${options.armedTimeoutMs} ms`,
            ),
          );
        }, options.armedTimeoutMs);
      }

      if (options.requestTimeoutMs !== undefined && options.requestTimeoutMs > 0) {
        deadline = setTimeout(() => {
          fail(
            new McpTimeoutError(
              'request',
              `the MCP request "${method}" timed out after ${options.requestTimeoutMs} ms`,
            ),
          );
        }, options.requestTimeoutMs);
      }

      if (options.idleTimeoutMs !== undefined && options.idleTimeoutMs > 0) {
        idle = setTimeout(() => {
          fail(
            new McpTimeoutError(
              'toolIdle',
              `the MCP request "${method}" was idle for too long`,
            ),
          );
        }, options.idleTimeoutMs);
        this.#activityListeners.add(onActivity);
      }

      this.#pending.set(key, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });

      this.#transport
        .send({ jsonrpc: '2.0', id, method, params })
        .catch((error: unknown) => {
          fail(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.#closed) {
      throw new Error(this.#closeReason ?? 'the MCP connection is closed');
    }
    await this.#transport.send({ jsonrpc: '2.0', method, params });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#closeReason = this.#closeReason ?? 'the MCP connection closed';
    await this.#transport.close();
  }

  #handle(message: JsonRpcMessage): void {
    if (typeof message !== 'object' || message === null) return;
    for (const listener of [...this.#activityListeners]) listener();

    const id = message.id;
    if (id === undefined || id === null) return;
    const key = String(id);
    const pending = this.#pending.get(key);
    if (!pending) return;
    this.#pending.delete(key);

    const error = message.error;
    if (error !== undefined && error !== null && typeof error === 'object') {
      const shape = error as Record<string, unknown>;
      const code = typeof shape['code'] === 'number' ? shape['code'] : -32603;
      const text =
        typeof shape['message'] === 'string' ? shape['message'] : 'the MCP server returned an error';
      pending.reject(new McpRpcError(code, text, shape['data']));
      return;
    }
    pending.resolve(message.result);
  }

  #failAll(error: Error): void {
    for (const pending of [...this.#pending.values()]) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* The connection                                                             */
/* -------------------------------------------------------------------------- */

/** A live connection to one MCP server. */
export interface McpConnection {
  /** The server's name. */
  readonly name: string;
  /** The configuration the connection was made from. */
  readonly config: McpServerConfig;
  /** The era the connection negotiated. */
  readonly era: McpProtocolEra;
  /** The negotiated protocol revision. */
  readonly protocolVersion: string;
  /** The server's own identity, when it reported one. */
  readonly serverInfo?: McpServerInfo;
  /** The server's capabilities, when it reported any. */
  readonly capabilities: Record<string, unknown>;
  /** The four timeouts the connection runs with. */
  readonly timeouts: McpTimeoutOptions;
  /** Whether the connection is still usable. */
  isLive(): boolean;
  /** Send a request and wait for its result. */
  request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  /** Send a notification. */
  notify(method: string, params?: unknown): Promise<void>;
  /** Call a tool. */
  callTool(
    name: string,
    args: unknown,
    options?: { timeoutMs?: number; idleTimeoutMs?: number },
  ): Promise<McpToolCallResult>;
  /** Close the connection. */
  close(): Promise<void>;
}

/** The identity a server reports. */
export interface McpServerInfo {
  name?: string;
  version?: string;
}

class McpServerConnection implements McpConnection {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly era: McpProtocolEra;
  readonly protocolVersion: string;
  readonly serverInfo: McpServerInfo | undefined;
  readonly capabilities: Record<string, unknown>;
  readonly timeouts: McpTimeoutOptions;
  readonly #peer: McpPeer;

  constructor(init: {
    name: string;
    config: McpServerConfig;
    era: McpProtocolEra;
    protocolVersion: string;
    serverInfo?: McpServerInfo;
    capabilities: Record<string, unknown>;
    timeouts: McpTimeoutOptions;
    peer: McpPeer;
  }) {
    this.name = init.name;
    this.config = init.config;
    this.era = init.era;
    this.protocolVersion = init.protocolVersion;
    this.serverInfo = init.serverInfo;
    this.capabilities = init.capabilities;
    this.timeouts = init.timeouts;
    this.#peer = init.peer;
  }

  isLive(): boolean {
    return !this.#peer.closed;
  }

  request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown> {
    // An ordinary request carries the **request timeout**. The armed-request
    // timeout belongs to the connect phase, where the request is *armed*.
    return this.#peer.request(method, params, {
      requestTimeoutMs: options?.timeoutMs ?? this.timeouts.requestTimeoutMs,
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.#peer.notify(method, params);
  }

  callTool(
    name: string,
    args: unknown,
    options?: { timeoutMs?: number; idleTimeoutMs?: number },
  ): Promise<McpToolCallResult> {
    // A tool call carries the **tool timeout** and the **tool idle timeout**,
    // and never the connect-phase armed timeout.
    return this.#peer
      .request(
        'tools/call',
        { name, arguments: args ?? {} },
        {
          requestTimeoutMs: options?.timeoutMs ?? this.timeouts.toolTimeoutMs,
          idleTimeoutMs: options?.idleTimeoutMs ?? this.timeouts.toolIdleTimeoutMs,
        },
      )
      .then((raw) => normalizeToolCallResult(raw));
  }

  async close(): Promise<void> {
    await this.#peer.close();
  }
}

/* -------------------------------------------------------------------------- */
/* The negotiation                                                            */
/* -------------------------------------------------------------------------- */

const CLIENT_INFO = Object.freeze({ name: 'prricode', version: '0.1.0' });

const CLIENT_CAPABILITIES = Object.freeze({ tools: {}, resources: {} });

interface NegotiationResult {
  era: McpProtocolEra;
  protocolVersion: string;
  serverInfo?: McpServerInfo;
  capabilities: Record<string, unknown>;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readServerInfo(value: unknown): McpServerInfo | undefined {
  const record = readRecord(value);
  if (!record) return undefined;
  const info: McpServerInfo = {};
  if (typeof record['name'] === 'string') info.name = record['name'];
  if (typeof record['version'] === 'string') info.version = record['version'];
  return info;
}

function readCapabilities(value: unknown): Record<string, unknown> {
  return readRecord(value) ?? {};
}

/** The versions a `-32022` error says the server supports. */
function readSupportedVersions(error: unknown): string[] {
  if (!(error instanceof McpRpcError)) return [];
  const data = readRecord(error.data);
  if (!data) return [];
  for (const key of ['supported', 'protocolVersions', 'supportedProtocolVersions']) {
    const value = data[key];
    if (!Array.isArray(value)) continue;
    const versions = value.filter((entry): entry is string => typeof entry === 'string');
    if (versions.length > 0) return versions;
  }
  return [];
}

/** Whether an error is the unsupported-protocol-version error. */
export function isUnsupportedProtocolVersionError(error: unknown): boolean {
  return error instanceof McpRpcError && error.code === UNSUPPORTED_PROTOCOL_VERSION;
}

/** Whether an error is the method-not-found error. */
export function isMethodNotFoundError(error: unknown): boolean {
  return error instanceof McpRpcError && error.code === METHOD_NOT_FOUND;
}

async function negotiate(
  peer: McpPeer,
  era: McpProtocolEra,
  timeouts: McpTimeoutOptions,
): Promise<NegotiationResult> {
  if (era === 'legacy') {
    return legacyHandshake(peer, LEGACY_PROTOCOL_VERSION, timeouts);
  }

  // The modern revision is probed **first**.
  const modernParams = {
    _meta: {
      protocolVersion: MODERN_PROTOCOL_VERSION,
      clientInfo: CLIENT_INFO,
      capabilities: CLIENT_CAPABILITIES,
    },
  };

  try {
    const result = await peer.request('server/discover', modernParams, {
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
        return legacyHandshake(peer, legacyVersion, timeouts);
      }
      const modernVersion = supported.find((version) => !LEGACY_ERA_VERSIONS.has(version));
      if (modernVersion) {
        const result = await peer.request(
          'server/discover',
          {
            _meta: {
              protocolVersion: modernVersion,
              clientInfo: CLIENT_INFO,
              capabilities: CLIENT_CAPABILITIES,
            },
          },
          {
            armedTimeoutMs: timeouts.armedRequestTimeoutMs,
            requestTimeoutMs: timeouts.requestTimeoutMs,
          },
        );
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
      throw error;
    }
    if (isMethodNotFoundError(error)) {
      // The server does not know the modern probe: fall back to the legacy
      // handshake.
      return legacyHandshake(peer, LEGACY_PROTOCOL_VERSION, timeouts);
    }
    throw error;
  }
}

async function legacyHandshake(
  peer: McpPeer,
  version: string,
  timeouts: McpTimeoutOptions,
): Promise<NegotiationResult> {
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

/* -------------------------------------------------------------------------- */
/* Connecting                                                                 */
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
}

/** The resolved timeouts. */
export function resolveMcpTimeouts(
  options: McpConnectOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): McpTimeoutOptions {
  const overrides = options.timeouts ?? {};
  const timeouts: McpTimeoutOptions = { ...DEFAULT_MCP_TIMEOUTS };
  for (const key of [
    'armedRequestTimeoutMs',
    'requestTimeoutMs',
    'toolTimeoutMs',
    'toolIdleTimeoutMs',
  ] as const) {
    const value = overrides[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      timeouts[key] = value;
    }
  }
  const fromEnv = Number(env[MCP_TIMEOUT_ENV]);
  if (overrides.requestTimeoutMs === undefined && Number.isFinite(fromEnv) && fromEnv > 0) {
    timeouts.requestTimeoutMs = fromEnv;
  }
  // The armed-request timeout is the timeout of the *connect* phase, so it
  // follows the connect timeout the target's environment reference names.
  const connectFromEnv = Number(env[MCP_CONNECT_TIMEOUT_ENV]);
  if (
    overrides.armedRequestTimeoutMs === undefined &&
    Number.isFinite(connectFromEnv) &&
    connectFromEnv > 0
  ) {
    timeouts.armedRequestTimeoutMs = connectFromEnv;
  }
  return timeouts;
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
    throw new Error('an MCP server configuration needs a non-empty name');
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
      protocolVersion: MODERN_PROTOCOL_VERSION,
      ...(credential?.present && credential.value !== undefined ? { token: credential.value } : {}),
    });
  }
  throw new Error(
    `the MCP server "${config.name}" has the type "${config.type}", which needs a transport factory`,
  );
}

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

  let negotiation: NegotiationResult;
  try {
    negotiation = await negotiate(peer, era, timeouts);
  } catch (error) {
    await peer.close().catch(() => undefined);
    throw error;
  }

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

  emitMcpServerConnectionEvent({ type: 'connected', server: config.name, protocolVersion: connection.protocolVersion });
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

/** The identity of a server's configuration, for the memo. */
export function mcpConfigKey(config: McpServerConfig): string {
  return JSON.stringify({
    type: config.type,
    command: config.command,
    args: config.args ?? [],
    url: config.url,
    cwd: config.cwd,
  });
}

/** The identity of a server's configuration, for the memo. */
function configKey(config: McpServerConfig): string {
  return mcpConfigKey(config);
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
    if (connection) void connection.close().catch(() => undefined);
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
  if (memo.connection) void memo.connection.close().catch(() => undefined);
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
  const key = configKey(config);
  const memo = connectMemos.get(config.name);

  if (memo) {
    if (memo.epoch !== epoch) {
      connectMemos.delete(config.name);
      if (memo.connection) void memo.connection.close().catch(() => undefined);
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
/* The capabilities                                                            */
/* -------------------------------------------------------------------------- */

function readToolList(result: unknown): McpToolDefinition[] {
  const record = readRecord(result);
  const list = record?.['tools'];
  if (!Array.isArray(list)) return [];
  const tools: McpToolDefinition[] = [];
  for (const entry of list) {
    const tool = readRecord(entry);
    if (!tool) continue;
    const name = tool['name'];
    if (typeof name !== 'string' || name === '') continue;
    const definition: McpToolDefinition = { name };
    if (typeof tool['title'] === 'string') definition.title = tool['title'];
    if (typeof tool['description'] === 'string') definition.description = tool['description'];
    if (tool['inputSchema'] !== undefined) definition.inputSchema = tool['inputSchema'];
    if (typeof tool['instructions'] === 'string') definition.instructions = tool['instructions'];
    tools.push(definition);
  }
  return tools;
}

function readCommandList(result: unknown): McpCommandDefinition[] {
  const record = readRecord(result);
  const list = record?.['prompts'] ?? record?.['commands'];
  if (!Array.isArray(list)) return [];
  const commands: McpCommandDefinition[] = [];
  for (const entry of list) {
    const command = readRecord(entry);
    if (!command) continue;
    const name = command['name'];
    if (typeof name !== 'string' || name === '') continue;
    const definition: McpCommandDefinition = { name };
    if (typeof command['title'] === 'string') definition.title = command['title'];
    if (typeof command['description'] === 'string') definition.description = command['description'];
    commands.push(definition);
  }
  return commands;
}

function readResourceList(result: unknown): McpResourceDefinition[] {
  const record = readRecord(result);
  const list = record?.['resources'];
  if (!Array.isArray(list)) return [];
  const resources: McpResourceDefinition[] = [];
  for (const entry of list) {
    const resource = readRecord(entry);
    if (!resource) continue;
    const uri = resource['uri'];
    const name = resource['name'];
    if (typeof uri !== 'string' || typeof name !== 'string') continue;
    const definition: McpResourceDefinition = { uri, name };
    if (typeof resource['title'] === 'string') definition.title = resource['title'];
    if (typeof resource['description'] === 'string') definition.description = resource['description'];
    if (typeof resource['mimeType'] === 'string') definition.mimeType = resource['mimeType'];
    resources.push(definition);
  }
  return resources;
}

function readResourceTemplateList(result: unknown): McpResourceTemplateDefinition[] {
  const record = readRecord(result);
  const list = record?.['resourceTemplates'];
  if (!Array.isArray(list)) return [];
  const templates: McpResourceTemplateDefinition[] = [];
  for (const entry of list) {
    const template = readRecord(entry);
    if (!template) continue;
    const uriTemplate = template['uriTemplate'];
    const name = template['name'];
    if (typeof uriTemplate !== 'string' || typeof name !== 'string') continue;
    const definition: McpResourceTemplateDefinition = { uriTemplate, name };
    if (typeof template['title'] === 'string') definition.title = template['title'];
    if (typeof template['description'] === 'string') definition.description = template['description'];
    if (typeof template['mimeType'] === 'string') definition.mimeType = template['mimeType'];
    templates.push(definition);
  }
  return templates;
}

/** The tools of a connected client. */
export async function fetchToolsForClient(connection: McpConnection): Promise<McpToolDefinition[]> {
  return readToolList(await connection.request('tools/list', {}));
}

/** The commands of a connected client. */
export async function fetchCommandsForClient(
  connection: McpConnection,
): Promise<McpCommandDefinition[]> {
  return readCommandList(await connection.request('prompts/list', {}));
}

/** The resources of a connected client. */
export async function fetchResourcesForClient(
  connection: McpConnection,
): Promise<McpResourceDefinition[]> {
  return readResourceList(await connection.request('resources/list', {}));
}

/** The resource templates of a connected client. */
export async function fetchResourceTemplatesForClient(
  connection: McpConnection,
): Promise<McpResourceTemplateDefinition[]> {
  return readResourceTemplateList(await connection.request('resources/templates/list', {}));
}

/** The capabilities of a connected client, fetched separately and aggregated. */
export async function getMcpToolsCommandsAndResources(
  connection: McpConnection,
): Promise<McpToolsCommandsAndResources> {
  const [tools, commands, resources, resourceTemplates] = await Promise.all([
    fetchToolsForClient(connection),
    fetchCommandsForClient(connection),
    fetchResourcesForClient(connection),
    fetchResourceTemplatesForClient(connection),
  ]);
  return { tools, commands, resources, resourceTemplates };
}

/* -------------------------------------------------------------------------- */
/* The listing hydration                                                      */
/* -------------------------------------------------------------------------- */

const discoveredServers = new Set<string>();

/** Whether a server's listing has already been discovered. */
export function getRememberedDiscoverPrior(server: string): boolean {
  return discoveredServers.has(server);
}

/**
 * Whether a listing has already been discovered.
 *
 * A listing that was already discovered is **not** discovered again.
 */
export function getListingDiscoverPrior(listing: McpListing): boolean {
  return getRememberedDiscoverPrior(listing.server);
}

/** Record that a server's listing was discovered. */
export function rememberDiscoverPrior(server: string): void {
  discoveredServers.add(server);
}

/** Hydrate the tools of a listing, and record the discover prior. */
export function hydrateToolsFromListing(listing: McpListing): McpToolDefinition[] {
  rememberDiscoverPrior(listing.server);
  return [...listing.tools];
}

/** Hydrate the commands of a listing, and record the discover prior. */
export function hydrateCommandsFromListing(listing: McpListing): McpCommandDefinition[] {
  rememberDiscoverPrior(listing.server);
  return [...listing.commands];
}

/* -------------------------------------------------------------------------- */
/* The tool composition                                                       */
/* -------------------------------------------------------------------------- */

/** The `mcp__ide__` tools the target special-cases. */
export const IDE_MCP_TOOL_NAMES: readonly string[] = Object.freeze([
  'mcp__ide__executeCode',
  'mcp__ide__getDiagnostics',
]);

/** The name the model calls an MCP tool by. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** Whether a tool name belongs to the IDE server. */
export function isIdeMcpTool(name: string): boolean {
  return name.startsWith('mcp__ide__');
}

/**
 * Whether a tool is hidden by the general "hide the `mcp__ide__` tools" filter.
 *
 * The two special-cased tools are **exempt**: the target excludes
 * `mcp__ide__executeCode` and `mcp__ide__getDiagnostics` from the filter.
 */
export function shouldHideMcpTool(name: string): boolean {
  if (!isIdeMcpTool(name)) return false;
  return !IDE_MCP_TOOL_NAMES.includes(name);
}

/** The maximum number of instructions a composed tool carries. */
export const MAX_MCP_INSTRUCTIONS_LENGTH = 2000;

/** The marker that says the instructions were truncated. */
const MCP_INSTRUCTIONS_TRUNCATED_MARKER = '…[truncated]';

/**
 * Cap the instructions a tool carries.
 *
 * The result is **never longer than `maxLength`**: the text that does not fit
 * is cut and the truncation marker takes its place, so the model knows the text
 * it sees is not the whole text.
 */
export function capMcpInstructions(
  instructions: string | undefined,
  maxLength: number = MAX_MCP_INSTRUCTIONS_LENGTH,
): string | undefined {
  if (instructions === undefined) return undefined;
  if (instructions.length <= maxLength) return instructions;
  if (maxLength <= MCP_INSTRUCTIONS_TRUNCATED_MARKER.length) {
    return instructions.slice(0, Math.max(0, maxLength));
  }
  return (
    instructions.slice(0, maxLength - MCP_INSTRUCTIONS_TRUNCATED_MARKER.length) +
    MCP_INSTRUCTIONS_TRUNCATED_MARKER
  );
}

/** The tool, as the model sees it. */
export interface McpComposedTool {
  /** The composed name, `mcp__<server>__<tool>`. */
  name: string;
  /** The server the tool belongs to. */
  server: string;
  /** The tool's name, as the server names it. */
  tool: string;
  /** The tool's title. */
  title?: string;
  /** The tool's description. */
  description: string;
  /** The tool's input schema. */
  inputSchema: unknown;
  /** The tool's instructions, capped. */
  instructions?: string;
}

/** Compose the tool the model sees. */
export function composeMcpTool(
  server: string,
  tool: McpToolDefinition,
  options: { maxInstructionsLength?: number } = {},
): McpComposedTool {
  const composed: McpComposedTool = {
    name: mcpToolName(server, tool.name),
    server,
    tool: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? { type: 'object' },
  };
  if (tool.title !== undefined) composed.title = tool.title;
  const instructions = capMcpInstructions(tool.instructions, options.maxInstructionsLength);
  if (instructions !== undefined) composed.instructions = instructions;
  return composed;
}

/* -------------------------------------------------------------------------- */
/* Calling a tool                                                             */
/* -------------------------------------------------------------------------- */

/** The result of a tool call. */
export interface McpToolCallResult {
  /** The content blocks the server returned. */
  content: unknown[];
  /** Whether the server reported an error. */
  isError: boolean;
  /** The structured content, when the server returned any. */
  structuredContent?: unknown;
  /** The raw result. */
  raw: unknown;
}

function normalizeToolCallResult(raw: unknown): McpToolCallResult {
  const record = readRecord(raw) ?? {};
  const content = Array.isArray(record['content']) ? (record['content'] as unknown[]) : [];
  const result: McpToolCallResult = {
    content,
    isError: record['isError'] === true,
    raw,
  };
  if (record['structuredContent'] !== undefined) {
    result.structuredContent = record['structuredContent'];
  }
  return result;
}

/** A URL the server asks the user to visit. */
export interface McpUrlElicitation {
  url: string;
  message?: string;
}

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/;

/** The URL elicitation a result carries, when it carries one. */
export function urlElicitationFromResult(result: McpToolCallResult): McpUrlElicitation | undefined {
  const record = readRecord(result.raw);
  const elicitation = readRecord(record?.['elicitation']) ?? readRecord(record?.['urlElicitation']);
  if (elicitation) {
    const url = elicitation['url'];
    if (typeof url === 'string' && url !== '') {
      const message = elicitation['message'];
      return typeof message === 'string' ? { url, message } : { url };
    }
  }
  if (!result.isError) return undefined;
  for (const block of result.content) {
    const entry = readRecord(block);
    if (!entry) continue;
    if (entry['type'] !== 'text') continue;
    const text = entry['text'];
    if (typeof text !== 'string') continue;
    const match = URL_PATTERN.exec(text);
    if (match?.[0]) {
      return { url: match[0], message: text };
    }
  }
  return undefined;
}

/** Whether a result is a URL elicitation. */
export function isUrlElicitationResult(result: McpToolCallResult): boolean {
  return urlElicitationFromResult(result) !== undefined;
}

/** The options a tool call runs with. */
export interface McpCallOptions {
  /** The deadline of the call. */
  timeoutMs?: number;
  /** The longest the call may stay silent. */
  idleTimeoutMs?: number;
  /** Called with the URL the server asked the user to visit. */
  onUrlElicitation?: (elicitation: McpUrlElicitation) => void | Promise<void>;
}

/** Call a tool. */
export async function callMCPTool(
  connection: McpConnection,
  name: string,
  args: unknown,
  options: McpCallOptions = {},
): Promise<McpToolCallResult> {
  return connection.callTool(name, args, {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
  });
}

/**
 * Call a tool, retrying once when the server elicits a URL.
 *
 * The retry happens **once**: a server that elicits a URL a second time has
 * answered, and the answer is returned.
 */
export async function callMCPToolWithUrlElicitationRetry(
  connection: McpConnection,
  name: string,
  args: unknown,
  options: McpCallOptions = {},
): Promise<McpToolCallResult> {
  const first = await callMCPTool(connection, name, args, options);
  const elicitation = urlElicitationFromResult(first);
  if (!elicitation) return first;
  if (!options.onUrlElicitation) return first;
  await options.onUrlElicitation(elicitation);
  return callMCPTool(connection, name, args, options);
}

/* -------------------------------------------------------------------------- */
/* The auth failures                                                          */
/* -------------------------------------------------------------------------- */

/** The classes of an auth failure. */
export type McpAuthFailureKind =
  | 'missing_credential'
  | 'expired_token'
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_token'
  | 'network'
  | 'unknown';

/** The HTTP failure of an MCP request. */
export interface McpHttpFailure {
  status?: number;
  body?: string;
  message?: string;
}

/**
 * Classify an auth failure.
 *
 * A `401` whose body names an expired token is an `expired_token`; a `401` is
 * an `unauthorized`; a `403` is a `forbidden`; a connection failure is a
 * `network` failure. Everything else is `unknown`.
 */
export function classifyMcpAuthFailure(error: unknown): McpAuthFailureKind {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const status = typeof record['status'] === 'number' ? record['status'] : undefined;
    const body = typeof record['body'] === 'string' ? record['body'] : undefined;
    const message = typeof record['message'] === 'string' ? record['message'] : undefined;

    if (status === 401) {
      if (
        (body !== undefined && hasEraCodeInHttpErrorBody(body, 'authentication_error')) ||
        (message !== undefined && /expired/i.test(message))
      ) {
        return 'expired_token';
      }
      return 'unauthorized';
    }
    if (status === 403) return 'forbidden';
    if (status === 402) return 'invalid_token';
    if (status === undefined && message !== undefined && /no credential|missing credential/i.test(message)) {
      return 'missing_credential';
    }
    if (message !== undefined && /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|fetch failed/i.test(message)) {
      return 'network';
    }
    return 'unknown';
  }
  if (error instanceof Error) {
    if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|fetch failed/i.test(error.message)) {
      return 'network';
    }
    return 'unknown';
  }
  return 'unknown';
}

/**
 * Whether an HTTP error body carries a specific code.
 *
 * The body may be a string or a parsed object; the code is looked for in the
 * body's own `code` and `type` fields, in the `error` object's own `code` and
 * `type` fields, and — as a last resort — in the body's own text.
 */
export function hasEraCodeInHttpErrorBody(body: unknown, code: string): boolean {
  if (typeof code !== 'string' || code === '') return false;
  if (typeof body === 'string') return body.includes(code);
  const record = readRecord(body);
  if (!record) return false;
  for (const key of ['code', 'type']) {
    if (Object.hasOwn(record, key) && record[key] === code) return true;
  }
  const nested = readRecord(record['error']);
  if (nested) {
    for (const key of ['code', 'type']) {
      if (Object.hasOwn(nested, key) && nested[key] === code) return true;
    }
  }
  try {
    return JSON.stringify(record).includes(code);
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* The fetch variants                                                         */
/* -------------------------------------------------------------------------- */

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
      next['x-claude-ai-proxy'] = '1';
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
      next['anthropic-version'] = '2023-06-01';
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
      next['x-ccr-proxy'] = '1';
      if (options.token !== undefined) next['authorization'] = `Bearer ${options.token}`;
      return { ...next, ...(options.headers ?? {}) };
    },
    options,
  );
}

/* -------------------------------------------------------------------------- */
/* The teardown                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Detach a connection from its owner and close it.
 *
 * The connection is removed from the memo first, so a later connect does not
 * hand the closed connection out again.
 */
export async function detachAndCloseConnection(connection: McpConnection): Promise<void> {
  discardMemoizedConnectResult(connection.name);
  await connection.close();
}

/** Dispose a connection that is already detached. */
export async function disposeServerConnectionDetached(connection: McpConnection): Promise<void> {
  await connection.close();
}

/** Close every connected client. */
export async function cleanupConnectedMcpClients(): Promise<void> {
  const connections = [...connectMemos.values()].map((memo) => memo.connection);
  connectMemos.clear();
  for (const connection of connections) {
    if (!connection) continue;
    await connection.close().catch(() => undefined);
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
  event: { type: McpServerConnectionEvent['type']; server: string; protocolVersion?: string; error?: string },
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

/**
 * The MCP transports.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("MCP, plugins, and
 * hooks" — "MCP transport"), and the `CC-011` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * This module owns **one** responsibility: carrying JSON-RPC messages to a
 * server and back. There are two transports:
 *
 *   - the **stdio** transport, which spawns the configured command;
 *   - the **HTTP** transport, which posts every message to the endpoint.
 *
 * ## What is observed and reproduced here
 *
 *   - A stdio server is spawned with the configured command and `args`, with
 *     `cwd`, with `shell: false`, with `windowsHide` on Windows, with
 *     `stdio: ["pipe", "pipe", stderr ?? "inherit"]`, and with an environment
 *     merged from the parent environment plus the server's own `env`.
 *   - A read error closes the transport.
 *   - The HTTP transport is the **stateless** shape the modern revision
 *     describes: every request is a `POST` and the response is the reply. A
 *     `text/event-stream` response is parsed as SSE; a `Mcp-Session-Id` the
 *     server hands out is echoed back.
 *
 * ## The protocol-version header
 *
 * The HTTP transport presents the **negotiated** protocol version, not a
 * hard-coded one. The negotiation owns the version, and it tells the transport
 * which version to present before every request it makes — so a legacy-era
 * connection presents the legacy version and a legacy-only server does not
 * answer `400`.
 *
 * ## Implementation choices
 *
 * The audit does not pin these, so they are marked here:
 *
 *   - The **`http` and `sse` types** are a widening of the target's own
 *     `stdio`/`sdk` types: the target also speaks the two network transports,
 *     and this implementation keeps them so a configuration written for the target is not
 *     rejected. The `sse` type uses the **same** HTTP transport as `http` — a
 *     `POST` whose answer may be an SSE body — rather than a long-lived event
 *     stream, because this implementation's own servers are request/response.
 *   - The **HTTP transport fails closed** on a non-2xx answer: it raises an
 *     `McpHttpStatusError` carrying the status and the body, rather than
 *     handing the peer a body it cannot correlate. The negotiation reads that
 *     error: a `400` on the modern probe means the server does not speak the
 *     modern revision, and the client falls back to the legacy handshake.
 *   - The **stdio transport's environment** is the parent's environment plus
 *     the server's own `env`, with the server's own entries winning.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

import { MCP_PROTOCOL_VERSION_HEADER } from './protocol.js';

/* -------------------------------------------------------------------------- */
/* The wire                                                                   */
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
  /**
   * Present the given protocol version.
   *
   * The negotiation calls this before every request it makes, so the version
   * the transport presents is always the one the negotiation is speaking.
   * A transport that does not speak a version header ignores it.
   */
  setProtocolVersion?(version: string): void;
}

/** The process a stdio transport spawns. */
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * The default spawn implementation.
 *
 * It is a typed wrapper rather than a cast, so the signature is checked.
 */
const defaultSpawn: SpawnImpl = (command, args, options) => nodeSpawn(command, args, options);

/* -------------------------------------------------------------------------- */
/* The stdio transport                                                        */
/* -------------------------------------------------------------------------- */

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
  const spawnImpl = options.spawnImpl ?? defaultSpawn;
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

/* -------------------------------------------------------------------------- */
/* The HTTP transport                                                         */
/* -------------------------------------------------------------------------- */

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
 * An HTTP answer the transport cannot use.
 *
 * A non-2xx answer is not a protocol message, so the transport raises this
 * rather than handing the peer a body it cannot correlate.
 */
export class McpHttpStatusError extends Error {
  /** The HTTP status the server answered with. */
  readonly status: number;
  /** The body the server answered with. */
  readonly body: string;

  constructor(status: number, body: string, url: string) {
    super(`the MCP server at "${url}" answered with the HTTP status ${status}`);
    this.name = 'McpHttpStatusError';
    this.status = status;
    this.body = body;
  }
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
  let protocolVersion = options.protocolVersion;

  const transport: McpTransport = {
    async start(): Promise<void> {
      closed = false;
    },

    setProtocolVersion(version: string): void {
      protocolVersion = version;
    },

    async send(message: JsonRpcMessage): Promise<void> {
      if (closed) throw new Error('the MCP connection is closed');
      // The container has a null prototype, so a header whose name is
      // `__proto__` is an ordinary header rather than a prototype assignment.
      const headers: Record<string, string> = Object.create(null) as Record<string, string>;
      headers['content-type'] = 'application/json';
      headers['accept'] = 'application/json, text/event-stream';
      for (const [key, value] of Object.entries(options.headers ?? {})) {
        headers[key] = value;
      }
      if (protocolVersion) headers[MCP_PROTOCOL_VERSION_HEADER] = protocolVersion;
      if (options.token) headers['authorization'] = `Bearer ${options.token}`;
      if (sessionId) headers['mcp-session-id'] = sessionId;

      const response = await fetchImpl(options.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
      });

      const handedOut = response.headers.get('mcp-session-id');
      if (handedOut) sessionId = handedOut;

      const body = await response.text();

      if (!response.ok) {
        throw new McpHttpStatusError(response.status, body, options.url);
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream')) {
        for (const payload of parseServerSentEvents(body)) {
          transport.onmessage?.(payload);
        }
        return;
      }

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

/**
 * The JSON-RPC peer.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("MCP, plugins, and
 * hooks" — "MCP transport"), and the `CC-011` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * This module owns **one** responsibility: the request/response correlation
 * over a transport, and the deadlines each request carries.
 *
 * The peer correlates responses with requests, arms the **armed-request
 * timeout** when a request goes out and disarms it when the response arrives,
 * enforces the **request timeout** as a deadline, and re-arms the **idle
 * timeout** on every message that arrives while a request is in flight.
 *
 * A request may carry **one** deadline, and the deadline decides the kind of
 * the timeout it raises: the ordinary request timeout raises a `request`
 * timeout, and the tool timeout raises a `tool` timeout. The two are never
 * conflated, so a caller can tell a tool that ran out of time from a listing
 * that ran out of time.
 */

import { METHOD_NOT_FOUND, UNSUPPORTED_PROTOCOL_VERSION } from './protocol.js';
import { McpTimeoutError } from './timeouts.js';
import type { JsonRpcMessage, McpTransport } from './transport.js';

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

/** Whether an error is the unsupported-protocol-version error. */
export function isUnsupportedProtocolVersionError(error: unknown): boolean {
  return error instanceof McpRpcError && error.code === UNSUPPORTED_PROTOCOL_VERSION;
}

/** Whether an error is the method-not-found error. */
export function isMethodNotFoundError(error: unknown): boolean {
  return error instanceof McpRpcError && error.code === METHOD_NOT_FOUND;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** The deadlines one request carries. */
export interface PeerRequestOptions {
  /** The connect-phase deadline. */
  armedTimeoutMs?: number;
  /** The deadline of an ordinary request. */
  requestTimeoutMs?: number;
  /** The deadline of a whole tool call. */
  toolTimeoutMs?: number;
  /** The longest the request may stay silent. */
  idleTimeoutMs?: number;
}

/**
 * The JSON-RPC peer.
 */
export class McpPeer {
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

      // The deadline is either the ordinary request timeout or the tool
      // timeout, and the two raise **different** kinds of timeout error.
      const deadlineMs = options.toolTimeoutMs ?? options.requestTimeoutMs;
      const deadlineKind = options.toolTimeoutMs !== undefined ? 'tool' : 'request';
      if (deadlineMs !== undefined && deadlineMs > 0) {
        deadline = setTimeout(() => {
          fail(
            new McpTimeoutError(
              deadlineKind,
              `the MCP request "${method}" timed out after ${deadlineMs} ms`,
            ),
          );
        }, deadlineMs);
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

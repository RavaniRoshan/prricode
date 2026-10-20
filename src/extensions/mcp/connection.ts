/**
 * The connection to one MCP server.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("MCP, plugins, and
 * hooks" — "MCP transport" and "The MCP client lifecycle is observed"), and the
 * `CC-011` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * This module owns **one** responsibility: the live connection — what it
 * exposes, which deadlines each of its requests carries, and how a tool call's
 * result is shaped.
 *
 * ## The deadlines a connection carries
 *
 *   - an **ordinary request** (`tools/list`, `prompts/list`, …) carries the
 *     *request* timeout, and never the connect-phase armed timeout;
 *   - a **tool call** carries the *tool* timeout and the *tool idle* timeout,
 *     and never the connect-phase armed timeout.
 *
 * The tool timeout is a **separate** deadline from the request timeout, so a
 * tool call that runs out of time raises a `tool` timeout and not a `request`
 * one: the two are told apart by `McpTimeoutError.kind`.
 */

import { readRecord } from './records.js';
import type { McpPeer } from './peer.js';
import type { McpProtocolEra, McpServerInfo } from './protocol.js';
import type { McpServerConfig } from './config.js';
import type { McpTimeoutOptions } from './timeouts.js';

/* -------------------------------------------------------------------------- */
/* The connection                                                              */
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

/** The connection the client builds. */
export class McpServerConnection implements McpConnection {
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
    // and never the connect-phase armed timeout. The tool timeout is its own
    // deadline, so it raises a `tool` timeout rather than a `request` one.
    return this.#peer
      .request(
        'tools/call',
        { name, arguments: args ?? {} },
        {
          toolTimeoutMs: options?.timeoutMs ?? this.timeouts.toolTimeoutMs,
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
/* The tool call                                                              */
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

/** The shape a tool call's answer has. */
export function normalizeToolCallResult(raw: unknown): McpToolCallResult {
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

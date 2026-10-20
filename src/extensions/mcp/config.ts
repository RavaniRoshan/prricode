/**
 * The MCP server configuration and the state a configured server is in.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("MCP, plugins, and
 * hooks" — "MCP transport" and "The MCP client lifecycle is observed"), and the
 * `CC-011` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * This module owns **one** responsibility: the shape of a configured server and
 * the shape of the state a configured server is in. The connection itself lives
 * in `connection.ts`, the manager that owns the servers lives in `manager.ts`.
 *
 * ## The server types
 *
 * The target's own types are `stdio` and `sdk` (audit §2.8); `http` and `sse`
 * are the **transports** the target also supports, and this implementation keeps them so
 * a configuration written for the target is not rejected.
 *
 * ## The credential
 *
 * **The client never resolves a credential itself.** It either receives one, or
 * asks the provider registry for one through `resolveConnectionCredential` —
 * the registry's guarded entry point, which is the only path to a secret. The
 * client never reads the environment, the filesystem or a keychain for a
 * secret.
 */

import type { ResolvedCredential } from '../../provider/credentials.js';

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

/** A tool, as the model sees it. */
export interface McpToolSummary {
  name: string;
  title?: string;
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

/**
 * The MCP server manager.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("MCP, plugins, and
 * hooks" — "MCP transport" and "The MCP client lifecycle is observed"), and the
 * `CC-011` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * The manager owns the **servers**: it connects them, remembers their state,
 * hands the model's tool list out, and tears them down. The connection itself
 * lives in `src/extensions/mcp/client.ts`.
 *
 * ## The batching
 *
 * The target's batching is `3` for local servers and `20` for remote ones
 * (audit §2.8, and the research report's `MCP_SERVER_CONNECTION_BATCH_SIZE` and
 * `MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE`). The two pools run **concurrently**
 * — a local server and a remote server do not wait for one another — and each
 * pool issues at most its own batch size at a time.
 *
 * ## A failed server never blocks the session
 *
 * A server that fails to connect — or that exits while its tools are listed — is
 * marked `failed` with the reason, and the other servers carry on. A failed
 * server is **retryable**: the next `connect` attempts it again rather than
 * handing out the memoized failure.
 *
 * ## The rug-pull surfacing
 *
 * The target does **not** notify when a tool's description changes; that is the
 * known MCP gap (the research report's "Known MCP issues"). This implementation computes
 * the change and re-surfaces it, so a tool cannot silently change what it does
 * after the model saw it. This is a **project requirement**.
 */

import {
  connectToServer,
  discardMemoizedConnectResult,
  ensureConnectedClient,
  evictStaleFailedConnectMemoForServe,
  fetchToolsForClient,
  mcpConfigKey,
  type McpCallOptions,
  type McpConnectOptions,
  type McpConnection,
  type McpServerConfig,
  type McpServerState,
  type McpToolCallResult,
  type McpToolDefinition,
  type McpToolDescriptionChange,
  type McpToolSummary,
  detectToolDescriptionChanges,
} from './client.js';

export type {
  McpCallOptions,
  McpConnection,
  McpServerConfig,
  McpServerState,
  McpServerType,
  McpToolCallResult,
  McpToolDefinition,
  McpToolDescriptionChange,
  McpToolSummary,
} from './client.js';

import { callMCPTool, callMCPToolWithUrlElicitationRetry } from './client.js';

/* -------------------------------------------------------------------------- */
/* The batch sizes                                                            */
/* -------------------------------------------------------------------------- */

/** The batch size for local servers. */
export const LOCAL_CONNECT_BATCH_SIZE = 3;

/** The batch size for remote servers. */
export const REMOTE_CONNECT_BATCH_SIZE = 20;

/** The environment variable that carries the local batch size. */
export const MCP_SERVER_CONNECTION_BATCH_SIZE_ENV = 'MCP_SERVER_CONNECTION_BATCH_SIZE';

/** The environment variable that carries the remote batch size. */
export const MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE_ENV = 'MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE';

function batchSizeFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/** The batch size for local servers. */
export function getMcpServerConnectionBatchSize(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return batchSizeFromEnv(env[MCP_SERVER_CONNECTION_BATCH_SIZE_ENV], LOCAL_CONNECT_BATCH_SIZE);
}

/** The batch size for remote servers. */
export function getRemoteMcpServerConnectionBatchSize(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return batchSizeFromEnv(
    env[MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE_ENV],
    REMOTE_CONNECT_BATCH_SIZE,
  );
}

/**
 * Whether a server is reached over the network.
 *
 * A `stdio` or `sdk` server is **local**; an `http` or `sse` server is
 * **remote**.
 */
export function isRemoteServerConfig(config: McpServerConfig): boolean {
  return config.type === 'http' || config.type === 'sse';
}

/* -------------------------------------------------------------------------- */
/* The batch scheduler                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Run a worker over the items, with at most `size` of them in flight.
 *
 * The workers pull from a shared queue, so a slow item does not hold a slot
 * empty while the others wait.
 */
export async function runBatchPool<T>(
  items: readonly T[],
  size: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.floor(size));
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/** The options a batched connect runs with. */
export interface BatchConnectOptions {
  /** The connect the scheduler drives. */
  connect: (config: McpServerConfig) => Promise<McpServerState>;
  /** The local batch size. */
  localBatchSize?: number;
  /** The remote batch size. */
  remoteBatchSize?: number;
  /** The environment the batch sizes are read from. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Connect to a set of servers, in batches.
 *
 * The local and the remote pools run **concurrently**, each with its own batch
 * size, and the states come back in the order the configurations were given.
 */
export async function connectServersInBatches(
  configs: readonly McpServerConfig[],
  options: BatchConnectOptions,
): Promise<McpServerState[]> {
  const env = options.env ?? process.env;
  const localBatchSize = options.localBatchSize ?? getMcpServerConnectionBatchSize(env);
  const remoteBatchSize = options.remoteBatchSize ?? getRemoteMcpServerConnectionBatchSize(env);

  const local = configs.filter((config) => !isRemoteServerConfig(config));
  const remote = configs.filter((config) => isRemoteServerConfig(config));

  const localStates: McpServerState[] = [];
  const remoteStates: McpServerState[] = [];

  await Promise.all([
    runBatchPool(local, localBatchSize, async (config) => {
      localStates.push(await options.connect(config));
    }),
    runBatchPool(remote, remoteBatchSize, async (config) => {
      remoteStates.push(await options.connect(config));
    }),
  ]);

  const byName = new Map<string, McpServerState>();
  for (const state of [...localStates, ...remoteStates]) {
    byName.set(state.name, state);
  }
  return configs.map((config) => {
    const state = byName.get(config.name);
    if (!state) {
      return { name: config.name, status: 'failed', tools: [], error: 'the server was not connected' };
    }
    return state;
  });
}

/* -------------------------------------------------------------------------- */
/* The manager                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The MCP server manager.
 *
 * The four members are the plan's; the rest are **additive** and are used by
 * the later milestones.
 */
export interface McpManager {
  /** Connect to a server and report its state. */
  connect(config: McpServerConfig): Promise<McpServerState>;
  /** Disconnect from a server. */
  disconnect(name: string): Promise<void>;
  /** The state of every configured server. */
  states(): readonly McpServerState[];
  /** The tools of one server. */
  toolsFor(name: string): McpToolSummary[];
}

/** The options a manager is created with. */
export interface McpManagerOptions {
  /** The options every connect runs with. */
  client?: McpConnectOptions;
  /** The environment the batch sizes are read from. */
  env?: NodeJS.ProcessEnv;
  /**
   * Called when a tool's description changed.
   *
   * The project requirement: the change is re-surfaced, so a "rug pull" cannot
   * silently alter an approved tool's behaviour.
   */
  onToolDescriptionChanged?: (change: McpToolDescriptionChange, state: McpServerState) => void;
}

interface ServerRecord {
  config: McpServerConfig;
  state: McpServerState;
  connection?: McpConnection;
  tools: McpToolDefinition[];
}

/** The in-memory MCP server manager. */
export class McpServerManager implements McpManager {
  readonly #servers = new Map<string, ServerRecord>();
  readonly #options: McpManagerOptions;
  readonly #env: NodeJS.ProcessEnv;

  constructor(options: McpManagerOptions = {}) {
    this.#options = options;
    this.#env = options.env ?? process.env;
  }

  async connect(config: McpServerConfig): Promise<McpServerState> {
    const record = this.#servers.get(config.name);
    const sameConfig = record !== undefined && mcpConfigKey(record.config) === mcpConfigKey(config);
    if (record?.connection?.isLive() && sameConfig) {
      return record.state;
    }
    // A server whose configuration changed is a different server: the old
    // connection is closed rather than left running.
    if (record?.connection && !sameConfig) {
      await record.connection.close().catch(() => undefined);
    }

    const connecting: McpServerState = { name: config.name, status: 'connecting', tools: [] };
    this.#servers.set(config.name, {
      config,
      state: connecting,
      tools: record?.tools ?? [],
    });

    try {
      // A failed server is retryable: the stale failure is evicted first.
      evictStaleFailedConnectMemoForServe(config.name);
      const connection = await ensureConnectedClient(config, {
        ...(this.#options.client ?? {}),
        env: this.#options.client?.env ?? this.#env,
        retryFailed: true,
      });

      const tools = await fetchToolsForClient(connection);
      const state: McpServerState = {
        name: config.name,
        status: 'ready',
        tools: tools.map((tool) => summarizeTool(config.name, tool)),
        protocolVersion: connection.protocolVersion,
      };
      const previous = record?.tools ?? [];
      const changes = detectToolDescriptionChanges(config.name, previous, tools);
      if (changes.length > 0) state.descriptionChanges = changes;

      this.#servers.set(config.name, { config, state, connection, tools });
      if (changes.length > 0) {
        for (const change of changes) {
          this.#options.onToolDescriptionChanged?.(change, state);
        }
      }
      return state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state: McpServerState = {
        name: config.name,
        status: 'failed',
        tools: [],
        error: message,
      };
      this.#servers.set(config.name, { config, state, tools: record?.tools ?? [] });
      return state;
    }
  }

  async disconnect(name: string): Promise<void> {
    const record = this.#servers.get(name);
    discardMemoizedConnectResult(name);
    if (record?.connection) {
      await record.connection.close().catch(() => undefined);
    }
    const state: McpServerState = { name, status: 'disabled', tools: [] };
    this.#servers.set(name, {
      config: record?.config ?? { name, type: 'stdio' },
      state,
      tools: [],
    });
  }

  states(): readonly McpServerState[] {
    return [...this.#servers.values()].map((record) => record.state);
  }

  toolsFor(name: string): McpToolSummary[] {
    const record = this.#servers.get(name);
    if (!record) return [];
    return record.state.tools.map((tool) => ({ ...tool }));
  }

  /* --- the additive surface ------------------------------------------------ */

  /** The live connection of a server, when there is one. */
  connection(name: string): McpConnection | undefined {
    const record = this.#servers.get(name);
    if (!record?.connection?.isLive()) return undefined;
    return record.connection;
  }

  /** The configuration of a server. */
  configFor(name: string): McpServerConfig | undefined {
    return this.#servers.get(name)?.config;
  }

  /** Call a tool of a server. */
  async callTool(name: string, tool: string, args: unknown): Promise<McpToolCallResult> {
    const connection = this.connection(name);
    if (!connection) {
      throw new Error(`the MCP server "${name}" is not connected`);
    }
    return callMCPTool(connection, tool, args);
  }

  /** Call a tool of a server, retrying once when the server elicits a URL. */
  async callToolWithUrlElicitationRetry(
    name: string,
    tool: string,
    args: unknown,
    options: McpCallOptions = {},
  ): Promise<McpToolCallResult> {
    const connection = this.connection(name);
    if (!connection) {
      throw new Error(`the MCP server "${name}" is not connected`);
    }
    return callMCPToolWithUrlElicitationRetry(connection, tool, args, options);
  }

  /**
   * Refresh a server's tools.
   *
   * The tools are fetched again unless an explicit list is given, and a tool
   * whose description changed is re-surfaced.
   */
  async refresh(name: string, tools?: readonly McpToolDefinition[]): Promise<McpServerState> {
    const record = this.#servers.get(name);
    if (!record) {
      return { name, status: 'failed', tools: [], error: `the MCP server "${name}" is not configured` };
    }
    let next: McpToolDefinition[];
    if (tools) {
      next = [...tools];
    } else {
      const connection = record.connection;
      if (!connection) {
        return { ...record.state };
      }
      next = await fetchToolsForClient(connection);
    }

    const changes = detectToolDescriptionChanges(name, record.tools, next);
    const state: McpServerState = {
      ...record.state,
      status: 'ready',
      tools: next.map((tool) => summarizeTool(name, tool)),
    };
    if (changes.length > 0) state.descriptionChanges = changes;

    this.#servers.set(name, { ...record, state, tools: next });
    for (const change of changes) {
      this.#options.onToolDescriptionChanged?.(change, state);
    }
    return state;
  }

  /**
   * Connect to a set of servers, in batches.
   *
   * The local and the remote pools run concurrently, each with its own batch
   * size.
   */
  async connectAll(configs: readonly McpServerConfig[]): Promise<McpServerState[]> {
    return connectServersInBatches(configs, {
      connect: (config) => this.connect(config),
      env: this.#env,
    });
  }

  /**
   * Replace the configured servers.
   *
   * A server that is no longer configured is disconnected; one that is
   * configured afresh is connected.
   */
  async setServers(configs: readonly McpServerConfig[]): Promise<McpServerState[]> {
    const wanted = new Set(configs.map((config) => config.name));
    for (const name of [...this.#servers.keys()]) {
      if (!wanted.has(name)) await this.disconnect(name);
    }
    return this.connectAll(configs);
  }
}

/** The summary of a tool, as the state carries it. */
function summarizeTool(server: string, tool: McpToolDefinition): McpToolSummary {
  const summary: McpToolSummary = { name: `mcp__${server}__${tool.name}` };
  if (tool.title !== undefined) summary.title = tool.title;
  return summary;
}

/** Create an MCP server manager. */
export function createMcpManager(options: McpManagerOptions = {}): McpServerManager {
  return new McpServerManager(options);
}

/**
 * Connect to a server without a manager.
 *
 * A convenience for a caller that wants one connection and nothing else.
 */
export async function connectMcpServer(
  config: McpServerConfig,
  options: McpConnectOptions = {},
): Promise<McpConnection> {
  return connectToServer(config, options);
}

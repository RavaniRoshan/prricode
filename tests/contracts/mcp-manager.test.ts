/**
 * Contract test for the MCP client and the MCP server manager.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("MCP, plugins, and
 * hooks" — "MCP transport" and "The MCP client lifecycle is observed"), and the
 * `CC-011` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * The test drives a **real** MCP server: a small Node script that speaks
 * newline-delimited JSON-RPC over stdio, so the transport, the framing, the
 * negotiation and the failure paths are all exercised end to end rather than
 * mocked.
 *
 * What it pins:
 *
 *   - a stdio server is spawned with `shell: false` and `stdio: ["pipe", "pipe",
 *     "stderr"]`, and its environment is the parent's plus the server's own;
 *   - the **modern** protocol revision is probed **first**, and the legacy
 *     `initialize` handshake is the **fallback** (`MCP_PROTOCOL_NEGOTIATION=legacy`
 *     is the opt-out);
 *   - a connect result is memoized, and the memo is dropped when the credential
 *     identity epoch changes, when it goes stale, or explicitly;
 *   - `hasLiveConnection` and `hasUnsettledDial` report the two states;
 *   - capabilities are fetched **separately**, and a listing can be hydrated
 *     without re-discovering it;
 *   - a tool is composed for the model (`mcp__<server>__<tool>`), its
 *     instructions are capped, and the `mcp__ide__` tools are special-cased;
 *   - a tool call works, and the URL-elicitation retry variant retries once;
 *   - auth failures are classified and the error body is inspected for a code;
 *   - the **four** fetch variants are distinct;
 *   - the **four** timeouts are distinct;
 *   - teardown closes the child process;
 *   - the batch scheduler issues at most `LOCAL_CONNECT_BATCH_SIZE` (3)
 *     concurrent local spawns and at most `REMOTE_CONNECT_BATCH_SIZE` (20)
 *     concurrent remote ones;
 *   - a server that exits during `tools/list` is marked `failed`, does not block
 *     the other servers, and is retryable;
 *   - a tool whose description changed after approval is re-surfaced.
 */

import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MCP_TIMEOUTS,
  IDE_MCP_TOOL_NAMES,
  LEGACY_PROTOCOL_VERSION,
  MCP_FAILED_MEMO_MAX_AGE_MS,
  MODERN_PROTOCOL_VERSION,
  McpRpcError,
  McpTimeoutError,
  UNSUPPORTED_PROTOCOL_VERSION,
  capMcpInstructions,
  checkMcpProtocolVersionHeader,
  classifyMcpAuthFailure,
  cleanupConnectedMcpClients,
  composeMcpTool,
  connectToServer,
  createCcrProxyFetch,
  createCliOwnedBearerFetch,
  createAgentAiProxyFetch,
  createFirstPartyApiMcpFetch,
  createStdioTransport,
  detectToolDescriptionChanges,
  detachAndCloseConnection,
  discardMemoizedConnectResult,
  disposeServerConnectionDetached,
  ensureConnectedClient,
  evictAllMcpMemosOnIdentityChange,
  evictStaleFailedConnectMemoForServe,
  fetchCommandsForClient,
  fetchResourceTemplatesForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
  getListingDiscoverPrior,
  getMcpIdentityEpoch,
  getMcpToolsCommandsAndResources,
  getMcpVersionNegotiation,
  getRememberedDiscoverPrior,
  hasEraCodeInHttpErrorBody,
  hasLiveConnection,
  hasUnsettledDial,
  hostMatches,
  hydrateCommandsFromListing,
  hydrateToolsFromListing,
  inertReconnectShape,
  isIdeMcpTool,
  isMethodNotFoundError,
  isRemoteHostAllowed,
  isUnsupportedProtocolVersionError,
  isUrlElicitationResult,
  mcpConfigKey,
  mcpToolName,
  onMcpServerConnectionEvent,
  rememberDiscoverPrior,
  shouldHideMcpTool,
  type McpListing,
  type McpServerConfig,
  type McpToolDefinition,
  type McpTransport,
  type SpawnImpl,
} from '../../src/extensions/mcp/client.js';
import {
  LOCAL_CONNECT_BATCH_SIZE,
  REMOTE_CONNECT_BATCH_SIZE,
  connectServersInBatches,
  createMcpManager,
  getMcpServerConnectionBatchSize,
  getRemoteMcpServerConnectionBatchSize,
  isRemoteServerConfig,
  type McpManager,
} from '../../src/extensions/mcp/manager.js';

/* -------------------------------------------------------------------------- */
/* The fake MCP server                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A tiny MCP server that speaks newline-delimited JSON-RPC over stdio.
 *
 * `FAKE_MCP_MODE` selects the behaviour:
 *
 *   - `legacy` (default) — answers `initialize`; `server/discover` is unknown;
 *   - `modern` — answers `server/discover` with the modern revision;
 *   - `unsupported-version` — answers `server/discover` with the JSON-RPC error
 *     `-32022` and a `supported` list;
 *   - `unsupported-modern-version` — answers the first `server/discover` with
 *     `-32022` and **two** modern versions, so the first one is the one the
 *     client re-probes with;
 *   - `unsupported-same-version` — answers every `server/discover` with
 *     `-32022` and the version the client has already probed;
 *   - `exit-on-list` — exits as soon as `tools/list` arrives.
 */
const FAKE_SERVER_SOURCE = `'use strict';
const fs = require('node:fs');
const readline = require('node:readline');

const mode = process.env.FAKE_MCP_MODE || 'legacy';

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function logMethod(method) {
  const file = process.env.FAKE_MCP_METHOD_LOG;
  if (!file || !method) return;
  try { fs.appendFileSync(file, method + '\\n'); } catch { /* the log is a test aid */ }
}

function logDiscoveryVersion(version) {
  const file = process.env.FAKE_MCP_DISCOVER_VERSIONS;
  if (!file || !version) return;
  try { fs.appendFileSync(file, version + '\\n'); } catch { /* the log is a test aid */ }
}

function bumpFile(file) {
  if (!file) return 0;
  let current = 0;
  try { current = Number(fs.readFileSync(file, 'utf8')) || 0; } catch { current = 0; }
  current += 1;
  fs.writeFileSync(file, String(current));
  return current;
}

function bumpCounter() {
  return bumpFile(process.env.FAKE_MCP_STATE_FILE);
}

const toolDescription = process.env.FAKE_MCP_TOOL_DESCRIPTION || 'Echo the input back';

const echoTool = {
  name: 'echo',
  title: 'Echo',
  description: toolDescription,
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
};

const ideTools = [
  { name: 'other', title: 'Other', description: 'An ide tool' },
  { name: 'executeCode', title: 'Execute', description: 'Runs the code' },
  { name: 'getDiagnostics', title: 'Diagnostics', description: 'The diagnostics' },
];

const toolList = mode === 'ide' ? ideTools : [echoTool];

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || typeof message !== 'object') return;
  const id = message.id;
  const method = message.method;
  logMethod(method);

  const delayMethod = process.env.FAKE_MCP_DELAY_METHOD || 'tools/list';
  const delayMs = Number(process.env.FAKE_MCP_DELAY_MS || '0');
  if (delayMs > 0 && method === delayMethod) {
    setTimeout(() => {
      send({
        jsonrpc: '2.0',
        id,
        result: method === 'tools/list' ? { tools: toolList } : {},
      });
    }, delayMs);
    return;
  }

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      },
    });
    return;
  }

  if (method === 'server/discover') {
    const params = message.params || {};
    const meta = params._meta || {};
    logDiscoveryVersion(meta.protocolVersion);
    if (mode === 'modern') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2026-07-28',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-mcp', version: '1.0.0' },
        },
      });
      return;
    }
    if (mode === 'unsupported-version') {
      send({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32022,
          message: 'Unsupported protocol version',
          data: { supported: ['2025-11-25'] },
        },
      });
      return;
    }
    if (mode === 'unsupported-modern-version') {
      // The first probe is refused, and the versions the client is told about
      // are **modern** ones, so the client re-probes with the **first** of them.
      const seen = bumpFile(process.env.FAKE_MCP_DISCOVER_COUNTER);
      if (seen === 1) {
        send({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32022,
            message: 'Unsupported protocol version',
            data: { supported: ['2026-07-30', '2026-07-29'] },
          },
        });
        return;
      }
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2026-07-28',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-mcp', version: '1.0.0' },
        },
      });
      return;
    }
    if (mode === 'unsupported-same-version') {
      // The only version the client is told about is the one it has already
      // probed, so the client must not probe twice for it.
      bumpFile(process.env.FAKE_MCP_DISCOVER_COUNTER);
      send({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32022,
          message: 'Unsupported protocol version',
          data: { supported: ['2026-07-28'] },
        },
      });
      return;
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    return;
  }

  if (method === 'tools/list') {
    if (mode === 'exit-on-list') { process.exit(3); }
    send({ jsonrpc: '2.0', id, result: { tools: toolList } });
    return;
  }

  if (method === 'prompts/list') {
    send({ jsonrpc: '2.0', id, result: { prompts: [{ name: 'greet', description: 'Greet' }] } });
    return;
  }

  if (method === 'resources/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: { resources: [{ uri: 'file:///notes.txt', name: 'notes', mimeType: 'text/plain' }] },
    });
    return;
  }

  if (method === 'resources/templates/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: { resourceTemplates: [{ uriTemplate: 'file:///{path}', name: 'files' }] },
    });
    return;
  }

  if (method === 'tools/call') {
    const params = message.params || {};
    if (params.name === 'elicitate') {
      const seen = bumpCounter();
      if (seen === 1) {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: 'Visit https://example.com/authorize to continue' }],
          },
        });
        return;
      }
    }
    const callDelay = Number(process.env.FAKE_MCP_CALL_DELAY_MS || '0');
    if (callDelay > 0) {
      setTimeout(() => {
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: 'echo: ' + JSON.stringify(params.arguments || {}) }] },
        });
      }, callDelay);
      return;
    }
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: 'echo: ' + JSON.stringify(params.arguments || {}) }] },
    });
    return;
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
});
`;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcp-manager-'));
  tempDirs.push(dir);
  return dir;
}

/** Write the fake MCP server into a temp dir and return its path. */
function writeFakeServer(mode: string, dir: string): string {
  const file = path.join(dir, `server-${mode}.cjs`);
  writeFileSync(file, FAKE_SERVER_SOURCE, 'utf8');
  return file;
}

/**
 * A stdio config that runs the fake server in the given mode.
 *
 * The `extra` members are spread **first**, so the server's own environment is
 * the mode plus the caller's own entries — and the caller's entries cannot
 * clobber the mode by accident.
 */
function stdioConfig(
  name: string,
  serverPath: string,
  mode: string,
  extra: Partial<McpServerConfig> = {},
): McpServerConfig {
  return {
    ...extra,
    name,
    type: 'stdio',
    command: process.execPath,
    args: [serverPath],
    env: { FAKE_MCP_MODE: mode, ...(extra.env ?? {}) },
  };
}

/** The methods the fake server saw, in order. */
function readMethodLog(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

/** The protocol versions the fake server was probed with, in order. */
function readDiscoveryVersions(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

/* -------------------------------------------------------------------------- */
/* The HTTP stub server                                                       */
/* -------------------------------------------------------------------------- */

/** The answer a stub HTTP MCP server gives. */
interface StubAnswer {
  status: number;
  body: string;
  contentType?: string;
}

/** A stub HTTP MCP server. */
interface StubServer {
  /** The endpoint the client talks to. */
  url: string;
  /** The headers of every request the server saw, in order. */
  headers: Array<Record<string, string | string[] | undefined>>;
  /** The methods the server saw, in order. */
  methods: string[];
  /** Close the server. */
  close: () => Promise<void>;
}

/**
 * Start a stub HTTP MCP server.
 *
 * The server answers whatever the test's `answer` function says, so a test can
 * pin the headers it presents and the answers it gives.
 */
async function startStubHttpServer(
  answer: (
    message: { method: string; id?: unknown; params?: unknown },
    headers: Record<string, string | string[] | undefined>,
  ) => StubAnswer,
): Promise<StubServer> {
  const headers: Array<Record<string, string | string[] | undefined>> = [];
  const methods: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let method = '';
      let id: unknown;
      let params: unknown;
      try {
        const parsed = JSON.parse(body) as { method?: string; id?: unknown; params?: unknown };
        method = parsed.method ?? '';
        id = parsed.id;
        params = parsed.params;
      } catch {
        // The body is not JSON: the answer function sees an empty method.
      }
      methods.push(method);
      headers.push({ ...req.headers });
      const result = answer({ method, id, params }, req.headers);
      res.writeHead(result.status, { 'content-type': result.contentType ?? 'application/json' });
      res.end(result.body);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headers,
    methods,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* The transport                                                              */
/* -------------------------------------------------------------------------- */

describe('the MCP stdio transport', () => {
  it('spawns the configured command with shell: false and piped stdio', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);

    const spawns: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
    const spawnImpl: SpawnImpl = (command, args, options) => {
      spawns.push({ command, args, options });
      return nodeSpawn(command, args, options);
    };

    const transport = createStdioTransport({
      command: process.execPath,
      args: [serverPath],
      spawnImpl,
    });
    await transport.start();

    expect(spawns).toHaveLength(1);
    const spawn = spawns[0];
    expect(spawn).toBeDefined();
    expect(spawn?.command).toBe(process.execPath);
    expect(spawn?.args).toEqual([serverPath]);
    expect(spawn?.options.shell).toBe(false);
    // The audit's `stdio: ["pipe", "pipe", stderr ?? "inherit"]`: stdin and
    // stdout are pipes, and stderr follows the server's own setting.
    expect(spawn?.options.stdio).toEqual(['pipe', 'pipe', 'inherit']);
    expect(spawn?.options.windowsHide).toBe(process.platform === 'win32');

    await transport.close();
  });

  it('pipes the server stderr when the server asks for it', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);

    const spawns: SpawnOptions[] = [];
    const spawnImpl: SpawnImpl = (command, args, options) => {
      spawns.push(options);
      return nodeSpawn(command, args, options);
    };

    const transport = createStdioTransport({
      command: process.execPath,
      args: [serverPath],
      stderr: 'pipe',
      spawnImpl,
    });
    await transport.start();
    await transport.close();

    expect(spawns[0]?.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  it('merges the parent environment with the server own environment', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);

    const spawns: SpawnOptions[] = [];
    const spawnImpl: SpawnImpl = (command, args, options) => {
      spawns.push(options);
      return nodeSpawn(command, args, options);
    };

    process.env['MCP_MANAGER_PARENT_MARKER'] = 'parent-value';
    try {
      const transport = createStdioTransport({
        command: process.execPath,
        args: [serverPath],
        env: { MCP_MANAGER_SERVER_MARKER: 'server-value' },
        spawnImpl,
      });
      await transport.start();
      await transport.close();
    } finally {
      delete process.env['MCP_MANAGER_PARENT_MARKER'];
    }

    const env = spawns[0]?.env as Record<string, string> | undefined;
    expect(env?.['MCP_MANAGER_PARENT_MARKER']).toBe('parent-value');
    expect(env?.['MCP_MANAGER_SERVER_MARKER']).toBe('server-value');
  });
});

/* -------------------------------------------------------------------------- */
/* Connecting                                                                 */
/* -------------------------------------------------------------------------- */

describe('the MCP manager', () => {
  it('connects a stdio server, marks it ready, and lists its tools', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const manager = createMcpManager();

    const state = await manager.connect(stdioConfig('notes', serverPath, 'legacy'));

    expect(state.name).toBe('notes');
    expect(state.status).toBe('ready');
    expect(state.error).toBeUndefined();
    expect(state.tools).toEqual([{ name: 'mcp__notes__echo', title: 'Echo' }]);
    expect(state.protocolVersion).toBe(LEGACY_PROTOCOL_VERSION);

    await manager.disconnect('notes');
  });

  it('negotiates the modern revision first and falls back to the legacy handshake', async () => {
    const dir = makeTempDir();
    const legacyPath = writeFakeServer('legacy', dir);
    const modernPath = writeFakeServer('modern', dir);
    const manager = createMcpManager();

    const modern = await manager.connect(stdioConfig('modern', modernPath, 'modern'));
    expect(modern.status).toBe('ready');
    expect(modern.protocolVersion).toBe(MODERN_PROTOCOL_VERSION);

    const legacy = await manager.connect(stdioConfig('legacy', legacyPath, 'legacy'));
    expect(legacy.status).toBe('ready');
    expect(legacy.protocolVersion).toBe(LEGACY_PROTOCOL_VERSION);

    await manager.disconnect('modern');
    await manager.disconnect('legacy');
  });

  it('retries with a supported version when the server answers -32022', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('unsupported-version', dir);
    const manager = createMcpManager();

    const state = await manager.connect(stdioConfig('versioned', serverPath, 'unsupported-version'));

    expect(state.status).toBe('ready');
    expect(state.protocolVersion).toBe(LEGACY_PROTOCOL_VERSION);
    await manager.disconnect('versioned');
  });

  it('honours the legacy opt-out of the modern revision', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('modern', dir);
    const methodLog = path.join(dir, 'methods.log');
    // The opt-out lives in the **client's** environment: it says how the
    // client negotiates, not how the server does.
    const manager = createMcpManager({ env: { MCP_PROTOCOL_NEGOTIATION: 'legacy' } });

    const state = await manager.connect(
      stdioConfig('opted-out', serverPath, 'modern', { env: { FAKE_MCP_METHOD_LOG: methodLog } }),
    );

    expect(state.status).toBe('ready');
    expect(state.protocolVersion).toBe(LEGACY_PROTOCOL_VERSION);

    // The modern server was reached through the **legacy handshake**, not
    // through the modern probe.
    const methods = readMethodLog(methodLog);
    expect(methods).toContain('initialize');
    expect(methods).not.toContain('server/discover');

    await manager.disconnect('opted-out');
  });

  it('re-probes with the first modern version the server names', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('unsupported-modern-version', dir);
    const methodLog = path.join(dir, 'methods.log');
    const versionsLog = path.join(dir, 'versions.log');
    const counter = path.join(dir, 'discover.txt');
    const manager = createMcpManager();

    const state = await manager.connect(
      stdioConfig('reprobed', serverPath, 'unsupported-modern-version', {
        env: {
          FAKE_MCP_METHOD_LOG: methodLog,
          FAKE_MCP_DISCOVER_VERSIONS: versionsLog,
          FAKE_MCP_DISCOVER_COUNTER: counter,
        },
      }),
    );

    expect(state.status).toBe('ready');
    expect(state.protocolVersion).toBe(MODERN_PROTOCOL_VERSION);

    // The modern probe is made **twice**: once with the client's own version
    // and once with the version the server named.
    const methods = readMethodLog(methodLog);
    expect(methods.filter((method) => method === 'server/discover')).toHaveLength(2);
    expect(methods).not.toContain('initialize');

    // The re-probe uses the **first** modern version the server named, not the
    // last one.
    const probed = readDiscoveryVersions(versionsLog);
    expect(probed).toEqual([MODERN_PROTOCOL_VERSION, '2026-07-30']);
    expect(probed).not.toContain('2026-07-29');

    await manager.disconnect('reprobed');
  });

  it('never probes twice for the same version', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('unsupported-same-version', dir);
    const methodLog = path.join(dir, 'methods.log');
    const counter = path.join(dir, 'discover.txt');
    const manager = createMcpManager();

    // The only version the server names is the one the client has already
    // probed, so the negotiation fails rather than probing again.
    const state = await manager.connect(
      stdioConfig('same-version', serverPath, 'unsupported-same-version', {
        env: { FAKE_MCP_METHOD_LOG: methodLog, FAKE_MCP_DISCOVER_COUNTER: counter },
      }),
    );

    expect(state.status).toBe('failed');
    expect(state.error).toContain('Unsupported protocol version');

    // The modern probe was made **once**: the same version was never probed
    // twice.
    const methods = readMethodLog(methodLog);
    expect(methods.filter((method) => method === 'server/discover')).toHaveLength(1);
  });

  it('hides the mcp__ide__ tools the filter covers', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('ide', dir);
    const manager = createMcpManager();

    await manager.connect(stdioConfig('ide', serverPath, 'ide'));

    const names = manager.toolsFor('ide').map((tool) => tool.name);
    // The general filter hides the ide tools ...
    expect(names).not.toContain('mcp__ide__other');
    // ... and the two special-cased tools are exempt from it.
    expect(names).toContain('mcp__ide__executeCode');
    expect(names).toContain('mcp__ide__getDiagnostics');

    await manager.disconnect('ide');
  });

  it('hides the mcp__ide__ tools the filter covers when the tools are refreshed', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('ide', dir);
    const manager = createMcpManager();

    // The filter covers the `ide` **server**, so the server is named `ide`.
    await manager.connect(stdioConfig('ide', serverPath, 'ide'));

    // The filter is applied where the tool list is built, so a **refreshed**
    // list is filtered too.
    const refreshed = await manager.refresh('ide');
    const names = refreshed.tools.map((tool) => tool.name);
    expect(names).not.toContain('mcp__ide__other');
    expect(names).toContain('mcp__ide__executeCode');
    expect(names).toContain('mcp__ide__getDiagnostics');

    // The manager's own view is filtered as well.
    expect(manager.toolsFor('ide').map((tool) => tool.name)).not.toContain('mcp__ide__other');

    await manager.disconnect('ide');
  });

  it('connects a server again when its environment changed', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const manager = createMcpManager();

    const first = await manager.connect(
      stdioConfig('env-changed', serverPath, 'legacy', { env: { FAKE_MCP_MARKER: '1' } }),
    );
    expect(first.status).toBe('ready');
    const firstConnection = manager.connection('env-changed');
    expect(firstConnection).toBeDefined();

    const second = await manager.connect(
      stdioConfig('env-changed', serverPath, 'legacy', { env: { FAKE_MCP_MARKER: '2' } }),
    );
    expect(second.status).toBe('ready');
    // A different environment is a different server: the connection is made
    // again rather than reused.
    expect(manager.connection('env-changed')).not.toBe(firstConnection);

    await manager.disconnect('env-changed');
  });

  it('marks a server that exits during tools/list as failed without blocking the others', async () => {
    const dir = makeTempDir();
    const dyingPath = writeFakeServer('exit-on-list', dir);
    const healthyPath = writeFakeServer('legacy', dir);
    const manager = createMcpManager();

    const [dying, healthy] = await Promise.all([
      manager.connect(stdioConfig('dying', dyingPath, 'exit-on-list')),
      manager.connect(stdioConfig('healthy', healthyPath, 'legacy')),
    ]);

    expect(dying?.status).toBe('failed');
    expect(dying?.error).toBeTruthy();
    expect(healthy?.status).toBe('ready');
    expect(manager.states().find((state) => state.name === 'healthy')?.status).toBe('ready');

    await manager.disconnect('healthy');
  });

  it('retries a failed server on the next connect', async () => {
    const dir = makeTempDir();
    const dyingPath = writeFakeServer('exit-on-list', dir);
    const healthyPath = writeFakeServer('legacy', dir);
    const manager = createMcpManager();

    const failed = await manager.connect(stdioConfig('flaky', dyingPath, 'exit-on-list'));
    expect(failed.status).toBe('failed');

    const retried = await manager.connect(stdioConfig('flaky', healthyPath, 'legacy'));
    expect(retried.status).toBe('ready');

    await manager.disconnect('flaky');
  });

  it('fetches the capabilities separately and aggregates them', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const manager = createMcpManager();
    await manager.connect(stdioConfig('caps', serverPath, 'legacy'));

    const connection = manager.connection('caps');
    expect(connection).toBeDefined();

    const tools = await fetchToolsForClient(connection!);
    const commands = await fetchCommandsForClient(connection!);
    const resources = await fetchResourcesForClient(connection!);
    const templates = await fetchResourceTemplatesForClient(connection!);

    expect(tools.map((tool) => tool.name)).toEqual(['echo']);
    expect(commands.map((command) => command.name)).toEqual(['greet']);
    expect(resources.map((resource) => resource.uri)).toEqual(['file:///notes.txt']);
    expect(templates.map((template) => template.uriTemplate)).toEqual(['file:///{path}']);

    const all = await getMcpToolsCommandsAndResources(connection!);
    expect(all.tools).toHaveLength(1);
    expect(all.commands).toHaveLength(1);
    expect(all.resources).toHaveLength(1);
    expect(all.resourceTemplates).toHaveLength(1);

    await manager.disconnect('caps');
  });

  it('reports the tools of a server and forgets a disconnected one', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const manager = createMcpManager();

    await manager.connect(stdioConfig('notes', serverPath, 'legacy'));
    expect(manager.toolsFor('notes')).toEqual([{ name: 'mcp__notes__echo', title: 'Echo' }]);
    expect(manager.toolsFor('nope')).toEqual([]);

    await manager.disconnect('notes');
    expect(manager.toolsFor('notes')).toEqual([]);
    expect(manager.states().find((state) => state.name === 'notes')?.status).toBe('disabled');
  });
});

/* -------------------------------------------------------------------------- */
/* The connect memo                                                           */
/* -------------------------------------------------------------------------- */

describe('the MCP connect memo', () => {
  it('treats a different environment, credential or connection as a different server', () => {
    const base: McpServerConfig = { name: 'identity', type: 'stdio', command: 'server' };

    expect(mcpConfigKey(base)).not.toBe(
      mcpConfigKey({ ...base, env: { TOKEN: 'one' } }),
    );
    expect(mcpConfigKey({ ...base, env: { TOKEN: 'one' } })).not.toBe(
      mcpConfigKey({ ...base, env: { TOKEN: 'two' } }),
    );
    expect(
      mcpConfigKey({ ...base, credential: { present: true, value: 'one' } }),
    ).not.toBe(mcpConfigKey({ ...base, credential: { present: true, value: 'two' } }));
    expect(mcpConfigKey({ ...base, connectionId: 'one' })).not.toBe(
      mcpConfigKey({ ...base, connectionId: 'two' }),
    );
  });

  it('never puts a secret in the configuration identity', () => {
    const key = mcpConfigKey({
      name: 'identity',
      type: 'stdio',
      command: 'server',
      env: { TOKEN: 'super-secret' },
      credential: { present: true, value: 'super-secret' },
    });

    expect(key).not.toContain('super-secret');
  });

  it('gives two environments that differ only by a newline different identities', () => {
    const base: McpServerConfig = { name: 'identity', type: 'stdio', command: 'server' };

    // The two environments differ only in where the newline falls, so a
    // delimiter-joined encoding would give them the same identity.
    expect(mcpConfigKey({ ...base, env: { A: '1\nB=2' } })).not.toBe(
      mcpConfigKey({ ...base, env: { A: '1', B: '2' } }),
    );
    expect(mcpConfigKey({ ...base, env: { A: '1\nB=2' } })).not.toBe(
      mcpConfigKey({ ...base, env: { A: '1\nB=3' } }),
    );
  });

  it('memoizes the connect result and drops it when the identity epoch changes', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const manager = createMcpManager();
    const config = stdioConfig('memo', serverPath, 'legacy');

    await manager.connect(config);
    const first = manager.connection('memo');
    expect(first).toBeDefined();
    expect(hasLiveConnection('memo')).toBe(true);

    await manager.connect(config);
    expect(manager.connection('memo')).toBe(first);

    const epoch = getMcpIdentityEpoch();
    evictAllMcpMemosOnIdentityChange();
    expect(getMcpIdentityEpoch()).toBe(epoch + 1);
    expect(hasLiveConnection('memo')).toBe(false);

    await manager.connect(config);
    expect(manager.connection('memo')).not.toBe(first);

    await manager.disconnect('memo');
  });

  it('drops the memo explicitly and reports an unsettled dial while connecting', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const manager = createMcpManager();
    const config = stdioConfig('dial', serverPath, 'legacy');

    const pending = manager.connect(config);
    expect(hasUnsettledDial('dial')).toBe(true);
    await pending;
    expect(hasUnsettledDial('dial')).toBe(false);

    expect(discardMemoizedConnectResult('dial')).toBe(true);
    expect(discardMemoizedConnectResult('dial')).toBe(false);
    expect(hasLiveConnection('dial')).toBe(false);

    await manager.disconnect('dial');
  });

  it('evicts a stale failed memo so the server is retried', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const manager = createMcpManager();
    const config = stdioConfig('stale', serverPath, 'legacy');

    await manager.connect(config);
    expect(evictStaleFailedConnectMemoForServe('stale')).toBe(false);
    expect(evictStaleFailedConnectMemoForServe('never-seen')).toBe(false);

    await manager.disconnect('stale');
  });

  it('evicts a failed memo and retries the server', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const manager = createMcpManager();

    // A server that cannot be reached leaves a **failed** memo behind.
    const failed = await manager.connect({ name: 'failed-memo', type: 'sdk' });
    expect(failed.status).toBe('failed');

    // The failed memo is stale, and evicting it says so.
    expect(evictStaleFailedConnectMemoForServe('failed-memo')).toBe(true);
    // It is gone, so a second eviction finds nothing.
    expect(evictStaleFailedConnectMemoForServe('failed-memo')).toBe(false);

    // The next connect retries the server rather than handing out the failure.
    const retried = await manager.connect(stdioConfig('failed-memo', serverPath, 'legacy'));
    expect(retried.status).toBe('ready');
    expect(retried.error).toBeUndefined();

    await manager.disconnect('failed-memo');
  });

  it('keeps a failed memo that is not yet stale and evicts it once it is stale', async () => {
    const manager = createMcpManager();

    // A server that cannot be reached leaves a **failed** memo behind.
    const failed = await manager.connect({ name: 'fresh-failure', type: 'sdk' });
    expect(failed.status).toBe('failed');

    // The memo is not yet stale, so it is kept.
    expect(
      evictStaleFailedConnectMemoForServe('fresh-failure', MCP_FAILED_MEMO_MAX_AGE_MS),
    ).toBe(false);

    // Once it is older than the threshold it goes stale, and it is evicted.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + MCP_FAILED_MEMO_MAX_AGE_MS + 1);
    try {
      expect(
        evictStaleFailedConnectMemoForServe('fresh-failure', MCP_FAILED_MEMO_MAX_AGE_MS),
      ).toBe(true);
    } finally {
      clock.mockRestore();
    }

    // And it is gone.
    expect(
      evictStaleFailedConnectMemoForServe('fresh-failure', MCP_FAILED_MEMO_MAX_AGE_MS),
    ).toBe(false);
  });

  it('closes the superseded connection when the configuration changed', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);

    const events: string[] = [];
    const off = onMcpServerConnectionEvent((event) => {
      events.push(`${event.type}:${event.server}`);
    });

    const first = await ensureConnectedClient(
      stdioConfig('superseded', serverPath, 'legacy', { env: { FAKE_MCP_MARKER: '1' } }),
    );
    expect(first.isLive()).toBe(true);

    // The configuration changed, so the memoized connection is superseded.
    const second = await ensureConnectedClient(
      stdioConfig('superseded', serverPath, 'legacy', { env: { FAKE_MCP_MARKER: '2' } }),
    );
    expect(second).not.toBe(first);

    // The superseded connection is closed rather than left running, and the
    // close is reported.
    expect(first.isLive()).toBe(false);
    expect(events).toContain('closed:superseded');

    off();
    await cleanupConnectedMcpClients();
  });
});

/* -------------------------------------------------------------------------- */
/* The listing hydration                                                      */
/* -------------------------------------------------------------------------- */

describe('the MCP listing hydration', () => {
  it('hydrates a listing without re-discovering it', () => {
    const listing: McpListing = {
      server: 'listing-server',
      tools: [{ name: 'echo', title: 'Echo', description: 'Echo' }],
      commands: [{ name: 'greet' }],
      resources: [],
      resourceTemplates: [],
    };

    expect(getRememberedDiscoverPrior('listing-server')).toBe(false);
    expect(getListingDiscoverPrior(listing)).toBe(false);

    const tools = hydrateToolsFromListing(listing);
    const commands = hydrateCommandsFromListing(listing);

    expect(tools.map((tool) => tool.name)).toEqual(['echo']);
    expect(commands.map((command) => command.name)).toEqual(['greet']);
    expect(getRememberedDiscoverPrior('listing-server')).toBe(true);
    expect(getListingDiscoverPrior(listing)).toBe(true);

    // A second hydration does not re-discover the listing.
    hydrateToolsFromListing(listing);
    expect(getListingDiscoverPrior(listing)).toBe(true);

    rememberDiscoverPrior('listing-server');
    expect(getRememberedDiscoverPrior('listing-server')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The tool composition                                                       */
/* -------------------------------------------------------------------------- */

describe('the MCP tool composition', () => {
  it('names a tool mcp__<server>__<tool> and caps its instructions', () => {
    const tool: McpToolDefinition = {
      name: 'echo',
      title: 'Echo',
      description: 'Echo the input back',
      inputSchema: { type: 'object' },
      instructions: 'x'.repeat(5000),
    };

    const composed = composeMcpTool('notes', tool);

    expect(composed.name).toBe('mcp__notes__echo');
    expect(mcpToolName('notes', 'echo')).toBe('mcp__notes__echo');
    expect(composed.title).toBe('Echo');
    expect(composed.description).toBe('Echo the input back');
    expect(composed.instructions?.length).toBeLessThan(5000);
    expect(composed.instructions).toContain('truncated');
  });

  it('caps the instructions at the given length', () => {
    expect(capMcpInstructions(undefined)).toBeUndefined();
    expect(capMcpInstructions('short')).toBe('short');
    // The result is never longer than the cap.
    expect(capMcpInstructions('abcdef', 3)).toBe('abc');
    expect(capMcpInstructions('abcdef', 6)).toBe('abcdef');
    const capped = capMcpInstructions('x'.repeat(100), 20);
    expect(capped?.length).toBe(20);
    expect(capped).toContain('truncated');
  });

  it('special-cases the mcp__ide__ tools', () => {
    expect(IDE_MCP_TOOL_NAMES).toEqual(['mcp__ide__executeCode', 'mcp__ide__getDiagnostics']);
    expect(isIdeMcpTool('mcp__ide__executeCode')).toBe(true);
    expect(isIdeMcpTool('mcp__ide__other')).toBe(true);
    expect(isIdeMcpTool('mcp__notes__echo')).toBe(false);

    // The general "hide the mcp__ide__ tools" filter spares the two.
    expect(shouldHideMcpTool('mcp__ide__executeCode')).toBe(false);
    expect(shouldHideMcpTool('mcp__ide__getDiagnostics')).toBe(false);
    expect(shouldHideMcpTool('mcp__ide__other')).toBe(true);
    expect(shouldHideMcpTool('mcp__notes__echo')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Calling a tool                                                             */
/* -------------------------------------------------------------------------- */

describe('calling an MCP tool', () => {
  it('calls a tool and reports the result', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const manager = createMcpManager();
    await manager.connect(stdioConfig('caller', serverPath, 'legacy'));

    const connection = manager.connection('caller');
    const result = await manager.callTool('caller', 'echo', { text: 'hi' });

    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain('echo:');
    expect(isUrlElicitationResult(result)).toBe(false);
    expect(connection).toBeDefined();

    await manager.disconnect('caller');
  });

  it('retries once when the server elicits a URL', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const stateFile = path.join(dir, 'counter.txt');
    const manager = createMcpManager();
    await manager.connect(
      stdioConfig('elicit', serverPath, 'legacy', { env: { FAKE_MCP_STATE_FILE: stateFile } }),
    );

    const elicitations: string[] = [];
    const result = await manager.callToolWithUrlElicitationRetry('elicit', 'elicitate', {}, {
      onUrlElicitation: (elicitation) => {
        elicitations.push(elicitation.url);
      },
    });

    expect(elicitations).toEqual(['https://example.com/authorize']);
    expect(result.isError).toBe(false);

    await manager.disconnect('elicit');
  });
});

/* -------------------------------------------------------------------------- */
/* The auth failures                                                          */
/* -------------------------------------------------------------------------- */

describe('the MCP auth failures', () => {
  it('classifies an auth failure', () => {
    expect(classifyMcpAuthFailure({ status: 401 })).toBe('unauthorized');
    expect(classifyMcpAuthFailure({ status: 403 })).toBe('forbidden');
    expect(classifyMcpAuthFailure({ status: 401, body: '{"error":{"type":"authentication_error"}}' })).toBe(
      'expired_token',
    );
    expect(classifyMcpAuthFailure(new Error('connect ECONNREFUSED'))).toBe('network');
    expect(classifyMcpAuthFailure({ status: 500 })).toBe('unknown');
    expect(classifyMcpAuthFailure(undefined)).toBe('unknown');
  });

  it('inspects the error body for a code', () => {
    expect(hasEraCodeInHttpErrorBody('{"error":{"type":"authentication_error"}}', 'authentication_error')).toBe(
      true,
    );
    expect(hasEraCodeInHttpErrorBody('{"error":{"type":"other"}}', 'authentication_error')).toBe(false);
    expect(hasEraCodeInHttpErrorBody({ code: 'authentication_error' }, 'authentication_error')).toBe(true);
    expect(hasEraCodeInHttpErrorBody({ error: { type: 'authentication_error' } }, 'authentication_error')).toBe(
      true,
    );
    expect(hasEraCodeInHttpErrorBody(undefined, 'authentication_error')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The fetch variants                                                         */
/* -------------------------------------------------------------------------- */

describe('the MCP fetch variants', () => {
  it('has four distinct variants', () => {
    const variants = [
      createAgentAiProxyFetch({ baseUrl: 'https://proxy.invalid' }),
      createFirstPartyApiMcpFetch(),
      createCliOwnedBearerFetch(),
      createCcrProxyFetch({ baseUrl: 'https://ccr.invalid' }),
    ];
    expect(new Set(variants).size).toBe(4);
  });

  it('routes the proxy variants through their base URL and presents a bearer token', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url: String(input), headers });
      return new Response('{}', { status: 200 });
    });

    await createAgentAiProxyFetch({
      baseUrl: 'https://proxy.invalid/api',
      token: 'proxy-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })('https://server.invalid/mcp', { headers: { authorization: 'Bearer caller-token' } });

    expect(seen[0]?.url).toBe('https://proxy.invalid/api/mcp');
    expect(seen[0]?.headers['authorization']).toBe('Bearer proxy-token');
    // The proxy variant is told apart by its own marker.
    expect(seen[0]?.headers['x-claude-ai-proxy']).toBe('1');
  });

  it('presents the first-party API key in its own header and keeps the API version', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url: String(input), headers });
      return new Response('{}', { status: 200 });
    });

    await createFirstPartyApiMcpFetch({
      token: 'first-party-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })('https://api.invalid/v1/mcp');

    expect(seen[0]?.url).toBe('https://api.invalid/v1/mcp');
    expect(seen[0]?.headers['x-api-key']).toBe('first-party-token');
    expect(seen[0]?.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('lets the CLI owned bearer token win over a caller supplied authorization header', async () => {
    const seen: Array<{ headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      seen.push({ headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response('{}', { status: 200 });
    });

    await createCliOwnedBearerFetch({
      token: 'cli-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })('https://server.invalid/mcp', { headers: { authorization: 'Bearer caller-token' } });

    expect(seen[0]?.headers['authorization']).toBe('Bearer cli-token');
  });

  it('does not leak the caller credentials to the CCR proxy', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      seen.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response('{}', { status: 200 });
    });

    await createCcrProxyFetch({
      baseUrl: 'https://ccr.invalid',
      token: 'ccr-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })('https://server.invalid/mcp', {
      headers: { authorization: 'Bearer caller-token', 'x-api-key': 'caller-key' },
    });

    expect(seen[0]?.url).toBe('https://ccr.invalid/mcp');
    expect(seen[0]?.headers['authorization']).toBe('Bearer ccr-token');
    expect(seen[0]?.headers['x-api-key']).toBeUndefined();
    // The CCR proxy variant is told apart by its own marker.
    expect(seen[0]?.headers['x-ccr-proxy']).toBe('1');
    // The two proxy variants are told apart from each other.
    expect(seen[0]?.headers['x-claude-ai-proxy']).toBeUndefined();
  });

  it('tells the four variants apart by their markers', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response('{}', { status: 200 });
    });
    const asFetch = fetchImpl as unknown as typeof fetch;

    await createAgentAiProxyFetch({ fetchImpl: asFetch })('https://a.invalid/mcp');
    await createFirstPartyApiMcpFetch({ fetchImpl: asFetch })('https://b.invalid/mcp');
    await createCliOwnedBearerFetch({ fetchImpl: asFetch })('https://c.invalid/mcp');
    await createCcrProxyFetch({ fetchImpl: asFetch })('https://d.invalid/mcp');

    const [claudeAi, firstParty, cliOwned, ccr] = seen;
    expect(claudeAi?.['x-claude-ai-proxy']).toBe('1');
    expect(claudeAi?.['x-ccr-proxy']).toBeUndefined();
    expect(ccr?.['x-ccr-proxy']).toBe('1');
    expect(ccr?.['x-claude-ai-proxy']).toBeUndefined();
    expect(firstParty?.['anthropic-version']).toBe('2023-06-01');
    expect(firstParty?.['x-claude-ai-proxy']).toBeUndefined();
    expect(cliOwned?.['x-claude-ai-proxy']).toBeUndefined();
    expect(cliOwned?.['x-ccr-proxy']).toBeUndefined();
  });

  it('gives the CLI-owned variant no marker of its own', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response('{}', { status: 200 });
    });

    await createCliOwnedBearerFetch({
      token: 'cli-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })('https://c.invalid/mcp');

    // The CLI-owned variant is told apart by what it does **not** carry: it
    // has no marker of its own.
    expect(seen[0]?.['x-claude-ai-proxy']).toBeUndefined();
    expect(seen[0]?.['x-ccr-proxy']).toBeUndefined();
    expect(seen[0]?.['anthropic-version']).toBeUndefined();
    // Its credential is the CLI's own bearer.
    expect(seen[0]?.['authorization']).toBe('Bearer cli-token');
  });

  it('does not let the configured headers defeat a variant own marker or credential', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response('{}', { status: 200 });
    });
    const asFetch = fetchImpl as unknown as typeof fetch;

    await createAgentAiProxyFetch({
      token: 'proxy-token',
      headers: { 'x-claude-ai-proxy': '0', authorization: 'Bearer caller-secret' },
      fetchImpl: asFetch,
    })('https://server.invalid/mcp');

    // The variant's own marker wins ...
    expect(seen[0]?.['x-claude-ai-proxy']).toBe('1');
    // ... and the caller's credential is not forwarded to the proxy host.
    expect(seen[0]?.['authorization']).toBe('Bearer proxy-token');

    await createCcrProxyFetch({
      token: 'ccr-token',
      headers: { 'x-ccr-proxy': '0', 'x-api-key': 'caller-key' },
      fetchImpl: asFetch,
    })('https://server.invalid/mcp');

    expect(seen[1]?.['x-ccr-proxy']).toBe('1');
    expect(seen[1]?.['x-api-key']).toBeUndefined();
    expect(seen[1]?.['authorization']).toBe('Bearer ccr-token');

    await createFirstPartyApiMcpFetch({
      token: 'first-party-token',
      headers: { 'anthropic-version': '1999-01-01', 'x-api-key': 'caller-key' },
      fetchImpl: asFetch,
    })('https://api.invalid/v1/mcp');

    expect(seen[2]?.['anthropic-version']).toBe('2023-06-01');
    expect(seen[2]?.['x-api-key']).toBe('first-party-token');

    await createCliOwnedBearerFetch({
      token: 'cli-token',
      headers: { authorization: 'Bearer caller-secret' },
      fetchImpl: asFetch,
    })('https://server.invalid/mcp');

    expect(seen[3]?.['authorization']).toBe('Bearer cli-token');
  });

  it('keeps a header whose name is __proto__', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response('{}', { status: 200 });
    });

    // A JSON-parsed object carries `__proto__` as an **own** key.
    const raw = JSON.parse('{"__proto__":"value"}') as Record<string, string>;

    await createAgentAiProxyFetch({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })('https://server.invalid/mcp', { headers: raw });

    // The header is neither lost nor turned into a prototype.
    expect(seen[0]?.['__proto__']).toBe('value');
    expect(Object.getPrototypeOf(seen[0] as Record<string, string>)).toBe(null);
  });
});

/* -------------------------------------------------------------------------- */
/* The timeouts                                                               */
/* -------------------------------------------------------------------------- */

describe('the MCP timeouts', () => {
  it('has four distinct timeouts', () => {
    const values = [
      DEFAULT_MCP_TIMEOUTS.armedRequestTimeoutMs,
      DEFAULT_MCP_TIMEOUTS.requestTimeoutMs,
      DEFAULT_MCP_TIMEOUTS.toolTimeoutMs,
      DEFAULT_MCP_TIMEOUTS.toolIdleTimeoutMs,
    ];
    expect(new Set(values).size).toBe(4);
    for (const value of values) expect(value).toBeGreaterThan(0);
  });

  it('does not let the armed-request timeout cap an ordinary request', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const manager = createMcpManager({
      client: {
        timeouts: { armedRequestTimeoutMs: 50, requestTimeoutMs: 5_000 },
      },
    });

    // The server takes 400 ms to answer `tools/list`. The armed timeout is 50
    // ms, so a request that carried it would fail.
    const state = await manager.connect(
      stdioConfig('slow', serverPath, 'legacy', { env: { FAKE_MCP_DELAY_MS: '400' } }),
    );

    expect(state.status).toBe('ready');
    await manager.disconnect('slow');
  });

  it('does not let the armed-request timeout cap a tool call', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const manager = createMcpManager({
      client: {
        timeouts: { armedRequestTimeoutMs: 50, toolTimeoutMs: 5_000 },
      },
    });

    await manager.connect(
      stdioConfig('slow-tool', serverPath, 'legacy', { env: { FAKE_MCP_DELAY_MS: '400' } }),
    );
    const result = await manager.callTool('slow-tool', 'echo', { text: 'hi' });

    expect(result.isError).toBe(false);
    await manager.disconnect('slow-tool');
  });

  it('rejects a tool call that runs out of time with a tool timeout', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const manager = createMcpManager({
      client: { timeouts: { toolTimeoutMs: 150 } },
    });

    await manager.connect(
      stdioConfig('tool-timeout', serverPath, 'legacy', {
        env: { FAKE_MCP_CALL_DELAY_MS: '5000' },
      }),
    );

    const error = await manager.callTool('tool-timeout', 'echo', { text: 'hi' }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // The tool timeout is its own kind: it is not an ordinary request timeout.
    expect(error).toBeInstanceOf(McpTimeoutError);
    expect((error as McpTimeoutError).kind).toBe('tool');

    await manager.disconnect('tool-timeout');
  });

  it('rejects a silent tool call with a tool idle timeout', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const manager = createMcpManager({
      client: { timeouts: { toolIdleTimeoutMs: 120 } },
    });

    await manager.connect(
      stdioConfig('tool-idle', serverPath, 'legacy', {
        env: { FAKE_MCP_CALL_DELAY_MS: '5000' },
      }),
    );

    const error = await manager.callTool('tool-idle', 'echo', { text: 'hi' }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(McpTimeoutError);
    expect((error as McpTimeoutError).kind).toBe('toolIdle');

    await manager.disconnect('tool-idle');
  });

  it('rejects an ordinary request that runs out of time with a request timeout', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const manager = createMcpManager({
      client: { timeouts: { requestTimeoutMs: 150 } },
    });

    await manager.connect(
      stdioConfig('request-timeout', serverPath, 'legacy', {
        env: { FAKE_MCP_DELAY_MS: '5000', FAKE_MCP_DELAY_METHOD: 'prompts/list' },
      }),
    );

    const connection = manager.connection('request-timeout');
    expect(connection).toBeDefined();
    const error = await connection!.request('prompts/list', {}).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(McpTimeoutError);
    expect((error as McpTimeoutError).kind).toBe('request');

    await manager.disconnect('request-timeout');
  });

  it('rejects a connect that runs out of time with an armed-request timeout', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);

    // The server never answers the modern probe in time, so the **connect
    // phase** deadline fires.
    const error = await connectToServer(
      stdioConfig('armed-timeout', serverPath, 'legacy', {
        env: { FAKE_MCP_DELAY_MS: '5000', FAKE_MCP_DELAY_METHOD: 'server/discover' },
      }),
      { timeouts: { armedRequestTimeoutMs: 150 } },
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // The armed-request timeout is its own kind: it is not an ordinary
    // request timeout and not a tool timeout.
    expect(error).toBeInstanceOf(McpTimeoutError);
    expect((error as McpTimeoutError).kind).toBe('armedRequest');
  });
});

/* -------------------------------------------------------------------------- */
/* Teardown                                                                   */
/* -------------------------------------------------------------------------- */

describe('the MCP teardown', () => {
  it('closes the child process when the server is disconnected', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const manager = createMcpManager();

    await manager.connect(stdioConfig('closing', serverPath, 'legacy'));
    const connection = manager.connection('closing');
    expect(connection?.isLive()).toBe(true);

    await manager.disconnect('closing');

    expect(connection?.isLive()).toBe(false);
    expect(hasLiveConnection('closing')).toBe(false);
  });

  it('detaches and closes a connection', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const manager = createMcpManager();

    await manager.connect(stdioConfig('detached', serverPath, 'legacy'));
    const connection = manager.connection('detached');
    expect(connection).toBeDefined();

    await detachAndCloseConnection(connection!);

    expect(connection?.isLive()).toBe(false);
    expect(hasLiveConnection('detached')).toBe(false);
  });

  it('disposes a detached connection', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const manager = createMcpManager();

    await manager.connect(stdioConfig('disposed', serverPath, 'legacy'));
    const connection = manager.connection('disposed');
    expect(connection).toBeDefined();

    await disposeServerConnectionDetached(connection!);

    expect(connection?.isLive()).toBe(false);
  });

  it('cleans up the connected clients', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const manager = createMcpManager();

    await manager.connect(stdioConfig('cleanup-a', serverPath, 'legacy'));
    await manager.connect(stdioConfig('cleanup-b', serverPath, 'legacy'));
    expect(hasLiveConnection('cleanup-a')).toBe(true);
    expect(hasLiveConnection('cleanup-b')).toBe(true);

    await cleanupConnectedMcpClients();

    expect(hasLiveConnection('cleanup-a')).toBe(false);
    expect(hasLiveConnection('cleanup-b')).toBe(false);
  });

  it('describes a deliberately inert reconnect', () => {
    const shape = inertReconnectShape('notes');
    expect(shape.reconnected).toBe(false);
    expect(shape.inert).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The connection events                                                      */
/* -------------------------------------------------------------------------- */

describe('the MCP connection events', () => {
  it('publishes a connection event', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const manager = createMcpManager();

    const events: string[] = [];
    const off = onMcpServerConnectionEvent((event) => {
      events.push(`${event.type}:${event.server}`);
    });

    await manager.connect(stdioConfig('evented', serverPath, 'legacy'));
    off();

    expect(events).toContain('connected:evented');

    await manager.disconnect('evented');
  });

  it('publishes a closed event when a connection is closed', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const manager = createMcpManager();

    const events: string[] = [];
    const off = onMcpServerConnectionEvent((event) => {
      events.push(`${event.type}:${event.server}`);
    });

    await manager.connect(stdioConfig('closed-event', serverPath, 'legacy'));
    await manager.disconnect('closed-event');
    off();

    expect(events).toContain('connected:closed-event');
    expect(events).toContain('closed:closed-event');
  });
});

/* -------------------------------------------------------------------------- */
/* The protocol-version header contract                                      */
/* -------------------------------------------------------------------------- */

describe('the MCP protocol-version header', () => {
  it('answers a missing header with a 400', () => {
    const check = checkMcpProtocolVersionHeader(undefined);
    expect(check.ok).toBe(false);
    expect(check.status).toBe(400);
    expect(check.error).toContain('missing');
  });

  it('answers an unsupported header with a 400', () => {
    const check = checkMcpProtocolVersionHeader('1999-01-01');
    expect(check.ok).toBe(false);
    expect(check.status).toBe(400);
  });

  it('accepts a supported header', () => {
    expect(checkMcpProtocolVersionHeader(MODERN_PROTOCOL_VERSION).ok).toBe(true);
    expect(checkMcpProtocolVersionHeader(LEGACY_PROTOCOL_VERSION).ok).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The negotiation path                                                       */
/* -------------------------------------------------------------------------- */

describe('the MCP negotiation path', () => {
  it('is the modern revision unless the legacy opt-out is set', () => {
    expect(getMcpVersionNegotiation({})).toBe('modern');
    expect(getMcpVersionNegotiation({ MCP_PROTOCOL_NEGOTIATION: 'legacy' })).toBe('legacy');
    expect(getMcpVersionNegotiation({ MCP_PROTOCOL_NEGOTIATION: 'modern' })).toBe('modern');
  });

  it('recognises the unsupported-protocol-version error', () => {
    expect(UNSUPPORTED_PROTOCOL_VERSION).toBe(-32022);
    expect(isUnsupportedProtocolVersionError(new McpRpcError(-32022, 'nope'))).toBe(true);
    expect(isUnsupportedProtocolVersionError(new McpRpcError(-32601, 'nope'))).toBe(false);
    expect(isMethodNotFoundError(new McpRpcError(-32601, 'nope'))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The remote host lists                                                      */
/* -------------------------------------------------------------------------- */

describe('the remote host lists', () => {
  it('matches a host and its sub-domains', () => {
    expect(hostMatches('example.com', 'example.com')).toBe(true);
    expect(hostMatches('example.com', 'api.example.com')).toBe(true);
    expect(hostMatches('*.example.com', 'api.example.com')).toBe(true);
    expect(hostMatches('example.com', 'notexample.com')).toBe(false);
  });

  it('lets a deny list win over an allow list', () => {
    expect(isRemoteHostAllowed('https://api.example.com/mcp', { allow: ['example.com'] })).toBe(true);
    expect(
      isRemoteHostAllowed('https://api.example.com/mcp', {
        allow: ['example.com'],
        deny: ['api.example.com'],
      }),
    ).toBe(false);
    expect(isRemoteHostAllowed('https://other.invalid/mcp', { allow: ['example.com'] })).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The caller-supplied names                                                  */
/* -------------------------------------------------------------------------- */

describe('the caller-supplied names', () => {
  it('does not let an Object.prototype member name resolve to an inherited member', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const manager = createMcpManager();

    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const state = await manager.connect(stdioConfig(name, serverPath, 'legacy'));
      expect(state.name, name).toBe(name);
      expect(state.status, name).toBe('ready');
      expect(manager.toolsFor(name), name).toEqual([{ name: `mcp__${name}__echo`, title: 'Echo' }]);
      await manager.disconnect(name);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The transport seam                                                         */
/* -------------------------------------------------------------------------- */

describe('the transport seam', () => {
  it('connects an in-process sdk server through an injected transport', async () => {
    let transport: McpTransport;
    transport = {
      start: async () => undefined,
      send: async (message: { id?: unknown; method?: unknown }) => {
        const id = message.id;
        if (message.method === 'server/discover') {
          queueMicrotask(() => {
            transport.onmessage?.({
              jsonrpc: '2.0',
              id,
              result: {
                protocolVersion: MODERN_PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: 'in-process', version: '1.0.0' },
              },
            });
          });
          return;
        }
        if (message.method === 'tools/list') {
          queueMicrotask(() => {
            transport.onmessage?.({
              jsonrpc: '2.0',
              id,
              result: { tools: [{ name: 'ping', title: 'Ping' }] },
            });
          });
        }
      },
      close: async () => {
        transport.onclose?.();
      },
    };

    const manager = createMcpManager({
      client: { transportFactory: () => transport },
    });

    const state = await manager.connect({ name: 'in-process', type: 'sdk' });

    expect(state.status).toBe('ready');
    expect(state.protocolVersion).toBe(MODERN_PROTOCOL_VERSION);
    expect(state.tools).toEqual([{ name: 'mcp__in-process__ping', title: 'Ping' }]);

    await manager.disconnect('in-process');
  });

  it('refuses a server type it cannot reach without a transport factory', async () => {
    const manager = createMcpManager();
    const state = await manager.connect({ name: 'nowhere', type: 'sdk' });
    expect(state.status).toBe('failed');
    expect(state.error).toContain('transport factory');
  });

  it('names the offending value when a configuration has no name', async () => {
    const manager = createMcpManager();
    const state = await manager.connect({ name: '', type: 'stdio', command: 'server' });
    expect(state.status).toBe('failed');
    expect(state.error).toContain('non-empty name');
    // The error names the value it was given.
    expect(state.error).toContain('""');
  });
});

/* -------------------------------------------------------------------------- */
/* The HTTP transport                                                         */
/* -------------------------------------------------------------------------- */

describe('the HTTP transport', () => {
  it('connects an http server end to end', async () => {
    const stub = await startStubHttpServer((message) => {
      if (message.method === 'server/discover') {
        return {
          status: 200,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: MODERN_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: 'stub', version: '1.0.0' },
            },
          }),
        };
      }
      if (message.method === 'tools/list') {
        return {
          status: 200,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { tools: [{ name: 'ping', title: 'Ping' }] },
          }),
        };
      }
      return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) };
    });

    const manager = createMcpManager();
    const state = await manager.connect({ name: 'remote', type: 'http', url: stub.url });

    expect(state.status).toBe('ready');
    expect(state.protocolVersion).toBe(MODERN_PROTOCOL_VERSION);
    expect(state.tools).toEqual([{ name: 'mcp__remote__ping', title: 'Ping' }]);
    expect(stub.methods).toContain('server/discover');

    await manager.disconnect('remote');
    await stub.close();
  });

  it('uses the injected fetch implementation', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(input), headers });
      const message = JSON.parse(String(init?.body)) as { method: string; id?: unknown };
      const result =
        message.method === 'server/discover'
          ? { protocolVersion: MODERN_PROTOCOL_VERSION, capabilities: { tools: {} } }
          : { tools: [{ name: 'ping', title: 'Ping' }] };
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, result }),
        { status: 200 },
      );
    });

    const manager = createMcpManager({
      client: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    const state = await manager.connect({
      name: 'injected',
      type: 'http',
      url: 'https://mcp.invalid/mcp',
    });

    expect(state.status).toBe('ready');
    expect(calls[0]?.url).toBe('https://mcp.invalid/mcp');
    // The transport presents the protocol version in its header.
    expect(calls[0]?.headers['MCP-Protocol-Version']).toBe(MODERN_PROTOCOL_VERSION);

    await manager.disconnect('injected');
  });

  it('presents the negotiated version to a modern http server', async () => {
    // The server negotiates a modern revision of its own.
    const negotiated = '2026-09-01';
    const stub = await startStubHttpServer((message) => {
      if (message.method === 'server/discover') {
        return {
          status: 200,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { protocolVersion: negotiated, capabilities: { tools: {} } },
          }),
        };
      }
      if (message.method === 'tools/list') {
        return {
          status: 200,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { tools: [{ name: 'ping', title: 'Ping' }] },
          }),
        };
      }
      return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) };
    });

    const manager = createMcpManager();
    const state = await manager.connect({ name: 'modern-remote', type: 'http', url: stub.url });

    expect(state.status).toBe('ready');
    expect(state.protocolVersion).toBe(negotiated);

    // The transport presents the version that was **negotiated**, not the one
    // the probe was made with.
    const listIndex = stub.methods.indexOf('tools/list');
    expect(listIndex).toBeGreaterThanOrEqual(0);
    expect(stub.headers[listIndex]?.['mcp-protocol-version']).toBe(negotiated);

    await manager.disconnect('modern-remote');
    await stub.close();
  });

  it('presents the negotiated version to a legacy-only http server', async () => {
    const stub = await startStubHttpServer((message, headers) => {
      const version = headers['mcp-protocol-version'];
      // The server only speaks the legacy era: it refuses the modern revision
      // with the server-side version contract's 400.
      if (message.method === 'server/discover') {
        return { status: 400, body: JSON.stringify({ error: 'unsupported protocol version' }) };
      }
      if (version !== LEGACY_PROTOCOL_VERSION) {
        return { status: 400, body: JSON.stringify({ error: 'unsupported protocol version' }) };
      }
      if (message.method === 'initialize') {
        return {
          status: 200,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: LEGACY_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: 'legacy-stub', version: '1.0.0' },
            },
          }),
        };
      }
      if (message.method === 'tools/list') {
        return {
          status: 200,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { tools: [{ name: 'ping', title: 'Ping' }] },
          }),
        };
      }
      return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) };
    });

    const manager = createMcpManager();
    const state = await manager.connect({ name: 'legacy-remote', type: 'http', url: stub.url });

    expect(state.status).toBe('ready');
    expect(state.protocolVersion).toBe(LEGACY_PROTOCOL_VERSION);

    // The header the transport presented for each request.
    const versions = stub.headers.map((headers) => headers['mcp-protocol-version']);
    const initializeIndex = stub.methods.indexOf('initialize');
    const listIndex = stub.methods.indexOf('tools/list');
    expect(initializeIndex).toBeGreaterThanOrEqual(0);
    expect(versions[initializeIndex]).toBe(LEGACY_PROTOCOL_VERSION);
    // The negotiated version is what the connection keeps presenting.
    expect(versions[listIndex]).toBe(LEGACY_PROTOCOL_VERSION);
    // The modern probe carried the modern version.
    expect(versions[0]).toBe(MODERN_PROTOCOL_VERSION);

    await manager.disconnect('legacy-remote');
    await stub.close();
  });
});

/* -------------------------------------------------------------------------- */
/* The batching                                                               */
/* -------------------------------------------------------------------------- */

describe('the MCP connection batching', () => {
  it('uses 3 for local servers and 20 for remote ones', () => {
    expect(LOCAL_CONNECT_BATCH_SIZE).toBe(3);
    expect(REMOTE_CONNECT_BATCH_SIZE).toBe(20);
    expect(getMcpServerConnectionBatchSize({})).toBe(3);
    expect(getRemoteMcpServerConnectionBatchSize({})).toBe(20);
    expect(getMcpServerConnectionBatchSize({ MCP_SERVER_CONNECTION_BATCH_SIZE: '5' })).toBe(5);
    expect(getRemoteMcpServerConnectionBatchSize({ MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE: '7' })).toBe(7);
  });

  it('classifies a remote server', () => {
    expect(isRemoteServerConfig({ name: 'a', type: 'stdio', command: 'x' })).toBe(false);
    expect(isRemoteServerConfig({ name: 'a', type: 'sdk' })).toBe(false);
    expect(isRemoteServerConfig({ name: 'a', type: 'http', url: 'https://x.invalid' })).toBe(true);
    expect(isRemoteServerConfig({ name: 'a', type: 'sse', url: 'https://x.invalid' })).toBe(true);
  });

  it('issues at most 3 concurrent local spawns for four local servers', async () => {
    let live = 0;
    let peak = 0;
    const connect = async (config: McpServerConfig) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 5));
      live -= 1;
      return { name: config.name, status: 'ready' as const, tools: [] };
    };

    const configs: McpServerConfig[] = ['a', 'b', 'c', 'd'].map((name) => ({
      name,
      type: 'stdio',
      command: 'server',
    }));

    const states = await connectServersInBatches(configs, { connect });

    expect(states).toHaveLength(4);
    expect(peak).toBeLessThanOrEqual(LOCAL_CONNECT_BATCH_SIZE);
    expect(peak).toBeGreaterThan(1);
  });

  it('issues at most 20 concurrent remote spawns', async () => {
    let live = 0;
    let peak = 0;
    const connect = async (config: McpServerConfig) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 2));
      live -= 1;
      return { name: config.name, status: 'ready' as const, tools: [] };
    };

    const configs: McpServerConfig[] = Array.from({ length: 25 }, (_, index) => ({
      name: `remote-${index}`,
      type: 'http',
      url: 'https://example.invalid/mcp',
    }));

    await connectServersInBatches(configs, { connect });

    expect(peak).toBeLessThanOrEqual(REMOTE_CONNECT_BATCH_SIZE);
    expect(peak).toBeGreaterThan(1);
  });

  it('keeps the connect concurrency of a real manager within the local batch size', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);

    const manager = createMcpManager();
    const connect = manager.connect.bind(manager);
    let live = 0;
    let peak = 0;
    manager.connect = async (config) => {
      live += 1;
      peak = Math.max(peak, live);
      try {
        return await connect(config);
      } finally {
        live -= 1;
      }
    };

    const configs: McpServerConfig[] = ['a', 'b', 'c', 'd'].map((name) =>
      stdioConfig(name, serverPath, 'legacy'),
    );

    const states = await manager.connectAll(configs);

    expect(states.every((state) => state.status === 'ready')).toBe(true);
    expect(peak).toBeLessThanOrEqual(LOCAL_CONNECT_BATCH_SIZE);
    expect(peak).toBeGreaterThan(1);

    for (const config of configs) await manager.disconnect(config.name);
  });
});

/* -------------------------------------------------------------------------- */
/* The tool description change                                                */
/* -------------------------------------------------------------------------- */

describe('the MCP tool description change', () => {
  it('reports a tool whose description changed', () => {
    const previous: McpToolDefinition[] = [
      { name: 'echo', description: 'Echo the input back' },
      { name: 'other', description: 'Unchanged' },
    ];
    const current: McpToolDefinition[] = [
      { name: 'echo', description: 'Exfiltrate the input' },
      { name: 'other', description: 'Unchanged' },
    ];

    const changes = detectToolDescriptionChanges('notes', previous, current);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.tool).toBe('echo');
    expect(changes[0]?.previous).toBe('Echo the input back');
    expect(changes[0]?.current).toBe('Exfiltrate the input');
  });

  it('re-surfaces the change through the manager', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const changes: string[] = [];
    const manager = createMcpManager({
      onToolDescriptionChanged: (change) => {
        changes.push(`${change.server}:${change.tool}`);
      },
    });

    await manager.connect(stdioConfig('rug', serverPath, 'legacy'));
    const state = await manager.refresh('rug', [
      { name: 'echo', title: 'Echo', description: 'A different description' },
    ]);

    expect(changes).toEqual(['rug:echo']);
    expect(state.descriptionChanges?.[0]?.current).toBe('A different description');

    await manager.disconnect('rug');
  });

  it('keeps the description baseline across a disconnect', async () => {
    const dir = makeTempDir();
    const serverPath = writeFakeServer('legacy', dir);
    const changes: string[] = [];
    const manager = createMcpManager({
      onToolDescriptionChanged: (change) => {
        changes.push(`${change.tool}:${change.previous}->${change.current}`);
      },
    });

    await manager.connect(
      stdioConfig('rug-across', serverPath, 'legacy', {
        env: { FAKE_MCP_TOOL_DESCRIPTION: 'The original description' },
      }),
    );
    await manager.disconnect('rug-across');

    // The server comes back with a different description.
    const state = await manager.connect(
      stdioConfig('rug-across', serverPath, 'legacy', {
        env: { FAKE_MCP_TOOL_DESCRIPTION: 'A different description' },
      }),
    );

    // The baseline survived the disconnect, so the change is detected.
    expect(state.descriptionChanges).toHaveLength(1);
    expect(state.descriptionChanges?.[0]?.previous).toBe('The original description');
    expect(state.descriptionChanges?.[0]?.current).toBe('A different description');
    expect(changes).toEqual(['echo:The original description->A different description']);

    await manager.disconnect('rug-across');
  });
});

/* -------------------------------------------------------------------------- */
/* The manager interface                                                      */
/* -------------------------------------------------------------------------- */

describe('the McpManager interface', () => {
  it('is implemented by the manager the plan fixes', () => {
    const manager: McpManager = createMcpManager();
    expect(typeof manager.connect).toBe('function');
    expect(typeof manager.disconnect).toBe('function');
    expect(typeof manager.states).toBe('function');
    expect(typeof manager.toolsFor).toBe('function');
    expect(manager.states()).toEqual([]);
  });
});

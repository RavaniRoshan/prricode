/**
 * The IDE bridge: the integrations the CLI can talk to, and the requests it
 * can apply to them.
 *
 * Evidence: the `CC-013` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`,
 * which names `IdeBridge` with `list()`, `resolve(name)` and `apply()`, and
 * the `CC-036` milestone, which reads the target's own IDE surface out of the
 * pinned build. The full reading, with every file and byte offset, is
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-ide-integration.md`.
 *
 * ## What is observed, and what is not
 *
 * The audit's §2.8 observes exactly two IDE tools: `mcp__ide__executeCode` and
 * `mcp__ide__getDiagnostics`, both special-cased in the MCP layer. It does
 * **not** describe an IDE integration surface — no lock files, no ports, no
 * discovery mechanism.
 *
 * `CC-036` read the rest of it out of the target's source: the **eighteen**
 * IDEs and their per-OS process keywords, the **lock-file protocol**, and the
 * **diagnostics subsystem**. Those live in their own modules, and the bridge
 * is the seam that reaches them:
 *
 *   - `./registry.js` — the IDE table, the display names, the process
 *     keywords and the detection rule;
 *   - `./lockfile.js` — the lock directories, the lock body, the port rule,
 *     the staleness rule and the discovery;
 *   - `./diagnostics.js` — the diagnostics shape, the validation rule, the
 *     baseline and the rendering.
 *
 * ## The action is a path segment (an implementation choice)
 *
 * The action is interpolated into the request path, so this implementation
 * **validates it as a single path segment**: it may not be empty, may not be
 * `.` or `..`, and may not carry a `/`, a `\` or a NUL. An action that fails
 * the check is refused before anything is sent.
 *
 * Implementation choice: the target's own behavior here is unobserved — the
 * audit names the two actions but says nothing about the request path — so the
 * check, and the fact that this implementation accepts an action **outside**
 * the two observed ones as long as it is a single segment, are this
 * implementation's.
 *
 * ## The lock file, and the two readers of it
 *
 * The bridge reads a lock file the **target's** way: the port is the **file
 * name's** suffix, the body is JSON with the target's field names, and a body
 * that is not JSON is a newline-delimited list of workspace folders.
 *
 * Two fields of the earlier, `CC-013` surface are kept as well — the `ide`
 * and `workspacePath` members — because the older surface is a **contract**
 * that already has tests against it. They are an implementation choice, and
 * they are the *fallbacks*: the target's own fields win when they are there.
 *
 * ## The honest boundary
 *
 * This implementation has **no IDE to talk to**: there is no extension, no
 * plugin, no lock file written by an IDE, no socket and no diagnostics
 * channel. So:
 *
 *   - the **table**, the **protocol** and the **shapes** are implemented;
 *   - the three operations that need an IDE — connecting to one, asking one
 *     for diagnostics, and installing the extension into one — **refuse**, and
 *     each refusal **names the capability** it needed.
 *
 * Nothing here invents a socket, and no stub pretends an extension connected.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isSafeLookupName, type DiscoveredItem, type DiscoverySource } from '../../extensions/skills/source.js';

import {
  IDE_CONNECTION_CAPABILITY,
  IDE_DIAGNOSTICS_CAPABILITY,
  IDE_EXTENSION_INSTALL_CAPABILITY,
  IdeCapabilityError,
  IdeDiagnosticsManager,
  type IdeDiagnosticFile,
} from './diagnostics.js';
import {
  discoverIdes,
  ideLockDirectories,
  parseIdeLock,
  sortIdeLockFiles,
  type DiscoveredIde,
  type IdeLock,
  type IdeLockEnvironment,
  type IdeLockFile,
} from './lockfile.js';
import {
  IDE_REGISTRY,
  ideDefinition,
  ideDisplayName,
  normalizeIdeName,
  type IdeDefinition,
} from './registry.js';

export type { DiscoveredItem, DiscoverySource } from '../../extensions/skills/source.js';

/** The transport an IDE integration listens on. */
export type IdeTransportKind = 'websocket' | 'http' | 'socket';

/** The actions the bridge applies to an IDE. */
export const IDE_ACTIONS = ['executeCode', 'getDiagnostics'] as const;

/** One of the observed IDE actions. */
export type IdeAction = (typeof IDE_ACTIONS)[number];

/**
 * Whether a value is one of the observed IDE actions.
 */
export function isIdeAction(value: unknown): value is IdeAction {
  return typeof value === 'string' && (IDE_ACTIONS as readonly string[]).includes(value);
}

/**
 * Whether an action may be used as a single path segment.
 *
 * The action is interpolated into the request path, so it may not be empty,
 * may not be `.` or `..`, and may not carry a separator or a NUL.
 *
 * Implementation choice — see the file header.
 */
export function isSafeIdeAction(action: string): boolean {
  if (action.length === 0) return false;
  if (action === '.' || action === '..') return false;
  if (action.includes('/') || action.includes('\\')) return false;
  if (action.includes('\0')) return false;
  return true;
}

/**
 * The reason an action is refused.
 */
export const IDE_UNSAFE_ACTION_ERROR =
  'The action is not a valid IDE action: it must be a single path segment.';

/** An IDE integration the CLI can talk to. */
export interface IdeIntegration {
  /** The integration's name — the IDE's own name, lower-cased. */
  name: string;
  /** The transport the IDE listens on. */
  transport: IdeTransportKind;
  /** The endpoint the IDE listens on, when it has one. */
  endpoint?: string;
  /** The workspace the IDE has open. */
  workspacePath?: string;
  /** The lock file the integration was discovered from. */
  lockPath: string;
  /** Whether the integration looks alive. */
  alive: boolean;
  /** Where the integration came from. */
  source: DiscoverySource;
}

/** A request applied to an IDE. */
export interface IdeRequest {
  /** The IDE the request is for. */
  ide: string;
  /**
   * The action to apply.
   *
   * The action is a **single path segment**: it may not be empty, may not be
   * `.` or `..`, and may not carry a separator. An action outside the two
   * observed ones is accepted as long as it is a single segment.
   */
  action: IdeAction | (string & {});
  /** The action's argument, when it takes one. */
  argument?: string;
}

/** The result of applying a request. */
export interface IdeResponse {
  /** Whether the request was applied. */
  ok: boolean;
  /** The IDE the request was for. */
  ide: string;
  /** The action that was applied. */
  action: string;
  /** The result, when the request succeeded. */
  result?: unknown;
  /** The reason the request failed, when it did. */
  error?: string;
}

/** The transport the bridge sends a request over. */
export interface IdeTransport {
  /** Send a request to an integration. */
  send(integration: IdeIntegration, request: IdeRequest): Promise<unknown>;
}

/** The IDE bridge. */
export interface IdeBridge {
  /** Every integration the bridge knows about. */
  list(): readonly IdeIntegration[];
  /** The integration with that name, or `undefined` when there is none. */
  resolve(name: string): IdeIntegration | undefined;
  /** The discovered integrations, in the shared `{ name, source, path }` shape. */
  discover(): readonly DiscoveredItem[];
  /** Apply a request to an integration. */
  apply(request: IdeRequest): Promise<IdeResponse>;

  /** The target's eighteen IDEs. */
  registry(): readonly IdeDefinition[];
  /** The registry entry for that IDE key, or `undefined`. */
  ide(key: string): IdeDefinition | undefined;
  /** The lock files the target's protocol finds, newest first. */
  lockFiles(): readonly IdeLockFile[];
  /** The lock files, parsed the target's way. */
  locks(): readonly IdeLock[];
  /** The IDEs the lock files name, the target's way. */
  ides(): readonly DiscoveredIde[];
  /** The diagnostics manager. */
  diagnostics(): IdeDiagnosticsManager;

  /** Connect to that IDE. */
  connect(ide: string): Promise<never>;
  /** Ask the IDE for its diagnostics. */
  requestDiagnostics(): Promise<never>;
  /** Install the extension into that IDE. */
  installExtension(ide: string): Promise<never>;
}

/** The options an IDE bridge is created with. */
export interface IdeBridgeOptions {
  /** The user's configuration directory (`~/.claude`). */
  configDir: string;
  /** The transport the requests go over. */
  transport?: IdeTransport;
  /** The user's home directory. */
  homeDir?: string;
  /**
   * The platform, as the target's own platform helper reports it.
   *
   * The target's helper names WSL `"wsl"`, which Node's own `os.platform()`
   * does not.
   */
  platform?: NodeJS.Platform | 'wsl';
  /** The environment the lock-file protocol reads. */
  env?: Readonly<Record<string, string | undefined>>;
  /** The session's working directory. */
  cwd?: string;
  /** The Windows user directories under `/mnt/c/Users`, under WSL. */
  windowsUserNames?: readonly string[];
}

/**
 * The lock file's own members, plus the two the earlier surface kept.
 *
 * The two `CC-013` members are the **fallbacks**: the target's own fields win
 * when they are there.
 */
interface IdeLockContents extends IdeLock {
  readonly ide?: string;
  readonly workspacePath?: string;
  readonly transport?: string;
  readonly alive?: boolean;
}

/**
 * Read a lock file the target's way, and keep the two older members.
 */
function readLock(lockPath: string): IdeLockContents {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch {
    return { workspaceFolders: [], port: Number.NaN, useWebSocket: false, runningInWindows: false };
  }

  const target = parseIdeLock(raw, path.basename(lockPath));

  let legacy: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) legacy = parsed as Record<string, unknown>;
  } catch {
    legacy = {};
  }

  const legacyPort = typeof legacy['port'] === 'number' ? legacy['port'] : undefined;
  const port = Number.isNaN(target.port) ? (legacyPort ?? Number.NaN) : target.port;

  const ideName = target.ideName ?? (typeof legacy['ide'] === 'string' ? legacy['ide'] : undefined);
  const workspacePath =
    typeof legacy['workspacePath'] === 'string' ? legacy['workspacePath'] : undefined;
  const transport = typeof legacy['transport'] === 'string' ? legacy['transport'] : undefined;
  const alive = typeof legacy['alive'] === 'boolean' ? legacy['alive'] : undefined;

  return {
    workspaceFolders: target.workspaceFolders,
    port,
    ...(target.pid === undefined ? {} : { pid: target.pid }),
    ...(ideName === undefined ? {} : { ideName }),
    useWebSocket: target.useWebSocket,
    runningInWindows: target.runningInWindows,
    ...(target.authToken === undefined ? {} : { authToken: target.authToken }),
    ...(legacy['ide'] === undefined ? {} : { ide: String(legacy['ide']) }),
    ...(workspacePath === undefined ? {} : { workspacePath }),
    ...(transport === undefined ? {} : { transport }),
    ...(alive === undefined ? {} : { alive }),
  };
}

function isAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // `EPERM` means the process exists but belongs to another user.
    return code === 'EPERM';
  }
}

/**
 * The default transport: an HTTP POST to the integration's loopback port.
 *
 * This implementation refuses to send anything to a host that is not a loopback address,
 * and refuses an action that is not a single path segment.
 */
export function createHttpIdeTransport(): IdeTransport {
  return {
    async send(integration: IdeIntegration, request: IdeRequest): Promise<unknown> {
      const endpoint = integration.endpoint;
      if (endpoint === undefined) {
        throw new Error(`The ${integration.name} integration has no endpoint.`);
      }
      if (!isSafeIdeAction(request.action)) {
        throw new Error(IDE_UNSAFE_ACTION_ERROR);
      }
      const url = new URL(endpoint);
      if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '::1') {
        throw new Error(`Refusing to send an IDE request to ${url.hostname}.`);
      }
      const response = await fetch(new URL(`/${request.action}`, url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ argument: request.argument }),
      });
      if (!response.ok) {
        throw new Error(`The ${integration.name} integration answered ${response.status}.`);
      }
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
  };
}

/**
 * Create an IDE bridge.
 *
 * The integrations are re-read from the lock files every time they are asked
 * for, so an integration that starts after the bridge was created is found.
 */
export function createIdeBridge(options: IdeBridgeOptions): IdeBridge {
  const transport = options.transport ?? createHttpIdeTransport();
  const lockDir = path.join(options.configDir, 'ide');

  const environment: IdeLockEnvironment = {
    configRoot: options.configDir,
    homeDir: options.homeDir ?? os.homedir(),
    platform: options.platform ?? os.platform(),
    env: options.env ?? process.env,
    ...(options.windowsUserNames === undefined
      ? {}
      : { windowsUserNames: options.windowsUserNames }),
  };

  const list = (): IdeIntegration[] => {
    let entries: string[] = [];
    try {
      entries = readdirSync(lockDir);
    } catch {
      return [];
    }

    const integrations: IdeIntegration[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.lock')) continue;
      const lockPath = path.join(lockDir, entry);
      const lock = readLock(lockPath);

      const name =
        typeof lock.ideName === 'string' && lock.ideName.length > 0
          ? lock.ideName
          : typeof lock.ide === 'string' && lock.ide.length > 0
            ? lock.ide
            : entry.slice(0, -'.lock'.length);

      const port = typeof lock.port === 'number' && !Number.isNaN(lock.port) ? lock.port : undefined;
      const endpoint = port === undefined ? undefined : `http://127.0.0.1:${port}`;
      const transportKind =
        lock.transport === 'websocket' || lock.transport === 'socket'
          ? (lock.transport as IdeTransportKind)
          : lock.useWebSocket
            ? 'websocket'
            : 'http';

      integrations.push({
        name,
        transport: transportKind,
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(typeof lock.workspacePath === 'string'
          ? { workspacePath: lock.workspacePath }
          : {}),
        lockPath,
        alive: lock.alive === false ? false : isAlive(lock.pid),
        source: 'local',
      });
    }
    return integrations;
  };

  const resolve = (name: string): IdeIntegration | undefined => {
    if (!isSafeLookupName(name)) return undefined;
    return list().find((integration) => integration.name === name);
  };

  /**
   * The lock files the target's protocol finds, newest first.
   *
   * The target reads **every** lock directory — the configuration root's, the
   * home directory's under an overridden or blank root, and, under WSL, the
   * Windows-side ones.
   */
  const lockFiles = (): IdeLockFile[] => {
    const found: IdeLockFile[] = [];
    for (const directory of ideLockDirectories(environment)) {
      let entries: string[] = [];
      try {
        entries = readdirSync(directory);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.lock')) continue;
        const lockPath = path.join(directory, entry);
        try {
          const stats = statSync(lockPath);
          found.push({ path: lockPath, mtime: stats.mtimeMs });
        } catch {
          continue;
        }
      }
    }
    return sortIdeLockFiles(found);
  };

  const locks = (): IdeLock[] => {
    const parsed: IdeLock[] = [];
    for (const file of lockFiles()) {
      let raw: string;
      try {
        raw = readFileSync(file.path, 'utf8');
      } catch {
        continue;
      }
      parsed.push(parseIdeLock(raw, path.basename(file.path)));
    }
    return parsed;
  };

  const ides = (): DiscoveredIde[] =>
    discoverIdes({
      cwd: options.cwd ?? process.cwd(),
      locks: locks(),
      fallbackName: 'IDE',
      ...(environment.env['CLAUDE_CODE_SSE_PORT'] === undefined
        ? {}
        : { ssePort: Number(environment.env['CLAUDE_CODE_SSE_PORT']) }),
      ...(environment.env['CLAUDE_CODE_IDE_SKIP_VALID_CHECK'] === undefined
        ? {}
        : { skipValidCheck: true }),
    });

  const manager = new IdeDiagnosticsManager();

  return {
    list(): readonly IdeIntegration[] {
      return list();
    },
    resolve,
    discover(): readonly DiscoveredItem[] {
      return list().map((integration) => ({
        name: integration.name,
        source: integration.source,
        path: integration.lockPath,
      }));
    },
    async apply(request: IdeRequest): Promise<IdeResponse> {
      // The action becomes a path segment, so it is validated before the
      // request is sent.
      if (!isSafeIdeAction(request.action)) {
        return {
          ok: false,
          ide: request.ide,
          action: request.action,
          error: IDE_UNSAFE_ACTION_ERROR,
        };
      }
      const integration = resolve(request.ide);
      if (!integration) {
        return {
          ok: false,
          ide: request.ide,
          action: request.action,
          error: `There is no IDE integration named ${request.ide}.`,
        };
      }
      try {
        const result = await transport.send(integration, request);
        return { ok: true, ide: integration.name, action: request.action, result };
      } catch (error) {
        return {
          ok: false,
          ide: integration.name,
          action: request.action,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    registry(): readonly IdeDefinition[] {
      return IDE_REGISTRY;
    },
    ide(key: string): IdeDefinition | undefined {
      return ideDefinition(key);
    },
    lockFiles,
    locks,
    ides,
    diagnostics(): IdeDiagnosticsManager {
      return manager;
    },

    async connect(ide: string): Promise<never> {
      const known = ideDefinition(ide);
      const name = known === undefined ? ideDisplayName(ide) : known.displayName;
      throw new IdeCapabilityError(
        IDE_CONNECTION_CAPABILITY,
        `Connecting to ${name}`,
      );
    },
    async requestDiagnostics(): Promise<never> {
      throw new IdeCapabilityError(IDE_DIAGNOSTICS_CAPABILITY, 'Requesting IDE diagnostics');
    },
    async installExtension(ide: string): Promise<never> {
      const known = ideDefinition(ide);
      const name = known === undefined ? ideDisplayName(ide) : known.displayName;
      throw new IdeCapabilityError(
        IDE_EXTENSION_INSTALL_CAPABILITY,
        `Installing the extension into ${name}`,
      );
    },
  };
}

export { normalizeIdeName };
export type { DiscoveredIde, IdeDefinition, IdeDiagnosticFile };

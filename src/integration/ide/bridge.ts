/**
 * The IDE bridge: the integrations the CLI can talk to, and the requests it
 * can apply to them.
 *
 * Evidence: the `CC-013` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`,
 * which names `IdeBridge` with `list()`, `resolve(name)` and `apply()`.
 *
 * ## What is observed, and what is not
 *
 * The audit's §2.8 observes exactly two IDE tools: `mcp__ide__executeCode` and
 * `mcp__ide__getDiagnostics`, both special-cased in the MCP layer. It does
 * **not** describe an IDE integration surface — no lock files, no ports, no
 * discovery mechanism. So the whole of this module's *behavior* is a **implementation
 * choice**, and it is marked as such throughout.
 *
 * This implementation's design:
 *
 *   - an IDE integration is discovered from a **lock file** in
 *     `<configDir>/ide/<name>.lock`, whose content is JSON carrying the IDE's
 *     name, its port, the transport and the workspace it has open;
 *   - `apply()` sends a request to the resolved integration through an
 *     injectable **transport**, so the bridge never depends on a socket it
 *     cannot test;
 *   - the two observed actions are `executeCode` and `getDiagnostics`.
 *
 * The default transport posts to `http://127.0.0.1:<port>/<action>`; this implementation
 * refuses to send anything to a host that is not a loopback address.
 *
 * ## The action is a path segment (a implementation choice)
 *
 * The action is interpolated into the request path, so this implementation **validates
 * it as a single path segment**: it may not be empty, may not be `.` or `..`,
 * and may not carry a `/`, a `\` or a NUL. An action that fails the check is
 * refused before anything is sent.
 *
 * Implementation choice: the target's own behavior here is unobserved — the audit
 * names the two actions but says nothing about the request path — so the
 * check, and the fact that this implementation accepts an action **outside** the two
 * observed ones as long as it is a single segment, are this implementation's.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { isSafeLookupName, type DiscoveredItem, type DiscoverySource } from '../../extensions/skills/source.js';

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
}

/** The options an IDE bridge is created with. */
export interface IdeBridgeOptions {
  /** The user's configuration directory (`~/.claude`). */
  configDir: string;
  /** The transport the requests go over. */
  transport?: IdeTransport;
}

interface IdeLock {
  ide?: unknown;
  port?: unknown;
  transport?: unknown;
  workspacePath?: unknown;
  pid?: unknown;
  alive?: unknown;
}

function readLock(lockPath: string): IdeLock {
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf8'));
    return typeof raw === 'object' && raw !== null ? (raw as IdeLock) : {};
  } catch {
    return {};
  }
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
        typeof lock.ide === 'string' && lock.ide.length > 0
          ? lock.ide
          : entry.slice(0, -'.lock'.length);

      const port = typeof lock.port === 'number' ? lock.port : undefined;
      const endpoint = port === undefined ? undefined : `http://127.0.0.1:${port}`;
      const transportKind =
        lock.transport === 'websocket' || lock.transport === 'socket'
          ? (lock.transport as IdeTransportKind)
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
  };
}

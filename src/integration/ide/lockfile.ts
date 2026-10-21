/**
 * The **IDE lock-file protocol**: where the lock files live, what they hold,
 * when they are stale, and how a lock file becomes an IDE the session can
 * talk to.
 *
 * Evidence: the target's own source, read out of the pinned build and recorded
 * in `/home/shiva/opt/reference-agent-rea/analysis/findings-ide-integration.md`
 * — every claim there carries a file and a byte offset. The milestone is
 * `CC-036` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * | what | where in the target |
 * |---|---|
 * | the lock directories | `chunk-a8rm68wf.js:794259` — `vWn()` |
 * | the Windows → WSL path mapping | `chunk-wz3ehw15.js:651` — `znn(t)` |
 * | the enumeration | `chunk-4jsg44k7.js:4009753`+ — `Hbr()` |
 * | the lock body | `chunk-4jsg44k7.js:4009265` — `DOn(e)` |
 * | the staleness sweep | `chunk-4jsg44k7.js:4009753`+ — `T7r()` |
 * | the liveness probe | `chunk-4jsg44k7.js:4009451`+ — `IOn(e)`, and `Bot(host, port, 500)` |
 * | the discovery | `chunk-4jsg44k7.js:4011960`+ — `Lbr(e)` |
 * | the workspace relation | `chunk-4jsg44k7.js:4012440`+ — `POn`, and `chunk-z2dde3wc.js:24927` — `Yse` |
 * | the host to connect to | `chunk-4jsg44k7.js:4019800`+ — `LOn`, `I7r` |
 * | the detection loop | `chunk-4jsg44k7.js:4012440`+ — `Dbr()` |
 *
 * ## The protocol, in the target's own order
 *
 *  1. **Where** — the lock directories: the configuration root's `ide`
 *     directory, `~/.claude/ide` when the configuration root is overridden or
 *     empty, and, under WSL, the Windows-side directories.
 *  2. **Which files** — every file whose name ends in `.lock`, newest first.
 *  3. **What is in one** — JSON with `{workspaceFolders, port, pid, ideName,
 *     transport, runningInWindows, authToken}`, or, when the body does not
 *     parse as JSON, a newline-delimited list of workspace folders.
 *  4. **The port** — the **file name**, not the JSON: the base name minus
 *     `.lock`, parsed as an integer. The JSON's `port` field is read and not
 *     used for the port.
 *  5. **Staleness** — a dead **pid** is enough outside WSL; under WSL the port
 *     must also refuse a connection. A lock file that cannot be parsed is
 *     deleted.
 *  6. **The workspace relation** — `contains-cwd`, `inside-cwd` or
 *     `unrelated`; only the first two make an IDE *valid*.
 *  7. **The URL** — `ws://<host>:<port>` when the lock said the transport was
 *     `ws`, and `http://<host>:<port>/sse` otherwise.
 *
 * ## The honest boundary
 *
 * The **reading** of the protocol is pure: it is file names, file bodies and
 * path relations, and it is implemented here.
 *
 * The **deleting** of a stale lock file, the **probing** of a port and the
 * **mapping** of a Windows path under WSL are side effects on the host, so
 * they are **injected**: the caller supplies the probe and the mapper, and
 * the pure rule is here. Nothing in this module opens a socket or removes a
 * file by itself.
 */

import path from 'node:path';

/* -------------------------------------------------------------------------- */
/* The environment                                                             */
/* -------------------------------------------------------------------------- */

/** The environment the lock-file protocol reads. */
export interface IdeLockEnvironment {
  /**
   * The configuration root — `~/.claude`, or `$CLAUDE_CONFIG_DIR` when that
   * is set.
   */
  readonly configRoot: string;
  /** The user's home directory. */
  readonly homeDir: string;
  /**
   * The platform, as the target's own platform helper reports it.
   *
   * The target's helper names WSL `"wsl"`, which Node's own `os.platform()`
   * does not.
   */
  readonly platform: NodeJS.Platform | 'wsl';
  /** The environment the target reads. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * The names of the Windows user directories under `/mnt/c/Users`.
   *
   * The target reads that directory itself; it is a parameter here so the rule
   * can be exercised without a WSL host. When it is absent, the WSL user
   * directories are not produced.
   */
  readonly windowsUserNames?: readonly string[];
}

/**
 * The Windows user names the target **skips** when it enumerates
 * `/mnt/c/Users`.
 *
 * These four are the shared, non-personal accounts.
 */
export const IDE_SKIPPED_WINDOWS_USERS: readonly string[] = Object.freeze([
  'Public',
  'Default',
  'Default User',
  'All Users',
]);

/**
 * The Windows path → WSL path mapping.
 *
 * The target's own rule: a path that starts with a drive letter and a colon
 * becomes `/mnt/<the drive, lower-cased><the rest, with backslashes turned
 * into forward slashes>`. A path that does not match is **not** mapped.
 */
export function windowsProfileToWslPath(profile: string): string | undefined {
  const match = /^([A-Z]):(.*)$/i.exec(profile);
  if (match === null) return undefined;
  const drive = match[1] as string;
  const rest = match[2] as string;
  return `/mnt/${drive.toLowerCase()}${rest.replaceAll('\\', '/')}`;
}

/**
 * The directories that hold IDE lock files.
 *
 * The target's own order:
 *
 *   1. `<configuration root>/ide`;
 *   2. `~/.claude/ide` — **only** when `CLAUDE_CONFIG_DIR` is set or the
 *      configuration root is blank;
 *   3. under WSL only: `<the Windows profile, mapped>/.claude/ide`, and then
 *      one `<user>/.claude/ide` for every Windows user directory, except the
 *      four shared accounts.
 */
export function ideLockDirectories(environment: IdeLockEnvironment): string[] {
  const directories: string[] = [path.join(environment.configRoot, 'ide')];

  if (environment.env['CLAUDE_CONFIG_DIR'] !== undefined || environment.configRoot.trim() === '') {
    directories.push(path.join(environment.homeDir, '.claude', 'ide').normalize('NFC'));
  }

  if (environment.platform === 'wsl') {
    const userProfile = environment.env['USERPROFILE'];
    const mapped = userProfile === undefined ? undefined : windowsProfileToWslPath(userProfile);
    if (mapped !== undefined) {
      directories.push(path.join(mapped, '.claude', 'ide'));
    }
    for (const name of environment.windowsUserNames ?? []) {
      if (IDE_SKIPPED_WINDOWS_USERS.includes(name)) continue;
      directories.push(path.join('/mnt/c/Users', name, '.claude', 'ide'));
    }
  }

  return directories;
}

/* -------------------------------------------------------------------------- */
/* The lock file                                                               */
/* -------------------------------------------------------------------------- */

/** A lock file the target read. */
export interface IdeLock {
  /** The workspace folders the IDE has open. */
  readonly workspaceFolders: readonly string[];
  /** The port — the **file name's** suffix, not the JSON's `port`. */
  readonly port: number;
  /** The IDE's process id, when the lock carried one. */
  readonly pid?: number;
  /** The IDE's own name, when the lock carried one. */
  readonly ideName?: string;
  /** Whether the lock said the transport is `ws`. */
  readonly useWebSocket: boolean;
  /** Whether the lock said the IDE runs on the Windows side. */
  readonly runningInWindows: boolean;
  /** The token the IDE's transport is authenticated with. */
  readonly authToken?: string;
}

/**
 * The port a lock file's **name** carries.
 *
 * The target's rule: the base name, minus `.lock`, parsed as an integer. A
 * name that carries no number gives `NaN` — the target does not check.
 */
export function ideLockPortFromFileName(fileName: string): number {
  const base = path.basename(fileName);
  return Number.parseInt(base.replace('.lock', ''), 10);
}

/**
 * Read a lock file's body.
 *
 * The target's own rule:
 *
 *   - a body that parses as JSON is read as an object: `workspaceFolders` is
 *     taken when it is present, `pid`, `ideName` and `authToken` are taken
 *     when they are present, `transport === "ws"` means the transport is a
 *     WebSocket, and `runningInWindows === true` means the IDE runs on the
 *     Windows side;
 *   - a body that does **not** parse as JSON is a **newline-delimited list of
 *     workspace folders**, each line trimmed;
 *   - the port comes from the **file name**.
 *
 * Implementation choices (the target does not check them):
 *
 *   - a `pid` that is not a number is dropped, and so are an `ideName` and an
 *     `authToken` that are not strings. The target keeps them and lets a
 *     later consumer trip over them.
 */
export function parseIdeLock(content: string, fileName: string): IdeLock {
  let workspaceFolders: readonly string[] = [];
  let pid: number | undefined;
  let ideName: string | undefined;
  let authToken: string | undefined;
  let useWebSocket = false;
  let runningInWindows = false;

  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const folders = record['workspaceFolders'];
      if (Array.isArray(folders)) {
        workspaceFolders = folders.filter((folder): folder is string => typeof folder === 'string');
      }
      const rawPid = record['pid'];
      if (typeof rawPid === 'number') pid = rawPid;
      const rawName = record['ideName'];
      if (typeof rawName === 'string') ideName = rawName;
      const rawToken = record['authToken'];
      if (typeof rawToken === 'string') authToken = rawToken;
      useWebSocket = record['transport'] === 'ws';
      runningInWindows = record['runningInWindows'] === true;
    }
  } catch {
    workspaceFolders = content.split('\n').map((line) => line.trim());
  }

  return {
    workspaceFolders,
    port: ideLockPortFromFileName(fileName),
    ...(pid === undefined ? {} : { pid }),
    ...(ideName === undefined ? {} : { ideName }),
    useWebSocket,
    runningInWindows,
    ...(authToken === undefined ? {} : { authToken }),
  };
}

/* -------------------------------------------------------------------------- */
/* The workspace relation                                                      */
/* -------------------------------------------------------------------------- */

/** How an IDE's workspace folder relates to the session's directory. */
export type IdeWorkspaceRelation = 'contains-cwd' | 'inside-cwd' | 'unrelated';

/**
 * The target's own separator rule.
 *
 * The target takes `/` when the path starts with `/` and `\` otherwise.
 */
function targetSeparator(value: string): string {
  return value.startsWith('/') ? '/' : '\\';
}

/**
 * The target's own containment test: is `candidate` inside `container`?
 *
 * The target's own helper is `Yse(e, n)`, and its argument order is the
 * **candidate first**: `e` is the candidate, `n` is the container. The
 * candidate is inside when it is the container, or when it starts with the
 * container plus a separator.
 *
 * The separator is the container's own: the target takes `/` when the
 * container starts with `/` and `\` otherwise.
 *
 * The test is **case-sensitive** unless the caller asks otherwise.
 */
export function isPathInside(
  candidate: string,
  container: string,
  caseSensitive = true,
): boolean {
  const left = caseSensitive ? candidate : candidate.toLowerCase();
  const right = caseSensitive ? container : container.toLowerCase();
  if (left === right) return true;
  const separator = targetSeparator(right);
  const prefix = right.endsWith(separator) ? right : `${right}${separator}`;
  return left.startsWith(prefix);
}

/**
 * How an IDE's workspace folder relates to the session's directory.
 *
 *   - `contains-cwd` — the session's directory is inside the folder;
 *   - `inside-cwd` — the folder is inside the session's directory;
 *   - `unrelated` — neither.
 */
export function workspaceRelation(
  cwd: string,
  folder: string,
  caseSensitive = true,
): IdeWorkspaceRelation {
  if (isPathInside(cwd, folder, caseSensitive)) return 'contains-cwd';
  if (isPathInside(folder, cwd, caseSensitive)) return 'inside-cwd';
  return 'unrelated';
}

/* -------------------------------------------------------------------------- */
/* The enumeration                                                             */
/* -------------------------------------------------------------------------- */

/** A lock file the target found, with the moment it was last written. */
export interface IdeLockFile {
  /** The lock file's path. */
  readonly path: string;
  /** When it was last written, in milliseconds since the epoch. */
  readonly mtime: number;
}

/**
 * The lock files in those directories, **newest first**.
 *
 * The target's rule: every file whose name ends in `.lock`, ordered by the
 * moment it was last written, the newest first.
 */
export function sortIdeLockFiles(files: readonly IdeLockFile[]): IdeLockFile[] {
  return [...files].sort((left, right) => right.mtime - left.mtime);
}

/* -------------------------------------------------------------------------- */
/* The staleness                                                               */
/* -------------------------------------------------------------------------- */

/** The probes the staleness rule needs. */
export interface IdeStalenessProbes {
  /** Whether that process is alive — the target's `process.kill(pid, 0)`. */
  readonly isProcessAlive: (pid: number) => boolean;
  /** Whether something answers on that host and port. */
  readonly canConnect: (host: string, port: number) => Promise<boolean> | boolean;
  /** Whether the session runs under WSL. */
  readonly isWsl: boolean;
}

/**
 * Whether that lock file is stale, and may be deleted.
 *
 * The target's own rule:
 *
 *   - a lock with a **pid** is stale when that pid is dead. Outside WSL that
 *     is the whole rule; under WSL the port must also refuse a connection.
 *   - a lock with **no pid** is stale when the port refuses a connection.
 *
 * The target's port probe gives up after **500 ms**.
 */
export async function isIdeLockStale(
  lock: IdeLock,
  host: string,
  probes: IdeStalenessProbes,
): Promise<boolean> {
  if (lock.pid !== undefined) {
    if (probes.isProcessAlive(lock.pid)) return false;
    if (!probes.isWsl) return true;
    return !(await probes.canConnect(host, lock.port));
  }
  return !(await probes.canConnect(host, lock.port));
}

/** The target's port probe timeout, in milliseconds. */
export const IDE_LOCK_PROBE_TIMEOUT_MS = 500;

/* -------------------------------------------------------------------------- */
/* The discovery                                                               */
/* -------------------------------------------------------------------------- */

/** One IDE the session can talk to. */
export interface DiscoveredIde {
  /** The URL the IDE is reached on. */
  readonly url: string;
  /** The name the IDE is shown under. */
  readonly name: string;
  /** The workspace folders the IDE has open. */
  readonly workspaceFolders: readonly string[];
  /** The port the IDE listens on. */
  readonly port: number;
  /** Whether the IDE's workspace is related to the session's directory. */
  readonly isValid: boolean;
  /** Whether the IDE's workspace holds the session's directory. */
  readonly workspaceContainsCwd: boolean;
  /** The token the IDE's transport is authenticated with. */
  readonly authToken?: string;
  /** Whether the IDE runs on the Windows side. */
  readonly ideRunningInWindows: boolean;
}

/** What the discovery needs beyond the lock files themselves. */
export interface IdeDiscoveryOptions {
  /** The session's working directory. */
  readonly cwd: string;
  /** The lock files to read. */
  readonly locks: readonly IdeLock[];
  /** The host to reach the IDE on. */
  readonly host?: string;
  /**
   * The name the IDE is shown under when the lock file does not name one.
   *
   * The target uses the terminal's display name when the session runs inside
   * an IDE's terminal, and `"IDE"` otherwise.
   */
  readonly fallbackName?: string;
  /** Whether the session runs inside an IDE's own terminal. */
  readonly insideIdeTerminal?: boolean;
  /** Whether the workspace check is skipped. */
  readonly skipValidCheck?: boolean;
  /** The port the session's own SSE server listens on. */
  readonly ssePort?: number;
  /** The pids the session's process descends from. */
  readonly ancestorPids?: ReadonlySet<number>;
  /** Whether the session's own process is the IDE's process. */
  readonly parentPid?: number;
  /** Whether that process is alive. */
  readonly isProcessAlive?: (pid: number) => boolean;
  /**
   * Whether the IDEs whose workspace is unrelated to the session's directory
   * are kept.
   *
   * The target's `Lbr(includeUnrelated)` keeps them when this is on; the
   * `/ide` command asks for them, so it can say *why* an IDE was left out.
   */
  readonly includeUnrelated?: boolean;
}

/**
 * The URL an IDE is reached on.
 *
 * The target's own rule: a WebSocket transport is `ws://<host>:<port>`, and
 * anything else is `http://<host>:<port>/sse`.
 */
export function ideUrl(lock: IdeLock, host: string): string {
  if (lock.useWebSocket) return `ws://${host}:${lock.port}`;
  return `http://${host}:${lock.port}/sse`;
}

/**
 * The IDEs the lock files name.
 *
 * The target's own rule, in its own order:
 *
 *  1. the workspace relation is computed against every workspace folder, and
 *     the first folder that **contains** the session's directory wins;
 *  2. a folder that is **inside** the session's directory makes the IDE
 *     valid too, but only when the folder is an **absolute** path;
 *  3. `CLAUDE_CODE_IDE_SKIP_VALID_CHECK` makes every lock valid;
 *  4. a lock whose port is the session's own SSE port is valid;
 *  5. an IDE that is not valid is dropped, unless the caller asked for the
 *     unrelated ones;
 *  6. when the session runs inside an IDE's own terminal, the IDE's process
 *     must be alive **and** must be the session's parent, or one of the
 *     session's ancestors — unless the lock's port is the session's own SSE
 *     port;
 *  7. the name is the lock's `ideName`, or the terminal's display name, or
 *     `"IDE"`.
 */
export function discoverIdes(options: IdeDiscoveryOptions): DiscoveredIde[] {
  const found: DiscoveredIde[] = [];
  const host = options.host ?? '127.0.0.1';
  const ancestors = options.ancestorPids ?? new Set<number>();
  const isAlive = options.isProcessAlive ?? ((): boolean => true);

  for (const lock of options.locks) {
    let relation: IdeWorkspaceRelation = 'unrelated';

    if (options.skipValidCheck === true) {
      relation = 'contains-cwd';
    } else if (options.ssePort !== undefined && lock.port === options.ssePort) {
      relation = 'contains-cwd';
    } else {
      for (const folder of lock.workspaceFolders) {
        if (!folder) continue;
        const resolved = path.resolve(folder);
        const candidate = workspaceRelation(options.cwd, resolved);
        if (candidate === 'contains-cwd') {
          relation = candidate;
          break;
        }
        if (candidate === 'inside-cwd' && path.isAbsolute(folder)) {
          relation = candidate;
        }
      }
    }

    const isValid = relation !== 'unrelated';
    if (!isValid && options.includeUnrelated !== true) continue;

    if (options.insideIdeTerminal === true) {
      const isOwnSsePort = options.ssePort !== undefined && lock.port === options.ssePort;
      if (!isOwnSsePort) {
        if (lock.pid === undefined || !isAlive(lock.pid)) continue;
        if (options.parentPid !== lock.pid && !ancestors.has(lock.pid)) continue;
      }
    }

    const name = lock.ideName ?? options.fallbackName ?? 'IDE';
    found.push({
      url: ideUrl(lock, host),
      name,
      workspaceFolders: lock.workspaceFolders,
      port: lock.port,
      isValid,
      workspaceContainsCwd: relation === 'contains-cwd',
      ...(lock.authToken === undefined ? {} : { authToken: lock.authToken }),
      ideRunningInWindows: lock.runningInWindows,
    });
  }

  return found;
}

/* -------------------------------------------------------------------------- */
/* The detection loop                                                          */
/* -------------------------------------------------------------------------- */

/** How long the target waits for an IDE to appear, in milliseconds. */
export const IDE_DETECTION_WINDOW_MS = 30_000;

/** How long the target waits between two polls, in milliseconds. */
export const IDE_DETECTION_POLL_INTERVAL_MS = 1_000;

/**
 * The one IDE the target connects to.
 *
 * The target's rule: the IDEs whose workspace **contains** the session's
 * directory, and there must be **exactly one** of them. Zero or more than one
 * and the target keeps waiting.
 */
export function theSingleContainingIde(ides: readonly DiscoveredIde[]): DiscoveredIde | undefined {
  const containing = ides.filter((ide) => ide.workspaceContainsCwd);
  if (containing.length !== 1) return undefined;
  return containing[0];
}

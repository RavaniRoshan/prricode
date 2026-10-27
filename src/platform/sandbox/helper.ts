/**
 * The native sandbox helper's seam.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  OBSERVED_SYSCALLS,
  buildSeccompFilter,
  createSeccompSupervisor,
  type NotifierChannel,
  type SeccompNotification,
  type SeccompResponse,
  type SeccompSupervisor,
  type SyscallObservation,
} from './seccomp.js';
import {
  type BackendEnforcement,
  type SandboxBackend,
  type SandboxLayers,
  type SandboxPlan,
  type SandboxProcess,
  type SandboxRunResult,
  type SandboxSpec,
  sandboxEnvironment,
} from './launcher.js';

const helperRoot = path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
export const HELPER_BINARY = path.join(helperRoot, 'native', 'build', 'sandbox-helper');

export const HELPER_BINARY_OVERRIDE = 'PRRICODE_SANDBOX_HELPER';

export const HELPER_BACKEND_NAME = 'sandbox-helper';

export const SANDBOX_HELPER_VERSION = 'sandbox-helper 1.0.0';

export const OBSERVE_SOCKET_PREFIX = 'prricode-observe-';

export const OBSERVE_SOCKET_ENVIRONMENT = 'SRT_OBSERVE_SOCK';

export const ENCODED_COMMAND_ENVIRONMENT = 'SRT_ENCODED_CMD';

const ESCAPES: ReadonlyArray<readonly [string, string]> = [
  ['\\', '\\134'],
  [' ', '\\040'],
  ['\t', '\\011'],
  ['\n', '\\012'],
];

export function escapeField(field: string): string {
  let escaped = '';
  for (const character of field) {
    const match = ESCAPES.find(([raw]) => raw === character);
    escaped += match === undefined ? character : match[1];
  }
  return escaped;
}

const PLAN_LINE_MAX = 32 * 1024;

export interface PlanTextOptions {
  command: string;
  token?: string;
  encodedCommand?: string;
  env?: Record<string, string> | NodeJS.ProcessEnv;
}

export function planTextOf(
  plan: SandboxPlan,
  commandOrSpec: string | PlanTextOptions,
  token?: string,
  encoded?: string,
): string {
  const spec: PlanTextOptions =
    typeof commandOrSpec === 'string'
      ? { command: commandOrSpec, token, encodedCommand: encoded }
      : commandOrSpec;

  const command = spec.command;
  const readinessToken = spec.token ?? randomBytes(16).toString('hex');
  const encodedCommand = spec.encodedCommand ?? Buffer.from(command, 'utf8').toString('base64');
  const env = spec.env ?? {};

  const rows: string[] = [];
  let emptyFileIndex = 0;
  for (const mount of plan.mounts) {
    if (mount.kind === 'empty-file') {
      // The helper's own numbering: 3 is the plan, 4 the filter, and one data
      // descriptor per `empty-file` row **from 5**, in row order — the same
      // order the `stdio` array hands them over in.
      const fd = 5 + emptyFileIndex;
      emptyFileIndex += 1;
      rows.push(`M empty-file ${escapeField(mount.target)} ${fd}`);
      continue;
    }
    if (mount.kind === 'tmpfs' || mount.kind === 'proc' || mount.kind === 'dev' || mount.kind === 'dir') {
      rows.push(`M ${mount.kind} ${escapeField(mount.target)}`);
      continue;
    }
    const source = mount.source === undefined ? '' : escapeField(mount.source);
    rows.push(`M ${mount.kind} ${escapeField(mount.target)} ${source}`);
  }

  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    rows.push(`E ${escapeField(`${name}=${value}`)}`);
  }
  rows.push(`E ${escapeField(`${ENCODED_COMMAND_ENVIRONMENT}=${encodedCommand}`)}`);
  rows.push(`C ${escapeField(plan.workingDirectory)}`);
  rows.push(`T ${escapeField(readinessToken)}`);
  rows.push(`X ${escapeField(command)}`);

  const text = `${rows.join('\n')}\n`;
  for (const row of rows) {
    if (row.length + 1 > PLAN_LINE_MAX) {
      throw new Error(`the plan's row does not fit the helper's line: ${row.slice(0, 60)}…`);
    }
  }
  return text;
}

export interface DispatchEntry {
  readonly nr: number;
  readonly name: string;
  readonly path: number;
  readonly secondPath: number;
  readonly flags: number;
  readonly dirfd: number;
  readonly secondDirfd: number;
}

export function dispatchTable(entries: readonly unknown[] = OBSERVED_SYSCALLS): {
  readonly records: readonly DispatchEntry[];
} {
  const records: DispatchEntry[] = [];
  for (const raw of entries) {
    const record = raw as { nr?: unknown; name?: unknown; meta?: unknown };
    if (typeof record.nr !== 'number' || typeof record.name !== 'string') continue;
    const meta = (record.meta ?? {}) as Record<string, unknown>;
    const at = (key: string): number => {
      const value = meta[key];
      return typeof value === 'number' ? value : 0xff;
    };
    records.push({
      nr: record.nr,
      name: record.name,
      path: at('path'),
      secondPath: at('secondPath'),
      flags: at('flags'),
      dirfd: at('dirfd'),
      secondDirfd: at('secondDirfd'),
    });
  }
  return { records };
}

export interface HelperProbeVerdict {
  userns: 'ok' | 'refused';
  usernsErrno: number;
  attach: 'ok' | 'refused';
  attachErrno: number;
}

export function parseHelperVerdict(text: string): HelperProbeVerdict | undefined {
  const line = text.split('\n').find((candidate) => candidate.includes('"userns"'));
  if (line === undefined) return undefined;
  try {
    return JSON.parse(line) as HelperProbeVerdict;
  } catch {
    return undefined;
  }
}

export function helperBinaryPath(override?: string): string {
  const named = override ?? process.env[HELPER_BINARY_OVERRIDE];
  return named !== undefined && named !== '' ? named : HELPER_BINARY;
}

export async function probeHelper(
  binary: string,
): Promise<{ available: boolean; reason?: string; warning?: string; verdict?: HelperProbeVerdict }> {
  if (!existsSync(binary)) {
    return {
      available: false,
      reason: `the compiled sandbox helper is not there: ${binary} — run native/build.sh (a C compiler is needed)`,
    };
  }
  const child = spawn(binary, ['--probe'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = await new Promise<string>((done) => {
    let text = '';
    child.stdout?.on('data', (chunk) => {
      text += String(chunk);
    });
    child.on('close', () => done(text));
    child.on('error', () => done(text));
  });
  const verdict = parseHelperVerdict(stdout);
  if (verdict === undefined) {
    return { available: false, reason: "the helper's probe printed no verdict" };
  }
  if (verdict.userns !== 'ok') {
    return {
      available: false,
      reason: `the kernel refuses the user namespace the helper establishes (errno ${verdict.usernsErrno})`,
      verdict,
    };
  }
  if (verdict.attach !== 'ok') {
    return {
      available: false,
      reason: `the kernel refuses a listener-carrying filter install (errno ${verdict.attachErrno})`,
      verdict,
    };
  }
  return { available: true, verdict };
}

/* -------------------------------------------------------------------------- */
/* the supervisor attachment (synchronous, main-thread)                        */
/* -------------------------------------------------------------------------- */

/**
 * Attach the supervisor to one helper instance.
 *
 * The launcher listens on the observe socket **before** it spawns the helper —
 * the C program connects before it forks its mounter, so the attachment is
 * passive: the server is bound here, and the socket the helper hands over is
 * only used once it exists. The line protocol is strictly turn-based: the
 * helper sends one frame and either answers ours or waits for ours, so a
 * synchronous reply read is bounded by the helper's own speed, and
 * `receive()` — which has no guaranteed answer — never reads at all: the
 * driver retries it from the event loop.
 */
export async function attachSupervisor(name: string): Promise<{
  channel: NotifierChannel;
  /** Stop the attachment: destroy the socket and release the server. */
  stop: () => void;
  /** Whether the attachment is over: the helper hung up or was stopped. */
  readonly isClosed: () => boolean;
}> {
  const server = createServer();
  let socket: Socket | undefined;
  let closed = false;
  let stopped = false;

  /** Raw bytes that have not been split into lines yet. */
  let text = '';
  /** Complete lines, oldest first. */
  const lines: string[] = [];
  const pushText = (chunk: string): void => {
    text += chunk;
    let at = text.indexOf('\n');
    while (at >= 0) {
      lines.push(text.slice(0, at));
      text = text.slice(at + 1);
      at = text.indexOf('\n');
    }
  };

  server.on('connection', (sock) => {
    if (socket !== undefined) {
      sock.destroy();
      return;
    }
    socket = sock;
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => pushText(String(chunk)));
    sock.on('close', () => {
      closed = true;
    });
    sock.on('error', () => {
      closed = true;
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(`\u0000${name}`, () => resolve());
    server.once('error', reject);
  });

  /** The descriptor readSync/writeSync use; `-1` before the helper connects. */
  const fdOf = (): number => {
    const handle = (socket as unknown as { _handle?: { fd?: number } } | undefined)?._handle;
    return handle?.fd ?? -1;
  };

  /**
   * Pull one more chunk into the line queue by a synchronous read.
   *
   * Only correct while the helper owes a line: it is blocked writing it, so the
   * spin on `EAGAIN` is bounded by the helper's own speed and by the deadline.
   */
  const readMore = (deadline: number): boolean => {
    const fd = fdOf();
    if (fd < 0 || closed || stopped) return false;
    const buffer = Buffer.alloc(8192);
    for (;;) {
      if (stopped || closed || Date.now() >= deadline) return false;
      let n: number;
      try {
        n = readSync(fd, buffer, 0, buffer.length, null);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'EAGAIN' || code === 'EWOULDBLOCK' || code === 'EINTR') continue;
        closed = true;
        return false;
      }
      if (n > 0) {
        pushText(buffer.subarray(0, n).toString('utf8'));
        return true;
      }
      closed = true;
      return false;
    }
  };

  /** The reply line to a request the helper currently owes. */
  const awaitReply = (prefix: string, timeoutMs = 2_000): string | null => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (lines.length > 0) {
        const line = lines.shift()!;
        if (line.startsWith(prefix)) return line;
        // A stray line between a request and its reply would be a protocol
        // breach; it is dropped rather than allowed to wedge the turn.
      }
      if (closed || stopped || Date.now() >= deadline) return null;
      readMore(deadline);
    }
  };

  const writeLine = (line: string): void => {
    const fd = fdOf();
    if (fd < 0 || closed || stopped) return;
    const data = Buffer.from(`${line}\n`, 'utf8');
    let written = 0;
    while (written < data.length) {
      if (stopped) return;
      let n: number;
      try {
        n = writeSync(fd, data, written, data.length - written, null);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'EAGAIN' || code === 'EINTR') continue;
        closed = true;
        return;
      }
      written += n;
    }
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    closed = true;
    lines.length = 0;
    text = '';
    try {
      socket?.destroy();
    } catch {
      // The socket is already gone.
    }
    try {
      server.close();
    } catch {
      // The server is already closed.
    }
  };

  const channel: NotifierChannel = {
    receive(): SeccompNotification | null {
      for (;;) {
        if (stopped) return null;
        if (lines.length === 0) return null;
        const line = lines.shift()!;
        if (line.startsWith('x ')) {
          closed = true;
          return null;
        }
        if (!line.startsWith('n ')) continue;
        const parts = line.split(' ');
        const id = BigInt(parts[1] ?? '0');
        const pid = Number(parts[2] ?? '0');
        const nr = Number(parts[3] ?? '0');
        const args = parts.slice(4).map((value) => BigInt(value));
        while (args.length < 6) args.push(0n);
        return { id, pid, nr, args };
      }
    },
    respond(response: SeccompResponse): void {
      writeLine(`R ${response.id} ${response.error} ${response.flags} ${response.val}`);
      // The helper's `R ok` acknowledgement arrives as a later line, which
      // receive() drops; waiting for it here would have no bounded source.
    },
    isIdValid(id: bigint): boolean {
      if (closed) return false;
      writeLine(`V ${id}`);
      const answer = awaitReply('V ');
      return answer !== null && answer.trimEnd() === 'V 1';
    },
    readMemory(pid: number, address: bigint, length: number): Buffer | null {
      if (closed) return null;
      const capped = Math.min(Math.max(length, 1), 65536);
      writeLine(`M ${pid} ${address.toString(16)} ${capped.toString(16)}`);
      const answer = awaitReply('D ');
      if (answer === null) return null;
      const hex = answer.slice(2).trim();
      if (hex === '-' || hex.length === 0) return null;
      const bytes = Buffer.from(hex, 'hex');
      return bytes.length === 0 ? null : bytes;
    },
    resolveTargetPath(pid: number, dirFd: number): string | undefined {
      if (closed) return undefined;
      writeLine(`P ${pid} ${dirFd}`);
      const answer = awaitReply('T ');
      if (answer === null) return undefined;
      const value = answer.slice(2).trim();
      if (value === '-' || value === '') return undefined;
      return value;
    },
  };

  return { channel, stop, isClosed: () => closed || stopped };
}

/* -------------------------------------------------------------------------- */
/* the backend                                                                 */
/* -------------------------------------------------------------------------- */

const nativeLayers = (): SandboxLayers => ({
  filesystem: true,
  seccomp: true,
  pathPolicy: false,
  network: true,
  supervisor: true,
});

export function nativeHelperBackend(options: { binary?: string } = {}): SandboxBackend {
  const binaryOf = (): string => options.binary ?? helperBinaryPath();

  let enforcement: Promise<BackendEnforcement> | undefined;

  const describe = (): Promise<BackendEnforcement> => {
    enforcement ??= probeHelper(binaryOf()).then((probed) => ({
      binary: binaryOf(),
      version: SANDBOX_HELPER_VERSION,
      setuid: false,
      warnings: [],
      problems: probed.available ? [] : [probed.reason ?? 'the helper is not available'],
    }));
    return enforcement;
  };

  return {
    name: HELPER_BACKEND_NAME,
    describe,
    async isAvailable() {
      if (process.platform !== 'linux') {
        return { available: false, reason: 'the native helper runs on Linux only' };
      }
      const probed = await probeHelper(binaryOf());
      const info = await describe();
      return {
        ...probed,
        ...(info.warnings.length === 0 ? {} : { warning: info.warnings.join('; ') }),
      };
    },
    async start(plan: SandboxPlan, spec: SandboxSpec): Promise<SandboxProcess> {
      const dataPaths: string[] = [];
      const dataFds: number[] = [];
      for (const mount of plan.mounts) {
        if (mount.kind !== 'empty-file') continue;
        const dataPath = path.join(
          tmpdir(),
          `agent-sandbox-mask-${process.pid}-${dataPaths.length}-${Date.now().toString(36)}`,
        );
        writeFileSync(dataPath, '');
        dataPaths.push(dataPath);
        dataFds.push(openSync(dataPath, fsConstants.O_RDONLY));
      }

      const filter = buildSeccompFilter({ denied: plan.deniedSyscalls });
      const filterPath = path.join(
        tmpdir(),
        `agent-sandbox-seccomp-${process.pid}-${Date.now().toString(36)}.bin`,
      );
      writeFileSync(filterPath, filter);
      const filterFd = openSync(filterPath, 'r');

      const token = randomBytes(16).toString('hex');
      const env = sandboxEnvironment(spec, 'sandboxed');
      const encoded = Buffer.from(spec.command, 'utf8').toString('base64');
      const planText = planTextOf(plan, {
        command: spec.command,
        token,
        encodedCommand: encoded,
        env,
      });

      const planPath = path.join(tmpdir(), `agent-sandbox-plan-${process.pid}-${Date.now().toString(36)}.txt`);
      writeFileSync(planPath, planText);
      const planFd = openSync(planPath, 'r');

      const name = `${OBSERVE_SOCKET_PREFIX}${randomUUID()}`;

      const attached = await attachSupervisor(name);
      const supervisor: SeccompSupervisor = createSeccompSupervisor({
        channel: attached.channel,
      });

      let stopped = false;
      const stopAll = (): void => {
        if (stopped) return;
        stopped = true;
        attached.stop();
        for (const dataPath of dataPaths) rmSync(dataPath, { force: true });
        rmSync(filterPath, { force: true });
        rmSync(planPath, { force: true });
      };

      const driver = (async (): Promise<void> => {
        for (;;) {
          if (stopped) break;
          const notification = attached.channel.receive();
          if (notification === null) {
            if (stopped || attached.isClosed()) break;
            await delay(5);
            continue;
          }
          try {
            supervisor.handle(notification);
          } catch {
            // An observation that cannot be resolved is dropped, never fatal.
          }
        }
      })();

      const stdio: Array<'ignore' | 'pipe' | number> = ['ignore', 'pipe', 'pipe', planFd, filterFd];
      for (const fd of dataFds) stdio.push(fd);

      const child: ChildProcess = spawn(binaryOf(), [], {
        cwd: path.resolve(spec.cwd),
        env: {
          PATH: '/usr/bin:/bin',
          LANG: 'C',
          [OBSERVE_SOCKET_ENVIRONMENT]: `@${name}`,
        },
        stdio,
      });

      child.on('close', () => {
        try { closeSync(planFd); } catch { /* already closed */ }
        try { closeSync(filterFd); } catch { /* already closed */ }
        for (const fd of dataFds) { try { closeSync(fd); } catch { /* already closed */ } }
        stopAll();
      });

      const collected = collectChild(child, token, nativeLayers());

      const originalWait = collected.wait.bind(collected);
      const originalKill = collected.kill.bind(collected);

      return {
        ...collected,
        get observations(): readonly SyscallObservation[] {
          return supervisor.observations;
        },
        wait: async (): Promise<SandboxRunResult> => {
          const result = await originalWait();
          stopAll();
          await driver.catch(() => undefined);
          return result;
        },
        kill: (): void => {
          originalKill();
          stopAll();
        },
      } as SandboxProcess & { observations: readonly SyscallObservation[] };
    },
  };
}

function collectChild(
  child: ChildProcess,
  token: string,
  layers: SandboxLayers,
): SandboxProcess {
  let stdout = '';
  let stderr = '';
  let tokenSeen = false;
  const layersCopy = { ...layers };

  let resolveEstablishment: ((establishment: { established: boolean; layers: SandboxLayers; reason?: string }) => void) | undefined;
  const establishment = new Promise<{ established: boolean; layers: SandboxLayers; reason?: string }>((resolve) => {
    resolveEstablishment = resolve;
  });

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  let truncated = false;
  child.stdout?.on('data', (chunk: string) => {
    if (stdout.length >= 200_000) {
      truncated = true;
      return;
    }
    stdout += chunk;
    if (stdout.length > 200_000) {
      stdout = stdout.slice(0, 200_000);
      truncated = true;
    }
    if (tokenSeen) return;
    if (stdout.length < token.length) return;
    if (!stdout.startsWith(token)) return;
    tokenSeen = true;
    resolveEstablishment?.({ established: true, layers: layersCopy });
  });
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length >= 200_000) {
      truncated = true;
      return;
    }
    stderr += chunk;
    if (stderr.length > 200_000) {
      stderr = stderr.slice(0, 200_000);
      truncated = true;
    }
  });

  const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (!tokenSeen) {
        tokenSeen = true;
        resolveEstablishment?.({
          established: false,
          layers: { filesystem: false, seccomp: false, pathPolicy: false, network: false, supervisor: false },
          reason: describeFailure(stderr),
        });
      }
      resolve({ exitCode: code, signal });
    });
    child.on('error', () => {
      if (!tokenSeen) {
        tokenSeen = true;
        resolveEstablishment?.({
          established: false,
          layers: { filesystem: false, seccomp: false, pathPolicy: false, network: false, supervisor: false },
          reason: 'the sandbox process could not be started',
        });
      }
      resolve({ exitCode: null, signal: null });
    });
  });

  const withoutToken = (text: string): string => (text.startsWith(token) ? text.slice(token.length) : text);

  return {
    pid: child.pid ?? -1,
    establishment,
    get output() {
      return { stdout: withoutToken(stdout), stderr };
    },
    wait: async (): Promise<SandboxRunResult> => {
      const { exitCode, signal } = await exited;
      return {
        exitCode,
        signal,
        stdout: withoutToken(stdout),
        stderr,
        truncated,
      };
    },
    kill: () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The child is already gone.
      }
    },
  };
}

function describeFailure(stderr: string): string {
  const firstLine = stderr.split('\n').find((line) => line.trim().length > 0);
  if (firstLine === undefined) return 'the sandbox never came up and the backend said nothing about it';
  return `the sandbox never came up: ${firstLine.trim()}`;
}

export async function defaultSandboxBackend(): Promise<SandboxBackend> {
  const binary = helperBinaryPath();
  const probed = await probeHelper(binary);
  if (probed.available) return nativeHelperBackend({ binary });
  const { bubblewrapBackend } = await import('./launcher.js');
  return bubblewrapBackend();
}

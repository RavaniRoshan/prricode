/**
 * The sandbox launcher: the plan, the backends, and the status.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.9 ("Native and platform
 * sandbox"), the research report §7, and the `CC-017` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The five layers, and which of them this build establishes.**
 *
 *   1. **Filesystem boundary.** A mount namespace plus a user namespace, with
 *      `PR_SET_NO_NEW_PRIVS`, every bind explicitly read-only or read-write, and
 *      the protected paths masked with a **tmpfs**. The mask is the point: a
 *      read-only bind on a path that does not exist is a no-op, so the writable
 *      parent lets the sandbox create the file — which is exactly how the target's
 *      CVE-2026-25725 injected persistent hooks.
 *   2. **Syscall surface.** A seccomp-BPF denylist the kernel enforces:
 *      `ptrace`, `process_vm_readv`, `process_vm_writev`, `io_uring_setup`,
 *      `io_uring_register`, `io_uring_enter`, `bpf`, `mount`, `pivot_root` and
 *      `setns`. Blocking `io_uring_setup` is the only reliable defense against the
 *      io-wq class, whose worker threads bypass `seccomp_run_filters()` entirely.
 *   3. **Path policy.** Landlock where the ABI is high enough, bound to `O_PATH`
 *      descriptors. This build ships no native Landlock helper, so the layer
 *      reports the reduced protection and the path policy is enforced by the mount
 *      namespace instead — which is kernel-enforced too.
 *   4. **Network.** The network namespace has no interface at all, so the sandboxed
 *      process cannot open a socket to anything; the only way out is the Unix
 *      socket the launcher bind-mounts into the sandbox, and that socket is served
 *      by the host-side proxy, which enforces the domain allowlist, refuses the
 *      loopback, link-local and cloud-metadata ranges, and pins the address.
 *   5. **Supervisor.** The seccomp-notification supervisor observes and emulates;
 *      it never enforces. See `src/platform/sandbox/seccomp.ts`.
 *
 * **The launcher never needs root.** The design is unprivileged: user namespaces
 * plus `PR_SET_NO_NEW_PRIVS`, never a setuid helper. When the host cannot create a
 * user namespace the launcher says so, and the policy's `failIfUnavailable`
 * decides between refusing and running unconfined.
 *
 * **The backend.** The mount namespace, the namespaces and the seccomp filter are
 * established by **bubblewrap**, which is what the target itself uses on
 * Linux/WSL2. This implementation builds the plan itself — every bind, every mask, the
 * filter — and hands it to the backend; the backend is the part that needs the
 * kernel.
 *
 * **The residual risk.** All five layers share one kernel. A kernel privilege
 * escalation reachable from the sandbox defeats every layer, and unprivileged user
 * namespaces widen the reachable surface. Only a microVM moves the boundary below
 * the kernel.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DEFAULT_SANDBOX_POLICY,
  evaluateSandbox,
  type SandboxAvailability,
  type SandboxEvaluation,
  type SandboxPolicy,
} from './policy.js';
import {
  DENIED_SYSCALLS,
  buildSeccompFilter,
  createSeccompSupervisor,
  type DispatchRecord,
  type NotifierChannel,
  type SeccompSupervisor,
} from './seccomp.js';
import {
  defaultLandlockSyscalls,
  detectLandlock,
  type LandlockStatus,
  type LandlockSyscalls,
} from './landlock.js';
import type { SandboxProxy } from './proxy.js';

/** The path the proxy socket is bind-mounted at inside the sandbox. */
export const SANDBOX_PROXY_SOCKET_PATH = '/tmp/agent-sandbox-proxy.sock';

/** The environment variable that tells the sandboxed process where the proxy is. */
export const SANDBOX_PROXY_SOCKET_VARIABLE = 'SANDBOX_PROXY_SOCKET';

/** The system directories the sandboxed process may read. */
const SYSTEM_DIRECTORIES: readonly string[] = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/etc',
];

/** The bubblewrap binary the backend drives. */
const BUBBLEWRAP_BINARY = '/usr/bin/bwrap';

/**
 * The environment the sandboxed process gets when the caller supplies none.
 *
 * The sandbox does **not** inherit the host's environment. A sandboxed command
 * that could read the agent's environment would find the API key in it, which is
 * exactly the leak the research records for the target's own sandbox. The home
 * directory points at the sandbox's own scratch tmpfs.
 */
const DEFAULT_SANDBOX_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp',
  LANG: 'C',
  TERM: 'dumb',
});

/** What to launch. */
export interface SandboxSpec {
  /** The shell command to run inside the sandbox. */
  command: string;
  /** The working directory of the sandboxed process. */
  cwd: string;
  /** The environment of the sandboxed process. */
  env?: NodeJS.ProcessEnv;
  /** The sandbox policy. */
  policy?: SandboxPolicy;
  /** The platform name; the host's own platform when it is not supplied. */
  platform?: string;
  /** The paths masked with a tmpfs inside the sandbox. */
  protectedPaths?: readonly string[];
  /** The syscalls the seccomp filter blocks; the denylist when it is not supplied. */
  deniedSyscalls?: readonly string[];
  /** Extra paths bound read-only inside the sandbox. */
  readOnlyPaths?: readonly string[];
  /** Extra paths bound read-write inside the sandbox. */
  readWritePaths?: readonly string[];
  /** The proxy the sandboxed process reaches the network through. */
  proxy?: SandboxProxy;
  /** The Landlock syscall seam. */
  landlock?: LandlockSyscalls;
  /** The backend's availability, when the caller already knows it. */
  availability?: SandboxAvailability;
  /** The backend that establishes the sandbox. */
  backend?: SandboxBackend;
  /** The seccomp-notification supervisor, when one is attached. */
  supervisor?: SeccompSupervisor;
  /** The timeout of the command, in milliseconds. */
  timeoutMs?: number;
}

/** One entry of the mount plan. */
export interface SandboxMount {
  /** What kind of mount this is. */
  kind: 'ro-bind' | 'bind' | 'tmpfs' | 'proc' | 'dev' | 'dir';
  /** The host path the mount comes from. */
  source?: string;
  /** The path inside the sandbox. */
  target: string;
  /** Why the entry is in the plan. */
  reason: string;
}

/** The plan the backend establishes. */
export interface SandboxPlan {
  /** The mounts, in the order the backend applies them. */
  mounts: readonly SandboxMount[];
  /** The syscalls the seccomp filter blocks. */
  deniedSyscalls: readonly string[];
  /** The paths the plan masks. */
  protectedPaths: readonly string[];
  /** The mask each protected path got. */
  masks: readonly { path: string; target: string }[];
  /** The proxy socket bind-mounted into the sandbox. */
  proxySocket?: string;
  /** The working directory of the sandboxed process. */
  workingDirectory: string;
  /** The environment of the sandboxed process. */
  environment: Readonly<Record<string, string>>;
}

/**
 * Build the mount plan.
 *
 * The plan is **explicit**: every path the sandboxed process can see is a bind,
 * and every bind says whether it is read-only or read-write. The protected paths
 * are masked with a **tmpfs**, which is the only mask that also covers a path that
 * does not exist yet.
 *
 * **The order of the mounts matters.** The scratch tmpfs comes before the binds,
 * so a working tree that lives under `/tmp` is bound onto the tmpfs rather than
 * being shadowed by it, and the masks come last, so a mask always wins over the
 * bind it covers.
 */
export function buildSandboxPlan(spec: SandboxSpec): SandboxPlan {
  const mounts: SandboxMount[] = [];

  for (const directory of SYSTEM_DIRECTORIES) {
    if (!existsSync(directory)) continue;
    mounts.push({
      kind: 'ro-bind',
      source: directory,
      target: directory,
      reason: 'the system directory is bound read-only',
    });
  }

  mounts.push({
    kind: 'tmpfs',
    target: '/tmp',
    reason: 'the scratch directory is a tmpfs, so it is never the host’s /tmp',
  });
  mounts.push({
    kind: 'proc',
    target: '/proc',
    reason: 'the process namespace gets its own /proc',
  });
  mounts.push({
    kind: 'dev',
    target: '/dev',
    reason: 'the device nodes are the minimal set',
  });

  const workingDirectory = path.resolve(spec.cwd);
  if (workingDirectory !== '/') {
    mounts.push({
      kind: 'ro-bind',
      source: workingDirectory,
      target: workingDirectory,
      reason: 'the working tree is bound read-only',
    });
  }

  for (const readOnly of spec.readOnlyPaths ?? []) {
    const resolved = path.resolve(readOnly);
    mounts.push({
      kind: 'ro-bind',
      source: resolved,
      target: resolved,
      reason: 'the path is bound read-only by the policy',
    });
  }

  for (const writable of spec.readWritePaths ?? []) {
    const resolved = path.resolve(writable);
    mounts.push({
      kind: 'bind',
      source: resolved,
      target: resolved,
      reason: 'the path is bound read-write by the policy',
    });
  }

  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(spec.env ?? DEFAULT_SANDBOX_ENVIRONMENT)) {
    if (value === undefined) continue;
    environment[name] = value;
  }

  let proxySocket: string | undefined;
  if (spec.proxy !== undefined) {
    proxySocket = SANDBOX_PROXY_SOCKET_PATH;
    mounts.push({
      kind: 'bind',
      source: spec.proxy.socketPath,
      target: SANDBOX_PROXY_SOCKET_PATH,
      reason: 'the proxy socket is the only way out of the sandbox',
    });
    environment[SANDBOX_PROXY_SOCKET_VARIABLE] = SANDBOX_PROXY_SOCKET_PATH;
  }

  const binds = mounts
    .filter((mount) => mount.kind === 'ro-bind' || mount.kind === 'bind')
    .map((mount) => ({ target: mount.target, writable: mount.kind === 'bind' }));

  const masks: { path: string; target: string }[] = [];
  const maskTargets = new Set<string>();
  for (const protectedPath of spec.protectedPaths ?? []) {
    const resolved = path.resolve(protectedPath);
    const target = maskTargetFor(resolved, binds);
    masks.push({ path: resolved, target });
    if (maskTargets.has(target)) continue;
    maskTargets.add(target);
    mounts.push({
      kind: 'tmpfs',
      target,
      reason:
        target === resolved
          ? 'the protected path is masked with a tmpfs, so it cannot be created or written even when it does not exist yet'
          : 'the protected path is masked with a tmpfs over its parent, so it cannot be created or written even when it does not exist yet',
    });
  }

  return {
    mounts,
    deniedSyscalls: [...(spec.deniedSyscalls ?? DENIED_SYSCALLS)],
    protectedPaths: [...(spec.protectedPaths ?? []).map((entry) => path.resolve(entry))],
    masks,
    ...(proxySocket === undefined ? {} : { proxySocket }),
    workingDirectory,
    environment,
  };
}

/**
 * The target of the mask that covers a protected path.
 *
 * A tmpfs mask occupies the path it is mounted on, so the sandbox cannot create
 * anything there. Mounting one needs a mount point, and the mount point must not
 * be created **on the host**: a directory named after a protected settings file
 * would break the host's own configuration.
 *
 *   - The protected path exists: the tmpfs is mounted over it, and nothing is
 *     created.
 *   - The protected path is not inside any bind: the tmpfs is mounted on the path
 *     itself, and the mount point is created inside the sandbox's own filesystem.
 *   - The protected path is inside a bind and does not exist: the tmpfs is
 *     mounted on its **parent**, which exists on the host, so the mount point is
 *     never created on the host and the sandbox reaches an empty directory.
 */
function maskTargetFor(
  protectedPath: string,
  binds: readonly { target: string; writable: boolean }[],
): string {
  if (existsSync(protectedPath)) return protectedPath;

  const containing = [...binds]
    .sort((left, right) => right.target.length - left.target.length)
    .find(
      (bind) => protectedPath === bind.target || protectedPath.startsWith(`${bind.target}/`),
    );
  if (containing === undefined) return protectedPath;
  return path.dirname(protectedPath);
}

/** The result of the sandboxed command. */
export interface SandboxRunResult {
  /** The exit code, or `null` when the command was killed by a signal. */
  exitCode: number | null;
  /** The signal that killed the command. */
  signal: NodeJS.Signals | null;
  /** The standard output. */
  stdout: string;
  /** The standard error. */
  stderr: string;
}

/** The process the backend started. */
export interface SandboxProcess {
  /** The pid of the process. */
  pid: number;
  /** Wait for the command to finish. */
  wait(): Promise<SandboxRunResult>;
  /** Kill the command. */
  kill(): void;
}

/** The backend that establishes the sandbox. */
export interface SandboxBackend {
  /** The name of the backend, for the status. */
  readonly name: string;
  /** Whether the backend can run on this host. */
  isAvailable(): Promise<{ available: boolean; reason?: string }>;
  /** Start the sandboxed command. */
  start(plan: SandboxPlan, spec: SandboxSpec): Promise<SandboxProcess>;
}

/** What the sandbox established. */
export interface SandboxStatus {
  /** Whether the command ran inside the sandbox. */
  sandboxed: boolean;
  /** The backend that ran the command. */
  backend: string;
  /** Which of the five layers are in force. */
  layers: {
    /** The mount namespace and the masks. */
    filesystem: boolean;
    /** The seccomp denylist. */
    seccomp: boolean;
    /** The path policy. */
    pathPolicy: boolean;
    /** The network isolation and the proxy. */
    network: boolean;
    /** The seccomp-notification supervisor. */
    supervisor: boolean;
  };
  /** What Landlock can do on this host. */
  landlock: LandlockStatus;
  /** Why the protection is reduced. */
  reducedProtection: readonly string[];
  /** Informational remarks that are not a reduction of the protection. */
  notes: readonly string[];
  /** The reason the command ran unconfined, when it did. */
  reason?: string;
  /** The plan the backend established. */
  plan: SandboxPlan;
}

/** The launched sandbox. */
export interface LaunchedSandbox {
  /** The pid of the sandboxed process. */
  pid: number;
  /** Stop the command and release everything the sandbox holds. */
  cleanup(): Promise<void>;
  /** Wait for the command to finish. */
  wait(): Promise<SandboxRunResult>;
  /** What the sandbox established. */
  status: SandboxStatus;
}

/** The error a refusal raises. */
export class SandboxRefusedError extends Error {
  /** The reason the policy gave. */
  readonly reason: string;

  constructor(reason: string) {
    super(`the sandbox refused to run the command: ${reason}`);
    this.name = 'SandboxRefusedError';
    this.reason = reason;
  }
}

/**
 * Launch a command inside the sandbox.
 *
 * The policy decides first: a denial raises `SandboxRefusedError`, and an
 * exemption or a missing backend runs the command unconfined — with the reason
 * recorded in the status.
 */
export async function launchSandbox(spec: SandboxSpec): Promise<LaunchedSandbox> {
  const policy = spec.policy ?? DEFAULT_SANDBOX_POLICY;
  const platform = spec.platform ?? process.platform;
  const backend = spec.backend ?? bubblewrapBackend();

  if (!existsSync(spec.cwd)) {
    throw new Error(`the sandbox cannot start: the working directory ${spec.cwd} does not exist`);
  }

  let availability: SandboxAvailability;
  let availabilityReason: string | undefined;
  if (spec.availability !== undefined) {
    availability = spec.availability;
  } else {
    const probe = await backend.isAvailable();
    availability = probe.available ? 'available' : 'unavailable';
    availabilityReason = probe.reason;
  }
  const evaluation: SandboxEvaluation = evaluateSandbox(policy, platform, spec.command, availability);
  const landlock = detectLandlock(spec.landlock ?? defaultLandlockSyscalls());

  if (evaluation.decision === 'deny') {
    throw new SandboxRefusedError(evaluation.reason ?? 'the sandbox policy refused the command');
  }

  if (evaluation.decision === 'unconfined') {
    return runUnconfined(spec, backend.name, evaluation, landlock, availabilityReason);
  }

  const plan = buildSandboxPlan(spec);
  const sandboxProcess = await backend.start(plan, spec);
  const timer = startTimeout(spec, sandboxProcess);

  const reducedProtection = [...landlock.reducedProtection];
  const notes: string[] = [];
  if (spec.supervisor === undefined) {
    notes.push(
      'the seccomp-notification supervisor is not attached: it needs a native listener, so the sandbox observes nothing.',
    );
  }
  notes.push(
    'no Landlock ruleset is applied inside the sandbox: applying one needs a native helper, which this build does not ship, so the path policy is enforced by the mount namespace alone.',
  );

  const status: SandboxStatus = {
    sandboxed: true,
    backend: backend.name,
    layers: {
      filesystem: true,
      seccomp: true,
      pathPolicy: true,
      network: true,
      supervisor: spec.supervisor !== undefined,
    },
    landlock,
    reducedProtection,
    notes,
    plan,
  };

  return {
    pid: sandboxProcess.pid,
    status,
    wait: async () => {
      const result = await sandboxProcess.wait();
      if (timer !== undefined) clearTimeout(timer);
      return result;
    },
    cleanup: async () => {
      if (timer !== undefined) clearTimeout(timer);
      sandboxProcess.kill();
      await sandboxProcess.wait().catch(() => undefined);
    },
  };
}

/** Run the command without the sandbox. */
async function runUnconfined(
  spec: SandboxSpec,
  backendName: string,
  evaluation: SandboxEvaluation,
  landlock: LandlockStatus,
  availabilityReason?: string,
): Promise<LaunchedSandbox> {
  const child = spawn('/bin/sh', ['-c', spec.command], {
    cwd: spec.cwd,
    env: spec.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sandboxProcess = collect(child);
  const timer = startTimeout(spec, sandboxProcess);

  const notes = ['the command ran outside the sandbox, so no layer of it is in force.'];
  if (availabilityReason !== undefined) {
    notes.push(`the sandbox backend was unavailable: ${availabilityReason}`);
  }

  const status: SandboxStatus = {
    sandboxed: false,
    backend: backendName,
    layers: {
      filesystem: false,
      seccomp: false,
      pathPolicy: false,
      network: false,
      supervisor: false,
    },
    landlock,
    reducedProtection: [...landlock.reducedProtection],
    notes,
    ...(evaluation.reason === undefined ? {} : { reason: evaluation.reason }),
    plan: buildSandboxPlan(spec),
  };

  return {
    pid: sandboxProcess.pid,
    status,
    wait: async () => {
      const result = await sandboxProcess.wait();
      if (timer !== undefined) clearTimeout(timer);
      return result;
    },
    cleanup: async () => {
      if (timer !== undefined) clearTimeout(timer);
      sandboxProcess.kill();
      await sandboxProcess.wait().catch(() => undefined);
    },
  };
}

/** Kill the command when the timeout expires. */
function startTimeout(spec: SandboxSpec, sandboxProcess: SandboxProcess): NodeJS.Timeout | undefined {
  if (spec.timeoutMs === undefined || spec.timeoutMs <= 0) return undefined;
  return setTimeout(() => {
    sandboxProcess.kill();
  }, spec.timeoutMs);
}

/** Collect the output of a child process. */
function collect(child: ChildProcess): SandboxProcess {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        resolve({ exitCode: code, signal });
      });
      child.on('error', () => resolve({ exitCode: null, signal: null }));
    },
  );

  return {
    pid: child.pid ?? -1,
    wait: async () => {
      const { exitCode, signal } = await exited;
      return { exitCode, signal, stdout, stderr };
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

/**
 * The bubblewrap backend.
 *
 * Bubblewrap establishes the user, mount, pid, ipc, uts and network namespaces,
 * applies the mounts of the plan, installs the seccomp filter and executes the
 * command. `PR_SET_NO_NEW_PRIVS` comes with the seccomp filter.
 */
export function bubblewrapBackend(): SandboxBackend {
  return {
    name: 'bubblewrap',
    async isAvailable(): Promise<{ available: boolean; reason?: string }> {
      if (process.platform !== 'linux') {
        return { available: false, reason: 'the bubblewrap backend runs on Linux only' };
      }
      if (!existsSync(BUBBLEWRAP_BINARY)) {
        return { available: false, reason: `bubblewrap is not installed at ${BUBBLEWRAP_BINARY}` };
      }
      const probe = spawnSync('unshare', ['--user', '--map-root-user', '--mount', 'true'], {
        stdio: 'ignore',
      });
      if (probe.status !== 0) {
        return {
          available: false,
          reason: 'the host does not allow an unprivileged user namespace, so the sandbox cannot be established',
        };
      }
      return { available: true };
    },
    async start(plan: SandboxPlan, spec: SandboxSpec): Promise<SandboxProcess> {
      const filter = buildSeccompFilter({ denied: plan.deniedSyscalls });
      const filterPath = path.join(
        tmpdir(),
        `agent-sandbox-seccomp-${process.pid}-${Date.now().toString(36)}.bin`,
      );
      writeFileSync(filterPath, filter);
      const filterFd = openSync(filterPath, 'r');

      const child = spawn(BUBBLEWRAP_BINARY, bubblewrapArguments(plan, spec), {
        cwd: spec.cwd,
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
        // The filter is handed over as the child's descriptor 3; bubblewrap reads
        // the compiled program from it.
        stdio: ['ignore', 'pipe', 'pipe', filterFd],
      });

      closeSync(filterFd);
      rmSync(filterPath, { force: true });

      return collect(child);
    },
  };
}

/** The bubblewrap command line for a plan. */
function bubblewrapArguments(plan: SandboxPlan, spec: SandboxSpec): string[] {
  const args: string[] = [
    '--unshare-user',
    '--unshare-ipc',
    '--unshare-pid',
    '--unshare-net',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--new-session',
    '--die-with-parent',
    '--clearenv',
  ];

  for (const mount of plan.mounts) {
    switch (mount.kind) {
      case 'ro-bind':
        args.push('--ro-bind-try', mount.source ?? mount.target, mount.target);
        break;
      case 'bind':
        args.push('--bind-try', mount.source ?? mount.target, mount.target);
        break;
      case 'tmpfs':
        args.push('--tmpfs', mount.target);
        break;
      case 'proc':
        args.push('--proc', mount.target);
        break;
      case 'dev':
        args.push('--dev', mount.target);
        break;
      case 'dir':
        args.push('--dir', mount.target);
        break;
      default:
        break;
    }
  }

  for (const [name, value] of Object.entries(plan.environment)) {
    args.push('--setenv', name, value);
  }

  args.push('--chdir', plan.workingDirectory);
  args.push('--seccomp', '3');
  args.push('/bin/sh', '-c', spec.command);
  return args;
}

/**
 * The supervisor of a plan.
 *
 * The supervisor observes and emulates; it never enforces. It is given the plan's
 * path policy, so a path the kernel-enforced layers would refuse is never
 * laundered by the observation. Every read of the target's memory is separated
 * from its use by a `SECCOMP_IOCTL_NOTIF_ID_VALID` re-check.
 */
export function planSupervisor(plan: SandboxPlan, channel: NotifierChannel): SeccompSupervisor {
  return createSeccompSupervisor({ channel, pathPolicy: mountPlanPathPolicy(plan) });
}

/**
 * The path policy layers 1 to 3 enforce, as the supervisor sees it.
 *
 * The supervisor asks it before it continues a call, so a path the mount namespace
 * would refuse is never laundered by the observation. The policy is an
 * approximation of what the kernel enforces: it knows which paths the plan binds
 * and how, but not what the kernel refuses for a reason of its own — which is why
 * the supervisor is observability and never enforcement.
 */export function mountPlanPathPolicy(plan: SandboxPlan): {
  permits(path: string, record: DispatchRecord): boolean;
} {
  const masked = new Set(plan.protectedPaths);
  const readOnly = new Set(
    plan.mounts
      .filter((mount) => mount.kind === 'ro-bind' && mount.source !== undefined)
      .map((mount) => mount.target),
  );
  const writable = new Set(
    plan.mounts
      .filter((mount) => mount.kind === 'bind' && mount.source !== undefined)
      .map((mount) => mount.target),
  );

  return {
    permits(candidate: string): boolean {
      if (masked.has(candidate)) return false;
      for (const maskedPath of masked) {
        if (candidate.startsWith(`${maskedPath}/`)) return false;
      }
      for (const writablePath of writable) {
        if (candidate === writablePath || candidate.startsWith(`${writablePath}/`)) return true;
      }
      for (const readOnlyPath of readOnly) {
        if (candidate === readOnlyPath || candidate.startsWith(`${readOnlyPath}/`)) return true;
      }
      return false;
    },
  };
}

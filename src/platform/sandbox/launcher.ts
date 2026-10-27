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
 *      the protected paths masked. The mask is the point: a read-only bind on a
 *      path that does not exist is a no-op, so the writable parent lets the
 *      sandbox create the file — which is exactly how the target's
 *      CVE-2026-25725 injected persistent hooks.
 *   2. **Syscall surface.** A seccomp-BPF denylist the kernel enforces:
 *      `ptrace`, `process_vm_readv`, `process_vm_writev`, `io_uring_setup`,
 *      `io_uring_register`, `io_uring_enter`, `bpf`, `mount`, `pivot_root` and
 *      `setns`. Blocking `io_uring_setup` is the only reliable defense against the
 *      io-wq class, whose worker threads bypass `seccomp_run_filters()` entirely.
 *   3. **Path policy.** Landlock where the ABI is high enough, bound to `O_PATH`
 *      descriptors. This build ships no native Landlock helper, so **no
 *      Landlock ruleset is ever applied**: the layer is reported as *not* in
 *      force, and the path policy is enforced by the mount namespace instead —
 *      which is kernel-enforced too. The status never claims a layer the build
 *      does not establish.
 *   4. **Network.** The network namespace has no interface at all, so the sandboxed
 *      process cannot open a socket to anything; the only way out is the Unix
 *      socket the launcher bind-mounts into the sandbox, and that socket is served
 *      by the host-side proxy, which enforces the domain allowlist, refuses the
 *      loopback, link-local and cloud-metadata ranges, and pins the address.
 *   5. **Supervisor.** The seccomp-notification supervisor observes and emulates;
 *      it never enforces. The **filter** that notifies is the target's: the
 *      observed syscalls are handed to the listener with
 *      `SECCOMP_RET_USER_NOTIF` (`buildSeccompFilter`), and the **listener**
 *      that serves them is implemented here
 *      (`createSandboxNotificationListener`). The kernel's attachment — the
 *      `seccomp(2)` call with `SECCOMP_FILTER_FLAG_NEW_LISTENER` and the two
 *      `ioctl(2)` calls — is the **native seam** the module already documents:
 *      a Node process cannot issue those calls, so they live behind the
 *      `NotifierChannel`. This build ships no native helper, so the layer is
 *      reported as *not* in force, and the status says so. See
 *      `src/platform/sandbox/seccomp.ts`.
 *
 * **The target's helper, and this implementation's.** The target's
 * `apply-seccomp` worker is a **native** program: it reads `SRT_OBSERVE_SOCK`
 * and `SRT_ENCODED_CMD`, creates a socketpair, unshares the PID, mount and
 * user namespaces, forks, performs the private/root and `/proc` mounts, sets
 * `prctl` (including `PR_SET_NO_NEW_PRIVS`), installs the seccomp filter with
 * `SECCOMP_FILTER_FLAG_TSYNC_ESRCH` and the listener with
 * `SECCOMP_FILTER_FLAG_NEW_LISTENER`, hands the descriptors over with
 * `sendmsg`, waits with `waitpid` and finally `execvp`s the command (audit
 * §2.9). **This implementation is a TypeScript program**, so the helper's
 * **decisions** are made here — `buildSandboxHelperPlan` produces the
 * environment, the namespaces, the mounts, the `prctl` calls, the seccomp
 * flags, the filter program, the descriptors and the order — and the backend
 * performs the parts that need the kernel. The **behaviour** is the target's;
 * the **mechanism** is not, and the difference is named in
 * `docs/compatibility/sandbox-surface.md`.
 *
 * **The launcher never needs root.** The design is unprivileged: user namespaces
 * plus `PR_SET_NO_NEW_PRIVS`, never a setuid helper. This implementation **refuses a
 * setuid bubblewrap outright** — the setuid build is not used at all — and the
 * version of the binary is probed and reported: CVE-2026-87766 (a symlink
 * traversal through bubblewrap's `/oldroot` staging mount) is fixed in 0.12.0.
 * Since this implementation only ever drives the **unprivileged** build, a version at or
 * above 0.12.0 does prove that the fix is present, and a version below it does
 * prove that the fix is missing.
 *
 * **The version policy: an old bubblewrap stays available.** The advisory is
 * promoted to a **named condition** — the status carries it as `advisory` and
 * repeats it in `reducedProtection` — so the caller can branch on it rather
 * than discover it in a log line. Refusing the backend would be *worse*: the
 * implementation's `failIfUnavailable` default refuses the command outright, and the
 * target's own default runs it **unconfined**, which is weaker in expectation
 * than running it inside a sandbox whose backend may carry a known advisory. The
 * implementation therefore keeps the isolation and makes the risk visible.
 *
 * **The backend.** The mount namespace, the namespaces and the seccomp filter are
 * established by **bubblewrap**, which is what the target itself uses on
 * Linux/WSL2. This implementation builds the plan itself — every bind, every mask, the
 * filter — and hands it to the backend; the backend is the part that needs the
 * kernel.
 *
 * **The mask rules.** A tmpfs mask occupies the path it is mounted on, so the
 * mount point must be a **directory that already exists**: a tmpfs mounted on a
 * file dies with `Can't mkdir …: Not a directory`, and a tmpfs mounted on a
 * directory that does not exist creates it — on the host, when the directory
 * lives inside a read-write bind. The rules are therefore:
 *
 *   - a protected path that **is** a directory is masked with a tmpfs on itself;
 *   - a protected path that is a **file**, or that does not exist, is masked with
 *     a tmpfs on its **parent directory**, when that parent exists, is a
 *     directory, is not the root of a bind, and holds the protected path;
 *   - when the parent cannot carry the mask, an **empty file** is bound over the
 *     protected path instead — which works because the path exists;
 *   - when neither is possible, the launch is **refused with a named reason**:
 *     this implementation never creates a directory on the host to make a mask fit.
 *
 * **A mask never shadows a bind.** The masks are applied **after** the binds,
 * so a mask always wins over the bind it covers — and a tmpfs on a directory
 * therefore hides every bind **beneath** it. A policy that grants a path inside
 * a directory it also protects is contradictory: the mask would take the granted
 * path away, and the protected path is unreadable either way. This implementation does
 * not pick a side: the launch is **refused with a named reason**, so the
 * conflict is loud instead of silent. The trade-off is deliberate — a mask that
 * is placed so the bind survives would give the granted path back at the cost of
 * the "the mask always wins" rule, which is the rule that keeps a protected
 * path unreadable.
 *
 * **A mask never lands on a symbolic link.** A mask is a mount, and a mount
 * lands on a **name**: a name that resolves through a link is mounted on the
 * link rather than on the object it names, so the backend either fails the
 * launch (`Can't create file at …`, `Can't mkdir …: Not a directory`) or masks
 * something the caller did not name. A protected path that resolves through a
 * link is therefore **refused with a named reason**, before the backend is
 * started — the launch fails loudly instead of dying inside bubblewrap.
 *
 * **The environment.** The sandboxed process gets an **allowlist**, never the
 * host's environment: `PATH`, `HOME`, `LANG`, `TERM` and the proxy-socket
 * variable, whatever the caller passes. The agent's API key therefore never
 * enters the sandbox, and the status does not echo the environment at all. The
 * **unconfined** path gets the same **filtered** environment — an exempt command
 * is still the agent's command, so it must not see the host's environment
 * either — with two differences that the host makes necessary:
 *
 *   - its `HOME` is the **caller's own**, not the sandbox's `/tmp`. The
 *     sandbox's `/tmp` is a private tmpfs, but the unconfined path runs on the
 *     host, where `/tmp` is world-writable and shared: a command that reads
 *     `$HOME/.gitconfig` out of it reads a file any local user can write.
 *   - it gets **no proxy-socket variable**. The socket is bind-mounted into the
 *     sandbox only, so the variable would name a path that does not exist for
 *     the unconfined process.
 *
 * The API key is filtered out of **both** paths: that is the property the
 * filtered environment exists for.
 *
 * **The status names the hazards it cannot fix.** The `excludedCommands` list is
 * the target's, and an entry of `*` in it is a glob over the whole sub-command,
 * so it exempts **every** command: this implementation does not change the semantics, but
 * the status reports the **scope** of the list (`exemptionScope`), and `all`
 * says in as many words that the sandbox is off for the whole command space.
 *
 * Implementation choices (the plan does not pin them, so they are marked here):
 *
 *   - **The working tree is bound read-only by default.** The target's project
 *     directory is writable; this implementation's is not, so the sandbox cannot modify the
 *     repository it runs in unless the caller asks for a read-write bind.
 *   - The **readiness token**: the sandboxed shell writes a random token to its
 *     standard output before it runs the command, and the launcher strips it. The
 *     token is the launcher's proof that the sandbox actually came up, so the
 *     status can say `sandboxed: false` when it did not.
 *
 * **The residual risk.** All five layers share one kernel. A kernel privilege
 * escalation reachable from the sandbox defeats every layer, and unprivileged user
 * namespaces widen the reachable surface. Only a microVM moves the boundary below
 * the kernel.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import {
  DEFAULT_SANDBOX_POLICY,
  evaluateSandbox,
  exemptionScope,
  type SandboxAvailability,
  type SandboxEvaluation,
  type SandboxExemptionScope,
  type SandboxFilesystemPolicy,
  type SandboxPolicy,
} from './policy.js';
import {
  DENIED_SYSCALLS,
  OBSERVED_SYSCALLS,
  SECCOMP_RET_USER_NOTIF,
  buildSeccompFilter,
  createSeccompSupervisor,
  type DispatchRecord,
  type NotifierChannel,
  type SeccompNotification,
  type SyscallObservation,
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

/**
 * The environment variables the sandboxed process may see.
 *
 * The list is an **allowlist**: everything else the caller passes is dropped, so
 * the agent's credentials never enter the sandbox.
 */
export const SANDBOX_ENVIRONMENT_ALLOWLIST: readonly string[] = Object.freeze([
  'PATH',
  'HOME',
  'LANG',
  'TERM',
  SANDBOX_PROXY_SOCKET_VARIABLE,
]);

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
 * The bubblewrap version that carries the CVE-2026-87766 fix.
 *
 * This implementation **refuses a setuid bubblewrap outright**, so it only ever drives the
 * unprivileged build, and for that build the version does decide whether the
 * fix is present. An older binary stays available: the launcher reports the
 * version, promotes the advisory to a named condition, and warns.
 */
export const BUBBLEWRAP_MINIMUM_VERSION = '0.12.0';

/** The advisory that the minimum version carries the fix for. */
export const BUBBLEWRAP_ADVISORY = 'CVE-2026-87766';

/**
 * The environment the sandboxed process gets when the caller supplies none.
 *
 * The sandbox does **not** inherit the host's environment. A sandboxed command
 * that could read the agent's environment would find the API key in it, which is
 * exactly the leak the research records for the target's own sandbox. The home
 * directory points at the sandbox's own scratch tmpfs unless the caller supplies
 * a `HOME` of its own.
 */
const DEFAULT_SANDBOX_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp',
  LANG: 'C',
  TERM: 'dumb',
});

/**
 * Which path the environment is built for.
 *
 * The two paths differ in two ways, and only in ways the host makes necessary:
 * the unconfined path runs on the host, where the sandbox's own `/tmp` is a
 * shared, world-writable directory, and the proxy socket is bind-mounted into
 * the sandbox only.
 */
export type SandboxEnvironmentMode = 'sandboxed' | 'unconfined';

/** How long the launcher waits for the backend to confirm that the sandbox came up. */
const ESTABLISHMENT_TIMEOUT_MS = 15_000;

/** The file descriptor the seccomp filter is handed over on. */
const FILTER_FD = 3;

/** The first file descriptor a mask's data file is handed over on. */
const FIRST_DATA_FD = FILTER_FD + 1;

/**
 * The shell the sandboxed command runs under.
 *
 * The wrapper writes the readiness token to the standard output and then
 * `exec`s the command, so the command keeps the process's own pid and its exit
 * status, and the token is the only thing the launcher has to strip.
 */
const READINESS_SCRIPT = 'printf %s "$1"; exec /bin/sh -c "$2"';

/** What to launch. */
export interface SandboxSpec {
  /** The shell command to run inside the sandbox. */
  command: string;
  /** The working directory of the sandboxed process. */
  cwd: string;
  /** The environment of the sandboxed process; filtered against the allowlist. */
  env?: NodeJS.ProcessEnv;
  /** The sandbox policy. */
  policy?: SandboxPolicy;
  /** The platform name; the host's own platform when it is not supplied. */
  platform?: string;
  /** The paths masked inside the sandbox. */
  protectedPaths?: readonly string[];
  /** The syscalls the seccomp filter blocks; the denylist when it is not supplied. */
  deniedSyscalls?: readonly string[];
  /** Extra paths bound read-only inside the sandbox. */
  readOnlyPaths?: readonly string[];
  /** Extra paths bound read-write inside the sandbox. */
  readWritePaths?: readonly string[];
  /** The filesystem policy of the `sandbox.filesystem` block. */
  filesystem?: SandboxFilesystemPolicy;
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
  kind: 'ro-bind' | 'bind' | 'tmpfs' | 'proc' | 'dev' | 'dir' | 'empty-file';
  /** The host path the mount comes from. */
  source?: string;
  /** The path inside the sandbox. */
  target: string;
  /** Why the entry is in the plan. */
  reason: string;
}

/** How a protected path is masked. */
export type SandboxMaskKind = 'tmpfs' | 'empty-file';

/** One mask of the plan. */
export interface SandboxMask {
  /** The protected path the mask covers. */
  path: string;
  /** The path the mask is mounted on. */
  target: string;
  /** How the mask is established. */
  kind: SandboxMaskKind;
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
  masks: readonly SandboxMask[];
  /** The reasons the plan could not be established; a launch with one is refused. */
  refusals: readonly string[];
  /** The proxy socket bind-mounted into the sandbox. */
  proxySocket?: string;
  /** The working directory of the sandboxed process. */
  workingDirectory: string;
}

/**
 * The mount plan a `sandbox.filesystem` block produces.
 *
 * The block is the target's: the audit names `allowRead`, `allowWrite`,
 * `denyRead`, `denyWrite` and `credentials`.
 */
export interface SandboxFilesystemPlan {
  /** The paths bound read-only. */
  readonly readOnlyPaths: readonly string[];
  /** The paths bound read-write. */
  readonly readWritePaths: readonly string[];
  /** The paths masked. */
  readonly protectedPaths: readonly string[];
}

/**
 * Map a `sandbox.filesystem` block onto the mount plan.
 *
 * The allow lists become binds: `allowRead` a read-only bind, `allowWrite` a
 * read-write one. The deny lists and the credential list become **masked**
 * paths, because the mount namespace cannot deny a write without also denying a
 * read — a `denyWrite` path is therefore masked entirely, which is the fail-safe
 * reading.
 */
export function planFilesystemPolicy(policy: SandboxFilesystemPolicy): SandboxFilesystemPlan {
  return {
    readOnlyPaths: [...(policy.allowRead ?? [])],
    readWritePaths: [...(policy.allowWrite ?? [])],
    protectedPaths: [
      ...(policy.denyRead ?? []),
      ...(policy.denyWrite ?? []),
      ...(policy.credentials ?? []),
    ],
  };
}

/**
 * Build the mount plan.
 *
 * The plan is **explicit**: every path the sandboxed process can see is a bind,
 * and every bind says whether it is read-only or read-write. The protected paths
 * are masked, which is the only mask that also covers a path that does not exist
 * yet.
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

  // A relative path is relative to the **working directory** of the sandbox and
  // not to the directory the launcher happens to run in: a policy that names
  // `config/settings.json` means the one inside the tree the command runs in.
  const inTree = (entry: string): string => path.resolve(workingDirectory, entry);

  const filesystem = planFilesystemPolicy(spec.filesystem ?? spec.policy?.filesystem ?? {});

  const readOnlyPaths = [...(spec.readOnlyPaths ?? []), ...filesystem.readOnlyPaths];
  for (const readOnly of readOnlyPaths) {
    const resolved = inTree(readOnly);
    mounts.push({
      kind: 'ro-bind',
      source: resolved,
      target: resolved,
      reason: 'the path is bound read-only by the policy',
    });
  }

  const readWritePaths = [...(spec.readWritePaths ?? []), ...filesystem.readWritePaths];
  for (const writable of readWritePaths) {
    const resolved = inTree(writable);
    mounts.push({
      kind: 'bind',
      source: resolved,
      target: resolved,
      reason: 'the path is bound read-write by the policy',
    });
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
  }

  const binds = effectiveBinds(mounts);
  const protectedPaths = [
    ...(spec.protectedPaths ?? []),
    ...filesystem.protectedPaths,
  ].map((entry) => inTree(entry));

  const masks: SandboxMask[] = [];
  const refusals: string[] = [];
  const mounted = new Set<string>();
  for (const protectedPath of protectedPaths) {
    const planned = planMask(protectedPath, binds);
    if (planned.refusal !== undefined) {
      refusals.push(planned.refusal);
      continue;
    }
    if (planned.mask === undefined) continue;
    masks.push(planned.mask);
    const key = `${planned.mask.kind}:${planned.mask.target}`;
    if (mounted.has(key)) continue;
    mounted.add(key);
    mounts.push(
      planned.mask.kind === 'tmpfs'
        ? {
            kind: 'tmpfs',
            target: planned.mask.target,
            reason:
              planned.mask.target === planned.mask.path
                ? 'the protected path is masked with a tmpfs, so it cannot be read or written even when it does not exist yet'
                : 'the protected path is masked with a tmpfs over its parent directory, so it cannot be read, written or created',
          }
        : {
            kind: 'empty-file',
            target: planned.mask.target,
            reason:
              'the protected path is masked with an empty file, so its contents cannot be read or written',
          },
    );
  }

  return {
    mounts,
    deniedSyscalls: [...(spec.deniedSyscalls ?? DENIED_SYSCALLS)],
    protectedPaths,
    masks,
    refusals,
    ...(proxySocket === undefined ? {} : { proxySocket }),
    workingDirectory,
  };
}

/** A bind of the plan, as the mask planner sees it. */
interface PlanBind {
  /** The path the bind is mounted on. */
  target: string;
  /** Whether the bind is writable. */
  writable: boolean;
}

/**
 * The binds of a plan, with the **last** mount for a path winning.
 *
 * A path that is bound twice — read-only by the working tree and read-write by
 * the policy — ends up with the mode of the last mount, which is the mode the
 * sandbox actually gets.
 */
function effectiveBinds(mounts: readonly SandboxMount[]): PlanBind[] {
  const byTarget = new Map<string, PlanBind>();
  for (const mount of mounts) {
    if (mount.kind !== 'ro-bind' && mount.kind !== 'bind') continue;
    byTarget.set(mount.target, { target: mount.target, writable: mount.kind === 'bind' });
  }
  return [...byTarget.values()];
}

/** The plan of one mask. */
interface MaskPlan {
  /** The mask, when one is possible. */
  mask?: SandboxMask;
  /** The reason the mask is impossible; the launch is refused when it is set. */
  refusal?: string;
}

/**
 * The mask that covers a protected path.
 *
 * A tmpfs mask occupies the path it is mounted on, so the mount point must be a
 * directory that already exists. The parent directory carries the mask when it
 * exists, is a directory, is not the root of a bind, and holds the protected
 * path; an empty file is bound over the protected path when the parent cannot
 * carry the mask and the path itself exists. When neither is possible the launch
 * is refused: this implementation never creates a directory on the host to make a mask fit.
 *
 * A protected path that **resolves through a symbolic link** is refused as well.
 * A mask is a mount, and a mount lands on a *name*: a name that is a link is
 * mounted on the link rather than on the object it names, so the backend either
 * fails the launch (`Can't create file at …`) or masks something the caller did
 * not name. The refusal names the link, so the caller can fix the path instead
 * of watching the sandbox die inside bubblewrap.
 */
function planMask(protectedPath: string, binds: readonly PlanBind[]): MaskPlan {
  const containing = containingBind(protectedPath, binds);
  if (containing === undefined) {
    // The path is inside no bind, so the sandbox does not see it at all and
    // there is nothing to mask.
    return {};
  }

  // The parts of the path that the bind carries are the parts that exist as
  // they are on the host inside the sandbox; the bind's own target is created
  // as a real directory there, so a link above it does not carry in.
  const link = symlinkBelow(protectedPath, containing.target);
  if (link !== undefined) {
    return {
      refusal:
        `the protected path ${protectedPath} cannot be masked: ${link} is a symbolic link, ` +
        'and a mask would land on the link rather than on the path it names',
    };
  }

  const stats = statOrUndefined(protectedPath);
  if (stats !== undefined && stats.isDirectory()) {
    // A directory carries a tmpfs directly: the mount point is a directory.
    return maskOrRefusal(
      { path: protectedPath, target: protectedPath, kind: 'tmpfs' },
      protectedPath,
      binds,
    );
  }

  const parent = maskTargetFor(protectedPath, containing, binds);
  if (parent !== undefined) {
    return maskOrRefusal(
      { path: protectedPath, target: parent, kind: 'tmpfs' },
      protectedPath,
      binds,
    );
  }

  if (stats !== undefined && stats.isFile()) {
    // The parent cannot carry the mask, but the path exists: an empty file is
    // bound over it, so neither its contents nor its mode are reachable.
    return maskOrRefusal(
      { path: protectedPath, target: protectedPath, kind: 'empty-file' },
      protectedPath,
      binds,
    );
  }

  if (containing.writable) {
    return {
      refusal:
        `the protected path ${protectedPath} cannot be masked: its directory does not exist, ` +
        'and masking it would create that directory on the host',
    };
  }

  // The bind that holds the path is read-only, so the sandbox can neither create
  // the path nor write to it. There is nothing to mask.
  return {};
}

/**
 * The mask, unless it would shadow a bind of the plan.
 *
 * The masks are applied **after** the binds, so a mask always wins over the bind
 * it covers — and a tmpfs on a directory hides every bind **beneath** it. A
 * policy that grants a path inside a directory it also protects is
 * contradictory: the protected path is unreadable either way, and the mask
 * would take the granted path away as well. The launch is therefore **refused
 * with a named reason** rather than silently dropping the grant: the trade-off
 * is between "the protected path is unreadable" and "the granted path stays
 * readable", and this implementation refuses instead of picking a side.
 */
function maskOrRefusal(
  mask: SandboxMask,
  protectedPath: string,
  binds: readonly PlanBind[],
): MaskPlan {
  const shadowed = binds.find((bind) => isUnder(bind.target, mask.target));
  if (shadowed !== undefined) {
    return {
      refusal:
        `the protected path ${protectedPath} cannot be masked: the mask would be a tmpfs on ` +
        `${mask.target}, which contains the bind the plan grants at ${shadowed.target}, so the ` +
        'mask would shadow the bind',
    };
  }
  return { mask };
}

/** Whether a path lies below another one. */
function isUnder(candidate: string, root: string): boolean {
  return candidate.startsWith(`${root}${path.sep}`);
}

/**
 * The first part of a path, below a root, that is a symbolic link.
 *
 * The parts at or above the root are not inspected: the backend creates the
 * root itself as a real directory inside the sandbox, so a link there does not
 * carry in. A path that is not below the root at all has no such part.
 */
function symlinkBelow(candidate: string, root: string): string | undefined {
  const relative = path.relative(root, candidate);
  if (relative.length === 0 || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return undefined;
  }
  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    if (isSymbolicLink(current)) return current;
  }
  return undefined;
}

/** Whether a path is a symbolic link. */
function isSymbolicLink(candidate: string): boolean {
  try {
    return lstatSync(candidate).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The directory that carries the mask of a protected path.
 *
 * The directory must exist, must be a directory, must not be the root of a bind
 * (a tmpfs there would replace the whole bind — the working tree with it), and
 * must hold the protected path.
 */
function maskTargetFor(
  protectedPath: string,
  containing: PlanBind,
  binds: readonly PlanBind[],
): string | undefined {
  let candidate = path.dirname(protectedPath);
  while (candidate !== containing.target && candidate !== path.dirname(candidate)) {
    if (isDirectory(candidate) && !isBindRoot(candidate, binds)) return candidate;
    candidate = path.dirname(candidate);
  }
  return undefined;
}

/** The bind that holds a path, the deepest one. */
function containingBind(
  protectedPath: string,
  binds: readonly PlanBind[],
): PlanBind | undefined {
  return [...binds]
    .sort((left, right) => right.target.length - left.target.length)
    .find(
      (bind) => protectedPath === bind.target || protectedPath.startsWith(`${bind.target}/`),
    );
}

/** Whether a path is the root of a bind. */
function isBindRoot(candidate: string, binds: readonly PlanBind[]): boolean {
  return binds.some((bind) => bind.target === candidate);
}

/** Whether a path is a directory that exists. */
function isDirectory(candidate: string): boolean {
  const stats = statOrUndefined(candidate);
  return stats !== undefined && stats.isDirectory();
}

/** The status of a path, when it exists. */
function statOrUndefined(candidate: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(candidate);
  } catch {
    return undefined;
  }
}

/**
 * The number of output characters the launcher keeps.
 *
 * The cap is enforced **at the collection point**, not after it: a command
 * that prints a gigabyte must not make the process hold a gigabyte before the
 * caller truncates it. Past the cap the launcher keeps counting, so the caller
 * can report that the output was truncated.
 */
export const MAX_COLLECTED_OUTPUT_CHARS = 200_000;

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
  /**
   * Whether the output was cut short by the collection cap.
   *
   * The launcher keeps at most {@link MAX_COLLECTED_OUTPUT_CHARS} characters
   * of each stream, so a command that prints more is **truncated** rather
   * than held whole in memory.
   *
   * It is **optional**: a caller that builds a result by hand — a test
   * double, or a backend that does not collect — reports nothing, and the
   * absence means "not truncated".
   */
  truncated?: boolean;
}

/** The layers a sandbox establishes. */
export interface SandboxLayers {
  /** The mount namespace and the masks. */
  filesystem: boolean;
  /** The seccomp denylist. */
  seccomp: boolean;
  /** The Landlock path policy. */
  pathPolicy: boolean;
  /** The network isolation and the proxy. */
  network: boolean;
  /** The seccomp-notification supervisor. */
  supervisor: boolean;
}

/** No layer is in force. */
const NO_LAYERS: SandboxLayers = Object.freeze({
  filesystem: false,
  seccomp: false,
  pathPolicy: false,
  network: false,
  supervisor: false,
});

/** What the backend established. */
export interface SandboxEstablishment {
  /** Whether the sandbox came up at all. */
  established: boolean;
  /** The layers that are in force. */
  layers: SandboxLayers;
  /** Why the sandbox did not come up. */
  reason?: string;
}

/** The process the backend started. */
export interface SandboxProcess {
  /** The pid of the process. */
  pid: number;
  /**
   * Whether the sandbox came up.
   *
   * The promise resolves once the backend knows: `established` is `true` when
   * the sandbox is up and `false` when it never came up. A backend that cannot
   * tell resolves `true`, because it is the backend that establishes the sandbox.
   */
  readonly establishment?: Promise<SandboxEstablishment>;
  /**
   * The output collected **so far**.
   *
   * A caller that stops the command before it ends reads the partial output
   * from here, rather than losing it with the process.
   *
   * It is **optional**: a backend that does not collect — a test double, or
   * one that streams the output elsewhere — reports nothing.
   */
  readonly output?: { readonly stdout: string; readonly stderr: string };
  /** Wait for the command to finish. */
  wait(): Promise<SandboxRunResult>;
  /** Kill the command. */
  kill(): void;
}

/**
 * The advisory that applies to the backend the launcher drives.
 *
 * It is a **named condition**, not a footnote: the caller can branch on
 * `advisory.id` and decide what to do about it, and the status repeats it in
 * `reducedProtection` so it cannot be missed.
 */
export interface SandboxAdvisory {
  /** The identifier of the advisory, e.g. `CVE-2026-87766`. */
  readonly id: string;
  /** The version of the backend that carries the fix. */
  readonly fixedIn: string;
  /** The version of the backend that is installed. */
  readonly version: string;
  /** What the advisory means for the sandbox. */
  readonly detail: string;
}

/** The enforcement a backend depends on. */
export interface BackendEnforcement {
  /** The binary the backend drives. */
  binary: string;
  /** The version the binary reports, when it could be read. */
  version?: string;
  /** Whether the binary carries the setuid bit. */
  setuid: boolean;
  /** The warnings about the enforcement; it is in force, but something is off. */
  warnings: readonly string[];
  /** The reasons the enforcement cannot be used. */
  problems: readonly string[];
  /** The advisory that applies to the enforcement, when one does. */
  advisory?: SandboxAdvisory;
}

/** The backend that establishes the sandbox. */
export interface SandboxBackend {
  /** The name of the backend, for the status. */
  readonly name: string;
  /** Whether the backend can run on this host. */
  isAvailable(): Promise<{ available: boolean; reason?: string; warning?: string }>;
  /** What the backend knows about the enforcement it depends on. */
  describe?(): Promise<BackendEnforcement>;
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
  layers: SandboxLayers;
  /** What Landlock can do on this host. */
  landlock: LandlockStatus;
  /** Why the protection is reduced. */
  reducedProtection: readonly string[];
  /** Informational remarks that are not a reduction of the protection. */
  notes: readonly string[];
  /** The reason the command ran unconfined, when it did. */
  reason?: string;
  /** The `excludedCommands` entries that exempt the command. */
  exemptions?: readonly string[];
  /**
   * The scope the `excludedCommands` list covers.
   *
   * `all` means the list carries an entry that matches **every** command: with
   * `allowUnsandboxedCommands` set, the sandbox is then switched off for the
   * whole command space. The semantics are the target's; this implementation only
   * reports the reach of the list, so the hazard is visible.
   */
  exemptionScope: SandboxExemptionScope;
  /** What the launcher knows about the enforcement the backend depends on. */
  enforcement?: BackendEnforcement;
  /**
   * The advisory that applies to the backend, when one does.
   *
   * A **named condition**: `advisory.id` says which advisory, `advisory.version`
   * says which version carries it, and `advisory.fixedIn` says which version
   * fixes it. The same advisory is repeated in `reducedProtection`.
   */
  advisory?: SandboxAdvisory;
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
  /** The output collected **so far**, for a caller that stops the command early. */
  readonly output?: { readonly stdout: string; readonly stderr: string };
  /** What the sandbox established. */
  status: SandboxStatus;
  /** The seccomp notifications the supervisor observed, when one was attached. */
  readonly observations?: readonly SyscallObservation[];
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
 * recorded in the status. A plan that cannot mask a protected path is refused
 * with a named reason, and a backend that never brings the sandbox up is
 * reported as `sandboxed: false`.
 */
export async function launchSandbox(spec: SandboxSpec): Promise<LaunchedSandbox> {
  const policy = spec.policy ?? DEFAULT_SANDBOX_POLICY;
  const platform = spec.platform ?? process.platform;
  const { defaultSandboxBackend } = await import('./helper.js');
  const backend = spec.backend ?? (await defaultSandboxBackend());

  if (!existsSync(spec.cwd)) {
    throw new SandboxRefusedError(
      `the working directory ${spec.cwd} does not exist, so the sandbox cannot start`,
    );
  }

  let availability: SandboxAvailability;
  let availabilityReason: string | undefined;
  let availabilityWarning: string | undefined;
  if (spec.availability !== undefined) {
    availability = spec.availability;
  } else {
    const probe = await backend.isAvailable();
    availability = probe.available ? 'available' : 'unavailable';
    availabilityReason = probe.reason;
    availabilityWarning = probe.warning;
  }
  const evaluation: SandboxEvaluation = evaluateSandbox(policy, platform, spec.command, availability);
  const landlock = detectLandlock(spec.landlock ?? defaultLandlockSyscalls());

  if (evaluation.decision === 'deny') {
    throw new SandboxRefusedError(evaluation.reason ?? 'the sandbox policy refused the command');
  }

  const enforcement = await backend.describe?.();

  if (evaluation.decision === 'unconfined') {
    return runUnconfined(
      spec,
      backend.name,
      evaluation,
      landlock,
      policy,
      availabilityReason,
      availabilityWarning,
      enforcement,
    );
  }

  const plan = buildSandboxPlan(spec);
  if (plan.refusals.length > 0) {
    throw new SandboxRefusedError(plan.refusals.join('; '));
  }

  const sandboxProcess = await backend.start(plan, spec);
  const timer = startTimeout(spec, sandboxProcess);
  const establishment = await resolveEstablishment(sandboxProcess);

  const reducedProtection = [...landlock.reducedProtection];
  const notes: string[] = [];
  if (availabilityWarning !== undefined) notes.push(availabilityWarning);
  if (enforcement !== undefined) {
    for (const warning of enforcement.warnings) pushNote(notes, warning);
  }
  const advisory = enforcement?.advisory;
  if (advisory !== undefined) {
    // The advisory is a named condition **and** a line of the reduced
    // protection, so it cannot be missed by a reader of the status alone.
    reducedProtection.push(advisoryCondition(backend.name, advisory));
  }
  const scopeNote = exemptionScopeNote(exemptionScope(policy));
  if (scopeNote !== undefined) notes.push(scopeNote);
  if (!establishment.layers.supervisor) {
    notes.push(
      'the seccomp-notification supervisor is not attached: the kernel attachment (seccomp(2) with SECCOMP_FILTER_FLAG_NEW_LISTENER and the two ioctls) needs a native listener, so the sandbox observes nothing.',
    );
  }
  if (spec.supervisor !== undefined && !establishment.layers.supervisor) {
    notes.push(
      'a supervisor object was supplied, but the notification filter it needs is installed by the helper, and the helper’s kernel calls need a native listener, so the supervisor still observes nothing.',
    );
  }
  if (!establishment.layers.pathPolicy) {
    notes.push(
      'no Landlock ruleset is applied inside the sandbox: applying one needs a native helper, which this build does not ship, so the path policy is enforced by the mount namespace alone.',
    );
  }
  if (sandboxProcess.establishment === undefined) {
    notes.push(
      'the backend did not report which layers it establishes, so only the filesystem boundary is claimed.',
    );
  }
  if (!establishment.established) {
    notes.push(
      'the sandbox never came up, so no layer of it is in force: the command ran without the isolation the plan describes.',
    );
  }

  const status: SandboxStatus = {
    sandboxed: establishment.established,
    backend: backend.name,
    layers: establishment.layers,
    landlock,
    reducedProtection,
    notes,
    ...(establishment.reason === undefined ? {} : { reason: establishment.reason }),
    ...(advisory === undefined ? {} : { advisory }),
    ...(enforcement === undefined ? {} : { enforcement }),
    exemptionScope: exemptionScope(policy),
    plan,
  };

  return {
    pid: sandboxProcess.pid,
    status,
    get output(): { readonly stdout: string; readonly stderr: string } | undefined {
      return sandboxProcess.output;
    },
    get observations(): readonly SyscallObservation[] | undefined {
      return (sandboxProcess as { observations?: readonly SyscallObservation[] }).observations;
    },
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

/**
 * The advisory as a line of the reduced protection.
 *
 * The line names the advisory and the backend it applies to, so a reader of
 * the status alone can tell that the protection is reduced and why.
 */
function advisoryCondition(backendName: string, advisory: SandboxAdvisory): string {
  return `the ${backendName} backend carries ${advisory.id}: ${advisory.detail}`;
}

/**
 * Add a note to the list, unless the list already carries it.
 *
 * The availability probe and the enforcement probe report the same facts: the
 * advisory's detail is one of them, and the real backend puts it in both. A
 * note that is already there is therefore not repeated — the detail is reported
 * once, and the machine-readable `advisory` and the `reducedProtection` line
 * carry it as well.
 */
function pushNote(notes: string[], note: string): void {
  if (notes.some((existing) => existing.includes(note))) return;
  notes.push(note);
}

/**
 * The note that names the catch-all exclusion.
 *
 * The semantics are the target's: an entry of `*` is a glob over the whole
 * sub-command, so it exempts every command. This implementation does not change that; it
 * makes the hazard visible, because a list that exempts everything switches
 * the sandbox off for the whole command space and nothing else in the status
 * says so.
 */
function exemptionScopeNote(scope: SandboxExemptionScope): string | undefined {
  if (scope !== 'all') return undefined;
  return (
    'the excludedCommands list carries an entry that matches every command, so every command ' +
    'runs outside the sandbox (a command that carries a command substitution is still sandboxed)'
  );
}

/**
 * Wait for the backend to say whether the sandbox came up.
 *
 * A backend that cannot tell is trusted: it is the backend that establishes the
 * sandbox. A backend that never answers is not: the launcher reports the sandbox
 * as not established rather than claiming a guarantee it cannot show.
 */
async function resolveEstablishment(sandboxProcess: SandboxProcess): Promise<SandboxEstablishment> {
  const establishment = sandboxProcess.establishment;
  if (establishment === undefined) {
    return {
      established: true,
      layers: { ...NO_LAYERS, filesystem: true },
    };
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<SandboxEstablishment>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        established: false,
        layers: { ...NO_LAYERS },
        reason: 'the backend did not confirm that the sandbox came up',
      });
    }, ESTABLISHMENT_TIMEOUT_MS);
    timer.unref();
  });
  try {
    return await Promise.race([establishment, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Run the command without the sandbox. */
async function runUnconfined(
  spec: SandboxSpec,
  backendName: string,
  evaluation: SandboxEvaluation,
  landlock: LandlockStatus,
  policy: SandboxPolicy,
  availabilityReason?: string,
  availabilityWarning?: string,
  enforcement?: BackendEnforcement,
): Promise<LaunchedSandbox> {
  const child = spawn('/bin/sh', ['-c', spec.command], {
    cwd: spec.cwd,
    // The **same filtered environment** the sandboxed path uses: an exempt
    // command is still the agent's command, so it must not see the host's
    // environment — the agent's API key is in it. The two paths differ only
    // where the host makes it necessary: the unconfined path runs on the host,
    // where the sandbox's own `/tmp` is a shared, world-writable directory, so
    // its home is the caller's own; and the proxy socket is bind-mounted into
    // the sandbox only, so the unconfined path is not handed the variable.
    env: sandboxEnvironment(spec, 'unconfined'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sandboxProcess = collect(child);
  const timer = startTimeout(spec, sandboxProcess);

  const notes = ['the command ran outside the sandbox, so no layer of it is in force.'];
  if (availabilityReason !== undefined) {
    notes.push(`the sandbox backend was unavailable: ${availabilityReason}`);
  }
  if (availabilityWarning !== undefined) notes.push(availabilityWarning);
  if (enforcement !== undefined) {
    for (const warning of enforcement.warnings) pushNote(notes, warning);
  }

  const advisory = enforcement?.advisory;
  const reducedProtection = [...landlock.reducedProtection];
  if (advisory !== undefined) {
    reducedProtection.push(advisoryCondition(backendName, advisory));
  }
  const scopeNote = exemptionScopeNote(exemptionScope(policy));
  if (scopeNote !== undefined) notes.push(scopeNote);

  const plan = buildSandboxPlan(spec);
  if (plan.refusals.length > 0) {
    // The plan was never established, so its refusals were never acted on. They
    // are said out loud rather than left in the plan alone: a reader of the
    // status has to be able to tell that the refusals were not enforced.
    notes.push(
      'the sandbox plan was never established, so the refusals it carries were never acted on: ' +
        plan.refusals.join('; '),
    );
  }

  const status: SandboxStatus = {
    sandboxed: false,
    backend: backendName,
    layers: { ...NO_LAYERS },
    landlock,
    reducedProtection,
    notes,
    ...(evaluation.reason === undefined ? {} : { reason: evaluation.reason }),
    ...(evaluation.exemptions === undefined ? {} : { exemptions: evaluation.exemptions }),
    ...(advisory === undefined ? {} : { advisory }),
    ...(enforcement === undefined ? {} : { enforcement }),
    exemptionScope: exemptionScope(policy),
    plan,
  };

  return {
    pid: sandboxProcess.pid,
    status,
    get output(): { readonly stdout: string; readonly stderr: string } | undefined {
      return sandboxProcess.output;
    },
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

/** The options of the collector. */
interface CollectOptions {
  /** The token the sandboxed shell writes when the sandbox is up. */
  readinessToken?: string;
  /** The layers the backend establishes. */
  layers?: SandboxLayers;
}

/**
 * The stdout without the launcher's readiness token.
 *
 * The token is written by the backend before the command's own output, and
 * the caller never sees it: it is the launcher's channel, not the command's.
 */
function withoutReadinessToken(stdout: string, token?: string): string {
  if (token === undefined) return stdout;
  return stdout.startsWith(token) ? stdout.slice(token.length) : stdout;
}

/**
 * Collect the output of a child process.
 *
 * The readiness token is stripped from the standard output, so the caller sees
 * exactly the output of the command. The establishment resolves as soon as the
 * token arrives, and resolves as a failure when the process ends without one.
 */
function collect(child: ChildProcess, options: CollectOptions = {}): SandboxProcess {
  let stdout = '';
  let stderr = '';
  let tokenSeen = options.readinessToken === undefined;
  const layers = options.layers ?? { ...NO_LAYERS };

  let resolveEstablishment: ((establishment: SandboxEstablishment) => void) | undefined;
  const establishment = new Promise<SandboxEstablishment>((resolve) => {
    resolveEstablishment = resolve;
  });
  if (options.readinessToken === undefined) {
    // There is no token to wait for: the backend reports the layers itself.
    resolveEstablishment?.({ established: true, layers });
  }

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  let truncated = false;
  child.stdout?.on('data', (chunk: string) => {
    if (stdout.length >= MAX_COLLECTED_OUTPUT_CHARS) {
      truncated = true;
      return;
    }
    stdout += chunk;
    if (stdout.length > MAX_COLLECTED_OUTPUT_CHARS) {
      stdout = stdout.slice(0, MAX_COLLECTED_OUTPUT_CHARS);
      truncated = true;
    }
    const token = options.readinessToken;
    if (token === undefined || tokenSeen) return;
    if (stdout.length < token.length) return;
    if (!stdout.startsWith(token)) return;
    tokenSeen = true;
    resolveEstablishment?.({ established: true, layers });
  });
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length >= MAX_COLLECTED_OUTPUT_CHARS) {
      truncated = true;
      return;
    }
    stderr += chunk;
    if (stderr.length > MAX_COLLECTED_OUTPUT_CHARS) {
      stderr = stderr.slice(0, MAX_COLLECTED_OUTPUT_CHARS);
      truncated = true;
    }
  });

  const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (!tokenSeen) {
          tokenSeen = true;
          resolveEstablishment?.({
            established: false,
            layers: { ...NO_LAYERS },
            reason: describeEstablishmentFailure(stderr),
          });
        }
        resolve({ exitCode: code, signal });
      });
      child.on('error', () => {
        if (!tokenSeen) {
          tokenSeen = true;
          resolveEstablishment?.({
            established: false,
            layers: { ...NO_LAYERS },
            reason: 'the sandbox process could not be started',
          });
        }
        resolve({ exitCode: null, signal: null });
      });
    },
  );

  return {
    pid: child.pid ?? -1,
    establishment,
    get output(): { readonly stdout: string; readonly stderr: string } {
      // The **readiness token** is the launcher's own, not the command's: it
      // is stripped here exactly as `wait()` strips it, so a caller that reads
      // the live output — a command stopped before it ended — never sees it.
      return { stdout: withoutReadinessToken(stdout, options.readinessToken), stderr };
    },
    wait: async () => {
      const { exitCode, signal } = await exited;
      return {
        exitCode,
        signal,
        stdout: withoutReadinessToken(stdout, options.readinessToken),
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

/** The reason a sandbox that never came up failed. */
function describeEstablishmentFailure(stderr: string): string {
  const firstLine = stderr.split('\n').find((line) => line.trim().length > 0);
  if (firstLine === undefined) {
    return 'the sandbox never came up and the backend said nothing about it';
  }
  return `the sandbox never came up: ${firstLine.trim()}`;
}

/**
 * The bubblewrap backend.
 *
 * Bubblewrap establishes the user, mount, pid, ipc, uts and network namespaces,
 * applies the mounts of the plan, installs the seccomp filter and executes the
 * command. `PR_SET_NO_NEW_PRIVS` comes with the seccomp filter.
 */
export function bubblewrapBackend(): SandboxBackend {
  let enforcement: Promise<BackendEnforcement> | undefined;
  const describe = (): Promise<BackendEnforcement> => {
    enforcement ??= Promise.resolve(probeEnforcementBinary(BUBBLEWRAP_BINARY));
    return enforcement;
  };

  return {
    name: 'bubblewrap',
    describe,
    async isAvailable(): Promise<{
      available: boolean;
      reason?: string;
      warning?: string;
    }> {
      if (process.platform !== 'linux') {
        return { available: false, reason: 'the bubblewrap backend runs on Linux only' };
      }
      if (!existsSync(BUBBLEWRAP_BINARY)) {
        return { available: false, reason: `bubblewrap is not installed at ${BUBBLEWRAP_BINARY}` };
      }
      const info = await describe();
      if (info.problems.length > 0) {
        return { available: false, reason: info.problems[0] };
      }
      const probe = probeUserNamespace();
      if (!probe.available) {
        return { available: false, reason: probe.reason };
      }
      // The version never makes the backend unavailable: the advisory is a
      // named condition on the status, and a refusal would run the command
      // unconfined, which is weaker in expectation.
      const warnings = [
        ...(info.advisory === undefined ? [] : [info.advisory.detail]),
        ...(probe.warning === undefined ? [] : [probe.warning]),
      ];
      return {
        available: true,
        ...(warnings.length === 0 ? {} : { warning: warnings.join('; ') }),
      };
    },
    async start(plan: SandboxPlan, spec: SandboxSpec): Promise<SandboxProcess> {
      // The **enforcement** filter: the denylist only. A notified syscall
      // without a listener attached answers `ENOSYS`, so the filter the
      // backend installs never carries the notification action — the target's
      // helper installs the notification filter itself, together with the
      // listener it hands to the supervisor (audit §2.9).
      const filter = buildSeccompFilter({ denied: plan.deniedSyscalls, notify: false });
      const filterPath = path.join(
        tmpdir(),
        `agent-sandbox-seccomp-${process.pid}-${Date.now().toString(36)}.bin`,
      );
      writeFileSync(filterPath, filter);
      const filterFd = openSync(filterPath, 'r');

      // Every empty-file mask needs its own descriptor: the backend reads the
      // data from the descriptor, and a descriptor that was read once is at its
      // end.
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
        dataFds.push(openSync(dataPath, 'r'));
      }

      const token = randomBytes(16).toString('hex');
      const stdio: Array<'ignore' | 'pipe' | number> = ['ignore', 'pipe', 'pipe', filterFd];
      for (const fd of dataFds) stdio.push(fd);

      const child = spawn(
        BUBBLEWRAP_BINARY,
        bubblewrapArguments(plan, spec, token, dataFds),
        {
          cwd: spec.cwd,
          env: { PATH: '/usr/bin:/bin', LANG: 'C' },
          // The filter is handed over as the child's descriptor 3; bubblewrap reads
          // the compiled program from it. The masks' data files follow.
          stdio,
        },
      );

      closeSync(filterFd);
      for (const fd of dataFds) closeSync(fd);
      rmSync(filterPath, { force: true });
      for (const dataPath of dataPaths) rmSync(dataPath, { force: true });

      return collect(child, { readinessToken: token, layers: bubblewrapLayers() });
    },
  };
}

/** The layers the bubblewrap backend establishes. */
function bubblewrapLayers(): SandboxLayers {
  return {
    // The mount namespace and the masks.
    filesystem: true,
    // The seccomp filter bubblewrap installs from the descriptor.
    seccomp: true,
    // No Landlock ruleset is ever applied: this build ships no native helper.
    pathPolicy: false,
    // The network namespace has no interface at all.
    network: true,
    // No USER_NOTIF filter is installed, so the supervisor observes nothing.
    supervisor: false,
  };
}

/**
 * Probe the bubblewrap binary.
 *
 * The **version** and the **setuid bit** are both read: a setuid bubblewrap is a
 * problem, because this design never uses a setuid helper, and a version below
 * the one that carries the CVE-2026-87766 fix is an **advisory**. This implementation
 * refuses a setuid bubblewrap outright, so it only drives the unprivileged
 * build, and for that build the version does decide whether the fix is present.
 * The advisory is a named condition on the status, not a warning that scrolls
 * past: the backend stays available, and the caller is told which advisory
 * applies.
 */
export function probeEnforcementBinary(binary: string): BackendEnforcement {
  const problems: string[] = [];
  const warnings: string[] = [];
  let setuid = false;
  let version: string | undefined;
  let advisory: SandboxAdvisory | undefined;

  try {
    const stats = statSync(binary);
    setuid = (stats.mode & 0o4000) !== 0;
  } catch {
    problems.push(`bubblewrap is not installed at ${binary}`);
  }
  if (setuid) {
    problems.push(
      `the bubblewrap binary at ${binary} carries the setuid bit; this sandbox never uses a setuid helper`,
    );
  }

  const probe = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  if (probe.status === 0 && typeof probe.stdout === 'string') {
    version = /(\d+(?:\.\d+)*)/.exec(probe.stdout)?.[1];
  }
  if (version === undefined) {
    warnings.push(`the version of the bubblewrap binary at ${binary} could not be read`);
  } else if (compareVersions(version, BUBBLEWRAP_MINIMUM_VERSION) < 0) {
    const detail =
      `bubblewrap ${version} predates ${BUBBLEWRAP_MINIMUM_VERSION}, which fixes ${BUBBLEWRAP_ADVISORY} ` +
      '(a symlink traversal through bubblewrap’s /oldroot staging mount); this implementation refuses a ' +
      'setuid bubblewrap outright and drives the unprivileged build, and there this version ' +
      'carries the vulnerability';
    warnings.push(detail);
    advisory = {
      id: BUBBLEWRAP_ADVISORY,
      fixedIn: BUBBLEWRAP_MINIMUM_VERSION,
      version,
      detail,
    };
  }

  return {
    binary,
    ...(version === undefined ? {} : { version }),
    setuid,
    warnings,
    problems,
    ...(advisory === undefined ? {} : { advisory }),
  };
}

/** The outcome of a backend's availability probe. */
export interface BackendAvailability {
  /** Whether the backend can run on this host. */
  available: boolean;
  /** Why it cannot. */
  reason?: string;
  /** What the probe could not establish. */
  warning?: string;
}

/** The runner an availability probe uses. */
export type ProbeRunner = (
  command: string,
  args: readonly string[],
) => { status: number | null; failed?: boolean };

/**
 * Probe whether the host allows an unprivileged user namespace.
 *
 * A **missing binary** and a **refused namespace** are two different facts. A
 * missing `unshare` says nothing about the host, so the probe reports it as a
 * warning and the sandbox is not refused for it; a namespace the host refuses is
 * a fact about the host, and the backend cannot run.
 */
export function probeUserNamespace(run: ProbeRunner = defaultProbeRunner): BackendAvailability {
  const probe = run('unshare', ['--user', '--map-root-user', '--mount', 'true']);
  if (probe.failed) {
    return {
      available: true,
      warning:
        'the unshare binary is not installed, so the availability of an unprivileged user namespace could not be probed',
    };
  }
  if (probe.status !== 0) {
    return {
      available: false,
      reason:
        'the host does not allow an unprivileged user namespace, so the sandbox cannot be established',
    };
  }
  return { available: true };
}

/** The default runner of an availability probe. */
function defaultProbeRunner(
  command: string,
  args: readonly string[],
): { status: number | null; failed?: boolean } {
  const probe = spawnSync(command, [...args], { stdio: 'ignore' });
  return {
    status: probe.status,
    ...(probe.error === undefined ? {} : { failed: true }),
  };
}

/** Compare two dotted version numbers. */
function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The environment of the sandboxed process.
 *
 * The environment is an **allowlist**: the caller's environment is filtered
 * against it, and the defaults fill in what the caller did not supply. The
 * proxy-socket variable is always the sandbox's own socket path.
 *
 * The **unconfined** path gets the same filtered environment, with two
 * differences: its home is the caller's own — the sandbox's `/tmp` is a private
 * tmpfs, but on the host it is a shared, world-writable directory — and it gets
 * no proxy-socket variable, because the socket is bind-mounted into the sandbox
 * only. The API key is filtered out of both.
 */
export function sandboxEnvironment(
  spec: SandboxSpec,
  mode: SandboxEnvironmentMode = 'sandboxed',
): Record<string, string> {
  const environment: Record<string, string> = { ...DEFAULT_SANDBOX_ENVIRONMENT };
  if (mode === 'unconfined') {
    environment['HOME'] = hostHome();
  }
  for (const [name, value] of Object.entries(spec.env ?? {})) {
    if (value === undefined) continue;
    if (!SANDBOX_ENVIRONMENT_ALLOWLIST.includes(name)) continue;
    if (mode === 'unconfined' && name === SANDBOX_PROXY_SOCKET_VARIABLE) continue;
    environment[name] = value;
  }
  if (mode === 'sandboxed' && spec.proxy !== undefined) {
    environment[SANDBOX_PROXY_SOCKET_VARIABLE] = SANDBOX_PROXY_SOCKET_PATH;
  }
  return environment;
}

/**
 * The home directory of the unconfined path.
 *
 * It is the caller's own: the unconfined command runs on the host, where the
 * sandbox's `/tmp` is a shared, world-writable directory, and a command that
 * reads `$HOME/.gitconfig` out of a shared directory reads a file any local
 * user can write.
 */
function hostHome(): string {
  return process.env['HOME'] ?? homedir();
}

/**
 * The bubblewrap command line for a plan.
 *
 * The working directory is the plan's: when it is the root, it is not bound (a
 * bind of the root would shadow the whole sandbox), and the sandboxed process
 * sees the sandbox's own root — the private tmpfs the system directories, the
 * scratch directory and the binds are mounted on.
 */
function bubblewrapArguments(
  plan: SandboxPlan,
  spec: SandboxSpec,
  readinessToken: string,
  dataFds: readonly number[],
): string[] {
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

  let dataIndex = 0;
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
      case 'empty-file':
        args.push('--ro-bind-data', String(FIRST_DATA_FD + dataIndex), mount.target);
        dataIndex += 1;
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
  if (dataIndex !== dataFds.length) {
    throw new Error('the plan carries a mask the backend has no data file for');
  }

  for (const [name, value] of Object.entries(sandboxEnvironment(spec))) {
    args.push('--setenv', name, value);
  }

  args.push('--chdir', plan.workingDirectory);
  args.push('--seccomp', String(FILTER_FD));
  args.push('/bin/sh', '-c', READINESS_SCRIPT, 'sandbox-ready', readinessToken, spec.command);
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

/* -------------------------------------------------------------------------- */
/* The sandbox helper                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The environment the target's `apply-seccomp` helper reads.
 *
 * **Observed** (audit §2.9): "It reads `SRT_OBSERVE_SOCK` and `SRT_ENCODED_CMD`".
 * The first names the socket the supervisor observes through; the second
 * carries the command the helper runs, encoded.
 *
 * The names are the target's own — they are the data the helper speaks to.
 */
export const SANDBOX_HELPER_ENVIRONMENT = Object.freeze(['SRT_OBSERVE_SOCK', 'SRT_ENCODED_CMD']);

/**
 * The namespaces the target's helper unshares.
 *
 * **Observed** (audit §2.9): "unshares PID/mount and user namespaces".
 */
export const SANDBOX_HELPER_NAMESPACES = Object.freeze(['pid', 'mount', 'user']);

/**
 * The `prctl` option the target's helper sets.
 *
 * **Observed** (audit §2.9): "sets `prctl` (including `PR_SET_NO_NEW_PRIVS`)".
 * `PR_SET_NO_NEW_PRIVS` is the one the audit names, and it is the one that
 * matters: without it the seccomp filter cannot be installed at all.
 */
export const PR_SET_NO_NEW_PRIVS = 38;

/**
 * `SECCOMP_FILTER_FLAG_TSYNC_ESRCH`.
 *
 * **Observed** (audit §2.9): the helper "installs a seccomp filter with
 * `SECCOMP_FILTER_FLAG_TSYNC_ESRCH`". The flag synchronises the filter into
 * every thread of the process.
 */
export const SECCOMP_FILTER_FLAG_TSYNC_ESRCH = 0x1;

/**
 * `SECCOMP_FILTER_FLAG_NEW_LISTENER`.
 *
 * **Observed** (audit §2.9): the helper "installs … a listener with
 * `SECCOMP_FILTER_FLAG_NEW_LISTENER`". The flag makes the kernel hand back a
 * listener descriptor, and the filter's `SECCOMP_RET_USER_NOTIF` actions are
 * delivered to it.
 */
export const SECCOMP_FILTER_FLAG_NEW_LISTENER = 0x8;

/**
 * `SECCOMP_IOCTL_NOTIF_RECV`.
 *
 * **Observed** (audit §2.9): the supervisor "receives notifications with ioctl
 * request `0xc0502100`".
 */
export const SECCOMP_IOCTL_NOTIF_RECV = 0xc0502100;

/**
 * `SECCOMP_IOCTL_NOTIF_SEND`.
 *
 * **Observed** (audit §2.9): the supervisor "responds with `0xc0182101`".
 */
export const SECCOMP_IOCTL_NOTIF_SEND = 0xc0182101;

/**
 * The order the target's helper does its work in.
 *
 * **Observed** (audit §2.9): "It reads `SRT_OBSERVE_SOCK` and
 * `SRT_ENCODED_CMD`, creates a socketpair, unshares PID/mount and user
 * namespaces, forks, performs private/root and `/proc` mounts, sets `prctl`
 * (including `PR_SET_NO_NEW_PRIVS`), installs a seccomp filter with
 * `SECCOMP_FILTER_FLAG_TSYNC_ESRCH` and a listener with
 * `SECCOMP_FILTER_FLAG_NEW_LISTENER`, transfers descriptors with `sendmsg`,
 * waits with `waitpid`, and finally `execvp`s."
 */
export const SANDBOX_HELPER_SEQUENCE = Object.freeze([
  'read-environment',
  'socketpair',
  'unshare',
  'fork',
  'mount-private-root',
  'mount-proc',
  'prctl',
  'seccomp-filter',
  'seccomp-listener',
  'sendmsg',
  'waitpid',
  'execvp',
]);

/** One mount the helper performs. */
export interface SandboxHelperMount {
  /** What the mount does. */
  readonly kind: 'private-root' | 'proc';
  /** Where it is mounted. */
  readonly target: string;
}

/** The plan the target's helper executes. */
export interface SandboxHelperPlan {
  /** The environment the helper read. */
  readonly environment: {
    /** The socket the supervisor observes through. */
    readonly observeSocket?: string;
    /** The encoded command the helper runs. */
    readonly encodedCommand?: string;
  };
  /** The namespaces the helper unshares. */
  readonly namespaces: readonly string[];
  /** The mounts the helper performs. */
  readonly mounts: readonly SandboxHelperMount[];
  /** The `prctl` calls the helper makes. */
  readonly prctl: readonly { readonly option: number; readonly name: string }[];
  /** The seccomp calls the helper makes. */
  readonly seccomp: {
    /** The flags the filter is installed with. */
    readonly filterFlags: number;
    /** The flags the listener is installed with. */
    readonly listenerFlags: number;
    /** The filter program the helper installs. */
    readonly filter: Buffer;
  };
  /** The descriptors the helper hands over with `sendmsg`. */
  readonly descriptors: readonly { readonly fd: number; readonly name: string }[];
  /** The order the helper does its work in. */
  readonly sequence: readonly string[];
}

/**
 * The plan the target's helper executes.
 *
 * **Observed** (audit §2.9): the helper reads two environment variables,
 * creates a socketpair, unshares three namespaces, forks, performs the
 * private/root and `/proc` mounts, sets `PR_SET_NO_NEW_PRIVS`, installs the
 * seccomp filter with `SECCOMP_FILTER_FLAG_TSYNC_ESRCH` and the listener with
 * `SECCOMP_FILTER_FLAG_NEW_LISTENER`, hands the descriptors over with
 * `sendmsg`, waits with `waitpid` and finally `execvp`s the command.
 *
 * **The mechanism differs, and the difference is named.** The target's helper
 * is a native worker that performs the namespace, mount and `prctl` work
 * itself. This implementation is a TypeScript program: the helper's
 * **decisions** are made here — the namespaces, the mounts, the `prctl` calls,
 * the seccomp flags, the filter program, the descriptors and the order — and
 * the parts that need the kernel are performed by the backend. The behaviour
 * is the target's; the mechanism is not.
 *
 * @param options The command the helper runs and the environment it reads.
 */
export function buildSandboxHelperPlan(options: {
  command: string;
  encodedCommand?: string;
  observeSocket?: string;
  deniedSyscalls?: readonly string[];
}): SandboxHelperPlan {
  const encodedCommand = options.encodedCommand ?? options.command;
  const filter = buildSeccompFilter({ denied: options.deniedSyscalls ?? DENIED_SYSCALLS });
  return {
    environment: {
      ...(options.observeSocket === undefined ? {} : { observeSocket: options.observeSocket }),
      encodedCommand,
    },
    namespaces: [...SANDBOX_HELPER_NAMESPACES],
    mounts: [
      { kind: 'private-root', target: '/' },
      { kind: 'proc', target: '/proc' },
    ],
    prctl: [{ option: PR_SET_NO_NEW_PRIVS, name: 'PR_SET_NO_NEW_PRIVS' }],
    seccomp: {
      filterFlags: SECCOMP_FILTER_FLAG_TSYNC_ESRCH,
      listenerFlags: SECCOMP_FILTER_FLAG_NEW_LISTENER,
      filter,
    },
    descriptors: [
      { fd: 0, name: 'the observe socket' },
      { fd: 3, name: 'the seccomp notification listener' },
    ],
    sequence: [...SANDBOX_HELPER_SEQUENCE],
  };
}

/* -------------------------------------------------------------------------- */
/* The notification listener                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The seccomp-notification listener.
 *
 * **Observed** (audit §2.9): the target's supervisor "allocates
 * kernel-reported notification buffers with fallbacks, opens a `pidfd`, polls
 * the listener, receives notifications with ioctl request `0xc0502100`,
 * dispatches on the notified syscall number, and responds with `0xc0182101`."
 *
 * **The mechanism differs, and the difference is named.** The target's
 * listener is a native supervisor that holds the kernel's notification
 * descriptor. This implementation's listener is an **in-process** component:
 * the kernel's `ioctl(2)` and `process_vm_readv(2)` calls live behind the
 * `NotifierChannel` seam, which a native helper implements. The *behaviour* —
 * the filter that notifies, the dispatch table, the path resolution, the
 * observe-never-deny answer and the JSON record — is the target's; the
 * mechanism is not.
 */
export interface SandboxNotificationListener {
  /**
   * Whether a listener is attached to the kernel's notifications.
   *
   * It is `true` when a channel was supplied — the channel **is** the
   * attachment, and a native helper implements it.
   */
  readonly attached: boolean;
  /** The ioctl requests the listener uses. */
  readonly requests: { readonly receive: number; readonly send: number };
  /** Serve the notifications the channel delivers, until it is closed. */
  serve(): void;
  /** The observations the listener recorded. */
  readonly observations: readonly SyscallObservation[];
}

/**
 * Create the notification listener.
 *
 * The listener owns the channel and drives the supervisor: it receives a
 * notification, hands it to the supervisor, and the supervisor answers it —
 * always with the observe-never-deny answer, because the target's supervisor
 * never denies a syscall (audit §2.9).
 *
 * Without a channel there is nothing to attach to, and the listener says so:
 * it is **not attached**, and it serves nothing.
 */
export function createSandboxNotificationListener(options: {
  channel?: NotifierChannel;
  supervisor?: SeccompSupervisor;
}): SandboxNotificationListener {
  const channel = options.channel;
  const supervisor =
    options.supervisor ??
    (channel === undefined
      ? undefined
      : createSeccompSupervisor({ channel, pathPolicy: { permits: () => true } }));
  const observations: SyscallObservation[] = [];

  return {
    attached: channel !== undefined,
    requests: { receive: SECCOMP_IOCTL_NOTIF_RECV, send: SECCOMP_IOCTL_NOTIF_SEND },
    serve(): void {
      if (channel === undefined || supervisor === undefined) return;
      for (;;) {
        const notification: SeccompNotification | null = channel.receive();
        // The channel is closed: the kernel has nothing more to say.
        if (notification === null) return;
        supervisor.handle(notification);
        for (const observation of supervisor.observations) {
          if (!observations.includes(observation)) observations.push(observation);
        }
      }
    },
    get observations(): readonly SyscallObservation[] {
      return [...observations];
    },
  };
}

/**
 * The path policy layers 1 to 3 enforce, as the supervisor sees it.
 *
 * The supervisor asks it before it continues a call, so a path the mount namespace
 * would refuse is never laundered by the observation. The policy is an
 * approximation of what the kernel enforces: it knows which paths the plan binds
 * and how, but not what the kernel refuses for a reason of its own — which is why
 * the supervisor is observability and never enforcement.
 *
 * The **mask targets** are the paths the plan masks, and they are what the
 * kernel refuses: a mask covers a whole directory, so a sibling under a masked
 * directory is refused as well. The protected paths are in the set too, because
 * a path the plan protects is never one the layers permit.
 */
export function mountPlanPathPolicy(plan: SandboxPlan): {
  permits(path: string, record: DispatchRecord): boolean;
} {
  const masked = new Set<string>([
    ...plan.masks.map((mask) => mask.target),
    ...plan.protectedPaths,
  ]);
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

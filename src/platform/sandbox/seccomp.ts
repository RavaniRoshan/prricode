/**
 * The syscall surface and the seccomp-notification supervisor.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.9 ("Native and platform
 * sandbox"), the research report §7 ("Linux sandbox primitives"), and the `CC-017`
 * milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **This module is two things, and they must not be confused.**
 *
 * 1. The **denylist** — a seccomp-BPF program the kernel enforces. It blocks
 *    `ptrace`, `process_vm_readv`, `process_vm_writev`, `io_uring_setup`,
 *    `io_uring_register`, `io_uring_enter`, `bpf`, `mount`, `pivot_root` and
 *    `setns`. This is a real boundary: the kernel refuses the call, and the
 *    sandboxed process cannot argue with it. `io_uring_setup` is the important
 *    one: the io-wq worker threads call `do_filp_open()` and the VFS directly,
 *    **without** `seccomp_run_filters()`, so a filter that does not block
 *    `io_uring_setup` can be side-stepped by any program that speaks the ring.
 * 2. The **supervisor** — a seccomp user-notification supervisor that *observes*
 *    and *emulates*. It is **not** a security boundary, and this module never
 *    pretends otherwise.
 *
 * **Why the supervisor is not a boundary.** The kernel's own UAPI header says the
 * seccomp notifier "cannot be used to implement a security policy", because the
 * target can rewrite its pointer arguments while it is blocked waiting for the
 * supervisor's response. The target's own supervisor is confirmed to be exactly
 * that: its 24-byte response struct is written three times — `memset(resp, 0, 24)`,
 * `resp.id = notif.id` and one 4-byte flags store — and `resp.error` is never
 * written, so it stays `0`, which the kernel defines as "allow the system call to
 * execute". Every intercepted call is therefore permitted and merely logged.
 *
 * **The two rules this implementation's supervisor obeys.**
 *
 *   - It never `CONTINUE`s a call whose arguments it read from target memory
 *     without a `SECCOMP_IOCTL_NOTIF_ID_VALID` re-check immediately before the
 *     use. The target may abandon the syscall through a signal handler and
 *     overwrite the frame the bytes came from, so the id is re-validated after
 *     every read and once more immediately before the response.
 *   - It never authorizes a path that layers 1–3 would deny. The path it resolved
 *     is re-checked against the kernel-enforced policy before the call is allowed
 *     to proceed, so the supervisor cannot launder a path the kernel would refuse.
 *
 * **The dispatch table is the target's shape, the decisions are this implementation's.** The
 * 27 records are `{ u64 nr; u64 name_ptr; u8 meta[8] }` in the target, and the
 * metadata bytes are **argument indices** — the path argument, the second path
 * argument, the flags/mode argument, the dirfd argument and the second dirfd
 * argument — with `0xff` meaning "this argument does not exist". This implementation keeps
 * the shape so the observation records line up with the target's, and it fills the
 * bytes the audit does not spell out from the real Linux syscall signatures.
 *
 * **The native seam.** Reading another process's memory, receiving a notification
 * and answering it are `ioctl(2)` and `process_vm_readv(2)` calls, and a Node
 * process cannot issue them. The supervisor is therefore written against the
 * `NotifierChannel` seam, and the tests drive it through that seam. The kernel's
 * own rules are enforced in the supervisor's *logic*, not in the seam.
 *
 * **The residual risk.** Every layer of the sandbox shares one kernel. A kernel
 * privilege escalation reachable from the sandbox defeats all of them, and
 * unprivileged user namespaces widen the reachable surface. Only a microVM moves
 * the boundary below the kernel.
 */

import { readlinkSync } from 'node:fs';

/** The syscall names this implementation's denylist blocks. */
export const DENIED_SYSCALLS: readonly string[] = Object.freeze([
  'ptrace',
  'process_vm_readv',
  'process_vm_writev',
  'io_uring_setup',
  'io_uring_register',
  'io_uring_enter',
  'bpf',
  'mount',
  'pivot_root',
  'setns',
]);

/**
 * The syscall numbers, on Linux x86-64.
 *
 * The numbers are the kernel's ABI and do not change. They are used for the
 * denylist filter and for the dispatch table.
 */
export const SYSCALL_NUMBERS: Readonly<Record<string, number>> = Object.freeze({
  // The denylist.
  ptrace: 101,
  process_vm_readv: 310,
  process_vm_writev: 311,
  io_uring_setup: 425,
  io_uring_register: 426,
  io_uring_enter: 427,
  bpf: 321,
  mount: 165,
  pivot_root: 155,
  setns: 308,
  // A call the denylist does not block, kept for the table's completeness and for
  // the check that a filter really refuses the call it names.
  getuid: 102,
  // The path-taking calls the supervisor observes.
  openat: 257,
  unlinkat: 263,
  mkdirat: 258,
  mknodat: 259,
  symlinkat: 266,
  linkat: 265,
  renameat: 264,
  renameat2: 316,
  fchmodat: 268,
  fchmodat2: 452,
  fchownat: 260,
  utimensat: 280,
  open: 2,
  creat: 85,
  unlink: 87,
  rmdir: 84,
  rename: 82,
  link: 86,
  symlink: 88,
  mkdir: 83,
  mknod: 133,
  truncate: 76,
  chmod: 90,
  chown: 92,
  lchown: 94,
  utime: 132,
  utimes: 235,
});

/** The `AT_FDCWD` value: the dirfd that means "the process's current directory". */
export const AT_FDCWD = -100;

/** The value a metadata byte carries when the argument does not exist. */
export const ABSENT_ARGUMENT = 0xff;

/** The `SECCOMP_USER_NOTIF_FLAG_CONTINUE` response flag. */
export const SECCOMP_USER_NOTIF_FLAG_CONTINUE = 1;

/** The `AUDIT_ARCH_X86_64` architecture value. */
export const AUDIT_ARCH_X86_64 = 0xc000003e;

/** The largest path the supervisor reads out of a target's memory. */
const MAX_PATH_BYTES = 4096;

/** The classic BPF opcodes the filter uses. */
const BPF_LD_W_ABS = 0x20;
const BPF_JEQ_K = 0x15;
const BPF_RET_K = 0x06;

/** `SECCOMP_RET_ALLOW`. */
const SECCOMP_RET_ALLOW = 0x7fff0000;

/** `SECCOMP_RET_ERRNO`. */
const SECCOMP_RET_ERRNO = 0x00050000;

/**
 * `SECCOMP_RET_USER_NOTIF`.
 *
 * The action that hands the syscall to the **notification** listener: the
 * kernel blocks the calling thread until the supervisor answers. It is only
 * usable when the filter is installed with `SECCOMP_FILTER_FLAG_NEW_LISTENER`
 * — without a listener the kernel answers `ENOSYS` — so the enforcement
 * filter never carries it.
 */
export const SECCOMP_RET_USER_NOTIF = 0x7fc00000;

/**
 * The metadata of one dispatch record.
 *
 * Every member is an **argument index** into the intercepted syscall's argument
 * list, or `ABSENT_ARGUMENT` when the call has no such argument.
 */
export interface SyscallMetadata {
  /** The index of the path argument. */
  path: number;
  /** The index of the second path argument. */
  secondPath: number;
  /** The index of the flags/mode argument. */
  flags: number;
  /** The index of the dirfd argument. */
  dirfd: number;
  /** The index of the second dirfd argument. */
  secondDirfd: number;
}

/** One record of the dispatch table. */
export interface DispatchRecord {
  /** The syscall number. */
  nr: number;
  /** The syscall name. */
  name: string;
  /** The argument indices of the call. */
  meta: SyscallMetadata;
}

/**
 * The 27 records the target's supervisor dispatches on.
 *
 * The names and the numbers are the audit's. The metadata is the audit's decoding:
 * the path argument, the second path argument, the flags/mode argument, the dirfd
 * argument and the second dirfd argument, with `0xff` for the arguments a call
 * does not have.
 */
export const OBSERVED_SYSCALLS: readonly DispatchRecord[] = Object.freeze([
  { nr: 257, name: 'openat', meta: { path: 1, secondPath: ABSENT_ARGUMENT, flags: 2, dirfd: 0, secondDirfd: ABSENT_ARGUMENT } },
  { nr: 263, name: 'unlinkat', meta: { path: 1, secondPath: ABSENT_ARGUMENT, flags: ABSENT_ARGUMENT, dirfd: 0, secondDirfd: ABSENT_ARGUMENT } },
  { nr: 258, name: 'mkdirat', meta: { path: 1, secondPath: ABSENT_ARGUMENT, flags: 2, dirfd: 0, secondDirfd: ABSENT_ARGUMENT } },
  { nr: 259, name: 'mknodat', meta: { path: 1, secondPath: ABSENT_ARGUMENT, flags: 2, dirfd: 0, secondDirfd: ABSENT_ARGUMENT } },
  { nr: 266, name: 'symlinkat', meta: { path: 2, secondPath: ABSENT_ARGUMENT, flags: ABSENT_ARGUMENT, dirfd: 1, secondDirfd: ABSENT_ARGUMENT } },
  { nr: 265, name: 'linkat', meta: { path: 1, secondPath: 3, flags: ABSENT_ARGUMENT, dirfd: 0, secondDirfd: 2 } },
  { nr: 264, name: 'renameat', meta: { path: 1, secondPath: 3, flags: ABSENT_ARGUMENT, dirfd: 0, secondDirfd: 2 } },
  { nr: 316, name: 'renameat2', meta: { path: 1, secondPath: 3, flags: ABSENT_ARGUMENT, dirfd: 0, secondDirfd: 2 } },
  { nr: 268, name: 'fchmodat', meta: { path: 1, secondPath: ABSENT_ARGUMENT, flags: 2, dirfd: 0, secondDirfd: ABSENT_ARGUMENT } },
  { nr: 452, name: 'fchmodat2', meta: { path: 1, secondPath: ABSENT_ARGUMENT, flags: 2, dirfd: 0, secondDirfd: ABSENT_ARGUMENT } },
  { nr: 260, name: 'fchownat', meta: { path: 1, secondPath: ABSENT_ARGUMENT, flags: ABSENT_ARGUMENT, dirfd: 0, secondDirfd: ABSENT_ARGUMENT } },
  { nr: 280, name: 'utimensat', meta: { path: 1, secondPath: ABSENT_ARGUMENT, flags: ABSENT_ARGUMENT, dirfd: 0, secondDirfd: ABSENT_ARGUMENT } },
  { nr: 2, name: 'open', meta: { path: 0, secondPath: ABSENT_ARGUMENT, flags: 1, dirfd: ABSENT_ARGUMENT, secondDirfd: ABSENT_ARGUMENT } },
  { nr: 85, name: 'creat', meta: { path: 0, secondPath: ABSENT_ARGUMENT, flags: 1, dirfd: ABSENT_ARGUMENT, secondDirfd: ABSENT_ARGUMENT } },
  { nr: 87, name: 'unlink', meta: { path: 0, secondPath: ABSENT_ARGUMENT, flags: ABSENT_ARGUMENT, dirfd: ABSENT_ARGUMENT, secondDirfd: ABSENT_ARGUMENT } },
  { nr: 84, name: 'rmdir', meta: { path: 0, secondPath: ABSENT_ARGUMENT, flags: ABSENT_ARGUMENT, dirfd: ABSENT_ARGUMENT, secondDirfd: ABSENT_ARGUMENT } },
  { nr: 82, name: 'rename', meta: { path: 0, secondPath: 1, flags: ABSENT_ARGUMENT, dirfd: ABSENT_ARGUMENT, secondDirfd: ABSENT_ARGUMENT } },
  { nr: 86, name: 'link', meta: { path: 0, secondPath: 1, flags: ABSENT_ARGUMENT, dirfd: ABSENT_ARGUMENT, secondDirfd: ABSENT_ARGUMENT } },
  { nr: 88, name: 'symlink', meta: { path: 1, secondPath: 0, flags: ABSENT_ARGUMENT, dirfd: ABSENT_ARGUMENT, secondDirfd: ABSENT_ARGUMENT } },
  { nr: 83, name: 'mkdir', meta: { path: 0, secondPath: ABSENT_ARGUMENT, flags: 1, dirfd: ABSENT_ARGUMENT, secondDirfd: ABSENT_ARGUMENT } },
  { nr: 133, name: 'mknod', meta: { path: 0, secondPath: ABSENT_ARGUMENT, flags: 1, dirfd: ABSENT_ARGUMENT, secondDirfd: ABSENT_ARGUMENT } },
  { nr: 76, name: 'truncate', meta: { path: 0, secondPath: ABSENT_ARGUMENT, flags: 1, dirfd: ABSENT_ARGUMENT, secondDirfd: ABSENT_ARGUMENT } },
  { nr: 90, name: 'chmod', meta: { path: 0, secondPath: ABSENT_ARGUMENT, flags: 1, dirfd: ABSENT_ARGUMENT, secondDirfd: ABSENT_ARGUMENT } },
  { nr: 92, name: 'chown', meta: { path: 0, secondPath: ABSENT_ARGUMENT, flags: 1, dirfd: ABSENT_ARGUMENT, secondDirfd: ABSENT_ARGUMENT } },
  { nr: 94, name: 'lchown', meta: { path: 0, secondPath: ABSENT_ARGUMENT, flags: 1, dirfd: ABSENT_ARGUMENT, secondDirfd: ABSENT_ARGUMENT } },
  { nr: 132, name: 'utime', meta: { path: 0, secondPath: ABSENT_ARGUMENT, flags: 1, dirfd: ABSENT_ARGUMENT, secondDirfd: ABSENT_ARGUMENT } },
  { nr: 235, name: 'utimes', meta: { path: 0, secondPath: ABSENT_ARGUMENT, flags: 1, dirfd: ABSENT_ARGUMENT, secondDirfd: ABSENT_ARGUMENT } },
]);

/** The record of a syscall, when the dispatch table has one. */
export function findDispatchRecord(nr: number): DispatchRecord | undefined {
  return OBSERVED_SYSCALLS.find((record) => record.nr === nr);
}

/**
 * Build the seccomp-BPF program.
 *
 * The program is the classic BPF the kernel expects: it loads the architecture,
 * refuses a foreign architecture, loads the syscall number and refuses every
 * syscall on the denylist with `EPERM`.
 *
 * **The notification filter.** The target's helper installs a filter that
 * **notifies**: the syscalls it observes are handed to the supervisor with
 * `SECCOMP_RET_USER_NOTIF`, and the supervisor answers them (audit §2.9). That
 * is the default here: the program hands the **27 observed syscalls** to the
 * listener and refuses the denylist with `EPERM`.
 *
 * The action is only usable with a listener attached — the kernel answers
 * `ENOSYS` for a notified syscall when there is none — so the **enforcement**
 * filter (the one the launcher installs through the backend) is built with
 * `notify: false`.
 *
 * The result is the raw instruction array — eight bytes per instruction — in the
 * form `seccomp(2)` and bubblewrap's `--seccomp` read.
 */
export function buildSeccompFilter(options: SeccompFilterOptions = {}): Buffer {
  const denied = options.denied ?? DENIED_SYSCALLS;
  const architecture = options.architecture ?? AUDIT_ARCH_X86_64;
  const errno = options.errno ?? 1; // EPERM
  const notify = options.notify !== false;
  const notified = options.notified ?? OBSERVED_SYSCALLS.map((record) => record.name);

  const instructions: number[][] = [
    [BPF_LD_W_ABS, 0, 0, 4],
    [BPF_JEQ_K, 1, 0, architecture],
    [BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | (errno & 0xffff)],
    [BPF_LD_W_ABS, 0, 0, 0],
  ];
  // The notified syscalls come first: the target's filter hands them to the
  // listener, and the listener — not the filter — decides what happens next.
  if (notify) {
    for (const name of notified) {
      const nr = syscallNumber(name);
      if (nr === undefined) continue;
      instructions.push([BPF_JEQ_K, 0, 1, nr]);
      instructions.push([BPF_RET_K, 0, 0, SECCOMP_RET_USER_NOTIF]);
    }
  }
  for (const name of denied) {
    const nr = syscallNumber(name);
    if (nr === undefined) continue;
    instructions.push([BPF_JEQ_K, 0, 1, nr]);
    instructions.push([BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | (errno & 0xffff)]);
  }
  instructions.push([BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW]);

  const buffer = Buffer.alloc(instructions.length * 8);
  instructions.forEach((instruction, index) => {
    const offset = index * 8;
    buffer.writeUInt16LE(instruction[0] ?? 0, offset);
    buffer.writeUInt8(instruction[1] ?? 0, offset + 2);
    buffer.writeUInt8(instruction[2] ?? 0, offset + 3);
    buffer.writeUInt32LE((instruction[3] ?? 0) >>> 0, offset + 4);
  });
  return buffer;
}

/** The options of the filter builder. */
export interface SeccompFilterOptions {
  /** The syscall names to block. */
  denied?: readonly string[];
  /** The architecture the filter is compiled for. */
  architecture?: number;
  /**
   * The errno a blocked syscall returns.
   *
   * The option applies to **every** call the filter refuses: the denied
   * syscalls and the foreign-architecture branch alike. The default is `EPERM`.
   */
  errno?: number;
  /**
   * Whether the filter hands the observed syscalls to the **notification
   * listener**.
   *
   * The default is `true`: the target's helper installs a filter that
   * notifies. The **enforcement** filter — the one the launcher installs
   * through the backend, where no listener is attached — is built with
   * `notify: false`, because a notified syscall without a listener answers
   * `ENOSYS`.
   */
  notify?: boolean;
  /**
   * The syscall names the filter hands to the listener.
   *
   * The default is the target's 27 observed syscalls.
   */
  notified?: readonly string[];
}

/** The number of a syscall, when the table has one. */
export function syscallNumber(name: string): number | undefined {
  if (!Object.hasOwn(SYSCALL_NUMBERS, name)) return undefined;
  return SYSCALL_NUMBERS[name];
}

/** A notification the kernel delivered to the supervisor. */
export interface SeccompNotification {
  /** The notification id. */
  id: bigint;
  /** The pid of the blocked process. */
  pid: number;
  /** The syscall number that was blocked. */
  nr: number;
  /** The syscall arguments. */
  args: readonly bigint[];
}

/** A response the supervisor sends back to the kernel. */
export interface SeccompResponse {
  /** The notification the response answers. */
  id: bigint;
  /** The negative errno the target sees; `0` means "the call may execute". */
  error: number;
  /** The response flags. */
  flags: number;
  /** The value the target sees when the supervisor emulates the call. */
  val: bigint;
}

/**
 * The channel to the kernel.
 *
 * Every member is an `ioctl(2)` or `process_vm_readv(2)` the kernel offers, and
 * every member is a seam a native helper implements.
 */
export interface NotifierChannel {
  /** Receive the next notification, or `null` when the listener is closed. */
  receive(): SeccompNotification | null;
  /** Send a response for a notification. */
  respond(response: SeccompResponse): void;
  /** `SECCOMP_IOCTL_NOTIF_ID_VALID`: is the notification still live? */
  isIdValid(id: bigint): boolean;
  /** Read a run of bytes out of the target's memory. */
  readMemory(pid: number, address: bigint, length: number): Buffer | null;
  /** The absolute path of the target's current directory, or of an open directory. */
  resolveTargetPath(pid: number, dirFd: number): string | undefined;
}

/** One observation the supervisor recorded. */
export interface SyscallObservation {
  /** The syscall number. */
  nr: number;
  /** The syscall name. */
  syscall: string;
  /** The pid of the process that made the call. */
  pid: number;
  /** The resolved path, when the call had one. */
  path?: string;
  /** The resolved second path, when the call had one. */
  secondPath?: string;
  /** The encoded command the target reports, when it reports one. */
  encodedCommand?: string;
}

/** The path policy of layers 1 to 3. */
export interface SupervisorPathPolicy {
  /** Whether the kernel-enforced layers permit this path. */
  permits(path: string, record: DispatchRecord): boolean;
}

/** The options of the supervisor. */
export interface SeccompSupervisorOptions {
  /** The channel to the kernel. */
  channel: NotifierChannel;
  /** The path policy of layers 1 to 3; without one the supervisor only observes. */
  pathPolicy?: SupervisorPathPolicy;
  /** Where the observations go. */
  onObservation?: (observation: SyscallObservation) => void;
}

/** The supervisor. */
export interface SeccompSupervisor {
  /** Handle one notification. */
  handle(notification: SeccompNotification): void;
  /** The observations the supervisor recorded. */
  readonly observations: readonly SyscallObservation[];
}

/**
 * Create the supervisor.
 *
 * The supervisor **observes** and **emulates**. It never denies a call on policy
 * grounds: the boundary is the namespace, mount and `PR_SET_NO_NEW_PRIVS` isolation
 * that the launcher establishes, and the kernel-enforced layers underneath it.
 */
export function createSeccompSupervisor(options: SeccompSupervisorOptions): SeccompSupervisor {
  const { channel } = options;
  const observations: SyscallObservation[] = [];

  /**
   * Read an argument out of the target's memory.
   *
   * The read is followed **immediately** by the `ID_VALID` re-check: the target may
   * have abandoned the call and overwritten the frame the bytes came from, so the
   * bytes are only usable while the notification is still live.
   */
  const readArgument = (
    notification: SeccompNotification,
    index: number,
  ): string | undefined | null => {
    if (index === ABSENT_ARGUMENT) return undefined;
    const address = notification.args[index];
    if (address === undefined) return undefined;
    const bytes = channel.readMemory(notification.pid, address, MAX_PATH_BYTES);
    if (!channel.isIdValid(notification.id)) return null;
    if (bytes === null) return undefined;
    const end = bytes.indexOf(0);
    const raw = end === -1 ? bytes : bytes.subarray(0, end);
    return raw.toString('utf8');
  };

  /** Read an integer argument, such as a dirfd. */
  const readIntegerArgument = (
    notification: SeccompNotification,
    index: number,
  ): number | undefined | null => {
    if (index === ABSENT_ARGUMENT) return undefined;
    const address = notification.args[index];
    if (address === undefined) return undefined;
    const bytes = channel.readMemory(notification.pid, address, 8);
    if (!channel.isIdValid(notification.id)) return null;
    if (bytes === null || bytes.length < 8) return undefined;
    return Number(bytes.readBigInt64LE(0));
  };

  /** Resolve a path against the target's current directory or an open directory. */
  const resolve = (
    notification: SeccompNotification,
    record: DispatchRecord,
    raw: string | undefined,
    dirFdIndex: number,
  ): string | undefined => {
    if (raw === undefined) return undefined;
    if (raw.startsWith('/')) return raw;
    const dirFd = readIntegerArgument(notification, dirFdIndex);
    if (dirFd === null) return undefined;
    const base = channel.resolveTargetPath(notification.pid, dirFd ?? AT_FDCWD);
    if (base === undefined) return raw;
    return `${base.replace(/\/$/, '')}/${raw}`;
  };

  const handle = (notification: SeccompNotification): void => {
    const record = findDispatchRecord(notification.nr);
    if (record === undefined) {
      // Not a call the supervisor observes. Nothing was read from the target's
      // memory, so there is nothing to re-validate.
      channel.respond({ id: notification.id, error: 0, flags: SECCOMP_USER_NOTIF_FLAG_CONTINUE, val: 0n });
      return;
    }

    const rawPath = readArgument(notification, record.meta.path);
    if (rawPath === null) {
      // The notification is stale: the bytes that were read are not usable, so the
      // call is not continued. The kernel has already discarded the notification.
      return;
    }
    const rawSecondPath = readArgument(notification, record.meta.secondPath);
    if (rawSecondPath === null) return;

    const path = resolve(notification, record, rawPath, record.meta.dirfd);
    const secondPath = resolve(notification, record, rawSecondPath, record.meta.secondDirfd);

    const observation: SyscallObservation = {
      nr: notification.nr,
      syscall: record.name,
      pid: notification.pid,
      ...(path === undefined ? {} : { path }),
      ...(secondPath === undefined ? {} : { secondPath }),
    };
    observations.push(observation);
    options.onObservation?.(observation);

    if (path !== undefined && options.pathPolicy !== undefined) {
      if (!options.pathPolicy.permits(path, record)) {
        // Layers 1 to 3 would refuse this path. The supervisor does not authorize
        // it: the call is not continued, and the kernel-enforced layer remains the
        // boundary that decides.
        channel.respond({ id: notification.id, error: -1, flags: 0, val: 0n });
        return;
      }
    }

    // The arguments came out of the target's memory, so the id is re-validated one
    // last time immediately before the response.
    if (!channel.isIdValid(notification.id)) return;

    channel.respond({ id: notification.id, error: 0, flags: SECCOMP_USER_NOTIF_FLAG_CONTINUE, val: 0n });
  };

  return { handle, observations };
}

/**
 * Format an observation as the JSON line the target writes.
 *
 * The target emits `{"nr":%d,"syscall":"%s","pid":%d,"path":"%s"}`, with the same
 * added `encodedCommand` member when an encoded command is present, and with `\`
 * and `"` backslash-escaped and the control bytes rendered as `\uXXXX`.
 *
 * **This implementation's divergence.** This implementation adds a `secondPath` member when the
 * intercepted call carries a second path — `rename`, `link`, `renameat`,
 * `linkat` and `renameat2` do. The target's line carries only the four members
 * above, so the extra member is a implementation choice and is marked here.
 */
export function formatObservation(observation: SyscallObservation): string {
  const members: string[] = [
    `"nr":${observation.nr}`,
    `"syscall":"${escapeJson(observation.syscall)}"`,
    `"pid":${observation.pid}`,
  ];
  if (observation.path !== undefined) members.push(`"path":"${escapeJson(observation.path)}"`);
  if (observation.secondPath !== undefined) {
    members.push(`"secondPath":"${escapeJson(observation.secondPath)}"`);
  }
  if (observation.encodedCommand !== undefined) {
    members.push(`"encodedCommand":"${escapeJson(observation.encodedCommand)}"`);
  }
  return `{${members.join(',')}}`;
}

/** Escape a string for a JSON string literal, the way the target escapes it. */
function escapeJson(text: string): string {
  let escaped = '';
  for (const character of text) {
    if (character === '\\') {
      escaped += '\\\\';
      continue;
    }
    if (character === '"') {
      escaped += '\\"';
      continue;
    }
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      escaped += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    escaped += character;
  }
  return escaped;
}

/**
 * Resolve the target's current directory, or one of its open directories.
 *
 * The supervisor resolves a relative path against the target: `"<pid>/cwd"` when the
 * dirfd is `AT_FDCWD` or absent, and `"<pid>/fd/<dirfd>"` otherwise.
 */
export function resolveTargetPathFromProc(pid: number, dirFd: number): string | undefined {
  const link =
    dirFd === AT_FDCWD ? `/proc/${pid}/cwd` : `/proc/${pid}/fd/${dirFd}`;
  try {
    const resolved = readlinkSync(link);
    return resolved.startsWith('/') ? resolved : undefined;
  } catch {
    return undefined;
  }
}

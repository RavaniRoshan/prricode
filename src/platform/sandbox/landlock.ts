/**
 * The path-policy layer: Landlock.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.9, the research report
 * §7 ("Linux sandbox primitives"), and the `CC-017` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **What Landlock is for.** Landlock is an unprivileged, self-restricting,
 * stackable LSM. Its rules bind to an `O_PATH` **descriptor**, not to a path
 * string, so a later rename, a symlink swap or a bind mount cannot walk a rule to
 * a different object. That is exactly the property this implementation needs against the
 * symlink-TOCTOU class: the rule follows the inode it was granted for, not the
 * name it was granted under.
 *
 * **The ABI is feature-detected, never assumed.** The reference host — WSL2, kernel
 * 6.6 — reports **ABI 3**: the full filesystem right set including
 * `LANDLOCK_ACCESS_FS_TRUNCATE`, but **no TCP/UDP network rights** (ABI 4), **no
 * `LANDLOCK_ACCESS_FS_IOCTL_DEV`** (ABI 5) and **no `LANDLOCK_SCOPE_*`** (ABI 6).
 * The network policy therefore comes from the proxy layer and never from Landlock,
 * and this module reports the reduced protection rather than pretending the full
 * set is in force.
 *
 * **The native seam.** `landlock_create_ruleset(2)`, `landlock_add_rule(2)` and
 * `landlock_restrict_self(2)` are raw syscalls, and a Node process cannot issue
 * them. The layer is therefore written against the `LandlockSyscalls` seam. This
 * build ships no native helper, so the default seam reports that Landlock is
 * unavailable and the launcher records the reduced protection: the path policy is
 * then enforced by the **mount namespace** instead, which is kernel-enforced too.
 *
 * **The residual risk.** Landlock is an LSM on the same kernel as everything else
 * in the sandbox. A kernel privilege escalation reachable from the sandbox defeats
 * it, and unprivileged user namespaces widen the reachable surface. Only a microVM
 * moves the boundary below the kernel.
 */

import { closeSync, openSync } from 'node:fs';

/** `LANDLOCK_CREATE_RULESET_VERSION`: ask the kernel which ABI it implements. */
export const LANDLOCK_CREATE_RULESET_VERSION = 1;

/** `LANDLOCK_RULE_PATH_BENEATH`: the only rule type this implementation uses. */
export const LANDLOCK_RULE_PATH_BENEATH = 1;

/** `O_PATH`: open a descriptor that refers to an object without granting access. */
export const O_PATH = 0o10000000;

/** `LANDLOCK_ACCESS_FS_EXECUTE`. */
export const LANDLOCK_ACCESS_FS_EXECUTE = 1n << 0n;
/** `LANDLOCK_ACCESS_FS_WRITE_FILE`. */
export const LANDLOCK_ACCESS_FS_WRITE_FILE = 1n << 1n;
/** `LANDLOCK_ACCESS_FS_READ_FILE`. */
export const LANDLOCK_ACCESS_FS_READ_FILE = 1n << 2n;
/** `LANDLOCK_ACCESS_FS_READ_DIR`. */
export const LANDLOCK_ACCESS_FS_READ_DIR = 1n << 3n;
/** `LANDLOCK_ACCESS_FS_REMOVE_DIR`. */
export const LANDLOCK_ACCESS_FS_REMOVE_DIR = 1n << 4n;
/** `LANDLOCK_ACCESS_FS_REMOVE_FILE`. */
export const LANDLOCK_ACCESS_FS_REMOVE_FILE = 1n << 5n;
/** `LANDLOCK_ACCESS_FS_MAKE_CHAR`. */
export const LANDLOCK_ACCESS_FS_MAKE_CHAR = 1n << 6n;
/** `LANDLOCK_ACCESS_FS_MAKE_DIR`. */
export const LANDLOCK_ACCESS_FS_MAKE_DIR = 1n << 7n;
/** `LANDLOCK_ACCESS_FS_MAKE_REG`. */
export const LANDLOCK_ACCESS_FS_MAKE_REG = 1n << 8n;
/** `LANDLOCK_ACCESS_FS_MAKE_SOCK`. */
export const LANDLOCK_ACCESS_FS_MAKE_SOCK = 1n << 9n;
/** `LANDLOCK_ACCESS_FS_MAKE_FIFO`. */
export const LANDLOCK_ACCESS_FS_MAKE_FIFO = 1n << 10n;
/** `LANDLOCK_ACCESS_FS_MAKE_BLOCK`. */
export const LANDLOCK_ACCESS_FS_MAKE_BLOCK = 1n << 11n;
/** `LANDLOCK_ACCESS_FS_MAKE_SYM`. */
export const LANDLOCK_ACCESS_FS_MAKE_SYM = 1n << 12n;
/** `LANDLOCK_ACCESS_FS_REFER`: rename or link across directories. ABI 2. */
export const LANDLOCK_ACCESS_FS_REFER = 1n << 13n;
/** `LANDLOCK_ACCESS_FS_TRUNCATE`. ABI 2. */
export const LANDLOCK_ACCESS_FS_TRUNCATE = 1n << 14n;
/** `LANDLOCK_ACCESS_FS_IOCTL_DEV`. ABI 5. */
export const LANDLOCK_ACCESS_FS_IOCTL_DEV = 1n << 15n;

/** The rights the ABI 1 filesystem rule set carries. */
const BASE_FILESYSTEM_RIGHTS =
  LANDLOCK_ACCESS_FS_EXECUTE |
  LANDLOCK_ACCESS_FS_WRITE_FILE |
  LANDLOCK_ACCESS_FS_READ_FILE |
  LANDLOCK_ACCESS_FS_READ_DIR |
  LANDLOCK_ACCESS_FS_REMOVE_DIR |
  LANDLOCK_ACCESS_FS_REMOVE_FILE |
  LANDLOCK_ACCESS_FS_MAKE_CHAR |
  LANDLOCK_ACCESS_FS_MAKE_DIR |
  LANDLOCK_ACCESS_FS_MAKE_REG |
  LANDLOCK_ACCESS_FS_MAKE_SOCK |
  LANDLOCK_ACCESS_FS_MAKE_FIFO |
  LANDLOCK_ACCESS_FS_MAKE_BLOCK |
  LANDLOCK_ACCESS_FS_MAKE_SYM;

/** The rights a read-only rule grants. */
export const LANDLOCK_READ_ONLY_RIGHTS =
  LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;

/** The rights a read-write rule grants. */
export const LANDLOCK_READ_WRITE_RIGHTS =
  LANDLOCK_READ_ONLY_RIGHTS |
  LANDLOCK_ACCESS_FS_WRITE_FILE |
  LANDLOCK_ACCESS_FS_REMOVE_DIR |
  LANDLOCK_ACCESS_FS_REMOVE_FILE |
  LANDLOCK_ACCESS_FS_MAKE_CHAR |
  LANDLOCK_ACCESS_FS_MAKE_DIR |
  LANDLOCK_ACCESS_FS_MAKE_REG |
  LANDLOCK_ACCESS_FS_MAKE_SOCK |
  LANDLOCK_ACCESS_FS_MAKE_FIFO |
  LANDLOCK_ACCESS_FS_MAKE_BLOCK |
  LANDLOCK_ACCESS_FS_MAKE_SYM |
  LANDLOCK_ACCESS_FS_REFER |
  LANDLOCK_ACCESS_FS_TRUNCATE;

/** The ABI this implementation wants: the rights `REFER` and `TRUNCATE` arrived with it. */
export const LANDLOCK_REQUIRED_ABI = 3;

/**
 * The filesystem rights the kernel's ABI grants.
 *
 * The ABI 3 filesystem right set is complete; the network rights arrived with ABI
 * 4 and live in a separate field, `LANDLOCK_ACCESS_FS_IOCTL_DEV` with ABI 5 and the
 * `LANDLOCK_SCOPE_*` rights with ABI 6.
 */
export function filesystemRightsForAbi(abi: number): bigint {
  let rights = BASE_FILESYSTEM_RIGHTS;
  if (abi >= 2) rights |= LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE;
  if (abi >= 5) rights |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
  return rights;
}

/** The syscall seam the layer needs. */
export interface LandlockSyscalls {
  /**
   * `landlock_create_ruleset(2)`.
   *
   * With no attributes and the `VERSION` flag the kernel answers with the ABI it
   * implements; a negative value is `-errno`.
   */
  createRuleset(attrs: { handledAccessFs: bigint } | null, size: number, flags: number): number;
  /**
   * `landlock_add_rule(2)`.
   *
   * The rule carries the `O_PATH` descriptor of the object the rule binds to.
   */
  addRule(
    rulesetFd: number,
    ruleType: number,
    rule: { pathFd: number; rights: bigint },
    flags: number,
  ): number;
  /** `landlock_restrict_self(2)`. */
  restrictSelf(rulesetFd: number, flags: number): number;
}

/**
 * The seam this build ships.
 *
 * The three calls are raw syscalls, and a Node process cannot issue them, so the
 * default seam reports `ENOSYS`. A build that ships a native helper replaces this
 * with the real calls.
 */
export function defaultLandlockSyscalls(): LandlockSyscalls {
  const unavailable = (): number => -38; // ENOSYS
  return {
    createRuleset: unavailable,
    addRule: unavailable,
    restrictSelf: unavailable,
  };
}

/** What the layer can do on this host. */
export interface LandlockStatus {
  /** Whether the kernel implements Landlock at all. */
  available: boolean;
  /** The ABI the kernel reports; `0` when Landlock is missing. */
  abi: number;
  /** The ABI this implementation wants. */
  requiredAbi: number;
  /** The reasons the protection is reduced; empty when the full set is in force. */
  reducedProtection: readonly string[];
  /** Whether the kernel grants the TCP/UDP network rights (ABI 4). */
  networkRights: boolean;
  /** Whether the kernel grants the `LANDLOCK_ACCESS_FS_IOCTL_DEV` right (ABI 5). */
  ioctlDevRights: boolean;
  /** Whether the kernel grants the `LANDLOCK_SCOPE_*` rights (ABI 6). */
  scopeRights: boolean;
  /** Why Landlock is missing or reduced. */
  reason?: string;
}

/**
 * Feature-detect Landlock.
 *
 * The kernel is asked which ABI it implements; nothing is assumed. A kernel that
 * does not implement Landlock, or one whose ABI is below the level this implementation
 * wants, yields a status that says so.
 */
export function detectLandlock(syscalls: LandlockSyscalls = defaultLandlockSyscalls()): LandlockStatus {
  let result: number;
  try {
    result = syscalls.createRuleset(null, 0, LANDLOCK_CREATE_RULESET_VERSION);
  } catch (error) {
    return unavailableStatus(`landlock_create_ruleset threw: ${describeError(error)}`);
  }
  if (result < 0) {
    return unavailableStatus(
      `landlock_create_ruleset returned ${result} (${errnoName(-result)}): the kernel does not implement Landlock`,
    );
  }

  const abi = result;
  const reducedProtection: string[] = [];
  if (abi < 2) {
    reducedProtection.push(
      `Landlock ABI ${abi} cannot restrict a rename or a hard link across directories (REFER) nor a truncation (TRUNCATE); this implementation wants ABI 2.`,
    );
  }
  if (abi < LANDLOCK_REQUIRED_ABI) {
    reducedProtection.push(
      `Landlock ABI ${abi} is below the ABI ${LANDLOCK_REQUIRED_ABI} this implementation wants.`,
    );
  }
  if (abi < 4) {
    reducedProtection.push(
      'the kernel grants no TCP/UDP network rights (Landlock ABI 4), so the network policy is enforced by the proxy layer and never by Landlock.',
    );
  }
  if (abi < 5) {
    reducedProtection.push(
      'the kernel grants no LANDLOCK_ACCESS_FS_IOCTL_DEV right (Landlock ABI 5).',
    );
  }
  if (abi < 6) {
    reducedProtection.push('the kernel grants no LANDLOCK_SCOPE_* right (Landlock ABI 6).');
  }

  return {
    available: true,
    abi,
    requiredAbi: LANDLOCK_REQUIRED_ABI,
    reducedProtection,
    networkRights: abi >= 4,
    ioctlDevRights: abi >= 5,
    scopeRights: abi >= 6,
  };
}

/** A status for a host without Landlock. */
function unavailableStatus(reason: string): LandlockStatus {
  return {
    available: false,
    abi: 0,
    requiredAbi: LANDLOCK_REQUIRED_ABI,
    reducedProtection: [
      'Landlock is not available on this host, so the path policy is enforced by the mount namespace instead.',
    ],
    networkRights: false,
    ioctlDevRights: false,
    scopeRights: false,
    reason,
  };
}

/** One rule, bound to a descriptor. */
export interface LandlockRuleBinding {
  /** The path the rule was created for. */
  path: string;
  /** The `O_PATH` descriptor the rule is bound to. */
  fd: number;
  /** The rights the rule grants. */
  rights: bigint;
}

/** The options of the ruleset builder. */
export interface LandlockRulesetOptions {
  /** The paths that may be read. */
  readOnlyPaths?: readonly string[];
  /** The paths that may be read and written. */
  readWritePaths?: readonly string[];
  /** The rights a read-only rule grants. */
  readOnlyRights?: bigint;
  /** The rights a read-write rule grants. */
  readWriteRights?: bigint;
  /** The syscall seam. */
  syscalls?: LandlockSyscalls;
}

/** The ruleset the layer builds. */
export interface LandlockRuleset {
  /** What the host can do. */
  status: LandlockStatus;
  /** The rules, each bound to a descriptor. */
  bindings: readonly LandlockRuleBinding[];
  /** The paths a rule could not be created for. */
  skipped: readonly string[];
  /** Restrict the calling process with the ruleset. */
  apply(): void;
  /** Close the descriptors the rules are bound to. */
  close(): void;
}

/**
 * Build the ruleset.
 *
 * Every rule binds to an `O_PATH` descriptor of the object the rule is for, so a
 * rename or a symlink swap cannot walk the rule to another object. The descriptors
 * are opened **before** the ruleset is applied, because a descriptor opened after
 * the restriction carries the restricted rights.
 */
export function buildLandlockRuleset(options: LandlockRulesetOptions): LandlockRuleset {
  const syscalls = options.syscalls ?? defaultLandlockSyscalls();
  const status = detectLandlock(syscalls);
  if (!status.available) {
    return {
      status,
      bindings: [],
      skipped: [],
      apply: () => undefined,
      close: () => undefined,
    };
  }

  const readOnlyRights = options.readOnlyRights ?? LANDLOCK_READ_ONLY_RIGHTS;
  const readWriteRights = options.readWriteRights ?? LANDLOCK_READ_WRITE_RIGHTS;
  const available = filesystemRightsForAbi(status.abi);

  const bindings: LandlockRuleBinding[] = [];
  const skipped: string[] = [];
  const rulesetFd = syscalls.createRuleset(
    { handledAccessFs: available & (readOnlyRights | readWriteRights) },
    8,
    0,
  );
  if (rulesetFd < 0) {
    return {
      status: {
        ...status,
        reducedProtection: [
          ...status.reducedProtection,
          `landlock_create_ruleset failed with ${rulesetFd} (${errnoName(-rulesetFd)}).`,
        ],
      },
      bindings: [],
      skipped: [],
      apply: () => undefined,
      close: () => undefined,
    };
  }

  const add = (rulePath: string, rights: bigint): void => {
    let fd: number;
    try {
      fd = openSync(rulePath, O_PATH);
    } catch {
      // The path cannot be bound, so the rule cannot be created for it. The path
      // is recorded: a rule that is silently missing is a rule that is silently
      // absent from the protection.
      skipped.push(rulePath);
      return;
    }
    const granted = rights & available;
    syscalls.addRule(rulesetFd, LANDLOCK_RULE_PATH_BENEATH, { pathFd: fd, rights: granted }, 0);
    bindings.push({ path: rulePath, fd, rights: granted });
  };

  for (const rulePath of options.readOnlyPaths ?? []) add(rulePath, readOnlyRights);
  for (const rulePath of options.readWritePaths ?? []) add(rulePath, readWriteRights);

  return {
    status,
    bindings,
    skipped,
    apply: () => {
      syscalls.restrictSelf(rulesetFd, 0);
    },
    close: () => {
      for (const binding of bindings) {
        try {
          closeSync(binding.fd);
        } catch {
          // The descriptor is already gone; nothing to do.
        }
      }
    },
  };
}

/** The name of an errno. */
function errnoName(errno: number): string {
  switch (errno) {
    case 1:
      return 'EPERM';
    case 12:
      return 'ENOMEM';
    case 22:
      return 'EINVAL';
    case 38:
      return 'ENOSYS';
    case 95:
      return 'ENOTSUP';
    default:
      return `errno ${errno}`;
  }
}

/** Describe a thrown value. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The platform sandbox: the policy, the launcher, the Landlock layer, the seccomp
 * supervisor and the network proxy.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.7 (the policy tier) and
 * §2.9 ("Native and platform sandbox"), and the `CC-017` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * The tests follow the plan's steps in order:
 *
 *   - step 1 — the policy: the decisions and the target's exact reason strings;
 *   - step 5 — the launcher: the refusal when the sandbox is required and missing,
 *     and the tmpfs mask over a protected path that does not exist at startup
 *     (the CVE-2026-25725 class);
 *   - step 8 — Landlock: the rule that is bound to an object rather than to a name,
 *     and the reduced protection the launcher reports when the ABI is too low;
 *   - step 11 — the supervisor: the `SECCOMP_IOCTL_NOTIF_ID_VALID` re-check and the
 *     refusal to authorize a path that layers 1–3 would deny;
 *   - step 13 — the proxy: the refusal of loopback, link-local and cloud-metadata
 *     addresses, and of a host that is not in the allowlist.
 */

import {
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SANDBOX_POLICY,
  SANDBOX_REASONS,
  evaluateSandbox,
  matchingExclusions,
  parseSandboxPolicy,
  readSandboxPolicy,
  type SandboxPolicy,
} from '../../src/platform/sandbox/policy.js';
import {
  ABSENT_ARGUMENT,
  DENIED_SYSCALLS,
  OBSERVED_SYSCALLS,
  SECCOMP_USER_NOTIF_FLAG_CONTINUE,
  SYSCALL_NUMBERS,
  buildSeccompFilter,
  createSeccompSupervisor,
  formatObservation,
  resolveTargetPathFromProc,
  type NotifierChannel,
  type SeccompNotification,
  type SeccompResponse,
} from '../../src/platform/sandbox/seccomp.js';
import {
  LANDLOCK_ACCESS_FS_READ_FILE,
  LANDLOCK_ACCESS_FS_WRITE_FILE,
  buildLandlockRuleset,
  detectLandlock,
  type LandlockSyscalls,
} from '../../src/platform/sandbox/landlock.js';
import {
  classifyAddress,
  createSandboxProxy,
  evaluateProxyTarget,
  isBlockedAddress,
} from '../../src/platform/sandbox/proxy.js';
import {
  SANDBOX_PROXY_SOCKET_PATH,
  SANDBOX_PROXY_SOCKET_VARIABLE,
  SandboxRefusedError,
  buildSandboxPlan,
  launchSandbox,
  planSupervisor,
  type SandboxBackend,
  type SandboxProcess,
} from '../../src/platform/sandbox/launcher.js';

/** A policy with the defaults, plus the overrides a test needs. */
function policy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return { ...DEFAULT_SANDBOX_POLICY, ...overrides };
}

/** The temporary directories a test creates, removed when the test ends. */
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'implementation-sandbox-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

/** Whether this host can run the bubblewrap backend the launcher uses. */
const bubblewrapAvailable = existsSync('/usr/bin/bwrap');

/** A backend that is never available, so the launcher's refusal path is testable. */
const unavailableBackend: SandboxBackend = {
  name: 'test-unavailable',
  async isAvailable() {
    return { available: false, reason: 'the test backend is not available' };
  },
  async start(): Promise<SandboxProcess> {
    throw new Error('the test backend must not start');
  },
};

// --- step 1: the policy -------------------------------------------------------

describe('CC-017 step 1 — the sandbox policy', () => {
  it('denies with the reason naming the platform when enabledPlatforms excludes it', () => {
    const result = evaluateSandbox(policy({ enabledPlatforms: ['darwin'] }), 'linux', 'ls -la');
    expect(result.decision).toBe('deny');
    expect(result.reason).toBe('sandbox.enabledPlatforms excludes linux');
    expect(result.reason).toBe(SANDBOX_REASONS.platformExcluded('linux'));
  });

  it('denies when the sandbox is disabled', () => {
    const result = evaluateSandbox(policy({ enabled: false }), 'linux', 'ls -la');
    expect(result.decision).toBe('deny');
    expect(result.reason).toBe('sandbox.enabled is false');
  });

  it('runs the shell unconfined, and says so, when failIfUnavailable is false', () => {
    const result = evaluateSandbox(policy({ failIfUnavailable: false }), 'linux', 'ls -la', 'unavailable');
    expect(result.decision).toBe('unconfined');
    expect(result.reason).toBe(
      'sandbox.failIfUnavailable is false (a missing backend would run the shell unconfined)',
    );
  });

  it('denies when the backend is missing and failIfUnavailable is true', () => {
    const result = evaluateSandbox(policy({ failIfUnavailable: true }), 'linux', 'ls -la', 'unavailable');
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/failIfUnavailable/);
  });

  it('runs an excluded command unconfined when allowUnsandboxedCommands is true', () => {
    const result = evaluateSandbox(
      policy({ allowUnsandboxedCommands: true, excludedCommands: ['git status'] }),
      'linux',
      'git status',
    );
    expect(result.decision).toBe('unconfined');
    expect(result.reason).toBe('sandbox.allowUnsandboxedCommands is true');
    expect(result.exemptions).toEqual(['git status']);
  });

  it('sandboxes a command that does not match an exclusion', () => {
    const result = evaluateSandbox(
      policy({ allowUnsandboxedCommands: true, excludedCommands: ['git status'] }),
      'linux',
      'ls -la',
    );
    expect(result.decision).toBe('allow');
    expect(result.reason).toBeUndefined();
  });

  it('does not let an excluded command exempt a compound command that has an unexempt part', () => {
    const result = evaluateSandbox(
      policy({ allowUnsandboxedCommands: true, excludedCommands: ['git status'] }),
      'linux',
      'git status && rm -rf /tmp/whatever',
    );
    expect(result.decision).toBe('allow');
  });

  it('reports every exclusion a command matches', () => {
    expect(matchingExclusions('git status', ['git status', 'git status'])).toEqual(['git status']);
    expect(matchingExclusions('git status', ['git *'])).toEqual(['git *']);
    expect(matchingExclusions('ls -la', ['git status'])).toEqual([]);
    expect(matchingExclusions('npm run build', ['npm run build -- --watch'])).toEqual([]);
  });

  it('reads the policy out of a settings document and out of a bare block', () => {
    expect(
      readSandboxPolicy({
        sandbox: {
          enabled: false,
          enabledPlatforms: ['darwin'],
          failIfUnavailable: false,
          allowUnsandboxedCommands: true,
          excludedCommands: ['git status'],
        },
      }),
    ).toEqual({
      enabled: false,
      enabledPlatforms: ['darwin'],
      failIfUnavailable: false,
      allowUnsandboxedCommands: true,
      excludedCommands: ['git status'],
    });

    expect(parseSandboxPolicy({ enabled: false })).toEqual({
      ...DEFAULT_SANDBOX_POLICY,
      enabled: false,
    });
  });

  it('ignores a settings block that carries the wrong types', () => {
    expect(parseSandboxPolicy({ enabled: 'yes', excludedCommands: 'git status' })).toEqual(
      DEFAULT_SANDBOX_POLICY,
    );
  });
});

// --- step 5: the launcher -----------------------------------------------------

describe('CC-017 step 5 — the launcher', () => {
  it('refuses to run the command when the sandbox is required and unavailable', async () => {
    const cwd = temporaryDirectory();
    await expect(
      launchSandbox({
        command: 'echo hello',
        cwd,
        policy: policy({ failIfUnavailable: true }),
        backend: unavailableBackend,
      }),
    ).rejects.toBeInstanceOf(SandboxRefusedError);
  });

  it('runs the shell unconfined when failIfUnavailable is false and the backend is missing', async () => {
    const cwd = temporaryDirectory();
    const launched = await launchSandbox({
      command: 'echo unconfined',
      cwd,
      policy: policy({ failIfUnavailable: false }),
      backend: unavailableBackend,
    });
    expect(launched.status.sandboxed).toBe(false);
    expect(launched.status.reason).toBe(
      'sandbox.failIfUnavailable is false (a missing backend would run the shell unconfined)',
    );
    const result = await launched.wait();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('unconfined');
    await launched.cleanup();
  });

  it('masks a protected path with a tmpfs rather than a read-only bind', () => {
    const cwd = temporaryDirectory();
    const protectedPath = path.join(cwd, 'settings.json');
    const plan = buildSandboxPlan({ command: 'true', cwd, protectedPaths: [protectedPath] });

    // The mask occupies the protected path, or the directory that holds it, so the
    // sandbox can neither read it nor create it.
    const masks = plan.mounts.filter((mount) => mount.kind === 'tmpfs');
    const covered = masks.some(
      (mount) =>
        mount.target === protectedPath ||
        mount.target === path.dirname(protectedPath) ||
        protectedPath.startsWith(`${mount.target}/`),
    );
    expect(covered).toBe(true);
    expect(plan.mounts.some((mount) => mount.target === protectedPath && mount.kind === 'ro-bind')).toBe(
      false,
    );
    expect(plan.protectedPaths).toContain(protectedPath);
  });

  it('masks a protected path that does not exist with a tmpfs as well', () => {
    const cwd = temporaryDirectory();
    const protectedPath = path.join(cwd, 'config', 'settings.json');
    expect(existsSync(protectedPath)).toBe(false);
    const plan = buildSandboxPlan({ command: 'true', cwd, protectedPaths: [protectedPath] });

    const masks = plan.mounts.filter((mount) => mount.kind === 'tmpfs');
    const covered = masks.some(
      (mount) =>
        mount.target === protectedPath ||
        mount.target === path.dirname(protectedPath) ||
        protectedPath.startsWith(`${mount.target}/`),
    );
    expect(covered).toBe(true);
    expect(plan.masks[0]?.path).toBe(protectedPath);
  });

  it('denies the syscall surface the plan requires, including io_uring_setup', () => {
    const cwd = temporaryDirectory();
    const plan = buildSandboxPlan({ command: 'true', cwd });
    for (const syscall of [
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
    ]) {
      expect(plan.deniedSyscalls).toContain(syscall);
      expect(DENIED_SYSCALLS).toContain(syscall);
    }
  });

  it.skipIf(!bubblewrapAvailable)(
    'establishes the namespaces, PR_SET_NO_NEW_PRIVS and the seccomp filter',
    async () => {
      const root = temporaryDirectory();
      const launched = await launchSandbox({
        command: 'grep -E "^(NoNewPrivs|Seccomp):" /proc/self/status; echo ---; cat /proc/net/dev',
        cwd: root,
      });
      const result = await launched.wait();
      await launched.cleanup();

      expect(result.exitCode).toBe(0);
      // PR_SET_NO_NEW_PRIVS, and a seccomp filter (mode 2) rather than strict mode.
      expect(result.stdout).toMatch(/NoNewPrivs:\s+1/);
      expect(result.stdout).toMatch(/Seccomp:\s+2/);
      // The network namespace has no interface at all but the loopback one.
      const interfaces = result.stdout.split('---')[1] ?? '';
      const names = interfaces
        .split('\n')
        .map((line) => line.split(':')[0]?.trim() ?? '')
        .filter((line) => line.length > 0 && !line.includes('Inter-') && !line.includes('|'));
      expect(names).toEqual(['lo']);
    },
  );

  it.skipIf(!bubblewrapAvailable)(
    'makes the kernel refuse a syscall the filter names',
    async () => {
      const root = temporaryDirectory();

      const blocked = await launchSandbox({
        command: 'id',
        cwd: root,
        deniedSyscalls: ['getuid'],
      });
      const blockedResult = await blocked.wait();
      await blocked.cleanup();

      const allowed = await launchSandbox({ command: 'id', cwd: root });
      const allowedResult = await allowed.wait();
      await allowed.cleanup();

      // The blocked call fails with EPERM, so the user id is unknown; the call that
      // is not blocked answers normally.
      expect(blockedResult.stdout).toContain('4294967295');
      expect(allowedResult.stdout).not.toContain('4294967295');
    },
  );

  it.skipIf(!bubblewrapAvailable)(
    'lets the sandboxed process reach the host only through the proxy socket',
    async () => {
      const root = temporaryDirectory();
      const socketPath = path.join(root, 'proxy.sock');
      const proxy = await createSandboxProxy({
        socketPath,
        policy: { allowedDomains: ['*'] },
        resolve: async () => ['127.0.0.1'],
      });
      const script = path.join(root, 'probe.py');
      writeFileSync(
        script,
        [
          'import socket',
          's = socket.socket(socket.AF_UNIX)',
          `s.connect(${JSON.stringify(SANDBOX_PROXY_SOCKET_PATH)})`,
          "s.sendall(b'CONNECT 127.0.0.1:22 HTTP/1.1\\r\\nHost: 127.0.0.1:22\\r\\n\\r\\n')",
          "print(s.recv(400).decode(errors='replace'))",
        ].join('\n'),
      );

      try {
        const launched = await launchSandbox({
          command: `python3 ${JSON.stringify(script)}; echo "socket=$SANDBOX_PROXY_SOCKET"`,
          cwd: root,
          proxy,
        });
        const result = await launched.wait();
        await launched.cleanup();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('403');
        expect(result.stdout).toContain('proxy_refused');
        expect(result.stdout).toContain(`socket=${SANDBOX_PROXY_SOCKET_PATH}`);
        expect(SANDBOX_PROXY_SOCKET_VARIABLE).toBe('SANDBOX_PROXY_SOCKET');
      } finally {
        await proxy.close();
      }
    },
  );

  it.skipIf(!bubblewrapAvailable)(
    'does not let a sandboxed process create a protected path that did not exist at startup',
    async () => {
      const root = temporaryDirectory();
      const writable = path.join(root, 'work');
      const protectedDirectory = path.join(writable, 'config');
      mkdirSync(protectedDirectory, { recursive: true });
      // The protected path does **not** exist: this is the CVE-2026-25725 shape.
      const protectedPath = path.join(protectedDirectory, 'settings.json');
      expect(existsSync(protectedPath)).toBe(false);

      const launched = await launchSandbox({
        command: `touch ${JSON.stringify(protectedPath)}`,
        cwd: root,
        readWritePaths: [writable],
        protectedPaths: [protectedPath],
      });
      expect(launched.status.sandboxed).toBe(true);
      const result = await launched.wait();
      await launched.cleanup();

      // The file must not exist **on the host**: the sandbox may create it inside
      // its own mask, but it must never reach the configuration directory.
      expect(existsSync(protectedPath)).toBe(false);
    },
  );

  it.skipIf(!bubblewrapAvailable)(
    'lets the same command create the path when the mask is absent, so the mask is what stops it',
    async () => {
      const root = temporaryDirectory();
      const writable = path.join(root, 'work');
      const protectedDirectory = path.join(writable, 'config');
      mkdirSync(protectedDirectory, { recursive: true });
      const protectedPath = path.join(protectedDirectory, 'settings.json');

      const launched = await launchSandbox({
        command: `touch ${JSON.stringify(protectedPath)}`,
        cwd: root,
        readWritePaths: [writable],
      });
      const result = await launched.wait();
      await launched.cleanup();

      expect(result.exitCode).toBe(0);
      expect(existsSync(protectedPath)).toBe(true);
    },
  );
});

// --- step 8: Landlock ---------------------------------------------------------

/** A Landlock syscall seam that reports a chosen ABI. */
function fakeLandlock(options: { abi?: number; errno?: number } = {}): LandlockSyscalls & {
  added: { pathFd: number; rights: bigint }[];
} {
  const added: { pathFd: number; rights: bigint }[] = [];
  const errno = options.errno ?? 0;
  const abi = options.abi ?? 3;
  return {
    added,
    createRuleset() {
      return errno === 0 ? abi : errno;
    },
    addRule(_rulesetFd: number, _ruleType: number, rule: { pathFd: number; rights: bigint }): number {
      added.push({ pathFd: rule.pathFd, rights: rule.rights });
      return 0;
    },
    restrictSelf(): number {
      return 0;
    },
  };
}

describe('CC-017 step 8 — the Landlock layer', () => {
  it('binds a rule to the object rather than to the name', () => {
    const root = temporaryDirectory();
    const allowed = path.join(root, 'allowed');
    mkdirSync(allowed);
    writeFileSync(path.join(allowed, 'file.txt'), 'contents');

    const syscalls = fakeLandlock({ abi: 3 });
    const ruleset = buildLandlockRuleset({ readOnlyPaths: [allowed], syscalls });

    expect(ruleset.status.available).toBe(true);
    expect(ruleset.status.abi).toBe(3);
    expect(ruleset.bindings).toHaveLength(1);
    const binding = ruleset.bindings[0];
    expect(binding?.path).toBe(allowed);

    // The rule is bound to a descriptor, never to a path string.
    expect(syscalls.added).toHaveLength(1);
    expect(syscalls.added[0]?.pathFd).toBe(binding?.fd);
    expect(syscalls.added[0]?.rights).toBeTypeOf('bigint');
    const granted = syscalls.added[0]?.rights ?? 0n;
    expect(granted & LANDLOCK_ACCESS_FS_READ_FILE).toBe(LANDLOCK_ACCESS_FS_READ_FILE);
    expect(granted & LANDLOCK_ACCESS_FS_WRITE_FILE).toBe(0n);

    // A rename and a symlink swap must not walk the rule to another object.
    const moved = path.join(root, 'moved');
    renameSync(allowed, moved);
    symlinkSync('/etc', allowed);

    const inodeOfRule = fstatSync(binding?.fd ?? -1).ino;
    expect(inodeOfRule).toBe(fstatSync(openSync(moved, 0o10000000)).ino);
    expect(lstatSync(allowed).isSymbolicLink()).toBe(true);
    expect(readlinkSync(allowed)).toBe('/etc');

    ruleset.close();
  });

  it('records a path a rule could not be bound to', () => {
    const root = temporaryDirectory();
    const missing = path.join(root, 'missing');
    const ruleset = buildLandlockRuleset({ readOnlyPaths: [missing], syscalls: fakeLandlock() });
    expect(ruleset.skipped).toEqual([missing]);
    expect(ruleset.bindings).toHaveLength(0);
    ruleset.close();
  });

  it('reports the reduced protection when the kernel reports an ABI below the required level', () => {
    const status = detectLandlock(fakeLandlock({ abi: 1 }));
    expect(status.available).toBe(true);
    expect(status.abi).toBe(1);
    expect(status.requiredAbi).toBeGreaterThan(1);
    expect(status.reducedProtection.length).toBeGreaterThan(0);
    expect(status.reducedProtection.join(' ')).toMatch(/ABI/);
  });

  it('reports that the reference host grants no network rights', () => {
    const status = detectLandlock(fakeLandlock({ abi: 3 }));
    expect(status.abi).toBe(3);
    expect(status.networkRights).toBe(false);
    expect(status.scopeRights).toBe(false);
    expect(status.reducedProtection.join(' ')).toMatch(/network/i);
  });

  it('reports that Landlock is missing rather than pretending it is there', () => {
    const status = detectLandlock(fakeLandlock({ errno: -38 }));
    expect(status.available).toBe(false);
    expect(status.abi).toBe(0);
    expect(status.reason).toMatch(/ENOSYS/);
    expect(status.reducedProtection.length).toBeGreaterThan(0);
  });

  it('degrades gracefully in the launcher status', async () => {
    const cwd = temporaryDirectory();
    const launched = await launchSandbox({
      command: 'echo degraded',
      cwd,
      landlock: fakeLandlock({ abi: 1 }),
    });
    expect(launched.status.landlock.available).toBe(true);
    expect(launched.status.landlock.abi).toBe(1);
    expect(launched.status.reducedProtection.length).toBeGreaterThan(0);
    const result = await launched.wait();
    expect(result.exitCode).toBe(0);
    await launched.cleanup();
  });
});

// --- step 11: the seccomp supervisor ------------------------------------------

interface FakeChannel extends NotifierChannel {
  readonly calls: string[];
  readonly responses: SeccompResponse[];
}

function fakeChannel(options: {
  path?: string;
  validUntil?: number;
  base?: string;
  dirFd?: number;
}): FakeChannel {
  const calls: string[] = [];
  const responses: SeccompResponse[] = [];
  let validations = 0;
  return {
    calls,
    responses,
    receive(): SeccompNotification | null {
      return null;
    },
    respond(response: SeccompResponse): void {
      calls.push('respond');
      responses.push(response);
    },
    isIdValid(): boolean {
      calls.push('idValid');
      validations += 1;
      if (options.validUntil === undefined) return true;
      return validations <= options.validUntil;
    },
    readMemory(_pid: number, _address: bigint, length: number): Buffer | null {
      calls.push('readMemory');
      // A short read is the dirfd argument; a long one is the path.
      if (length === 8) {
        const bytes = Buffer.alloc(8);
        bytes.writeBigInt64LE(BigInt(options.dirFd ?? -100));
        return bytes;
      }
      return options.path === undefined ? null : Buffer.from(`${options.path}\0`, 'utf8');
    },
    resolveTargetPath(): string | undefined {
      calls.push('resolveTargetPath');
      return options.base ?? '/tmp';
    },
  };
}

describe('CC-017 step 11 — the seccomp supervisor', () => {
  it('observes without denying: the response error stays zero and the call continues', () => {
    const channel = fakeChannel({ path: '/etc/passwd' });
    const supervisor = createSeccompSupervisor({ channel });
    supervisor.handle({ id: 1n, pid: 4242, nr: 257, args: [0n, 0n] });

    expect(channel.responses).toHaveLength(1);
    const response = channel.responses[0];
    expect(response?.error).toBe(0);
    expect(response?.flags).toBe(SECCOMP_USER_NOTIF_FLAG_CONTINUE);
    expect(supervisor.observations).toHaveLength(1);
    expect(supervisor.observations[0]?.syscall).toBe('openat');
    expect(supervisor.observations[0]?.pid).toBe(4242);
  });

  it('re-validates the notification id immediately before it uses the arguments it read', () => {
    const channel = fakeChannel({ path: '/etc/passwd' });
    const supervisor = createSeccompSupervisor({ channel });
    supervisor.handle({ id: 7n, pid: 4242, nr: 257, args: [0n, 0n] });

    const lastRead = channel.calls.lastIndexOf('readMemory');
    const lastValidation = channel.calls.lastIndexOf('idValid');
    const response = channel.calls.indexOf('respond');
    expect(lastRead).toBeGreaterThanOrEqual(0);
    expect(lastValidation).toBeGreaterThan(lastRead);
    expect(response).toBeGreaterThan(lastValidation);
  });

  it('never continues a call whose notification id is no longer valid', () => {
    const channel = fakeChannel({ path: '/etc/passwd', validUntil: 1 });
    const supervisor = createSeccompSupervisor({ channel });
    supervisor.handle({ id: 7n, pid: 4242, nr: 257, args: [0n, 0n] });

    const continued = channel.responses.filter(
      (response) => (response.flags & SECCOMP_USER_NOTIF_FLAG_CONTINUE) !== 0,
    );
    expect(continued).toHaveLength(0);
  });

  it('never authorizes a path that layers 1 to 3 would deny', () => {
    const channel = fakeChannel({ path: '/etc/shadow' });
    const supervisor = createSeccompSupervisor({
      channel,
      pathPolicy: {
        permits: (candidate) => candidate !== '/etc/shadow',
      },
    });
    supervisor.handle({ id: 9n, pid: 4242, nr: 257, args: [0n, 0n] });

    expect(channel.responses).toHaveLength(1);
    const response = channel.responses[0];
    expect(response?.flags).toBe(0);
    expect(response?.error).not.toBe(0);
    expect((response?.flags ?? 0) & SECCOMP_USER_NOTIF_FLAG_CONTINUE).toBe(0);
  });

  it('decodes the target dispatch table the audit describes', () => {
    expect(OBSERVED_SYSCALLS).toHaveLength(27);
    const openat = OBSERVED_SYSCALLS.find((record) => record.name === 'openat');
    expect(openat?.nr).toBe(257);
    expect(openat?.meta.path).toBe(1);
    expect(openat?.meta.flags).toBe(2);
    expect(openat?.meta.dirfd).toBe(0);
    expect(openat?.meta.secondPath).toBe(ABSENT_ARGUMENT);

    const symlink = OBSERVED_SYSCALLS.find((record) => record.name === 'symlink');
    expect(symlink?.meta.path).toBe(1);

    const renameat = OBSERVED_SYSCALLS.find((record) => record.name === 'renameat');
    expect(renameat?.meta.secondPath).toBe(3);
    expect(renameat?.meta.secondDirfd).toBe(2);
  });

  it('resolves a relative path against the target, the way the target does', () => {
    const channel = fakeChannel({ path: 'etc/passwd', base: '/home/user/project' });
    const supervisor = createSeccompSupervisor({ channel });
    supervisor.handle({ id: 3n, pid: 4242, nr: 257, args: [0n, 0n] });

    expect(supervisor.observations[0]?.path).toBe('/home/user/project/etc/passwd');
    expect(channel.calls).toContain('resolveTargetPath');
  });

  it('resolves the target\'s directory through /proc, the way the target does', () => {
    expect(resolveTargetPathFromProc(process.pid, -100)).toBe(process.cwd());
    expect(resolveTargetPathFromProc(0x7fffffff, -100)).toBeUndefined();
  });

  it('writes the observation line the way the target writes it', () => {
    expect(
      formatObservation({ nr: 257, syscall: 'openat', pid: 42, path: '/tmp/a"b\\c' }),
    ).toBe('{"nr":257,"syscall":"openat","pid":42,"path":"/tmp/a\\"b\\\\c"}');
  });

  it('builds a seccomp filter that is a multiple of the instruction size', () => {
    const filter = buildSeccompFilter();
    expect(filter.length % 8).toBe(0);
    expect(filter.length).toBeGreaterThan(0);
  });

  it('builds a filter that carries the numbers of every denied syscall', () => {
    const filter = buildSeccompFilter();
    const immediates: number[] = [];
    for (let offset = 0; offset + 8 <= filter.length; offset += 8) {
      const code = filter.readUInt16LE(offset);
      // BPF_JEQ | BPF_K carries the syscall number.
      if (code === 0x15) immediates.push(filter.readUInt32LE(offset + 4));
    }
    for (const name of DENIED_SYSCALLS) {
      const number = SYSCALL_NUMBERS[name];
      expect(number).toBeTypeOf('number');
      expect(immediates).toContain(number);
    }
    // The architecture check is in the program too.
    expect(immediates).toContain(0xc000003e);
  });

  it('never authorizes a path the plan masks', () => {
    const cwd = temporaryDirectory();
    const protectedPath = path.join(cwd, 'settings.json');
    const plan = buildSandboxPlan({ command: 'true', cwd, protectedPaths: [protectedPath] });

    const channel = fakeChannel({ path: protectedPath });
    const supervisor = planSupervisor(plan, channel);
    supervisor.handle({ id: 11n, pid: 4242, nr: 257, args: [0n, 0n] });

    const continued = channel.responses.filter(
      (response) => (response.flags & SECCOMP_USER_NOTIF_FLAG_CONTINUE) !== 0,
    );
    expect(continued).toHaveLength(0);
  });
});

// --- step 13: the network proxy -----------------------------------------------

describe('CC-017 step 13 — the network proxy', () => {
  it('classifies the loopback, link-local and cloud-metadata ranges', () => {
    expect(classifyAddress('127.0.0.1')).toBe('loopback');
    expect(classifyAddress('127.255.255.254')).toBe('loopback');
    expect(classifyAddress('::1')).toBe('loopback');
    expect(classifyAddress('169.254.1.1')).toBe('link-local');
    expect(classifyAddress('fe80::1')).toBe('link-local');
    expect(classifyAddress('169.254.169.254')).toBe('cloud-metadata');
    expect(classifyAddress('100.100.100.200')).toBe('cloud-metadata');
    expect(classifyAddress('fd00:ec2::254')).toBe('cloud-metadata');
    expect(classifyAddress('93.184.216.34')).toBe('public');
  });

  it('blocks the loopback, link-local and cloud-metadata addresses', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    expect(isBlockedAddress('fe80::1')).toBe(true);
    expect(isBlockedAddress('93.184.216.34')).toBe(false);
  });

  it('refuses a hostname whose resolved address is not in the allowlist', () => {
    const decision = evaluateProxyTarget({
      host: 'blocked.example',
      port: 443,
      addresses: ['93.184.216.34'],
      policy: { allowedDomains: ['allowed.example'] },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/allowlist/i);
  });

  it('refuses a hostname whose resolved address is blocked, whatever the allowlist says', () => {
    const decision = evaluateProxyTarget({
      host: 'metadata.internal',
      port: 80,
      addresses: ['169.254.169.254'],
      policy: { allowedDomains: ['*'] },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/cloud-metadata/);
  });

  it('refuses a cloud-metadata name even when it resolves to a permitted address', () => {
    const decision = evaluateProxyTarget({
      host: 'metadata.google.internal',
      port: 80,
      addresses: ['93.184.216.34'],
      policy: { allowedDomains: ['*'] },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/cloud-metadata/);
  });

  it('allows a host that is in the allowlist and resolves to a permitted address', () => {
    const decision = evaluateProxyTarget({
      host: 'api.allowed.example',
      port: 443,
      addresses: ['93.184.216.34'],
      policy: { allowedDomains: ['allowed.example'] },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.address).toBe('93.184.216.34');
  });

  it('refuses over the wire: a CONNECT to a loopback address is answered with a refusal', async () => {
    const directory = temporaryDirectory();
    const socketPath = path.join(directory, 'proxy.sock');
    const proxy = await createSandboxProxy({
      socketPath,
      policy: { allowedDomains: ['*'] },
      resolve: async () => ['127.0.0.1'],
    });

    try {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const client = connect(socketPath);
        client.on('error', reject);
        client.on('connect', () => {
          client.write('CONNECT 127.0.0.1:22 HTTP/1.1\r\nHost: 127.0.0.1:22\r\n\r\n');
        });
        let data = '';
        client.setEncoding('utf8');
        client.on('data', (chunk: string) => {
          data += chunk;
          if (data.includes('\r\n\r\n')) {
            client.end();
            resolve({ status: parseStatus(data), body: data });
          }
        });
      });
      expect(response.status).toBe(403);
      expect(response.body).toMatch(/refus/i);
    } finally {
      await proxy.close();
    }
  });
});

/** The status code of an HTTP response head. */
function parseStatus(head: string): number {
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(head);
  return match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10);
}

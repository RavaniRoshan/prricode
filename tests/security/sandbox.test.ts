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
 *     and the masks over the protected configuration paths (the CVE-2026-25725
 *     class);
 *   - step 8 — Landlock: the rule that is bound to an object rather than to a name,
 *     and the reduced protection the launcher reports when the ABI is too low;
 *   - step 11 — the supervisor: the `SECCOMP_IOCTL_NOTIF_ID_VALID` re-check and the
 *     refusal to authorize a path that layers 1–3 would deny;
 *   - step 13 — the proxy: the refusal of loopback, link-local and cloud-metadata
 *     addresses, and of a host that is not in the allowlist.
 *
 * **The review round.** Every test below is named after the finding it pins, so a
 * regression names the defect it breaks.
 */

import {
  chmodSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import * as policyModule from '../../src/platform/sandbox/policy.js';
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
  defaultLandlockSyscalls,
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
  BUBBLEWRAP_ADVISORY,
  BUBBLEWRAP_MINIMUM_VERSION,
  SANDBOX_PROXY_SOCKET_PATH,
  SANDBOX_PROXY_SOCKET_VARIABLE,
  SandboxRefusedError,
  bubblewrapBackend,
  buildSandboxPlan,
  launchSandbox,
  planFilesystemPolicy,
  planSupervisor,
  probeEnforcementBinary,
  probeUserNamespace,
  sandboxEnvironment,
  type SandboxAdvisory,
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

/**
 * A backend that runs the command on the host and reports the sandbox as up.
 *
 * It carries the enforcement the test needs — a named advisory, for instance —
 * without depending on the version of bubblewrap the host happens to ship.
 */
function fakeBackend(options: { advisory?: SandboxAdvisory } = {}): SandboxBackend {
  return {
    name: 'test-fake',
    async isAvailable() {
      return { available: true };
    },
    async describe() {
      return {
        binary: '/usr/bin/bwrap',
        version: '0.9.0',
        setuid: false,
        warnings: [],
        problems: [],
        ...(options.advisory === undefined ? {} : { advisory: options.advisory }),
      };
    },
    async start(_plan, spec): Promise<SandboxProcess> {
      const child = spawn('/bin/sh', ['-c', spec.command], {
        cwd: spec.cwd,
        env: { PATH: '/usr/bin:/bin' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.on('close', (code, signal) => {
            resolve({ exitCode: code, signal });
          });
        },
      );
      return {
        pid: child.pid ?? -1,
        establishment: Promise.resolve({
          established: true,
          layers: {
            filesystem: true,
            seccomp: true,
            pathPolicy: false,
            network: true,
            supervisor: false,
          },
        }),
        async wait() {
          const { exitCode, signal } = await exited;
          return { exitCode, signal, stdout, stderr };
        },
        kill() {
          child.kill('SIGKILL');
        },
      };
    },
  };
}

/** Compare two dotted version numbers, the way the launcher does. */
function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

// --- step 1: the policy -------------------------------------------------------

describe('CC-017 step 1 — the sandbox policy', () => {
  it('denies with the reason naming the platform when enabledPlatforms excludes it', () => {
    const result = evaluateSandbox(
      policy({ enabledPlatforms: ['darwin'] }),
      'linux',
      'ls -la',
      'available',
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toBe('sandbox.enabledPlatforms excludes linux');
    expect(result.reason).toBe(SANDBOX_REASONS.platformExcluded('linux'));
  });

  it('denies when the sandbox is disabled', () => {
    const result = evaluateSandbox(policy({ enabled: false }), 'linux', 'ls -la', 'available');
    expect(result.decision).toBe('deny');
    expect(result.reason).toBe('sandbox.enabled is false');
  });

  it('runs the shell unconfined, and says so, when failIfUnavailable is false', () => {
    const result = evaluateSandbox(
      policy({ failIfUnavailable: false }),
      'linux',
      'ls -la',
      'unavailable',
    );
    expect(result.decision).toBe('unconfined');
    expect(result.reason).toBe(
      'sandbox.failIfUnavailable is false (a missing backend would run the shell unconfined)',
    );
  });

  it('denies when the backend is missing and failIfUnavailable is true', () => {
    const result = evaluateSandbox(
      policy({ failIfUnavailable: true }),
      'linux',
      'ls -la',
      'unavailable',
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/failIfUnavailable/);
  });

  it('runs an excluded command unconfined when allowUnsandboxedCommands is true', () => {
    const result = evaluateSandbox(
      policy({ allowUnsandboxedCommands: true, excludedCommands: ['git status'] }),
      'linux',
      'git status',
      'available',
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
      'available',
    );
    expect(result.decision).toBe('allow');
    expect(result.reason).toBeUndefined();
  });

  it('does not let an excluded command exempt a compound command that has an unexempt part', () => {
    const result = evaluateSandbox(
      policy({ allowUnsandboxedCommands: true, excludedCommands: ['git status'] }),
      'linux',
      'git status && rm -rf /tmp/whatever',
      'available',
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

  // --- review finding 3: the exclusion exemption is bypassable with a substitution ---

  it('never exempts a sub-command that carries a command substitution', () => {
    const excluded = policy({ allowUnsandboxedCommands: true, excludedCommands: ['git status'] });

    const substitution = evaluateSandbox(
      excluded,
      'linux',
      'git status "$(rm -rf /tmp/x)"',
      'available',
    );
    expect(substitution.decision).toBe('allow');
    expect(substitution.exemptions).toBeUndefined();

    const backtick = evaluateSandbox(
      excluded,
      'linux',
      'git status `rm -rf /tmp/x`',
      'available',
    );
    expect(backtick.decision).toBe('allow');
    expect(backtick.exemptions).toBeUndefined();

    // A glob entry covers the whole sub-command, substitution and all: the
    // substitution is what the entry must not be allowed to cover.
    const globbed = evaluateSandbox(
      policy({ allowUnsandboxedCommands: true, excludedCommands: ['git status *'] }),
      'linux',
      'git status "$(rm -rf /tmp/x)"',
      'available',
    );
    expect(globbed.decision).toBe('allow');
    expect(globbed.exemptions).toBeUndefined();
  });

  it('still exempts the plain command the exclusion names', () => {
    const result = evaluateSandbox(
      policy({ allowUnsandboxedCommands: true, excludedCommands: ['git status'] }),
      'linux',
      'git status',
      'available',
    );
    expect(result.decision).toBe('unconfined');
    expect(result.exemptions).toEqual(['git status']);
  });

  // --- fix round 2, finding 1: the substitution check ran after the redirections were stripped ---

  it('never exempts a command whose redirection target carries a command substitution', () => {
    const excluded = policy({ allowUnsandboxedCommands: true, excludedCommands: ['git status'] });

    // Every spelling of a redirection: the target is deleted by the stripping,
    // and the substitution has to be caught before that happens.
    for (const command of [
      'git status > "$(rm -rf /tmp/x)"',
      'git status >> "$(rm -rf /tmp/x)"',
      'git status < "$(rm -rf /tmp/x)"',
      'git status 2> "$(rm -rf /tmp/x)"',
      'git status >"$(rm -rf /tmp/x)"',
      'git status > `rm -rf /tmp/x`',
    ]) {
      const result = evaluateSandbox(excluded, 'linux', command, 'available');
      expect(result.decision, command).toBe('allow');
      expect(result.exemptions, command).toBeUndefined();
    }
  });

  it('never exempts a glob entry over a command that carries a command substitution', () => {
    const excluded = policy({ allowUnsandboxedCommands: true, excludedCommands: ['git *'] });

    // The glob covers the whole sub-command, so it is the one that must not be
    // allowed to cover a substitution.
    for (const command of [
      'git status > "$(rm -rf /tmp/x)"',
      'git status >> "$(rm -rf /tmp/x)"',
      'git status < "$(rm -rf /tmp/x)"',
      'git status 2> "$(rm -rf /tmp/x)"',
      'git status >"$(rm -rf /tmp/x)"',
      'git status > `rm -rf /tmp/x`',
      'git status "$(rm -rf /tmp/x)"',
      'git status $( $( rm -rf /tmp/x ) )',
    ]) {
      const result = evaluateSandbox(excluded, 'linux', command, 'available');
      expect(result.decision, command).toBe('allow');
      expect(result.exemptions, command).toBeUndefined();
    }
  });

  it('still exempts the plain command and the plain glob the exclusion names', () => {
    expect(matchingExclusions('git status', ['git status'])).toEqual(['git status']);
    expect(matchingExclusions('git status', ['git *'])).toEqual(['git *']);
    // A redirection that carries no substitution is still stripped before the
    // comparison.
    expect(matchingExclusions('git status > out.txt', ['git status'])).toEqual(['git status']);
  });

  it('does not exempt a command that an exclusion entry only names in part', () => {
    // An entry that is exactly `git` does not cover `git status`.
    expect(matchingExclusions('git status', ['git'])).toEqual([]);
    expect(matchingExclusions('git', ['git'])).toEqual(['git']);
  });

  it('never exempts a command that carries a process substitution', () => {
    // A shell that supports the process substitution runs the command inside
    // the parentheses, exactly as it runs a `$( … )`.
    const excluded = policy({ allowUnsandboxedCommands: true, excludedCommands: ['git *'] });
    for (const command of [
      'git status <(rm -rf /tmp/x)',
      'git status >(rm -rf /tmp/x)',
      'git status > <(rm -rf /tmp/x)',
    ]) {
      const result = evaluateSandbox(excluded, 'linux', command, 'available');
      expect(result.decision, command).toBe('allow');
      expect(result.exemptions, command).toBeUndefined();
    }
  });

  // --- fix round 2, finding 6: the entry was reported with its stray space ---

  it('reports the trimmed form of an exclusion entry', () => {
    expect(matchingExclusions('git status', ['git status '])).toEqual(['git status']);
    const result = evaluateSandbox(
      policy({ allowUnsandboxedCommands: true, excludedCommands: ['git status '] }),
      'linux',
      'git status',
      'available',
    );
    expect(result.decision).toBe('unconfined');
    expect(result.exemptions).toEqual(['git status']);
  });

  it('requires an exclusion entry to cover the whole sub-command', () => {
    // The entry is the whole sub-command: an argument is not part of the entry.
    expect(matchingExclusions('git status --short', ['git status'])).toEqual([]);
    // A glob still covers the whole sub-command.
    expect(matchingExclusions('git status --short', ['git *'])).toEqual(['git *']);
    // A redirection is stripped before the comparison.
    expect(matchingExclusions('git status > out.txt', ['git status'])).toEqual(['git status']);
  });

  // --- review finding 18: the policy is exported three ways ---

  it('exports the policy under one name', () => {
    expect(Object.keys(policyModule)).not.toContain('sandboxPolicy');
    expect(Object.keys(policyModule)).toContain('DEFAULT_SANDBOX_POLICY');
  });

  // --- review finding 12: the sandbox.filesystem block is not inert ---

  it('reads the sandbox.filesystem block out of a settings document', () => {
    const read = readSandboxPolicy({
      sandbox: {
        filesystem: {
          allowRead: ['/tmp/readable'],
          allowWrite: ['/tmp/writable'],
          denyRead: ['/tmp/secret'],
          denyWrite: ['/tmp/locked'],
          credentials: ['/tmp/token'],
        },
      },
    });
    expect(read.filesystem?.allowRead).toEqual(['/tmp/readable']);
    expect(read.filesystem?.allowWrite).toEqual(['/tmp/writable']);
    expect(read.filesystem?.denyRead).toEqual(['/tmp/secret']);
    expect(read.filesystem?.denyWrite).toEqual(['/tmp/locked']);
    expect(read.filesystem?.credentials).toEqual(['/tmp/token']);
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

  // --- review finding 11: the unit mask assertion is vacuous ---

  it('masks a protected path with exactly one tmpfs, on the directory that holds it', () => {
    const cwd = temporaryDirectory();
    const configDirectory = path.join(cwd, '.claude');
    mkdirSync(configDirectory);
    const protectedPath = path.join(configDirectory, 'settings.json');
    writeFileSync(protectedPath, '{}');

    const plan = buildSandboxPlan({ command: 'true', cwd, protectedPaths: [protectedPath] });

    // The exact mask: one mask, on the parent directory, never on the file.
    expect(plan.masks).toHaveLength(1);
    expect(plan.masks[0]?.path).toBe(protectedPath);
    expect(plan.masks[0]?.target).toBe(configDirectory);
    expect(plan.masks[0]?.kind).toBe('tmpfs');

    // The exact number of tmpfs mounts: the scratch one and the mask.
    const tmpfs = plan.mounts.filter((mount) => mount.kind === 'tmpfs');
    expect(tmpfs.map((mount) => mount.target)).toEqual(['/tmp', configDirectory]);
    expect(plan.mounts.some((mount) => mount.target === protectedPath)).toBe(false);
    expect(plan.protectedPaths).toContain(protectedPath);
  });

  it('masks a protected path that does not exist with a tmpfs as well', () => {
    const cwd = temporaryDirectory();
    const configDirectory = path.join(cwd, '.claude');
    mkdirSync(configDirectory);
    const protectedPath = path.join(configDirectory, 'settings.json');
    expect(existsSync(protectedPath)).toBe(false);

    const plan = buildSandboxPlan({ command: 'true', cwd, protectedPaths: [protectedPath] });

    expect(plan.masks).toHaveLength(1);
    expect(plan.masks[0]?.path).toBe(protectedPath);
    expect(plan.masks[0]?.target).toBe(configDirectory);
    const tmpfs = plan.mounts.filter((mount) => mount.kind === 'tmpfs');
    expect(tmpfs.map((mount) => mount.target)).toEqual(['/tmp', configDirectory]);
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

  // --- review finding 10: io_uring_setup is never proven refused end to end ---

  it.skipIf(!bubblewrapAvailable)(
    'makes the kernel refuse io_uring_setup, which the denylist names',
    async () => {
      const root = temporaryDirectory();
      const script = path.join(root, 'io_uring.py');
      writeFileSync(
        script,
        [
          'import ctypes, os',
          'libc = ctypes.CDLL("libc.so.6", use_errno=True)',
          'ctypes.set_errno(0)',
          'libc.syscall(425, 8, None)',
          'print("errno", ctypes.get_errno())',
        ].join('\n'),
      );

      const blocked = await launchSandbox({
        command: `python3 ${JSON.stringify(script)}`,
        cwd: root,
      });
      const blockedResult = await blocked.wait();
      await blocked.cleanup();

      // The filter refuses the call with EPERM: the kernel, not this implementation.
      expect(blockedResult.stdout).toContain('errno 1');

      // The control: the same call without the denylist reaches the kernel, which
      // answers with its own errno.
      const control = await launchSandbox({
        command: `python3 ${JSON.stringify(script)}`,
        cwd: root,
        deniedSyscalls: [],
      });
      const controlResult = await control.wait();
      await control.cleanup();
      const controlErrno = /errno (\d+)/.exec(controlResult.stdout)?.[1];
      expect(controlErrno).not.toBe('1');
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

  // --- review finding 1: the tmpfs mask kills the sandbox for an existing file ---

  it.skipIf(!bubblewrapAvailable)(
    'comes up when the protected path is an existing file, and the file is unreadable',
    async () => {
      const root = temporaryDirectory();
      const configDirectory = path.join(root, '.claude');
      mkdirSync(configDirectory);
      const protectedPath = path.join(configDirectory, 'settings.json');
      writeFileSync(protectedPath, '{"token":"s3cret"}');

      const launched = await launchSandbox({
        command: `cat ${JSON.stringify(protectedPath)}; echo "rc=$?"`,
        cwd: root,
        protectedPaths: [protectedPath],
      });

      // The sandbox came up: the mask is a tmpfs on a directory, never on the file.
      expect(launched.status.sandboxed).toBe(true);
      const result = await launched.wait();
      await launched.cleanup();

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('s3cret');
      expect(result.stdout).toContain('rc=1');
      expect(result.stderr).not.toMatch(/Not a directory/);
    },
  );

  it.skipIf(!bubblewrapAvailable)(
    'binds an empty file over a protected file whose parent cannot carry a mask',
    async () => {
      const root = temporaryDirectory();
      // The parent is the root of the working-tree bind, so it cannot carry a
      // tmpfs without replacing the whole working tree.
      const protectedPath = path.join(root, 'settings.json');
      writeFileSync(protectedPath, '{"token":"s3cret"}');

      const plan = buildSandboxPlan({ command: 'true', cwd: root, protectedPaths: [protectedPath] });
      expect(plan.masks[0]?.kind).toBe('empty-file');
      expect(plan.masks[0]?.target).toBe(protectedPath);

      const launched = await launchSandbox({
        command: `cat ${JSON.stringify(protectedPath)}; echo "rc=$?"`,
        cwd: root,
        protectedPaths: [protectedPath],
      });
      expect(launched.status.sandboxed).toBe(true);
      const result = await launched.wait();
      await launched.cleanup();

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('s3cret');
      expect(result.stdout).toContain('rc=0');
    },
  );

  // --- review finding 2: the "mask the parent" rule masks the whole working tree ---

  it.skipIf(!bubblewrapAvailable)(
    'keeps the working tree visible when a path inside it is masked',
    async () => {
      const root = temporaryDirectory();
      writeFileSync(path.join(root, 'README.md'), 'visible');
      const configDirectory = path.join(root, '.claude');
      mkdirSync(configDirectory);
      writeFileSync(path.join(configDirectory, 'settings.json'), '{}');

      const launched = await launchSandbox({
        command: 'cat README.md',
        cwd: root,
        protectedPaths: [path.join(configDirectory, 'settings.json')],
      });
      const result = await launched.wait();
      await launched.cleanup();

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('visible');
    },
  );

  it.skipIf(!bubblewrapAvailable)(
    'never creates the missing parent of a protected path on the host',
    async () => {
      const root = temporaryDirectory();
      const protectedPath = path.join(root, 'config', 'settings.json');
      const parent = path.dirname(protectedPath);
      expect(existsSync(parent)).toBe(false);

      const launched = await launchSandbox({
        command: 'echo RAN',
        cwd: root,
        protectedPaths: [protectedPath],
      });
      const result = await launched.wait();
      await launched.cleanup();

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('RAN');
      // The parent is never created on the host.
      expect(existsSync(parent)).toBe(false);
    },
  );

  it('refuses the launch with a named reason when a protected path cannot be masked', async () => {
    const root = temporaryDirectory();
    const protectedPath = path.join(root, 'config', 'settings.json');
    const parent = path.dirname(protectedPath);
    expect(existsSync(parent)).toBe(false);

    await expect(
      launchSandbox({
        command: 'echo RAN',
        cwd: root,
        // A read-write bind: masking the missing parent would create it on the host.
        readWritePaths: [root],
        protectedPaths: [protectedPath],
      }),
    ).rejects.toBeInstanceOf(SandboxRefusedError);
    expect(existsSync(parent)).toBe(false);
  });

  it('names the reason a protected path cannot be masked', () => {
    const root = temporaryDirectory();
    const protectedPath = path.join(root, 'config', 'settings.json');
    const plan = buildSandboxPlan({
      command: 'true',
      cwd: root,
      readWritePaths: [root],
      protectedPaths: [protectedPath],
    });
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]).toContain(protectedPath);
    expect(plan.refusals[0]).toMatch(/would create that directory on the host/);
  });

  // --- review finding 5: the status claims layers that are not in force ---

  it.skipIf(!bubblewrapAvailable)('reports only the layers the backend establishes', async () => {
    const root = temporaryDirectory();
    const launched = await launchSandbox({ command: 'echo layers', cwd: root });

    expect(launched.status.layers.filesystem).toBe(true);
    expect(launched.status.layers.seccomp).toBe(true);
    expect(launched.status.layers.network).toBe(true);
    // No Landlock ruleset is ever applied, and no USER_NOTIF filter is installed.
    expect(launched.status.layers.pathPolicy).toBe(false);
    expect(launched.status.layers.supervisor).toBe(false);
    expect(launched.status.notes.join(' ')).toMatch(/no Landlock ruleset is applied/);
    expect(launched.status.notes.join(' ')).toMatch(/supervisor is not attached/);

    await launched.cleanup();
  });

  it('reports that the sandbox never came up', async () => {
    const root = temporaryDirectory();
    const brokenBackend: SandboxBackend = {
      name: 'test-broken',
      async isAvailable() {
        return { available: true };
      },
      async start(): Promise<SandboxProcess> {
        return {
          pid: 4242,
          establishment: Promise.resolve({
            established: false,
            layers: {
              filesystem: false,
              seccomp: false,
              pathPolicy: false,
              network: false,
              supervisor: false,
            },
            reason: 'the sandbox never came up: bwrap: Cannot create the sandbox',
          }),
          async wait() {
            return { exitCode: 1, signal: null, stdout: '', stderr: 'bwrap: Cannot create' };
          },
          kill() {
            // The process is already gone.
          },
        };
      },
    };

    const launched = await launchSandbox({ command: 'echo never', cwd: root, backend: brokenBackend });

    // The caller can tell "the command failed" from "the sandbox never came up".
    expect(launched.status.sandboxed).toBe(false);
    expect(launched.status.layers.filesystem).toBe(false);
    expect(launched.status.reason).toMatch(/never came up/);
    await launched.cleanup();
  });

  it('never claims a supervisor layer when a supervisor object is supplied', async () => {
    const root = temporaryDirectory();
    const channel: NotifierChannel = {
      receive: () => null,
      respond: () => undefined,
      isIdValid: () => true,
      readMemory: () => null,
      resolveTargetPath: () => undefined,
    };
    const supervisor = createSeccompSupervisor({ channel });

    const launched = await launchSandbox({ command: 'echo supervisor', cwd: root, supervisor });
    expect(launched.status.layers.supervisor).toBe(false);
    expect(launched.status.notes.join(' ')).toMatch(/supervisor is not attached/);
    expect(launched.status.notes.join(' ')).toMatch(/no USER_NOTIF filter/);
    await launched.cleanup();
  });

  // --- review finding 7: the environment is passed through unfiltered ---

  it.skipIf(!bubblewrapAvailable)(
    'keeps the caller’s environment out of the sandbox and out of the status',
    async () => {
      const root = temporaryDirectory();
      const launched = await launchSandbox({
        command: 'echo "key=$ANTHROPIC_API_KEY"',
        cwd: root,
        env: { PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'sk-s3cret', LANG: 'C' },
      });
      const result = await launched.wait();
      await launched.cleanup();

      expect(result.stdout).toContain('key=');
      expect(result.stdout).not.toContain('sk-s3cret');
      // The status does not echo the environment either.
      expect(JSON.stringify(launched.status)).not.toContain('sk-s3cret');
    },
  );

  it('filters the environment against the allowlist', () => {
    const environment = sandboxEnvironment({
      command: 'true',
      cwd: '/tmp',
      env: { PATH: '/opt/bin', LANG: 'C', ANTHROPIC_API_KEY: 'sk-s3cret', HOME: '/home/user' },
    });
    expect(environment['PATH']).toBe('/opt/bin');
    expect(environment['LANG']).toBe('C');
    expect(environment['HOME']).toBe('/home/user');
    expect(environment['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  // --- review finding 8: the bubblewrap version and the setuid bit ---

  it.skipIf(!bubblewrapAvailable)('reports the bubblewrap version and the setuid bit', async () => {
    const root = temporaryDirectory();
    const launched = await launchSandbox({ command: 'echo version', cwd: root });

    const enforcement = launched.status.enforcement;
    expect(enforcement?.binary).toBe('/usr/bin/bwrap');
    expect(enforcement?.setuid).toBe(false);
    expect(enforcement?.version).toMatch(/^\d+\.\d+/);

    // A version below the fixed one is a warning, and it names the advisory.
    const version = enforcement?.version ?? '0.0.0';
    const warnings = enforcement?.warnings.join(' ') ?? '';
    if (compareVersions(version, BUBBLEWRAP_MINIMUM_VERSION) < 0) {
      expect(warnings).toMatch(/CVE-2026-87766/);
    } else {
      expect(warnings).not.toMatch(/CVE-2026-87766/);
    }

    await launched.cleanup();
  });

  it('refuses a setuid bubblewrap', () => {
    const root = temporaryDirectory();
    const fake = path.join(root, 'bwrap');
    writeFileSync(fake, '#!/bin/sh\nexit 0\n');
    chmodSync(fake, 0o4755);

    const enforcement = probeEnforcementBinary(fake);
    expect(enforcement.setuid).toBe(true);
    expect(enforcement.problems.join(' ')).toMatch(/setuid/);
  });

  it('warns about a bubblewrap below the version that carries the fix', () => {
    const root = temporaryDirectory();
    const fake = path.join(root, 'bwrap');
    writeFileSync(fake, '#!/bin/sh\necho "bubblewrap 0.9.0"\n');
    chmodSync(fake, 0o755);

    const enforcement = probeEnforcementBinary(fake);
    expect(enforcement.version).toBe('0.9.0');
    expect(enforcement.setuid).toBe(false);
    expect(enforcement.warnings.join(' ')).toMatch(/CVE-2026-87766/);
  });

  // --- review finding 15: the exemptions are computed but never reported ---

  it('reports the excludedCommands exemptions in the status', async () => {
    const root = temporaryDirectory();
    const launched = await launchSandbox({
      command: 'git status',
      cwd: root,
      policy: policy({ allowUnsandboxedCommands: true, excludedCommands: ['git status'] }),
    });
    expect(launched.status.sandboxed).toBe(false);
    expect(launched.status.exemptions).toEqual(['git status']);
    await launched.cleanup();
  });

  // --- review finding 19: the misleading diagnostics ---

  it('raises a SandboxRefusedError when the working directory does not exist', async () => {
    const missing = path.join(temporaryDirectory(), 'does-not-exist');
    await expect(launchSandbox({ command: 'echo hello', cwd: missing })).rejects.toBeInstanceOf(
      SandboxRefusedError,
    );
  });

  // --- review finding 20: --chdir is given a path that may not be bound ---

  it.skipIf(!bubblewrapAvailable)(
    'runs the command in the sandbox root when the working directory is the root',
    async () => {
      const launched = await launchSandbox({ command: 'pwd', cwd: '/' });
      const result = await launched.wait();
      await launched.cleanup();

      // The root is not bound — a bind of it would shadow the whole sandbox — so
      // the sandboxed process sees the sandbox's own root.
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('/');
      expect(launched.status.plan.workingDirectory).toBe('/');
    },
  );

  it('distinguishes a missing unshare binary from a refused user namespace', () => {
    const missing = probeUserNamespace(() => ({ status: null, failed: true }));
    expect(missing.available).toBe(true);
    expect(missing.warning).toMatch(/unshare/);
    expect(missing.reason).toBeUndefined();

    const refused = probeUserNamespace(() => ({ status: 1 }));
    expect(refused.available).toBe(false);
    expect(refused.reason).toMatch(/does not allow an unprivileged user namespace/);
    expect(refused.warning).toBeUndefined();
  });

  // --- review finding 12: the sandbox.filesystem block reaches the mount plan ---

  it('maps the sandbox.filesystem block onto the mount plan', () => {
    const root = temporaryDirectory();
    const readable = path.join(root, 'readable');
    const writable = path.join(root, 'writable');
    const secret = path.join(root, 'secret.txt');
    const token = path.join(root, 'token');
    mkdirSync(readable);
    mkdirSync(writable);
    writeFileSync(secret, 'secret');
    writeFileSync(token, 'token');

    const plan = buildSandboxPlan({
      command: 'true',
      cwd: root,
      filesystem: {
        allowRead: [readable],
        allowWrite: [writable],
        denyRead: [secret],
        denyWrite: [],
        credentials: [token],
      },
    });

    expect(plan.mounts.some((mount) => mount.kind === 'ro-bind' && mount.target === readable)).toBe(
      true,
    );
    expect(plan.mounts.some((mount) => mount.kind === 'bind' && mount.target === writable)).toBe(
      true,
    );
    expect(plan.protectedPaths).toContain(secret);
    expect(plan.protectedPaths).toContain(token);
    expect(plan.masks.some((mask) => mask.path === secret)).toBe(true);
    expect(plan.masks.some((mask) => mask.path === token)).toBe(true);
  });

  it('maps the filesystem policy onto the read-only, read-write and masked lists', () => {
    const mapped = planFilesystemPolicy({
      allowRead: ['/a'],
      allowWrite: ['/b'],
      denyRead: ['/c'],
      denyWrite: ['/d'],
      credentials: ['/e'],
    });
    expect(mapped.readOnlyPaths).toEqual(['/a']);
    expect(mapped.readWritePaths).toEqual(['/b']);
    expect(mapped.protectedPaths).toEqual(['/c', '/d', '/e']);
  });

  // --- fix round 2, finding 1: a substitution in a redirection target was an escape ---

  it.skipIf(!bubblewrapAvailable)(
    'never runs a substituted command on the host when the command is exempt',
    async () => {
      const root = temporaryDirectory();
      const outside = temporaryDirectory();
      const insideVictim = path.join(root, 'inside-victim.txt');
      const outsideVictim = path.join(outside, 'outside-victim.txt');

      const launched = await launchSandbox({
        command:
          `git status > "$(touch ${JSON.stringify(insideVictim)} ${JSON.stringify(outsideVictim)})"`,
        cwd: root,
        policy: policy({ allowUnsandboxedCommands: true, excludedCommands: ['git status'] }),
      });

      // The command is **not** exempt: the shell evaluates the substitution
      // before the command runs, so the exemption would run it on the host.
      const result = await launched.wait();
      await launched.cleanup();

      // The substitution ran inside the sandbox, so neither file is on the host.
      // This is the proof: an exempt command would have created both of them.
      expect(existsSync(insideVictim)).toBe(false);
      expect(existsSync(outsideVictim)).toBe(false);

      expect(launched.status.sandboxed).toBe(true);
      expect(launched.status.exemptions).toBeUndefined();
    },
  );

  // --- fix round 2, finding 2: a symlinked protected path aborted the launch ---

  it('refuses the launch with a named reason when a protected path is a symbolic link', async () => {
    const root = temporaryDirectory();
    const target = path.join(root, 'settings.json');
    writeFileSync(target, '{"token":"s3cret"}');
    const link = path.join(root, 'link.json');
    symlinkSync(target, link);

    const plan = buildSandboxPlan({ command: 'true', cwd: root, protectedPaths: [link] });
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]).toContain(link);
    expect(plan.refusals[0]).toMatch(/symbolic link/);
    // Nothing is masked: the launch is refused instead of dying inside bwrap.
    expect(plan.masks).toHaveLength(0);

    await expect(
      launchSandbox({ command: 'echo RAN', cwd: root, protectedPaths: [link] }),
    ).rejects.toBeInstanceOf(SandboxRefusedError);
  });

  it('refuses the launch when the parent of a protected path is a symbolic link', () => {
    const root = temporaryDirectory();
    const real = path.join(root, 'real');
    mkdirSync(real);
    writeFileSync(path.join(real, 'settings.json'), '{}');
    const link = path.join(root, 'link');
    symlinkSync(real, link);
    const protectedPath = path.join(link, 'settings.json');

    const plan = buildSandboxPlan({ command: 'true', cwd: root, protectedPaths: [protectedPath] });
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]).toMatch(/symbolic link/);
    expect(plan.masks).toHaveLength(0);
  });

  // --- fix round 2, finding 3: a symlinked mask target was not refused ---

  it('refuses the launch with a named reason when the mask target is a symbolic link', () => {
    const root = temporaryDirectory();
    const real = path.join(root, 'real');
    mkdirSync(real);
    const link = path.join(root, 'link');
    symlinkSync(real, link);

    // The mask would be a tmpfs on the link, which the backend cannot mount.
    const plan = buildSandboxPlan({ command: 'true', cwd: root, protectedPaths: [link] });
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]).toContain(link);
    expect(plan.refusals[0]).toMatch(/symbolic link/);
    expect(plan.masks).toHaveLength(0);
  });

  // --- fix round 2, finding 4: the advisory of an old bubblewrap was only a warning ---

  it('promotes the advisory of an old backend to a named condition in the status', async () => {
    const root = temporaryDirectory();
    const advisory: SandboxAdvisory = {
      id: BUBBLEWRAP_ADVISORY,
      fixedIn: BUBBLEWRAP_MINIMUM_VERSION,
      version: '0.9.0',
      detail: 'bubblewrap 0.9.0 predates 0.12.0, which fixes CVE-2026-87766',
    };

    const launched = await launchSandbox({
      command: 'echo advisory',
      cwd: root,
      backend: fakeBackend({ advisory }),
    });

    // The condition is named, so the caller can branch on it.
    expect(launched.status.advisory?.id).toBe(BUBBLEWRAP_ADVISORY);
    expect(launched.status.advisory?.version).toBe('0.9.0');
    expect(launched.status.advisory?.fixedIn).toBe(BUBBLEWRAP_MINIMUM_VERSION);
    // And it is a line of the reduced protection, so it cannot be missed.
    expect(launched.status.reducedProtection.join(' ')).toMatch(/CVE-2026-87766/);
    await launched.cleanup();
  });

  it('names the advisory of an old bubblewrap in the enforcement probe', () => {
    const root = temporaryDirectory();
    const fake = path.join(root, 'bwrap');
    writeFileSync(fake, '#!/bin/sh\necho "bubblewrap 0.9.0"\n');
    chmodSync(fake, 0o755);

    const enforcement = probeEnforcementBinary(fake);
    expect(enforcement.advisory?.id).toBe(BUBBLEWRAP_ADVISORY);
    expect(enforcement.advisory?.version).toBe('0.9.0');
    expect(enforcement.advisory?.fixedIn).toBe(BUBBLEWRAP_MINIMUM_VERSION);
    // The backend is not refused over the version: the advisory is a condition.
    expect(enforcement.problems).toEqual([]);
  });

  it.skipIf(!bubblewrapAvailable)(
    'keeps an old bubblewrap available and reports its advisory',
    async () => {
      const backend = bubblewrapBackend();
      const probe = await backend.isAvailable();
      const enforcement = await backend.describe?.();
      const version = enforcement?.version ?? '0.0.0';

      if (compareVersions(version, BUBBLEWRAP_MINIMUM_VERSION) < 0) {
        // The version never refuses the backend, and the advisory is visible.
        expect(enforcement?.advisory?.id).toBe(BUBBLEWRAP_ADVISORY);
        expect(probe.reason ?? '').not.toMatch(/CVE-2026-87766/);
        expect(probe.warning ?? '').toMatch(/CVE-2026-87766/);

        const root = temporaryDirectory();
        const launched = await launchSandbox({ command: 'echo version', cwd: root });
        expect(launched.status.advisory?.id).toBe(BUBBLEWRAP_ADVISORY);
        expect(launched.status.reducedProtection.join(' ')).toMatch(/CVE-2026-87766/);
        await launched.cleanup();
        return;
      }

      // A fixed version carries no advisory at all.
      expect(enforcement?.advisory).toBeUndefined();
      expect(probe.warning ?? '').not.toMatch(/CVE-2026-87766/);
    },
  );

  // --- fix round 2, finding 5: the unconfined path leaked the environment ---

  it('filters the environment of an exempt command too', async () => {
    const root = temporaryDirectory();
    const command = 'echo "key=[$ANTHROPIC_API_KEY]"';
    const launched = await launchSandbox({
      command,
      cwd: root,
      env: { PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'sk-s3cret' },
      policy: policy({ allowUnsandboxedCommands: true, excludedCommands: [command] }),
    });

    expect(launched.status.sandboxed).toBe(false);
    expect(launched.status.exemptions).toEqual([command]);
    const result = await launched.wait();
    await launched.cleanup();

    // The exempt command is still the agent's command: it does not see the key.
    expect(result.stdout).toContain('key=[]');
    expect(result.stdout).not.toContain('sk-s3cret');
  });

  it('does not leak the host environment into an exempt command', async () => {
    const root = temporaryDirectory();
    const command = 'echo "marker=[$CLONE_SANDBOX_HOST_MARKER]"';
    process.env['CLONE_SANDBOX_HOST_MARKER'] = 'host-secret';
    try {
      const launched = await launchSandbox({
        command,
        cwd: root,
        policy: policy({ allowUnsandboxedCommands: true, excludedCommands: [command] }),
      });
      const result = await launched.wait();
      await launched.cleanup();

      expect(result.stdout).toContain('marker=[]');
      expect(result.stdout).not.toContain('host-secret');
    } finally {
      delete process.env['CLONE_SANDBOX_HOST_MARKER'];
    }
  });

  // --- fix round 2: the probes ---

  it('resolves a relative protected path against the working directory', () => {
    const root = temporaryDirectory();
    const configDirectory = path.join(root, 'config');
    mkdirSync(configDirectory);

    const plan = buildSandboxPlan({
      command: 'true',
      cwd: root,
      protectedPaths: ['config/settings.json'],
    });

    expect(plan.protectedPaths).toEqual([path.join(configDirectory, 'settings.json')]);
    expect(plan.masks[0]?.target).toBe(configDirectory);
    expect(plan.masks[0]?.kind).toBe('tmpfs');
  });

  it('masks a protected path that carries a trailing slash', () => {
    const root = temporaryDirectory();
    const configDirectory = path.join(root, 'config');
    mkdirSync(configDirectory);

    const plan = buildSandboxPlan({ command: 'true', cwd: root, protectedPaths: ['config/'] });

    expect(plan.protectedPaths).toEqual([configDirectory]);
    expect(plan.masks[0]?.target).toBe(configDirectory);
    expect(plan.refusals).toHaveLength(0);
  });

  it('never masks the root of the filesystem', () => {
    const root = temporaryDirectory();

    const plan = buildSandboxPlan({ command: 'true', cwd: root, protectedPaths: ['/'] });

    expect(plan.protectedPaths).toEqual(['/']);
    expect(plan.masks).toHaveLength(0);
    expect(plan.refusals).toHaveLength(0);
  });

  it.skipIf(!bubblewrapAvailable)('binds a read-write path that is a file', async () => {
    const root = temporaryDirectory();
    const file = path.join(root, 'notes.txt');
    writeFileSync(file, 'hello');

    const launched = await launchSandbox({
      command: `cat ${JSON.stringify(file)}; echo "rc=$?"`,
      cwd: root,
      readWritePaths: [file],
    });

    expect(launched.status.sandboxed).toBe(true);
    const result = await launched.wait();
    await launched.cleanup();

    expect(result.stdout).toContain('hello');
  });
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
    // The seam really asked the kernel, so the kernel is the one that said no.
    expect(status.seamImplemented).toBe(true);
    expect(status.kernelSupported).toBe(false);
  });

  // --- review finding 6: the status blames the kernel for a reimplementation-side stub ---

  it('does not blame the kernel when the seam is a stub', () => {
    const status = detectLandlock(defaultLandlockSyscalls());
    expect(status.available).toBe(false);
    expect(status.seamImplemented).toBe(false);
    // The kernel was never asked, so this implementation claims nothing about it.
    expect(status.kernelSupported).toBeUndefined();
    expect(status.reason).toMatch(/seam is not implemented/);
    expect(status.reason).not.toMatch(/kernel does not implement/);
    expect(status.reducedProtection.join(' ')).not.toMatch(/not available on this host/);
    expect(status.reducedProtection.join(' ')).toMatch(/was not probed/);
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

  // --- review finding 16: the errno option applies only to the architecture ---

  it('makes the errno option apply to every blocked syscall', () => {
    const filter = buildSeccompFilter({ errno: 13 });
    const returns: number[] = [];
    for (let offset = 0; offset + 8 <= filter.length; offset += 8) {
      if (filter.readUInt16LE(offset) === 0x06) returns.push(filter.readUInt32LE(offset + 4));
    }
    // Every refusal carries the errno the option names, and not the default one.
    expect(returns).toContain(0x00050000 | 13);
    expect(returns).not.toContain(0x00050000 | 1);
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

  // --- review finding 4: the supervisor authorizes paths that layer 1 denies ---

  it('never authorizes a sibling under the directory the plan masks', () => {
    const cwd = temporaryDirectory();
    const configDirectory = path.join(cwd, '.claude');
    mkdirSync(configDirectory);
    const protectedPath = path.join(configDirectory, 'settings.json');
    writeFileSync(protectedPath, '{}');
    const plan = buildSandboxPlan({ command: 'true', cwd, protectedPaths: [protectedPath] });

    // The mask covers the whole directory, so a sibling under it is refused too.
    expect(plan.masks[0]?.target).toBe(configDirectory);

    const channel = fakeChannel({ path: path.join(configDirectory, 'other.json') });
    const supervisor = planSupervisor(plan, channel);
    supervisor.handle({ id: 12n, pid: 4242, nr: 257, args: [0n, 0n] });

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

  // --- review finding 9: the expanded IPv4-mapped loopback is classified public ---

  it('classifies an IPv4-mapped address by the IPv4 address it carries', () => {
    expect(classifyAddress('0:0:0:0:0:ffff:7f00:1')).toBe('loopback');
    expect(classifyAddress('::ffff:127.0.0.1')).toBe('loopback');
    expect(classifyAddress('::ffff:7f00:1')).toBe('loopback');
    expect(classifyAddress('::ffff:a9fe:a9fe')).toBe('link-local');
    expect(isBlockedAddress('0:0:0:0:0:ffff:7f00:1')).toBe(true);
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
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

  // --- review finding 17: the socket lives in a world-writable directory ---

  it('puts the proxy socket in a private directory', async () => {
    const proxy = await createSandboxProxy({ policy: { allowedDomains: ['*'] } });
    try {
      const directory = path.dirname(proxy.socketPath);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(proxy.socketPath).mode & 0o777).toBe(0o600);
    } finally {
      await proxy.close();
    }
  });
});

// --- the documentation the review pins ----------------------------------------

/** The source of a module of the sandbox. */
function moduleSource(name: string): string {
  return readFileSync(new URL(`../../src/platform/sandbox/${name}.ts`, import.meta.url), 'utf8');
}

/** The header of a module of the sandbox, with the comment markers stripped. */
function moduleHeader(name: string): string {
  const source = moduleSource(name);
  return source.slice(0, source.indexOf('*/')).replace(/^\s*\*\s?/gm, '');
}

describe('CC-017 — the documented shape of the sandbox', () => {
  it('states the residual risk in every module header', () => {
    for (const name of ['policy', 'launcher', 'landlock', 'seccomp', 'proxy']) {
      const header = moduleHeader(name);
      expect(header).toMatch(/residual risk/i);
      expect(header).toMatch(/microVM/);
    }
  });

  // --- review finding 13: the policy defaults diverge from the target ---

  it('labels the policy defaults that diverge from the target', () => {
    const header = moduleHeader('policy');
    expect(header).toMatch(/falls back to running\s+unsandboxed/);
    expect(header).toMatch(/failIfUnavailable/);
    expect(header).toMatch(/enabledPlatforms/);
  });

  // --- review finding 12: the read-only working tree is a implementation choice ---

  it('labels the read-only working tree as a implementation choice', () => {
    const header = moduleHeader('launcher');
    expect(header).toMatch(/Implementation choices/);
    expect(header).toMatch(/working tree is bound read-only/);
  });

  // --- review finding 14: the observation line diverges from the target's ---

  it('labels the extra member of the observation line', () => {
    const source = moduleSource('seccomp');
    const documentation = source.slice(source.indexOf('Format an observation'));
    expect(documentation).toMatch(/secondPath/);
    expect(documentation).toMatch(/divergence/i);
  });

  // --- review finding 6: the seam and the kernel are different facts ---

  it('distinguishes the unimplemented seam from a kernel without Landlock', () => {
    const header = moduleHeader('landlock');
    expect(header).toMatch(/stub/);
    expect(header).toMatch(/never claims a host fact/i);
  });

  // --- review finding 20: the JSDoc block and the export share a line ---

  it('keeps the JSDoc block of an export on its own line', () => {
    for (const name of ['policy', 'launcher', 'landlock', 'seccomp', 'proxy']) {
      expect(moduleSource(name)).not.toContain('}export');
    }
  });
});

/** The status code of an HTTP response head. */
function parseStatus(head: string): number {
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(head);
  return match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10);
}

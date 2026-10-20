/**
 * The `Bash` tool and the sandbox: the routing between them.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.9 ("Native and platform
 * sandbox") and §2.5 (Permissions, "Tool contract"), and the `CC-008b` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * The tests follow the plan's steps in order:
 *
 *   - **step 1** — the routing: a call with the sandbox enabled runs through the
 *     launcher, a call the policy exempts runs unconfined and says so, a call
 *     whose sandbox cannot be started is refused when `failIfUnavailable` is set
 *     and runs unconfined when it is not, and `dangerouslyDisableSandbox` never
 *     skips a permission rule;
 *   - **step 3** — the policy: the tool hands the policy to the launcher, so the
 *     `sandbox.filesystem` block reaches the mount plan;
 *   - **step 5** — the safety: the sandboxed command does not see the agent's
 *     credentials, and a denied sandbox leaves the tool's result reporting the
 *     refusal rather than a bare non-zero exit;
 *   - **step 6** — the header no longer claims that the sandbox is not
 *     implemented.
 *
 * **The backend is a test double.** It mirrors what the real bubblewrap backend
 * does — it runs the command with the environment the launcher filtered — so the
 * environment rule is exercised end to end without depending on the host.
 *
 * **The reason strings are the target's.** The tests assert them verbatim, so a
 * change to a reason is a change to a compatibility claim.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadSettings } from '../../src/config/loader.js';
import { describeReason, type PermissionDecision, type ToolContext } from '../../src/permissions/decision.js';
import type { RuleSet } from '../../src/permissions/rules.js';
import {
  MAX_COLLECTED_OUTPUT_CHARS,
  bubblewrapBackend,
  launchSandbox,
  sandboxEnvironment,
  type SandboxBackend,
  type SandboxPlan,
  type SandboxProcess,
  type SandboxSpec,
} from '../../src/platform/sandbox/launcher.js';
import {
  DEFAULT_SANDBOX_POLICY,
  SANDBOX_REASONS,
  type SandboxPolicy,
} from '../../src/platform/sandbox/policy.js';
import {
  createBashTool,
  MAX_BASH_OUTPUT_CHARS,
  SANDBOX_NOT_CONFIGURED_REASON,
  SANDBOX_OVERRIDE_REASON,
} from '../../src/tools/builtins/bash.js';
import type { BuiltinToolDeps } from '../../src/tools/builtins/shared.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { runTool } from '../../src/tools/runner.js';

// --- the fixtures -----------------------------------------------------------------

/** The host's process table, as one string. */
function psOutput(): string {
  const result = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' });
  return result.stdout ?? '';
}

/** The temporary directories a test creates, removed when the test ends. */
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'cc008b-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function toolContext(toolName: string, input: unknown): ToolContext {
  return { toolName, input, toolUseId: 'toolu_01', sessionId: 'session-01' };
}

function ruleSet(overrides: Partial<RuleSet> = {}): RuleSet {
  return {
    allow: [],
    deny: [],
    ask: [],
    cwd: '/work',
    source: 'userSettings',
    ...overrides,
  };
}

function builtinDeps(overrides: Partial<BuiltinToolDeps> = {}): BuiltinToolDeps {
  return {
    rules: ruleSet(),
    mode: 'default',
    cwd: '/work',
    ...overrides,
  };
}

/** The layers a test double establishes. */
const DOUBLE_LAYERS = {
  filesystem: true,
  seccomp: true,
  pathPolicy: false,
  network: true,
  supervisor: false,
} as const;

/** A backend that records what it was asked to do. */
interface RecordingBackend extends SandboxBackend {
  /** The number of times the backend was asked to start a command. */
  started: number;
  /** The number of times the backend was asked whether it is available. */
  probes: number;
  /** The plan of the last command the backend was asked to start. */
  lastPlan?: SandboxPlan;
  /** The spec of the last command the backend was asked to start. */
  lastSpec?: SandboxSpec;
}

/**
 * A backend that runs the command on the host.
 *
 * It applies the **filtered** environment the way the real backend does, so the
 * environment rule is exercised rather than assumed.
 */
function recordingBackend(
  options: {
    available?: boolean;
    established?: boolean;
    reason?: string;
    warning?: string;
    failWait?: boolean;
  } = {},
): RecordingBackend {
  const backend: RecordingBackend = {
    name: 'test-double',
    started: 0,
    probes: 0,
    async isAvailable() {
      backend.probes += 1;
      return {
        available: options.available ?? true,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
        ...(options.warning === undefined ? {} : { warning: options.warning }),
      };
    },
    async start(plan, spec): Promise<SandboxProcess> {
      backend.started += 1;
      backend.lastPlan = plan;
      backend.lastSpec = spec;
      const child = spawn('/bin/sh', ['-c', spec.command], {
        cwd: spec.cwd,
        env: sandboxEnvironment(spec),
        stdio: ['ignore', 'pipe', 'pipe'],
        // The command leads its own process group, so the double can stop the
        // whole group — what bubblewrap does with `--die-with-parent`.
        detached: true,
      });
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
          child.on('close', (code, signal) => {
            resolve({ exitCode: code, signal });
          });
        },
      );
      return {
        pid: child.pid ?? -1,
        establishment: Promise.resolve({
          established: options.established ?? true,
          layers: { ...DOUBLE_LAYERS },
          ...(options.established === false
            ? { reason: 'the sandbox never came up' }
            : {}),
        }),
        async wait() {
          if (options.failWait === true) {
            throw new Error('the sandboxed run could not report its result');
          }
          const { exitCode, signal } = await exited;
          return { exitCode, signal, stdout, stderr };
        },
        kill() {
          const pid = child.pid;
          if (pid === undefined) return;
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        },
      };
    },
  };
  return backend;
}

/** A backend that is never available, so the refusal path is testable. */
const unavailableBackend: SandboxBackend = {
  name: 'test-unavailable',
  async isAvailable() {
    return { available: false, reason: 'the test backend is not available' };
  },
  async start(): Promise<SandboxProcess> {
    throw new Error('the test backend must not start');
  },
};

/** A backend whose availability probe throws. */
const throwingProbeBackend: SandboxBackend = {
  name: 'test-throwing-probe',
  async isAvailable(): Promise<{ available: boolean }> {
    throw new Error('the availability probe exploded');
  },
  async start(): Promise<SandboxProcess> {
    throw new Error('the test backend must not start');
  },
};

/** Whether this host can run the bubblewrap backend the launcher uses. */
const bubblewrapAvailable = existsSync('/usr/bin/bwrap') && process.platform === 'linux';

// --- step 1: the routing -----------------------------------------------------------

describe('CC-008b step 1 — the Bash tool runs through the sandbox', () => {
  it('runs the command through the launcher when the sandbox is enabled', async () => {
    const root = temporaryDirectory();
    const backend = recordingBackend();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        env: { PATH: '/usr/bin:/bin' },
        sandboxPolicy: DEFAULT_SANDBOX_POLICY,
        sandboxBackend: backend,
      }),
    );
    const input = { command: 'printf hello' };

    const output = await tool.execute(input, toolContext('Bash', input));

    // The launcher started the backend: the command ran through the sandbox.
    expect(backend.started).toBe(1);
    expect(output.stdout).toBe('hello');
    expect(output.exitCode).toBe(0);
    expect(output.sandboxed).toBe(true);
  });

  it('runs an exempt command unconfined, and says so', async () => {
    const root = temporaryDirectory();
    const backend = recordingBackend();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: {
          ...DEFAULT_SANDBOX_POLICY,
          allowUnsandboxedCommands: true,
          excludedCommands: ['git status'],
        },
        sandboxBackend: backend,
      }),
    );
    const input = { command: 'git status' };

    const output = await tool.execute(input, toolContext('Bash', input));

    // The launcher was not asked to start anything: the command ran on the host.
    expect(backend.started).toBe(0);
    expect(output.sandboxed).toBe(false);
    expect(output.sandboxReason).toBe(SANDBOX_REASONS.unsandboxedCommand);
    expect(output.sandboxReason).toBe('sandbox.allowUnsandboxedCommands is true');
    expect(output.sandboxExemptions).toEqual(['git status']);
  });

  it('refuses the command when the sandbox cannot be started and failIfUnavailable is set', async () => {
    const root = temporaryDirectory();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: { ...DEFAULT_SANDBOX_POLICY, failIfUnavailable: true },
        sandboxBackend: unavailableBackend,
      }),
    );
    const input = { command: 'printf hello' };

    await expect(tool.execute(input, toolContext('Bash', input))).rejects.toThrow(
      'the sandbox refused to run the command: sandbox backend is unavailable and sandbox.failIfUnavailable is true',
    );
  });

  it('runs the command unconfined when the sandbox cannot be started and failIfUnavailable is false', async () => {
    const root = temporaryDirectory();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: { ...DEFAULT_SANDBOX_POLICY, failIfUnavailable: false },
        sandboxBackend: unavailableBackend,
      }),
    );
    const input = { command: 'printf unconfined' };

    const output = await tool.execute(input, toolContext('Bash', input));

    expect(output.stdout).toBe('unconfined');
    expect(output.sandboxed).toBe(false);
    expect(output.sandboxReason).toBe(
      'sandbox.failIfUnavailable is false (a missing backend would run the shell unconfined)',
    );
  });

  it('never lets dangerouslyDisableSandbox skip a permission rule', async () => {
    const root = temporaryDirectory();
    const backend = recordingBackend();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ deny: ['Bash(curl *)'], allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: DEFAULT_SANDBOX_POLICY,
        sandboxBackend: backend,
      }),
    );
    const registry = createToolRegistry();
    registry.register(tool);
    const input = { command: 'curl https://example.com', dangerouslyDisableSandbox: true };

    // The call goes through the **runner**, so the runner's own order — check,
    // then validate, then execute — is what is exercised: a check that is not
    // consulted before the execution would run the command.
    const envelope = await runTool(
      registry,
      'Bash',
      input,
      toolContext('Bash', input),
      { cwd: root },
    );

    expect(envelope.isError).toBe(true);
    const content = envelope.content as { type: string; message: string; errorCode: number };
    expect(content.type).toBe('error');
    expect(content.message).toContain("Permission rule 'Bash(curl *)'");
    // The command never ran: neither in the sandbox nor on the host.
    expect(backend.started).toBe(0);
  });

  it('lets dangerouslyDisableSandbox skip the sandbox, and only the sandbox', async () => {
    const root = temporaryDirectory();
    const backend = recordingBackend();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        env: { PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'sk-s3cret' },
        sandboxPolicy: DEFAULT_SANDBOX_POLICY,
        sandboxBackend: backend,
      }),
    );
    const input = {
      command: 'echo "key=[$ANTHROPIC_API_KEY]"',
      dangerouslyDisableSandbox: true,
    };

    const output = await tool.execute(input, toolContext('Bash', input));

    expect(backend.started).toBe(0);
    expect(output.stdout).toContain('key=[]');
    // The flag does not hand the command the raw environment: the command is
    // still the agent's command.
    expect(output.stdout).not.toContain('sk-s3cret');
    expect(output.sandboxed).toBe(false);
    expect(output.sandboxReason).toMatch(/dangerouslyDisableSandbox/);
  });

  it('keeps the timeout of a command on the sandboxed path', async () => {
    const root = temporaryDirectory();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: DEFAULT_SANDBOX_POLICY,
        sandboxBackend: recordingBackend(),
      }),
    );
    const input = { command: 'sleep 30', timeout: 250 };

    const output = await tool.execute(input, toolContext('Bash', input));

    expect(output.exitCode).toBe(124);
    expect(output.stderr).toContain('ran past its timeout');
    expect(output.truncated).toBe(true);
    // The result says the command was stopped, and not only the header does.
    expect(output.timedOut).toBe(true);
  });

  it('reports the partial output of a command that ran past its timeout', async () => {
    const root = temporaryDirectory();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: DEFAULT_SANDBOX_POLICY,
        sandboxBackend: recordingBackend(),
      }),
    );
    const input = { command: 'printf partial; sleep 30', timeout: 250 };

    const output = await tool.execute(input, toolContext('Bash', input));

    // The direct path reports what the command had produced when it was
    // stopped; the sandboxed path reports the same.
    expect(output.stdout).toContain('partial');
    expect(output.exitCode).toBe(124);
    expect(output.timedOut).toBe(true);
  });

  it('reports a sandbox that never came up as not sandboxed', async () => {
    const root = temporaryDirectory();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: DEFAULT_SANDBOX_POLICY,
        sandboxBackend: recordingBackend({ established: false }),
      }),
    );
    const input = { command: 'printf hello' };

    const output = await tool.execute(input, toolContext('Bash', input));

    // The flag comes from the backend's **establishment report**: a sandbox that
    // never came up is not a sandbox.
    expect(output.sandboxed).toBe(false);
    // The reason the sandbox never came up is its own member: it is not the
    // reason the command ran outside the sandbox — it ran inside a sandbox that
    // never came up.
    expect(output.sandboxEstablishmentReason).toBe('the sandbox never came up');
    expect(output.sandboxReason).toBeUndefined();
  });

  it('caps the output of a command on the sandboxed path', async () => {
    const root = temporaryDirectory();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: DEFAULT_SANDBOX_POLICY,
        sandboxBackend: recordingBackend(),
      }),
    );
    const input = { command: 'yes x | head -c 200001' };

    const output = await tool.execute(input, toolContext('Bash', input));

    expect(output.stdout.length).toBe(200_000);
    expect(output.truncated).toBe(true);
  });

  it('caps the standard error of a command that ran past its timeout', async () => {
    const root = temporaryDirectory();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: DEFAULT_SANDBOX_POLICY,
        sandboxBackend: recordingBackend(),
      }),
    );
    const input = {
      command: "head -c 300000 /dev/zero | tr '\\0' 'x' >&2; sleep 30",
      timeout: 500,
    };

    const output = await tool.execute(input, toolContext('Bash', input));

    // The timeout message is **reserved room for**, so the reported standard
    // error never exceeds the cap and the notice is never truncated away.
    expect(output.stderr.length).toBe(MAX_BASH_OUTPUT_CHARS);
    expect(output.stderr.length).toBeLessThanOrEqual(MAX_BASH_OUTPUT_CHARS);
    // The message is **reserved room for**, so a standard error that is
    // already at the cap does not truncate it away: the notice is part of the
    // report, and the report has to survive the cap.
    expect(output.stderr.endsWith('The command was stopped because it ran past its timeout.')).toBe(true);
  });

  it('reserves room for the timeout notice on the unconfined path too', async () => {
    const root = temporaryDirectory();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        // No policy at all: the command runs on the host, unconfined.
        sandboxBackend: recordingBackend(),
      }),
    );
    const input = {
      command: "head -c 300000 /dev/zero | tr '\\0' 'x' >&2; sleep 30",
      timeout: 500,
    };

    const output = await tool.execute(input, toolContext('Bash', input));

    // The same reservation as the sandboxed path: the notice is part of the
    // report, and the report has to survive the cap.
    expect(output.stderr.length).toBe(MAX_BASH_OUTPUT_CHARS);
    expect(output.stderr.endsWith('The command was stopped because it ran past its timeout.')).toBe(true);
  });

  it.skipIf(!bubblewrapAvailable)(
    'stops the sandboxed command it reports as stopped',
    async () => {
      const root = temporaryDirectory();
      const tool = createBashTool(
        builtinDeps({
          rules: ruleSet({ allow: ['Bash'], cwd: root }),
          cwd: root,
          sandboxPolicy: DEFAULT_SANDBOX_POLICY,
          sandboxBackend: bubblewrapBackend(),
        }),
      );
      // A **distinctive** command line, so the running process can be found in
      // the host's process table. A file the command would create cannot be
      // observed: the sandboxed process writes into the sandbox's own root, not
      // the host's. Two commands, so the shell does **not** exec them away —
      // a single command is exec'd, which would drop the marker from the
      // process's arguments.
      const marker = 'claude008b-still-running-marker';
      const input = { command: `echo started; sleep 30 # ${marker}`, timeout: 300 };

      const output = await tool.execute(input, toolContext('Bash', input));

      expect(output.exitCode).toBe(124);
      expect(output.timedOut).toBe(true);

      // The report says the command was stopped. It must **be** stopped: the
      // host's process table must not still carry it.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(psOutput()).not.toContain(marker);
    },
  );

  it('does not report a sandboxed run that failed as a command that succeeded', async () => {
    const root = temporaryDirectory();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: DEFAULT_SANDBOX_POLICY,
        sandboxBackend: recordingBackend({ failWait: true }),
      }),
    );
    const input = { command: 'printf hello' };

    const output = await tool.execute(input, toolContext('Bash', input));

    // The direct path reports `127` for a command that could not be started, and
    // this is the same failure.
    expect(output.exitCode).toBe(127);
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('could not report its result');
  });
});

// --- the no-policy path ------------------------------------------------------------

describe('CC-008b — the path of a session that has no sandbox policy', () => {
  it('runs the command on the host with the filtered environment', async () => {
    const root = temporaryDirectory();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        env: { PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'sk-s3cret' },
      }),
    );
    const input = { command: 'echo "key=[$ANTHROPIC_API_KEY]"' };

    const output = await tool.execute(input, toolContext('Bash', input));

    // No sandbox at all — but the command still does not see the agent's
    // credentials: the environment is filtered against the same allowlist.
    expect(output.stdout).toContain('key=[]');
    expect(output.stdout).not.toContain('sk-s3cret');
    expect(output.sandboxed).toBe(false);
    expect(output.sandboxReason).toBe(SANDBOX_NOT_CONFIGURED_REASON);
  });

  it('never asks the backend anything, because there is no policy to evaluate', async () => {
    const root = temporaryDirectory();
    const backend = recordingBackend();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxBackend: backend,
      }),
    );
    const input = { command: 'printf hello' };

    const output = await tool.execute(input, toolContext('Bash', input));

    expect(backend.probes).toBe(0);
    expect(backend.started).toBe(0);
    expect(output.sandboxed).toBe(false);
  });
});

// --- the flag and the policy --------------------------------------------------------

describe('CC-008b — the sandbox-skip flag against the policy', () => {
  it('runs the command unconfined when the sandbox is switched off, even with the flag', async () => {
    const root = temporaryDirectory();
    const backend = recordingBackend();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: { ...DEFAULT_SANDBOX_POLICY, enabled: false },
        sandboxBackend: backend,
      }),
    );
    const input = { command: 'printf hello', dangerouslyDisableSandbox: true };

    const result = await tool.execute(input, toolContext('Bash', input));
    const output = result as { sandboxed: boolean; sandboxReason?: string; stdout: string };
    expect(output.sandboxed).toBe(false);
    expect(output.sandboxReason).toBe('sandbox.enabled is false');
    expect(output.stdout).toContain('hello');
    // The backend was never started: the policy did not sandbox the command.
    expect(backend.started).toBe(0);
  });

  it('runs the command unconfined when the platform is excluded, even with the flag', async () => {
    const root = temporaryDirectory();
    const backend = recordingBackend();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: { ...DEFAULT_SANDBOX_POLICY, enabledPlatforms: [] },
        sandboxBackend: backend,
      }),
    );
    const input = { command: 'printf hello', dangerouslyDisableSandbox: true };

    const result = await tool.execute(input, toolContext('Bash', input));
    const output = result as { sandboxed: boolean; sandboxReason?: string; stdout: string };
    expect(output.sandboxed).toBe(false);
    expect(output.sandboxReason).toBe(`sandbox.enabledPlatforms excludes ${process.platform}`);
    expect(output.stdout).toContain('hello');
    expect(backend.started).toBe(0);
  });

  it('refuses the command when the backend is missing, even with the flag', async () => {
    const root = temporaryDirectory();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: { ...DEFAULT_SANDBOX_POLICY, failIfUnavailable: true },
        sandboxBackend: unavailableBackend,
      }),
    );
    const input = { command: 'printf hello', dangerouslyDisableSandbox: true };

    await expect(tool.execute(input, toolContext('Bash', input))).rejects.toThrow(
      'the sandbox refused to run the command: sandbox backend is unavailable and sandbox.failIfUnavailable is true',
    );
  });

  it('does not read the flag from the prototype of the input', async () => {
    const root = temporaryDirectory();
    const backend = recordingBackend();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: DEFAULT_SANDBOX_POLICY,
        sandboxBackend: backend,
      }),
    );
    // The validator reads an **own** field, so the runner must read one too:
    // an inherited field is not a field the model supplied.
    const input = Object.create({ dangerouslyDisableSandbox: true }) as {
      command: string;
    };
    input.command = 'printf hello';

    const validation = await tool.validateInput(input, toolContext('Bash', input));
    expect(validation.ok).toBe(true);

    const output = await tool.execute(input, toolContext('Bash', input));

    // The sandbox is **not** skipped: the flag was never on the input.
    expect(backend.started).toBe(1);
    expect(output.sandboxed).toBe(true);
  });

  it('attaches the sandboxOverride reason kind to a call that asks for an unsandboxed run', async () => {
    const root = temporaryDirectory();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ ask: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: DEFAULT_SANDBOX_POLICY,
        sandboxBackend: recordingBackend(),
      }),
    );
    const input = { command: 'printf hello', dangerouslyDisableSandbox: true };

    const decision = await tool.checkPermissions(input, toolContext('Bash', input));

    expect(decision?.reasonKind).toBe('sandboxOverride');
    expect(describeReason(decision as PermissionDecision, 'Bash')).toBe(
      'Run outside of the sandbox',
    );
    expect(decision?.reason).toBe(SANDBOX_OVERRIDE_REASON);
  });

  it('keeps the denial reason of a call that asks for an unsandboxed run', async () => {
    const root = temporaryDirectory();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ deny: ['Bash(curl *)'], cwd: root }),
        cwd: root,
        sandboxPolicy: DEFAULT_SANDBOX_POLICY,
        sandboxBackend: recordingBackend(),
      }),
    );
    const input = { command: 'curl https://example.com', dangerouslyDisableSandbox: true };

    const decision = await tool.checkPermissions(input, toolContext('Bash', input));

    expect(decision?.behavior).toBe('deny');
    // The flag never turns a refusal into an approval, so the refusal keeps its
    // own reason.
    expect(decision?.reasonKind).not.toBe('sandboxOverride');
    expect(decision?.reason).toContain('Bash(curl *)');
  });
});

// --- the availability ----------------------------------------------------------------

describe('CC-008b — the availability of the backend', () => {
  it('probes the backend exactly once per call, and hands the answer to the launcher', async () => {
    const root = temporaryDirectory();
    const backend = recordingBackend();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: DEFAULT_SANDBOX_POLICY,
        sandboxBackend: backend,
      }),
    );
    const input = { command: 'printf hello' };

    await tool.execute(input, toolContext('Bash', input));

    // One probe: the launcher does not probe a second time, because the tool
    // hands it the answer it already has.
    expect(backend.probes).toBe(1);
    expect(backend.lastSpec?.availability).toBe('available');
  });

  it('treats a probe that throws as an unavailable backend', async () => {
    const root = temporaryDirectory();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: { ...DEFAULT_SANDBOX_POLICY, failIfUnavailable: true },
        sandboxBackend: throwingProbeBackend,
      }),
    );
    const input = { command: 'printf hello' };

    await expect(tool.execute(input, toolContext('Bash', input))).rejects.toThrow(
      'the sandbox refused to run the command: sandbox backend is unavailable and sandbox.failIfUnavailable is true',
    );
  });

  it('carries the reason and the warning of the probe into the result', async () => {
    const root = temporaryDirectory();
    const backend = recordingBackend({
      available: false,
      reason: 'the test backend is not available',
      warning: 'the unshare binary is not installed',
    });
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: { ...DEFAULT_SANDBOX_POLICY, failIfUnavailable: false },
        sandboxBackend: backend,
      }),
    );
    const input = { command: 'printf hello' };

    const output = await tool.execute(input, toolContext('Bash', input));

    expect(output.sandboxAvailability?.available).toBe(false);
    expect(output.sandboxAvailability?.reason).toBe('the test backend is not available');
    expect(output.sandboxAvailability?.warning).toBe('the unshare binary is not installed');
  });

  it('evaluates the policy against the platform the session supplies', async () => {
    const root = temporaryDirectory();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: DEFAULT_SANDBOX_POLICY,
        sandboxPlatform: 'darwin',
        sandboxBackend: recordingBackend(),
      }),
    );
    const input = { command: 'printf hello' };

    const result = await tool.execute(input, toolContext('Bash', input));
    const output = result as { sandboxed: boolean; sandboxReason?: string };
    expect(output.sandboxed).toBe(false);
    expect(output.sandboxReason).toBe('sandbox.enabledPlatforms excludes darwin');
  });

  it('does not hand the timeout to the launcher, so the tool keeps the partial output', async () => {
    const root = temporaryDirectory();
    const backend = recordingBackend();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: DEFAULT_SANDBOX_POLICY,
        sandboxBackend: backend,
      }),
    );
    const input = { command: 'printf hello', timeout: 5000 };

    await tool.execute(input, toolContext('Bash', input));

    // The launcher kills the command on its own only when it is told to, and a
    // launcher that kills it never hands the output over.
    expect(backend.lastSpec?.timeoutMs).toBeUndefined();
  });
});

// --- step 3: the policy reaches the launcher ----------------------------------------

describe('CC-008b step 3 — the policy reaches the launcher', () => {
  it('hands the sandbox policy to the launcher, so the filesystem block reaches the plan', async () => {
    const root = temporaryDirectory();
    const backend = recordingBackend();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: {
          ...DEFAULT_SANDBOX_POLICY,
          filesystem: { allowRead: ['docs'] },
        },
        sandboxBackend: backend,
      }),
    );
    const input = { command: 'printf hello' };

    await tool.execute(input, toolContext('Bash', input));

    const plan = backend.lastPlan;
    expect(plan).toBeDefined();
    const bind = plan?.mounts.find(
      (mount) => mount.kind === 'ro-bind' && mount.target === path.join(root, 'docs'),
    );
    expect(bind).toBeDefined();
  });

  it('hands the masked filesystem paths of the policy to the plan', async () => {
    const root = temporaryDirectory();
    const backend = recordingBackend();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: {
          ...DEFAULT_SANDBOX_POLICY,
          filesystem: {
            denyRead: ['secrets'],
            denyWrite: ['out'],
            credentials: ['keys'],
          },
        },
        sandboxBackend: backend,
      }),
    );
    const input = { command: 'printf hello' };

    await tool.execute(input, toolContext('Bash', input));

    // The deny lists and the credential list become **masked** paths.
    expect(backend.lastPlan?.protectedPaths).toEqual([
      path.join(root, 'secrets'),
      path.join(root, 'out'),
      path.join(root, 'keys'),
    ]);
  });

  it('reports the scope of the excludedCommands list', async () => {
    const root = temporaryDirectory();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: {
          ...DEFAULT_SANDBOX_POLICY,
          allowUnsandboxedCommands: true,
          excludedCommands: ['*'],
        },
        sandboxBackend: recordingBackend(),
      }),
    );
    const input = { command: 'printf hello' };

    const output = await tool.execute(input, toolContext('Bash', input));

    // A list that matches every command switches the sandbox off for the whole
    // command space, and the scope says so.
    expect(output.sandboxed).toBe(false);
    expect(output.sandboxExemptionScope).toBe('all');
  });

  it('reads the sandbox policy out of the settings document the loader merged', () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'project');
    const configDir = path.join(root, 'config');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify({ sandbox: { enabled: false, excludedCommands: ['git status'] } }),
    );

    const result = loadSettings({ cwd, configDir, restricted: false });

    expect(result.sandboxPolicy.enabled).toBe(false);
    expect(result.sandboxPolicy.excludedCommands).toEqual(['git status']);
  });

  it('uses the default policy when the settings document says nothing about the sandbox', () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'project');
    const configDir = path.join(root, 'config');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(configDir, { recursive: true });

    const result = loadSettings({ cwd, configDir, restricted: false });

    expect(result.sandboxPolicy).toEqual(DEFAULT_SANDBOX_POLICY);
  });

  it('takes the sandbox block from the highest tier, as a whole', () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'project');
    const configDir = path.join(root, 'config');
    mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify({ sandbox: { enabled: true } }),
    );
    writeFileSync(
      path.join(cwd, '.claude', 'settings.json'),
      JSON.stringify({ sandbox: { enabled: false, allowUnsandboxedCommands: true } }),
    );

    const result = loadSettings({ cwd, configDir, restricted: false });

    // The project tier's block wins as a whole; the user tier's block is not
    // merged into it.
    expect(result.sandboxPolicy.enabled).toBe(false);
    expect(result.sandboxPolicy.allowUnsandboxedCommands).toBe(true);
  });
});

// --- step 5: the safety ------------------------------------------------------------

describe('CC-008b step 5 — the safety of the sandboxed command', () => {
  it('does not let the sandboxed command see the agent’s credentials', async () => {
    const root = temporaryDirectory();
    const backend = recordingBackend();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        env: { PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'sk-s3cret' },
        sandboxPolicy: DEFAULT_SANDBOX_POLICY,
        sandboxBackend: backend,
      }),
    );
    const input = { command: 'echo "key=[$ANTHROPIC_API_KEY]"' };

    const output = await tool.execute(input, toolContext('Bash', input));

    expect(output.stdout).toContain('key=[]');
    expect(output.stdout).not.toContain('sk-s3cret');
  });

  it('does not let the unconfined command see the agent’s credentials either', async () => {
    const root = temporaryDirectory();
    const backend = recordingBackend();
    const command = 'echo "key=[$ANTHROPIC_API_KEY]"';
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        env: { PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'sk-s3cret' },
        sandboxPolicy: {
          ...DEFAULT_SANDBOX_POLICY,
          allowUnsandboxedCommands: true,
          excludedCommands: [command],
        },
        sandboxBackend: backend,
      }),
    );
    const input = { command };

    const output = await tool.execute(input, toolContext('Bash', input));

    expect(output.sandboxed).toBe(false);
    expect(output.stdout).toContain('key=[]');
    expect(output.stdout).not.toContain('sk-s3cret');
  });

  it('leaves the tool’s result reporting the refusal, not a bare non-zero exit', async () => {
    const root = temporaryDirectory();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        // A **refusal** is the missing backend with `failIfUnavailable` set:
        // the user asked for a sandbox and none can be provided.
        sandboxPolicy: { ...DEFAULT_SANDBOX_POLICY, failIfUnavailable: true },
        sandboxBackend: unavailableBackend,
      }),
    );
    const registry = createToolRegistry();
    registry.register(tool);
    const input = { command: 'printf hello' };

    const envelope = await runTool(
      registry,
      'Bash',
      input,
      toolContext('Bash', input),
      { cwd: root },
    );

    expect(envelope.isError).toBe(true);
    const content = envelope.content as { type: string; message: string; errorCode: number };
    expect(content.type).toBe('error');
    expect(content.message).toContain('sandbox backend is unavailable');
    expect(content.message).toContain('sandbox.failIfUnavailable is true');
    expect(content.errorCode).toBeGreaterThan(0);
    // The refusal is not reported as a command that ran and failed.
    expect(content.message).not.toMatch(/^The command exited/);
  });

  it('reports the launcher’s own refusal as a refusal, not as a crash', async () => {
    const root = temporaryDirectory();
    const missing = path.join(root, 'missing');
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        // The working directory does not exist, so the launcher refuses the
        // launch before the backend is started.
        cwd: missing,
        sandboxPolicy: DEFAULT_SANDBOX_POLICY,
        sandboxBackend: recordingBackend(),
      }),
    );
    const input = { command: 'printf hello' };

    await expect(tool.execute(input, toolContext('Bash', input))).rejects.toThrow(
      /the sandbox refused to run the command/,
    );
  });

  it.skipIf(!bubblewrapAvailable)(
    'runs the command inside the real sandbox, which never sees the credentials',
    async () => {
      const root = temporaryDirectory();
      const tool = createBashTool(
        builtinDeps({
          rules: ruleSet({ allow: ['Bash'], cwd: root }),
          cwd: root,
          env: { PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'sk-s3cret' },
          sandboxPolicy: DEFAULT_SANDBOX_POLICY,
        }),
      );
      const input = { command: 'echo "key=[$ANTHROPIC_API_KEY]"' };

      const output = await tool.execute(input, toolContext('Bash', input));

      expect(output.sandboxed).toBe(true);
      expect(output.stdout).toContain('key=[]');
      expect(output.stdout).not.toContain('sk-s3cret');
    },
  );

  it.skipIf(!bubblewrapAvailable)(
    'confines the command to the sandbox: a host path outside it is unreachable',
    async () => {
      const root = temporaryDirectory();
      // A path of the host that the sandbox does not bind: the working tree is
      // bound, the scratch directory is a private tmpfs, and nothing else is.
      const outside = temporaryDirectory();
      const secret = path.join(outside, 'secret.txt');
      writeFileSync(secret, 'the secret');
      const tool = createBashTool(
        builtinDeps({
          rules: ruleSet({ allow: ['Bash'], cwd: root }),
          cwd: root,
          env: { PATH: '/usr/bin:/bin' },
          sandboxPolicy: DEFAULT_SANDBOX_POLICY,
        }),
      );
      const input = { command: `cat ${secret}` };

      const output = await tool.execute(input, toolContext('Bash', input));

      // The command ran **inside** the sandbox, and the sandbox does not carry
      // the host's file: a plain spawn with a filtered environment would have
      // printed the secret.
      expect(output.sandboxed).toBe(true);
      expect(output.stdout).not.toContain('the secret');
      expect(output.stdout).toBe('');
      expect(output.exitCode).not.toBe(0);
    },
  );
});

// --- step 6: the header ------------------------------------------------------------

describe('CC-008b step 6 — the header of the tool', () => {
  it('no longer claims that the sandbox is not implemented', () => {
    const source = readFileSync(
      new URL('../../src/tools/builtins/bash.ts', import.meta.url),
      'utf8',
    );
    // The header is read with its line breaks flattened: the wording is the
    // point, not where the lines happen to break.
    const header = source
      .slice(0, source.indexOf('*/'))
      .replace(/^\s*\*\s?/gm, '')
      .replace(/\s+/g, ' ');

    expect(header).not.toMatch(/sandbox itself is not implemented/i);
    expect(header).toMatch(/launchSandbox/);
    expect(header).toMatch(/dangerouslyDisableSandbox/);
    expect(header).toMatch(/never skips a permission rule/i);
    // The header's claim about the flag and the policy is the code's claim.
    expect(header).toMatch(/never overrides a policy error/i);
    // The sandbox is in the production path now, so the header says so —
    // and the **code** is what carries it (the next test).
    expect(header).toMatch(/in the production path/i);
    expect(header).not.toMatch(/not in the production path/i);
  });

  it('names the wiring the session assembly carries', () => {
    // A **tripwire**, not a guard: it says the wiring is *named* in the
    // session assembly. The guard is the behavioural test below, which builds
    // a real session and checks the policy reached the model.
    // The wiring the tool's header names: the `BuiltinToolDeps` the session
    // assembly builds must carry the loaded sandbox policy, or every command
    // takes the no-policy branch and the sandbox protects nothing.
    const source = readFileSync(
      new URL('../../src/cli/command.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('sandboxPolicy: settings.sandboxPolicy');
  });

  it('describes the code it claims to describe', () => {
    const source = readFileSync(
      new URL('../../src/tools/builtins/bash.ts', import.meta.url),
      'utf8',
    );

    // A header that names a call the code never makes is a header that lies.
    expect(source).toContain('launchSandbox(');
    expect(source).toContain('evaluateSandbox(');
    // The flag is read as an own field, exactly as the validator reads it.
    expect(source).toContain("readInputField(input, 'dangerouslyDisableSandbox')");
    // Every path filters the environment through the sandbox's own filter.
    expect(source).toContain("sandboxEnvironment(spec, 'unconfined')");
  });
});

/* -------------------------------------------------------------------------- */
/* The launcher's own collection                                               */
/* -------------------------------------------------------------------------- */

describe('the launcher\'s collection', () => {
  it('caps the output at the collection point, not after it', async () => {
    const root = temporaryDirectory();
    // A command that prints far more than the cap. The cap must bound what
    // the process **holds**, not only what the caller is told.
    const launched = await launchSandbox({
      command: 'yes x | head -c 2000000',
      cwd: root,
      env: { PATH: process.env.PATH ?? '' },
      policy: { ...DEFAULT_SANDBOX_POLICY },
      platform: process.platform,
      availability: 'available',
    });

    const result = await launched.wait();
    await launched.cleanup();

    expect(result.stdout.length).toBeLessThanOrEqual(MAX_COLLECTED_OUTPUT_CHARS);
    expect(result.truncated).toBe(true);
  });

  it('never reports the readiness token as the command\'s output', async () => {
    const root = temporaryDirectory();
    const launched = await launchSandbox({
      command: 'printf PARTIAL-OUTPUT',
      cwd: root,
      env: { PATH: process.env.PATH ?? '' },
      policy: { ...DEFAULT_SANDBOX_POLICY },
      platform: process.platform,
      availability: 'available',
    });

    // The live accessor — the one a caller reads when it stops the command
    // before it ends — must not carry the launcher's own readiness token.
    const live = launched.output;
    const finished = await launched.wait();
    await launched.cleanup();

    // Whether the command's own output is in the live buffer yet depends on
    // the timing, so the assertion is about the **token** only.
    expect(live?.stdout ?? '').not.toMatch(/^[0-9a-f]{32}/);
    expect(finished.stdout).toBe('PARTIAL-OUTPUT');
  });
});

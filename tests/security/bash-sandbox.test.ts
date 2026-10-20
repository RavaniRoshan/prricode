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

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadSettings } from '../../src/config/loader.js';
import type { ToolContext } from '../../src/permissions/decision.js';
import type { RuleSet } from '../../src/permissions/rules.js';
import {
  sandboxEnvironment,
  type SandboxBackend,
  type SandboxPlan,
  type SandboxProcess,
} from '../../src/platform/sandbox/launcher.js';
import {
  DEFAULT_SANDBOX_POLICY,
  SANDBOX_REASONS,
  type SandboxPolicy,
} from '../../src/platform/sandbox/policy.js';
import { createBashTool } from '../../src/tools/builtins/bash.js';
import type { BuiltinToolDeps } from '../../src/tools/builtins/shared.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { runTool } from '../../src/tools/runner.js';

// --- the fixtures -----------------------------------------------------------------

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
  /** The plan of the last command the backend was asked to start. */
  lastPlan?: SandboxPlan;
}

/**
 * A backend that runs the command on the host.
 *
 * It applies the **filtered** environment the way the real backend does, so the
 * environment rule is exercised rather than assumed.
 */
function recordingBackend(options: { available?: boolean; established?: boolean } = {}): RecordingBackend {
  const backend: RecordingBackend = {
    name: 'test-double',
    started: 0,
    async isAvailable() {
      return { available: options.available ?? true };
    },
    async start(plan, spec): Promise<SandboxProcess> {
      backend.started += 1;
      backend.lastPlan = plan;
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
      /sandbox\.failIfUnavailable|sandbox backend is unavailable/,
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
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ deny: ['Bash(curl *)'], allow: ['Bash'], cwd: root }),
        cwd: root,
        sandboxPolicy: DEFAULT_SANDBOX_POLICY,
        sandboxBackend: recordingBackend(),
      }),
    );
    const input = { command: 'curl https://example.com', dangerouslyDisableSandbox: true };

    const decision = await tool.checkPermissions(input, toolContext('Bash', input));

    expect(decision?.behavior).toBe('deny');
    expect(decision?.reasonType).toBe('rule');
  });

  it('lets dangerouslyDisableSandbox skip the sandbox, and only the sandbox', async () => {
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
    const input = { command: 'printf hello', dangerouslyDisableSandbox: true };

    const output = await tool.execute(input, toolContext('Bash', input));

    expect(backend.started).toBe(0);
    expect(output.stdout).toBe('hello');
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
    expect(output.sandboxReason).toBe('the sandbox never came up');
  });

  it('caps the output of a command on the sandboxed path', async () => {    const root = temporaryDirectory();
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

    expect(result.sandboxPolicy?.enabled).toBe(false);
    expect(result.sandboxPolicy?.excludedCommands).toEqual(['git status']);
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
    expect(result.sandboxPolicy?.enabled).toBe(false);
    expect(result.sandboxPolicy?.allowUnsandboxedCommands).toBe(true);
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
        sandboxPolicy: { ...DEFAULT_SANDBOX_POLICY, enabledPlatforms: [] },
        sandboxBackend: recordingBackend(),
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
    expect(content.message).toContain('sandbox.enabledPlatforms excludes');
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
  });
});

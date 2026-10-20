/**
 * The `Bash` tool: run a shell command.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.5 (Permissions, "Tool
 * contract" and "Rule sources") and §2.9 ("Native and platform sandbox"), and the
 * `CC-008` and `CC-008b` milestones of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **A Bash rule matches command text, not program identity.** The research is
 * explicit: `Bash(curl *)` does not stop `/usr/bin/curl` or `sh -c 'curl …'`, and
 * the target's own documentation calls these rules "not a security boundary around
 * the program". The tool therefore does not claim any such guarantee: it hands the
 * command text to the rule engine and does what the engine says, and it does not
 * try to decide which program the shell will run.
 *
 * **A compound command is split and every part is matched independently.** That is
 * the rule engine's job, not the tool's, and the engine splits on `&&`, `||`, `;`,
 * `|`, `|&`, `&` and newlines with **no cap** on the number of parts.
 *
 * **The `dangerouslyDisableSandbox` flag is not a permission bypass.** The sandbox
 * is a separate layer from the permissions, and the flag never skips a permission
 * rule: the permission check runs on the command whether the flag is set or not.
 * The flag skips the **sandbox** and nothing else.
 *
 * **The command runs through the sandbox.** The tool resolves the session's
 * sandbox policy, asks the policy what to do with the command, and routes the
 * command accordingly:
 *
 *   - **allowed** — the command runs through `launchSandbox`, inside the sandbox
 *     the policy describes;
 *   - **unconfined** — the command runs on the host, with the **reason** the
 *     policy gave and the `excludedCommands` exemptions that applied;
 *   - **denied** — the command is **refused**, and the refusal names the reason.
 *
 * The reason strings are the target's, verbatim: `sandbox.enabledPlatforms
 * excludes <platform>`, `sandbox.enabled is false`, `sandbox.failIfUnavailable is
 * false (a missing backend would run the shell unconfined)` and
 * `sandbox.allowUnsandboxedCommands is true`. The refusal the policy produces is
 * reported as a **refusal** — a typed failure that names the reason — and never as
 * a command that ran and exited with a non-zero status.
 *
 * **The availability is probed, never assumed.** The tool asks the backend
 * whether it can run on this host, and it hands the answer to `evaluateSandbox` as
 * its fourth argument. A host with no backend is never reported as available by
 * default, so the policy's `failIfUnavailable` decides between a refusal and an
 * unconfined run.
 *
 * **Neither path sees the agent's credentials.** The sandbox filters the
 * environment against an allowlist (`PATH`, `HOME`, `LANG`, `TERM` and the
 * proxy-socket variable), and the tool applies **the same filter** to a command
 * that runs outside the sandbox: an exempt command is still the agent's command.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The command runs through `/bin/sh -c`, with the session's working directory
 *     as its directory and the **session's environment** — the `env` the session
 *     supplies, and the process environment when it supplies none. The target
 *     documents a **persistent** shell session; this implementation runs a shell per call,
 *     which is a labelled implementation choice and not a claim of equivalence.
 *   - The default timeout is `120000` ms and the maximum is `600000` ms. The audit
 *     does not pin the shell timeout. A timeout of `0` is refused: it would stop
 *     the command before it began.
 *   - The output is capped, so a command that prints without bound does not fill
 *     the context window. On the **sandboxed** path the cap is applied to the
 *     output the launcher collected, so the launcher itself buffers the whole
 *     output before the cap bites; the cap the tool reports is unchanged.
 *   - A command that runs **past its timeout** on the sandboxed path is reported
 *     with the same exit code (`124`), the same message and the same
 *     `truncated` flag as the direct path, but the output it had produced so far
 *     is not reported: the launcher hands the output over when the process ends,
 *     and a command that was stopped never ends on its own.
 *   - The **output shape** — `{ type: 'text', text, stdout, stderr, exitCode,
 *     truncated, sandboxed, sandboxReason, sandboxExemptions }` — is a reimplementation
 *     choice: the audit pins the tool-result *metadata*, not the content a tool
 *     returns. The three sandbox members report **what the sandbox did**: whether
 *     the command ran inside it, the reason it did not (when it did not), and the
 *     `excludedCommands` exemptions that applied.
 *   - A session that supplies **no** sandbox policy has no sandbox at all: the
 *     command runs the way the tool has always run it, in the session's own
 *     environment. The settings loader always supplies one
 *     (`SettingsLoadResult.sandboxPolicy`), so a configured session always has
 *     the sandbox in front of it.
 *   - The `dangerouslyDisableSandbox` flag asks for an **unconfined** run, and it
 *     does so whatever the policy says about the sandbox — a refusal to sandbox a
 *     command is not a refusal to run it. It never touches the permission layer.
 */

import { spawn } from 'node:child_process';

import { ToolExecutionError, TOOL_ERROR_CODES, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';
import {
  SandboxRefusedError,
  bubblewrapBackend,
  launchSandbox,
  sandboxEnvironment,
  type LaunchedSandbox,
  type SandboxBackend,
  type SandboxRunResult,
  type SandboxSpec,
} from '../../platform/sandbox/launcher.js';
import {
  evaluateSandbox,
  type SandboxAvailability,
} from '../../platform/sandbox/policy.js';

import {
  checkToolPermissions,
  recheckToolPermissions,
  optionalIntegerField,
  readInputField,
  rejectUnknownFields,
  requireStringField,
  type BuiltinToolDeps,
} from './shared.js';

/** The input of the `Bash` tool. */
export interface BashInput {
  /** The command to run. */
  command: string;
  /** What the command does, for the user. */
  description?: string;
  /** The timeout in milliseconds. */
  timeout?: number;
  /** Whether the sandbox is skipped. It never skips a permission rule. */
  dangerouslyDisableSandbox?: boolean;
}

/** The output of the `Bash` tool. */
export interface BashOutput {
  type: 'text';
  /** The standard output of the command. */
  text: string;
  /** The standard output of the command. */
  stdout: string;
  /** The standard error of the command. */
  stderr: string;
  /** The exit code of the command. */
  exitCode: number;
  /** Whether the output was capped. */
  truncated: boolean;
  /**
   * Whether the command ran inside the sandbox.
   *
   * It is the **backend's own report**: a sandbox that never came up reports
   * `false`, whatever the policy decided.
   */
  sandboxed: boolean;
  /** The reason the command ran outside the sandbox, when it did. */
  sandboxReason?: string;
  /** The `excludedCommands` exemptions that applied to the command. */
  sandboxExemptions?: readonly string[];
}

/** The input schema of the `Bash` tool. */
export const BASH_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'The command to run.',
    },
    description: {
      type: 'string',
      description: 'A short description of what the command does.',
    },
    timeout: {
      type: 'integer',
      minimum: 1,
      description: 'The timeout in milliseconds.',
    },
    dangerouslyDisableSandbox: {
      type: 'boolean',
      description:
        'Whether the sandbox is skipped. It never skips a permission rule; a matching deny rule still blocks the call.',
    },
  },
  required: ['command'],
  additionalProperties: false,
} as const;

/** The default timeout of a shell command. */
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;

/** The largest timeout a shell command may ask for. */
export const MAX_BASH_TIMEOUT_MS = 600_000;

/** The number of output characters the tool reports. */
export const MAX_BASH_OUTPUT_CHARS = 200_000;

/**
 * The reason a command runs outside the sandbox when the session configured none.
 *
 * The wording is this implementation's own: the audit names no reason for a session that
 * has no sandbox at all.
 */
export const SANDBOX_NOT_CONFIGURED_REASON =
  'no sandbox policy is configured for this session, so the command runs outside the sandbox';

/**
 * The reason a command runs outside the sandbox when the call asked for it.
 *
 * The wording is this implementation's own: the audit names the policy's reasons, not the
 * flag's.
 */
export const SANDBOX_SKIPPED_BY_CALL_REASON =
  'the call asked for the sandbox to be skipped (dangerouslyDisableSandbox)';

/**
 * The timeout a command runs with.
 *
 * A call that asks for no timeout gets the default, and a call that asks for more
 * than the maximum gets the maximum. A timeout of zero is **not** a timeout: it
 * would kill the command before it started, so it is refused by the validator and
 * it never reaches here.
 */
export function resolveBashTimeout(timeout: number | undefined): number {
  if (timeout === undefined || timeout <= 0) return DEFAULT_BASH_TIMEOUT_MS;
  return Math.min(timeout, MAX_BASH_TIMEOUT_MS);
}

/**
 * Run a command through the shell and collect its output.
 */
function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, truncated });
    };

    const timer = setTimeout(() => {
      truncated = true;
      child.kill('SIGKILL');
      stderr += '\nThe command was stopped because it ran past its timeout.';
      finish(124);
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length >= MAX_BASH_OUTPUT_CHARS) {
        truncated = true;
        return;
      }
      stdout += chunk;
      if (stdout.length > MAX_BASH_OUTPUT_CHARS) {
        stdout = stdout.slice(0, MAX_BASH_OUTPUT_CHARS);
        truncated = true;
      }
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length >= MAX_BASH_OUTPUT_CHARS) return;
      stderr += chunk;
      if (stderr.length > MAX_BASH_OUTPUT_CHARS) {
        stderr = stderr.slice(0, MAX_BASH_OUTPUT_CHARS);
        truncated = true;
      }
    });
    child.on('error', (error: Error) => {
      stderr += `\n${error.message}`;
      finish(127);
    });
    child.on('close', (code: number | null) => {
      finish(code ?? 0);
    });
  });
}

/**
 * The environment a command that runs **outside** the sandbox gets.
 *
 * It is the **sandbox's** filter, not a second one: an allowlist, so the agent's
 * credentials never reach the command — not even a command the policy exempts
 * from the sandbox. The home directory is the caller's own, because the unconfined
 * path runs on the host, where `/tmp` is shared and world-writable.
 */
function unconfinedEnvironment(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  return sandboxEnvironment({ command, cwd, env }, 'unconfined');
}

/**
 * Whether the backend can run on this host.
 *
 * The probe is the backend's own, and a probe that **fails** is an unavailable
 * backend: a host with no backend must never be reported as available.
 */
async function backendAvailability(backend: SandboxBackend): Promise<SandboxAvailability> {
  try {
    const probe = await backend.isAvailable();
    return probe.available ? 'available' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/**
 * The message a refusal is reported with.
 *
 * The wording is the launcher's: a refusal names the reason the policy gave.
 */
function refusalMessage(reason: string | undefined): string {
  return `the sandbox refused to run the command: ${reason ?? 'the sandbox policy refused the command'}`;
}

/**
 * Run a command **outside** the sandbox, with the reason recorded.
 *
 * The environment is the filtered one: an exempt command is still the agent's
 * command, and it must not see the agent's credentials.
 */
async function runUnconfined(
  command: string,
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  reason: string,
  exemptions?: readonly string[],
): Promise<BashOutput> {
  const result = await runCommand(
    command,
    cwd,
    timeoutMs,
    unconfinedEnvironment(command, cwd, env),
  );
  return {
    type: 'text',
    text: result.stdout,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    truncated: result.truncated,
    sandboxed: false,
    sandboxReason: reason,
    ...(exemptions === undefined ? {} : { sandboxExemptions: exemptions }),
  };
}

/**
 * Run a command **inside** the sandbox, through the launcher.
 *
 * The launcher owns the plan, the backend and the environment; the tool owns the
 * timeout, the output cap and the report. A launcher that refuses the launch
 * raises a refusal, and the refusal is reported as a refusal — never as a command
 * that ran and failed.
 */
async function runSandboxed(spec: SandboxSpec, timeoutMs: number): Promise<BashOutput> {
  let launched: LaunchedSandbox;
  try {
    launched = await launchSandbox(spec);
  } catch (error) {
    if (error instanceof SandboxRefusedError) {
      throw new ToolExecutionError(refusalMessage(error.reason), TOOL_ERROR_CODES.executionFailed);
    }
    throw error;
  }

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const result = await new Promise<SandboxRunResult>((resolve) => {
    let settled = false;
    const finish = (value: SandboxRunResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => {
      timedOut = true;
      // The command is stopped **at once**: the result is reported without
      // waiting for the process to die, exactly as the direct path reports it.
      void launched.cleanup();
      finish({ exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '' });
    }, timeoutMs);
    void launched.wait().then(finish, () =>
      finish({ exitCode: null, signal: null, stdout: '', stderr: '' }),
    );
  });

  if (!timedOut) await launched.cleanup();

  const stdout = capOutput(result.stdout);
  const stderr = capOutput(result.stderr);
  let errorText = stderr.text;
  let exitCode = result.exitCode ?? 0;
  if (timedOut) {
    exitCode = 124;
    errorText += '\nThe command was stopped because it ran past its timeout.';
  }

  return {
    type: 'text',
    text: stdout.text,
    stdout: stdout.text,
    stderr: errorText,
    exitCode,
    truncated: stdout.truncated || stderr.truncated || timedOut,
    sandboxed: launched.status.sandboxed,
    ...(launched.status.reason === undefined ? {} : { sandboxReason: launched.status.reason }),
    ...(launched.status.exemptions === undefined
      ? {}
      : { sandboxExemptions: launched.status.exemptions }),
  };
}

/**
 * Cap the output the tool reports.
 *
 * The cap is the tool's own: a command that prints without bound does not fill
 * the context window.
 */
function capOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_BASH_OUTPUT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_BASH_OUTPUT_CHARS), truncated: true };
}

/**
 * Create the `Bash` tool.
 */
export function createBashTool(deps: BuiltinToolDeps): ToolDefinition<BashInput, BashOutput> {
  return {
    name: 'Bash',
    description: 'Run a shell command.',
    inputSchema: BASH_INPUT_SCHEMA,
    mutatesFiles: false,

    async checkPermissions(_input, ctx: ToolContext) {
      return checkToolPermissions(ctx, deps);
    },

    async recheckPermission(_input, ctx: ToolContext) {
      // A hook may have rewritten the input: the **whole** check runs again on the
      // rewritten input, so the rewrite cannot escape the ask list, the allow
      // scope or the mode.
      return recheckToolPermissions(ctx, deps);
    },

    async validateInput(input) {
      const fields = rejectUnknownFields(input, [
        'command',
        'description',
        'timeout',
        'dangerouslyDisableSandbox',
      ]);
      if (!fields.ok) return fields;
      const command = requireStringField(input, 'command', {
        invalidCode: TOOL_ERROR_CODES.invalidCommand,
      });
      if (!command.ok) return command;
      const timeout = optionalIntegerField(input, 'timeout');
      if (!timeout.ok) return timeout;
      if (timeout.value === 0) {
        // A timeout of zero would stop the command before it began.
        return {
          ok: false,
          message: "The 'timeout' argument must be greater than zero.",
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      const sandbox = readInputField(input, 'dangerouslyDisableSandbox');
      if (sandbox !== undefined && sandbox !== null && typeof sandbox !== 'boolean') {
        return {
          ok: false,
          message: "The 'dangerouslyDisableSandbox' argument must be a boolean.",
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      return { ok: true };
    },

    async execute(input) {
      const timeout = resolveBashTimeout(input.timeout);
      const cwd = deps.cwd ?? process.cwd();
      const env = deps.env ?? process.env;
      const command = input.command;

      const policy = deps.sandboxPolicy;
      if (policy === undefined) {
        // No sandbox is configured for this session: the command runs the way the
        // tool has always run it, in the session's own environment.
        const result = await runCommand(command, cwd, timeout, env);
        return {
          type: 'text' as const,
          text: result.stdout,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          truncated: result.truncated,
          sandboxed: false,
          sandboxReason: SANDBOX_NOT_CONFIGURED_REASON,
        };
      }

      if (input.dangerouslyDisableSandbox === true) {
        // The flag skips the **sandbox**; it never skips a permission rule — the
        // permission check has already run on this command.
        return runUnconfined(command, cwd, timeout, env, SANDBOX_SKIPPED_BY_CALL_REASON);
      }

      const backend = deps.sandboxBackend ?? bubblewrapBackend();
      const platform = deps.sandboxPlatform ?? process.platform;
      const availability = await backendAvailability(backend);
      const evaluation = evaluateSandbox(policy, platform, command, availability);

      if (evaluation.decision === 'deny') {
        // A refusal is a refusal: it names the reason, and it is never reported
        // as a command that ran and exited with a non-zero status.
        throw new ToolExecutionError(
          refusalMessage(evaluation.reason),
          TOOL_ERROR_CODES.executionFailed,
        );
      }

      if (evaluation.decision === 'unconfined') {
        return runUnconfined(
          command,
          cwd,
          timeout,
          env,
          evaluation.reason ?? 'the sandbox policy does not sandbox the command',
          evaluation.exemptions,
        );
      }

      return runSandboxed(
        {
          command,
          cwd,
          env,
          policy,
          platform,
          availability,
          backend,
        },
        timeout,
      );
    },
  };
}

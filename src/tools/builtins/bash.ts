/**
 * The `Bash` tool: run a shell command.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.5 (Permissions, "Tool
 * contract" and "Rule sources") and the `CC-008` milestone of
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
 * is a separate layer from the permissions, and the flag never skips a rule check:
 * the permission check runs on the command whether the flag is set or not. The
 * implementation's sandbox itself is not implemented yet.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The command runs through `/bin/sh -c`, with the session's working directory
 *     as its directory and the session's environment.
 *   - The default timeout is `120000` ms and the maximum is `600000` ms. The audit
 *     does not pin the shell timeout.
 *   - The output is capped, so a command that prints without bound does not fill
 *     the context window.
 */

import { spawn } from 'node:child_process';

import { ToolExecutionError, TOOL_ERROR_CODES, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  checkToolPermissions,
  optionalIntegerField,
  readInputField,
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
      minimum: 0,
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
 * Run a command through the shell and collect its output.
 */
function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env: process.env,
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

    async validateInput(input) {
      const command = requireStringField(input, 'command', {
        invalidCode: TOOL_ERROR_CODES.invalidCommand,
      });
      if (!command.ok) return command;
      const timeout = optionalIntegerField(input, 'timeout');
      if (!timeout.ok) return timeout;
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
      const timeout = Math.min(input.timeout ?? DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS);
      const result = await runCommand(
        input.command,
        deps.cwd ?? process.cwd(),
        timeout,
      );
      return {
        type: 'text' as const,
        text: result.stdout,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        truncated: result.truncated,
      };
    },
  };
}

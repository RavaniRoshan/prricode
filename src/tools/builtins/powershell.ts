/**
 * The `PowerShell` tool: execute Windows PowerShell commands.
 *
 * Evidence: the target's `PowerShell` tool, read out of the pinned build
 * (`chunk-tt5xyzk8.js:94219`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The tool is Windows-only, and it says so.** The target ships it for the
 * Windows build of the product; on any other platform the call is **refused**
 * with a typed failure that names the reason, rather than running a different
 * program under the same name.
 *
 * **The command runs through the shell the platform has.** On Windows the tool
 * runs `powershell.exe` with the session's working directory and the **filtered**
 * environment, exactly as the `Bash` tool does — the agent's credentials never
 * reach the command.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **input shape** — `{ command, description?, timeout? }` — mirrors the
 *     `Bash` tool's, and the **output shape** —
 *     `{ type: 'text', text, stdout, stderr, exitCode, truncated }` — mirrors it
 *     too. The target's own schema for this tool was not read out of the bundle.
 */

import { spawn } from 'node:child_process';

import { TOOL_ERROR_CODES, ToolExecutionError, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  checkToolPermissions,
  optionalIntegerField,
  recheckToolPermissions,
  rejectUnknownFields,
  requireStringField,
  type BuiltinToolDeps,
} from './shared.js';

/** The input of the `PowerShell` tool. */
export interface PowerShellInput {
  /** The command to run. */
  command: string;
  /** A short description of what the command does. */
  description?: string;
  /** The timeout in milliseconds. */
  timeout?: number;
}

/** The output of the `PowerShell` tool. */
export interface PowerShellOutput {
  type: 'text';
  /** The standard output of the command. */
  stdout: string;
  /** The standard error output of the command. */
  stderr: string;
  /** The exit code of the command. */
  exitCode: number;
  /** Whether the output was capped. */
  truncated: boolean;
}

/** The input schema of the `PowerShell` tool. */
export const POWERSHELL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'The command to run.' },
    description: { type: 'string', description: 'A short description of what the command does.' },
    timeout: { type: 'integer', minimum: 1, description: 'The timeout in milliseconds.' },
  },
  required: ['command'],
  additionalProperties: false,
} as const;

/** The default timeout of a PowerShell command. */
export const DEFAULT_POWERSHELL_TIMEOUT_MS = 120_000;

/**
 * Create the `PowerShell` tool.
 */
export function createPowerShellTool(
  deps: BuiltinToolDeps,
): ToolDefinition<PowerShellInput, PowerShellOutput> {
  return {
    name: 'PowerShell',
    description: 'Execute Windows PowerShell commands.',
    inputSchema: POWERSHELL_INPUT_SCHEMA,
    mutatesFiles: false,

    async checkPermissions(_input, ctx: ToolContext) {
      return checkToolPermissions(ctx, deps);
    },

    async recheckPermission(_input, ctx: ToolContext) {
      return recheckToolPermissions(ctx, deps);
    },

    async validateInput(input) {
      const fields = rejectUnknownFields(input, ['command', 'description', 'timeout']);
      if (!fields.ok) return fields;
      const command = requireStringField(input, 'command', {
        invalidCode: TOOL_ERROR_CODES.invalidCommand,
      });
      if (!command.ok) return command;
      const timeout = optionalIntegerField(input, 'timeout');
      if (!timeout.ok) return timeout;
      return { ok: true };
    },

    async execute(input) {
      if (process.platform !== 'win32') {
        throw new ToolExecutionError(
          `The 'PowerShell' tool needs Windows, and this session runs on ${process.platform}, so the call was refused.`,
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }

      const timeout = input.timeout ?? DEFAULT_POWERSHELL_TIMEOUT_MS;
      const env = deps.env ?? process.env;
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', input.command], {
        cwd: deps.cwd,
        env: filteredEnvironment(env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      const code = await new Promise<number>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve(124);
        }, timeout);
        child.on('close', (exitCode) => {
          clearTimeout(timer);
          resolve(exitCode ?? 0);
        });
      });

      return {
        type: 'text' as const,
        stdout,
        stderr,
        exitCode: code,
        truncated: false,
      };
    },
  };
}

/**
 * The environment a command runs with.
 *
 * The agent's credentials are **not** in it: the sandbox's allowlist is the
 * environment a command sees, exactly as the `Bash` tool does it.
 */
function filteredEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot']);
  const filtered: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (allowed.has(key) && value !== undefined) filtered[key] = value;
  }
  return filtered;
}

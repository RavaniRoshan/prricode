/**
 * The `Monitor` tool: watch a process, a log, a command or a WebSocket.
 *
 * Evidence: the target's `Monitor` tool, read out of the pinned build
 * (`chunk-3f441cda.js:14752`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own output shape, reproduced.** The target answers with
 * `{ taskId, timeoutMs, persistent? }`.
 *
 * **The monitor is a capability.** A monitor is a background process whose output
 * is streamed as live notifications, and the session hands the tool its monitor
 * through `capabilities.monitor`; a session that supplies none gets a **typed
 * refusal**.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **input shape** — `{ command, description?, timeout_ms?, persistent? }`
 *     — is an implementation choice: the target's own schema for this tool was
 *     not read out of the bundle, and the target's own description names a
 *     process, a log, a command and a WebSocket as the things it watches.
 *   - The **output shape** — `{ type: 'text', text, taskId, timeoutMs,
 *     persistent? }` — is an implementation choice.
 */

import { TOOL_ERROR_CODES, ToolExecutionError, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  checkToolPermissions,
  optionalBooleanField,
  optionalIntegerField,
  recheckToolPermissions,
  rejectUnknownFields,
  requireStringField,
  type BuiltinToolDeps,
} from './shared.js';

/** The input of the `Monitor` tool. */
export interface MonitorInput {
  /** The command, log or WebSocket to watch. */
  command: string;
  /** What the monitor is for. */
  description?: string;
  /** The timeout in milliseconds. */
  timeout_ms?: number;
  /** Whether the monitor runs until it is stopped. */
  persistent?: boolean;
}

/** The output of the `Monitor` tool. */
export interface MonitorOutput {
  type: 'text';
  /** A short report of what was started. */
  text: string;
  /** The id of the background monitor task. */
  taskId: string;
  /** The timeout deadline in milliseconds. */
  timeoutMs: number;
  /** Whether the monitor runs until it is stopped. */
  persistent?: boolean;
}

/** The input schema of the `Monitor` tool. */
export const MONITOR_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'The command, log or WebSocket to watch.',
    },
    description: {
      type: 'string',
      description: 'What the monitor is for.',
    },
    timeout_ms: {
      type: 'integer',
      minimum: 0,
      description: 'Timeout deadline in milliseconds (0 when persistent).',
    },
    persistent: {
      type: 'boolean',
      description: 'No timeout — runs until TaskStop or session end.',
    },
  },
  required: ['command'],
  additionalProperties: false,
} as const;

/**
 * Create the `Monitor` tool.
 */
export function createMonitorTool(deps: BuiltinToolDeps): ToolDefinition<MonitorInput, MonitorOutput> {
  return {
    name: 'Monitor',
    description:
      'Watch, monitor, or keep an eye on a process, log or command — stream each stdout line as a live notification.',
    inputSchema: MONITOR_INPUT_SCHEMA,
    mutatesFiles: false,

    async checkPermissions(_input, ctx: ToolContext) {
      return checkToolPermissions(ctx, deps);
    },

    async recheckPermission(_input, ctx: ToolContext) {
      return recheckToolPermissions(ctx, deps);
    },

    async validateInput(input) {
      const fields = rejectUnknownFields(input, ['command', 'description', 'timeout_ms', 'persistent']);
      if (!fields.ok) return fields;
      const command = requireStringField(input, 'command', {
        invalidCode: TOOL_ERROR_CODES.invalidCommand,
      });
      if (!command.ok) return command;
      const timeout = optionalIntegerField(input, 'timeout_ms');
      if (!timeout.ok) return timeout;
      const persistent = optionalBooleanField(input, 'persistent');
      if (!persistent.ok) return persistent;
      return { ok: true };
    },

    async execute(input) {
      const monitor = deps.capabilities?.monitor;
      if (monitor === undefined) {
        throw new ToolExecutionError(
          "The 'Monitor' tool needs a monitor that can stream a process's output, which this session does not have, so the call was refused.",
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }
      const started = await monitor({
        command: input.command,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.timeout_ms === undefined ? {} : { timeoutMs: input.timeout_ms }),
        ...(input.persistent === undefined ? {} : { persistent: input.persistent }),
      });
      return {
        type: 'text' as const,
        text: `Monitoring task ${started.taskId}.`,
        taskId: started.taskId,
        timeoutMs: started.timeoutMs,
        ...(started.persistent === undefined ? {} : { persistent: started.persistent }),
      };
    },
  };
}

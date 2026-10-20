/**
 * The `TaskStop` tool: kill a running background task.
 *
 * Evidence: the target's `TaskStop` tool, read out of the pinned build
 * (`chunk-705mhzj8.js:26819`, with its aliases at `chunk-qpgrz24m.js:8011`), and
 * the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own input shape, reproduced.** The schema takes an optional
 * `task_id` and a **deprecated** optional `shell_id`; the tool reads either, and
 * refuses a call that names neither.
 *
 * **The target's own output shape, reproduced.** The target answers with
 * `{ message, task_id, task_type, command? }`.
 *
 * **The aliases are the target's.** The target declares `aliases: ["KillShell",
 * "KillBash"]`, and the alias table maps both of them to `TaskStop`.
 *
 * **The background tasks are a capability.** The tasks that run in the background
 * belong to the session's shell, and the session hands the tool its registry
 * through `capabilities.backgroundTasks`. A session that supplies none gets a
 * **typed refusal**: there is nothing here that could be stopped.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, message, task_id, task_type,
 *     command? }` — is an implementation choice: the audit pins the tool-result
 *     *metadata*, not the content a tool returns.
 */

import { TOOL_ERROR_CODES, ToolExecutionError, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  checkToolPermissions,
  readInputField,
  recheckToolPermissions,
  rejectUnknownFields,
  type BuiltinToolDeps,
} from './shared.js';

/** The input of the `TaskStop` tool. */
export interface TaskStopInput {
  /** The ID of the background task to stop. */
  task_id?: string;
  /** Deprecated: use `task_id` instead. */
  shell_id?: string;
}

/** The output of the `TaskStop` tool. */
export interface TaskStopOutput {
  type: 'text';
  /** A short report of what happened. */
  text: string;
  /** The status message about the operation. */
  message: string;
  /** The id of the task that was stopped. */
  task_id: string;
  /** The type of the task that was stopped. */
  task_type: string;
  /** The command or description of the stopped task. */
  command?: string;
}

/** The input schema of the `TaskStop` tool. */
export const TASKSTOP_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    task_id: {
      type: 'string',
      description: 'The ID of the background task to stop.',
    },
    shell_id: {
      type: 'string',
      description: 'Deprecated: use task_id instead.',
    },
  },
  required: [],
  additionalProperties: false,
} as const;

/**
 * Create the `TaskStop` tool.
 */
export function createTaskStopTool(
  deps: BuiltinToolDeps,
): ToolDefinition<TaskStopInput, TaskStopOutput> {
  return {
    name: 'TaskStop',
    description: 'Kill a running background task.',
    inputSchema: TASKSTOP_INPUT_SCHEMA,
    mutatesFiles: false,

    isConcurrencySafe(): boolean {
      return true;
    },

    async checkPermissions(_input, ctx: ToolContext) {
      return checkToolPermissions(ctx, deps);
    },

    async recheckPermission(_input, ctx: ToolContext) {
      return recheckToolPermissions(ctx, deps);
    },

    async validateInput(input) {
      const fields = rejectUnknownFields(input, ['task_id', 'shell_id']);
      if (!fields.ok) return fields;
      const taskId = readInputField(input, 'task_id');
      const shellId = readInputField(input, 'shell_id');
      if (taskId === undefined && shellId === undefined) {
        return {
          ok: false,
          message: 'Missing required parameter: task_id',
          errorCode: TOOL_ERROR_CODES.missingField,
        };
      }
      return { ok: true };
    },

    async execute(input) {
      const registry = deps.capabilities?.backgroundTasks;
      if (registry === undefined) {
        throw new ToolExecutionError(
          "The 'TaskStop' tool needs a registry of background tasks, which this session does not have, so the call was refused.",
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }

      const taskId =
        typeof input.task_id === 'string' && input.task_id.length > 0
          ? input.task_id
          : typeof input.shell_id === 'string'
            ? input.shell_id
            : '';

      const task = registry.get(taskId);
      if (task === undefined) {
        throw new ToolExecutionError(
          `No background task with task ID ${taskId}.`,
          TOOL_ERROR_CODES.notFound,
        );
      }

      const stopped = await registry.stop(taskId);
      if (!stopped) {
        throw new ToolExecutionError(
          `The background task ${taskId} could not be stopped.`,
          TOOL_ERROR_CODES.executionFailed,
        );
      }

      return {
        type: 'text' as const,
        text: `Stopped task ${taskId}.`,
        message: `Stopped task ${taskId}.`,
        task_id: taskId,
        task_type: 'shell',
        ...(task.command === undefined ? {} : { command: task.command }),
      };
    },
  };
}

/**
 * The `GetTask` tool: check on a background shell command by task ID.
 *
 * Evidence: the target's `GetTask` tool, read out of the pinned build
 * (`chunk-705mhzj8.js:90402`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own input shape, reproduced.** The schema takes a `taskId` —
 * "The taskId from the result that moved the command to the background".
 *
 * **The background tasks are a capability.** The session hands the tool its
 * registry through `capabilities.backgroundTasks`; a session that supplies none
 * gets a **typed refusal**.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, taskId, state, output,
 *     exitCode? }` — is an implementation choice: the audit pins the tool-result
 *     *metadata*, not the content a tool returns.
 */

import { TOOL_ERROR_CODES, ToolExecutionError, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  checkToolPermissions,
  recheckToolPermissions,
  rejectUnknownFields,
  requireStringField,
  type BuiltinToolDeps,
} from './shared.js';

/** The input of the `GetTask` tool. */
export interface GetTaskInput {
  /** The id of the background task. */
  taskId: string;
}

/** The output of the `GetTask` tool. */
export interface GetTaskOutput {
  type: 'text';
  /** A short report of what the task is doing. */
  text: string;
  /** The id of the task. */
  taskId: string;
  /** The task's state. */
  state: string;
  /** What the task printed. */
  output: string;
  /** The task's exit code, when it has one. */
  exitCode?: number;
}

/** The input schema of the `GetTask` tool. */
export const GETTASK_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    taskId: {
      type: 'string',
      description: 'The taskId from the result that moved the command to the background.',
    },
  },
  required: ['taskId'],
  additionalProperties: false,
} as const;

/**
 * Create the `GetTask` tool.
 */
export function createGetTaskTool(deps: BuiltinToolDeps): ToolDefinition<GetTaskInput, GetTaskOutput> {
  return {
    name: 'GetTask',
    description: 'Check on a background shell command by task ID.',
    inputSchema: GETTASK_INPUT_SCHEMA,
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
      const fields = rejectUnknownFields(input, ['taskId']);
      if (!fields.ok) return fields;
      const taskId = requireStringField(input, 'taskId', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
      });
      if (!taskId.ok) return taskId;
      return { ok: true };
    },

    async execute(input) {
      const registry = deps.capabilities?.backgroundTasks;
      if (registry === undefined) {
        throw new ToolExecutionError(
          "The 'GetTask' tool needs a registry of background tasks, which this session does not have, so the call was refused.",
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }
      const task = registry.get(input.taskId);
      if (task === undefined) {
        throw new ToolExecutionError(
          `No background command with task ID ${input.taskId}.`,
          TOOL_ERROR_CODES.notFound,
        );
      }
      return {
        type: 'text' as const,
        text: `Task ${input.taskId} is ${task.state}.`,
        taskId: input.taskId,
        state: task.state,
        output: task.output ?? '',
        ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
      };
    },
  };
}

/**
 * The `TaskGet` tool: retrieve a task by ID.
 *
 * Evidence: the target's `TaskGet` tool, read out of the pinned build
 * (`chunk-705mhzj8.js:140904`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own input and output shapes, reproduced.** The schema takes a
 * `taskId`, and the target answers with the task — `id`, `subject`,
 * `description`, `status`, `blocks` and `blockedBy` — or with a **null** task
 * when there is none.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, task }` — is an implementation
 *     choice: the audit pins the tool-result *metadata*, not the content a tool
 *     returns.
 */

import { TOOL_ERROR_CODES, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  checkToolPermissions,
  recheckToolPermissions,
  rejectUnknownFields,
  requireStringField,
  type BuiltinToolDeps,
} from './shared.js';
import { TaskStore, type Task } from './taskstore.js';

/** The input of the `TaskGet` tool. */
export interface TaskGetInput {
  /** The ID of the task to retrieve. */
  taskId: string;
}

/** The output of the `TaskGet` tool. */
export interface TaskGetOutput {
  type: 'text';
  /** A short report of what was found. */
  text: string;
  /** The task, or `null` when there is none. */
  task: Omit<Task, 'activeForm' | 'owner' | 'metadata'> | null;
}

/** The input schema of the `TaskGet` tool. */
export const TASKGET_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    taskId: {
      type: 'string',
      description: 'The ID of the task to retrieve.',
    },
  },
  required: ['taskId'],
  additionalProperties: false,
} as const;

/**
 * Create the `TaskGet` tool.
 */
export function createTaskGetTool(deps: BuiltinToolDeps): ToolDefinition<TaskGetInput, TaskGetOutput> {
  const store = deps.stores?.tasks ?? new TaskStore();

  return {
    name: 'TaskGet',
    description: 'Retrieve a task by ID.',
    inputSchema: TASKGET_INPUT_SCHEMA,
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
      const task = store.get(input.taskId);
      if (task === undefined) {
        return {
          type: 'text' as const,
          text: 'Task not found',
          task: null,
        };
      }
      return {
        type: 'text' as const,
        text: `Task #${task.id}: ${task.subject}`,
        task: {
          id: task.id,
          subject: task.subject,
          description: task.description,
          status: task.status,
          blocks: task.blocks,
          blockedBy: task.blockedBy,
        },
      };
    },
  };
}

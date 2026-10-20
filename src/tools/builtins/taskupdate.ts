/**
 * The `TaskUpdate` tool: update a task.
 *
 * Evidence: the target's `TaskUpdate` tool, read out of the pinned build
 * (`chunk-705mhzj8.js:145216`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own input and output shapes, reproduced.** The schema takes a
 * `taskId` and the fields to change — `subject`, `description`, `activeForm`,
 * `status`, `addBlocks`, `addBlockedBy`, `owner` and `metadata` — and the target
 * answers with `{ success, taskId, updatedFields, error?, statusChange? }`.
 *
 * **A task that does not exist is not an error the call can fix.** The target
 * answers with `success: false` and the error `Task not found`; this
 * implementation answers the same way rather than throwing.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, success, taskId,
 *     updatedFields, error? }` — is an implementation choice: the audit pins the
 *     tool-result *metadata*, not the content a tool returns.
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
import { TaskStore, type TaskStatus } from './taskstore.js';

/** The input of the `TaskUpdate` tool. */
export interface TaskUpdateInput {
  /** The ID of the task to update. */
  taskId: string;
  /** The new title. */
  subject?: string;
  /** The new description. */
  description?: string;
  /** The new present continuous form. */
  activeForm?: string;
  /** The new status. */
  status?: TaskStatus;
  /** The ids of the tasks this task blocks. */
  addBlocks?: string[];
  /** The ids of the tasks that block this task. */
  addBlockedBy?: string[];
  /** The new owner. */
  owner?: string;
  /** The metadata keys to merge into the task. A null value deletes the key. */
  metadata?: Record<string, unknown>;
}

/** The output of the `TaskUpdate` tool. */
export interface TaskUpdateOutput {
  type: 'text';
  /** A short report of what happened. */
  text: string;
  /** Whether the task was updated. */
  success: boolean;
  /** The id of the task. */
  taskId: string;
  /** The fields that changed. */
  updatedFields: string[];
  /** Why the task was not updated. */
  error?: string;
}

/** The input schema of the `TaskUpdate` tool. */
export const TASKUPDATE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    taskId: { type: 'string', description: 'The ID of the task to update.' },
    subject: { type: 'string', description: 'New subject for the task.' },
    description: { type: 'string', description: 'New description for the task.' },
    activeForm: {
      type: 'string',
      description:
        'Present continuous form shown in spinner when in_progress (e.g., "Running tests").',
    },
    status: {
      type: 'string',
      enum: ['pending', 'in_progress', 'completed', 'deleted'],
      description: 'New status for the task.',
    },
    addBlocks: {
      type: 'array',
      items: { type: 'string' },
      description: 'Task IDs that this task blocks.',
    },
    addBlockedBy: {
      type: 'array',
      items: { type: 'string' },
      description: 'Task IDs that block this task.',
    },
    owner: { type: 'string', description: 'New owner for the task.' },
    metadata: {
      type: 'object',
      description: 'Metadata keys to merge into the task. Set a key to null to delete it.',
      additionalProperties: true,
    },
  },
  required: ['taskId'],
  additionalProperties: false,
} as const;

/**
 * Create the `TaskUpdate` tool.
 */
export function createTaskUpdateTool(
  deps: BuiltinToolDeps,
): ToolDefinition<TaskUpdateInput, TaskUpdateOutput> {
  const store = deps.stores?.tasks ?? new TaskStore();

  return {
    name: 'TaskUpdate',
    description: 'Update a task.',
    inputSchema: TASKUPDATE_INPUT_SCHEMA,
    mutatesFiles: false,

    async checkPermissions(_input, ctx: ToolContext) {
      return checkToolPermissions(ctx, deps);
    },

    async recheckPermission(_input, ctx: ToolContext) {
      return recheckToolPermissions(ctx, deps);
    },

    async validateInput(input) {
      const fields = rejectUnknownFields(input, [
        'taskId',
        'subject',
        'description',
        'activeForm',
        'status',
        'addBlocks',
        'addBlockedBy',
        'owner',
        'metadata',
      ]);
      if (!fields.ok) return fields;
      const taskId = requireStringField(input, 'taskId', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
      });
      if (!taskId.ok) return taskId;
      return { ok: true };
    },

    async execute(input) {
      const result = store.update(input.taskId, {
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.activeForm === undefined ? {} : { activeForm: input.activeForm }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.addBlocks === undefined ? {} : { addBlocks: input.addBlocks }),
        ...(input.addBlockedBy === undefined ? {} : { addBlockedBy: input.addBlockedBy }),
        ...(input.owner === undefined ? {} : { owner: input.owner }),
        ...(input.metadata === undefined
          ? {}
          : { metadata: input.metadata as Record<string, unknown | null> }),
      });

      if (result === undefined) {
        return {
          type: 'text' as const,
          text: `Task ${input.taskId} was not found, so it was not updated.`,
          success: false,
          taskId: input.taskId,
          updatedFields: [],
          error: 'Task not found',
        };
      }

      return {
        type: 'text' as const,
        text: `Updated task ${input.taskId}.`,
        success: true,
        taskId: input.taskId,
        updatedFields: result.updatedFields,
      };
    },
  };
}

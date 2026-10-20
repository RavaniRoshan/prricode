/**
 * The `TaskList` tool: list all tasks.
 *
 * Evidence: the target's `TaskList` tool, read out of the pinned build
 * (`chunk-705mhzj8.js:150065`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own input and output shapes, reproduced.** The schema takes no
 * arguments, and the target answers with the tasks — `id`, `subject`, `status`,
 * an optional `owner` and `blockedBy`.
 *
 * **A dependency that is completed is not reported as a blocker.** The target
 * filters the `blockedBy` list against the ids of the completed tasks, and this
 * implementation does the same.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, tasks }` — is an implementation
 *     choice: the audit pins the tool-result *metadata*, not the content a tool
 *     returns.
 */

import { type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  checkToolPermissions,
  recheckToolPermissions,
  rejectUnknownFields,
  type BuiltinToolDeps,
} from './shared.js';
import { TaskStore, type TaskStatus } from './taskstore.js';

/** One task of the `TaskList` tool. */
export interface TaskListEntry {
  /** The task's id. */
  id: string;
  /** The task's title. */
  subject: string;
  /** Where the task stands. */
  status: TaskStatus;
  /** Who owns the task. */
  owner?: string;
  /** The ids of the tasks that block this one. */
  blockedBy: string[];
}

/** The input of the `TaskList` tool. */
export interface TaskListInput {
  /** The tool takes no arguments. */
  readonly?: never;
}

/** The output of the `TaskList` tool. */
export interface TaskListOutput {
  type: 'text';
  /** A short report of what was found. */
  text: string;
  /** The tasks. */
  tasks: TaskListEntry[];
}

/** The input schema of the `TaskList` tool. */
export const TASKLIST_INPUT_SCHEMA = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
} as const;

/**
 * Create the `TaskList` tool.
 */
export function createTaskListTool(
  deps: BuiltinToolDeps,
): ToolDefinition<TaskListInput, TaskListOutput> {
  const store = deps.stores?.tasks ?? new TaskStore();

  return {
    name: 'TaskList',
    description: 'List all tasks.',
    inputSchema: TASKLIST_INPUT_SCHEMA,
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
      return rejectUnknownFields(input, []);
    },

    async execute() {
      const tasks = store.list();
      const completed = new Set(
        tasks.filter((task) => task.status === 'completed').map((task) => task.id),
      );
      return {
        type: 'text' as const,
        text:
          tasks.length === 0
            ? 'No tasks found'
            : `Found ${tasks.length} task${tasks.length === 1 ? '' : 's'}.`,
        tasks: tasks.map((task) => ({
          id: task.id,
          subject: task.subject,
          status: task.status,
          ...(task.owner === undefined ? {} : { owner: task.owner }),
          blockedBy: task.blockedBy.filter((id) => !completed.has(id)),
        })),
      };
    },
  };
}

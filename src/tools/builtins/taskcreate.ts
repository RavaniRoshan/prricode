/**
 * The `TaskCreate` tool: create a task in the task list.
 *
 * Evidence: the target's `TaskCreate` tool, read out of the pinned build
 * (`chunk-705mhzj8.js:138696`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own input shape, reproduced.** The schema takes a `subject` (a
 * brief title), a `description` (what needs to be done), an optional `activeForm`
 * (the present continuous form shown while the task is in progress) and an
 * optional `metadata` map.
 *
 * **The target's own output shape, reproduced.** The target answers with
 * `{ task: { id, subject } }` — the id and the subject, and nothing else.
 *
 * **The list is session state.** The task is written into the session's task
 * store, which `TaskGet`, `TaskList` and `TaskUpdate` read.
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
import { TaskStore } from './taskstore.js';

/** The input of the `TaskCreate` tool. */
export interface TaskCreateInput {
  /** A brief title for the task. */
  subject: string;
  /** What needs to be done. */
  description: string;
  /** The present continuous form, shown while the task is in progress. */
  activeForm?: string;
  /** Arbitrary metadata to attach to the task. */
  metadata?: Record<string, unknown>;
}

/** The output of the `TaskCreate` tool. */
export interface TaskCreateOutput {
  type: 'text';
  /** A short report of what was created. */
  text: string;
  /** The task that was created. */
  task: { id: string; subject: string };
}

/** The input schema of the `TaskCreate` tool. */
export const TASKCREATE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    subject: {
      type: 'string',
      description: 'A brief title for the task.',
    },
    description: {
      type: 'string',
      description: 'What needs to be done.',
    },
    activeForm: {
      type: 'string',
      description:
        'Present continuous form shown in spinner when in_progress (e.g., "Running tests").',
    },
    metadata: {
      type: 'object',
      description: 'Arbitrary metadata to attach to the task.',
      additionalProperties: true,
    },
  },
  required: ['subject', 'description'],
  additionalProperties: false,
} as const;

/**
 * Create the `TaskCreate` tool.
 */
export function createTaskCreateTool(
  deps: BuiltinToolDeps,
): ToolDefinition<TaskCreateInput, TaskCreateOutput> {
  const store = deps.stores?.tasks ?? new TaskStore();

  return {
    name: 'TaskCreate',
    description: 'Create a task in the task list.',
    inputSchema: TASKCREATE_INPUT_SCHEMA,
    mutatesFiles: false,

    async checkPermissions(_input, ctx: ToolContext) {
      return checkToolPermissions(ctx, deps);
    },

    async recheckPermission(_input, ctx: ToolContext) {
      return recheckToolPermissions(ctx, deps);
    },

    async validateInput(input) {
      const fields = rejectUnknownFields(input, ['subject', 'description', 'activeForm', 'metadata']);
      if (!fields.ok) return fields;
      const subject = requireStringField(input, 'subject', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
      });
      if (!subject.ok) return subject;
      const description = requireStringField(input, 'description', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
      });
      if (!description.ok) return description;
      return { ok: true };
    },

    async execute(input) {
      const task = store.create({
        subject: input.subject,
        description: input.description,
        ...(input.activeForm === undefined ? {} : { activeForm: input.activeForm }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      });
      return {
        type: 'text' as const,
        text: `Created task #${task.id}: ${task.subject}.`,
        task: { id: task.id, subject: task.subject },
      };
    },
  };
}

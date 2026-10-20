/**
 * The `TodoWrite` tool: record the task list.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.4 (Agent loop and tool
 * dispatch) and the `CC-008` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The todo list is state, not a file.** The tool keeps the list it was given and
 * reports it back; where a session persists it is the session store's business, and
 * the `CC-009` milestone owns that.
 *
 * The tool writes nothing to the filesystem, so it is **not** file-mutating: the
 * observed file-mutating set is exactly `["Edit", "Write", "NotebookEdit"]`.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The statuses are exactly `pending`, `in_progress` and `completed`. The audit
 *     does not name them, so this implementation does not claim them.
 *   - The list is a **recorder**, not a scheduler: a list with two items in
 *     progress is recorded, not refused. The target accepts it, and a stricter
 *     tool would be a false refusal.
 *   - The **output shape** — `{ type: 'text', text, todos }` — is a implementation choice:
 *     the audit pins the tool-result *metadata*, not the content a tool returns.
 */

import { TOOL_ERROR_CODES, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  checkToolPermissions,
  denyDecisionFor,
  readInputField,
  rejectUnknownFields,
  type BuiltinToolDeps,
} from './shared.js';

/** The status of a todo item. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** One item of the todo list. */
export interface Todo {
  /** What the item is. */
  content: string;
  /** Where the item stands. */
  status: TodoStatus;
  /** The present continuous form of the item. */
  activeForm: string;
}

/** The input of the `TodoWrite` tool. */
export interface TodoWriteInput {
  /** The list. */
  todos: Todo[];
}

/** The output of the `TodoWrite` tool. */
export interface TodoWriteOutput {
  type: 'text';
  /** A short report of what was recorded. */
  text: string;
  /** The list that was recorded. */
  todos: Todo[];
}

/** The input schema of the `TodoWrite` tool. */
export const TODOWRITE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      description: 'The list of the items, each with a content, a status and an active form.',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          activeForm: { type: 'string' },
        },
        required: ['content', 'status', 'activeForm'],
        additionalProperties: false,
      },
    },
  },
  required: ['todos'],
  additionalProperties: false,
} as const;

/** The statuses a todo item may carry. */
const TODO_STATUSES: ReadonlySet<string> = new Set<TodoStatus>([
  'pending',
  'in_progress',
  'completed',
]);

/**
 * Create the `TodoWrite` tool.
 */
export function createTodoWriteTool(
  deps: BuiltinToolDeps,
): ToolDefinition<TodoWriteInput, TodoWriteOutput> {
  return {
    name: 'TodoWrite',
    description: 'Record the list of the tasks that are being worked on.',
    inputSchema: TODOWRITE_INPUT_SCHEMA,
    mutatesFiles: false,

    async checkPermissions(_input, ctx: ToolContext) {
      return checkToolPermissions(ctx, deps);
    },

    async recheckDeny(_input, ctx: ToolContext) {
      // A hook may have rewritten the input onto a call the deny list covers.
      return denyDecisionFor(ctx, deps);
    },

    async validateInput(input) {
      const fields = rejectUnknownFields(input, ['todos']);
      if (!fields.ok) return fields;
      const todos = readInputField(input, 'todos');
      if (todos === undefined || todos === null) {
        return {
          ok: false,
          message: "The 'todos' argument is required.",
          errorCode: TOOL_ERROR_CODES.missingField,
        };
      }
      if (!Array.isArray(todos)) {
        return {
          ok: false,
          message: "The 'todos' argument must be an array.",
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      if (todos.length === 0) {
        return {
          ok: false,
          message: "The 'todos' argument must not be empty.",
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }

      for (const entry of todos) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          return {
            ok: false,
            message: 'Every item of the todo list must be an object.',
            errorCode: TOOL_ERROR_CODES.invalidInput,
          };
        }
        const itemFields = rejectUnknownFields(entry, ['content', 'status', 'activeForm']);
        if (!itemFields.ok) return itemFields;
        const content = readInputField(entry, 'content');
        const status = readInputField(entry, 'status');
        const activeForm = readInputField(entry, 'activeForm');
        if (typeof content !== 'string' || content.length === 0) {
          return {
            ok: false,
            message: "Every item of the todo list needs a non-empty 'content'.",
            errorCode: TOOL_ERROR_CODES.invalidInput,
          };
        }
        if (typeof status !== 'string' || !TODO_STATUSES.has(status)) {
          return {
            ok: false,
            message: "Every item of the todo list needs a 'status' of pending, in_progress or completed.",
            errorCode: TOOL_ERROR_CODES.invalidInput,
          };
        }
        if (typeof activeForm !== 'string' || activeForm.length === 0) {
          return {
            ok: false,
            message: "Every item of the todo list needs a non-empty 'activeForm'.",
            errorCode: TOOL_ERROR_CODES.invalidInput,
          };
        }
      }

      return { ok: true };
    },

    async execute(input) {
      const todos = input.todos.map((todo) => ({
        content: todo.content,
        status: todo.status,
        activeForm: todo.activeForm,
      }));
      return {
        type: 'text' as const,
        text: `Recorded ${todos.length} todo${todos.length === 1 ? '' : 's'}.`,
        todos,
      };
    },
  };
}

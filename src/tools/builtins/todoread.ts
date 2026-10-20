/**
 * The `TodoRead` tool: report the session's task checklist.
 *
 * Evidence: the target's tool inventory, read out of the pinned build, and the
 * `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **This tool is not one of the target's.** The target's inventory names
 * `TodoWrite` and no `TodoRead`: the target's checklist is readable through the
 * session's own UI, not through a tool. This implementation adds the read
 * because a session that keeps a checklist needs to be able to look at it, and
 * because the target's own `TodoWrite` **replaces** the list — a write that
 * cannot see what it replaces cannot report it.
 *
 * **It is therefore an extension, and it is labelled as one** in
 * `docs/compatibility/tool-surface.md`.
 *
 * **The list is session state.** The tool reads the session's own store, which
 * is the same store `TodoWrite` writes.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **input shape** — no arguments — and the **output shape** —
 *     `{ type: 'text', text, todos }` — are implementation choices.
 */

import { type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  checkToolPermissions,
  recheckToolPermissions,
  rejectUnknownFields,
  type BuiltinToolDeps,
} from './shared.js';
import { TodoStore, type Todo } from './todostore.js';

/** The input of the `TodoRead` tool. */
export interface TodoReadInput {
  /** The tool takes no arguments. */
  readonly?: never;
}

/** The output of the `TodoRead` tool. */
export interface TodoReadOutput {
  type: 'text';
  /** A short report of what the list holds. */
  text: string;
  /** The list. */
  todos: Todo[];
}

/** The input schema of the `TodoRead` tool. */
export const TODOREAD_INPUT_SCHEMA = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
} as const;

/**
 * Create the `TodoRead` tool.
 */
export function createTodoReadTool(deps: BuiltinToolDeps): ToolDefinition<TodoReadInput, TodoReadOutput> {
  const store = deps.stores?.todos ?? new TodoStore();

  return {
    name: 'TodoRead',
    description: 'Report the session task checklist.',
    inputSchema: TODOREAD_INPUT_SCHEMA,
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
      const todos = store.list();
      return {
        type: 'text' as const,
        text:
          todos.length === 0
            ? 'The task checklist is empty.'
            : `The task checklist holds ${todos.length} item${todos.length === 1 ? '' : 's'}.`,
        todos,
      };
    },
  };
}

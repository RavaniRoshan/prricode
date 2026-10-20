/**
 * The `Task` tool: hand a piece of work to a sub-agent.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.4 (Agent loop and tool
 * dispatch, "Partial: ... the sub-agent / task delegation scheduler were not traced
 * to resolved relations") and the `CC-008` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The delegation scheduler is not observed.** The audit says so outright, so the
 * implementation does not invent one: the tool delegates through a seam the session supplies,
 * and without that seam the call is a typed failure rather than a silent no-op.
 *
 * The tool is **not** file-mutating: the observed file-mutating set is exactly
 * `["Edit", "Write", "NotebookEdit"]`. A sub-agent may write files, but the writes
 * are its own tools' writes, each of which passes the permission service on its
 * own.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The input is a `description` of the work, a `prompt` that carries it, and an
 *     optional `subagent_type`.
 *   - The delegate is supplied by the session. The `CC-010` milestone owns the
 *     runtime that provides it.
 *   - The **output shape** — `{ type: 'text', text, description }` — is a reimplementation
 *     choice: the audit pins the tool-result *metadata*, not the content a tool
 *     returns.
 */

import { ToolExecutionError, TOOL_ERROR_CODES, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  checkToolPermissions,
  denyDecisionFor,
  rejectUnknownFields,
  requireStringField,
  type BuiltinToolDeps,
} from './shared.js';

/** The input of the `Task` tool. */
export interface TaskInput {
  /** A short description of the work. */
  description: string;
  /** The prompt the sub-agent receives. */
  prompt: string;
  /** The kind of sub-agent to run. */
  subagent_type?: string;
}

/** The output of the `Task` tool. */
export interface TaskOutput {
  type: 'text';
  /** What the sub-agent reported. */
  text: string;
  /** The description of the work. */
  description: string;
}

/** The input schema of the `Task` tool. */
export const TASK_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    description: {
      type: 'string',
      description: 'A short description of the work.',
    },
    prompt: {
      type: 'string',
      description: 'The prompt the sub-agent receives.',
    },
    subagent_type: {
      type: 'string',
      description: 'The kind of sub-agent to run.',
    },
  },
  required: ['description', 'prompt'],
  additionalProperties: false,
} as const;

/**
 * Create the `Task` tool.
 */
export function createTaskTool(deps: BuiltinToolDeps): ToolDefinition<TaskInput, TaskOutput> {
  return {
    name: 'Task',
    description: 'Hand a piece of work to a sub-agent.',
    inputSchema: TASK_INPUT_SCHEMA,
    mutatesFiles: false,

    async checkPermissions(_input, ctx: ToolContext) {
      return checkToolPermissions(ctx, deps);
    },

    async recheckDeny(_input, ctx: ToolContext) {
      // A hook may have rewritten the input onto a command the deny list covers.
      return denyDecisionFor(ctx, deps);
    },

    async validateInput(input) {
      const fields = rejectUnknownFields(input, ['description', 'prompt', 'subagent_type']);
      if (!fields.ok) return fields;
      const description = requireStringField(input, 'description', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
      });
      if (!description.ok) return description;
      const prompt = requireStringField(input, 'prompt', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
      });
      if (!prompt.ok) return prompt;
      return { ok: true };
    },

    async execute(input, ctx: ToolContext) {
      const delegate = deps.delegate;
      if (!delegate) {
        throw new ToolExecutionError(
          'No task runner is available, so the work was not delegated.',
          TOOL_ERROR_CODES.taskUnavailable,
        );
      }
      const report = await delegate(input, ctx);
      return {
        type: 'text' as const,
        text: report,
        description: input.description,
      };
    },
  };
}

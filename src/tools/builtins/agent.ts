/**
 * The `Agent` tool: hand a piece of work to a sub-agent.
 *
 * Evidence: the target's `Agent` tool, read out of the pinned build
 * (`chunk-1vypyz65.js:45778`, with its input schema at `chunk-1vypyz65.js:9970`
 * and its aliases at `chunk-k2x7dq66.js:986`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's name for this tool is `Agent`, and `Task` is its alias.** The
 * target's alias table maps `Task` to `Agent` (`chunk-y3kmvs94.js:663`), and the
 * tool itself declares `aliases: ["Task"]`. This implementation therefore names
 * the tool `Agent` and resolves `Task` to it through the registry's alias table.
 *
 * **The target's own input shape, reproduced.** The schema takes a `description`
 * ("A short (3-5 word) description of the task"), a `prompt` ("The task for the
 * agent to perform"), an optional `subagent_type`, an optional `model` override,
 * an optional `run_in_background`, an optional `name`, an optional `isolation`
 * (`worktree` or `remote`) and an optional `cwd`. The **model ids** are the
 * target's own — `sonnet`, `opus`, `haiku` and `fable` — because those are the
 * data the implementation has to speak to.
 *
 * **The delegation scheduler is not observed.** The audit says so outright, so the
 * implementation does not invent one: the tool delegates through a seam the
 * session supplies, and without that seam the call is a typed failure rather
 * than a silent no-op.
 *
 * The tool is **not** file-mutating: the observed file-mutating set is exactly
 * `["Edit", "Write", "NotebookEdit"]`. A sub-agent may write files, but the writes
 * are its own tools' writes, each of which passes the permission service on its
 * own.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, description }` — is a
 *     implementation choice: the audit pins the tool-result *metadata*, not the content a
 *     tool returns.
 */

import { ToolExecutionError, TOOL_ERROR_CODES, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  checkToolPermissions,
  recheckToolPermissions,
  rejectUnknownFields,
  requireStringField,
  type BuiltinToolDeps,
} from './shared.js';

/** The input of the `Agent` tool. */
export interface AgentInput {
  /** A short description of the work. */
  description: string;
  /** The prompt the sub-agent receives. */
  prompt: string;
  /** The kind of sub-agent to run. */
  subagent_type?: string;
  /** The model the sub-agent runs on. */
  model?: 'sonnet' | 'opus' | 'haiku' | 'fable';
  /** Whether the agent runs in the background. */
  run_in_background?: boolean;
  /** The name the spawned agent is addressable by. */
  name?: string;
  /** The isolation the agent runs in. */
  isolation?: 'worktree' | 'remote';
  /** The directory the agent runs in. */
  cwd?: string;
}

/** The output of the `Agent` tool. */
export interface AgentOutput {
  type: 'text';
  /** What the sub-agent reported. */
  text: string;
  /** The description of the work. */
  description: string;
}

/** The input schema of the `Agent` tool. */
export const AGENT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    description: {
      type: 'string',
      description: 'A short (3-5 word) description of the task.',
    },
    prompt: {
      type: 'string',
      description: 'The task for the agent to perform.',
    },
    subagent_type: {
      type: 'string',
      description: 'The type of specialized agent to use for this task.',
    },
    model: {
      type: 'string',
      enum: ['sonnet', 'opus', 'haiku', 'fable'],
      description: 'The model the agent runs on.',
    },
    run_in_background: {
      type: 'boolean',
      description: 'Whether the agent runs in the background.',
    },
    name: {
      type: 'string',
      description: 'Name for the spawned agent.',
    },
    isolation: {
      type: 'string',
      enum: ['worktree', 'remote'],
      description: 'The isolation mode the agent runs in.',
    },
    cwd: {
      type: 'string',
      description: 'Absolute path to run the agent in.',
    },
  },
  required: ['description', 'prompt'],
  additionalProperties: false,
} as const;

/**
 * Create the `Agent` tool.
 */
export function createAgentTool(deps: BuiltinToolDeps): ToolDefinition<AgentInput, AgentOutput> {
  return {
    name: 'Agent',
    description: 'Launch a new agent to handle complex, multi-step tasks.',
    inputSchema: AGENT_INPUT_SCHEMA,
    mutatesFiles: false,

    async checkPermissions(_input, ctx: ToolContext) {
      return checkToolPermissions(ctx, deps);
    },

    async recheckPermission(_input, ctx: ToolContext) {
      // A hook may have rewritten the input: the **whole** check runs again on the
      // rewritten input, so the rewrite cannot escape the ask list, the allow
      // scope or the mode.
      return recheckToolPermissions(ctx, deps);
    },

    async validateInput(input) {
      const fields = rejectUnknownFields(input, [
        'description',
        'prompt',
        'subagent_type',
        'model',
        'run_in_background',
        'name',
        'isolation',
        'cwd',
      ]);
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

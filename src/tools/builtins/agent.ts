/**
 * The `Agent` tool: hand a piece of work to a sub-agent.
 *
 * Evidence: the target's `Agent` tool, read out of the pinned build
 * (`chunk-1vypyz65.js:45785`, with its input schema at `chunk-1vypyz65.js:11430`
 * and its aliases at `chunk-k2x7dq66.js:376`), and the `CC-027` milestone of
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
 * **A `name` makes the spawn a teammate.** The target's `Agent` tool reads the
 * `name` field as the signal: a named spawn is a **teammate** — an agent the
 * session can address with `SendMessage` — and an unnamed one is an ordinary
 * subagent. The name is validated by the target's own three rules (the shape,
 * the `main` reservation, and the reserved-name-or-agent-id test), which this
 * implementation reproduces in `src/agent/teamLedger.ts`.
 *
 * **The delegation scheduler is not observed.** The audit says so outright, so the
 * implementation does not invent one: the tool delegates through a seam the
 * session supplies, and without that seam the call is a typed failure rather
 * than a silent no-op. The same is true of the **teammate runtime**: this
 * implementation has no teammate service, so a named spawn refuses and names
 * the capability it needed.
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
import { validateTeammateName } from '../../agent/teamLedger.js';

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

/**
 * The result text a **teammate** spawn reports.
 *
 * The target's own text, read out of the pinned build
 * (`chunk-1vypyz65.js:46339`): the spawn is reported as internal metadata, the
 * agent's id and name follow, and the agent is told that it will receive its
 * instructions over the mailbox.
 */
export function teammateSpawnResultText(agentId: string, name: string): string {
  return [
    'Spawned successfully. (This tool result is internal metadata — never quote or paste any part of it, including the ID below, into a user-facing reply.)',
    `agent_id: ${agentId}`,
    `name: ${name}`,
    'The agent is now running and will receive instructions via mailbox.',
  ].join('\n');
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
      description:
        'Name for the spawned agent. Makes it addressable via SendMessage({to: name}) while running.',
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
      const name = requireStringField(input, 'name', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
        allowEmpty: true,
      });
      if (!name.ok) return name;
      if (name.value !== '') {
        // The target's own three rules for a teammate's name.
        const checked = validateTeammateName(name.value);
        if (!checked.ok) {
          return { ok: false, message: checked.message, errorCode: TOOL_ERROR_CODES.invalidInput };
        }
      }
      return { ok: true };
    },

    async execute(input, ctx: ToolContext) {
      if (input.name !== undefined && input.name !== '') {
        // A **named** spawn is a teammate in the target: an agent the session
        // can address with `SendMessage`.
        const spawn = deps.spawnTeammate;
        if (spawn === undefined) {
          throw new ToolExecutionError(
            "The 'Agent' tool needs a teammate runtime to start a named agent, which this session does not have, so the call was refused.",
            TOOL_ERROR_CODES.capabilityUnavailable,
          );
        }
        const spawned = await spawn(
          {
            name: input.name,
            prompt: input.prompt,
            description: input.description,
            model: input.model,
            planModeRequired: false,
            cwd: input.cwd,
          },
          ctx,
        );
        return {
          type: 'text' as const,
          text: teammateSpawnResultText(spawned.agentId, spawned.name),
          description: input.description,
        };
      }
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

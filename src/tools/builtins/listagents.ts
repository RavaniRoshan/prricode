/**
 * The `ListAgents` tool: list the agents a message can be sent to.
 *
 * Evidence: the target's `ListAgents` tool, read out of the pinned build
 * (`chunk-sd0h64ax.js:5212`, with its alias at the same place), and the `CC-027`
 * milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own name and alias, reproduced.** The canonical name is
 * `ListAgents` and the alias is `ListPeers`.
 *
 * **The target's own input shape, reproduced.** The schema takes two optional
 * fields — a `channel` and a `q` — which the target's own description marks as
 * "Not available in this build; leave unset". This implementation keeps them, so
 * a call that carries them validates, and it does not pretend to filter by them.
 *
 * **The agent team is a capability.** The agents that can be reached belong to
 * the session's team, and the session hands the tool its team through
 * `capabilities.team`; a session that supplies none gets a **typed refusal**.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, agents }` — is an
 *     implementation choice: the audit pins the tool-result *metadata*, not the
 *     content a tool returns.
 */

import { TOOL_ERROR_CODES, ToolExecutionError, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  checkToolPermissions,
  recheckToolPermissions,
  rejectUnknownFields,
  type BuiltinToolDeps,
} from './shared.js';

/** The input of the `ListAgents` tool. */
export interface ListAgentsInput {
  /** Not available in this build; leave unset. */
  channel?: string;
  /** Not available in this build; leave unset. */
  q?: string;
}

/** The output of the `ListAgents` tool. */
export interface ListAgentsOutput {
  type: 'text';
  /** A short report of what was found. */
  text: string;
  /** The agents that can be reached. */
  agents: { name: string; description?: string; agentId?: string }[];
}

/** The input schema of the `ListAgents` tool. */
export const LISTAGENTS_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    channel: {
      type: 'string',
      maxLength: 256,
      description: 'Not available in this build; leave unset.',
    },
    q: {
      type: 'string',
      maxLength: 256,
      description: 'Not available in this build; leave unset.',
    },
  },
  required: [],
  additionalProperties: false,
} as const;

/**
 * Create the `ListAgents` tool.
 */
export function createListAgentsTool(
  deps: BuiltinToolDeps,
): ToolDefinition<ListAgentsInput, ListAgentsOutput> {
  return {
    name: 'ListAgents',
    description: 'List agents you can SendMessage to.',
    inputSchema: LISTAGENTS_INPUT_SCHEMA,
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
      return rejectUnknownFields(input, ['channel', 'q']);
    },

    async execute() {
      const team = deps.capabilities?.team;
      if (team === undefined) {
        throw new ToolExecutionError(
          "The 'ListAgents' tool needs an agent team, which this session does not have, so the call was refused.",
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }
      const agents = team.list();
      return {
        type: 'text' as const,
        text: `Found ${agents.length} agent${agents.length === 1 ? '' : 's'}.`,
        agents: agents.map((agent) => ({ ...agent })),
      };
    },
  };
}

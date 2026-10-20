/**
 * The `SubagentHandback` tool: deliver the final report to the agent that
 * spawned this one.
 *
 * Evidence: the target's `SubagentHandback` tool, read out of the pinned build
 * (`chunk-y5at8j56.js:3548`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own input and output shapes, reproduced.** The schema takes a
 * `message` — "Your full report for your caller" — and the target answers with
 * `{ success, message }`.
 *
 * **The target's own guard, reproduced.** The target refuses an empty message
 * ("message must not be empty"), and it answers `success: false` when the
 * handback is not active for the calling agent.
 *
 * **The agent team is a capability.** The session hands the tool its team
 * through `capabilities.team`; a session that supplies none gets a **typed
 * refusal**.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, success, message }` — is an
 *     implementation choice: the audit pins the tool-result *metadata*, not the
 *     content a tool returns.
 */

import { TOOL_ERROR_CODES, ToolExecutionError, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  checkToolPermissions,
  recheckToolPermissions,
  rejectUnknownFields,
  requireStringField,
  type BuiltinToolDeps,
} from './shared.js';

/** The input of the `SubagentHandback` tool. */
export interface SubagentHandbackInput {
  /** The full report for the caller. */
  message: string;
}

/** The output of the `SubagentHandback` tool. */
export interface SubagentHandbackOutput {
  type: 'text';
  /** A short report of what happened. */
  text: string;
  /** Whether the report was delivered. */
  success: boolean;
  /** The message the tool reports. */
  message: string;
}

/** The input schema of the `SubagentHandback` tool. */
export const SUBAGENTHANDBACK_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string', description: 'Your full report for your caller' },
  },
  required: ['message'],
  additionalProperties: false,
} as const;

/**
 * Create the `SubagentHandback` tool.
 */
export function createSubagentHandbackTool(
  deps: BuiltinToolDeps,
): ToolDefinition<SubagentHandbackInput, SubagentHandbackOutput> {
  return {
    name: 'SubagentHandback',
    description: 'Deliver your final report to the agent that spawned you.',
    inputSchema: SUBAGENTHANDBACK_INPUT_SCHEMA,
    mutatesFiles: false,

    async checkPermissions(_input, ctx: ToolContext) {
      return checkToolPermissions(ctx, deps);
    },

    async recheckPermission(_input, ctx: ToolContext) {
      return recheckToolPermissions(ctx, deps);
    },

    async validateInput(input) {
      const fields = rejectUnknownFields(input, ['message']);
      if (!fields.ok) return fields;
      const message = requireStringField(input, 'message', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
      });
      if (!message.ok) return message;
      if (message.value.trim().length === 0) {
        return {
          ok: false,
          message: 'message must not be empty',
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      return { ok: true };
    },

    async execute(input) {
      const team = deps.capabilities?.team;
      if (team === undefined) {
        throw new ToolExecutionError(
          "The 'SubagentHandback' tool needs an agent team, which this session does not have, so the call was refused.",
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }
      await team.send('main', input.message);
      return {
        type: 'text' as const,
        text: 'The report was delivered.',
        success: true,
        message: 'The report was delivered.',
      };
    },
  };
}

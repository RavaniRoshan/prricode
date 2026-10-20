/**
 * The `SendMessage` tool: send a message to an agent teammate.
 *
 * Evidence: the target's `SendMessage` tool, read out of the pinned build
 * (`chunk-sy98zctw.js:48781`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own input shape, reproduced.** The target's schema takes a
 * `to` (the name or id of the agent) and a `message`; the tool's own classifier
 * input is the `to` field.
 *
 * **The agent team is a capability.** The session hands the tool its team
 * through `capabilities.team`; a session that supplies none gets a **typed
 * refusal**.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, success }` — is an
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

/** The input of the `SendMessage` tool. */
export interface SendMessageInput {
  /** The name or id of the agent to send the message to. */
  to: string;
  /** The message. */
  message: string;
}

/** The output of the `SendMessage` tool. */
export interface SendMessageOutput {
  type: 'text';
  /** A short report of what happened. */
  text: string;
  /** Whether the message was sent. */
  success: boolean;
}

/** The input schema of the `SendMessage` tool. */
export const SENDMESSAGE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    to: { type: 'string', description: 'The name or id of the agent to send the message to.' },
    message: { type: 'string', description: 'The message to send.' },
  },
  required: ['to', 'message'],
  additionalProperties: false,
} as const;

/**
 * Create the `SendMessage` tool.
 */
export function createSendMessageTool(
  deps: BuiltinToolDeps,
): ToolDefinition<SendMessageInput, SendMessageOutput> {
  return {
    name: 'SendMessage',
    description: 'Send messages to agent teammates.',
    inputSchema: SENDMESSAGE_INPUT_SCHEMA,
    mutatesFiles: false,

    async checkPermissions(_input, ctx: ToolContext) {
      return checkToolPermissions(ctx, deps);
    },

    async recheckPermission(_input, ctx: ToolContext) {
      return recheckToolPermissions(ctx, deps);
    },

    async validateInput(input) {
      const fields = rejectUnknownFields(input, ['to', 'message']);
      if (!fields.ok) return fields;
      const to = requireStringField(input, 'to', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
      });
      if (!to.ok) return to;
      const message = requireStringField(input, 'message', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
      });
      if (!message.ok) return message;
      return { ok: true };
    },

    async execute(input) {
      const team = deps.capabilities?.team;
      if (team === undefined) {
        throw new ToolExecutionError(
          "The 'SendMessage' tool needs an agent team, which this session does not have, so the call was refused.",
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }
      await team.send(input.to, input.message);
      return {
        type: 'text' as const,
        text: `Message sent to ${input.to}.`,
        success: true,
      };
    },
  };
}

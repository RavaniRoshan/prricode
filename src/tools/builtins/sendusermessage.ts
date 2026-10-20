/**
 * The `SendUserMessage` tool: send a message to the user.
 *
 * Evidence: the target's `SendUserMessage` tool, read out of the pinned build
 * (`chunk-705mhzj8.js:30849`, with its alias at `chunk-153xd3e1.js:644`), and the
 * `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own input shape, reproduced.** The schema takes a `message`.
 *
 * **The target's own output shape, reproduced.** The target answers with
 * `{ message, attachments?, sentAt?, rendered_locally? }`.
 *
 * **The alias is the target's.** The target declares `aliases: ["Brief"]`, and
 * the alias table maps `Brief` to `SendUserMessage`.
 *
 * **The channel to the user is a capability.** The message leaves the tool
 * through the session's own UI, and the session hands the tool that channel
 * through `capabilities.sendUserMessage`. A session that supplies none gets a
 * **typed refusal**: the tool cannot deliver a message on its own.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, message, sentAt }` — is an
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

/** The input of the `SendUserMessage` tool. */
export interface SendUserMessageInput {
  /** The message to send. */
  message: string;
}

/** The output of the `SendUserMessage` tool. */
export interface SendUserMessageOutput {
  type: 'text';
  /** A short report of what happened. */
  text: string;
  /** The message that was sent. */
  message: string;
  /** When the message was sent. */
  sentAt: string;
}

/** The input schema of the `SendUserMessage` tool. */
export const SENDUSERMESSAGE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    message: {
      type: 'string',
      description: 'The message.',
    },
  },
  required: ['message'],
  additionalProperties: false,
} as const;

/**
 * Create the `SendUserMessage` tool.
 */
export function createSendUserMessageTool(
  deps: BuiltinToolDeps,
): ToolDefinition<SendUserMessageInput, SendUserMessageOutput> {
  return {
    name: 'SendUserMessage',
    description: 'Send a message to the user — your primary visible output channel.',
    inputSchema: SENDUSERMESSAGE_INPUT_SCHEMA,
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
      const fields = rejectUnknownFields(input, ['message']);
      if (!fields.ok) return fields;
      const message = requireStringField(input, 'message', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
      });
      if (!message.ok) return message;
      return { ok: true };
    },

    async execute(input) {
      const deliver = deps.capabilities?.sendUserMessage;
      if (deliver === undefined) {
        throw new ToolExecutionError(
          "The 'SendUserMessage' tool needs a channel to the user, which this session does not have, so the call was refused.",
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }
      await deliver(input.message);
      return {
        type: 'text' as const,
        text: 'Message delivered to user.',
        message: input.message,
        sentAt: new Date().toISOString(),
      };
    },
  };
}

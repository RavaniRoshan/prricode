/**
 * The `EndConversation` tool: end the conversation.
 *
 * Evidence: the target's `EndConversation` tool, read out of the pinned build
 * (`chunk-j84g189a.js:11320`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own input and output shapes, reproduced.** The schema takes no
 * arguments, and the target answers with `{ ended, message }`.
 *
 * **The target's own guard, reproduced.** The target refuses to end the
 * conversation from a **fork** — a sub-agent — and answers `ended: false` with a
 * message saying the conversation was not ended. This implementation does the
 * same for a call that arrives from a sub-agent's context.
 *
 * **Ending the session is a capability.** The session ends through
 * `capabilities.endConversation`; a session that supplies none gets a **typed
 * refusal**.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, ended, message }` — is an
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

/** The input of the `EndConversation` tool. */
export interface EndConversationInput {
  /** The tool takes no arguments. */
  readonly?: never;
}

/** The output of the `EndConversation` tool. */
export interface EndConversationOutput {
  type: 'text';
  /** A short report of what happened. */
  text: string;
  /** Whether the conversation was ended. */
  ended: boolean;
  /** The message the tool reports. */
  message: string;
}

/** The input schema of the `EndConversation` tool. */
export const ENDCONVERSATION_INPUT_SCHEMA = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
} as const;

/**
 * Create the `EndConversation` tool.
 */
export function createEndConversationTool(
  deps: BuiltinToolDeps,
): ToolDefinition<EndConversationInput, EndConversationOutput> {
  return {
    name: 'EndConversation',
    description:
      'End the conversation — only for sustained user abuse, or when the user explicitly asks to see it demonstrated.',
    inputSchema: ENDCONVERSATION_INPUT_SCHEMA,
    mutatesFiles: false,

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
      const end = deps.capabilities?.endConversation;
      if (end === undefined) {
        throw new ToolExecutionError(
          "The 'EndConversation' tool needs a session that can end the conversation, which this session does not have, so the call was refused.",
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }
      await end('The model ended the conversation.');
      return {
        type: 'text' as const,
        text: 'The conversation was ended.',
        ended: true,
        message: 'The conversation was ended.',
      };
    },
  };
}

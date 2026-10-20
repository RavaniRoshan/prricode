/**
 * The `ProposeGoal` tool: propose a session goal condition for the user to
 * approve.
 *
 * Evidence: the target's `ProposeGoal` tool, read out of the pinned build
 * (`chunk-6zjyke0f.js:5819`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own input and output shapes, reproduced.** The schema takes a
 * `condition` — the completion condition, written so a separate evaluator can
 * verify it — and an optional `ask_user` that says whether the user is asked for
 * approval first. The target answers with `{ condition, askUser }`.
 *
 * **The approval is a capability.** The condition is approved by the user in the
 * session's own UI, and the session hands the tool that dialog through
 * `capabilities.askUser`; a session that supplies none gets a **typed refusal**.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, condition, askUser }` — is an
 *     implementation choice: the audit pins the tool-result *metadata*, not the
 *     content a tool returns.
 */

import { TOOL_ERROR_CODES, ToolExecutionError, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  checkToolPermissions,
  optionalBooleanField,
  recheckToolPermissions,
  rejectUnknownFields,
  requireStringField,
  type BuiltinToolDeps,
} from './shared.js';

/** The input of the `ProposeGoal` tool. */
export interface ProposeGoalInput {
  /** The completion condition to propose. */
  condition: string;
  /** Whether the user is asked for approval before the goal is set. */
  ask_user?: boolean;
}

/** The output of the `ProposeGoal` tool. */
export interface ProposeGoalOutput {
  type: 'text';
  /** A short report of what happened. */
  text: string;
  /** The condition that was shown to the user. */
  condition: string;
  /** Whether the user was asked for approval. */
  askUser: boolean;
}

/** The input schema of the `ProposeGoal` tool. */
export const PROPOSEGOAL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    condition: {
      type: 'string',
      minLength: 1,
      description:
        'The completion condition to propose, written so a separate evaluator can verify it from the conversation.',
    },
    ask_user: {
      type: 'boolean',
      description: 'Whether to ask the user for approval before the goal is set.',
    },
  },
  required: ['condition'],
  additionalProperties: false,
} as const;

/**
 * Create the `ProposeGoal` tool.
 */
export function createProposeGoalTool(
  deps: BuiltinToolDeps,
): ToolDefinition<ProposeGoalInput, ProposeGoalOutput> {
  return {
    name: 'ProposeGoal',
    description: 'Propose a session goal condition for the user to approve with one keypress.',
    inputSchema: PROPOSEGOAL_INPUT_SCHEMA,
    mutatesFiles: false,

    async checkPermissions(_input, ctx: ToolContext) {
      return checkToolPermissions(ctx, deps);
    },

    async recheckPermission(_input, ctx: ToolContext) {
      return recheckToolPermissions(ctx, deps);
    },

    async validateInput(input) {
      const fields = rejectUnknownFields(input, ['condition', 'ask_user']);
      if (!fields.ok) return fields;
      const condition = requireStringField(input, 'condition', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
      });
      if (!condition.ok) return condition;
      const askUser = optionalBooleanField(input, 'ask_user');
      if (!askUser.ok) return askUser;
      return { ok: true };
    },

    async execute(input) {
      const askUser = deps.capabilities?.askUser;
      if (askUser === undefined) {
        throw new ToolExecutionError(
          "The 'ProposeGoal' tool needs a dialog that can ask the user to approve a goal, which this session does not have, so the call was refused.",
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }

      const shouldAsk = input.ask_user !== false;
      if (shouldAsk) {
        const answer = await askUser({
          question: `Set this goal for the session?\n\n${input.condition}`,
          options: [
            { label: 'Yes', description: 'Set the goal.' },
            { label: 'No', description: 'Do not set the goal.' },
          ],
        });
        const approved = /^(yes|approve|approved|ok)$/i.test(answer.answer.trim());
        if (!approved) {
          throw new ToolExecutionError(
            'The goal was not approved, so no goal was set.',
            TOOL_ERROR_CODES.permissionDenied,
          );
        }
      }

      return {
        type: 'text' as const,
        text: shouldAsk ? 'The goal was approved.' : 'The goal was set directly.',
        condition: input.condition,
        askUser: shouldAsk,
      };
    },
  };
}

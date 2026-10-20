/**
 * The `EnterPlanMode` tool: switch to plan mode.
 *
 * Evidence: the target's `EnterPlanMode` tool, read out of the pinned build
 * (`chunk-gvcgcbhj.js:29272`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own input and output shapes, reproduced.** The schema takes no
 * arguments, and the target answers with `{ message }` — the confirmation that
 * plan mode was entered.
 *
 * **The mode is the session's.** The target sets the session's permission mode,
 * and this implementation hands the mode to the session through
 * `capabilities.setPermissionMode`; a session that supplies none gets a **typed
 * refusal**, because a tool that reported plan mode it did not enter would leave
 * the session and the model disagreeing.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, message }` — is an
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

/** The input of the `EnterPlanMode` tool. */
export interface EnterPlanModeInput {
  /** The tool takes no arguments. */
  readonly?: never;
}

/** The output of the `EnterPlanMode` tool. */
export interface EnterPlanModeOutput {
  type: 'text';
  /** A short report of what happened. */
  text: string;
  /** The confirmation that plan mode was entered. */
  message: string;
}

/** The input schema of the `EnterPlanMode` tool. */
export const ENTERPLANMODE_INPUT_SCHEMA = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
} as const;

/** The message the target confirms plan mode with. */
export const ENTER_PLAN_MODE_MESSAGE =
  'Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.';

/**
 * Create the `EnterPlanMode` tool.
 */
export function createEnterPlanModeTool(
  deps: BuiltinToolDeps,
): ToolDefinition<EnterPlanModeInput, EnterPlanModeOutput> {
  return {
    name: 'EnterPlanMode',
    description: 'Switch to plan mode to design an approach before coding.',
    inputSchema: ENTERPLANMODE_INPUT_SCHEMA,
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
      const setMode = deps.capabilities?.setPermissionMode;
      if (setMode === undefined) {
        throw new ToolExecutionError(
          "The 'EnterPlanMode' tool needs a session that can change its permission mode, which this session does not have, so the call was refused.",
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }
      await setMode('plan');
      return {
        type: 'text' as const,
        text: ENTER_PLAN_MODE_MESSAGE,
        message: ENTER_PLAN_MODE_MESSAGE,
      };
    },
  };
}

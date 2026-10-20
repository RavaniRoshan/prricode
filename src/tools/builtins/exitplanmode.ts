/**
 * The `ExitPlanMode` tool: present the plan for approval and start coding.
 *
 * Evidence: the target's `ExitPlanMode` tool, read out of the pinned build
 * (`chunk-53ppvfsj.js:6006`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The tool is plan-mode only, and it says so.** The target refuses the call
 * when the session is not in plan mode, and its message names the tool that gets
 * there: *"You are not in plan mode. To enter plan mode, call the EnterPlanMode
 * tool first. If your plan was already approved, continue with implementation."*
 * This implementation refuses the call the same way, with the same message.
 *
 * **The target's own input shape, reproduced.** The schema takes an optional
 * `allowedPrompts` list — each entry a `tool` (the target allows `Bash`) and a
 * `prompt` that says what the prompt is for — and the plan itself, which the
 * target injects from disk into `plan` and `planFilePath`.
 *
 * **The target's own output shape, reproduced.** The target answers with
 * `{ plan, isAgent, filePath?, hasTaskTool?, planWasEdited? }`.
 *
 * **The approval is a capability.** The plan is presented to the **user**, and the
 * user approves it in the session's own UI. The session supplies the dialog
 * through `capabilities.askUser`, and a session that supplies none gets a **typed
 * refusal**: the plan cannot be approved by a tool.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, plan, isAgent }` — is an
 *     implementation choice: the audit pins the tool-result *metadata*, not the
 *     content a tool returns.
 */

import { TOOL_ERROR_CODES, ToolExecutionError, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  checkToolPermissions,
  readInputField,
  recheckToolPermissions,
  rejectUnknownFields,
  type BuiltinToolDeps,
} from './shared.js';

/** One prompt the plan asks permission for. */
export interface ExitPlanModeAllowedPrompt {
  /** The tool the prompt is for. */
  tool: string;
  /** What the prompt does. */
  prompt: string;
}

/** The input of the `ExitPlanMode` tool. */
export interface ExitPlanModeInput {
  /** The prompts the plan asks permission for. */
  allowedPrompts?: ExitPlanModeAllowedPrompt[];
  /** The plan itself. */
  plan?: string;
  /** Where the plan was saved. */
  planFilePath?: string;
}

/** The output of the `ExitPlanMode` tool. */
export interface ExitPlanModeOutput {
  type: 'text';
  /** A short report of what happened. */
  text: string;
  /** The plan that was presented. */
  plan: string;
  /** Whether the plan was presented. */
  isAgent: boolean;
}

/** The input schema of the `ExitPlanMode` tool. */
export const EXITPLANMODE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    allowedPrompts: {
      type: 'array',
      description: 'The prompts the plan asks permission for.',
      items: {
        type: 'object',
        properties: {
          tool: {
            type: 'string',
            enum: ['Bash'],
            description: 'The tool this prompt applies to.',
          },
          prompt: {
            type: 'string',
            description: 'Semantic description of the action, e.g. "run tests".',
          },
        },
        required: ['tool', 'prompt'],
        additionalProperties: false,
      },
    },
    plan: {
      type: 'string',
      description: 'The plan that is presented to the user.',
    },
    planFilePath: {
      type: 'string',
      description: 'The file path where the plan was saved.',
    },
  },
  required: [],
  additionalProperties: false,
} as const;

/**
 * The message the target refuses a call made outside plan mode with.
 *
 * The target's own wording, read out of the bundle.
 */
export const NOT_IN_PLAN_MODE_MESSAGE =
  'You are not in plan mode. To enter plan mode, call the EnterPlanMode tool first. If your plan was already approved, continue with implementation.';

/**
 * Create the `ExitPlanMode` tool.
 */
export function createExitPlanModeTool(
  deps: BuiltinToolDeps,
): ToolDefinition<ExitPlanModeInput, ExitPlanModeOutput> {
  return {
    name: 'ExitPlanMode',
    description: 'Present the plan for approval and start coding (plan mode only).',
    inputSchema: EXITPLANMODE_INPUT_SCHEMA,
    mutatesFiles: false,

    async checkPermissions(_input, ctx: ToolContext) {
      return checkToolPermissions(ctx, deps);
    },

    async recheckPermission(_input, ctx: ToolContext) {
      return recheckToolPermissions(ctx, deps);
    },

    async validateInput(input) {
      const fields = rejectUnknownFields(input, ['allowedPrompts', 'plan', 'planFilePath']);
      if (!fields.ok) return fields;
      const allowed = readInputField(input, 'allowedPrompts');
      if (allowed !== undefined && allowed !== null && !Array.isArray(allowed)) {
        return {
          ok: false,
          message: "The 'allowedPrompts' argument must be an array.",
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      return { ok: true };
    },

    async execute(input) {
      if (deps.mode !== 'plan') {
        throw new ToolExecutionError(NOT_IN_PLAN_MODE_MESSAGE, TOOL_ERROR_CODES.invalidState);
      }

      const plan = typeof input.plan === 'string' ? input.plan : '';
      const askUser = deps.capabilities?.askUser;
      if (askUser === undefined) {
        throw new ToolExecutionError(
          "The 'ExitPlanMode' tool needs a dialog that can present the plan to the user, which this session does not have, so the call was refused.",
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }

      const answer = await askUser({
        question: plan.length === 0 ? 'Exit plan mode?' : `Exit plan mode with this plan?\n\n${plan}`,
        options: [
          { label: 'Yes', description: 'Approve the plan and start coding.' },
          { label: 'No', description: 'Keep planning.' },
        ],
      });

      const approved = /^(yes|approve|approved|ok)$/i.test(answer.answer.trim());
      if (!approved) {
        throw new ToolExecutionError(
          'The plan was not approved, so the session stays in plan mode.',
          TOOL_ERROR_CODES.permissionDenied,
        );
      }

      return {
        type: 'text' as const,
        text: 'The plan was approved.',
        plan,
        isAgent: false,
      };
    },
  };
}

/**
 * The `Skill` tool: invoke a slash-command skill.
 *
 * Evidence: the target's `Skill` tool, read out of the pinned build
 * (`chunk-gvcgcbhj.js:15125`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own input shape, reproduced.** The schema takes a `skill` — the
 * name of a skill from the available-skills list — and an optional `args` string.
 * The target strips a leading `/` from the name, refuses an empty name, and
 * refuses a name it does not know.
 *
 * **The target's own output shape, reproduced.** The target answers with
 * `{ success, commandName, allowedTools?, model?, status?, readOnly? }`.
 *
 * **The skill catalogue is a capability.** The skills themselves live in the
 * extension layer (`src/extensions/skills/registry.ts`); the session hands the
 * tool a lookup through `capabilities.skills`, so the tool layer does not depend
 * on the extension layer. A session that supplies no lookup gets a **typed
 * refusal**, and a session that supplies one but has no such skill gets the
 * target's own refusal: `Unknown skill: <name>`.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, success, commandName }` — is an
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

/** The input of the `Skill` tool. */
export interface SkillInput {
  /** The name of the skill to invoke. */
  skill: string;
  /** The arguments for the skill. */
  args?: string;
}

/** The output of the `Skill` tool. */
export interface SkillOutput {
  type: 'text';
  /** The skill's instructions. */
  text: string;
  /** Whether the skill was found. */
  success: boolean;
  /** The name of the skill that was invoked. */
  commandName: string;
}

/** The input schema of the `Skill` tool. */
export const SKILL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    skill: {
      type: 'string',
      description:
        'The name of a skill from the available-skills list. Do not guess names.',
    },
    args: {
      type: 'string',
      description: 'Optional arguments for the skill.',
    },
  },
  required: ['skill'],
  additionalProperties: false,
} as const;

/**
 * Create the `Skill` tool.
 */
export function createSkillTool(deps: BuiltinToolDeps): ToolDefinition<SkillInput, SkillOutput> {
  return {
    name: 'Skill',
    description: 'Invoke a slash-command skill.',
    inputSchema: SKILL_INPUT_SCHEMA,
    mutatesFiles: false,

    async checkPermissions(_input, ctx: ToolContext) {
      return checkToolPermissions(ctx, deps);
    },

    async recheckPermission(_input, ctx: ToolContext) {
      return recheckToolPermissions(ctx, deps);
    },

    async validateInput(input) {
      const fields = rejectUnknownFields(input, ['skill', 'args']);
      if (!fields.ok) return fields;
      const skill = requireStringField(input, 'skill', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
      });
      if (!skill.ok) return skill;
      return { ok: true };
    },

    async execute(input) {
      const lookup = deps.capabilities?.skills;
      if (lookup === undefined) {
        throw new ToolExecutionError(
          "The 'Skill' tool needs a skill catalogue, which this session does not have, so the call was refused.",
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }

      // The target strips a leading `/` from the name before it looks the skill
      // up.
      const name = input.skill.trim().replace(/^\//, '');
      if (name.length === 0) {
        throw new ToolExecutionError(
          `Invalid skill format: ${input.skill}`,
          TOOL_ERROR_CODES.invalidInput,
        );
      }

      const record = lookup.resolve(name);
      if (record === undefined) {
        throw new ToolExecutionError(`Unknown skill: ${name}`, TOOL_ERROR_CODES.notFound);
      }

      const text =
        input.args === undefined || input.args.length === 0
          ? record.instructions
          : `${record.instructions}\n\nArguments: ${input.args}`;

      return {
        type: 'text' as const,
        text,
        success: true,
        commandName: record.name,
      };
    },
  };
}

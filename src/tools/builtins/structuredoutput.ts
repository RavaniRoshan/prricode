/**
 * The `StructuredOutput` tool: return the final response as structured JSON.
 *
 * Evidence: the target's `StructuredOutput` tool, read out of the pinned build
 * (`chunk-qmndwv3b.js:21592`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own input shape, reproduced.** The target's schema is a
 * **passthrough** object: the tool takes whatever the requested format is, and
 * the target answers with the string that the structured output produced.
 *
 * **The tool is read-only and concurrency safe**, exactly as the target declares
 * it.
 *
 * **The output is JSON.** The tool checks that what it is given is a JSON
 * object, and it reports the value back as the session's structured output. A
 * value that is not a JSON object is refused: the tool's whole purpose is to
 * return structured JSON, so a non-object would be a silent failure.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, structured_output }` — is an
 *     implementation choice: the audit pins the tool-result *metadata*, not the
 *     content a tool returns.
 */

import { TOOL_ERROR_CODES, ToolExecutionError, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  checkToolPermissions,
  recheckToolPermissions,
  type BuiltinToolDeps,
} from './shared.js';

/** The input of the `StructuredOutput` tool. */
export interface StructuredOutputInput {
  /** The structured output. Any JSON object. */
  [key: string]: unknown;
}

/** The output of the `StructuredOutput` tool. */
export interface StructuredOutputOutput {
  type: 'text';
  /** A short report of what was returned. */
  text: string;
  /** The structured output. */
  structured_output: Record<string, unknown>;
}

/** The input schema of the `StructuredOutput` tool. */
export const STRUCTUREDOUTPUT_INPUT_SCHEMA = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: true,
} as const;

/**
 * Create the `StructuredOutput` tool.
 */
export function createStructuredOutputTool(
  deps: BuiltinToolDeps,
): ToolDefinition<StructuredOutputInput, StructuredOutputOutput> {
  return {
    name: 'StructuredOutput',
    description: 'Return the final response as structured JSON.',
    inputSchema: STRUCTUREDOUTPUT_INPUT_SCHEMA,
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
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return {
          ok: false,
          message: 'The structured output must be a JSON object.',
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      return { ok: true };
    },

    async execute(input) {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new ToolExecutionError(
          'The structured output must be a JSON object.',
          TOOL_ERROR_CODES.invalidInput,
        );
      }
      const structured = { ...(input as Record<string, unknown>) };
      return {
        type: 'text' as const,
        text: 'Structured output provided successfully',
        structured_output: structured,
      };
    },
  };
}

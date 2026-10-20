/**
 * The `ToolSearch` tool: find a tool by keyword.
 *
 * Evidence: the target's `ToolSearch` tool, read out of the pinned build
 * (`chunk-4jsg44k7.js:1492440`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own input and output shapes, reproduced.** The schema takes a
 * `query` — the target's own wording is *"Query to find deferred tools. Use
 * 'select:<tool_name>' for direct selection, or keywords to search."* — and an
 * optional `max_results` that defaults to `5`. The target answers with
 * `{ matches, query, total_deferred_tools, pending_mcp_servers?, failed_mcp_servers? }`.
 *
 * **The tool searches the registry the session holds.** The catalogue is a
 * capability (`capabilities.toolCatalogue`), so the tool layer does not need to
 * know how the registry is built, and a session that supplies none gets a **typed
 * refusal**.
 *
 * **A `select:<name>` query names one tool.** The target's own wording says so,
 * and this implementation honours it: the query selects that tool by name, and
 * the search falls back to keywords otherwise.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, matches, query,
 *     total_deferred_tools }` — is an implementation choice: the audit pins the
 *     tool-result *metadata*, not the content a tool returns.
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

/** The input of the `ToolSearch` tool. */
export interface ToolSearchInput {
  /** The query that finds the tools. */
  query: string;
  /** The most results to return. The default is 5. */
  max_results?: number;
}

/** The output of the `ToolSearch` tool. */
export interface ToolSearchOutput {
  type: 'text';
  /** A short report of what was found. */
  text: string;
  /** The names of the tools that matched. */
  matches: string[];
  /** The query that was executed. */
  query: string;
  /** The number of tools the catalogue holds. */
  total_deferred_tools: number;
}

/** The input schema of the `ToolSearch` tool. */
export const TOOLSEARCH_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.',
    },
    max_results: {
      type: 'integer',
      minimum: 1,
      default: 5,
      description: 'Maximum number of results to return (default: 5).',
    },
  },
  required: ['query'],
  additionalProperties: false,
} as const;

/** The default number of results the tool returns. */
export const DEFAULT_TOOL_SEARCH_RESULTS = 5;

/**
 * Create the `ToolSearch` tool.
 */
export function createToolSearchTool(
  deps: BuiltinToolDeps,
): ToolDefinition<ToolSearchInput, ToolSearchOutput> {
  return {
    name: 'ToolSearch',
    description: 'Find a tool by keyword.',
    inputSchema: TOOLSEARCH_INPUT_SCHEMA,
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
      const fields = rejectUnknownFields(input, ['query', 'max_results']);
      if (!fields.ok) return fields;
      const query = requireStringField(input, 'query', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
      });
      if (!query.ok) return query;
      return { ok: true };
    },

    async execute(input) {
      const catalogue = deps.capabilities?.toolCatalogue;
      if (catalogue === undefined) {
        throw new ToolExecutionError(
          "The 'ToolSearch' tool needs a tool catalogue, which this session does not have, so the call was refused.",
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }

      const tools = catalogue();
      const limit = input.max_results ?? DEFAULT_TOOL_SEARCH_RESULTS;
      const matches = searchTools(tools, input.query, limit);

      return {
        type: 'text' as const,
        text: `Found ${matches.length} tool${matches.length === 1 ? '' : 's'} for '${input.query}'.`,
        matches,
        query: input.query,
        total_deferred_tools: tools.length,
      };
    },
  };
}

/**
 * The tools that match a query.
 *
 * A `select:<name>` query names one tool; anything else is a keyword search over
 * the names and the descriptions.
 */
function searchTools(
  tools: readonly { name: string; description?: string }[],
  query: string,
  limit: number,
): string[] {
  const trimmed = query.trim();
  const select = /^select:(.+)$/i.exec(trimmed);
  if (select !== null) {
    const wanted = (select[1] ?? '').trim().toLowerCase();
    const exact = tools.find((tool) => tool.name.toLowerCase() === wanted);
    return exact === undefined ? [] : [exact.name];
  }

  const words = trimmed.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  const scored: { name: string; score: number }[] = [];
  for (const tool of tools) {
    const name = tool.name.toLowerCase();
    const description = (tool.description ?? '').toLowerCase();
    let score = 0;
    if (name === trimmed.toLowerCase()) score += 100;
    if (name.includes(trimmed.toLowerCase()) && trimmed.length > 0) score += 10;
    for (const word of words) {
      if (name.includes(word)) score += 5;
      if (description.includes(word)) score += 1;
    }
    if (score > 0) scored.push({ name: tool.name, score });
  }
  scored.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
  return scored.slice(0, limit).map((entry) => entry.name);
}

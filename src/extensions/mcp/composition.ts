/**
 * The tool the model sees.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("MCP, plugins, and
 * hooks" — "MCP transport"), and the `CC-011` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * This module owns **one** responsibility: composing a server's tool
 * definition into the tool the model is given, and the filter that decides
 * which composed tools are hidden.
 *
 * ## The naming
 *
 * The tool is named `mcp__<server>__<tool>`.
 *
 * ## The `mcp__ide__` filter
 *
 * The general filter hides the `mcp__ide__` tools, and the two
 * special-cased tools — `mcp__ide__executeCode` and `mcp__ide__getDiagnostics`
 * — are **exempt** from it. The filter belongs here, next to the composition,
 * because a composed name is what the filter tests.
 *
 * ## Implementation choices
 *
 * The audit does not pin these, so they are marked here:
 *
 *   - The **instruction cap** is `2 000` characters, and the text that does not
 *     fit is cut and replaced by a truncation marker, so the model knows the
 *     text it sees is not the whole text.
 */

import type { McpToolDefinition } from './capabilities.js';

/** The `mcp__ide__` tools the target special-cases. */
export const IDE_MCP_TOOL_NAMES: readonly string[] = Object.freeze([
  'mcp__ide__executeCode',
  'mcp__ide__getDiagnostics',
]);

/** The name the model calls an MCP tool by. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** Whether a tool name belongs to the IDE server. */
export function isIdeMcpTool(name: string): boolean {
  return name.startsWith('mcp__ide__');
}

/**
 * Whether a tool is hidden by the general "hide the `mcp__ide__` tools" filter.
 *
 * The two special-cased tools are **exempt**: the target excludes
 * `mcp__ide__executeCode` and `mcp__ide__getDiagnostics` from the filter.
 */
export function shouldHideMcpTool(name: string): boolean {
  if (!isIdeMcpTool(name)) return false;
  return !IDE_MCP_TOOL_NAMES.includes(name);
}

/** The maximum number of instructions a composed tool carries. */
export const MAX_MCP_INSTRUCTIONS_LENGTH = 2000;

/** The marker that says the instructions were truncated. */
const MCP_INSTRUCTIONS_TRUNCATED_MARKER = '…[truncated]';

/**
 * Cap the instructions a tool carries.
 *
 * The result is **never longer than `maxLength`**: the text that does not fit
 * is cut and the truncation marker takes its place, so the model knows the text
 * it sees is not the whole text.
 */
export function capMcpInstructions(
  instructions: string | undefined,
  maxLength: number = MAX_MCP_INSTRUCTIONS_LENGTH,
): string | undefined {
  if (instructions === undefined) return undefined;
  if (instructions.length <= maxLength) return instructions;
  if (maxLength <= MCP_INSTRUCTIONS_TRUNCATED_MARKER.length) {
    return instructions.slice(0, Math.max(0, maxLength));
  }
  return (
    instructions.slice(0, maxLength - MCP_INSTRUCTIONS_TRUNCATED_MARKER.length) +
    MCP_INSTRUCTIONS_TRUNCATED_MARKER
  );
}

/** The tool, as the model sees it. */
export interface McpComposedTool {
  /** The composed name, `mcp__<server>__<tool>`. */
  name: string;
  /** The server the tool belongs to. */
  server: string;
  /** The tool's name, as the server names it. */
  tool: string;
  /** The tool's title. */
  title?: string;
  /** The tool's description. */
  description: string;
  /** The tool's input schema. */
  inputSchema: unknown;
  /** The tool's instructions, capped. */
  instructions?: string;
}

/** Compose the tool the model sees. */
export function composeMcpTool(
  server: string,
  tool: McpToolDefinition,
  options: { maxInstructionsLength?: number } = {},
): McpComposedTool {
  const composed: McpComposedTool = {
    name: mcpToolName(server, tool.name),
    server,
    tool: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? { type: 'object' },
  };
  if (tool.title !== undefined) composed.title = tool.title;
  const instructions = capMcpInstructions(tool.instructions, options.maxInstructionsLength);
  if (instructions !== undefined) composed.instructions = instructions;
  return composed;
}

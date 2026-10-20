/**
 * The `ListMcpResourcesTool` tool: list the resources of the connected MCP
 * servers.
 *
 * Evidence: the target's tool, read out of the pinned build
 * (`chunk-7fedhq8p.js:2306`, with its alias in the same place), and the `CC-027`
 * milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own name and alias, reproduced.** The canonical name is
 * `ListMcpResourcesTool` and the alias is `ListMcpResources`; the alias table
 * maps the alias to the canonical name.
 *
 * **The target's own input and output shapes, reproduced.** The schema takes an
 * optional `server` — the server to filter by — and the target answers with an
 * array of `{ uri, name, mimeType?, description?, server }`.
 *
 * **The MCP servers are a capability.** The connected servers live in the
 * extension layer, and the session hands the tool its resource surface through
 * `capabilities.mcp`. A session that supplies none gets a **typed refusal**.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, resources }` — is an
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
import type { McpResourceRecord } from './capabilities.js';

/** The input of the `ListMcpResourcesTool` tool. */
export interface ListMcpResourcesInput {
  /** The server to filter the resources by. */
  server?: string;
}

/** The output of the `ListMcpResourcesTool` tool. */
export interface ListMcpResourcesOutput {
  type: 'text';
  /** A short report of what was found. */
  text: string;
  /** The resources. */
  resources: McpResourceRecord[];
}

/** The input schema of the `ListMcpResourcesTool` tool. */
export const LISTMCPRESOURCES_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    server: {
      type: 'string',
      description: 'Optional server name to filter resources by.',
    },
  },
  required: [],
  additionalProperties: false,
} as const;

/**
 * Create the `ListMcpResourcesTool` tool.
 */
export function createListMcpResourcesTool(
  deps: BuiltinToolDeps,
): ToolDefinition<ListMcpResourcesInput, ListMcpResourcesOutput> {
  return {
    name: 'ListMcpResourcesTool',
    description: 'List resources from connected MCP servers.',
    inputSchema: LISTMCPRESOURCES_INPUT_SCHEMA,
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
      return rejectUnknownFields(input, ['server']);
    },

    async execute(input) {
      const provider = deps.capabilities?.mcp;
      if (provider === undefined) {
        throw new ToolExecutionError(
          "The 'ListMcpResourcesTool' tool needs connected MCP servers, which this session does not have, so the call was refused.",
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }
      const resources = await provider.listResources(input.server);
      return {
        type: 'text' as const,
        text: `Found ${resources.length} resource${resources.length === 1 ? '' : 's'}.`,
        resources,
      };
    },
  };
}

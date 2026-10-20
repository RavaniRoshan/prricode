/**
 * The `ReadMcpResourceDirTool` tool: list the children of an MCP directory
 * resource.
 *
 * Evidence: the target's tool, read out of the pinned build
 * (`chunk-7fedhq8p.js:6347`, with its alias in the same place), and the `CC-027`
 * milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own name and alias, reproduced.** The canonical name is
 * `ReadMcpResourceDirTool` and the alias is `ReadMcpResourceDir`.
 *
 * **The target's own input and output shapes, reproduced.** The schema takes a
 * `server` and a `uri`, and the target answers with
 * `{ resources: [{ uri, name, mimeType? }], error? }`.
 *
 * **The MCP servers are a capability.** The session hands the tool its resource
 * surface through `capabilities.mcp`, and a session that supplies none gets a
 * **typed refusal**.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, resources, error? }` — is an
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
import type { McpResourceRecord } from './capabilities.js';

/** The input of the `ReadMcpResourceDirTool` tool. */
export interface ReadMcpResourceDirInput {
  /** The MCP server name. */
  server: string;
  /** The directory resource URI to list. */
  uri: string;
}

/** The output of the `ReadMcpResourceDirTool` tool. */
export interface ReadMcpResourceDirOutput {
  type: 'text';
  /** A short report of what was found. */
  text: string;
  /** The children of the directory resource. */
  resources: McpResourceRecord[];
  /** Why the server could not list the directory. */
  error?: string;
}

/** The input schema of the `ReadMcpResourceDirTool` tool. */
export const READMCPRESOURCEDIR_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    server: { type: 'string', description: 'The MCP server name.' },
    uri: { type: 'string', description: 'The directory resource URI to list.' },
  },
  required: ['server', 'uri'],
  additionalProperties: false,
} as const;

/**
 * Create the `ReadMcpResourceDirTool` tool.
 */
export function createReadMcpResourceDirTool(
  deps: BuiltinToolDeps,
): ToolDefinition<ReadMcpResourceDirInput, ReadMcpResourceDirOutput> {
  return {
    name: 'ReadMcpResourceDirTool',
    description: 'List the children of an MCP directory resource.',
    inputSchema: READMCPRESOURCEDIR_INPUT_SCHEMA,
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
      const fields = rejectUnknownFields(input, ['server', 'uri']);
      if (!fields.ok) return fields;
      const server = requireStringField(input, 'server', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
      });
      if (!server.ok) return server;
      const uri = requireStringField(input, 'uri', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
      });
      if (!uri.ok) return uri;
      return { ok: true };
    },

    async execute(input) {
      const provider = deps.capabilities?.mcp;
      if (provider === undefined) {
        throw new ToolExecutionError(
          "The 'ReadMcpResourceDirTool' tool needs connected MCP servers, which this session does not have, so the call was refused.",
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }
      try {
        const resources = await provider.readResourceDir(input.server, input.uri);
        return {
          type: 'text' as const,
          text: `Found ${resources.length} child resource${resources.length === 1 ? '' : 's'} under ${input.uri}.`,
          resources,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          type: 'text' as const,
          text: `The server could not list ${input.uri}.`,
          resources: [],
          error: message,
        };
      }
    },
  };
}

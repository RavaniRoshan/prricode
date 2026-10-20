/**
 * The `ReadMcpResourceTool` tool: read a specific MCP resource by URI.
 *
 * Evidence: the target's tool, read out of the pinned build
 * (`chunk-7fedhq8p.js:9248`, with its alias in the same place), and the `CC-027`
 * milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own name and alias, reproduced.** The canonical name is
 * `ReadMcpResourceTool` and the alias is `ReadMcpResource`.
 *
 * **The target's own input and output shapes, reproduced.** The schema takes a
 * `server` and a `uri`, and the target answers with
 * `{ contents: [{ uri, mimeType?, text?, blobSavedTo? }], error? }`.
 *
 * **The MCP servers are a capability.** The session hands the tool its resource
 * surface through `capabilities.mcp`, and a session that supplies none gets a
 * **typed refusal**.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, contents, error? }` — is an
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
import type { McpResourceContent } from './capabilities.js';

/** The input of the `ReadMcpResourceTool` tool. */
export interface ReadMcpResourceInput {
  /** The MCP server name. */
  server: string;
  /** The resource URI to read. */
  uri: string;
}

/** The output of the `ReadMcpResourceTool` tool. */
export interface ReadMcpResourceOutput {
  type: 'text';
  /** A short report of what was read. */
  text: string;
  /** The contents of the resource. */
  contents: McpResourceContent[];
  /** Why the server could not read the resource. */
  error?: string;
}

/** The input schema of the `ReadMcpResourceTool` tool. */
export const READMCPRESOURCE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    server: { type: 'string', description: 'The MCP server name.' },
    uri: { type: 'string', description: 'The resource URI to read.' },
  },
  required: ['server', 'uri'],
  additionalProperties: false,
} as const;

/**
 * Create the `ReadMcpResourceTool` tool.
 */
export function createReadMcpResourceTool(
  deps: BuiltinToolDeps,
): ToolDefinition<ReadMcpResourceInput, ReadMcpResourceOutput> {
  return {
    name: 'ReadMcpResourceTool',
    description: 'Read a specific MCP resource by URI.',
    inputSchema: READMCPRESOURCE_INPUT_SCHEMA,
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
          "The 'ReadMcpResourceTool' tool needs connected MCP servers, which this session does not have, so the call was refused.",
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }
      try {
        const contents = await provider.readResource(input.server, input.uri);
        return {
          type: 'text' as const,
          text: `Read ${contents.length} content item${contents.length === 1 ? '' : 's'} from ${input.uri}.`,
          contents,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          type: 'text' as const,
          text: `The server could not read ${input.uri}.`,
          contents: [],
          error: message,
        };
      }
    },
  };
}

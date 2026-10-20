/**
 * The `LSP` tool: code intelligence.
 *
 * Evidence: the target's `LSP` tool, read out of the pinned build
 * (`chunk-705mhzj8.js:105074`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own input shape, reproduced.** The schema takes an `operation`
 * — the target's own nine: `goToDefinition`, `findReferences`, `hover`,
 * `documentSymbol`, `workspaceSymbol`, `goToImplementation`,
 * `prepareCallHierarchy`, `incomingCalls` and `outgoingCalls` — a `filePath`, a
 * one-based `line` and `character`, and an optional `query` for the
 * `workspaceSymbol` operation.
 *
 * **The target's own output shape, reproduced.** The target answers with
 * `{ operation, result, filePath, resultCount?, fileCount? }`.
 *
 * **The language server is a capability.** A language server is a process per
 * language, and this implementation has none. The session hands the tool its
 * server through `capabilities.lsp`; a session that supplies none gets a **typed
 * refusal** that names the missing capability.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, operation, result, filePath }`
 *     — is an implementation choice: the audit pins the tool-result *metadata*,
 *     not the content a tool returns.
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

/** The operations the target's `LSP` tool performs. */
export const LSP_OPERATIONS: readonly string[] = Object.freeze([
  'goToDefinition',
  'findReferences',
  'hover',
  'documentSymbol',
  'workspaceSymbol',
  'goToImplementation',
  'prepareCallHierarchy',
  'incomingCalls',
  'outgoingCalls',
]);

/** The input of the `LSP` tool. */
export interface LspInput {
  /** The operation to perform. */
  operation: string;
  /** The path of the file. */
  filePath: string;
  /** The one-based line number. */
  line: number;
  /** The one-based character offset. */
  character: number;
  /** The symbol name to search for, for the `workspaceSymbol` operation. */
  query?: string;
}

/** The output of the `LSP` tool. */
export interface LspOutput {
  type: 'text';
  /** A short report of what was found. */
  text: string;
  /** The operation that was performed. */
  operation: string;
  /** The formatted result of the operation. */
  result: string;
  /** The path the operation was performed on. */
  filePath: string;
}

/** The input schema of the `LSP` tool. */
export const LSP_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    operation: {
      type: 'string',
      enum: [...LSP_OPERATIONS],
      description: 'The LSP operation to perform.',
    },
    filePath: {
      type: 'string',
      description: 'The absolute or relative path to the file.',
    },
    line: {
      type: 'integer',
      minimum: 1,
      description: 'The line number (1-based, as shown in editors).',
    },
    character: {
      type: 'integer',
      minimum: 1,
      description: 'The character offset (1-based, as shown in editors).',
    },
    query: {
      type: 'string',
      description: 'The symbol name or partial name to search for (workspaceSymbol only).',
    },
  },
  required: ['operation', 'filePath', 'line', 'character'],
  additionalProperties: false,
} as const;

/**
 * Create the `LSP` tool.
 */
export function createLspTool(deps: BuiltinToolDeps): ToolDefinition<LspInput, LspOutput> {
  return {
    name: 'LSP',
    description: 'Code intelligence (definitions, references, symbols, hover).',
    inputSchema: LSP_INPUT_SCHEMA,
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
      const fields = rejectUnknownFields(input, [
        'operation',
        'filePath',
        'line',
        'character',
        'query',
      ]);
      if (!fields.ok) return fields;
      const operation = requireStringField(input, 'operation', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
      });
      if (!operation.ok) return operation;
      if (!LSP_OPERATIONS.includes(operation.value)) {
        return {
          ok: false,
          message: `The 'operation' argument must be one of ${LSP_OPERATIONS.join(', ')}.`,
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      const filePath = requireStringField(input, 'filePath', {
        invalidCode: TOOL_ERROR_CODES.invalidPath,
      });
      if (!filePath.ok) return filePath;
      const line = readPosition(input, 'line');
      if (!line.ok) return line;
      const character = readPosition(input, 'character');
      if (!character.ok) return character;
      return { ok: true };
    },

    async execute(input) {
      const server = deps.capabilities?.lsp;
      if (server === undefined) {
        throw new ToolExecutionError(
          "The 'LSP' tool needs a language server, which this session does not have, so the call was refused.",
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }
      const result = await server.perform(
        input.operation,
        input.filePath,
        input.line,
        input.character,
        input.query,
      );
      return {
        type: 'text' as const,
        text: result,
        operation: input.operation,
        result,
        filePath: input.filePath,
      };
    },
  };
}

/**
 * Read a one-based position field.
 *
 * The value is caller-supplied data, so the lookup is an **own-property** check.
 */
function readPosition(
  input: unknown,
  field: string,
): { ok: true; value: number } | { ok: false; message: string; errorCode: number } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      message: `The '${field}' argument is required.`,
      errorCode: TOOL_ERROR_CODES.missingField,
    };
  }
  const record = input as Record<string, unknown>;
  if (!Object.hasOwn(record, field)) {
    return {
      ok: false,
      message: `The '${field}' argument is required.`,
      errorCode: TOOL_ERROR_CODES.missingField,
    };
  }
  const value = record[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return {
      ok: false,
      message: `The '${field}' argument must be a positive whole number.`,
      errorCode: TOOL_ERROR_CODES.invalidInput,
    };
  }
  return { ok: true, value };
}

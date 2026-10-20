/**
 * The `memory_read` tool: read a document from a memory store.
 *
 * Evidence: the target's `memory_read` tool, read out of the pinned build
 * (`chunk-4jsg44k7.js:1324824`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own input and output shapes, reproduced.** The schema takes a
 * `store` and a `path`, and the target answers with
 * `{ outcome, path, store_kind?, content?, updatedAt?, version?, reason?, message? }`
 * — the outcome is one of `ok`, `not_found`, `refused` and `failed`.
 *
 * **The memory stores are a capability.** The session hands the tool its memory
 * surface through `capabilities.memory`; a session that supplies none gets a
 * **typed refusal**.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, outcome, path, content? }` —
 *     is an implementation choice: the audit pins the tool-result *metadata*, not
 *     the content a tool returns.
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

/** The input of the `memory_read` tool. */
export interface MemoryReadInput {
  /** The id of the memory store to read from. */
  store: string;
  /** The path of the memory document to read. */
  path: string;
}

/** The output of the `memory_read` tool. */
export interface MemoryReadOutput {
  type: 'text';
  /** A short report of what was read. */
  text: string;
  /** Whether the read succeeded. */
  outcome: 'ok' | 'not_found' | 'refused' | 'failed';
  /** The document's path. */
  path: string;
  /** The document's content. */
  content?: string;
  /** When the document was last written. */
  updatedAt?: string;
}

/** The input schema of the `memory_read` tool. */
export const MEMORYREAD_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    store: { type: 'string', description: 'Id of the memory store to read from.' },
    path: { type: 'string', description: 'Path of the memory document to read (e.g. /MEMORY.md).' },
  },
  required: ['store', 'path'],
  additionalProperties: false,
} as const;

/**
 * Create the `memory_read` tool.
 */
export function createMemoryReadTool(
  deps: BuiltinToolDeps,
): ToolDefinition<MemoryReadInput, MemoryReadOutput> {
  return {
    name: 'memory_read',
    description: 'Read a document from a memory store.',
    inputSchema: MEMORYREAD_INPUT_SCHEMA,
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
      const fields = rejectUnknownFields(input, ['store', 'path']);
      if (!fields.ok) return fields;
      const store = requireStringField(input, 'store', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
      });
      if (!store.ok) return store;
      const path = requireStringField(input, 'path', {
        invalidCode: TOOL_ERROR_CODES.invalidPath,
      });
      if (!path.ok) return path;
      return { ok: true };
    },

    async execute(input) {
      const memory = deps.capabilities?.memory;
      if (memory === undefined) {
        throw new ToolExecutionError(
          "The 'memory_read' tool needs memory stores, which this session does not have, so the call was refused.",
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }
      const document = await memory.readDocument(input.store, input.path);
      if (document === undefined) {
        return {
          type: 'text' as const,
          text: `The document ${input.path} was not found in the store ${input.store}.`,
          outcome: 'not_found' as const,
          path: input.path,
        };
      }
      return {
        type: 'text' as const,
        text: `Read ${input.path} from the store ${input.store}.`,
        outcome: 'ok' as const,
        path: document.path,
        content: document.content,
        ...(document.updatedAt === undefined ? {} : { updatedAt: document.updatedAt }),
      };
    },
  };
}

/**
 * The `memory_write` tool: save a document to a memory store.
 *
 * Evidence: the target's `memory_write` tool, read out of the pinned build
 * (`chunk-x0sf10xm.js:49057`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own input and output shapes, reproduced.** The schema takes a
 * `store`, a `path`, the full `content` and an `if_version` — the target's own
 * wording is that the content "Replaces the entire document — any line you omit
 * is deleted". The target answers with
 * `{ outcome, path, store_kind?, version?, bytes?, content?, op?, currentVersion?, currentContent?, reason?, message? }`
 * and the outcome is one of `ok`, `conflict`, `missing`, `refused` and `failed`.
 *
 * **The memory stores are a capability.** The session hands the tool its memory
 * surface through `capabilities.memory`; a session that supplies none gets a
 * **typed refusal**.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, outcome, path, version? }` —
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

/** The input of the `memory_write` tool. */
export interface MemoryWriteInput {
  /** The id of the memory store to write to. */
  store: string;
  /** The path of the document to create or update. */
  path: string;
  /** The full text content to write. */
  content: string;
  /** The version token from the most recent read of this file. */
  if_version?: string;
}

/** The output of the `memory_write` tool. */
export interface MemoryWriteOutput {
  type: 'text';
  /** A short report of what happened. */
  text: string;
  /** Whether the write succeeded. */
  outcome: 'ok' | 'conflict' | 'missing' | 'refused' | 'failed';
  /** The document's path. */
  path: string;
  /** The document's version, after the write. */
  version?: string;
  /** Whether the document was created or updated. */
  op?: 'created' | 'updated';
}

/** The input schema of the `memory_write` tool. */
export const MEMORYWRITE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    store: { type: 'string', description: 'Id of the memory store to write to.' },
    path: { type: 'string', description: 'Path of the memory document to create or update.' },
    content: {
      type: 'string',
      description:
        'Full text content to write (UTF-8). Replaces the entire document — any line you omit is deleted.',
    },
    if_version: {
      type: 'string',
      maxLength: 64,
      description: 'The version token from your most recent read of this file.',
    },
  },
  required: ['store', 'path', 'content'],
  additionalProperties: false,
} as const;

/**
 * Create the `memory_write` tool.
 */
export function createMemoryWriteTool(
  deps: BuiltinToolDeps,
): ToolDefinition<MemoryWriteInput, MemoryWriteOutput> {
  return {
    name: 'memory_write',
    description: 'Save a document to a memory store.',
    inputSchema: MEMORYWRITE_INPUT_SCHEMA,
    mutatesFiles: false,

    async checkPermissions(_input, ctx: ToolContext) {
      return checkToolPermissions(ctx, deps);
    },

    async recheckPermission(_input, ctx: ToolContext) {
      return recheckToolPermissions(ctx, deps);
    },

    async validateInput(input) {
      const fields = rejectUnknownFields(input, ['store', 'path', 'content', 'if_version']);
      if (!fields.ok) return fields;
      const store = requireStringField(input, 'store', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
      });
      if (!store.ok) return store;
      const path = requireStringField(input, 'path', {
        invalidCode: TOOL_ERROR_CODES.invalidPath,
      });
      if (!path.ok) return path;
      const content = requireStringField(input, 'content', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
        allowEmpty: true,
      });
      if (!content.ok) return content;
      if (content.value.trim().length === 0) {
        return {
          ok: false,
          message: "The 'content' argument must not be empty or whitespace only.",
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      return { ok: true };
    },

    async execute(input) {
      const memory = deps.capabilities?.memory;
      if (memory === undefined) {
        throw new ToolExecutionError(
          "The 'memory_write' tool needs memory stores, which this session does not have, so the call was refused.",
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }
      const document = await memory.writeDocument(input.store, input.path, input.content);
      return {
        type: 'text' as const,
        text: `Wrote ${input.path} to the store ${input.store}.`,
        outcome: 'ok' as const,
        path: document.path,
        ...(document.updatedAt === undefined ? {} : { version: document.updatedAt }),
        op: 'updated' as const,
      };
    },
  };
}

/**
 * The `memory_list` tool: list the memory stores and the documents in them.
 *
 * Evidence: the target's `memory_list` tool, read out of the pinned build
 * (`chunk-705mhzj8.js:63954`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own input and output shapes, reproduced.** The schema takes an
 * optional `store`, an optional `path_prefix` and an optional `cursor`, and the
 * target answers with
 * `{ outcome, store_kind?, entries?, remaining?, stores?, reason?, message? }`.
 *
 * **The memory stores are a capability.** The stores live in the account's
 * memory, and the session hands the tool its memory surface through
 * `capabilities.memory`; a session that supplies none gets a **typed refusal**.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, outcome, stores?, entries? }`
 *     — is an implementation choice: the audit pins the tool-result *metadata*,
 *     not the content a tool returns.
 */

import { TOOL_ERROR_CODES, ToolExecutionError, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  checkToolPermissions,
  recheckToolPermissions,
  rejectUnknownFields,
  type BuiltinToolDeps,
} from './shared.js';
import type { MemoryDocument, MemoryStore } from './capabilities.js';

/** The input of the `memory_list` tool. */
export interface MemoryListInput {
  /** The store to list. Omit to list the stores. */
  store?: string;
  /** The directory prefix to list under. */
  path_prefix?: string;
  /** The path of the last entry of a previous call. */
  cursor?: string;
}

/** The output of the `memory_list` tool. */
export interface MemoryListOutput {
  type: 'text';
  /** A short report of what was found. */
  text: string;
  /** Whether the listing succeeded. */
  outcome: 'ok' | 'refused' | 'failed';
  /** The stores, when the call listed the stores. */
  stores?: MemoryStore[];
  /** The documents, when the call listed a store. */
  entries?: MemoryDocument[];
}

/** The input schema of the `memory_list` tool. */
export const MEMORYLIST_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    store: {
      type: 'string',
      description:
        'Id of the memory store to list. Omit to list the memory stores available in this session.',
    },
    path_prefix: {
      type: 'string',
      description: 'Optional directory prefix to list only documents under it.',
    },
    cursor: {
      type: 'string',
      description: 'Path of the last entry from a previous call. Returns entries after this path.',
    },
  },
  required: [],
  additionalProperties: false,
} as const;

/**
 * Create the `memory_list` tool.
 */
export function createMemoryListTool(
  deps: BuiltinToolDeps,
): ToolDefinition<MemoryListInput, MemoryListOutput> {
  return {
    name: 'memory_list',
    description: 'List the memory stores and the documents in them.',
    inputSchema: MEMORYLIST_INPUT_SCHEMA,
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
      return rejectUnknownFields(input, ['store', 'path_prefix', 'cursor']);
    },

    async execute(input) {
      const memory = deps.capabilities?.memory;
      if (memory === undefined) {
        throw new ToolExecutionError(
          "The 'memory_list' tool needs memory stores, which this session does not have, so the call was refused.",
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }

      if (input.store === undefined) {
        const stores = memory.listStores();
        return {
          type: 'text' as const,
          text: `Found ${stores.length} memory store${stores.length === 1 ? '' : 's'}.`,
          outcome: 'ok' as const,
          stores: stores.map((store) => ({ ...store })),
        };
      }

      const entries = await memory.listDocuments(input.store, input.path_prefix);
      const cursor = input.cursor;
      const after =
        cursor === undefined
          ? entries
          : entries.filter((entry) => entry.path > cursor);
      return {
        type: 'text' as const,
        text: `Found ${after.length} document${after.length === 1 ? '' : 's'}.`,
        outcome: 'ok' as const,
        entries: after,
      };
    },
  };
}

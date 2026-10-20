/**
 * The `Read` tool: read a file from the local filesystem.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.5 (Permissions, "Tool
 * contract" and "File-mutating tools") and the `CC-008` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * `Read` is **not** a file-mutating tool: the observed file-mutating set is exactly
 * `["Edit", "Write", "NotebookEdit"]`. It is still a **read** of the filesystem, so
 * the `Read(...)` path rules apply to it, and the rule engine resolves the path
 * before the match — an allow rule requires both the requested path and the
 * resolved target to match, and a deny rule fires when either does.
 *
 * The tool does not resolve the path itself for the permission check: the rule
 * engine does, and the tool resolves the same way when it opens the file, so the
 * path the check saw and the path the tool opens are the same path.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, filePath, totalLines }` — is a
 *     implementation choice: the audit pins the tool-result *metadata*, not the content a
 *     tool returns.
 */

import { readFile } from 'node:fs/promises';

import { ToolExecutionError, TOOL_ERROR_CODES, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  absoluteToolPath,
  checkToolPermissions,
  recheckToolPermissions,
  optionalIntegerField,
  rejectUnknownFields,
  requireStringField,
  type BuiltinToolDeps,
} from './shared.js';

/** The input of the `Read` tool. */
export interface ReadInput {
  /** The path of the file to read. */
  file_path: string;
  /** The line to start reading from. */
  offset?: number;
  /** The number of lines to read. */
  limit?: number;
}

/** The output of the `Read` tool. */
export interface ReadOutput {
  type: 'text';
  /** The content that was read. */
  text: string;
  /** The path the content came from. */
  filePath: string;
  /** The number of lines the file has. */
  totalLines: number;
}

/** The input schema of the `Read` tool. */
export const READ_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description: 'The path of the file to read, absolute or relative to the working directory.',
    },
    offset: {
      type: 'integer',
      minimum: 0,
      description: 'The line to start reading from.',
    },
    limit: {
      type: 'integer',
      minimum: 0,
      description: 'The number of lines to read.',
    },
  },
  required: ['file_path'],
  additionalProperties: false,
} as const;

/**
 * Create the `Read` tool.
 */
export function createReadTool(deps: BuiltinToolDeps): ToolDefinition<ReadInput, ReadOutput> {
  return {
    name: 'Read',
    description: 'Read a file from the local filesystem.',
    inputSchema: READ_INPUT_SCHEMA,
    mutatesFiles: false,

    // A read is **concurrency safe**: the target's `Read` tool declares the
    // flag, so the call may run beside the other concurrency-safe calls of the
    // same assistant message.
    isConcurrencySafe(): boolean {
      return true;
    },

    async checkPermissions(_input, ctx: ToolContext) {
      return checkToolPermissions(ctx, deps);
    },

    async recheckPermission(_input, ctx: ToolContext) {
      // A hook may have rewritten the input: the **whole** check runs again on the
      // rewritten input, so the rewrite cannot escape the ask list, the allow
      // scope or the mode.
      return recheckToolPermissions(ctx, deps);
    },

    async validateInput(input) {
      const fields = rejectUnknownFields(input, ['file_path', 'offset', 'limit']);
      if (!fields.ok) return fields;
      const path = requireStringField(input, 'file_path', {
        invalidCode: TOOL_ERROR_CODES.invalidPath,
      });
      if (!path.ok) return path;
      const offset = optionalIntegerField(input, 'offset');
      if (!offset.ok) return offset;
      const limit = optionalIntegerField(input, 'limit');
      if (!limit.ok) return limit;
      return { ok: true };
    },

    async execute(input, _ctx) {
      const filePath = absoluteToolPath(input.file_path, deps.cwd);
      let content: string;
      try {
        content = await readFile(filePath, 'utf8');
      } catch (error) {
        throw new ToolExecutionError(
          `The file '${filePath}' could not be read: ${(error as NodeJS.ErrnoException).message}`,
          TOOL_ERROR_CODES.fileNotFound,
        );
      }

      const lines = content.split('\n');
      const start = input.offset ?? 0;
      const end = input.limit === undefined ? lines.length : start + input.limit;
      const slice = lines.slice(start, end).join('\n');

      return {
        type: 'text' as const,
        text: slice,
        filePath,
        totalLines: lines.length,
      };
    },
  };
}

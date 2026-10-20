/**
 * The `Write` tool: write a file to the local filesystem.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.5 (Permissions, "Tool
 * contract" and "File-mutating tools") and the `CC-008` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The write path re-resolves the path after the permission check and before the
 * write.** The audit's file-write tool "normalizes the path, stashes the permission
 * decision keyed by `toolUseId`, evaluates the rules, ... then runs the input
 * validation"; the re-resolution the `CC-007` review found was never called belongs
 * here. The snapshot is taken while the check runs, and the write re-resolves it:
 * a symlink swapped in between would otherwise redirect the write, which is the
 * "Symlink TOCTOU" failure the target fixed in `2.1.251`.
 *
 * **The write is refused when the path changed.** The refusal is a typed failure
 * with the `pathChanged` code, not a silent success.
 *
 * The tool never widens its own permission: it consults the rule engine through the
 * session's rules and mode, and the `Write(...)` path rules apply to it — an allow
 * rule requires **both** the requested path and the resolved target to match.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ToolExecutionError, TOOL_ERROR_CODES, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  PathSnapshot,
  absoluteToolPath,
  checkToolPermissions,
  requireStringField,
  type BuiltinToolDeps,
} from './shared.js';

/** The input of the `Write` tool. */
export interface WriteInput {
  /** The path of the file to write. */
  file_path: string;
  /** The content of the file. */
  content: string;
}

/** The output of the `Write` tool. */
export interface WriteOutput {
  type: 'text';
  /** A short report of what was written. */
  text: string;
  /** The path that was written. */
  filePath: string;
  /** The number of bytes written. */
  bytes: number;
}

/** The input schema of the `Write` tool. */
export const WRITE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description: 'The path of the file to write, absolute or relative to the working directory.',
    },
    content: {
      type: 'string',
      description: 'The content of the file.',
    },
  },
  required: ['file_path', 'content'],
  additionalProperties: false,
} as const;

/**
 * Create the `Write` tool.
 */
export function createWriteTool(deps: BuiltinToolDeps): ToolDefinition<WriteInput, WriteOutput> {
  const snapshot = new PathSnapshot(deps.cwd);

  return {
    name: 'Write',
    description: 'Write a file to the local filesystem, replacing it when it exists.',
    inputSchema: WRITE_INPUT_SCHEMA,
    mutatesFiles: true,

    async checkPermissions(input, ctx: ToolContext) {
      // The snapshot is taken **before** the rules are evaluated, so the check and
      // the write are compared against the same resolution.
      snapshot.record(ctx.toolUseId, input.file_path);
      return checkToolPermissions(ctx, deps);
    },

    async validateInput(input) {
      const filePath = requireStringField(input, 'file_path', {
        invalidCode: TOOL_ERROR_CODES.invalidPath,
      });
      if (!filePath.ok) return filePath;
      const content = requireStringField(input, 'content', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
        allowEmpty: true,
      });
      if (!content.ok) return content;
      return { ok: true };
    },

    async execute(input, ctx) {
      const refusal = snapshot.verify(ctx.toolUseId, input.file_path);
      if (refusal !== undefined) {
        throw new ToolExecutionError(refusal, TOOL_ERROR_CODES.pathChanged);
      }

      const filePath = absoluteToolPath(input.file_path, deps.cwd);
      try {
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, input.content, 'utf8');
      } catch (error) {
        throw new ToolExecutionError(
          `The file '${filePath}' could not be written: ${(error as NodeJS.ErrnoException).message}`,
          TOOL_ERROR_CODES.executionFailed,
        );
      }

      const bytes = Buffer.byteLength(input.content, 'utf8');
      return {
        type: 'text' as const,
        text: `Wrote ${input.content.length === 0 ? 0 : input.content.split('\n').length} lines to ${filePath}.`,
        filePath,
        bytes,
      };
    },
  };
}

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
 * here. The snapshot is taken **after** the check returns, on the path the call will
 * act on, and the write re-resolves it **immediately before** the write: a symlink
 * swapped in between would otherwise redirect the write, which is the "Symlink
 * TOCTOU" failure the target fixed in `2.1.251`. The snapshot is of the path the
 * call will act on, so a hook that rewrote the path is covered too.
 *
 * **The write is refused when the path changed.** The refusal is a typed failure
 * with the `pathChanged` code, not a silent success.
 *
 * The tool never widens its own permission: it consults the rule engine through the
 * session's rules and mode, and the `Write(...)` path rules apply to it — an allow
 * rule requires **both** the requested path and the resolved target to match.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, filePath, bytes }` — is a reimplementation
 *     choice: the audit pins the tool-result *metadata*, not the content a tool
 *     returns.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ToolExecutionError, TOOL_ERROR_CODES, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  PathSnapshot,
  absoluteToolPath,
  checkFileToolPermissions,
  fileToolSafetyCheck,
  recheckToolPermissions,
  rejectUnknownFields,
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
      // The snapshot is of the path the call will act on, so it is taken once the
      // check — and any rewrite it carried — is known.
      return checkFileToolPermissions(ctx, deps, snapshot, 'file_path');
    },

    async recheckPermission(_input, ctx: ToolContext) {
      // A hook may have rewritten the input onto another path: the **whole** check
      // runs again on the rewritten input, so the rewrite cannot escape the ask
      // list, the allow scope or the mode.
      return recheckToolPermissions(ctx, deps, {
        safetyCheck: fileToolSafetyCheck('file_path'),
        pathField: 'file_path',
      });
    },

    async validateInput(input) {
      const fields = rejectUnknownFields(input, ['file_path', 'content']);
      if (!fields.ok) return fields;
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
      try {
        // The path is resolved twice: once here, so the write does not follow a
        // symlink that was swapped after the check, and once **immediately before**
        // the write, so the window between the last resolution and the write is
        // as small as it can be.
        const refusal = snapshot.verify(ctx.toolUseId, input.file_path);
        if (refusal !== undefined) {
          throw new ToolExecutionError(refusal, TOOL_ERROR_CODES.pathChanged);
        }

        const filePath = absoluteToolPath(input.file_path, deps.cwd);
        try {
          await mkdir(path.dirname(filePath), { recursive: true });
        } catch (error) {
          throw new ToolExecutionError(
            `The directory of '${filePath}' could not be created: ${(error as NodeJS.ErrnoException).message}`,
            TOOL_ERROR_CODES.executionFailed,
          );
        }

        // The re-resolution, **immediately before** the write. The write path must
        // not trust the resolution the check took: a symlink can be swapped while
        // the check runs, and the window between the check and the write is
        // exactly where it is swapped.
        const finalRefusal = snapshot.verify(ctx.toolUseId, input.file_path);
        if (finalRefusal !== undefined) {
          throw new ToolExecutionError(finalRefusal, TOOL_ERROR_CODES.pathChanged);
        }

        try {
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
      } finally {
        // The snapshot has served its purpose: the call is over, and the map must
        // not grow one entry per call for the life of the tool.
        snapshot.forget(ctx.toolUseId);
      }
    },
  };
}

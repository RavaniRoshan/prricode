/**
 * The `Edit` tool: replace a string in a file.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.5 (Permissions, "Tool
 * contract" and "File-mutating tools") and the `CC-008` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The edit is exact.** The string to replace has to appear in the file, and
 * unless the call asks for every occurrence to be replaced, it has to appear
 * **exactly once**: an edit that would change more than the caller asked for is a
 * refusal, not a guess.
 *
 * **An edit that would change nothing is suppressed.** The audit records the
 * file-write tool returning a typed failure with `errorCode: 14` for a suppressed
 * write, and this implementation produces that code when the replacement is the string that
 * would be replaced: there is nothing to write, so no write happens.
 *
 * **The write path re-resolves the path after the permission check**, exactly as
 * the `Write` tool does: a symlink swapped between the check and the write would
 * otherwise redirect the edit outside the area the check covered.
 *
 * The `Edit(...)` path rules apply to the tool, and the rule engine resolves the
 * path before the match — an allow rule requires **both** the requested path and
 * the resolved target to match, and a deny rule fires when either does.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { ToolExecutionError, TOOL_ERROR_CODES, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  PathSnapshot,
  absoluteToolPath,
  checkToolPermissions,
  optionalBooleanField,
  requireStringField,
  type BuiltinToolDeps,
} from './shared.js';

/** The input of the `Edit` tool. */
export interface EditInput {
  /** The path of the file to edit. */
  file_path: string;
  /** The string to replace. */
  old_string: string;
  /** The string to replace it with. */
  new_string: string;
  /** Whether every occurrence is replaced. */
  replace_all?: boolean;
}

/** The output of the `Edit` tool. */
export interface EditOutput {
  type: 'text';
  /** A short report of what was changed. */
  text: string;
  /** The path that was edited. */
  filePath: string;
  /** The number of occurrences that were replaced. */
  replacements: number;
}

/** The input schema of the `Edit` tool. */
export const EDIT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description: 'The path of the file to edit, absolute or relative to the working directory.',
    },
    old_string: {
      type: 'string',
      description: 'The string to replace. It must appear in the file.',
    },
    new_string: {
      type: 'string',
      description: 'The string to replace it with.',
    },
    replace_all: {
      type: 'boolean',
      description: 'Whether every occurrence is replaced. The default is a single occurrence.',
    },
  },
  required: ['file_path', 'old_string', 'new_string'],
  additionalProperties: false,
} as const;

/** The number of occurrences of a string in a text. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Create the `Edit` tool.
 */
export function createEditTool(deps: BuiltinToolDeps): ToolDefinition<EditInput, EditOutput> {
  const snapshot = new PathSnapshot(deps.cwd);

  return {
    name: 'Edit',
    description: 'Replace a string in a file.',
    inputSchema: EDIT_INPUT_SCHEMA,
    mutatesFiles: true,

    async checkPermissions(input, ctx: ToolContext) {
      snapshot.record(ctx.toolUseId, input.file_path);
      return checkToolPermissions(ctx, deps);
    },

    async validateInput(input) {
      const filePath = requireStringField(input, 'file_path', {
        invalidCode: TOOL_ERROR_CODES.invalidPath,
      });
      if (!filePath.ok) return filePath;
      // The string to replace must not be empty: replacing the empty string would
      // match everywhere.
      const oldString = requireStringField(input, 'old_string', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
      });
      if (!oldString.ok) return oldString;
      const newString = requireStringField(input, 'new_string', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
        allowEmpty: true,
      });
      if (!newString.ok) return newString;
      const replaceAll = optionalBooleanField(input, 'replace_all');
      if (!replaceAll.ok) return replaceAll;
      return { ok: true };
    },

    async execute(input, ctx) {
      const refusal = snapshot.verify(ctx.toolUseId, input.file_path);
      if (refusal !== undefined) {
        throw new ToolExecutionError(refusal, TOOL_ERROR_CODES.pathChanged);
      }

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

      const occurrences = countOccurrences(content, input.old_string);
      if (input.old_string === input.new_string) {
        // The write would change nothing, so it is **suppressed** rather than
        // performed. `14` is the code the audit records for a suppressed write.
        throw new ToolExecutionError(
          `The replacement is the string that would be replaced, so the write to '${filePath}' was suppressed.`,
          TOOL_ERROR_CODES.suppressedWrite,
        );
      }
      if (occurrences === 0) {
        throw new ToolExecutionError(
          `The string to replace does not appear in '${filePath}'.`,
          TOOL_ERROR_CODES.stringNotFound,
        );
      }
      if (occurrences > 1 && input.replace_all !== true) {
        throw new ToolExecutionError(
          `The string to replace appears ${occurrences} times in '${filePath}'; set 'replace_all' to replace every occurrence, or make the string unique.`,
          TOOL_ERROR_CODES.invalidInput,
        );
      }

      const updated =
        input.replace_all === true
          ? content.split(input.old_string).join(input.new_string)
          : content.replace(input.old_string, input.new_string);

      try {
        await writeFile(filePath, updated, 'utf8');
      } catch (error) {
        throw new ToolExecutionError(
          `The file '${filePath}' could not be written: ${(error as NodeJS.ErrnoException).message}`,
          TOOL_ERROR_CODES.executionFailed,
        );
      }

      return {
        type: 'text' as const,
        text: `Replaced ${occurrences} occurrence${occurrences === 1 ? '' : 's'} in ${filePath}.`,
        filePath,
        replacements: occurrences,
      };
    },
  };
}

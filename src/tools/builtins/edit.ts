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
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, filePath, replacements }` — is a
 *     implementation choice: the audit pins the tool-result *metadata*, not the content a
 *     tool returns.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { ToolExecutionError, TOOL_ERROR_CODES, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  PathSnapshot,
  absoluteToolPath,
  checkFileToolPermissions,
  fileToolSafetyCheck,
  recheckToolPermissions,
  optionalBooleanField,
  rejectUnknownFields,
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

    async checkPermissions(_input, ctx: ToolContext) {
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
      const fields = rejectUnknownFields(input, ['file_path', 'old_string', 'new_string', 'replace_all']);
      if (!fields.ok) return fields;
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
      try {
        // The path is resolved twice: once here, so the read does not follow a
        // symlink that was swapped after the check, and once **immediately before**
        // the write, so the window between the last resolution and the write is
        // as small as it can be.
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

        // The re-resolution, **immediately before** the write. The read above sits
        // between the check and the write, and a symlink can be swapped in that
        // window, so the path is resolved again right here.
        const finalRefusal = snapshot.verify(ctx.toolUseId, input.file_path);
        if (finalRefusal !== undefined) {
          throw new ToolExecutionError(finalRefusal, TOOL_ERROR_CODES.pathChanged);
        }

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
      } finally {
        // The snapshot has served its purpose: the call is over, and the map must
        // not grow one entry per call for the life of the tool.
        snapshot.forget(ctx.toolUseId);
      }
    },
  };
}

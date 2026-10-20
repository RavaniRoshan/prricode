/**
 * The `MultiEdit` tool: several edits to one file, applied in order.
 *
 * Evidence: the target's tool inventory, read out of the pinned build — the name
 * appears in the target's file-pattern tool set (`chunk-7hz7hhh6.js:9491`), in
 * its file-mutating set (`chunk-f27ph7ed.js:281051`) and in its response-member
 * table (`chunk-yy6ygzaq.js:1693`) — and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The edits are applied in order, and the file is written once.** Each edit
 * replaces a string in the content the previous edit produced, and the file is
 * written when every edit has been applied. A call that fails half way writes
 * **nothing**: the file on disk is the file the check approved.
 *
 * **An edit that changes nothing is refused**, exactly as the `Edit` tool refuses
 * it: the replacement is the string that would be replaced, so there is nothing
 * to write.
 *
 * **The write path re-resolves the path after the permission check**, exactly as
 * the `Edit` and `Write` tools do: a symlink swapped between the check and the
 * write would otherwise redirect the edit outside the area the check covered.
 *
 * **The `Edit(...)` path rules cover the tool.** The target says so in its own
 * rule validation: a `MultiEdit(path)` rule "is not matched by file permission
 * checks — only `Edit(path)` rules are", because the `Edit` rules cover every
 * file-editing tool. This implementation's rule engine therefore matches an
 * `Edit` rule against a `MultiEdit` call, and it still matches a `MultiEdit` rule
 * against a `MultiEdit` call.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **input shape** — `{ file_path, edits: [{ old_string, new_string,
 *     replace_all? }] }` — and the **output shape** — `{ type: 'text', text,
 *     filePath, replacements }` — are implementation choices: the target names the
 *     tool and its purpose; its own schema for this tool was not read out of the
 *     bundle.
 *   - The tool declares `mutatesFiles: true`, so the runner re-resolves its path
 *     around the check. The **file-mutating tool set** the audit pins is exactly
 *     `["Edit", "Write", "NotebookEdit"]` and is **not** changed by this: that set
 *     is the permission module's, and it stays as it is.
 */

import { readFile, writeFile } from 'node:fs/promises';

import { TOOL_ERROR_CODES, ToolExecutionError, type ToolDefinition } from '../registry.js';
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

/** One edit of the `MultiEdit` tool. */
export interface MultiEditEntry {
  /** The string to replace. */
  old_string: string;
  /** The string to replace it with. */
  new_string: string;
  /** Whether every occurrence is replaced. */
  replace_all?: boolean;
}

/** The input of the `MultiEdit` tool. */
export interface MultiEditInput {
  /** The path of the file to edit. */
  file_path: string;
  /** The edits, applied in order. */
  edits: MultiEditEntry[];
}

/** The output of the `MultiEdit` tool. */
export interface MultiEditOutput {
  type: 'text';
  /** A short report of what was changed. */
  text: string;
  /** The path that was edited. */
  filePath: string;
  /** The number of occurrences that were replaced. */
  replacements: number;
}

/** The input schema of the `MultiEdit` tool. */
export const MULTIEDIT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description: 'The path of the file to edit, absolute or relative to the working directory.',
    },
    edits: {
      type: 'array',
      minItems: 1,
      description: 'The edits, applied in order.',
      items: {
        type: 'object',
        properties: {
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
        required: ['old_string', 'new_string'],
        additionalProperties: false,
      },
    },
  },
  required: ['file_path', 'edits'],
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
 * Create the `MultiEdit` tool.
 */
export function createMultiEditTool(
  deps: BuiltinToolDeps,
): ToolDefinition<MultiEditInput, MultiEditOutput> {
  const snapshot = new PathSnapshot(deps.cwd);

  return {
    name: 'MultiEdit',
    description: 'Apply several edits to one file.',
    inputSchema: MULTIEDIT_INPUT_SCHEMA,
    // The tool writes the file, so the runner re-resolves its path around the
    // check. The pinned file-mutating **set** in the permission module is
    // unchanged.
    mutatesFiles: true,

    async checkPermissions(_input, ctx: ToolContext) {
      return checkFileToolPermissions(ctx, deps, snapshot, 'file_path');
    },

    async recheckPermission(_input, ctx: ToolContext) {
      return recheckToolPermissions(ctx, deps, {
        safetyCheck: fileToolSafetyCheck('file_path'),
        pathField: 'file_path',
      });
    },

    async validateInput(input) {
      const fields = rejectUnknownFields(input, ['file_path', 'edits']);
      if (!fields.ok) return fields;
      const filePath = requireStringField(input, 'file_path', {
        invalidCode: TOOL_ERROR_CODES.invalidPath,
      });
      if (!filePath.ok) return filePath;
      const edits = (input as { edits?: unknown }).edits;
      if (edits === undefined || edits === null) {
        return {
          ok: false,
          message: "The 'edits' argument is required.",
          errorCode: TOOL_ERROR_CODES.missingField,
        };
      }
      if (!Array.isArray(edits) || edits.length === 0) {
        return {
          ok: false,
          message: "The 'edits' argument must be a non-empty array.",
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      for (const entry of edits) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          return {
            ok: false,
            message: 'Every edit must be an object.',
            errorCode: TOOL_ERROR_CODES.invalidInput,
          };
        }
        const entryFields = rejectUnknownFields(entry, ['old_string', 'new_string', 'replace_all']);
        if (!entryFields.ok) return entryFields;
        const oldString = requireStringField(entry, 'old_string', {
          invalidCode: TOOL_ERROR_CODES.invalidInput,
        });
        if (!oldString.ok) return oldString;
        const newString = requireStringField(entry, 'new_string', {
          invalidCode: TOOL_ERROR_CODES.invalidInput,
          allowEmpty: true,
        });
        if (!newString.ok) return newString;
        const replaceAll = optionalBooleanField(entry, 'replace_all');
        if (!replaceAll.ok) return replaceAll;
      }
      return { ok: true };
    },

    async execute(input, ctx) {
      try {
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

        let updated = content;
        let replacements = 0;
        for (const [index, edit] of input.edits.entries()) {
          const occurrences = countOccurrences(updated, edit.old_string);
          if (edit.old_string === edit.new_string) {
            throw new ToolExecutionError(
              `Edit ${index + 1} replaces the string with itself, so the write to '${filePath}' was suppressed.`,
              TOOL_ERROR_CODES.suppressedWrite,
            );
          }
          if (occurrences === 0) {
            throw new ToolExecutionError(
              `The string to replace does not appear in '${filePath}' at edit ${index + 1}.`,
              TOOL_ERROR_CODES.stringNotFound,
            );
          }
          if (occurrences > 1 && edit.replace_all !== true) {
            throw new ToolExecutionError(
              `The string to replace appears ${occurrences} times in '${filePath}' at edit ${index + 1}; set 'replace_all' to replace every occurrence, or make the string unique.`,
              TOOL_ERROR_CODES.invalidInput,
            );
          }
          updated =
            edit.replace_all === true
              ? updated.split(edit.old_string).join(edit.new_string)
              : updated.replace(edit.old_string, edit.new_string);
          replacements += occurrences;
        }

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
          text: `Applied ${input.edits.length} edit${input.edits.length === 1 ? '' : 's'} to ${filePath}.`,
          filePath,
          replacements,
        };
      } finally {
        snapshot.forget(ctx.toolUseId);
      }
    },
  };
}

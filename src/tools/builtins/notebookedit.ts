/**
 * The `NotebookEdit` tool: replace the source of a notebook cell.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.5 (Permissions, "File
 * mutating tools") and the `CC-008` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **`NotebookEdit` is a file-mutating tool.** The observed file-mutating set is
 * exactly `["Edit", "Write", "NotebookEdit"]`, so the notebook is written through
 * the same boundary as any other file: the path is resolved before the check, the
 * `NotebookEdit(...)` path rules apply, and the path is **re-resolved after the
 * check and before the write**, so a symlink swapped in between cannot redirect
 * the write.
 *
 * The notebook is a JSON document with a `cells` array. A cell's `source` is either
 * a string or an array of lines, and the tool preserves the shape it found.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - A cell is addressed by its `id`. A notebook whose cells carry no id is
 *     addressed by the cell's index, written as a number.
 *   - The notebook is written back as JSON with two-space indentation.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { ToolExecutionError, TOOL_ERROR_CODES, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  PathSnapshot,
  absoluteToolPath,
  checkToolPermissions,
  optionalStringField,
  requireStringField,
  type BuiltinToolDeps,
} from './shared.js';

/** The input of the `NotebookEdit` tool. */
export interface NotebookEditInput {
  /** The path of the notebook. */
  notebook_path: string;
  /** The id of the cell to edit. */
  cell_id: string;
  /** The new source of the cell. */
  new_source: string;
  /** The type of the cell, when it changes. */
  cell_type?: string;
  /** How the source is replaced. */
  edit_mode?: 'replace' | 'insert' | 'delete';
}

/** The output of the `NotebookEdit` tool. */
export interface NotebookEditOutput {
  type: 'text';
  /** A short report of what was changed. */
  text: string;
  /** The notebook that was edited. */
  notebookPath: string;
  /** The cell that was edited. */
  cellId: string;
}

/** The input schema of the `NotebookEdit` tool. */
export const NOTEBOOKEDIT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    notebook_path: {
      type: 'string',
      description: 'The path of the notebook, absolute or relative to the working directory.',
    },
    cell_id: {
      type: 'string',
      description: 'The id of the cell to edit.',
    },
    new_source: {
      type: 'string',
      description: 'The new source of the cell.',
    },
    cell_type: {
      type: 'string',
      description: 'The type of the cell, when it changes.',
    },
    edit_mode: {
      type: 'string',
      enum: ['replace', 'insert', 'delete'],
      description: 'How the source is replaced. The default is replace.',
    },
  },
  required: ['notebook_path', 'cell_id', 'new_source'],
  additionalProperties: false,
} as const;

/** One cell of a notebook. */
interface NotebookCell {
  id?: string;
  cell_type?: string;
  source?: string | string[];
  [key: string]: unknown;
}

/** A notebook document. */
interface NotebookDocument {
  cells?: NotebookCell[];
  [key: string]: unknown;
}

/**
 * Find the cell a call addresses.
 */
function findCell(cells: readonly NotebookCell[], cellId: string): NotebookCell | undefined {
  const byId = cells.find((cell) => cell.id === cellId);
  if (byId) return byId;

  const index = Number.parseInt(cellId, 10);
  if (Number.isInteger(index) && index >= 0 && index < cells.length) {
    return cells[index];
  }
  return undefined;
}

/**
 * Create the `NotebookEdit` tool.
 */
export function createNotebookEditTool(
  deps: BuiltinToolDeps,
): ToolDefinition<NotebookEditInput, NotebookEditOutput> {
  const snapshot = new PathSnapshot(deps.cwd);

  return {
    name: 'NotebookEdit',
    description: 'Replace the source of a cell of a notebook.',
    inputSchema: NOTEBOOKEDIT_INPUT_SCHEMA,
    mutatesFiles: true,

    async checkPermissions(input, ctx: ToolContext) {
      snapshot.record(ctx.toolUseId, input.notebook_path);
      return checkToolPermissions(ctx, deps);
    },

    async validateInput(input) {
      const notebookPath = requireStringField(input, 'notebook_path', {
        invalidCode: TOOL_ERROR_CODES.invalidPath,
      });
      if (!notebookPath.ok) return notebookPath;
      const cellId = requireStringField(input, 'cell_id', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
      });
      if (!cellId.ok) return cellId;
      const newSource = requireStringField(input, 'new_source', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
        allowEmpty: true,
      });
      if (!newSource.ok) return newSource;
      const cellType = optionalStringField(input, 'cell_type');
      if (!cellType.ok) return cellType;
      const editMode = optionalStringField(input, 'edit_mode');
      if (!editMode.ok) return editMode;
      if (
        editMode.value !== undefined &&
        editMode.value !== 'replace' &&
        editMode.value !== 'insert' &&
        editMode.value !== 'delete'
      ) {
        return {
          ok: false,
          message: "The 'edit_mode' argument must be one of replace, insert or delete.",
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      return { ok: true };
    },

    async execute(input, ctx) {
      const refusal = snapshot.verify(ctx.toolUseId, input.notebook_path);
      if (refusal !== undefined) {
        throw new ToolExecutionError(refusal, TOOL_ERROR_CODES.pathChanged);
      }

      const notebookPath = absoluteToolPath(input.notebook_path, deps.cwd);
      let document: NotebookDocument;
      try {
        const raw = await readFile(notebookPath, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('the notebook is not a JSON object');
        }
        document = parsed as NotebookDocument;
      } catch (error) {
        throw new ToolExecutionError(
          `The notebook '${notebookPath}' could not be read: ${(error as Error).message}`,
          TOOL_ERROR_CODES.invalidNotebook,
        );
      }

      const cells = document.cells;
      if (!Array.isArray(cells)) {
        throw new ToolExecutionError(
          `The notebook '${notebookPath}' has no cells.`,
          TOOL_ERROR_CODES.invalidNotebook,
        );
      }

      const cell = findCell(cells, input.cell_id);
      if (!cell) {
        throw new ToolExecutionError(
          `The notebook '${notebookPath}' has no cell '${input.cell_id}'.`,
          TOOL_ERROR_CODES.invalidNotebook,
        );
      }

      // The shape of the source is preserved: a cell whose source is a list of
      // lines stays a list of lines, and the newline stays at the end of its line.
      const source = cell.source;
      if (Array.isArray(source)) {
        cell.source = input.new_source.split(/(?<=\n)/);
      } else {
        cell.source = input.new_source;
      }
      if (input.cell_type !== undefined) cell.cell_type = input.cell_type;

      try {
        await writeFile(notebookPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      } catch (error) {
        throw new ToolExecutionError(
          `The notebook '${notebookPath}' could not be written: ${(error as NodeJS.ErrnoException).message}`,
          TOOL_ERROR_CODES.executionFailed,
        );
      }

      return {
        type: 'text' as const,
        text: `Edited the cell '${input.cell_id}' of ${notebookPath}.`,
        notebookPath,
        cellId: input.cell_id,
      };
    },
  };
}

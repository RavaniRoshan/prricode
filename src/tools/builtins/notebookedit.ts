/**
 * The `NotebookEdit` tool: change a cell of a notebook.
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
 * **The three edit modes are implemented.** The schema advertises `replace`,
 * `insert` and `delete`, and a model will send them, so a mode that was accepted
 * and then ignored would be a silent wrong action: `delete` removes the cell and
 * `insert` adds a cell after it.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - A cell is addressed by its `id`. A notebook whose cells carry no id is
 *     addressed by the cell's index, written as a number.
 *   - The notebook is written back as JSON with two-space indentation.
 *   - The **output shape** — `{ type: 'text', text, notebookPath, cellId }` — is a
 *     implementation choice: the audit pins the tool-result *metadata*, not the content a
 *     tool returns.
 *   - The **semantics of the edit modes** are a implementation choice as well: the audit
 *     names the file-mutating tool set, not what a mode does. `replace` replaces
 *     the source of the addressed cell, `insert` adds a cell **after** it, and
 *     `delete` removes it.
 *   - The **id of an inserted cell** is generated: the first `inserted-<n>` that
 *     the notebook does not already use. The audit does not name an id scheme.
 *   - An inserted cell takes the `cell_type` of the call, or the one of the cell
 *     it is inserted after when the call does not name one.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { ToolExecutionError, TOOL_ERROR_CODES, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  PathSnapshot,
  absoluteToolPath,
  checkFileToolPermissions,
  denyDecisionFor,
  optionalStringField,
  rejectUnknownFields,
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

/** The three edit modes the tool implements. */
export const NOTEBOOK_EDIT_MODES = ['replace', 'insert', 'delete'] as const;

/** The modes the validator accepts. */
const NOTEBOOK_EDIT_MODE_SET: ReadonlySet<string> = new Set(NOTEBOOK_EDIT_MODES);

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
 * The index of the cell a call addresses.
 *
 * A cell is addressed by its `id`; a notebook whose cells carry no id is addressed
 * by the cell's index, written as a number.
 */
function indexOfCell(cells: readonly NotebookCell[], cellId: string): number {
  const byId = cells.findIndex((cell) => cell.id === cellId);
  if (byId !== -1) return byId;

  const index = Number.parseInt(cellId, 10);
  if (Number.isInteger(index) && index >= 0 && index < cells.length) return index;
  return -1;
}

/**
 * The id of a cell that is inserted into a notebook.
 *
 * The first `inserted-<n>` the notebook does not already use, so an inserted cell
 * is addressable by its id like every other cell.
 */
function insertedCellId(cells: readonly NotebookCell[]): string {
  const used = new Set(cells.map((cell) => cell.id));
  for (let n = 1; ; n += 1) {
    const id = `inserted-${n}`;
    if (!used.has(id)) return id;
  }
}

/**
 * The source of a cell, in the shape the notebook uses.
 *
 * A cell whose source is a list of lines stays a list of lines, and the newline
 * stays at the end of its line.
 */
function sourceInShape(shape: unknown, newSource: string): string | string[] {
  if (Array.isArray(shape)) return newSource.split(/(?<=\n)/);
  return newSource;
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
    description: 'Change a cell of a notebook: replace its source, insert a cell or delete one.',
    inputSchema: NOTEBOOKEDIT_INPUT_SCHEMA,
    mutatesFiles: true,

    async checkPermissions(_input, ctx: ToolContext) {
      // The snapshot is of the path the call will act on, so it is taken once the
      // check — and any rewrite it carried — is known.
      return checkFileToolPermissions(ctx, deps, snapshot, 'notebook_path');
    },

    async recheckDeny(_input, ctx: ToolContext) {
      // A hook may have rewritten the input onto a path the deny list covers.
      return denyDecisionFor(ctx, deps);
    },

    async validateInput(input) {
      const fields = rejectUnknownFields(input, [
        'notebook_path',
        'cell_id',
        'new_source',
        'cell_type',
        'edit_mode',
      ]);
      if (!fields.ok) return fields;
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
      if (editMode.value !== undefined && !NOTEBOOK_EDIT_MODE_SET.has(editMode.value)) {
        return {
          ok: false,
          message: "The 'edit_mode' argument must be one of replace, insert or delete.",
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      return { ok: true };
    },

    async execute(input, ctx) {
      try {
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

        const index = indexOfCell(cells, input.cell_id);
        const cell = index === -1 ? undefined : cells[index];
        if (!cell) {
          throw new ToolExecutionError(
            `The notebook '${notebookPath}' has no cell '${input.cell_id}'.`,
            TOOL_ERROR_CODES.invalidNotebook,
          );
        }

        const mode = input.edit_mode ?? 'replace';
        let cellId = input.cell_id;
        let text: string;

        if (mode === 'delete') {
          cells.splice(index, 1);
          text = `Deleted the cell '${input.cell_id}' of ${notebookPath}.`;
        } else if (mode === 'insert') {
          const inserted: NotebookCell = {
            id: insertedCellId(cells),
            source: sourceInShape(cell.source, input.new_source),
          };
          const cellType = input.cell_type ?? cell.cell_type;
          if (cellType !== undefined) inserted.cell_type = cellType;
          cells.splice(index + 1, 0, inserted);
          cellId = inserted.id ?? input.cell_id;
          text = `Inserted the cell '${cellId}' into ${notebookPath}.`;
        } else {
          cell.source = sourceInShape(cell.source, input.new_source);
          if (input.cell_type !== undefined) cell.cell_type = input.cell_type;
          text = `Edited the cell '${input.cell_id}' of ${notebookPath}.`;
        }

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
          text,
          notebookPath,
          cellId,
        };
      } finally {
        // The snapshot has served its purpose: the call is over, and the map must
        // not grow one entry per call for the life of the tool.
        snapshot.forget(ctx.toolUseId);
      }
    },
  };
}

/**
 * The `NotebookRead` tool: read a Jupyter notebook.
 *
 * Evidence: the target's tool inventory, read out of the pinned build — the name
 * appears in the target's own file-pattern tool set (`chunk-c9s0jh80.js:229728`),
 * in its read-tool set (`chunk-3r7fz8m2.js:118230`) and in its tool table
 * (`chunk-7hz7hhh6.js:9568`) — and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The notebook is a JSON document, and the tool reads its cells.** A notebook
 * file holds a `cells` array; every cell has a `cell_type` (`code` or `markdown`)
 * and a `source`, and a code cell may carry `outputs`, an `execution_count` and a
 * `language`. The tool reports the cells, and it reports them in the shape the
 * target's own notebook output uses — `cellType`, `source`, `execution_count`,
 * `cell_id`, `language` and `outputs`.
 *
 * **The tool is read-only.** It writes nothing, so it is **not** file-mutating:
 * the observed file-mutating set is exactly `["Edit", "Write", "NotebookEdit"]`.
 *
 * **The `NotebookRead(...)` path rules apply to it**, because the target lists it
 * among the file-pattern tools. The path field is `notebook_path`, and the rule
 * engine resolves the path before the match.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **input shape** — `{ notebook_path }` — and the **output shape** —
 *     `{ type: 'text', text, notebookPath, cells }` — are implementation choices.
 *     The target names the tool and its purpose; its own schema for this tool was
 *     not read out of the bundle.
 *   - A notebook that is not a notebook — a file that is not JSON, or JSON without
 *     a `cells` array — is a **typed failure**, not an empty list.
 */

import { readFile } from 'node:fs/promises';

import { TOOL_ERROR_CODES, ToolExecutionError, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  absoluteToolPath,
  checkToolPermissions,
  fileToolSafetyCheck,
  recheckToolPermissions,
  rejectUnknownFields,
  requireStringField,
  type BuiltinToolDeps,
} from './shared.js';

/** One cell of a notebook. */
export interface NotebookCell {
  /** Whether the cell is a code cell or a markdown cell. */
  cellType: string;
  /** The cell's source. */
  source: string;
  /** The cell's id, when the notebook gives it one. */
  cell_id?: string;
  /** The number the cell was executed under, when it was executed. */
  execution_count?: number;
  /** The language of a code cell. */
  language?: string;
  /** The cell's outputs, when it has any. */
  outputs?: unknown[];
}

/** The input of the `NotebookRead` tool. */
export interface NotebookReadInput {
  /** The path of the notebook. */
  notebook_path: string;
}

/** The output of the `NotebookRead` tool. */
export interface NotebookReadOutput {
  type: 'text';
  /** A short report of what was read. */
  text: string;
  /** The path of the notebook. */
  notebookPath: string;
  /** The cells of the notebook. */
  cells: NotebookCell[];
}

/** The input schema of the `NotebookRead` tool. */
export const NOTEBOOKREAD_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    notebook_path: {
      type: 'string',
      description: 'The path of the Jupyter notebook to read, absolute or relative to the working directory.',
    },
  },
  required: ['notebook_path'],
  additionalProperties: false,
} as const;

/**
 * Create the `NotebookRead` tool.
 */
export function createNotebookReadTool(
  deps: BuiltinToolDeps,
): ToolDefinition<NotebookReadInput, NotebookReadOutput> {
  return {
    name: 'NotebookRead',
    description: 'Read the cells of a Jupyter notebook.',
    inputSchema: NOTEBOOKREAD_INPUT_SCHEMA,
    mutatesFiles: false,

    // A read is **concurrency safe**: the target declares the flag for the read
    // tools, so the call may run beside the other safe calls of the message.
    isConcurrencySafe(): boolean {
      return true;
    },

    async checkPermissions(_input, ctx: ToolContext) {
      return checkToolPermissions(ctx, deps, { safetyCheck: fileToolSafetyCheck('notebook_path') });
    },

    async recheckPermission(_input, ctx: ToolContext) {
      return recheckToolPermissions(ctx, deps, {
        safetyCheck: fileToolSafetyCheck('notebook_path'),
        pathField: 'notebook_path',
      });
    },

    async validateInput(input) {
      const fields = rejectUnknownFields(input, ['notebook_path']);
      if (!fields.ok) return fields;
      const path = requireStringField(input, 'notebook_path', {
        invalidCode: TOOL_ERROR_CODES.invalidPath,
      });
      if (!path.ok) return path;
      return { ok: true };
    },

    async execute(input) {
      const notebookPath = absoluteToolPath(input.notebook_path, deps.cwd);
      let raw: string;
      try {
        raw = await readFile(notebookPath, 'utf8');
      } catch (error) {
        throw new ToolExecutionError(
          `The notebook '${notebookPath}' could not be read: ${(error as NodeJS.ErrnoException).message}`,
          TOOL_ERROR_CODES.fileNotFound,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new ToolExecutionError(
          `The file '${notebookPath}' is not a JSON document, so it is not a notebook.`,
          TOOL_ERROR_CODES.invalidNotebook,
        );
      }

      const cells = readCells(parsed);
      if (cells === undefined) {
        throw new ToolExecutionError(
          `The file '${notebookPath}' has no 'cells' array, so it is not a notebook.`,
          TOOL_ERROR_CODES.invalidNotebook,
        );
      }

      return {
        type: 'text' as const,
        text: `Read ${cells.length} cell${cells.length === 1 ? '' : 's'} from ${notebookPath}.`,
        notebookPath,
        cells,
      };
    },
  };
}

/**
 * The cells of a parsed notebook, or `undefined` when the document is not one.
 *
 * The document is caller-supplied data, so every field is read as an **own**
 * property.
 */
function readCells(parsed: unknown): NotebookCell[] | undefined {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (!Object.hasOwn(record, 'cells')) return undefined;
  const cells = record['cells'];
  if (!Array.isArray(cells)) return undefined;

  const result: NotebookCell[] = [];
  for (const entry of cells) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const cell = entry as Record<string, unknown>;
    const cellType = readString(cell, 'cell_type');
    if (cellType === undefined) continue;
    const source = readSource(cell['source']);
    const cellId = readString(cell, 'id');
    const executionCount = readNumber(cell, 'execution_count');
    const language = readMetadataLanguage(cell);
    const outputs = Array.isArray(cell['outputs']) ? cell['outputs'] : undefined;
    result.push({
      cellType,
      source,
      ...(cellId === undefined ? {} : { cell_id: cellId }),
      ...(executionCount === undefined ? {} : { execution_count: executionCount }),
      ...(language === undefined ? {} : { language }),
      ...(outputs === undefined ? {} : { outputs }),
    });
  }
  return result;
}

/** Read an own string field of an object. */
function readString(record: Record<string, unknown>, field: string): string | undefined {
  if (!Object.hasOwn(record, field)) return undefined;
  const value = record[field];
  return typeof value === 'string' ? value : undefined;
}

/** Read an own number field of an object. */
function readNumber(record: Record<string, unknown>, field: string): number | undefined {
  if (!Object.hasOwn(record, field)) return undefined;
  const value = record[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The language of a cell, which a notebook holds in the cell's own metadata.
 */
function readMetadataLanguage(cell: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(cell, 'metadata')) return undefined;
  const metadata = cell['metadata'];
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return undefined;
  const record = metadata as Record<string, unknown>;
  if (!Object.hasOwn(record, 'language')) return undefined;
  const language = record['language'];
  return typeof language === 'string' ? language : undefined;
}

/**
 * The source of a cell.
 *
 * A notebook may hold the source as a string or as an array of lines; both are
 * read, and the array is joined.
 */
function readSource(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .filter((line): line is string => typeof line === 'string')
    .join('');
}

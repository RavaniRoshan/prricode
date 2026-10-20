/**
 * The `Grep` tool: search the contents of files.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.5 (Permissions, "Tool
 * contract") and the `CC-008` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **A `Read(...)` deny rule applies to the files a search reaches.** The `2.1.251`
 * fix the research records names `Grep` beside `Glob`: "Grep and Glob not applying
 * `Read(...)` deny rules to files reached through a symlinked search path". The
 * search follows a symlinked directory, and every file it reads is checked against
 * the `Read` rules — and the rule engine resolves the path before the match, so a
 * deny rule fires when **either** the requested path or the resolved target
 * matches.
 *
 * The `Grep` tool itself is not file-mutating: the observed file-mutating set is
 * exactly `["Edit", "Write", "NotebookEdit"]`.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The pattern is a JavaScript regular expression. A pattern that does not
 *     compile is a typed validation failure rather than a crash.
 *   - The pattern, the file size and the number of files are **bounded**: the
 *     pattern comes from the model and the content comes from the disk, so an
 *     unbounded regular expression over an unbounded file is a denial-of-service
 *     waiting to happen. The bounds are this implementation's, not the target's. The bound
 *     on the number of files is on the files the search **reads**, not on the
 *     files that match: a tree of files that do not match is read in full
 *     otherwise.
 *   - The output modes are `files_with_matches` (the default), `content` and
 *     `count`.
 *   - The **output shape** — `{ type: 'text', text, files, matches, counts,
 *     truncated }` — is a implementation choice: the audit pins the tool-result *metadata*,
 *     not the content a tool returns.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { commandGlobMatch } from '../../permissions/paths.js';
import { TOOL_ERROR_CODES, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  absoluteToolPath,
  checkToolPermissions,
  recheckToolPermissions,
  isDeniedByReadRule,
  optionalStringField,
  rejectUnknownFields,
  requireStringField,
  walkFiles,
  type BuiltinToolDeps,
} from './shared.js';

/** The input of the `Grep` tool. */
export interface GrepInput {
  /** The regular expression to search for. */
  pattern: string;
  /** The directory to search. The working directory by default. */
  path?: string;
  /** A glob the files have to match. */
  glob?: string;
  /** What the search reports. */
  output_mode?: 'files_with_matches' | 'content' | 'count';
}

/** One match of a search. */
export interface GrepMatch {
  /** The file the match is in. */
  file: string;
  /** The line the match is on, counting from one. */
  line: number;
  /** The text of the line. */
  text: string;
}

/** The output of the `Grep` tool. */
export interface GrepOutput {
  type: 'text';
  /** The report of the search. */
  text: string;
  /** The files that matched. */
  files: string[];
  /** The matches, in `content` mode. */
  matches: GrepMatch[];
  /** The number of matches per file, in `count` mode. */
  counts: Record<string, number>;
  /** Whether the search was capped. */
  truncated: boolean;
}

/** The input schema of the `Grep` tool. */
export const GREP_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description: 'The regular expression to search for.',
    },
    path: {
      type: 'string',
      description: 'The directory to search. The working directory by default.',
    },
    glob: {
      type: 'string',
      description: 'A glob the files have to match.',
    },
    output_mode: {
      type: 'string',
      enum: ['files_with_matches', 'content', 'count'],
      description: 'What the search reports. The default is files_with_matches.',
    },
  },
  required: ['pattern'],
  additionalProperties: false,
} as const;

/** The longest regular expression a search accepts. */
export const MAX_GREP_PATTERN_LENGTH = 512;

/** The largest file a search reads. */
export const MAX_GREP_FILE_BYTES = 1024 * 1024;

/** The largest number of files a search reads. */
export const MAX_GREP_FILES = 2000;

/** The largest number of matches a search reports. */
export const MAX_GREP_MATCHES = 500;

/**
 * Whether a file matches a glob pattern.
 *
 * The pattern is matched against the file's name and against its path relative to
 * the search directory, so `*.ts` and `src/*.ts` both work.
 */
function matchesGlob(pattern: string, file: string, root: string): boolean {
  const relative = path.relative(root, file);
  if (commandGlobMatch(pattern, path.basename(file))) return true;
  return commandGlobMatch(pattern, relative);
}

/**
 * Compile a search pattern.
 *
 * A pattern that does not compile is a typed validation failure rather than a
 * crash.
 */
export function compilePattern(pattern: string): RegExp {
  return new RegExp(pattern);
}

/**
 * Create the `Grep` tool.
 */
export function createGrepTool(deps: BuiltinToolDeps): ToolDefinition<GrepInput, GrepOutput> {
  return {
    name: 'Grep',
    description: 'Search the contents of files.',
    inputSchema: GREP_INPUT_SCHEMA,
    mutatesFiles: false,

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
      const fields = rejectUnknownFields(input, ['pattern', 'path', 'glob', 'output_mode']);
      if (!fields.ok) return fields;
      const pattern = requireStringField(input, 'pattern', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
      });
      if (!pattern.ok) return pattern;
      if (pattern.value.length > MAX_GREP_PATTERN_LENGTH) {
        return {
          ok: false,
          message: `The 'pattern' argument must not be longer than ${MAX_GREP_PATTERN_LENGTH} characters.`,
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      try {
        compilePattern(pattern.value);
      } catch (error) {
        return {
          ok: false,
          message: `The 'pattern' argument is not a valid regular expression: ${(error as Error).message}`,
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      const search = optionalStringField(input, 'path', {
        invalidCode: TOOL_ERROR_CODES.invalidPath,
      });
      if (!search.ok) return search;
      const glob = optionalStringField(input, 'glob');
      if (!glob.ok) return glob;
      const mode = optionalStringField(input, 'output_mode');
      if (!mode.ok) return mode;
      if (
        mode.value !== undefined &&
        mode.value !== 'files_with_matches' &&
        mode.value !== 'content' &&
        mode.value !== 'count'
      ) {
        return {
          ok: false,
          message:
            "The 'output_mode' argument must be one of files_with_matches, content or count.",
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      return { ok: true };
    },

    async execute(input) {
      const cwd = deps.cwd ?? process.cwd();
      const root = input.path ? absoluteToolPath(input.path, cwd) : cwd;
      const mode = input.output_mode ?? 'files_with_matches';
      const expression = compilePattern(input.pattern);

      const candidates = await walkFiles(root);
      const files: string[] = [];
      const matches: GrepMatch[] = [];
      const counts: Record<string, number> = {};
      let truncated = false;
      // The number of files the search **read**. The bound is on the files that
      // are read, not on the files that match: a tree of files that do not
      // match would otherwise be read in full.
      let examined = 0;

      for (const candidate of candidates) {
        if (examined >= MAX_GREP_FILES) {
          truncated = true;
          break;
        }
        if (input.glob !== undefined && !matchesGlob(input.glob, candidate, root)) continue;
        // A `Read(...)` deny rule applies to the files the search reaches, including
        // the ones reached through a symlinked search path.
        if (isDeniedByReadRule(candidate, deps)) continue;

        let size: number;
        try {
          size = (await stat(candidate)).size;
        } catch {
          continue;
        }
        if (size > MAX_GREP_FILE_BYTES) continue;

        let content: string;
        try {
          content = await readFile(candidate, 'utf8');
        } catch {
          continue;
        }
        examined += 1;
        // A file with a NUL byte in it is a binary file, not text.
        if (content.includes('\u0000')) continue;

        const lines = content.split('\n');
        let fileMatches = 0;
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? '';
          if (!expression.test(line)) continue;
          fileMatches += 1;
          if (mode === 'content' && matches.length < MAX_GREP_MATCHES) {
            matches.push({ file: candidate, line: index + 1, text: line });
          }
        }
        if (fileMatches === 0) continue;

        files.push(candidate);
        counts[candidate] = fileMatches;
        if (matches.length >= MAX_GREP_MATCHES) truncated = true;
      }

      const text =
        mode === 'content'
          ? matches.map((match) => `${match.file}:${match.line}:${match.text}`).join('\n')
          : mode === 'count'
            ? Object.entries(counts)
                .map(([file, count]) => `${file}:${count}`)
                .join('\n')
            : files.join('\n');

      return {
        type: 'text' as const,
        text,
        files,
        matches,
        counts,
        truncated,
      };
    },
  };
}

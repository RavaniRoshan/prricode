/**
 * The `Glob` tool: find the files that match a pattern.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.5 (Permissions, "Tool
 * contract") and the `CC-008` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **A `Read(...)` deny rule applies to the files a search reaches.** The `2.1.251`
 * fix the research records is exactly this: "Grep and Glob not applying `Read(...)`
 * deny rules to files reached through a symlinked search path". The search follows
 * a symlinked directory, and every file it reports is checked against the `Read`
 * rules — and the rule engine resolves the path before the match, so a deny rule
 * fires when **either** the requested path or the resolved target matches. A file
 * reached through a symlink into a denied area is therefore **not** reported.
 *
 * The `Glob` tool itself is not file-mutating: the observed file-mutating set is
 * exactly `["Edit", "Write", "NotebookEdit"]`.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The pattern is matched against the path **relative to the search directory**,
 *     with `*` matching within one path segment, `**` crossing segments and `?`
 *     matching one character.
 *   - The number of files a search reports is capped, so a search over a huge tree
 *     does not fill the context window.
 *   - The **output shape** — `{ type: 'text', text, files, truncated }` — is a reimplementation
 *     choice: the audit pins the tool-result *metadata*, not the content a tool
 *     returns.
 */

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

/** The input of the `Glob` tool. */
export interface GlobInput {
  /** The pattern to match. */
  pattern: string;
  /** The directory to search. The working directory by default. */
  path?: string;
}

/** The output of the `Glob` tool. */
export interface GlobOutput {
  type: 'text';
  /** The list of the files that matched. */
  text: string;
  /** The files that matched. */
  files: string[];
  /** Whether the list was capped. */
  truncated: boolean;
}

/** The input schema of the `Glob` tool. */
export const GLOB_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description:
        'The pattern to match. `*` matches within one path segment, `**` crosses segments, and `?` matches one character.',
    },
    path: {
      type: 'string',
      description: 'The directory to search. The working directory by default.',
    },
  },
  required: ['pattern'],
  additionalProperties: false,
} as const;

/** The largest number of files a search reports. */
export const MAX_GLOB_RESULTS = 1000;

/**
 * Match a pattern against a path, segment by segment.
 *
 * `**` matches any number of segments, `*` and `?` match within one segment.
 */
function matchesPattern(patternSegments: readonly string[], pathSegments: readonly string[]): boolean {
  if (patternSegments.length === 0) return pathSegments.length === 0;
  const head = patternSegments[0];
  if (head === undefined) return pathSegments.length === 0;
  if (head === '**') {
    for (let skip = 0; skip <= pathSegments.length; skip += 1) {
      if (matchesPattern(patternSegments.slice(1), pathSegments.slice(skip))) return true;
    }
    return false;
  }
  const candidate = pathSegments[0];
  if (candidate === undefined) return false;
  if (!commandGlobMatch(head, candidate)) return false;
  return matchesPattern(patternSegments.slice(1), pathSegments.slice(1));
}

/**
 * Create the `Glob` tool.
 */
export function createGlobTool(deps: BuiltinToolDeps): ToolDefinition<GlobInput, GlobOutput> {
  return {
    name: 'Glob',
    description: 'Find the files that match a pattern.',
    inputSchema: GLOB_INPUT_SCHEMA,
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
      const fields = rejectUnknownFields(input, ['pattern', 'path']);
      if (!fields.ok) return fields;
      const pattern = requireStringField(input, 'pattern', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
      });
      if (!pattern.ok) return pattern;
      const search = optionalStringField(input, 'path', {
        invalidCode: TOOL_ERROR_CODES.invalidPath,
      });
      if (!search.ok) return search;
      return { ok: true };
    },

    async execute(input) {
      const cwd = deps.cwd ?? process.cwd();
      const pattern = input.pattern;
      const absolutePattern = path.isAbsolute(pattern);
      const searchRoot = input.path
        ? absoluteToolPath(input.path, cwd)
        : absolutePattern
          ? path.dirname(pattern)
          : cwd;
      const relativePattern = absolutePattern ? path.basename(pattern) : pattern;

      const patternSegments = relativePattern.split('/').filter((segment) => segment.length > 0);
      const candidates = await walkFiles(searchRoot);

      const files: string[] = [];
      let truncated = false;
      for (const candidate of candidates) {
        const relative = path.relative(searchRoot, candidate);
        if (relative.length === 0) continue;
        const segments = relative.split(path.sep);
        if (!matchesPattern(patternSegments, segments)) continue;
        // A `Read(...)` deny rule applies to the files the search reaches, including
        // the ones reached through a symlinked search path.
        if (isDeniedByReadRule(candidate, deps)) continue;
        if (files.length >= MAX_GLOB_RESULTS) {
          truncated = true;
          break;
        }
        files.push(candidate);
      }

      files.sort();
      return {
        type: 'text' as const,
        text: files.join('\n'),
        files,
        truncated,
      };
    },
  };
}

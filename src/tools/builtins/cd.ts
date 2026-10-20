/**
 * The `Cd` tool: change the working directory.
 *
 * Evidence: the target's `Cd` tool, read out of the pinned build
 * (`chunk-e2q22x9w.js:1904`, where the tool's own permission matcher resolves a
 * requested path and a canonical path), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The `Cd(...)` path rules apply to it**, because the target lists it among the
 * file-pattern tools. The path field is `path`, and the rule engine resolves the
 * path before the match.
 *
 * **The session's working directory is the session's.** The tool resolves the
 * path and hands it to the session through
 * `capabilities.changeDirectory`; a session that supplies none gets a **typed
 * refusal**, because a tool that reported a directory it did not move to would
 * be a lie the next call would be built on.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **input shape** — `{ path }` — and the **output shape** —
 *     `{ type: 'text', text, path }` — are implementation choices. The target
 *     resolves a requested path and a canonical path; this implementation resolves
 *     one path and reports the directory it resolved to.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';

import { TOOL_ERROR_CODES, ToolExecutionError, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  absoluteToolPath,
  checkToolPermissions,
  recheckToolPermissions,
  rejectUnknownFields,
  requireStringField,
  type BuiltinToolDeps,
} from './shared.js';

/** The input of the `Cd` tool. */
export interface CdInput {
  /** The directory to move to. */
  path: string;
}

/** The output of the `Cd` tool. */
export interface CdOutput {
  type: 'text';
  /** A short report of what happened. */
  text: string;
  /** The directory the session moved to. */
  path: string;
}

/** The input schema of the `Cd` tool. */
export const CD_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'The directory to move to, absolute or relative to the working directory.',
    },
  },
  required: ['path'],
  additionalProperties: false,
} as const;

/**
 * Create the `Cd` tool.
 */
export function createCdTool(deps: BuiltinToolDeps): ToolDefinition<CdInput, CdOutput> {
  return {
    name: 'Cd',
    description: 'Change the working directory of the session.',
    inputSchema: CD_INPUT_SCHEMA,
    mutatesFiles: false,

    async checkPermissions(_input, ctx: ToolContext) {
      return checkToolPermissions(ctx, deps);
    },

    async recheckPermission(_input, ctx: ToolContext) {
      return recheckToolPermissions(ctx, deps);
    },

    async validateInput(input) {
      const fields = rejectUnknownFields(input, ['path']);
      if (!fields.ok) return fields;
      const target = requireStringField(input, 'path', {
        invalidCode: TOOL_ERROR_CODES.invalidPath,
      });
      if (!target.ok) return target;
      return { ok: true };
    },

    async execute(input) {
      const resolved = absoluteToolPath(input.path, deps.cwd);
      let stats;
      try {
        stats = await stat(resolved);
      } catch (error) {
        throw new ToolExecutionError(
          `The directory '${resolved}' could not be read: ${(error as NodeJS.ErrnoException).message}`,
          TOOL_ERROR_CODES.invalidPath,
        );
      }
      if (!stats.isDirectory()) {
        throw new ToolExecutionError(
          `The path '${resolved}' is not a directory.`,
          TOOL_ERROR_CODES.invalidPath,
        );
      }

      const changeDirectory = deps.capabilities?.changeDirectory;
      if (changeDirectory === undefined) {
        throw new ToolExecutionError(
          "The 'Cd' tool needs a session that can change its working directory, which this session does not have, so the call was refused.",
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }

      const moved = await changeDirectory(resolved);
      return {
        type: 'text' as const,
        text: `The working directory is now ${moved}.`,
        path: path.resolve(moved),
      };
    },
  };
}

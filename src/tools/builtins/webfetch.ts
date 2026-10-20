/**
 * The `WebFetch` tool: fetch a URL.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.5 (Permissions, "Tool
 * contract" and "Host-level gates") and the `CC-008` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **A fetch whose arguments cannot be verified is refused.** The audit records a
 * `PermissionRequest` hook that may approve a `WebFetch`, and a safety check that
 * then refuses to run a fetch whose approved arguments the tool cannot verify. The
 * refusal is a `safetyCheck`, not a user denial — the source is the hook, never
 * `user_reject` — and the reason states that nothing was fetched.
 *
 * **The safety check runs before the rule engine**, because it is independent of
 * it and holds in every mode, including `bypassPermissions`. The tool's own check
 * is `safetyCheckForTool`, which refuses a URL that is not an http(s) URL.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The fetch has a timeout and a response-size cap, so a fetch cannot hang the
 *     session or fill the context window.
 *   - The tool reports the response's status and its body as text.
 */

import { TOOL_ERROR_CODES, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import { checkToolPermissions, requireStringField, type BuiltinToolDeps } from './shared.js';

/** The input of the `WebFetch` tool. */
export interface WebFetchInput {
  /** The URL to fetch. */
  url: string;
  /** What the caller wants from the page. */
  prompt?: string;
}

/** The output of the `WebFetch` tool. */
export interface WebFetchOutput {
  type: 'text';
  /** The body of the response. */
  text: string;
  /** The URL that was fetched. */
  url: string;
  /** The status of the response. */
  status: number;
  /** Whether the body was capped. */
  truncated: boolean;
}

/** The input schema of the `WebFetch` tool. */
export const WEBFETCH_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      description: 'The URL to fetch.',
    },
    prompt: {
      type: 'string',
      description: 'What the caller wants from the page.',
    },
  },
  required: ['url'],
  additionalProperties: false,
} as const;

/** The timeout of a fetch. */
export const WEBFETCH_TIMEOUT_MS = 30_000;

/** The largest response body the tool reports. */
export const MAX_WEBFETCH_BYTES = 5 * 1024 * 1024;

/**
 * Create the `WebFetch` tool.
 */
export function createWebFetchTool(
  deps: BuiltinToolDeps,
): ToolDefinition<WebFetchInput, WebFetchOutput> {
  return {
    name: 'WebFetch',
    description: 'Fetch a URL and report its content.',
    inputSchema: WEBFETCH_INPUT_SCHEMA,
    mutatesFiles: false,

    async checkPermissions(_input, ctx: ToolContext) {
      return checkToolPermissions(ctx, deps);
    },

    async validateInput(input) {
      const url = requireStringField(input, 'url', {
        invalidCode: TOOL_ERROR_CODES.invalidUrl,
      });
      if (!url.ok) return url;
      let parsed: URL;
      try {
        parsed = new URL(url.value);
      } catch {
        return {
          ok: false,
          message: `The 'url' argument '${url.value}' is not a valid URL.`,
          errorCode: TOOL_ERROR_CODES.invalidUrl,
        };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return {
          ok: false,
          message: `The 'url' argument '${url.value}' is not an http(s) URL.`,
          errorCode: TOOL_ERROR_CODES.invalidUrl,
        };
      }
      return { ok: true };
    },

    async execute(input) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WEBFETCH_TIMEOUT_MS);
      try {
        const response = await fetch(input.url, { signal: controller.signal });
        const body = await response.text();
        const truncated = body.length > MAX_WEBFETCH_BYTES;
        return {
          type: 'text' as const,
          text: truncated ? body.slice(0, MAX_WEBFETCH_BYTES) : body,
          url: input.url,
          status: response.status,
          truncated,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The `WebSearch` tool: search the web.
 *
 * Evidence: the target's `WebSearch` tool, read out of the pinned build
 * (`chunk-705mhzj8.js:41616`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own input shape, reproduced.** The target's schema is
 * `{ query: string (at least two characters), allowed_domains?: string[],
 * blocked_domains?: string[] }`, and its validator refuses an empty query and
 * refuses a call that names **both** an allow list and a block list.
 *
 * **The target's own output shape, reproduced.** The target answers with
 * `{ query, results, durationSeconds, searchCount }`, where a result is either a
 * `{ tool_use_id, content }` pair of search hits or the model's own commentary.
 *
 * **The search itself is a capability.** The target's search is a **server tool**:
 * the request carries the query and the server performs the search. This
 * implementation has no such server, so the session supplies the backend through
 * `capabilities.webSearch`, and a session that supplies none gets a **typed
 * refusal** that names the missing capability rather than an invented answer.
 *
 * **The rule engine governs the call.** The target refuses a `WebSearch` rule that
 * carries a wildcard ("WebSearch does not support wildcards") and matches the
 * rest against the **query**, so a `WebSearch(...)` rule is a rule about the
 * search terms. This implementation reads the query as the tool's primary content
 * field, so a `WebSearch(...)` rule matches the query text.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, query, results,
 *     durationSeconds, searchCount }` — is an implementation choice: the audit
 *     pins the tool-result *metadata*, not the content a tool returns.
 */

import { TOOL_ERROR_CODES, ToolExecutionError, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  checkToolPermissions,
  recheckToolPermissions,
  rejectUnknownFields,
  requireStringField,
  type BuiltinToolDeps,
} from './shared.js';
import type { WebSearchHit } from './capabilities.js';

/** The input of the `WebSearch` tool. */
export interface WebSearchInput {
  /** The search query. */
  query: string;
  /** Only results from these domains. */
  allowed_domains?: string[];
  /** No results from these domains. */
  blocked_domains?: string[];
}

/** The output of the `WebSearch` tool. */
export interface WebSearchOutput {
  type: 'text';
  /** A short report of what was found. */
  text: string;
  /** The query that was executed. */
  query: string;
  /** The hits the search returned. */
  results: WebSearchHit[];
  /** How long the search took, in seconds. */
  durationSeconds: number;
  /** The number of searches that were performed. */
  searchCount: number;
}

/** The input schema of the `WebSearch` tool. */
export const WEBSEARCH_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      minLength: 2,
      description: 'The search query to use.',
    },
    allowed_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'Only include search results from these domains.',
    },
    blocked_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'Never include search results from these domains.',
    },
  },
  required: ['query'],
  additionalProperties: false,
} as const;

/**
 * Create the `WebSearch` tool.
 */
export function createWebSearchTool(
  deps: BuiltinToolDeps,
): ToolDefinition<WebSearchInput, WebSearchOutput> {
  return {
    name: 'WebSearch',
    description: 'Search the web for current information.',
    inputSchema: WEBSEARCH_INPUT_SCHEMA,
    mutatesFiles: false,

    // A search is **concurrency safe**: the target's `WebSearch` tool declares the
    // flag, so the call may run beside the other concurrency-safe calls of the
    // same assistant message.
    isConcurrencySafe(): boolean {
      return true;
    },

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
      const fields = rejectUnknownFields(input, ['query', 'allowed_domains', 'blocked_domains']);
      if (!fields.ok) return fields;
      const query = requireStringField(input, 'query', {
        invalidCode: TOOL_ERROR_CODES.invalidInput,
      });
      if (!query.ok) return query;
      if (query.value.length < 2) {
        return {
          ok: false,
          message: "The 'query' argument must be at least two characters long.",
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      const allowed = readDomainList(input, 'allowed_domains');
      if (!allowed.ok) return allowed;
      const blocked = readDomainList(input, 'blocked_domains');
      if (!blocked.ok) return blocked;
      if (allowed.value !== undefined && blocked.value !== undefined) {
        // The target refuses a call that names both lists: the two say opposite
        // things about the same result.
        return {
          ok: false,
          message:
            "The 'allowed_domains' and 'blocked_domains' arguments cannot both be given in the same call.",
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      return { ok: true };
    },

    async execute(input) {
      const backend = deps.capabilities?.webSearch;
      if (backend === undefined) {
        throw new ToolExecutionError(
          "The 'WebSearch' tool needs a web-search backend, which this session does not have, so the call was refused.",
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }
      const started = Date.now();
      const hits = await backend(input.query, {
        ...(input.allowed_domains === undefined ? {} : { allowedDomains: input.allowed_domains }),
        ...(input.blocked_domains === undefined ? {} : { blockedDomains: input.blocked_domains }),
      });
      const durationSeconds = (Date.now() - started) / 1000;
      return {
        type: 'text' as const,
        text: `Found ${hits.length} result${hits.length === 1 ? '' : 's'} for '${input.query}'.`,
        query: input.query,
        results: hits,
        durationSeconds,
        searchCount: 1,
      };
    },
  };
}

/**
 * Read one of the two domain lists.
 *
 * The value is caller-supplied data, so the lookup is an **own-property** check.
 */
function readDomainList(
  input: unknown,
  field: string,
): { ok: true; value?: string[] } | { ok: false; message: string; errorCode: number } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: true };
  const record = input as Record<string, unknown>;
  if (!Object.hasOwn(record, field)) return { ok: true };
  const value = record[field];
  if (value === undefined || value === null) return { ok: true };
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return {
      ok: false,
      message: `The '${field}' argument must be an array of strings.`,
      errorCode: TOOL_ERROR_CODES.invalidInput,
    };
  }
  return { ok: true, value: value as string[] };
}

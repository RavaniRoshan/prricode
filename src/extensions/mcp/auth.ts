/**
 * The auth failures.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("MCP, plugins, and
 * hooks" — "MCP transport"), and the `CC-011` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * This module owns **one** responsibility: classifying the failure an MCP
 * request ran into, and inspecting an HTTP error body for a specific code.
 */

import { readRecord } from './records.js';

/** The classes of an auth failure. */
export type McpAuthFailureKind =
  | 'missing_credential'
  | 'expired_token'
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_token'
  | 'network'
  | 'unknown';

/** The HTTP failure of an MCP request. */
export interface McpHttpFailure {
  status?: number;
  body?: string;
  message?: string;
}

const NETWORK_PATTERN = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|fetch failed/i;

/**
 * Classify an auth failure.
 *
 * A `401` whose body names an expired token is an `expired_token`; a `401` is
 * an `unauthorized`; a `403` is a `forbidden`; a connection failure is a
 * `network` failure. Everything else is `unknown`.
 */
export function classifyMcpAuthFailure(error: unknown): McpAuthFailureKind {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const status = typeof record['status'] === 'number' ? record['status'] : undefined;
    const body = typeof record['body'] === 'string' ? record['body'] : undefined;
    const message = typeof record['message'] === 'string' ? record['message'] : undefined;

    if (status === 401) {
      if (
        (body !== undefined && hasEraCodeInHttpErrorBody(body, 'authentication_error')) ||
        (message !== undefined && /expired/i.test(message))
      ) {
        return 'expired_token';
      }
      return 'unauthorized';
    }
    if (status === 403) return 'forbidden';
    if (status === 402) return 'invalid_token';
    if (status === undefined && message !== undefined && /no credential|missing credential/i.test(message)) {
      return 'missing_credential';
    }
    if (message !== undefined && NETWORK_PATTERN.test(message)) {
      return 'network';
    }
    return 'unknown';
  }
  if (error instanceof Error) {
    if (NETWORK_PATTERN.test(error.message)) {
      return 'network';
    }
    return 'unknown';
  }
  return 'unknown';
}

/**
 * Whether an HTTP error body carries a specific code.
 *
 * The body may be a string or a parsed object; the code is looked for in the
 * body's own `code` and `type` fields, in the `error` object's own `code` and
 * `type` fields, and — as a last resort — in the body's own text.
 */
export function hasEraCodeInHttpErrorBody(body: unknown, code: string): boolean {
  if (typeof code !== 'string' || code === '') return false;
  if (typeof body === 'string') return body.includes(code);
  const record = readRecord(body);
  if (!record) return false;
  for (const key of ['code', 'type']) {
    if (Object.hasOwn(record, key) && record[key] === code) return true;
  }
  const nested = readRecord(record['error']);
  if (nested) {
    for (const key of ['code', 'type']) {
      if (Object.hasOwn(nested, key) && nested[key] === code) return true;
    }
  }
  try {
    return JSON.stringify(record).includes(code);
  } catch {
    return false;
  }
}

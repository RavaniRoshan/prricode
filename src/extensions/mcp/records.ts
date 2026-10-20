/**
 * The wire-shape readers.
 *
 * The MCP payloads are `unknown` — they arrive as parsed JSON and this implementation
 * never trusts their shape. This module owns the one responsibility of turning
 * an `unknown` into a record, and the typed readers the rest of the MCP
 * modules build on.
 *
 * The readers are **defensive**: a payload that is not an object yields
 * `undefined`, and a member of the wrong type is simply not read. Nothing here
 * throws, so a malformed server answer can never crash a connect.
 */

/** A value that is a plain object, or `undefined`. */
export function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** A string member of a record, or `undefined`. */
export function readString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** A number member of a record, or `undefined`. */
export function readNumber(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** An array member of a record, or `undefined`. */
export function readArray(
  record: Record<string, unknown> | undefined,
  key: string,
): unknown[] | undefined {
  const value = record?.[key];
  return Array.isArray(value) ? value : undefined;
}

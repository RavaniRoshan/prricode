/**
 * The protocol version.
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §2.
 *
 * **One responsibility:** the version this build speaks, the versions it accepts,
 * and the test for either. The version is a **major** version string — `"1"` — and
 * it is carried by every frame in the `v` member.
 *
 * ## The rule the specification states
 *
 * > Every frame carries `v`, the protocol version, as a major version string. A
 * > peer that receives a major version it does not implement answers with
 * > `protocol/unsupported` and the versions it does.
 *
 * So there are exactly two version facts: the version is a **major** string, and a
 * peer that does not implement the major it is given **answers** — it does not
 * ignore the frame and it does not guess.
 *
 * ## What is an implementation choice
 *
 *   - The **value** `"1"`. The specification names the shape and not the number,
 *     and a number that is ours is ours to choose.
 *   - The **list** of accepted majors is a single-entry list today. It is a
 *     *list* rather than one constant so that a second major can be added
 *     without changing the shape of anything that reads it — and the refusal
 *     carries the whole list, so a peer that is refused learns every version the
 *     other side does speak, exactly as the specification promises.
 *   - A frame whose `v` is **missing**, or is not a string, is a **malformed
 *     frame** rather than an unsupported version: there is no version to be
 *     unsupported. A frame whose `v` is a string the build does not implement is
 *     `protocol/unsupported`. The distinction is recorded in
 *     `docs/compatibility/protocol-surface.md`.
 */

/** The protocol version this build speaks. */
export const PROTOCOL_VERSION = '1';

/**
 * Every major version this build implements.
 *
 * The refusal to an unknown version carries this list, so a peer learns what the
 * other side does speak.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = Object.freeze([PROTOCOL_VERSION]);

/**
 * Whether the given value is a major version this build implements.
 *
 * The value must be a string and it must be one of the supported majors. A
 * number, a missing member and a `null` are all "not a version this build
 * implements" — but a caller that wants to tell *those* apart from an
 * unsupported major reads the member itself.
 */
export function isSupportedProtocolVersion(value: unknown): value is string {
  return typeof value === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(value);
}

/**
 * The protocol version a frame carries, or `undefined` when it carries none.
 *
 * A frame whose `v` is present but is not a string is **not** a version: the
 * member is unusable, and the frame is malformed rather than unsupported.
 */
export function readProtocolVersion(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const version = (value as Record<string, unknown>)['v'];
  return typeof version === 'string' ? version : undefined;
}

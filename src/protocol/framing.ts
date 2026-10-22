/**
 * The transport's framing.
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §2.
 *
 * **One responsibility:** turning a frame into a line and a line into a frame,
 * and the size limit that a line may not cross.
 *
 * ## What the specification states
 *
 * > **Newline-delimited JSON over stdio.** One JSON object per line, UTF-8,
 * > `\n`-terminated. […] The **message size limit is 8 MiB**; a larger frame is
 * > refused with the `frame/too-large` error rather than truncated.
 *
 * The limit is counted in **bytes of UTF-8**, not in characters: the limit is
 * about how much a reader has to hold, and a character is not a byte. The
 * trailing newline is the frame's terminator, not part of it, so the count is
 * over the JSON text alone.
 *
 * ## The two halves
 *
 *   - `encodeFrame` **refuses** to write a frame that is over the limit. The
 *     refusal is an error carrying `frame/too-large`, so a caller learns
 *     before anything reaches the wire.
 *   - `decodeFrame` **reads** one line. It refuses a line that is not JSON, and
 *     a line that is over the limit, with the same reasons.
 *
 * The reader that consumes a stream refuses an over-long line **before** it is
 * complete, so a peer cannot make this process hold an unbounded buffer; that
 * is the connection's job (`src/protocol/connection.ts`).
 */

import { PROTOCOL_ERROR_CODES, protocolError } from './errors.js';
import type { ProtocolFrame } from './frames.js';

/** The message size limit: 8 MiB. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** The byte length of a string, counted as UTF-8. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The wire form of a frame: one JSON object, one line, `\n`-terminated.
 *
 * A frame over the size limit is refused rather than truncated, and the
 * refusal is thrown as a `ProtocolError` so that the caller sees the reason
 * instead of a shortened frame on the wire.
 */
export function encodeFrame(frame: ProtocolFrame): string {
  const json = JSON.stringify(frame);
  const bytes = utf8ByteLength(json);
  if (bytes > MAX_FRAME_BYTES) {
    throw protocolError(
      PROTOCOL_ERROR_CODES.frameTooLarge,
      `the frame is ${bytes} bytes, over the ${MAX_FRAME_BYTES}-byte limit`,
      { bytes, limit: MAX_FRAME_BYTES },
    );
  }
  return `${json}\n`;
}

/** The outcome of reading one line. */
export type LineRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: Error & { code: string } };

/**
 * Read one line of the transport.
 *
 * The line is the frame's JSON text, without its terminator. A line that is
 * not JSON is refused with `frame/malformed`; a line over the limit is refused
 * with `frame/too-large`.
 */
export function decodeFrame(line: string): LineRead {
  const bytes = utf8ByteLength(line);
  if (bytes > MAX_FRAME_BYTES) {
    return {
      ok: false,
      error: protocolError(
        PROTOCOL_ERROR_CODES.frameTooLarge,
        `the frame is ${bytes} bytes, over the ${MAX_FRAME_BYTES}-byte limit`,
        { bytes, limit: MAX_FRAME_BYTES },
      ),
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: protocolError(
        PROTOCOL_ERROR_CODES.frameMalformed,
        `the frame is not JSON: ${detail}`,
      ),
    };
  }
  return { ok: true, value };
}

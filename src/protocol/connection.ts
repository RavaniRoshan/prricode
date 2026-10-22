/**
 * The connection — the transport under the frames.
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §2.
 *
 * **One responsibility:** carrying frames over a pair of streams. It reads
 * lines from the input, writes lines to the output, and it holds the line
 * that is being read — nothing else. It does not know what a frame means, and
 * it does not know which peer is on the other end.
 *
 * ## The size limit is enforced while the line is read
 *
 * A line is read into a buffer, and the buffer is **bounded**: the moment the
 * bytes read so far pass the limit and no terminator has arrived, the frame is
 * refused with `frame/too-large` and the rest of the line is discarded as it
 * arrives. A peer therefore cannot make this process hold an unbounded buffer
 * by never sending a newline, and the frame is **refused rather than
 * truncated** — the bytes that were read are dropped, not cut short and
 * handed on as a smaller frame.
 *
 * ## The refusals
 *
 * A line that is not JSON is refused with `frame/malformed`; a line over the
 * limit is refused with `frame/too-large`. Both are reported through
 * `onRefusal`, and neither is a crash: the connection keeps reading the next
 * line.
 *
 * The connection **does not encode**: the peer above it encodes, so that a
 * frame which is over the limit is refused to the caller that tried to send
 * it rather than silently dropped on the way out.
 */

import type { Readable, Writable } from 'node:stream';

import { PROTOCOL_ERROR_CODES, protocolError, type ProtocolError } from './errors.js';
import { MAX_FRAME_BYTES, utf8ByteLength } from './framing.js';

/** The options a connection is created with. */
export interface ProtocolConnectionOptions {
  /** The stream the peer's frames arrive on. */
  input: Readable;
  /** The stream this peer's frames are written to. */
  output: Writable;
  /** The message size limit. It is 8 MiB unless the caller says otherwise. */
  maxFrameBytes?: number;
}

/** A connection over a pair of streams. */
export interface ProtocolConnection {
  /** Called with every parsed JSON value that arrives. */
  onValue: (value: unknown) => void;
  /** Called with every frame that could not be read at all. */
  onRefusal: (error: ProtocolError) => void;
  /** Write one encoded line. */
  writeLine(line: string): void;
  /** Stop reading and release the streams. */
  close(): void;
}

/**
 * Create a connection.
 *
 * The connection is a thin layer: it frames and unframes, and it reports the
 * frames it cannot read. Everything else — what a frame means, who may send
 * it — belongs to the peer above it.
 */
export function createProtocolConnection(options: ProtocolConnectionOptions): ProtocolConnection {
  const limit = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  let buffer = '';
  let discarding = false;
  let closed = false;

  const refuseTooLarge = (): void => {
    connection.onRefusal(
      protocolError(
        PROTOCOL_ERROR_CODES.frameTooLarge,
        `the frame is over the ${limit}-byte limit`,
        { limit },
      ),
    );
  };

  const handleLine = (line: string): void => {
    if (line.length === 0) return;
    if (utf8ByteLength(line) > limit) {
      refuseTooLarge();
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      connection.onRefusal(
        protocolError(
          PROTOCOL_ERROR_CODES.frameMalformed,
          `the frame is not JSON: ${detail}`,
        ),
      );
      return;
    }
    connection.onValue(value);
  };

  const drain = (): void => {
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      handleLine(line);
      newline = buffer.indexOf('\n');
    }
  };

  const onData = (chunk: Buffer | string): void => {
    if (closed) return;
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (discarding) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) {
        // The rest of the over-long frame is dropped as it arrives.
        buffer = '';
        return;
      }
      buffer = buffer.slice(newline + 1);
      discarding = false;
    }
    drain();
    if (!discarding && utf8ByteLength(buffer) > limit) {
      refuseTooLarge();
      discarding = true;
      buffer = '';
    }
  };

  const onEnd = (): void => {
    if (closed) return;
    // A last line without a terminator is still a frame.
    if (!discarding && buffer.length > 0) {
      const line = buffer;
      buffer = '';
      handleLine(line);
    }
    buffer = '';
  };

  options.input.on('data', onData);
  options.input.on('end', onEnd);
  options.input.on('error', () => {
    /* the peer went away; the pending requests are settled by the peer */
  });

  const connection: ProtocolConnection = {
    onValue: () => undefined,
    onRefusal: () => undefined,
    writeLine(line: string): void {
      if (closed) {
        throw protocolError(
          PROTOCOL_ERROR_CODES.frameMalformed,
          'the connection is closed',
        );
      }
      options.output.write(line);
    },
    close(): void {
      if (closed) return;
      closed = true;
      options.input.removeListener('data', onData);
      options.input.removeListener('end', onEnd);
      if (!options.output.destroyed) options.output.end();
    },
  };

  return connection;
}

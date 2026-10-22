/**
 * The frame.
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §2 and §3.
 *
 * **One responsibility:** the three frame kinds, how a frame is told apart from
 * another, and what makes a frame unusable.
 *
 * ## What the specification states
 *
 * Three message kinds, distinguished by their members:
 *
 * | kind | the members that mark it |
 * |---|---|
 * | a **request** | `id` and `method` |
 * | a **response** | `id` and either `result` or `error` |
 * | a **notification** | `method` and no `id` |
 *
 * > A response must carry either `result` or `error`, never both and never
 * > neither. A frame that does not is refused as `frame/malformed`.
 *
 * ## The order the rules are applied in
 *
 * 1. The frame is an object. Anything else — an array, a string, `null` — is
 *    `frame/malformed`.
 * 2. The frame carries a `v` that is a string. A missing one, or one that is
 *    not a string, is `frame/malformed`: there is no version to be
 *    unsupported.
 * 3. The frame carries an `id` and a `method` → a **request**.
 * 4. The frame carries a `method` and no `id` → a **notification**.
 * 5. Otherwise the frame carries an `id` → a **response**, and it must carry
 *    exactly one of `result` and `error`.
 *
 * A frame that carries a `method` **and** an answer is refused: a request may
 * not answer itself, and a frame that means two things is not understood. The
 * specification's "never both and never neither" is about the response, and
 * this is the same rule applied to the request.
 *
 * ## What is an implementation choice
 *
 *   - The **rejection** of a request that carries an answer. The specification
 *     does not name the case; refusing it is the reading that keeps "a frame is
 *     either understood or refused" true.
 *   - The **id's** accepted types: a string or a number, which is what the
 *     specification says.
 */

import { PROTOCOL_ERROR_CODES, protocolError, type ProtocolErrorPayload } from './errors.js';
import { readProtocolVersion } from './version.js';

/** A request's id: a string or a number, never reused within a session. */
export type RequestId = string | number;

/** A frame that asks for something. */
export interface RequestFrame {
  /** The protocol version. */
  readonly v: string;
  /** The id the answer must carry. */
  readonly id: RequestId;
  /** The method, as `area/verb`. */
  readonly method: string;
  /** The parameters. */
  readonly params?: unknown;
}

/** A frame that answers a request. */
export interface ResponseFrame {
  /** The protocol version. */
  readonly v: string;
  /** The id of the request this answers. */
  readonly id: RequestId;
  /** The result. Exactly one of `result` and `error` is present. */
  readonly result?: unknown;
  /** The error. Exactly one of `result` and `error` is present. */
  readonly error?: ProtocolErrorPayload;
}

/** A frame that says something and is never answered. */
export interface NotificationFrame {
  /** The protocol version. */
  readonly v: string;
  /** The method, as `area/verb`. */
  readonly method: string;
  /** The parameters. */
  readonly params?: unknown;
}

/** Any frame on the wire. */
export type ProtocolFrame = RequestFrame | ResponseFrame | NotificationFrame;

/** The three kinds of frame. */
export type FrameKind = 'request' | 'response' | 'notification';

/** A frame that has been understood, and its kind. */
export type ParsedFrame =
  | { readonly kind: 'request'; readonly frame: RequestFrame }
  | { readonly kind: 'response'; readonly frame: ResponseFrame }
  | { readonly kind: 'notification'; readonly frame: NotificationFrame };

/** The outcome of reading a frame. */
export type FrameRead =
  | { readonly ok: true; readonly parsed: ParsedFrame }
  | { readonly ok: false; readonly error: Error & { code: string } };

/**
 * Whether the value is an id a request may carry.
 *
 * A string or a number, and nothing else: an object, an array, a boolean and
 * `null` are not ids.
 */
export function isRequestId(value: unknown): value is RequestId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * The id a frame carries, when it carries a usable one.
 *
 * This is what lets a refusal be **answered** rather than merely reported: a
 * frame that is malformed but still carries an id is answered with that id, so
 * the peer learns which request was refused.
 */
export function readFrameId(value: unknown): RequestId | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const id = (value as Record<string, unknown>)['id'];
  return isRequestId(id) ? id : undefined;
}

/**
 * Read a frame.
 *
 * The value is a parsed JSON value; the rules above decide what it is. A frame
 * that breaks them is refused with the reason, and the refusal is an error
 * carrying the code — never a shrug and never a throw that is not a refusal.
 */
export function readFrame(value: unknown): FrameRead {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: protocolError(
        PROTOCOL_ERROR_CODES.frameMalformed,
        'the frame is not a JSON object',
      ),
    };
  }

  if (readProtocolVersion(value) === undefined) {
    return {
      ok: false,
      error: protocolError(
        PROTOCOL_ERROR_CODES.frameMalformed,
        'the frame carries no protocol version',
      ),
    };
  }

  const record = value as Record<string, unknown>;
  const version = record['v'] as string;
  const method = record['method'];
  const id = record['id'];
  const hasResult = Object.hasOwn(record, 'result');
  const hasError = Object.hasOwn(record, 'error');

  if (typeof method === 'string') {
    if (!Object.hasOwn(record, 'id')) {
      const notification: NotificationFrame = {
        v: version,
        method,
        ...(Object.hasOwn(record, 'params') ? { params: record['params'] } : {}),
      };
      return { ok: true, parsed: { kind: 'notification', frame: notification } };
    }
    if (!isRequestId(id)) {
      return {
        ok: false,
        error: protocolError(
          PROTOCOL_ERROR_CODES.frameMalformed,
          'the request carries an id that is neither a string nor a number',
        ),
      };
    }
    if (hasResult || hasError) {
      return {
        ok: false,
        error: protocolError(
          PROTOCOL_ERROR_CODES.frameMalformed,
          'the request carries an answer, and a request may not answer itself',
        ),
      };
    }
    const request: RequestFrame = {
      v: version,
      id,
      method,
      ...(Object.hasOwn(record, 'params') ? { params: record['params'] } : {}),
    };
    return { ok: true, parsed: { kind: 'request', frame: request } };
  }

  if (Object.hasOwn(record, 'id')) {
    if (!isRequestId(id)) {
      return {
        ok: false,
        error: protocolError(
          PROTOCOL_ERROR_CODES.frameMalformed,
          'the response carries an id that is neither a string nor a number',
        ),
      };
    }
    if (hasResult && hasError) {
      return {
        ok: false,
        error: protocolError(
          PROTOCOL_ERROR_CODES.frameMalformed,
          'the response carries both a result and an error',
        ),
      };
    }
    if (!hasResult && !hasError) {
      return {
        ok: false,
        error: protocolError(
          PROTOCOL_ERROR_CODES.frameMalformed,
          'the response carries neither a result nor an error',
        ),
      };
    }
    const response: ResponseFrame = {
      v: version,
      id,
      ...(hasResult ? { result: record['result'] } : {}),
      ...(hasError ? { error: record['error'] as ProtocolErrorPayload } : {}),
    };
    return { ok: true, parsed: { kind: 'response', frame: response } };
  }

  return {
    ok: false,
    error: protocolError(
      PROTOCOL_ERROR_CODES.frameMalformed,
      'the frame is neither a request, a response nor a notification',
    ),
  };
}

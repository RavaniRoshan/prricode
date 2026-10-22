/**
 * The error shape.
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §3.
 *
 * **One responsibility:** the error's three members, the stable codes, and the
 * exception the protocol raises internally.
 *
 * ## What the specification states
 *
 * > The error's `code` is stable and machine-readable — a kebab-case path whose
 * > first segment is the area. The `message` is for a person and is never parsed.
 * > The `data` is whatever the area needs, and is optional.
 *
 * So a code is `area/rest`, the `area` is the first segment, and the `data` is
 * free-form. The `message` is never parsed by anything, and nothing in this
 * repository parses it.
 *
 * ## The codes
 *
 * The first segment of a code names the area the refusal belongs to. **Six** of
 * the areas are the method areas of the specification's table — `session`,
 * `turn`, `tool`, `model`, `approval` and `capability` — plus the
 * notification area `event`. **Three** are the protocol's own, and the
 * specification itself names two of them in its examples: `frame/*` (a frame
 * that cannot be understood) and `protocol/*` (the version). The third,
 * `method/*`, is the **method vocabulary**: a refusal about which methods exist
 * and how they may be used, rather than about the area a method belongs to.
 *
 * Every code the protocol can produce is listed in `PROTOCOL_ERROR_CODES`, so a
 * caller can enumerate them and a test can assert that nothing invents one.
 */

/** The error's wire shape. */
export interface ProtocolErrorPayload {
  /** The stable, machine-readable code — a kebab-case path whose first segment is the area. */
  readonly code: string;
  /** The human-readable message. It is never parsed. */
  readonly message: string;
  /** Whatever the area needs. It is optional. */
  readonly data?: unknown;
}

/**
 * Every code the protocol can produce.
 *
 * The names are the codes' own subjects, so a call site reads as the refusal it
 * makes.
 */
export const PROTOCOL_ERROR_CODES = {
  /** A frame that is not JSON, is not an object, or breaks the frame's own rules. */
  frameMalformed: 'frame/malformed',
  /** A frame over the size limit. The frame is refused, never truncated. */
  frameTooLarge: 'frame/too-large',
  /** A response whose id matches no request this peer has in flight. */
  frameUnknownId: 'frame/unknown-id',
  /** A major protocol version this peer does not implement. */
  protocolUnsupported: 'protocol/unsupported',
  /** A method that is not in the vocabulary. */
  methodUnknown: 'method/unknown',
  /** A notification-only method that was called as a request. */
  methodNotificationOnly: 'method/notification-only',
  /** A method whose parameters do not fit it. */
  methodInvalidParams: 'method/invalid-params',
  /** A method whose handler failed. */
  methodFailed: 'method/failed',
  /** A method of the vocabulary that this build does not implement. */
  methodUnavailable: 'method/unavailable',
  /** A call against a session that has been disposed. */
  sessionDisposed: 'session/disposed',
  /** A call against a session this peer does not have. */
  sessionUnknown: 'session/unknown',
  /** A call against a turn this peer does not have. */
  turnUnknown: 'turn/unknown',
  /** A turn that failed. */
  turnFailed: 'turn/failed',
  /** The model a turn selected is not available. */
  modelUnavailable: 'model/unavailable',
  /** A tool this peer does not have. */
  toolUnknown: 'tool/unknown',
  /** A capability this peer does not have. */
  capabilityUnknown: 'capability/unknown',
  /** An approval that was denied. */
  approvalDenied: 'approval/denied',
  /** An answer that quoted a request id nobody is waiting on. */
  approvalUnknown: 'approval/unknown',
  /** An answer for a request that has already been decided. */
  approvalDecided: 'approval/decided',
} as const;

/** One of the protocol's own codes. */
export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[keyof typeof PROTOCOL_ERROR_CODES];

/**
 * The exception the protocol raises internally.
 *
 * It carries the wire payload, so a handler that refuses raises this and the
 * peer answers with exactly the code and message the refusal named.
 */
export class ProtocolError extends Error {
  /** The stable, machine-readable code. */
  readonly code: string;
  /** Whatever the area needs. */
  readonly data: unknown;

  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.data = data;
  }

  /** The wire payload of this refusal. */
  toPayload(): ProtocolErrorPayload {
    const payload: { code: string; message: string; data?: unknown } = {
      code: this.code,
      message: this.message,
    };
    if (this.data !== undefined) payload.data = this.data;
    return payload;
  }
}

/**
 * Build a refusal.
 *
 * The helper exists so that a call site names the code and the reason and
 * nothing else — a refusal cannot be built with a missing message.
 */
export function protocolError(code: string, message: string, data?: unknown): ProtocolError {
  return new ProtocolError(code, message, data);
}

/**
 * The wire payload of any thrown value.
 *
 * A `ProtocolError` keeps its own code; anything else becomes `method/failed`,
 * because a handler that threw an ordinary exception has failed, and the reason
 * is still carried so that nothing is swallowed.
 */
export function toErrorPayload(error: unknown): ProtocolErrorPayload {
  if (error instanceof ProtocolError) return error.toPayload();
  const message = error instanceof Error ? error.message : String(error);
  return { code: PROTOCOL_ERROR_CODES.methodFailed, message };
}

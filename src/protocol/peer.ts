/**
 * The peer — the half of the protocol both sides share.
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §2, §3 and §4.
 *
 * **One responsibility:** the exchange. A peer sends requests and answers
 * them, sends notifications and receives them, and it refuses every frame it
 * cannot understand with a reason.
 *
 * ## The two roles are the same role
 *
 * The specification says the two sides are peers and neither is privileged:
 * > One vocabulary, both roles. The two sides are peers, and neither is
 * > privileged.
 *
 * So the peer is written once, and the **server** and the **client** are the
 * same exchange with different methods registered on it. A peer may have a
 * request in flight and answer a request at the same time; the two are
 * correlated by the id, and the ids of the two directions are allocated from
 * **separate counters**, so a request this peer sends and a request this peer
 * receives can never share an id on the same channel.
 *
 * ## The refusals
 *
 * A frame that cannot be understood is refused, and the refusal is always
 * reported:
 *
 *   - a frame that **carries an id** is answered with an error response
 *     carrying that id, so the peer learns which request was refused;
 *   - a frame that **carries no id** — a line that is not JSON, a frame over
 *     the size limit, a frame with no usable version — is reported as an
 *     `event/diagnostic` notification, because the specification's vocabulary
 *     has no other way to say something that is not an answer. The reading is
 *     recorded in `docs/compatibility/protocol-surface.md`.
 *
 * In both cases the refusal is also reported on the peer's own **diagnostic
 * channel**, so the process that owns the peer sees it too.
 *
 * A diagnostic is **never answered with a diagnostic**: a peer that received
 * one does not send one back, so two peers cannot make each other talk in
 * circles.
 */

import type { Readable, Writable } from 'node:stream';

import { createProtocolConnection, type ProtocolConnection } from './connection.js';
import {
  PROTOCOL_ERROR_CODES,
  protocolError,
  toErrorPayload,
  type ProtocolError,
} from './errors.js';
import { encodeFrame } from './framing.js';
import {
  readFrame,
  readFrameId,
  type ProtocolFrame,
  type RequestId,
} from './frames.js';
import { isKnownMethod, isNotificationOnly } from './methods.js';
import {
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  isSupportedProtocolVersion,
} from './version.js';

/** Something the peer refused or could not place. */
export interface PeerDiagnostic {
  /** The stable code. */
  readonly code: string;
  /** The human-readable reason. */
  readonly message: string;
  /** Whatever the area needs. */
  readonly data?: unknown;
}

/** The context a request handler is called with. */
export interface PeerRequestContext {
  /** The method being served. */
  readonly method: string;
  /** The identity of the peer that asked. */
  readonly peerIdentity: string;
}

/** A handler for one method. */
export type PeerHandler = (
  params: unknown,
  context: PeerRequestContext,
) => unknown | Promise<unknown>;

/** A handler for one notification. */
export type PeerNotificationHandler = (params: unknown) => void;

/** The options a peer is created with. */
export interface ProtocolPeerOptions {
  /** The stream the peer's frames arrive on. */
  input: Readable;
  /** The stream this peer's frames are written to. */
  output: Writable;
  /** This peer's own name. */
  identity?: string;
  /** The name of the peer on the other end, until it names itself. */
  peerIdentity?: string;
  /** The methods this peer serves. */
  handlers?: Record<string, PeerHandler>;
  /**
   * Called when a **known** method has no handler.
   *
   * It answers the method when it returns a value, and the method is refused
   * with `method/unavailable` when it does not. The server uses it to answer
   * a method whose area's capability is not enabled with the capability's
   * record — the degradation contract — and it is why a method of an area
   * that is off is never answered with "not implemented" when the honest
   * answer is "this cannot run, and here is why".
   */
  onUnhandled?: (method: string) => unknown | Promise<unknown>;
  /** Called with every refusal and every diagnostic. */
  onDiagnostic?: (diagnostic: PeerDiagnostic) => void;
  /** The message size limit. */
  maxFrameBytes?: number;
  /** How long a request waits for its answer, in milliseconds. */
  requestTimeoutMs?: number;
}

/** A pending request. */
interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout | undefined;
}

/** The exchange, and everything a peer can do with it. */
export interface ProtocolPeer {
  /** This peer's own name. */
  readonly identity: string;
  /** The name of the peer on the other end. */
  readonly peerIdentity: string;
  /** Every id this peer has sent, in the order it sent them. */
  readonly sentRequestIds: readonly RequestId[];
  /** Send a request and wait for its answer. */
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Send a notification. It is never answered. */
  notify(method: string, params?: unknown): void;
  /** Serve a method. */
  onRequest(method: string, handler: PeerHandler): void;
  /** Receive a notification. */
  onNotification(method: string, handler: PeerNotificationHandler): void;
  /** Receive a diagnostic. */
  onDiagnostic(handler: (diagnostic: PeerDiagnostic) => void): void;
  /** Set the name of the peer on the other end. */
  setPeerIdentity(identity: string): void;
  /** Settle every request in flight with a refusal, and stop reading. */
  close(): void;
}

/**
 * Create a peer.
 *
 * The peer is the shared half of the protocol: it is what a server and a
 * client are both made of.
 */
export function createProtocolPeer(options: ProtocolPeerOptions): ProtocolPeer {
  const handlers = new Map<string, PeerHandler>();
  const notificationHandlers = new Map<string, PeerNotificationHandler>();
  const diagnosticHandlers: Array<(diagnostic: PeerDiagnostic) => void> = [];
  const pending = new Map<RequestId, PendingRequest>();
  const sentIds: RequestId[] = [];

  let identity = options.identity ?? 'prricode';
  let peerIdentity = options.peerIdentity ?? 'peer';
  let nextRequestId = 1;
  let closed = false;

  if (options.onDiagnostic) diagnosticHandlers.push(options.onDiagnostic);

  const report = (diagnostic: PeerDiagnostic): void => {
    for (const handler of diagnosticHandlers) {
      try {
        handler(diagnostic);
      } catch {
        /* a diagnostic handler that throws must not take the peer down */
      }
    }
  };

  const connection: ProtocolConnection = createProtocolConnection({
    input: options.input,
    output: options.output,
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
  });

  const sendFrame = (frame: ProtocolFrame): void => {
    if (closed) return;
    let line: string;
    try {
      line = encodeFrame(frame);
    } catch (error) {
      report({
        code:
          error instanceof Error && 'code' in error
            ? String((error as { code: unknown }).code)
            : PROTOCOL_ERROR_CODES.frameMalformed,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    connection.writeLine(line);
  };

  /** Report a refusal on the wire when it cannot be attributed to a request. */
  const reportUnattributed = (error: ProtocolError): void => {
    const payload = error.toPayload();
    sendFrame({
      v: PROTOCOL_VERSION,
      method: 'event/diagnostic',
      params: {
        code: payload.code,
        message: payload.message,
        ...(payload.data === undefined ? {} : { data: payload.data }),
      },
    });
  };

  /** Answer a refusal with the id the refused frame carried, when it had one. */
  const refuse = (value: unknown, error: ProtocolError): void => {
    report({ code: error.code, message: error.message, data: error.data });
    const id = readFrameId(value);
    if (id === undefined) {
      reportUnattributed(error);
      return;
    }
    sendFrame({ v: PROTOCOL_VERSION, id, error: error.toPayload() });
  };

  const settle = (id: RequestId, error: Error): void => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (request.timer) clearTimeout(request.timer);
    request.reject(error);
  };

  const handleResponse = (id: RequestId, result: unknown, error: unknown): void => {
    const request = pending.get(id);
    if (!request) {
      report({
        code: PROTOCOL_ERROR_CODES.frameUnknownId,
        message: `the answer carries the id ${JSON.stringify(id)}, which matches no request in flight`,
        data: { id },
      });
      return;
    }
    pending.delete(id);
    if (request.timer) clearTimeout(request.timer);
    if (error !== undefined && error !== null) {
      const payload = error as { code?: unknown; message?: unknown; data?: unknown };
      const code = typeof payload.code === 'string' ? payload.code : PROTOCOL_ERROR_CODES.methodFailed;
      const message =
        typeof payload.message === 'string' ? payload.message : 'the request was refused';
      request.reject(protocolError(code, message, payload.data));
      return;
    }
    request.resolve(result);
  };

  const handleRequest = (id: RequestId, method: string, params: unknown): void => {
    if (isNotificationOnly(method)) {
      sendFrame({
        v: PROTOCOL_VERSION,
        id,
        error: protocolError(
          PROTOCOL_ERROR_CODES.methodNotificationOnly,
          `"${method}" is a notification and is never called`,
          { method },
        ).toPayload(),
      });
      return;
    }
    if (!isKnownMethod(method)) {
      sendFrame({
        v: PROTOCOL_VERSION,
        id,
        error: protocolError(
          PROTOCOL_ERROR_CODES.methodUnknown,
          `"${method}" is not a method of this protocol`,
          { method },
        ).toPayload(),
      });
      return;
    }
    const handler = handlers.get(method);
    if (!handler) {
      if (options.onUnhandled) {
        void (async () => {
          try {
            const answer = await options.onUnhandled?.(method);
            if (answer === undefined) {
              sendFrame({
                v: PROTOCOL_VERSION,
                id,
                error: protocolError(
                  PROTOCOL_ERROR_CODES.methodUnavailable,
                  `"${method}" is not implemented by this build`,
                  { method },
                ).toPayload(),
              });
              return;
            }
            sendFrame({ v: PROTOCOL_VERSION, id, result: answer });
          } catch (error) {
            sendFrame({ v: PROTOCOL_VERSION, id, error: toErrorPayload(error) });
          }
        })();
        return;
      }
      sendFrame({
        v: PROTOCOL_VERSION,
        id,
        error: protocolError(
          PROTOCOL_ERROR_CODES.methodUnavailable,
          `"${method}" is not implemented by this build`,
          { method },
        ).toPayload(),
      });
      return;
    }
    void (async () => {
      try {
        const result = await handler(params, { method, peerIdentity });
        sendFrame({ v: PROTOCOL_VERSION, id, result: result === undefined ? null : result });
      } catch (error) {
        sendFrame({ v: PROTOCOL_VERSION, id, error: toErrorPayload(error) });
      }
    })();
  };

  const handleNotification = (method: string, params: unknown): void => {
    const handler = notificationHandlers.get(method);
    if (!handler) {
      // A diagnostic is never answered with a diagnostic, so a notification
      // nobody serves is reported and nothing more. A method that is not of
      // the vocabulary is unknown; a method that is of it and is not served
      // is unavailable, and the two say different things.
      report({
        code: isKnownMethod(method)
          ? PROTOCOL_ERROR_CODES.methodUnavailable
          : PROTOCOL_ERROR_CODES.methodUnknown,
        message: isKnownMethod(method)
          ? `the notification "${method}" is not served by this peer`
          : `the notification "${method}" is not a method of this protocol`,
        data: { method },
      });
      return;
    }
    try {
      handler(params);
    } catch (error) {
      report({
        code: PROTOCOL_ERROR_CODES.methodFailed,
        message: error instanceof Error ? error.message : String(error),
        data: { method },
      });
    }
  };

  const handleValue = (value: unknown): void => {
    if (closed) return;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      refuse(
        value,
        protocolError(PROTOCOL_ERROR_CODES.frameMalformed, 'the frame is not a JSON object'),
      );
      return;
    }
    const version = (value as Record<string, unknown>)['v'];
    if (typeof version !== 'string') {
      refuse(
        value,
        protocolError(
          PROTOCOL_ERROR_CODES.frameMalformed,
          'the frame carries no protocol version',
        ),
      );
      return;
    }
    if (!isSupportedProtocolVersion(version)) {
      refuse(
        value,
        protocolError(
          PROTOCOL_ERROR_CODES.protocolUnsupported,
          `the protocol version "${version}" is not implemented by this peer`,
          { supported: [...SUPPORTED_PROTOCOL_VERSIONS] },
        ),
      );
      return;
    }
    const read = readFrame(value);
    if (!read.ok) {
      refuse(value, read.error as ProtocolError);
      return;
    }
    const parsed = read.parsed;
    if (parsed.kind === 'request') {
      handleRequest(parsed.frame.id, parsed.frame.method, parsed.frame.params);
      return;
    }
    if (parsed.kind === 'response') {
      handleResponse(parsed.frame.id, parsed.frame.result, parsed.frame.error);
      return;
    }
    handleNotification(parsed.frame.method, parsed.frame.params);
  };

  connection.onValue = handleValue;
  connection.onRefusal = (error) => {
    report({ code: error.code, message: error.message, data: error.data });
    reportUnattributed(error);
  };

  const peer: ProtocolPeer = {
    get identity(): string {
      return identity;
    },
    get peerIdentity(): string {
      return peerIdentity;
    },
    get sentRequestIds(): readonly RequestId[] {
      return sentIds;
    },
    async request<T = unknown>(method: string, params?: unknown): Promise<T> {
      if (isNotificationOnly(method)) {
        throw new Error(`"${method}" is a notification and is never called`);
      }
      if (!isKnownMethod(method)) {
        throw new Error(`"${method}" is not a method of this protocol`);
      }
      const id = nextRequestId;
      nextRequestId += 1;
      const frame: { v: string; id: RequestId; method: string; params?: unknown } = {
        v: PROTOCOL_VERSION,
        id,
        method,
      };
      if (params !== undefined) frame.params = params;
      // The frame is encoded **before** the request is registered, so a frame
      // over the size limit is refused to the caller that tried to send it:
      // nothing is written, and nothing is left waiting for an answer that
      // will never come.
      const line = encodeFrame(frame as ProtocolFrame);
      sentIds.push(id);
      const promise = new Promise<T>((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        if (options.requestTimeoutMs !== undefined) {
          timer = setTimeout(() => {
            settle(
              id,
              protocolError(
                PROTOCOL_ERROR_CODES.methodFailed,
                `the request "${method}" was not answered within ${options.requestTimeoutMs} ms`,
                { method },
              ),
            );
          }, options.requestTimeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
        }
        pending.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
        });
      });
      connection.writeLine(line);
      return promise;
    },
    notify(method: string, params?: unknown): void {
      if (!isNotificationOnly(method)) {
        throw new Error(`"${method}" is a request and is never notified`);
      }
      const frame: { v: string; method: string; params?: unknown } = {
        v: PROTOCOL_VERSION,
        method,
      };
      if (params !== undefined) frame.params = params;
      connection.writeLine(encodeFrame(frame as ProtocolFrame));
    },
    onRequest(method: string, handler: PeerHandler): void {
      handlers.set(method, handler);
    },
    onNotification(method: string, handler: PeerNotificationHandler): void {
      notificationHandlers.set(method, handler);
    },
    onDiagnostic(handler: (diagnostic: PeerDiagnostic) => void): void {
      diagnosticHandlers.push(handler);
    },
    setPeerIdentity(value: string): void {
      peerIdentity = value;
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const [id, request] of pending) {
        pending.delete(id);
        if (request.timer) clearTimeout(request.timer);
        request.reject(
          protocolError(
            PROTOCOL_ERROR_CODES.frameMalformed,
            'the connection was closed before the request was answered',
            { id },
          ),
        );
      }
      connection.close();
    },
  };

  for (const [method, handler] of Object.entries(options.handlers ?? {})) {
    handlers.set(method, handler);
  }

  return peer;
}

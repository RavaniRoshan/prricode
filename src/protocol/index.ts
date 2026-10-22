/**
 * The protocol surface — our own JSON-RPC over stdio.
 *
 * **The specification:** `docs/protocol/PROTOCOL.md`. The specification is the
 * design; this module is its implementation.
 *
 * **One responsibility:** the barrel. Every module of the surface is
 * re-exported here, so that an importer of `protocol/index.js` sees the whole
 * surface and not a part of it.
 *
 * ## The modules
 *
 * | module | what it owns |
 * |---|---|
 * | `version.ts` | the protocol version and the versions this build speaks |
 * | `errors.ts` | the error shape and the protocol's codes |
 * | `frames.ts` | the three frame kinds and what makes a frame unusable |
 * | `framing.ts` | the newline-delimited JSON transport and the size limit |
 * | `methods.ts` | the method vocabulary and the notification-only methods |
 * | `capability.ts` | the capability record and the degradation contract |
 * | `approvals.ts` | the pending approvals, the decision and the attribution |
 * | `session.ts` | the session lifecycle |
 * | `connection.ts` | the transport under the frames |
 * | `peer.ts` | the exchange both sides share |
 * | `server.ts` | the server's half: the sessions, the turns, the methods |
 * | `client.ts` | the client's half: asking, listening, answering |
 */

export {
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  isSupportedProtocolVersion,
  readProtocolVersion,
} from './version.js';

export {
  PROTOCOL_ERROR_CODES,
  ProtocolError,
  protocolError,
  toErrorPayload,
  type ProtocolErrorCode,
  type ProtocolErrorPayload,
} from './errors.js';

export {
  isRequestId,
  readFrame,
  readFrameId,
  type FrameKind,
  type FrameRead,
  type NotificationFrame,
  type ParsedFrame,
  type ProtocolFrame,
  type RequestFrame,
  type RequestId,
  type ResponseFrame,
} from './frames.js';

export {
  MAX_FRAME_BYTES,
  decodeFrame,
  encodeFrame,
  utf8ByteLength,
  type LineRead,
} from './framing.js';

export {
  NOTIFICATION_ONLY_METHODS,
  PROTOCOL_AREAS,
  PROTOCOL_METHODS,
  isKnownMethod,
  isNotificationOnly,
  methodArea,
  type ProtocolArea,
  type ProtocolMethod,
} from './methods.js';

export {
  CapabilityRegistry,
  PLACEHOLDER_REASONS,
  assertCapabilityRecord,
  capabilityRecord,
  createDefaultCapabilityRegistry,
  isDegraded,
  isReportableReason,
  type CapabilityRecord,
} from './capability.js';

export {
  ApprovalRegistry,
  type ApprovalDecision,
  type ApprovalRequest,
  type PendingApproval,
} from './approvals.js';

export {
  SessionStore,
  type ProtocolSession,
  type ProtocolTurn,
  type SessionState,
  type TurnState,
} from './session.js';

export {
  createProtocolConnection,
  type ProtocolConnection,
  type ProtocolConnectionOptions,
} from './connection.js';

export {
  createProtocolPeer,
  type PeerDiagnostic,
  type PeerHandler,
  type PeerNotificationHandler,
  type PeerRequestContext,
  type ProtocolPeer,
  type ProtocolPeerOptions,
} from './peer.js';

export {
  createProtocolServer,
  type ProtocolServer,
  type ProtocolServerOptions,
  type TurnHandler,
  type TurnOutcome,
  type TurnRequest,
} from './server.js';

export {
  createProtocolClient,
  type ApprovalAnswer,
  type ProtocolClient,
  type ProtocolClientOptions,
} from './client.js';

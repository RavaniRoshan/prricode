/**
 * The client — the role PRRICODE plays for the tool providers it does not
 * implement.
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §1, §4 and §7.
 *
 * **One responsibility:** the client half of the exchange. It asks, it
 * listens, and it answers the approvals the peer asks about.
 *
 * ## The two roles, one vocabulary
 *
 * > PRRICODE is the server for the clients that drive it […] PRRICODE is the
 * > client for the tool providers it does not implement […] One vocabulary,
 * > both roles. The two sides are peers, and neither is privileged.
 *
 * So the client is the same peer as the server, with the methods a client
 * serves rather than the ones a server serves. A client may also **answer** a
 * request the peer asks about — the `approval/request` the peer sends when a
 * rule says *ask* — and the answer is attributed to the client.
 *
 * ## The answer
 *
 * `answerApproval` sends the `approval/answer` and returns what the peer
 * said: the decision, and the answerer the peer recorded. An answer for a
 * request id nobody is waiting on is **dropped** by the peer and reported as
 * `approval/unknown` — the client sees that refusal rather than a success
 * that was never applied.
 */

import type { Readable, Writable } from 'node:stream';

import {
  ApprovalRegistry,
  type ApprovalDecision,
  type ApprovalRequest,
} from './approvals.js';
import { PROTOCOL_ERROR_CODES, protocolError } from './errors.js';
import {
  createProtocolPeer,
  type PeerDiagnostic,
  type PeerHandler,
  type ProtocolPeer,
} from './peer.js';

/** The options a client is created with. */
export interface ProtocolClientOptions {
  /** The stream the peer's frames arrive on. */
  input: Readable;
  /** The stream the client's frames are written to. */
  output: Writable;
  /** The client's own name. */
  identity?: string;
  /** The name of the peer, until the peer names itself. */
  peerIdentity?: string;
  /** The methods this client serves. */
  handlers?: Record<string, PeerHandler>;
  /** Called with every refusal and every diagnostic. */
  onDiagnostic?: (diagnostic: PeerDiagnostic) => void;
  /** Called when the peer asks for a decision. */
  onApprovalRequest?: (request: ApprovalRequest) => void;
  /** The message size limit. */
  maxFrameBytes?: number;
  /** How long a request waits for its answer, in milliseconds. */
  requestTimeoutMs?: number;
}

/** What a client says when an approval is answered. */
export interface ApprovalAnswer {
  /** The request id the answer quotes. */
  readonly requestId: string;
  /** The decision. */
  readonly decision: ApprovalDecision;
  /** The peer that recorded the answerer. */
  readonly answerer: string;
}

/** A client. */
export interface ProtocolClient extends ProtocolPeer {
  /** The approvals the peer asked about and nobody has answered. */
  readonly approvals: readonly ApprovalRequest[];
  /** Answer an approval, and report what the peer recorded. */
  answerApproval(requestId: string, decision: ApprovalDecision): Promise<ApprovalAnswer>;
}

/**
 * Create a client.
 *
 * The client serves `approval/request` out of the box: the peer asks for a
 * decision, the client records the request and tells the application about
 * it, and the application answers when it can.
 */
export function createProtocolClient(options: ProtocolClientOptions): ProtocolClient {
  const approvals = new ApprovalRegistry();

  const peer = createProtocolPeer({
    input: options.input,
    output: options.output,
    identity: options.identity ?? 'prricode-client',
    peerIdentity: options.peerIdentity ?? 'peer',
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  });

  peer.onRequest('approval/request', (params) => {
    const record =
      typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
    const requestId = record['requestId'];
    const tool = record['tool'];
    const reason = record['reason'];
    if (
      typeof requestId !== 'string' ||
      requestId.length === 0 ||
      typeof tool !== 'string' ||
      typeof reason !== 'string'
    ) {
      throw protocolError(
        PROTOCOL_ERROR_CODES.methodInvalidParams,
        'the call needs a requestId, a tool and a reason',
      );
    }
    const request: ApprovalRequest = {
      requestId,
      tool,
      call: record['call'],
      reason,
      ...(typeof record['sessionId'] === 'string' ? { sessionId: record['sessionId'] } : {}),
      ...(typeof record['turnId'] === 'string' ? { turnId: record['turnId'] } : {}),
    };
    approvals.open(request);
    options.onApprovalRequest?.(request);
    return { requestId, status: 'pending' };
  });

  for (const [method, handler] of Object.entries(options.handlers ?? {})) {
    peer.onRequest(method, handler);
  }

  const client: ProtocolClient = {
    request: (method, params) => peer.request(method, params),
    notify: (method, params) => peer.notify(method, params),
    onRequest: (method, handler) => peer.onRequest(method, handler),
    onNotification: (method, handler) => peer.onNotification(method, handler),
    onDiagnostic: (handler) => peer.onDiagnostic(handler),
    setPeerIdentity: (identity) => peer.setPeerIdentity(identity),
    close: () => peer.close(),
    get identity(): string {
      return peer.identity;
    },
    get peerIdentity(): string {
      return peer.peerIdentity;
    },
    get sentRequestIds(): readonly (string | number)[] {
      return peer.sentRequestIds;
    },
    get approvals(): readonly ApprovalRequest[] {
      return approvals.pending().map((approval) => ({
        requestId: approval.requestId,
        tool: approval.tool,
        call: approval.call,
        reason: approval.reason,
        ...(approval.sessionId === undefined ? {} : { sessionId: approval.sessionId }),
        ...(approval.turnId === undefined ? {} : { turnId: approval.turnId }),
      }));
    },
    async answerApproval(requestId: string, decision: ApprovalDecision): Promise<ApprovalAnswer> {
      if (decision !== 'allow' && decision !== 'deny') {
        throw new Error('the decision is either "allow" or "deny"');
      }
      const answer = await peer.request<ApprovalAnswer>('approval/answer', {
        requestId,
        decision,
      });
      approvals.decide(requestId, decision, peer.peerIdentity);
      return answer;
    },
  };

  return client;
}

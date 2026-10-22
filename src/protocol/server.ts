/**
 * The server — the role PRRICODE plays for the clients that drive it.
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §4, §5, §6, §7 and §8.
 *
 * **One responsibility:** the session and turn lifecycle, the capability
 * record, and the methods of the vocabulary that belong to the server. The
 * exchange itself is the peer's (`src/protocol/peer.ts`); this module is the
 * server's half of it.
 *
 * ## The methods this module owns
 *
 * | method | what it does |
 * |---|---|
 * | `session/create` | creates a session and returns its id and the capability record |
 * | `session/status` | the session's state |
 * | `session/cancel` | cancels the session's running turn |
 * | `session/dispose` | releases the session |
 * | `turn/start` | starts a turn and returns its id at once |
 * | `turn/abort` | stops the turn |
 * | `approval/request` | records an approval the peer asked for |
 * | `approval/answer` | applies a decision, and says who gave it |
 * | `approval/pending` | the approvals that are waiting for an answer |
 * | `capability/describe` | the record of one capability |
 *
 * The `tool/*` and `model/*` methods are the **embedder's**: the server
 * serves whatever handlers it is given, and refuses the ones it is not given
 * with `method/unavailable`.
 *
 * ## The degradation contract, in the method path
 *
 * A method whose area's capability is **not enabled** answers with that
 * capability's record — `enabled: false` and the reason. It does not answer
 * with a result that pretends the work was done, and it does not answer with
 * an error that hides the fact: the record *is* the answer, and it names what
 * is missing. A method whose capability is enabled but whose handler is
 * missing is a different case, and it is refused with `method/unavailable`.
 *
 * The gate is the **area's capability**, and the embedder owns it: a server
 * with a `tool/call` handler but a `tool` capability that is off answers with
 * the record, because the record is what says whether the tool area can run.
 * The one capability the server owns is `turn`, and it follows the turn
 * runner: a server with a turn runner enables it, a server without one
 * reports the reason.
 */

import type { Readable, Writable } from 'node:stream';

import {
  ApprovalRegistry,
  type ApprovalDecision,
  type ApprovalRequest,
} from './approvals.js';
import {
  CapabilityRegistry,
  capabilityRecord,
  createDefaultCapabilityRegistry,
  type CapabilityRecord,
} from './capability.js';
import {
  PROTOCOL_ERROR_CODES,
  protocolError,
  toErrorPayload,
  type ProtocolError,
} from './errors.js';
import {
  createProtocolPeer,
  type PeerDiagnostic,
  type PeerHandler,
  type ProtocolPeer,
} from './peer.js';
import { SessionStore, type ProtocolSession, type TurnState } from './session.js';

/* -------------------------------------------------------------------------- */
/* The turns                                                                   */
/* -------------------------------------------------------------------------- */

/** What a turn handler is given. */
export interface TurnRequest {
  /** The session the turn belongs to. */
  readonly sessionId: string;
  /** The turn's id. */
  readonly turnId: string;
  /** The prompt the turn was started with. */
  readonly prompt: string;
  /** The model the turn selected, when it selected one. */
  readonly model: string | undefined;
  /** The signal that fires when the turn is aborted. */
  readonly signal: AbortSignal;
  /** Emit one of the turn's events. */
  emit(
    method: 'event/message' | 'event/tool' | 'event/stage',
    params: Record<string, unknown>,
  ): void;
}

/** How a turn ended. */
export interface TurnOutcome {
  /** The state the turn ended in. */
  readonly state: 'completed' | 'failed' | 'aborted';
  /** The turn's last text, when it has one. */
  readonly text?: string;
  /** The code of the failure, when the turn failed. */
  readonly code?: string;
  /** The reason of the failure, when the turn failed. */
  readonly message?: string;
}

/** The handler that runs a turn. */
export type TurnHandler = (turn: TurnRequest) => Promise<TurnOutcome>;

/* -------------------------------------------------------------------------- */
/* The server                                                                 */
/* -------------------------------------------------------------------------- */

/** The options a server is created with. */
export interface ProtocolServerOptions {
  /** The stream the client's frames arrive on. */
  input: Readable;
  /** The stream the server's frames are written to. */
  output: Writable;
  /** The server's own name. */
  identity?: string;
  /** The name of the client, until it names itself in `session/create`. */
  peerIdentity?: string;
  /** The capabilities this server knows about. */
  capabilities?: CapabilityRegistry;
  /** The handler that runs a turn. */
  turnHandler?: TurnHandler;
  /** The methods this server serves, besides the ones it owns. */
  handlers?: Record<string, PeerHandler>;
  /** Called with every refusal and every diagnostic. */
  onDiagnostic?: (diagnostic: PeerDiagnostic) => void;
  /** The message size limit. */
  maxFrameBytes?: number;
  /** How long a request waits for its answer, in milliseconds. */
  requestTimeoutMs?: number;
}

/** A server. */
export interface ProtocolServer extends ProtocolPeer {
  /** The sessions this server holds. */
  readonly sessions: readonly ProtocolSession[];
  /** The capabilities this server knows about. */
  readonly capabilities: CapabilityRegistry;
  /**
   * Ask the peer for a decision.
   *
   * The request names the tool, the call and the reason, and it carries the
   * request id the answer must quote. The answer that comes back is
   * attributed to the peer that gave it.
   */
  requestApproval(
    request: ApprovalRequest,
  ): Promise<{ readonly decision: ApprovalDecision; readonly answerer: string }>;
  /** The approvals that are waiting for an answer. */
  pendingApprovals(): ApprovalRequest[];
}

/**
 * The capability each method belongs to.
 *
 * A method whose capability is not enabled answers with the capability's
 * record rather than with a result that pretends the work was done.
 */
const METHOD_CAPABILITIES: Readonly<Record<string, string>> = Object.freeze({
  'session/create': 'session',
  'session/status': 'session',
  'session/cancel': 'session',
  'session/dispose': 'session',
  'turn/start': 'turn',
  'turn/abort': 'turn',
  'tool/list': 'tool',
  'tool/describe': 'tool',
  'tool/call': 'tool',
  'model/list': 'model',
  'model/describe': 'model',
  'model/select': 'model',
  'approval/request': 'approval',
  'approval/answer': 'approval',
  'approval/pending': 'approval',
  'capability/describe': 'capability',
});

/** A waiter for an approval's decision. */
interface ApprovalWaiter {
  readonly resolve: (value: { decision: ApprovalDecision; answerer: string }) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Create a server.
 *
 * The server owns the session store, the approval registry and the turn
 * machinery; the peer underneath owns the exchange.
 */
export function createProtocolServer(options: ProtocolServerOptions): ProtocolServer {
  const capabilities = options.capabilities ?? createDefaultCapabilityRegistry();
  const sessions = new SessionStore();
  const approvals = new ApprovalRegistry();
  const waiters = new Map<string, ApprovalWaiter>();
  const turnControllers = new Map<string, AbortController>();
  const endedTurns = new Set<string>();
  let turnCounter = 0;

  const peer = createProtocolPeer({
    input: options.input,
    output: options.output,
    identity: options.identity ?? 'prricode',
    peerIdentity: options.peerIdentity ?? 'peer',
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    // A known method with no handler is answered with the record of the
    // capability its area needs, when that capability is off. The honest
    // answer is "this cannot run, and here is why" — not "not implemented".
    onUnhandled: (method) => degradedAnswer(method),
  });

  /**
   * The `turn` capability follows the turn runner.
   *
   * A server with a turn runner can run turns, and says so; a server without
   * one reports the reason. The embedder may register its own `turn` record
   * afterwards, and that record is the one that counts.
   */
  if (options.turnHandler) {
    capabilities.register('turn', capabilityRecord(true, null));
  }

  /** The record of the capability a method belongs to, when it is disabled. */
  const degradedAnswer = (method: string): CapabilityRecord | undefined => {
    const name = METHOD_CAPABILITIES[method];
    if (name === undefined) return undefined;
    const record = capabilities.get(name);
    if (record === undefined || record.enabled) return undefined;
    return record;
  };

  /** Serve a method, behind the degradation rule. */
  const serve = (method: string, handler: PeerHandler): void => {
    peer.onRequest(method, async (params, context) => {
      const degraded = degradedAnswer(method);
      if (degraded) return degraded;
      return handler(params, context);
    });
  };

  /** The record a call carries, when it carries one. */
  const recordOf = (params: unknown): Record<string, unknown> =>
    typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};

  /** The session a call names, or the refusal that names the reason. */
  const requireSession = (params: unknown): ProtocolSession => {
    const record = recordOf(params);
    const sessionId = record['sessionId'];
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw protocolError(
        PROTOCOL_ERROR_CODES.methodInvalidParams,
        'the call needs a sessionId',
      );
    }
    const session = sessions.get(sessionId);
    if (!session) {
      throw protocolError(
        PROTOCOL_ERROR_CODES.sessionUnknown,
        `no session "${sessionId}"`,
        { sessionId },
      );
    }
    if (session.state === 'disposed') {
      throw protocolError(
        PROTOCOL_ERROR_CODES.sessionDisposed,
        `the session "${sessionId}" has been disposed`,
        { sessionId },
      );
    }
    return session;
  };

  const releaseWaiter = (requestId: string, error: Error): void => {
    const waiter = waiters.get(requestId);
    if (!waiter) return;
    waiters.delete(requestId);
    waiter.reject(error);
  };

  const settleWaiter = (
    requestId: string,
    value: { decision: ApprovalDecision; answerer: string },
  ): void => {
    const waiter = waiters.get(requestId);
    if (!waiter) return;
    waiters.delete(requestId);
    waiter.resolve(value);
  };

  /**
   * End a turn, and say how it ended.
   *
   * A turn that ended is ended **once**: the second ending is ignored, so a
   * handler that settles after its turn was aborted does not end it twice.
   */
  function endTurn(
    turnId: string,
    state: Exclude<TurnState, 'running'>,
    failure?: { code: string; message: string },
  ): void {
    if (endedTurns.has(turnId)) return;
    endedTurns.add(turnId);
    const controller = turnControllers.get(turnId);
    turnControllers.delete(turnId);
    void controller;
    const turn = sessions.closeTurn(turnId, state, failure);
    if (!turn) return;
    if (state === 'failed') {
      peer.notify('turn/failed', {
        sessionId: turn.sessionId,
        turnId: turn.id,
        code: failure?.code ?? PROTOCOL_ERROR_CODES.turnFailed,
        message: failure?.message ?? 'the turn failed',
      });
      return;
    }
    peer.notify('event/message', {
      sessionId: turn.sessionId,
      turnId: turn.id,
      state,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* The session methods                                                    */
  /* ---------------------------------------------------------------------- */

  serve('session/create', (params) => {
    const record = recordOf(params);
    const client = typeof record['client'] === 'string' ? record['client'] : null;
    if (client !== null) peer.setPeerIdentity(client);
    const session = sessions.create(client);
    return {
      sessionId: session.id,
      state: session.state,
      capabilities: capabilities.all(),
    };
  });

  serve('session/status', (params) => {
    const session = requireSession(params);
    return {
      sessionId: session.id,
      state: session.state,
      turnId: session.turnId,
    };
  });

  serve('session/cancel', (params) => {
    const session = requireSession(params);
    const turn = sessions.currentTurn(session.id);
    if (!turn) {
      return { sessionId: session.id, state: session.state, cancelled: false };
    }
    endTurn(turn.id, 'aborted');
    return {
      sessionId: session.id,
      state: sessions.get(session.id)?.state ?? 'idle',
      cancelled: true,
    };
  });

  serve('session/dispose', (params) => {
    const record = recordOf(params);
    const sessionId = record['sessionId'];
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw protocolError(
        PROTOCOL_ERROR_CODES.methodInvalidParams,
        'the call needs a sessionId',
      );
    }
    const session = sessions.get(sessionId);
    if (!session) {
      throw protocolError(
        PROTOCOL_ERROR_CODES.sessionUnknown,
        `no session "${sessionId}"`,
        { sessionId },
      );
    }
    if (session.state === 'disposed') {
      throw protocolError(
        PROTOCOL_ERROR_CODES.sessionDisposed,
        `the session "${sessionId}" has been disposed`,
        { sessionId },
      );
    }
    sessions.dispose(sessionId);
    return { sessionId, state: 'disposed' };
  });

  /* ---------------------------------------------------------------------- */
  /* The turn methods                                                       */
  /* ---------------------------------------------------------------------- */

  serve('turn/start', (params) => {
    const record = recordOf(params);
    const session = requireSession(params);
    const prompt = record['prompt'];
    if (typeof prompt !== 'string') {
      throw protocolError(
        PROTOCOL_ERROR_CODES.methodInvalidParams,
        'the call needs a prompt',
      );
    }
    const model = typeof record['model'] === 'string' ? record['model'] : undefined;
    turnCounter += 1;
    const turnId = `turn_${turnCounter}`;
    sessions.openTurn(session.id, turnId);

    const controller = new AbortController();
    turnControllers.set(turnId, controller);

    const turn: TurnRequest = {
      sessionId: session.id,
      turnId,
      prompt,
      model,
      signal: controller.signal,
      emit(method, eventParams): void {
        if (endedTurns.has(turnId)) return;
        peer.notify(method, { sessionId: session.id, turnId, ...eventParams });
      },
    };

    const handler = options.turnHandler;
    if (!handler) {
      endTurn(turnId, 'failed', {
        code: PROTOCOL_ERROR_CODES.methodUnavailable,
        message: 'no turn runner is registered in this build',
      });
      return { turnId };
    }

    void (async () => {
      try {
        const outcome = await handler(turn);
        if (outcome.state === 'failed') {
          endTurn(turnId, 'failed', {
            code: outcome.code ?? PROTOCOL_ERROR_CODES.turnFailed,
            message: outcome.message ?? 'the turn failed',
          });
          return;
        }
        endTurn(turnId, outcome.state === 'aborted' ? 'aborted' : 'completed');
      } catch (error) {
        const payload = toErrorPayload(error);
        endTurn(turnId, 'failed', { code: payload.code, message: payload.message });
      }
    })();

    return { turnId };
  });

  serve('turn/abort', (params) => {
    const record = recordOf(params);
    const session = requireSession(params);
    const turnId = record['turnId'];
    if (typeof turnId !== 'string' || turnId.length === 0) {
      throw protocolError(
        PROTOCOL_ERROR_CODES.methodInvalidParams,
        'the call needs a turnId',
      );
    }
    const turn = sessions.getTurn(turnId);
    if (!turn || turn.sessionId !== session.id) {
      throw protocolError(
        PROTOCOL_ERROR_CODES.turnUnknown,
        `no turn "${turnId}" in this session`,
        { turnId },
      );
    }
    if (turn.state !== 'running') {
      return { turnId, state: turn.state };
    }
    const controller = turnControllers.get(turnId);
    if (controller) controller.abort();
    // The turn still ends, with the state it reached.
    endTurn(turnId, 'aborted');
    return { turnId, state: 'aborted' as TurnState };
  });

  /* ---------------------------------------------------------------------- */
  /* The approval methods                                                   */
  /* ---------------------------------------------------------------------- */

  serve('approval/request', (params) => {
    const record = recordOf(params);
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
    return { requestId, status: 'pending' };
  });

  serve('approval/answer', (params) => {
    const record = recordOf(params);
    const requestId = record['requestId'];
    const decision = record['decision'];
    if (typeof requestId !== 'string' || requestId.length === 0) {
      throw protocolError(
        PROTOCOL_ERROR_CODES.methodInvalidParams,
        'the call needs a requestId',
      );
    }
    if (decision !== 'allow' && decision !== 'deny') {
      throw protocolError(
        PROTOCOL_ERROR_CODES.methodInvalidParams,
        'the decision is either "allow" or "deny"',
      );
    }
    const answerer = peer.peerIdentity;
    try {
      approvals.decide(requestId, decision, answerer);
      settleWaiter(requestId, { decision, answerer });
      return { requestId, decision, answerer };
    } catch (error) {
      const failure = error as ProtocolError;
      releaseWaiter(requestId, failure);
      throw failure;
    }
  });

  serve('approval/pending', () => ({
    pending: approvals.pending().map((approval) => ({
      requestId: approval.requestId,
      tool: approval.tool,
      call: approval.call,
      reason: approval.reason,
      ...(approval.sessionId === undefined ? {} : { sessionId: approval.sessionId }),
      ...(approval.turnId === undefined ? {} : { turnId: approval.turnId }),
    })),
  }));

  /* ---------------------------------------------------------------------- */
  /* The capability method                                                  */
  /* ---------------------------------------------------------------------- */

  serve('capability/describe', (params) => {
    const record = recordOf(params);
    const name = record['capability'];
    if (typeof name !== 'string' || name.length === 0) {
      throw protocolError(
        PROTOCOL_ERROR_CODES.methodInvalidParams,
        'the call needs the name of a capability',
      );
    }
    const capability = capabilities.get(name);
    if (!capability) {
      throw protocolError(
        PROTOCOL_ERROR_CODES.capabilityUnknown,
        `no capability "${name}"`,
        { capability: name },
      );
    }
    return capability;
  });

  /* ---------------------------------------------------------------------- */
  /* The embedder's methods                                                 */
  /* ---------------------------------------------------------------------- */

  for (const [method, handler] of Object.entries(options.handlers ?? {})) {
    serve(method, handler);
  }

  const server: ProtocolServer = {
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
    get sessions(): readonly ProtocolSession[] {
      return sessions
        .ids()
        .map((id) => sessions.get(id))
        .filter((session): session is ProtocolSession => !!session);
    },
    capabilities,
    async requestApproval(request: ApprovalRequest) {
      approvals.open(request);
      const waiter = new Promise<{ decision: ApprovalDecision; answerer: string }>(
        (resolve, reject) => {
          waiters.set(request.requestId, { resolve, reject });
        },
      );
      void peer.request('approval/request', { ...request }).then(
        () => undefined,
        (error: Error) => {
          releaseWaiter(request.requestId, error);
        },
      );
      return waiter;
    },
    pendingApprovals() {
      return approvals.pending().map((approval) => ({
        requestId: approval.requestId,
        tool: approval.tool,
        call: approval.call,
        reason: approval.reason,
        ...(approval.sessionId === undefined ? {} : { sessionId: approval.sessionId }),
        ...(approval.turnId === undefined ? {} : { turnId: approval.turnId }),
      }));
    },
  };

  return server;
}

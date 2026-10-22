/**
 * The session lifecycle.
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §5.
 *
 * **One responsibility:** the states a session is in, the moves between them,
 * and the store the server keeps them in.
 *
 * ## What the specification states
 *
 * ```
 *    create ──► active ──► (turn/start) ──► running ──► idle ──► disposed
 *                  │                          │                    ▲
 *                  └──────── turn/abort ──────┴────────────────────┘
 * ```
 *
 * - **`session/create`** returns a session id and the capability record.
 * - **`turn/start`** returns a turn id at once; the turn's events follow.
 * - **`turn/abort`** stops the turn; the turn still ends, with the state it
 *   reached.
 * - **`session/dispose`** releases the session. A disposed session answers
 *   nothing, and every later call is `session/disposed`.
 *
 * ## The states
 *
 * The four states are the diagram's: `active` (created, no turn has run),
 * `running` (a turn is running), `idle` (a turn has run and ended) and
 * `disposed` (released).
 *
 * A **disposed** session does no work: it runs no turn and produces no event.
 * Every later call against it is refused with `session/disposed` — a refusal
 * with a reason, which is the one thing a released session is allowed to do.
 */

/** The states a session is in. */
export type SessionState = 'active' | 'running' | 'idle' | 'disposed';

/** One session. */
export interface ProtocolSession {
  /** The session's id. */
  readonly id: string;
  /** The state the session is in. */
  state: SessionState;
  /** The turn that is running, when one is. */
  turnId: string | null;
  /** The name of the client that created the session, when it named itself. */
  readonly client: string | null;
}

/** A turn's own states. */
export type TurnState = 'running' | 'completed' | 'failed' | 'aborted';

/** One turn. */
export interface ProtocolTurn {
  /** The turn's id. */
  readonly id: string;
  /** The session the turn belongs to. */
  readonly sessionId: string;
  /** The state the turn is in. */
  state: TurnState;
  /** The code of the failure, when the turn failed. */
  failureCode?: string;
  /** The reason of the failure, when the turn failed. */
  failureMessage?: string;
}

/**
 * The store of a peer's sessions.
 *
 * A **disposed** session is kept, not forgotten: a call against it is refused
 * with `session/disposed` rather than `session/unknown`, and the two are
 * different facts — one is a session that existed and was released, the other
 * is a session that never existed.
 */
export class SessionStore {
  private readonly sessions = new Map<string, ProtocolSession>();
  private readonly turns = new Map<string, ProtocolTurn>();
  private counter = 0;

  /** Create a session, in the `active` state. */
  create(client: string | null = null): ProtocolSession {
    this.counter += 1;
    const session: ProtocolSession = {
      id: `session_${this.counter}`,
      state: 'active',
      turnId: null,
      client,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** The session, or `undefined` when there is none with that id. */
  get(id: string): ProtocolSession | undefined {
    return this.sessions.get(id);
  }

  /** Every session's id, in the order they were created. */
  ids(): string[] {
    return [...this.sessions.keys()];
  }

  /** Open a turn on the session, and move the session to `running`. */
  openTurn(sessionId: string, turnId: string): ProtocolTurn {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`no session "${sessionId}"`);
    const turn: ProtocolTurn = { id: turnId, sessionId, state: 'running' };
    this.turns.set(turnId, turn);
    session.turnId = turnId;
    session.state = 'running';
    return turn;
  }

  /** The turn, or `undefined` when there is none with that id. */
  getTurn(turnId: string): ProtocolTurn | undefined {
    return this.turns.get(turnId);
  }

  /** The turn of a session, or `undefined` when it has none running. */
  currentTurn(sessionId: string): ProtocolTurn | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.turnId === null) return undefined;
    return this.turns.get(session.turnId);
  }

  /** End a turn, and move the session back to `idle`. */
  closeTurn(turnId: string, state: Exclude<TurnState, 'running'>, failure?: { code: string; message: string }): ProtocolTurn | undefined {
    const turn = this.turns.get(turnId);
    if (!turn) return undefined;
    turn.state = state;
    if (failure) {
      turn.failureCode = failure.code;
      turn.failureMessage = failure.message;
    }
    const session = this.sessions.get(turn.sessionId);
    if (session && session.turnId === turnId) {
      session.turnId = null;
      if (session.state !== 'disposed') session.state = 'idle';
    }
    return turn;
  }

  /** Dispose a session. */
  dispose(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.state = 'disposed';
    session.turnId = null;
    return true;
  }
}

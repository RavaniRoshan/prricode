/**
 * The **agent's states** — the closed list, and the transitions between them.
 *
 * **The milestone:** `CC-048` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **One responsibility:** the four states, and the picture of a change.
 *
 * ## The four states
 *
 * The agent is in exactly one of four states:
 *
 * | the state | what the agent is doing |
 * |---|---|
 * | `idle` | nothing — it is waiting for the user |
 * | `thinking` | it is thinking |
 * | `asking` | it is waiting for an answer |
 * | `tool` | it is running a tool |
 *
 * The list is **closed**: a state that is not in it is not a state, and a
 * caller that names one is refused rather than answered with something else.
 *
 * ## The transition
 *
 * A change draws **two** lines for a moment: the outgoing one leaves and the
 * incoming one arrives. The leaving line is the `transition-out` motion and
 * the arriving line is the `transition-in` motion, and the gap between them
 * is the arriving line's **offset** — the incoming line comes up from one
 * line below, exactly as the motion table says.
 *
 * The leaving line is gone when the transition has run its course, and what
 * is left is the incoming line on its own.
 *
 * ## The resting frame
 *
 * A terminal that cannot draw a frame gets the **resting** picture: the
 * current state, plainly, with no outgoing line and no gap. A motion that is
 * not drawn is not a motion that has finished.
 */

import { DARK_THEME, type Theme } from '../theme.js';
import { drawMotion } from '../motion/render.js';
import { motionFor } from '../motion/vocabulary.js';
import type { MotionCapability } from '../motion/capability.js';

import { rowOf } from './frame.js';
import type { SurfaceFrame } from './surface.js';

/* -------------------------------------------------------------------------- */
/* The states                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The four states of the agent.
 *
 * The list is closed, and it is the whole of it: a surface that wants to
 * name the agent's state takes one of these.
 */
export const AGENT_STATES = ['idle', 'thinking', 'asking', 'tool'] as const;

/** One of the agent's four states. */
export type AgentState = (typeof AGENT_STATES)[number];

/**
 * The state a name asks for.
 *
 * The lookup is over a **set**, so a name that is not in the list is
 * **refused** — it is never quietly answered with some other state.
 */
export function agentStateFor(name: string): AgentState {
  if (!AGENT_STATE_TABLE.has(name)) {
    throw new Error(`there is no agent state named "${name}"`);
  }
  return name as AgentState;
}

/** The table the lookup reads. */
const AGENT_STATE_TABLE: ReadonlySet<string> = new Set<string>(AGENT_STATES);

/**
 * What the state's line says.
 *
 * The words are **this implementation's own**: the first layer's status line
 * is the caller's own text, and this line is the second layer's.
 */
export function stateLabel(state: AgentState): string {
  switch (state) {
    case 'idle':
      return 'Ready';
    case 'thinking':
      return 'Thinking';
    case 'asking':
      return 'Waiting for an answer';
    case 'tool':
      return 'Running a tool';
  }
}

/**
 * The role the state's line is drawn in.
 *
 * Every role is the theme's own: the theme owns the colours, and the surface
 * only says which one a line belongs to.
 */
export function stateRole(state: AgentState): string {
  switch (state) {
    case 'idle':
      return 'inactive';
    case 'thinking':
      return 'prricode';
    case 'asking':
      return 'permission';
    case 'tool':
      return 'text';
  }
}

/* -------------------------------------------------------------------------- */
/* The change                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A change of state.
 *
 * The state the agent was in, and the state it is in now. The first change —
 * the one from nothing — carries no `from`.
 */
export interface StateChange {
  /** The state the agent was in, when it was in one. */
  readonly from: AgentState | null;
  /** The state the agent is in. */
  readonly to: AgentState;
}

/** What the state's frame is drawn from. */
export interface StateFrameRequest {
  /** The change the frame draws. */
  readonly change: StateChange;
  /** The time since the change, in milliseconds. */
  readonly elapsedMs: number;
  /** The terminal's capability. */
  readonly capability: MotionCapability;
  /** The theme the roles are read from. */
  readonly theme?: Theme | undefined;
}

/**
 * The state's frame.
 *
 * The incoming line is the `transition-in` motion and the outgoing line is
 * the `transition-out` motion — the two halves of the system's transition
 * pair, with the system's own durations and its own easing.
 */
export function renderStateFrame(request: StateFrameRequest): SurfaceFrame {
  const theme = request.theme ?? DARK_THEME;

  const entering = drawMotion({
    motion: 'transition-in',
    elapsedMs: request.elapsedMs,
    content: [{ text: stateLabel(request.change.to), role: stateRole(request.change.to) }],
    theme,
    capability: request.capability,
  });

  const leaving =
    request.change.from === null
      ? null
      : drawMotion({
          motion: 'transition-out',
          elapsedMs: request.elapsedMs,
          content: [{ text: stateLabel(request.change.from), role: stateRole(request.change.from) }],
          theme,
          capability: request.capability,
        });

  const rows = [];

  // The outgoing line is there while the transition runs. A terminal that
  // cannot draw a frame has no transition at all: it has the resting picture,
  // which is the incoming line and nothing else.
  const duration = motionFor('transition-out').durationMs;
  if (leaving !== null && request.capability.enabled && request.elapsedMs < duration) {
    rows.push(rowOf(leaving.segments));
    // The arriving line comes up from one line below, and the gap it leaves
    // is the gap the user sees.
    for (let line = 0; line < entering.offset; line += 1) {
      rows.push(rowOf([]));
    }
  }

  rows.push(rowOf(entering.segments));

  return {
    rows,
    motion: entering.motion,
    frame: entering.frame,
    opacity: entering.opacity,
    offset: entering.offset,
    unsupported: request.capability.enabled ? null : request.capability.unsupported,
  };
}

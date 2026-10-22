/**
 * The **surface** — the second layer's motion applied to the first layer's
 * terminal.
 *
 * **The milestone:** `CC-048` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The substrate:** `src/ui/motion/` — the shared motion system — and
 * `src/ui/theme.ts` and `src/ui/render/` — the first layer's own surface.
 *
 * ## What this layer is
 *
 * The motion system knows **how** to draw a motion: one vocabulary, one
 * easings table, one durations table, one frame budget, and one drawer. It
 * does not know **what** a motion is drawn over.
 *
 * This layer is the other half. It says:
 *
 * - the **prompt's shimmer** travels across the composer's rule, in the
 *   theme's own shimmer partner;
 * - the agent's **states** are a closed list of four, and a change draws the
 *   outgoing line and the incoming one;
 * - the pipeline's **stage advance** is read out of the protocol's
 *   `event/stage` notification, and the stage pulses as it advances;
 * - the **overlays** fade in when they arrive and fade out when they leave.
 *
 * ## The rules it keeps
 *
 * - **The motion sits on the first layer.** The surface draws the first
 *   layer's own segments, in the first layer's own roles, and it writes no
 *   colour of its own.
 * - **What cannot be drawn is not drawn.** A terminal without the capability
 *   gets the **resting** picture and the reason, and the reason is reported
 *   beside it.
 * - **A frame is a value.** Every function here is a function of its
 *   arguments and the time alone, so a frame can be recorded in a golden and
 *   compared.
 *
 * ## The naming rule applies
 *
 * The layer names the things it draws — a prompt, a state, a stage, an
 * overlay — and no product and no company.
 */

import type { MotionCapability } from '../motion/capability.js';
import type { MotionFrame } from '../motion/vocabulary.js';
import type { MotionName } from '../motion/vocabulary.js';

import type { FrameRow } from './frame.js';

/* -------------------------------------------------------------------------- */
/* The frame a surface draws                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a surface draws.
 *
 * The **rows** are the picture, and the rest says what the motion was: the
 * name it went by, the frame it drew, and the two numbers the frame carries —
 * the opacity and the offset. A surface that lays the rows out reads the
 * offset from here and never reads the frame again.
 */
export interface SurfaceFrame {
  /** The rows, in the order they are drawn. */
  readonly rows: readonly FrameRow[];
  /** The motion that was drawn. */
  readonly motion: MotionName;
  /** The frame that was drawn — the resting one when the motion was not. */
  readonly frame: MotionFrame;
  /** The frame's opacity, 0..1. */
  readonly opacity: number;
  /** The frame's offset, in whole lines. */
  readonly offset: number;
  /** The reason the motion was not drawn, when it was not drawn. */
  readonly unsupported: string | null;
}

/**
 * The reason a terminal that cannot draw gives.
 *
 * The capability carries the reason already; this is the sentence the
 * surface writes **beside** the resting picture, and it is never empty.
 */
export const REASON_CANNOT_DRAW = 'the terminal cannot draw a frame, so no animation is drawn';

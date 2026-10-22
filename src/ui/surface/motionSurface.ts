/**
 * The **motion surface** — every row the second layer's motion draws, in one
 * place.
 *
 * **The milestone:** `CC-048` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **One responsibility:** the composition.
 *
 * ## Why a composition
 *
 * The four surfaces — the prompt, the states, the stages and the overlays —
 * are four separate pictures, and each of them is drawn where it belongs:
 * the rule above the composer, the state line above the status line, the
 * stage's row above that, the overlay in the middle of the screen.
 *
 * The composition is the **whole** of them in one frame, and it is what the
 * golden records: a golden frame is a picture of the terminal, and a picture
 * of the terminal is every row the motion draws, in the order they are drawn.
 *
 * The app draws the same rows in their own places, with the first layer's
 * chrome around them; the composition is the same functions, put together.
 *
 * ## The reason is beside the picture
 *
 * A terminal that cannot draw a frame gets the resting picture **and the
 * reason**. The reason is a row of its own, and it is written once — the
 * surface says *why* it is not animating, and it says it in the shared
 * capability's own sentence.
 */

import { DARK_THEME, type Theme } from '../theme.js';
import type { MotionCapability } from '../motion/capability.js';
import type { MotionName } from '../motion/vocabulary.js';

import { rowOf, type FrameRow, type TerminalFrame } from './frame.js';
import { renderPromptFrame } from './prompt.js';
import { renderStageFrame, type StageAdvance } from './stages.js';
import { renderStateFrame, type StateChange } from './states.js';
import { renderOverlayFrame } from './overlays.js';
import { REASON_CANNOT_DRAW } from './surface.js';

/* -------------------------------------------------------------------------- */
/* The composition                                                             */
/* -------------------------------------------------------------------------- */

/** What the motion surface is drawn from. */
export interface MotionSurfaceRequest {
  /** The terminal's capability. */
  readonly capability: MotionCapability;
  /** The time the surface is drawn at, in milliseconds. */
  readonly elapsedMs: number;
  /** The prompt's rule, when the composer is on the screen. */
  readonly prompt?: { readonly columns: number } | undefined;
  /** The agent's state, and the state it came from. */
  readonly state?: StateChange | undefined;
  /** The stage's advance. */
  readonly stage?: StageAdvance | undefined;
  /** The overlay's rows, and the half of the fade it is in. */
  readonly overlay?:
    | { readonly rows: readonly FrameRow[]; readonly motion?: MotionName | undefined }
    | undefined;
  /** The theme the roles are read from. */
  readonly theme?: Theme | undefined;
}

/**
 * The reason row.
 *
 * The reason the capability carries, in the theme's own `inactive` role — the
 * role the theme has for a line that is there but is not the point. A
 * terminal that can draw has no reason row at all.
 */
export function motionReasonRow(capability: MotionCapability): FrameRow | null {
  if (capability.enabled) return null;
  const reason = capability.unsupported ?? REASON_CANNOT_DRAW;
  return rowOf([{ text: reason, role: 'inactive' }]);
}

/**
 * The whole motion surface, as one frame.
 *
 * The rows are in the order they are drawn on the terminal: the prompt's
 * rule, the state line, the stage's row, the overlay, and the reason.
 */
export function renderMotionSurface(request: MotionSurfaceRequest): TerminalFrame {
  const theme = request.theme ?? DARK_THEME;
  const rows: FrameRow[] = [];

  if (request.prompt !== undefined) {
    rows.push(
      ...renderPromptFrame({
        columns: request.prompt.columns,
        elapsedMs: request.elapsedMs,
        capability: request.capability,
        theme,
      }).rows,
    );
  }

  if (request.state !== undefined) {
    rows.push(
      ...renderStateFrame({
        change: request.state,
        elapsedMs: request.elapsedMs,
        capability: request.capability,
        theme,
      }).rows,
    );
  }

  if (request.stage !== undefined) {
    rows.push(
      ...renderStageFrame({
        advance: request.stage,
        elapsedMs: request.elapsedMs,
        capability: request.capability,
        theme,
      }).rows,
    );
  }

  if (request.overlay !== undefined) {
    rows.push(
      ...renderOverlayFrame({
        rows: request.overlay.rows,
        elapsedMs: request.elapsedMs,
        capability: request.capability,
        theme,
        ...(request.overlay.motion === undefined ? {} : { motion: request.overlay.motion }),
      }).rows,
    );
  }

  const reason = motionReasonRow(request.capability);
  if (reason !== null) rows.push(reason);

  return { rows };
}

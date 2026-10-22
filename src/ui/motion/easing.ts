/**
 * The easings — the four curves the motion system shapes its motions with.
 *
 * **The specification:** `docs/protocol/MOTION.md` §2.2.
 *
 * **One responsibility:** the curve from a progress to an eased progress.
 *
 * ## Every curve is a closed form
 *
 * There is no simulation here, no velocity, no spring and no state. A curve is
 * a **function** of the progress, so a frame is reproducible: the same time
 * gives the same picture, on any machine, in any order.
 *
 * That is what makes the next milestone's visual golden possible, so it is not
 * a convenience: it is the property the whole system is built on.
 *
 * ## The curves
 *
 * | the easing | the curve |
 * |---|---|
 * | `linear` | `t` |
 * | `ease-in` | `t * t` |
 * | `ease-out` | `1 - (1 - t) * (1 - t)` |
 * | `ease-in-out` | `t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) * (-2 * t + 2)) / 2` |
 */

import type { EasingName } from './vocabulary.js';

/**
 * The four easings.
 *
 * The lookup of a curve is own-property, and a name that is not a curve is
 * refused rather than answered with something else.
 */
export const EASINGS: Readonly<Record<EasingName, (t: number) => number>> = Object.freeze({
  /** No shaping at all — the progress is the eased progress. */
  linear: (t: number): number => t,
  /** Slow at the beginning, quick at the end. */
  'ease-in': (t: number): number => t * t,
  /** Quick at the beginning, slow at the end. */
  'ease-out': (t: number): number => 1 - (1 - t) * (1 - t),
  /** Slow at both ends, quick in the middle. */
  'ease-in-out': (t: number): number =>
    t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) * (-2 * t + 2)) / 2,
});

/**
 * Shape a progress with a curve.
 *
 * The progress is **clamped** to `[0, 1]` first and the result is clamped to
 * `[0, 1]` after, so a time outside the pass is the end of the pass and never
 * an overshoot.
 */
export function ease(name: EasingName, t: number): number {
  if (!Object.hasOwn(EASINGS, name)) {
    throw new Error(`there is no easing named "${String(name)}"`);
  }
  const curve = EASINGS[name];
  const clamped = Math.min(1, Math.max(0, t));
  return Math.min(1, Math.max(0, curve(clamped)));
}

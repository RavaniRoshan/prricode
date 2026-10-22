/**
 * The frame — the one function that turns a motion and a time into a picture.
 *
 * **The specification:** `docs/protocol/MOTION.md` §3.
 *
 * **One responsibility:** the frame, and the clock it is quantised against.
 *
 * ## The frame is a value
 *
 * `motionFrame` reads **no clock** and keeps **no counter**. It is a function
 * of the motion and the elapsed time alone, so:
 *
 * - the same time gives the same frame, on any machine;
 * - stepping to a frame one frame at a time gives exactly the frame that
 *   asking for that time gives;
 * - a frame can be asserted on, compared, and **recorded in a golden**.
 *
 * That last one is what the next milestone's visual golden is built on, so it
 * is not a convenience: it is the property the whole system exists for.
 *
 * ## The quantisation
 *
 * A frame is not drawn at an arbitrary moment — it is drawn on a frame
 * boundary. The elapsed time is divided by the frame interval, and the frame
 * is computed at the **quantised** time. Two elapsed times inside one interval
 * therefore give the **same** frame: the picture is a function of the frame
 * index, not of the moment it happened to be drawn.
 */

import { ease } from './easing.js';
import {
  motionFor,
  type Motion,
  type MotionFrame,
  type MotionName,
} from './vocabulary.js';

/* -------------------------------------------------------------------------- */
/* The budget                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The frame interval, in milliseconds.
 *
 * One frame every 33 milliseconds — thirty a second. This is the system's
 * frame budget, and it is the same budget everywhere: the prompt, the
 * transitions, the stage changes and the overlays.
 */
export const MOTION_FRAME_INTERVAL_MS = 33;

/** The nominal rate the interval gives — thirty frames a second. */
export const MOTION_FRAME_RATE = 30;

/* -------------------------------------------------------------------------- */
/* The clock                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The frame index an elapsed time falls in.
 *
 * A negative elapsed time is **0**: a motion that has not started yet is at
 * its beginning.
 */
export function frameIndexAt(
  elapsedMs: number,
  intervalMs: number = MOTION_FRAME_INTERVAL_MS,
): number {
  const elapsed = Math.max(0, elapsedMs);
  return Math.floor(elapsed / intervalMs);
}

/* -------------------------------------------------------------------------- */
/* The frame                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The frame a motion shows at a time.
 *
 * The motion may be named or given; a name is looked up in the vocabulary.
 */
export function motionFrame(
  motion: Motion | MotionName,
  elapsedMs: number,
  intervalMs: number = MOTION_FRAME_INTERVAL_MS,
): MotionFrame {
  const named = typeof motion === 'string' ? motionFor(motion) : motion;
  const index = frameIndexAt(elapsedMs, intervalMs);
  const time = index * intervalMs;
  const duration = named.durationMs;

  // The progress within the motion's pass: the position in the cycle for a
  // repeating motion, and the fraction of the pass for a one-pass motion.
  const progress = named.repeats
    ? duration > 0
      ? (time % duration) / duration
      : 0
    : duration > 0
      ? Math.min(1, time / duration)
      : 1;

  const eased = ease(named.easing, progress);

  switch (named.kind) {
    case 'fade':
      return {
        kind: 'fade',
        opacity: named.start.opacity + (named.end.opacity - named.start.opacity) * eased,
      };
    case 'slide':
      return {
        kind: 'slide',
        offset: Math.round(named.start.offset + (named.end.offset - named.start.offset) * eased),
      };
    case 'pulse':
      return {
        kind: 'pulse',
        brightness:
          named.start.brightness + (named.end.brightness - named.start.brightness) * eased,
      };
    case 'shimmer':
      // The cycling kinds run on the raw progress of the cycle: a curve has no
      // meaning in a cycle that never ends.
      return {
        kind: 'shimmer',
        phase: named.start.phase + (named.end.phase - named.start.phase) * progress,
      };
    case 'blink':
      return { kind: 'blink', visible: progress < 0.5 ? named.start.visible : named.end.visible };
  }
}

/**
 * The frame a motion shows when it is **not** animating.
 *
 * This is the degraded picture — what a terminal without the capability gets —
 * and it is **not** the end of a pass.
 */
export function restingFrame(motion: Motion | MotionName): MotionFrame {
  const named = typeof motion === 'string' ? motionFor(motion) : motion;
  return named.resting;
}

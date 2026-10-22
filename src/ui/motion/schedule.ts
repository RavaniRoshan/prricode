/**
 * The scheduler — the system's only clock, and the rule that the input comes
 * first.
 *
 * **The specification:** `docs/protocol/MOTION.md` §6.
 *
 * **One responsibility:** when a frame is drawn.
 *
 * ## Motion never blocks the input
 *
 * - a **tick** draws **at most one** frame;
 * - a tick that finds an **input waiting** draws **nothing** and yields to it —
 *   the input goes first, always;
 * - the frame's time comes from the **clock**, not from an accumulation of
 *   frame costs, so a slow frame **drops** the frames it missed rather than
 *   queueing them. The picture catches up, and the key is never behind the
 *   picture.
 *
 * ## A terminal that cannot draw gets nothing
 *
 * When the capability is off, the scheduler draws **nothing at all**. The
 * surface draws the resting picture once, and the reason is in the
 * capability's own record.
 *
 * ## The clock is injected
 *
 * The scheduler takes its time from a `now` it is given, so a test drives it
 * by hand and asserts on the frames it draws.
 */

import { motionFrame, MOTION_FRAME_INTERVAL_MS, frameIndexAt } from './frame.js';
import { motionFor, type Motion, type MotionFrame, type MotionName } from './vocabulary.js';
import type { MotionCapability } from './capability.js';

/* -------------------------------------------------------------------------- */
/* The options                                                                  */
/* -------------------------------------------------------------------------- */

/** How the scheduler is built. */
export interface MotionSchedulerOptions {
  /** The motion the scheduler draws. */
  readonly motion: Motion | MotionName;
  /** The terminal's capability — when it is off, nothing is drawn. */
  readonly capability: MotionCapability;
  /** What is drawn when a frame is due. */
  readonly onFrame: (frame: MotionFrame, index: number) => void;
  /** The clock, when the caller does not pass a time to a tick. */
  readonly now?: (() => number) | undefined;
  /** The frame interval — the budget. */
  readonly intervalMs?: number | undefined;
}

/* -------------------------------------------------------------------------- */
/* The scheduler                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The scheduler.
 *
 * One tick is one frame at most, and the input always goes first.
 */
export class MotionScheduler {
  private readonly motion: Motion;
  private readonly capability: MotionCapability;
  private readonly onFrame: (frame: MotionFrame, index: number) => void;
  private readonly now: () => number;
  private readonly intervalMs: number;

  /** The time the motion started at. */
  private origin = 0;
  /** The index of the last frame drawn — `-1` when none has been. */
  private lastIndex = -1;
  /** Whether an input is waiting. */
  private inputPending = false;

  constructor(options: MotionSchedulerOptions) {
    this.motion = typeof options.motion === 'string' ? motionFor(options.motion) : options.motion;
    this.capability = options.capability;
    this.onFrame = options.onFrame;
    this.now = options.now ?? ((): number => Date.now());
    this.intervalMs = options.intervalMs ?? MOTION_FRAME_INTERVAL_MS;
  }

  /**
   * Begin the motion.
   *
   * The origin is the time the motion started at; the elapsed time is measured
   * from it.
   */
  start(originMs?: number): void {
    this.origin = originMs ?? this.now();
    this.lastIndex = -1;
    this.inputPending = false;
  }

  /**
   * Say that an input is waiting.
   *
   * The next tick draws nothing and yields to it. The input is waited for, not
   * lost: the tick after it draws again.
   */
  notifyInput(): void {
    this.inputPending = true;
  }

  /** The index of the last frame drawn, or `-1` when none has been. */
  get index(): number {
    return this.lastIndex;
  }

  /**
   * Draw a frame, if one is due.
   *
   * Returns whether a frame was drawn.
   */
  tick(nowMs?: number): boolean {
    // A terminal that cannot draw gets nothing at all.
    if (!this.capability.enabled) return false;

    // The input goes first.
    if (this.inputPending) {
      this.inputPending = false;
      return false;
    }

    const now = nowMs ?? this.now();
    const elapsed = Math.max(0, now - this.origin);
    const index = frameIndexAt(elapsed, this.intervalMs);
    if (index === this.lastIndex) return false;
    this.lastIndex = index;

    // The frame is drawn at its **own** quantised time, so the picture is the
    // frame the index names and not the moment the tick happened to arrive.
    const time = index * this.intervalMs;
    this.onFrame(motionFrame(this.motion, time, this.intervalMs), index);
    return true;
  }
}

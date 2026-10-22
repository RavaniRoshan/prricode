/**
 * The motion system's **vocabulary** — the kinds, the easings, the durations and
 * the named motions.
 *
 * **The specification:** `docs/protocol/MOTION.md` §2.
 *
 * **One responsibility:** the names, and the table that says what each of them
 * is.
 *
 * ## What this module is
 *
 * The vocabulary is **one table**. A surface that wants a motion takes one of
 * the seven names in §2.4, and this module says what that name is: the kind it
 * animates, the easing it uses, how long a pass takes, whether it repeats, and
 * the three frames it declares — the **start**, the **end** and the **resting**
 * one.
 *
 * ## The three frames
 *
 * - the **start** is the frame at the beginning of a pass;
 * - the **end** is the frame at the end of a pass;
 * - the **resting** frame is the picture the motion shows when it is **not**
 *   animating — which is what a terminal without the capability gets.
 *
 * The resting frame is **not** the end of a pass. `overlay-out` ends at no
 * opacity and still rests fully present: a motion that is not drawn is not a
 * motion that has finished.
 *
 * ## The lookup is own-property
 *
 * The motion's name can come from a surface, and `Object.prototype` carries
 * members called `constructor` and `toString`. The lookup is therefore
 * `Object.hasOwn`, and a name that is not in the table is **refused** rather
 * than quietly answered with something else.
 */

import type { Segment } from '../theme.js';

/* -------------------------------------------------------------------------- */
/* The names                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What a motion animates.
 *
 * There are five kinds, and no more: a presence, a place, a brightness, a
 * travelling light and a visibility.
 */
export type MotionKind = 'fade' | 'slide' | 'pulse' | 'shimmer' | 'blink';

/** The name of an easing. */
export type EasingName = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';

/** The name of a duration. */
export type DurationName = 'instant' | 'fast' | 'normal' | 'slow';

/**
 * The name of a motion.
 *
 * These seven names are the product's whole motion vocabulary: the prompt, the
 * transitions between the agent's states, the pipeline's stage changes and the
 * overlays all animate through them.
 */
export type MotionName =
  | 'overlay-in'
  | 'overlay-out'
  | 'transition-in'
  | 'transition-out'
  | 'prompt-shimmer'
  | 'stage-advance'
  | 'cursor-blink';

/* -------------------------------------------------------------------------- */
/* The frame                                                                    */
/* -------------------------------------------------------------------------- */

/** How present the content is — 0..1. */
export interface FadeFrame {
  readonly kind: 'fade';
  readonly opacity: number;
}

/** Where the content sits — whole lines, signed. */
export interface SlideFrame {
  readonly kind: 'slide';
  readonly offset: number;
}

/** How brightly the content is drawn — 0.5..1. */
export interface PulseFrame {
  readonly kind: 'pulse';
  readonly brightness: number;
}

/** Where the travelling light is — 0..1. */
export interface ShimmerFrame {
  readonly kind: 'shimmer';
  readonly phase: number;
}

/** Whether the content is drawn at all. */
export interface BlinkFrame {
  readonly kind: 'blink';
  readonly visible: boolean;
}

/**
 * One frame of a motion.
 *
 * The frame carries the one value its kind animates, and nothing else. A frame
 * is a **value**: it can be asserted on, compared, and recorded in a golden.
 */
export type MotionFrame = FadeFrame | SlideFrame | PulseFrame | ShimmerFrame | BlinkFrame;

/* -------------------------------------------------------------------------- */
/* The motion                                                                  */
/* -------------------------------------------------------------------------- */

/** What every motion carries, whatever its kind. */
interface MotionBase {
  /** The motion's own name. */
  readonly name: MotionName;
  /** The curve the motion is shaped by. */
  readonly easing: EasingName;
  /** The name of the motion's duration. */
  readonly duration: DurationName;
  /** The duration in milliseconds. */
  readonly durationMs: number;
  /** Whether the motion cycles rather than running one pass. */
  readonly repeats: boolean;
  /** How many lines a `slide` moves — 0 for every other motion. */
  readonly distance: number;
}

/**
 * A motion: a name, and everything the frame function needs.
 *
 * The type is a **discriminated union** over the kind, so the start, the end
 * and the resting frames are the kind's own frame — and the frame function
 * reads them without a cast.
 */
export type Motion =
  | (MotionBase & {
      readonly kind: 'fade';
      readonly start: FadeFrame;
      readonly end: FadeFrame;
      readonly resting: FadeFrame;
    })
  | (MotionBase & {
      readonly kind: 'slide';
      readonly start: SlideFrame;
      readonly end: SlideFrame;
      readonly resting: SlideFrame;
    })
  | (MotionBase & {
      readonly kind: 'pulse';
      readonly start: PulseFrame;
      readonly end: PulseFrame;
      readonly resting: PulseFrame;
    })
  | (MotionBase & {
      readonly kind: 'shimmer';
      readonly start: ShimmerFrame;
      readonly end: ShimmerFrame;
      readonly resting: ShimmerFrame;
    })
  | (MotionBase & {
      readonly kind: 'blink';
      readonly start: BlinkFrame;
      readonly end: BlinkFrame;
      readonly resting: BlinkFrame;
    });

/* -------------------------------------------------------------------------- */
/* The durations                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The durations, in milliseconds.
 *
 * Four names, and every motion's duration is one of them: there is no second
 * duration table anywhere in the product.
 */
export const DURATIONS: Readonly<Record<DurationName, number>> = Object.freeze({
  /** No time at all — the motion is already where it belongs. */
  instant: 0,
  /** A quick change — an overlay arriving or leaving. */
  fast: 120,
  /** The ordinary change — a transition, a stage advancing. */
  normal: 240,
  /** A slow cycle — a shimmer, a blink. */
  slow: 480,
});

/* -------------------------------------------------------------------------- */
/* The named motions                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The seven named motions, in the order the specification lists them.
 */
export const MOTION_NAMES: readonly MotionName[] = Object.freeze([
  'overlay-in',
  'overlay-out',
  'transition-in',
  'transition-out',
  'prompt-shimmer',
  'stage-advance',
  'cursor-blink',
]);

/**
 * The vocabulary: every named motion, and what it is.
 *
 * This table is the whole of it. The **direction** of a motion is in the table
 * too — `overlay-in` fades in and `overlay-out` fades out, `transition-in`
 * comes up from one line below and `transition-out` goes one line above — so a
 * motion never has to be told which way it runs.
 */
export const MOTIONS: Readonly<Record<MotionName, Motion>> = Object.freeze({
  'overlay-in': {
    name: 'overlay-in',
    kind: 'fade',
    easing: 'ease-out',
    duration: 'fast',
    durationMs: DURATIONS.fast,
    repeats: false,
    distance: 0,
    start: { kind: 'fade', opacity: 0 },
    end: { kind: 'fade', opacity: 1 },
    resting: { kind: 'fade', opacity: 1 },
  },
  'overlay-out': {
    name: 'overlay-out',
    kind: 'fade',
    easing: 'ease-in',
    duration: 'fast',
    durationMs: DURATIONS.fast,
    repeats: false,
    distance: 0,
    start: { kind: 'fade', opacity: 1 },
    end: { kind: 'fade', opacity: 0 },
    resting: { kind: 'fade', opacity: 1 },
  },
  'transition-in': {
    name: 'transition-in',
    kind: 'slide',
    easing: 'ease-out',
    duration: 'normal',
    durationMs: DURATIONS.normal,
    repeats: false,
    distance: 1,
    start: { kind: 'slide', offset: 1 },
    end: { kind: 'slide', offset: 0 },
    resting: { kind: 'slide', offset: 0 },
  },
  'transition-out': {
    name: 'transition-out',
    kind: 'slide',
    easing: 'ease-in',
    duration: 'normal',
    durationMs: DURATIONS.normal,
    repeats: false,
    distance: 1,
    start: { kind: 'slide', offset: 0 },
    end: { kind: 'slide', offset: -1 },
    resting: { kind: 'slide', offset: 0 },
  },
  'prompt-shimmer': {
    name: 'prompt-shimmer',
    kind: 'shimmer',
    easing: 'linear',
    duration: 'slow',
    durationMs: DURATIONS.slow,
    repeats: true,
    distance: 0,
    start: { kind: 'shimmer', phase: 0 },
    end: { kind: 'shimmer', phase: 1 },
    resting: { kind: 'shimmer', phase: 0 },
  },
  'stage-advance': {
    name: 'stage-advance',
    kind: 'pulse',
    easing: 'ease-in-out',
    duration: 'normal',
    durationMs: DURATIONS.normal,
    repeats: false,
    distance: 0,
    start: { kind: 'pulse', brightness: 0.5 },
    end: { kind: 'pulse', brightness: 1 },
    resting: { kind: 'pulse', brightness: 1 },
  },
  'cursor-blink': {
    name: 'cursor-blink',
    kind: 'blink',
    easing: 'linear',
    duration: 'slow',
    durationMs: DURATIONS.slow,
    repeats: true,
    distance: 0,
    start: { kind: 'blink', visible: true },
    end: { kind: 'blink', visible: false },
    resting: { kind: 'blink', visible: true },
  },
});

/**
 * The motion a name asks for.
 *
 * The lookup is **own-property**: a name can come from a surface, and
 * `Object.prototype` carries members called `constructor` and `toString`. A
 * name that is not in the table is **refused** — it is never quietly answered
 * with some other motion.
 */
export function motionFor(name: MotionName): Motion {
  if (!Object.hasOwn(MOTIONS, name)) {
    throw new Error(`there is no motion named "${String(name)}"`);
  }
  return MOTIONS[name];
}

/* -------------------------------------------------------------------------- */
/* The content                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The content a motion is drawn over.
 *
 * A string, or the first layer's own segments — a piece of text and the theme
 * **role** it is drawn in. The motion system writes no colour of its own.
 */
export type MotionContent = string | readonly Segment[];

/**
 * The content as segments, with the request's role filling in the ones that
 * have none of their own.
 *
 * A segment that names its own role keeps it: the theme owns the colours, and
 * the motion never overrides a role the content chose.
 */
export function contentSegments(
  content: MotionContent,
  role?: string | undefined,
): Segment[] {
  if (typeof content === 'string') {
    return role === undefined ? [{ text: content }] : [{ text: content, role }];
  }
  return content.map((segment) =>
    segment.role === undefined && role !== undefined ? { ...segment, role } : segment,
  );
}

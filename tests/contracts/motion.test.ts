/**
 * The contract test for the motion system — the second layer's shared motion.
 *
 * **The milestone:** `CC-047` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The specification:** `docs/protocol/MOTION.md` — one vocabulary used
 * everywhere: the same kinds, the same easings, the same durations and the same
 * frame budget, for the prompt, the transitions, the stage changes and the
 * overlays. The capability is detected once, and what cannot be drawn is not
 * drawn, with the reason in the shared shape.
 *
 * ## What is measured, and how
 *
 * - **One vocabulary.** The seven named motions are the whole table, and every
 *   one of them carries its easing, its duration and its resting frame. There
 *   is no second table: the test reads the table and checks that nothing else
 *   is in it.
 * - **The motion is deterministic.** A frame is a function of the motion and
 *   the time alone. The test asks for a frame directly and **steps** to it one
 *   frame at a time, and the two are compared.
 * - **The same motion renders identically wherever it is used.** The motion is
 *   drawn in **two places** — the direct draw and the scheduler's draw — and
 *   the pictures are compared.
 * - **A terminal without the capability gets the degraded form and the
 *   reason.** The reason is in the shared shape — `enabled: false` and
 *   `unsupported: <why>` — and the picture is the motion's resting frame.
 * - **Motion never blocks the input.** A tick that finds an input waiting draws
 *   nothing, and a slow frame drops the frames it missed rather than queueing
 *   them.
 * - **The first layer is not disturbed.** The motion system sits on the theme's
 *   own roles and the first layer's own segment shape, and writes no colour of
 *   its own.
 */

import { describe, expect, it } from 'vitest';

import {
  DARK_THEME,
  type Segment,
} from '../../src/ui/theme.js';
import {
  DURATIONS,
  EASINGS,
  MOTION_FRAME_INTERVAL_MS,
  MOTION_FRAME_RATE,
  MOTIONS,
  MOTION_NAMES,
  MotionCapabilityProvider,
  MotionScheduler,
  detectMotionCapability,
  drawFrame,
  drawMotion,
  ease,
  frameIndexAt,
  motionCapability,
  motionFor,
  motionFrame,
  restingFrame,
  type EasingName,
  type Motion,
  type MotionCapability,
  type MotionFrame,
  type MotionKind,
  type MotionName,
} from '../../src/ui/motion/index.js';

/* -------------------------------------------------------------------------- */
/* The helpers                                                                 */
/* -------------------------------------------------------------------------- */

/** A capability record of a terminal that can draw. */
function capableTerminal(overrides: Partial<MotionCapability> = {}): MotionCapability {
  return {
    enabled: true,
    unsupported: null,
    interactive: true,
    reducedMotion: false,
    ...overrides,
  };
}

/** The text of a list of segments, joined. */
function textOf(segments: readonly Segment[]): string {
  return segments.map((segment) => segment.text).join('');
}

/** The roles of a list of segments, in order. */
function rolesOf(segments: readonly Segment[]): (string | undefined)[] {
  return segments.map((segment) => segment.role);
}

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                               */
/* -------------------------------------------------------------------------- */

describe('the motion vocabulary', () => {
  it('names the seven motions, and the table holds nothing else', () => {
    expect(MOTION_NAMES).toEqual([
      'overlay-in',
      'overlay-out',
      'transition-in',
      'transition-out',
      'prompt-shimmer',
      'stage-advance',
      'cursor-blink',
    ]);
    expect(Object.keys(MOTIONS).sort()).toEqual([...MOTION_NAMES].sort());
  });

  it('gives every motion a kind, an easing, a duration and a resting frame of that kind', () => {
    for (const name of MOTION_NAMES) {
      const motion = motionFor(name);
      expect(Object.hasOwn(EASINGS, motion.easing)).toBe(true);
      expect(Object.hasOwn(DURATIONS, motion.duration)).toBe(true);
      expect(motion.durationMs).toBe(DURATIONS[motion.duration]);
      expect(motion.resting.kind).toBe(motion.kind);
    }
  });

  it('has four durations, and the table holds nothing else', () => {
    expect(DURATIONS).toEqual({ instant: 0, fast: 120, normal: 240, slow: 480 });
    expect(Object.keys(DURATIONS).sort()).toEqual(['fast', 'instant', 'normal', 'slow']);
  });

  it('has four easings, and each one is the curve the specification states', () => {
    expect(Object.keys(EASINGS).sort()).toEqual(['ease-in', 'ease-in-out', 'ease-out', 'linear']);
    expect(EASINGS.linear(0.25)).toBe(0.25);
    expect(EASINGS['ease-in'](0.5)).toBe(0.25);
    expect(EASINGS['ease-out'](0.5)).toBe(0.75);
    expect(EASINGS['ease-in-out'](0.25)).toBeCloseTo(0.125, 12);
    expect(EASINGS['ease-in-out'](0.75)).toBeCloseTo(0.875, 12);
  });

  it('clamps the curve to the progress, so a time outside the pass is the end of it', () => {
    expect(ease('linear', -1)).toBe(0);
    expect(ease('linear', 2)).toBe(1);
    expect(ease('ease-out', 2)).toBe(1);
  });

  it('binds each motion to its easing, its duration and whether it repeats', () => {
    const table: Record<MotionName, [MotionKind, EasingName, number, boolean]> = {
      'overlay-in': ['fade', 'ease-out', 120, false],
      'overlay-out': ['fade', 'ease-in', 120, false],
      'transition-in': ['slide', 'ease-out', 240, false],
      'transition-out': ['slide', 'ease-in', 240, false],
      'prompt-shimmer': ['shimmer', 'linear', 480, true],
      'stage-advance': ['pulse', 'ease-in-out', 240, false],
      'cursor-blink': ['blink', 'linear', 480, true],
    };
    for (const name of MOTION_NAMES) {
      const motion = motionFor(name);
      const [kind, easing, durationMs, repeats] = table[name];
      expect(motion.kind).toBe(kind);
      expect(motion.easing).toBe(easing);
      expect(motion.durationMs).toBe(durationMs);
      expect(motion.repeats).toBe(repeats);
    }
  });

  it('slides the transitions by one line, and moves nothing else', () => {
    expect(motionFor('transition-in').distance).toBe(1);
    expect(motionFor('transition-out').distance).toBe(1);
    for (const name of MOTION_NAMES) {
      if (name === 'transition-in' || name === 'transition-out') continue;
      expect(motionFor(name).distance).toBe(0);
    }
  });

  it('rests each motion at the picture the specification states', () => {
    expect(restingFrame(motionFor('overlay-in'))).toEqual({ kind: 'fade', opacity: 1 });
    expect(restingFrame(motionFor('overlay-out'))).toEqual({ kind: 'fade', opacity: 1 });
    expect(restingFrame(motionFor('transition-in'))).toEqual({ kind: 'slide', offset: 0 });
    expect(restingFrame(motionFor('transition-out'))).toEqual({ kind: 'slide', offset: 0 });
    expect(restingFrame(motionFor('prompt-shimmer'))).toEqual({ kind: 'shimmer', phase: 0 });
    expect(restingFrame(motionFor('stage-advance'))).toEqual({ kind: 'pulse', brightness: 1 });
    expect(restingFrame(motionFor('cursor-blink'))).toEqual({ kind: 'blink', visible: true });
  });

  it('does not mistake the end of a pass for the resting picture', () => {
    // `overlay-out` ends at no opacity; its resting frame is fully present.
    const end = motionFrame(motionFor('overlay-out'), 1000);
    expect(end).toEqual({ kind: 'fade', opacity: 0 });
    expect(restingFrame(motionFor('overlay-out'))).toEqual({ kind: 'fade', opacity: 1 });
  });
});

/* -------------------------------------------------------------------------- */
/* The frame                                                                    */
/* -------------------------------------------------------------------------- */

describe('the frame', () => {
  it('spends one frame every 33 milliseconds, thirty a second', () => {
    expect(MOTION_FRAME_INTERVAL_MS).toBe(33);
    expect(MOTION_FRAME_RATE).toBe(30);
  });

  it('quantises the time to the frame index', () => {
    expect(frameIndexAt(0)).toBe(0);
    expect(frameIndexAt(32)).toBe(0);
    expect(frameIndexAt(33)).toBe(1);
    expect(frameIndexAt(65)).toBe(1);
    expect(frameIndexAt(66)).toBe(2);
  });

  it('treats a negative time as the beginning', () => {
    expect(frameIndexAt(-100)).toBe(0);
    expect(motionFrame(motionFor('overlay-in'), -100)).toEqual(
      motionFrame(motionFor('overlay-in'), 0),
    );
  });

  it('gives the same frame to two times inside one frame interval', () => {
    const motion = motionFor('overlay-in');
    expect(motionFrame(motion, 33)).toEqual(motionFrame(motion, 65));
    expect(motionFrame(motion, 33)).not.toEqual(motionFrame(motion, 66));
  });

  it('is the same frame whether it is stepped to or asked for', () => {
    const motion = motionFor('stage-advance');
    const asked = [0, 33, 66, 99, 132, 165, 198, 231].map((elapsed) => motionFrame(motion, elapsed));
    const stepped: MotionFrame[] = [];
    for (let elapsed = 0; elapsed <= 231; elapsed += MOTION_FRAME_INTERVAL_MS) {
      stepped.push(motionFrame(motion, elapsed));
    }
    expect(stepped).toEqual(asked);
  });

  it('fades from nothing to present over the motion\'s own easing', () => {
    const motion = motionFor('overlay-in');
    expect(motionFrame(motion, 0)).toEqual({ kind: 'fade', opacity: 0 });
    // 33 * 3 = 99 ms into a 120 ms pass: 0.825 of the way, eased out.
    expect(motionFrame(motion, 99)).toEqual({
      kind: 'fade',
      opacity: 1 - (1 - 0.825) * (1 - 0.825),
    });
  });

  it('runs a one-pass motion to its end and holds it there', () => {
    const motion = motionFor('overlay-in');
    const end = motionFrame(motion, 240);
    expect(end).toEqual({ kind: 'fade', opacity: 1 });
    expect(motionFrame(motion, 10_000)).toEqual(end);
  });

  it('cycles a repeating motion', () => {
    const motion = motionFor('prompt-shimmer');
    expect(motionFrame(motion, 0)).toEqual({ kind: 'shimmer', phase: 0 });
    // 495 ms is 15 ms into the second 480 ms cycle.
    expect(motionFrame(motion, 495)).toEqual({ kind: 'shimmer', phase: 15 / 480 });
  });

  it('slides in whole lines, and the direction is in the table', () => {
    const entering = motionFor('transition-in');
    expect(motionFrame(entering, 0)).toEqual({ kind: 'slide', offset: 1 });
    expect(motionFrame(entering, 231)).toEqual({ kind: 'slide', offset: 0 });

    const leaving = motionFor('transition-out');
    expect(motionFrame(leaving, 0)).toEqual({ kind: 'slide', offset: 0 });
    expect(motionFrame(leaving, 231)).toEqual({ kind: 'slide', offset: -1 });
  });

  it('pulses from half brightness to full', () => {
    const motion = motionFor('stage-advance');
    expect(motionFrame(motion, 0)).toEqual({ kind: 'pulse', brightness: 0.5 });
    const late = motionFrame(motion, 231);
    expect(late.kind).toBe('pulse');
    if (late.kind !== 'pulse') throw new Error('the frame is not a pulse');
    expect(late.brightness).toBeGreaterThan(0.99);
    expect(late.brightness).toBeLessThanOrEqual(1);
  });

  it('blinks on the first half of the cycle and off on the second', () => {
    const motion = motionFor('cursor-blink');
    expect(motionFrame(motion, 0)).toEqual({ kind: 'blink', visible: true });
    expect(motionFrame(motion, 231)).toEqual({ kind: 'blink', visible: true });
    expect(motionFrame(motion, 264)).toEqual({ kind: 'blink', visible: false });
  });
});

/* -------------------------------------------------------------------------- */
/* The capability                                                               */
/* -------------------------------------------------------------------------- */

describe('the terminal capability', () => {
  it('is enabled for a terminal that can draw', () => {
    const capability = detectMotionCapability({
      env: { TERM: 'xterm-256color' },
      interactive: true,
    });
    expect(capability.enabled).toBe(true);
    expect(capability.unsupported).toBeNull();
    expect(capability.interactive).toBe(true);
    expect(capability.reducedMotion).toBe(false);
  });

  it('reports a terminal that cannot draw a frame, in the shared shape', () => {
    const capability = detectMotionCapability({ env: {}, interactive: false });
    expect(capability.enabled).toBe(false);
    expect(capability.unsupported).toBe('the output is not an interactive terminal, so no frame can be drawn');
  });

  it('treats a terminal that says `dumb` as one that cannot draw', () => {
    const capability = detectMotionCapability({ env: { TERM: 'dumb' }, interactive: true });
    expect(capability.enabled).toBe(false);
    expect(capability.unsupported).toBe('the output is not an interactive terminal, so no frame can be drawn');
  });

  it('reports the user\'s own reason first', () => {
    const capability = detectMotionCapability({
      env: { TERM: 'xterm' },
      interactive: true,
      reducedMotion: true,
    });
    expect(capability.enabled).toBe(false);
    expect(capability.unsupported).toBe('the user asked for reduced motion, so no animation is drawn');
    expect(capability.reducedMotion).toBe(true);
  });

  it('is detected once, and the record is the same every time it is asked for', () => {
    let detections = 0;
    const provider = new MotionCapabilityProvider(() => {
      detections += 1;
      return capableTerminal();
    });
    const first = provider.capability();
    const second = provider.capability();
    expect(detections).toBe(1);
    expect(second).toBe(first);
  });

  it('gives the process one capability, detected once', () => {
    expect(motionCapability()).toBe(motionCapability());
  });

  it('carries the shared pair, and the reason is a sentence', () => {
    const capability = detectMotionCapability({ env: {}, interactive: false });
    expect(Object.hasOwn(capability, 'enabled')).toBe(true);
    expect(Object.hasOwn(capability, 'unsupported')).toBe(true);
    const reason = capability.unsupported;
    expect(reason).not.toBeNull();
    if (reason === null) throw new Error('the reason is missing');
    expect(reason.split(/\s+/).length).toBeGreaterThan(2);
  });
});

/* -------------------------------------------------------------------------- */
/* The degradation                                                              */
/* -------------------------------------------------------------------------- */

describe('the degradation', () => {
  const off = detectMotionCapability({ env: {}, interactive: false });

  it('draws the resting picture when the capability is off', () => {
    const render = drawMotion({
      motion: 'overlay-in',
      elapsedMs: 0,
      content: 'the overlay',
      role: 'permission',
      theme: DARK_THEME,
      capability: off,
    });
    expect(render.frame).toEqual({ kind: 'fade', opacity: 1 });
    expect(render.opacity).toBe(1);
    expect(render.segments).toEqual([{ text: 'the overlay', role: 'permission' }]);
  });

  it('draws nothing at all when the capability is off', () => {
    let drawn = 0;
    const scheduler = new MotionScheduler({
      motion: 'overlay-in',
      capability: off,
      onFrame: () => {
        drawn += 1;
      },
    });
    scheduler.start(0);
    for (const now of [0, 33, 66, 99, 132]) {
      scheduler.tick(now);
    }
    expect(drawn).toBe(0);
  });

  it('reports the reason beside the degraded picture', () => {
    expect(off.enabled).toBe(false);
    expect(off.unsupported).toBe('the output is not an interactive terminal, so no frame can be drawn');
  });

  it('does not draw the animation of a motion that is not drawn', () => {
    const render = drawMotion({
      motion: 'overlay-in',
      elapsedMs: 0,
      content: 'the overlay',
      role: 'permission',
      theme: DARK_THEME,
      capability: off,
    });
    // A drawn fade at zero opacity would be `dim`; the degraded picture is not.
    expect(render.segments[0]?.dim).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* The renderer                                                                 */
/* -------------------------------------------------------------------------- */

describe('the renderer', () => {
  const capable = capableTerminal();

  it('draws the same picture in two places', () => {
    const direct = drawMotion({
      motion: 'overlay-in',
      elapsedMs: 99,
      content: 'the overlay',
      role: 'permission',
      theme: DARK_THEME,
      capability: capable,
    });
    const drawn = drawFrame({
      motion: 'overlay-in',
      frame: motionFrame(motionFor('overlay-in'), 99),
      content: 'the overlay',
      role: 'permission',
      theme: DARK_THEME,
      capability: capable,
    });
    expect(drawn.segments).toEqual(direct.segments);
    expect(drawn.frame).toEqual(direct.frame);
    expect(drawn.opacity).toBe(direct.opacity);
  });

  it('draws the fade as the dim style below the full opacity', () => {
    const fading = drawMotion({
      motion: 'overlay-in',
      elapsedMs: 0,
      content: 'the overlay',
      role: 'permission',
      theme: DARK_THEME,
      capability: capable,
    });
    expect(fading.segments[0]?.dim).toBe(true);
    expect(fading.opacity).toBe(0);

    const present = drawMotion({
      motion: 'overlay-in',
      elapsedMs: 240,
      content: 'the overlay',
      role: 'permission',
      theme: DARK_THEME,
      capability: capable,
    });
    expect(present.segments[0]?.dim).toBeUndefined();
    expect(present.opacity).toBe(1);
  });

  it('draws the shimmer per character, in the theme\'s own roles', () => {
    const shimmer = drawFrame({
      motion: 'prompt-shimmer',
      frame: { kind: 'shimmer', phase: 0.25 },
      content: 'abcde',
      role: 'prricode',
      theme: DARK_THEME,
      capability: capable,
    });
    expect(textOf(shimmer.segments)).toBe('abcde');
    expect(rolesOf(shimmer.segments)).toEqual([
      'prricodeShimmer',
      'prricodeShimmer',
      'prricodeShimmer',
      'prricode',
      'prricode',
    ]);
  });

  it('finds the theme\'s underscored shimmer partner too', () => {
    const shimmer = drawFrame({
      motion: 'prompt-shimmer',
      frame: { kind: 'shimmer', phase: 0.25 },
      content: 'abc',
      role: 'rainbow_red',
      theme: DARK_THEME,
      capability: capable,
    });
    expect(rolesOf(shimmer.segments)).toContain('rainbow_red_shimmer');
  });

  it('draws the blink as spaces of the same length', () => {
    const hidden = drawFrame({
      motion: 'cursor-blink',
      frame: { kind: 'blink', visible: false },
      content: 'x',
      role: 'prricode',
      theme: DARK_THEME,
      capability: capable,
    });
    expect(hidden.segments).toEqual([{ text: ' ', role: 'prricode' }]);

    const shown = drawFrame({
      motion: 'cursor-blink',
      frame: { kind: 'blink', visible: true },
      content: 'x',
      role: 'prricode',
      theme: DARK_THEME,
      capability: capable,
    });
    expect(shown.segments).toEqual([{ text: 'x', role: 'prricode' }]);
  });

  it('keeps the layout when the content is not visible', () => {
    const hidden = drawFrame({
      motion: 'cursor-blink',
      frame: { kind: 'blink', visible: false },
      content: 'abc',
      role: 'prricode',
      theme: DARK_THEME,
      capability: capable,
    });
    expect(textOf(hidden.segments)).toHaveLength(3);
  });

  it('carries the slide\'s offset for the surface to apply', () => {
    const render = drawMotion({
      motion: 'transition-in',
      elapsedMs: 0,
      content: 'the transcript',
      role: 'text',
      theme: DARK_THEME,
      capability: capable,
    });
    expect(render.offset).toBe(1);
    expect(render.segments).toEqual([{ text: 'the transcript', role: 'text' }]);
  });

  it('keeps a segment\'s own role, and fills in the ones that have none', () => {
    const render = drawMotion({
      motion: 'overlay-in',
      elapsedMs: 240,
      content: [
        { text: 'own', role: 'success' },
        { text: 'none' },
      ],
      role: 'permission',
      theme: DARK_THEME,
      capability: capable,
    });
    expect(render.segments).toEqual([
      { text: 'own', role: 'success' },
      { text: 'none', role: 'permission' },
    ]);
  });

  it('writes no colour of its own', () => {
    const render = drawMotion({
      motion: 'prompt-shimmer',
      elapsedMs: 99,
      content: 'the prompt',
      role: 'prricode',
      theme: DARK_THEME,
      capability: capable,
    });
    const written = JSON.stringify(render.segments);
    expect(written).not.toContain('rgb(');
    expect(written).not.toContain('ansi:');
  });
});

/* -------------------------------------------------------------------------- */
/* The frame budget                                                             */
/* -------------------------------------------------------------------------- */

describe('the frame budget', () => {
  const capable = capableTerminal();

  it('draws at most one frame per tick', () => {
    const drawn: number[] = [];
    const scheduler = new MotionScheduler({
      motion: 'overlay-in',
      capability: capable,
      onFrame: (_frame, index) => drawn.push(index),
    });
    scheduler.start(0);
    expect(scheduler.tick(0)).toBe(true);
    expect(scheduler.tick(0)).toBe(false);
    expect(scheduler.tick(33)).toBe(true);
    expect(drawn).toEqual([0, 1]);
  });

  it('yields to the input', () => {
    const drawn: number[] = [];
    const scheduler = new MotionScheduler({
      motion: 'overlay-in',
      capability: capable,
      onFrame: (_frame, index) => drawn.push(index),
    });
    scheduler.start(0);
    scheduler.notifyInput();
    expect(scheduler.tick(0)).toBe(false);
    expect(drawn).toEqual([]);
    // The next tick draws again — the input was waited for, not lost.
    expect(scheduler.tick(33)).toBe(true);
    expect(drawn).toEqual([1]);
  });

  it('drops the frames a slow frame missed, rather than queueing them', () => {
    const drawn: number[] = [];
    const scheduler = new MotionScheduler({
      motion: 'overlay-in',
      capability: capable,
      onFrame: (_frame, index) => drawn.push(index),
    });
    scheduler.start(0);
    scheduler.tick(0);
    // A frame that took 500 ms: the picture catches up, and the frames that
    // were missed are dropped rather than drawn one after another.
    expect(scheduler.tick(500)).toBe(true);
    expect(drawn).toEqual([0, 15]);
    expect(scheduler.tick(515)).toBe(false);
  });

  it('takes the time from the clock, so the picture does not drift', () => {
    const frames: MotionFrame[] = [];
    const scheduler = new MotionScheduler({
      motion: 'overlay-in',
      capability: capable,
      onFrame: (frame) => frames.push(frame),
    });
    scheduler.start(0);
    scheduler.tick(0);
    scheduler.tick(33);
    scheduler.tick(66);
    const motion = motionFor('overlay-in');
    expect(frames).toEqual([
      motionFrame(motion, 0),
      motionFrame(motion, 33),
      motionFrame(motion, 66),
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* The surface                                                                  */
/* -------------------------------------------------------------------------- */

describe('the motion system sits on the first layer', () => {
  it('uses the theme\'s own roles, and writes no colour of its own', () => {
    const shimmer = drawFrame({
      motion: 'prompt-shimmer',
      frame: { kind: 'shimmer', phase: 0.25 },
      content: 'ab',
      role: 'prricode',
      theme: DARK_THEME,
      capability: capableTerminal(),
    });
    const roles = rolesOf(shimmer.segments);
    for (const role of roles) {
      if (role === undefined) continue;
      expect(Object.hasOwn(DARK_THEME, role)).toBe(true);
    }
  });

  it('draws the first layer\'s own segment shape', () => {
    const render = drawMotion({
      motion: 'overlay-in',
      elapsedMs: 240,
      content: 'the overlay',
      role: 'permission',
      theme: DARK_THEME,
      capability: capableTerminal(),
    });
    const segment = render.segments[0];
    expect(segment).toBeDefined();
    if (segment === undefined) throw new Error('the segment is missing');
    expect(typeof segment.text).toBe('string');
    expect(segment.role).toBe('permission');
  });

  it('has one vocabulary, and the module exports one table of motions', () => {
    const names = Object.keys(MOTIONS);
    expect(names).toHaveLength(MOTION_NAMES.length);
    for (const name of names) {
      const named = name as MotionName;
      const motion: Motion = MOTIONS[named];
      expect(motion.name).toBe(name);
      expect(motionFor(named)).toBe(motion);
    }
  });
});

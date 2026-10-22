/**
 * The renderer — the one function that turns a motion into a picture.
 *
 * **The specification:** `docs/protocol/MOTION.md` §5.
 *
 * **One responsibility:** the picture.
 *
 * ## There is one drawer
 *
 * Every surface that draws a motion draws it **here**. That is what makes "the
 * same motion renders identically wherever it is used" a property rather than
 * a hope: there is nothing to differ. The drawer is entered in two ways, and
 * they must agree:
 *
 * - `drawMotion` — from the motion and the elapsed time;
 * - `drawFrame` — from a frame that has already been computed.
 *
 * A surface that animates asks for frames as the clock advances and draws them
 * with `drawFrame`; a surface that draws once asks `drawMotion`.
 *
 * ## It writes no colour of its own
 *
 * The output is the first layer's own `Segment[]` — a piece of text and the
 * theme **role** it is drawn in — and the styles every terminal has. The
 * theme owns the colours, and the motion system never overrides one.
 *
 * The shimmer is therefore drawn in the **theme's own roles**: the character
 * under the travelling light is drawn in the role's shimmer partner, which is
 * the theme's own `<role>Shimmer` — or `<role>_shimmer` — where it has one.
 *
 * ## The coarse form is stated
 *
 * A terminal cannot blend a colour into another one, so the fade is drawn as
 * the `dim` style below the full opacity — the idiom every terminal has. The
 * render still carries the frame's **exact** opacity, so a surface that can do
 * better may draw it finer, and the motion is not faked: the frame says what
 * the picture is.
 */

import { DARK_THEME, type Segment, type Theme } from '../theme.js';
import { motionFrame, restingFrame } from './frame.js';
import {
  contentSegments,
  motionFor,
  type Motion,
  type MotionContent,
  type MotionFrame,
  type MotionName,
} from './vocabulary.js';
import type { MotionCapability } from './capability.js';

/* -------------------------------------------------------------------------- */
/* The requests                                                                 */
/* -------------------------------------------------------------------------- */

/** What is drawn, and where the motion is in its pass. */
export interface MotionRenderRequest {
  /** The motion — named, or given. */
  readonly motion: Motion | MotionName;
  /** The time since the motion started, in milliseconds. */
  readonly elapsedMs: number;
  /** The content the motion is drawn over. */
  readonly content: MotionContent;
  /** The role of any content that does not carry one of its own. */
  readonly role?: string | undefined;
  /** The theme the roles are read from. */
  readonly theme?: Theme | undefined;
  /** The terminal's capability. */
  readonly capability: MotionCapability;
}

/** What is drawn, and the frame to draw it at. */
export interface MotionFrameRequest {
  /** The motion — named, or given. */
  readonly motion: Motion | MotionName;
  /** The frame to draw. */
  readonly frame: MotionFrame;
  /** The content the motion is drawn over. */
  readonly content: MotionContent;
  /** The role of any content that does not carry one of its own. */
  readonly role?: string | undefined;
  /** The theme the roles are read from. */
  readonly theme?: Theme | undefined;
  /** The terminal's capability. */
  readonly capability: MotionCapability;
}

/* -------------------------------------------------------------------------- */
/* The render                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One drawn frame.
 *
 * The **segments** are the picture; the rest is what the motion's frame says
 * about it, so a surface can lay it out without reading the frame again.
 */
export interface MotionRender {
  /** The motion's name. */
  readonly motion: MotionName;
  /** The frame that was drawn. */
  readonly frame: MotionFrame;
  /** The frame's opacity — 1 for every motion that does not fade. */
  readonly opacity: number;
  /** The frame's offset in whole lines — 0 for every motion that does not slide. */
  readonly offset: number;
  /** The content, styled by the frame. */
  readonly segments: Segment[];
}

/* -------------------------------------------------------------------------- */
/* The drawer                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Draw a motion at a time.
 *
 * The frame is computed from the motion and the elapsed time, and then drawn.
 */
export function drawMotion(request: MotionRenderRequest): MotionRender {
  const motion = typeof request.motion === 'string' ? motionFor(request.motion) : request.motion;
  return drawFrame({
    motion,
    frame: motionFrame(motion, request.elapsedMs),
    content: request.content,
    role: request.role,
    theme: request.theme,
    capability: request.capability,
  });
}

/**
 * Draw a frame.
 *
 * When the capability is off, the **resting** frame is drawn instead — the
 * content, with no animation at all — and the reason is in the capability's
 * own record.
 */
export function drawFrame(request: MotionFrameRequest): MotionRender {
  const motion = typeof request.motion === 'string' ? motionFor(request.motion) : request.motion;
  const theme = request.theme ?? DARK_THEME;
  const content = contentSegments(request.content, request.role);

  if (!request.capability.enabled) {
    const frame = restingFrame(motion);
    return {
      motion: motion.name,
      frame,
      opacity: frame.kind === 'fade' ? frame.opacity : 1,
      offset: frame.kind === 'slide' ? frame.offset : 0,
      segments: content,
    };
  }

  const frame = request.frame;
  return {
    motion: motion.name,
    frame,
    opacity: frame.kind === 'fade' ? frame.opacity : 1,
    offset: frame.kind === 'slide' ? frame.offset : 0,
    segments: styledSegments(frame, content, theme),
  };
}

/* -------------------------------------------------------------------------- */
/* The effects                                                                  */
/* -------------------------------------------------------------------------- */

/** The segments of a frame, styled by it. */
function styledSegments(frame: MotionFrame, segments: Segment[], theme: Theme): Segment[] {
  switch (frame.kind) {
    case 'fade':
      // The coarse form of an opacity: the terminal's own idiom for "less
      // present". The frame carries the exact value.
      return frame.opacity < 1 ? dimmed(segments) : segments;
    case 'pulse':
      return frame.brightness < 1 ? dimmed(segments) : segments;
    case 'slide':
      // The movement is a layout matter; the render carries the offset.
      return segments;
    case 'shimmer':
      return shimmered(frame.phase, segments, theme);
    case 'blink':
      return blinked(frame.visible, segments);
  }
}

/** The segments, drawn dim. */
function dimmed(segments: Segment[]): Segment[] {
  return segments.map((segment) => (segment.dim === true ? segment : { ...segment, dim: true }));
}

/**
 * The segments, with the text replaced by spaces when they are not visible.
 *
 * The spaces are the **same length** as the text, so the layout holds and the
 * cursor is simply not there.
 */
function blinked(visible: boolean, segments: Segment[]): Segment[] {
  if (visible) return segments;
  return segments.map((segment) => ({
    ...segment,
    text: ' '.repeat([...segment.text].length),
  }));
}

/* -------------------------------------------------------------------------- */
/* The shimmer                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The segments, with the travelling light drawn across them.
 *
 * The light is **per character**, so it travels across the content rather than
 * switching the whole run at once:
 *
 * - the characters are counted **across the whole content**, not per segment;
 * - the light's width is `max(2, ceil(n / 2))` characters;
 * - the light's head runs from before the content to after it;
 * - a character under the light is drawn in its role's **shimmer partner**.
 */
function shimmered(phase: number, segments: Segment[], theme: Theme): Segment[] {
  const characters = segments.flatMap((segment) => [...segment.text].map((c) => ({ segment, c })));
  const n = characters.length;
  if (n === 0) return segments;

  const width = Math.max(2, Math.ceil(n / 2));
  const head = -width + phase * (n + 2 * width);

  const drawn: Segment[] = [];
  let index = 0;
  for (const { segment, c } of characters) {
    const distance = Math.min(1, Math.max(0, 1 - Math.abs(index - head) / width));
    const partner = shimmerPartner(segment.role, theme);
    const lit = distance > 0 && partner !== undefined && partner !== segment.role;
    drawn.push(lit ? { ...segment, text: c, role: partner } : { ...segment, text: c });
    index += 1;
  }
  return drawn;
}

/**
 * The role a lit character is drawn in.
 *
 * The theme's own partner, where it has one:
 *
 * 1. `<role>Shimmer` — the camel-cased partner, as in `prricodeShimmer`;
 * 2. otherwise `<role>_shimmer` — the underscored partner, as in
 *    `rainbow_red_shimmer`;
 * 3. otherwise the theme's `text` role.
 *
 * A segment with no role has no partner: there is nothing to draw it in.
 */
function shimmerPartner(role: string | undefined, theme: Theme): string | undefined {
  if (role === undefined) return undefined;
  const camel = `${role}Shimmer`;
  if (Object.hasOwn(theme, camel)) return camel;
  const underscored = `${role}_shimmer`;
  if (Object.hasOwn(theme, underscored)) return underscored;
  return 'text';
}

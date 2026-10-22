/**
 * The **prompt's shimmer** — the travelling light on the composer's rule.
 *
 * **The milestone:** `CC-048` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **One responsibility:** the rule, and the light that travels across it.
 *
 * ## Why the rule
 *
 * The theme owns a **shimmer partner** for the `promptBorder` role — the
 * theme's own `promptBorderShimmer` — and the composer's rule is drawn in
 * `promptBorder`. So the rule is what the shimmer is drawn over: the light
 * travels across it, and the characters it touches are drawn in the theme's
 * own partner role.
 *
 * The motion system writes no colour of its own, and neither does this
 * module: the picture is the theme's `promptBorder` and the theme's
 * `promptBorderShimmer`, and nothing else.
 *
 * ## The rule is the composer's own
 *
 * The rule is a row of the rule character in the `promptBorder` role, and the
 * app draws it in the place Ink's border used to be. The characters are the
 * same ones the border drew — the rule character, as many of them as the
 * terminal is wide — so the picture the user sees does not change; what
 * changes is that the light can travel across it.
 */

import { DARK_THEME, type Segment, type Theme } from '../theme.js';
import { drawMotion } from '../motion/render.js';
import type { MotionCapability } from '../motion/capability.js';

import { rowOf } from './frame.js';
import type { SurfaceFrame } from './surface.js';

/* -------------------------------------------------------------------------- */
/* The rule                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The character the composer's rule is drawn with.
 *
 * The target's own rule character — the first layer's `glyphs().rule`.
 */
export const PROMPT_RULE_CHARACTER = '─';

/**
 * The composer's rule.
 *
 * As many rule characters as the terminal is wide, in the `promptBorder`
 * role. A width of nothing is no rule at all.
 */
export function promptRuleSegments(columns: number): Segment[] {
  const width = Math.max(0, Math.floor(columns));
  if (width === 0) return [];
  return [{ text: PROMPT_RULE_CHARACTER.repeat(width), role: 'promptBorder' }];
}

/* -------------------------------------------------------------------------- */
/* The frame                                                                   */
/* -------------------------------------------------------------------------- */

/** What the prompt's frame is drawn from. */
export interface PromptFrameRequest {
  /** How many columns the rule spans. */
  readonly columns: number;
  /** The time since the shimmer started, in milliseconds. */
  readonly elapsedMs: number;
  /** The terminal's capability. */
  readonly capability: MotionCapability;
  /** The theme the roles are read from. */
  readonly theme?: Theme | undefined;
}

/**
 * The prompt's frame.
 *
 * The shimmer is the `prompt-shimmer` motion — the system's own, with its own
 * easing, its own duration and its own frame budget. Nothing here chooses a
 * curve or a length.
 */
export function renderPromptFrame(request: PromptFrameRequest): SurfaceFrame {
  const theme = request.theme ?? DARK_THEME;
  const render = drawMotion({
    motion: 'prompt-shimmer',
    elapsedMs: request.elapsedMs,
    content: promptRuleSegments(request.columns),
    theme,
    capability: request.capability,
  });

  return {
    rows: [rowOf(render.segments)],
    motion: render.motion,
    frame: render.frame,
    opacity: render.opacity,
    offset: render.offset,
    unsupported: request.capability.enabled ? null : request.capability.unsupported,
  };
}

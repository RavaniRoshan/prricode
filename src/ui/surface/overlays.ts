/**
 * The **overlays** — their entrance and their exit.
 *
 * **The milestone:** `CC-048` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **One responsibility:** the overlay's rows, and the fade that carries them
 * in and out.
 *
 * ## The two halves of one fade
 *
 * An overlay arrives with the `overlay-in` motion and leaves with the
 * `overlay-out` motion. They are the system's own pair, with the system's own
 * duration and easing, and the direction is in the table: `overlay-in` fades
 * in and `overlay-out` fades out.
 *
 * **The resting frame is not the end of a pass.** An overlay that is not
 * drawn is not an overlay that has gone: its resting frame is fully present,
 * so a terminal that cannot draw a frame shows the overlay itself.
 *
 * ## The overlays the surface draws
 *
 * - the **approval dialog** — the first layer's own parts, laid out as rows;
 * - the **autocomplete overlay** — the first layer's own rows, with the
 *   pointer in front of the focused one.
 *
 * Both are built from the first layer's own renderers, so the overlay and
 * the first layer's dialog cannot drift apart.
 */

import { DARK_THEME, type Theme } from '../theme.js';
import { drawMotion } from '../motion/render.js';
import type { MotionCapability } from '../motion/capability.js';
import type { MotionName } from '../motion/vocabulary.js';

import { optionSegments, type ApprovalPromptParts } from '../render/prompts.js';
import { renderAutocompleteSuggestion, type AutocompleteSuggestion } from '../render/prompts.js';

import { rowOf, type FrameRow } from './frame.js';
import type { SurfaceFrame } from './surface.js';

/* -------------------------------------------------------------------------- */
/* The rows                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The approval dialog's rows, **grouped** as the dialog lays them out.
 *
 * The groups are: the title, the question, the reason (when there is one),
 * a group for each choice, and the guide. The grouping is what lets a
 * surface lay the dialog out with its own chrome — a border and a padding —
 * and still fade the whole of it as one thing.
 */
export function approvalOverlayGroups(parts: ApprovalPromptParts): FrameRow[][] {
  const groups: FrameRow[][] = [];

  groups.push([rowOf([{ text: parts.title, role: 'permission', bold: true }])]);
  groups.push([rowOf([{ text: parts.question }])]);
  if (parts.reason !== '') groups.push([rowOf([{ text: parts.reason, dim: true }])]);

  for (const choice of parts.choices) {
    groups.push([rowOf(optionSegments(choice))]);
  }

  groups.push([rowOf([{ text: parts.guide, dim: true, italic: true }])]);

  return groups;
}

/**
 * The approval dialog's rows.
 *
 * The dialog's **own** parts — the title, the question, the reason, the
 * choices and the guide — in the order the first layer draws them.
 */
export function approvalOverlayRows(parts: ApprovalPromptParts): FrameRow[] {
  return approvalOverlayGroups(parts).flat();
}

/**
 * The autocomplete overlay's rows.
 *
 * The first layer's own row renderer, with the pointer in front of the
 * focused one.
 */
export function autocompleteOverlayRows(
  suggestions: readonly AutocompleteSuggestion[],
  focused = 0,
): FrameRow[] {
  return suggestions.map((suggestion, index) =>
    rowOf([{ text: renderAutocompleteSuggestion(suggestion, index === focused) }]),
  );
}

/* -------------------------------------------------------------------------- */
/* The frame                                                                   */
/* -------------------------------------------------------------------------- */

/** What the overlay's frame is drawn from. */
export interface OverlayFrameRequest {
  /** The overlay's own rows. */
  readonly rows: readonly FrameRow[];
  /** The time since the overlay arrived or left, in milliseconds. */
  readonly elapsedMs: number;
  /** The terminal's capability. */
  readonly capability: MotionCapability;
  /** The theme the roles are read from. */
  readonly theme?: Theme | undefined;
  /** The motion — the entrance by default. */
  readonly motion?: MotionName | undefined;
}

/**
 * The overlay's frame.
 *
 * Every row of the overlay fades together: the overlay is **one** thing, and
 * it arrives and leaves as one thing.
 */
export function renderOverlayFrame(request: OverlayFrameRequest): SurfaceFrame {
  const theme = request.theme ?? DARK_THEME;
  const motion = request.motion ?? 'overlay-in';

  const rendered = request.rows.map((row) =>
    drawMotion({
      motion,
      elapsedMs: request.elapsedMs,
      content: row.segments,
      theme,
      capability: request.capability,
    }),
  );

  const rows: FrameRow[] = rendered.map((render, index) => {
    const row = request.rows[index];
    return row === undefined ? { segments: render.segments } : { ...row, segments: render.segments };
  });

  const head =
    rendered[0] ??
    drawMotion({ motion, elapsedMs: request.elapsedMs, content: '', theme, capability: request.capability });

  return {
    rows,
    motion: head.motion,
    frame: head.frame,
    opacity: head.opacity,
    offset: head.offset,
    unsupported: request.capability.enabled ? null : request.capability.unsupported,
  };
}

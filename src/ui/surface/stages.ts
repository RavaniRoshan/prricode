/**
 * The **stage advance** — the pipeline's stage changing, as it happens.
 *
 * **The milestone:** `CC-048` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **One responsibility:** the advance, and the picture of it.
 *
 * ## Where the advance comes from
 *
 * The pipeline's stages advance over the protocol: an `event/stage`
 * notification carrying the stage's id, the stage's state, and — when the
 * stage is not proceeding — the shared shape's pair, `enabled` and
 * `unsupported`.
 *
 * So the surface reads the **notification's own parameters**, and it reads
 * them defensively: the parameters come off the wire, and a notification that
 * carries no stage is **refused** rather than drawn as an empty line.
 *
 * ## The advance is drawn as it happens
 *
 * The `stage-advance` motion is the system's own: a pulse from half
 * brightness to full, over the system's own duration. The stage's row is
 * drawn in the theme's roles, and a stage that did not proceed carries its
 * reason — in the theme's own `error` role, because that is what the theme
 * has for it.
 */

import { DARK_THEME, type Theme } from '../theme.js';
import { drawMotion } from '../motion/render.js';
import type { MotionCapability } from '../motion/capability.js';
import type { Segment } from '../theme.js';
import type { StageState } from '../../pipeline/stage.js';

import { rowOf } from './frame.js';
import type { SurfaceFrame } from './surface.js';

/* -------------------------------------------------------------------------- */
/* The advance                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The advance of one stage.
 *
 * The shape is the notification's own: the stage's id, the stage's state, and
 * the shared pair when the stage is not proceeding.
 */
export interface StageAdvance {
  /** The stage that advanced. */
  readonly stageId: string;
  /** The state the stage is in. */
  readonly state: StageState;
  /** Whether the stage is proceeding. */
  readonly enabled: boolean;
  /** The reason it is not proceeding, when it is not. */
  readonly unsupported: string | null;
}

/**
 * The stage's states.
 *
 * The pipeline's own vocabulary — the same five the report uses — and nothing
 * else. A state that is not one of them is not a state.
 */
const STAGE_STATES: ReadonlySet<string> = new Set<string>([
  'pending',
  'running',
  'completed',
  'refused',
  'not-reached',
]);

/**
 * Read the advance out of the notification's parameters.
 *
 * The parameters come off the wire, so the read is defensive: a notification
 * with no stage in it names nothing, and this returns `null` rather than
 * drawing an empty stage.
 */
export function stageAdvanceFromParams(params: Record<string, unknown>): StageAdvance | null {
  if (!Object.hasOwn(params, 'stageId')) return null;
  const stageId = params['stageId'];
  if (typeof stageId !== 'string' || stageId === '') return null;

  const state = params['state'];
  const unsupported = params['unsupported'];

  return {
    stageId,
    state: typeof state === 'string' && STAGE_STATES.has(state) ? (state as StageState) : 'pending',
    enabled: params['enabled'] === true,
    unsupported: typeof unsupported === 'string' && unsupported !== '' ? unsupported : null,
  };
}

/**
 * What the stage's row says.
 *
 * The stage's id and its state, and — when the stage did not proceed — the
 * reason it did not.
 */
export function stageAdvanceSegments(advance: StageAdvance): Segment[] {
  const segments: Segment[] = [
    { text: advance.stageId, role: 'prricode' },
    { text: ': ' },
    { text: advance.state, role: 'text' },
  ];
  if (advance.unsupported !== null) {
    segments.push({ text: ' — ' });
    segments.push({ text: advance.unsupported, role: 'error' });
  }
  return segments;
}

/* -------------------------------------------------------------------------- */
/* The frame                                                                   */
/* -------------------------------------------------------------------------- */

/** What the stage's frame is drawn from. */
export interface StageFrameRequest {
  /** The advance the frame draws. */
  readonly advance: StageAdvance;
  /** The time since the advance arrived, in milliseconds. */
  readonly elapsedMs: number;
  /** The terminal's capability. */
  readonly capability: MotionCapability;
  /** The theme the roles are read from. */
  readonly theme?: Theme | undefined;
}

/**
 * The stage's frame.
 *
 * The pulse is the `stage-advance` motion — the system's own — and the
 * stage's row is drawn in the theme's roles whatever the pulse is doing.
 */
export function renderStageFrame(request: StageFrameRequest): SurfaceFrame {
  const theme = request.theme ?? DARK_THEME;

  const render = drawMotion({
    motion: 'stage-advance',
    elapsedMs: request.elapsedMs,
    content: stageAdvanceSegments(request.advance),
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

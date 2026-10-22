/**
 * The motion system — the second layer's shared motion.
 *
 * **The specification:** `docs/protocol/MOTION.md`.
 *
 * **The conformance document:**
 * [`docs/compatibility/motion-surface.md`](../../docs/compatibility/motion-surface.md).
 *
 * ## What this layer is
 *
 * **One vocabulary, used everywhere.** The prompt, the transitions between the
 * agent's states, the pipeline's stage changes and the overlays all animate
 * through the same seven named motions, with the same easings, the same
 * durations and the same frame budget.
 *
 * The four rules it keeps:
 *
 * - **One vocabulary.** There is one table of motions, one table of easings and
 *   one table of durations. A surface asks for a motion by name.
 * - **What cannot be drawn is not drawn.** The terminal's capability is
 *   detected once; a terminal that cannot draw a frame gets the motion's
 *   **resting** picture and the reason, in the shared capability shape.
 * - **Motion never blocks the input.** A tick that finds an input waiting
 *   draws nothing, and a slow frame drops the frames it missed rather than
 *   queueing them.
 * - **The motion is deterministic.** A frame is a function of the motion and
 *   the time alone, so a frame can be asserted on and a golden can be
 *   recorded.
 *
 * ## Where it sits
 *
 * On the first layer's terminal surface: the theme's own roles and the first
 * layer's own segment shape. The motion system **writes no colour of its own**
 * and changes nothing under `src/ui/render/` or `src/ui/app.ts`.
 *
 * **The naming rule applies.** The layer names the capability — a motion — and
 * no product and no company.
 */

export {
  DURATIONS,
  MOTIONS,
  MOTION_NAMES,
  contentSegments,
  motionFor,
  type BlinkFrame,
  type DurationName,
  type EasingName,
  type FadeFrame,
  type Motion,
  type MotionContent,
  type MotionFrame,
  type MotionKind,
  type MotionName,
  type PulseFrame,
  type ShimmerFrame,
  type SlideFrame,
} from './vocabulary.js';

export { EASINGS, ease } from './easing.js';

export {
  MOTION_FRAME_INTERVAL_MS,
  MOTION_FRAME_RATE,
  frameIndexAt,
  motionFrame,
  restingFrame,
} from './frame.js';

export {
  MotionCapabilityProvider,
  REASON_NOT_INTERACTIVE,
  REASON_REDUCED_MOTION,
  configureMotionCapability,
  detectMotionCapability,
  motionCapability,
  type MotionCapability,
  type MotionCapabilityInput,
} from './capability.js';

export {
  drawFrame,
  drawMotion,
  type MotionFrameRequest,
  type MotionRender,
  type MotionRenderRequest,
} from './render.js';

export { MotionScheduler, type MotionSchedulerOptions } from './schedule.js';

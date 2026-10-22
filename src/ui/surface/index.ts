/**
 * The **motion surface** — the barrel.
 *
 * **The milestone:** `CC-048` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The specification:** `docs/protocol/MOTION.md` — the system this layer
 * sits on.
 *
 * ## What the layer is
 *
 * The shared motion system knows **how** to draw a motion. This layer knows
 * **what** a motion is drawn over: the prompt's rule, the agent's states, the
 * pipeline's stage advance and the overlays.
 *
 * The two halves are kept apart on purpose. The motion system is the
 * system's, and it is not changed here; the surface is the second layer's,
 * and it changes nothing under `src/ui/render/` or under the motion system.
 *
 * ## The naming rule applies
 *
 * The layer names the things it draws — a prompt, a state, a stage, an
 * overlay — and no product and no company.
 */

export {
  frameOf,
  frameText,
  renderPicture,
  rowOf,
  type FrameRow,
  type TerminalFrame,
} from './frame.js';

export type { MotionCapability } from '../motion/capability.js';
export type { MotionFrame, MotionName } from '../motion/vocabulary.js';

export {
  REASON_CANNOT_DRAW,
  type SurfaceFrame,
} from './surface.js';

export {
  PROMPT_RULE_CHARACTER,
  promptRuleSegments,
  renderPromptFrame,
  type PromptFrameRequest,
} from './prompt.js';

export {
  AGENT_STATES,
  agentStateFor,
  renderStateFrame,
  stateLabel,
  stateRole,
  type AgentState,
  type StateChange,
  type StateFrameRequest,
} from './states.js';

export {
  renderStageFrame,
  stageAdvanceFromParams,
  stageAdvanceSegments,
  type StageAdvance,
  type StageFrameRequest,
} from './stages.js';

export {
  approvalOverlayGroups,
  approvalOverlayRows,
  autocompleteOverlayRows,
  renderOverlayFrame,
  type OverlayFrameRequest,
} from './overlays.js';

export {
  motionReasonRow,
  renderMotionSurface,
  type MotionSurfaceRequest,
} from './motionSurface.js';

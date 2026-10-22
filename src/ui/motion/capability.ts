/**
 * The terminal's capability — detected once, and the reason when it is off.
 *
 * **The specification:** `docs/protocol/MOTION.md` §4.
 *
 * **One responsibility:** what the terminal can draw, and the shared record
 * that says so.
 *
 * ## The shape is the shared one
 *
 * The record is the one `src/protocol/capability.ts` builds and
 * `docs/protocol/PROTOCOL.md` §6 states — `enabled`, and when not, the reason
 * — with the motion capability's own fields beneath the shared pair. **There
 * is no second shape**, and this module does not invent one.
 *
 * ## Detected once
 *
 * The terminal's capabilities do not change while the program runs, so they are
 * detected **once** and the record is kept. `MotionCapabilityProvider` is that
 * cache, and the process-wide `motionCapability()` is one of them.
 *
 * ## What is detected
 *
 * - **interactive** — the output is a terminal, and `TERM` is not `dumb`. A
 *   terminal that says `dumb` cannot draw a frame, whatever it says about
 *   being a terminal.
 * - **reduced motion** — the user asked for reduced motion. The setting is the
 *   first layer's own `prefersReducedMotion` — "Reduce or disable animations
 *   for accessibility" — and it is the user's, not the terminal's, so it is an
 *   input to the detection rather than something read from the environment.
 *
 * ## The reasons
 *
 * The user's own reason comes first: it is the one they can act on. The
 * reasons are sentences that name what is missing, exactly as the protocol's
 * contract says — never empty, never a placeholder, never a success.
 */

import { capabilityRecord, type CapabilityRecord } from '../../protocol/capability.js';

/* -------------------------------------------------------------------------- */
/* The record                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The terminal's motion capability.
 *
 * The shared pair is `enabled` and `unsupported`; the motion capability's own
 * fields sit beneath it.
 */
export interface MotionCapability extends CapabilityRecord {
  /** Whether a frame can be drawn at all. */
  readonly enabled: boolean;
  /** The reason it cannot, or `null` when it can. */
  readonly unsupported: string | null;
  /** Whether the output is a terminal that can draw. */
  readonly interactive: boolean;
  /** Whether the user asked for reduced motion. */
  readonly reducedMotion: boolean;
}

/** What the detection reads. */
export interface MotionCapabilityInput {
  /** The environment to read `TERM` from. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Whether the output is a terminal — the caller knows; the default asks the process. */
  readonly interactive?: boolean | undefined;
  /** Whether the user asked for reduced motion. */
  readonly reducedMotion?: boolean | undefined;
}

/* -------------------------------------------------------------------------- */
/* The reasons                                                                  */
/* -------------------------------------------------------------------------- */

/** The reason a terminal that cannot draw gives. */
export const REASON_NOT_INTERACTIVE =
  'the output is not an interactive terminal, so no frame can be drawn';

/** The reason the user's own preference gives. */
export const REASON_REDUCED_MOTION = 'the user asked for reduced motion, so no animation is drawn';

/* -------------------------------------------------------------------------- */
/* The detection                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Build the record.
 *
 * The pair is built by the protocol's own `capabilityRecord`, so a record that
 * breaks the contract — an enabled capability with a reason, or a capability
 * that cannot run without one — cannot be built at all.
 */
function motionCapabilityRecord(
  enabled: boolean,
  unsupported: string | null,
  interactive: boolean,
  reducedMotion: boolean,
): MotionCapability {
  const record = capabilityRecord(enabled, unsupported, { interactive, reducedMotion });
  return {
    ...record,
    enabled: record.enabled,
    unsupported: record.unsupported,
    interactive,
    reducedMotion,
  };
}

/**
 * Detect what the terminal can do.
 *
 * The detection is a **pure function** of what the terminal says about itself,
 * so it can be asked about any terminal — a test asks about one it made up.
 */
export function detectMotionCapability(
  input: MotionCapabilityInput = {},
): MotionCapability {
  const env = input.env ?? process.env;
  const reducedMotion = input.reducedMotion === true;
  const term = env['TERM'];
  const dumb = term === 'dumb';
  const interactive = input.interactive ?? process.stdout.isTTY === true;
  const canDraw = interactive && !dumb;

  // The user's own reason comes first: it is the one they can act on.
  if (reducedMotion) {
    return motionCapabilityRecord(false, REASON_REDUCED_MOTION, canDraw, true);
  }
  if (!canDraw) {
    return motionCapabilityRecord(false, REASON_NOT_INTERACTIVE, false, false);
  }
  return motionCapabilityRecord(true, null, true, false);
}

/* -------------------------------------------------------------------------- */
/* The provider                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A capability that is detected **once** and then kept.
 *
 * The detection is not repeated: the terminal's capabilities do not change
 * while the program runs, and a capability that were re-detected per frame
 * would be a per-frame cost for a fact that never changes.
 */
export class MotionCapabilityProvider {
  private readonly detect: (input: MotionCapabilityInput) => MotionCapability;
  private detected: MotionCapability | undefined;

  /**
   * Build a provider.
   *
   * The detection may be supplied — a test counts how many times it runs.
   */
  constructor(
    detect: (input: MotionCapabilityInput) => MotionCapability = detectMotionCapability,
  ) {
    this.detect = detect;
  }

  /** The capability — detected on the first call, and the same one after that. */
  capability(): MotionCapability {
    if (this.detected === undefined) this.detected = this.detect({});
    return this.detected;
  }
}

/* -------------------------------------------------------------------------- */
/* The process-wide capability                                                   */
/* -------------------------------------------------------------------------- */

/** The input the process-wide capability is detected from. */
let configuredInput: MotionCapabilityInput = {};

/** The provider the process-wide capability is detected by. */
let provider: MotionCapabilityProvider | undefined;

/**
 * Say what the process-wide capability should be detected from.
 *
 * The caller supplies what it knows — the environment it runs in, whether the
 * output is a terminal, and the user's reduced-motion preference — and the
 * capability is detected from it **once**.
 *
 * This is called before the first frame is drawn. Calling it again re-detects,
 * which is deliberate: a caller that changes the answer wants a new answer.
 */
export function configureMotionCapability(input: MotionCapabilityInput): void {
  configuredInput = input;
  provider = undefined;
}

/**
 * The process-wide capability.
 *
 * The same record every time it is asked for, and detected on the first ask.
 */
export function motionCapability(): MotionCapability {
  if (provider === undefined) {
    provider = new MotionCapabilityProvider(() => detectMotionCapability(configuredInput));
  }
  return provider.capability();
}

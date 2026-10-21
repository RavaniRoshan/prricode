/**
 * The **cross-session inbound gate**.
 *
 * Evidence: the target's own source, read out of the pinned build and recorded
 * in `/home/shiva/opt/reference-agent-rea/analysis/findings-agent-teams.md`.
 * The gate itself is one module in the target — `chunk-v01p0e5r.js` — and every
 * rule below is read out of it:
 *
 *   - `:1146` — the attribution and the hold causes; `:1377` — the strictness
 *     order `{accept:0, hold:1, refuse:2}`, the hold capacity `100` and the
 *     known-mode set; `:2206` — the shutdown drain.
 *   - `:2941` — the resolution order and the repository-tightening rule;
 *     `:3487` — the invalid-value probe; `:3582` — the value-to-policy map;
 *     `:3750` — the kill switch.
 *   - `:3816` — the default gate; `:4277` — the mode-parity gate;
 *     `:4787` and `:4884` — the permission-mode classes.
 *   - `:5523` — the ingress guard; `:5798` — the decision and the hold buffer;
 *     `:6797` and `:7283` — the origin kinds and the dispatch;
 *     `:8323` — the release; `:9389` — the approval.
 *   - `chunk-c9s0jh80.js:236597` — the three values; `:322225` — the setting;
 *     `:427318` — the managed-settings normalisation of an unrecognised value.
 *   - `chunk-n7hxtqpf.js:1358` — the six permission modes.
 *   - `chunk-fvj2e8y8.js` — the envelope's own fields and the message tag.
 *
 * **The honest boundary.** The **gate** is implemented: the resolution order,
 * the tightening rule, the invalid-value rule, the mode-parity rule, the hold
 * causes, the buffer and the receipts are the target's own. The **transport**
 * is not: there is no cross-session transport here — no socket, no bridge, no
 * peer — so the operation that would carry a message to the receiving session
 * **refuses**, and the refusal names the capability it needed.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **class** is this implementation's own; the target's own state lives
 *     in a context object.
 *   - The **receipt** a release reports means "the gate released it", which is
 *     the target's own sense of the word: the target's log reads "held peer
 *     message APPROVED — released to queue".
 */

/* -------------------------------------------------------------------------- */
/* The setting                                                                 */
/* -------------------------------------------------------------------------- */
/** The three values the setting takes. */
export const CROSS_SESSION_INBOUND_VALUES = ['accept', 'hold', 'refuse'] as const;

/** One of the three values. */
export type CrossSessionInboundSetting = (typeof CROSS_SESSION_INBOUND_VALUES)[number];

/**
 * The strictness order.
 *
 * The repository tiers may only **tighten**, so the order is `accept` (the
 * loosest) → `hold` → `refuse` (the strictest).
 */
const STRICTNESS: Readonly<Record<CrossSessionInboundSetting, number>> = {
  accept: 0,
  hold: 1,
  refuse: 2,
};

/**
 * The settings sources the resolution reads.
 *
 * The target reads the **enabled** sources only, so a caller supplies the
 * enabled ones.
 */
export interface CrossSessionInboundSources {
  /** The machine policy's settings. */
  policySettings?: unknown;
  /** The feature flags' settings. */
  flagSettings?: unknown;
  /** The user's settings. */
  userSettings?: unknown;
  /** The project's settings. */
  projectSettings?: unknown;
  /** The local settings. */
  localSettings?: unknown;
}

/**
 * Which source decided the setting.
 */
export type CrossSessionDecidedBy =
  | 'policySettings'
  | 'flagSettings'
  | 'userSettings'
  | 'repoSettings'
  | 'invalidSetting'
  | undefined;

/**
 * The resolved setting.
 */
export interface CrossSessionResolution {
  /** The value, when one was resolved. */
  value: CrossSessionInboundSetting | undefined;
  /** Which source decided it. */
  decidedBy: CrossSessionDecidedBy;
  /** Whether a settings file carried a value the target does not recognise. */
  invalidValue: boolean;
}

/**
 * Whether a value is one of the three.
 */
function isCrossSessionValue(value: unknown): value is CrossSessionInboundSetting {
  return (
    typeof value === 'string' &&
    (CROSS_SESSION_INBOUND_VALUES as readonly string[]).includes(value)
  );
}

/**
 * The value a source contributes, and whether the source carried an
 * unrecognised one.
 *
 * The target normalises **per source** before the merge: an unrecognised value
 * in a **policy** source becomes `refuse` — the most restrictive reading — and
 * anywhere else the key is **dropped**. Either way the source reports a
 * warning, and that warning is what turns an unset value into `hold`.
 */
function normalizeSource(
  value: unknown,
  isPolicySource: boolean,
): { value: CrossSessionInboundSetting | undefined; invalid: boolean } {
  if (value === undefined || value === null) return { value: undefined, invalid: false };
  if (isCrossSessionValue(value)) return { value, invalid: false };
  return { value: isPolicySource ? 'refuse' : undefined, invalid: true };
}

/**
 * Resolve the setting.
 *
 * The target's own order:
 *
 *   1. the **top-level** sources — `policySettings`, `flagSettings`,
 *      `userSettings`, highest first — and the first one that defines the key
 *      wins outright;
 *   2. the **repository** sources — `localSettings`, `projectSettings` — may
 *      only **tighten**: a repository value replaces the resolved one only when
 *      it is stricter, and an equal value only changes the attribution;
 *   3. an unrecognised value anywhere leaves the resolved value at `accept`
 *      (or unset), and the invalid-value probe turns it into `hold`.
 */
export function resolveCrossSessionInbound(
  sources: CrossSessionInboundSources,
): CrossSessionResolution {
  const policy = normalizeSource(sources.policySettings, true);
  const flag = normalizeSource(sources.flagSettings, false);
  const user = normalizeSource(sources.userSettings, false);
  const local = normalizeSource(sources.localSettings, false);
  const project = normalizeSource(sources.projectSettings, false);

  const invalidValue =
    policy.invalid || flag.invalid || user.invalid || local.invalid || project.invalid;

  let value: CrossSessionInboundSetting | undefined;
  let decidedBy: CrossSessionDecidedBy;

  for (const [source, normalized] of [
    ['policySettings', policy],
    ['flagSettings', flag],
    ['userSettings', user],
  ] as const) {
    if (normalized.value === undefined) continue;
    value = normalized.value;
    decidedBy = source;
    break;
  }

  for (const normalized of [local, project]) {
    if (normalized.value === undefined) continue;
    const candidate = normalized.value;
    const current = value ?? 'accept';
    if (STRICTNESS[candidate] > STRICTNESS[current]) {
      value = candidate;
      decidedBy = 'repoSettings';
    } else if (
      candidate !== 'accept' &&
      value !== undefined &&
      STRICTNESS[candidate] === STRICTNESS[current] &&
      decidedBy !== 'policySettings'
    ) {
      decidedBy = 'repoSettings';
    }
  }

  if (STRICTNESS[value ?? 'accept'] < STRICTNESS.hold && invalidValue) {
    value = 'hold';
    decidedBy = 'invalidSetting';
  }

  return { value, decidedBy, invalidValue };
}

/* -------------------------------------------------------------------------- */
/* The policy                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The two permission-mode classes.
 *
 * A sender and a receiver are in the same class when both bypass prompts, or
 * both prompt.
 */
export type CrossSessionPermissionClass = 'bypass' | 'prompting';

/**
 * The six permission modes the target knows.
 */
export const CROSS_SESSION_PERMISSION_MODES: readonly string[] = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
];

/**
 * The receiving session's permission mode.
 */
export interface CrossSessionMode {
  /** The mode itself. */
  mode: string;
  /** Whether bypass permissions is available in this session. */
  isBypassPermissionsModeAvailable?: boolean;
  /** Whether the session is interactive. */
  interactive?: boolean;
}

/**
 * Whether a mode is one the target knows.
 */
export function isKnownPermissionMode(mode: string): boolean {
  return CROSS_SESSION_PERMISSION_MODES.includes(mode);
}

/**
 * The class a permission mode belongs to.
 *
 * A session is in the **bypass** class when its mode is `bypassPermissions`,
 * or when it is in plan mode in a session where bypass permissions is
 * available and the session is interactive.
 */
export function permissionModeClass(mode: CrossSessionMode): CrossSessionPermissionClass {
  if (mode.mode === 'bypassPermissions') return 'bypass';
  if (
    mode.mode === 'plan' &&
    mode.isBypassPermissionsModeAvailable === true &&
    mode.interactive === true
  ) {
    return 'bypass';
  }
  return 'prompting';
}

/**
 * The eight causes a message can be held for.
 *
 * The first four name **where the setting came from**; the last four name
 * **why the gate could not decide**.
 */
export type CrossSessionHoldCause =
  | 'managed-setting'
  | 'repo-setting'
  | 'invalid-setting'
  | 'explicit-setting'
  | 'mode-unknown'
  | 'bypass-default'
  | 'mode-mismatch'
  | 'no-mode-asserted';

/**
 * The two causes a message can be refused for.
 */
export type CrossSessionRefuseCause = 'opt-out' | 'kill-switch';

/**
 * The gate's decision.
 */
export type CrossSessionPolicy =
  | { policy: 'accept' }
  | { policy: 'hold'; holdCause: CrossSessionHoldCause }
  | { policy: 'refuse'; refuseCause: CrossSessionRefuseCause };

/**
 * The cause the attribution implies.
 */
function holdCauseFor(decidedBy: CrossSessionDecidedBy): CrossSessionHoldCause {
  switch (decidedBy) {
    case 'policySettings':
      return 'managed-setting';
    case 'repoSettings':
      return 'repo-setting';
    case 'invalidSetting':
      return 'invalid-setting';
    default:
      return 'explicit-setting';
  }
}

/* -------------------------------------------------------------------------- */
/* The messages                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Where an inbound message came from.
 */
export interface CrossSessionOrigin {
  /** The origin's kind. */
  kind: 'peer' | 'task-notification' | 'other';
  /** Whether the host injected the message rather than a peer sending it. */
  hostInjected?: boolean;
  /** The sub-kind, for a task notification. */
  subkind?: string;
  /** The class the sending session asserted. */
  fromMode?: CrossSessionPermissionClass;
  /** Whether the sending session is this session. */
  selfSent?: boolean;
}

/**
 * One inbound message.
 */
export interface HeldMessage {
  /** The message's identifier. */
  id: string;
  /** Where it came from. */
  origin?: CrossSessionOrigin;
}

/**
 * The receipts the gate sends back.
 */
export type CrossSessionReceipt =
  | 'delivered'
  | 'held'
  | 'refused'
  | 'expired'
  | 'denied'
  | 'dropped';

/**
 * The capacity of the hold buffer.
 *
 * The target's own number: a hundred parked messages. The hundred-and-first
 * evicts the oldest, which is settled as `expired`.
 */
export const CROSS_SESSION_HOLD_CAPACITY = 100;

/* -------------------------------------------------------------------------- */
/* The gate                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The gate's own dependencies.
 */
export interface CrossSessionInboundOptions {
  /** The settings sources. */
  sources?: CrossSessionInboundSources;
  /** Whether the cross-session messaging kill switch is on. */
  killSwitch?: boolean;
  /** The receiving session's permission mode. */
  mode?: CrossSessionMode;
  /** The capacity of the hold buffer. */
  capacity?: number;
  /** The receipt sink. */
  sendReceipt?: (message: HeldMessage, receipt: CrossSessionReceipt) => void;
  /** Called when a message is parked. */
  onHeld?: (message: HeldMessage, count: number, cause: CrossSessionHoldCause) => void;
  /** Called when a parked message is dropped. */
  onHoldDropped?: (message: HeldMessage, receipt: CrossSessionReceipt) => void;
  /** Called when parked messages are released. */
  onHoldReleased?: (messages: readonly HeldMessage[], reason: string) => void;
  /**
   * The ingress guard.
   *
   * A message the guard drops is not delivered. The target runs every inbound
   * message through this guard; without one, every message is admitted.
   */
  guard?: (message: HeldMessage) => boolean;
}

/**
 * The outcome of admitting a message.
 */
export interface CrossSessionAdmission {
  /** The gate's decision. */
  decision: 'accept' | 'held' | 'refused';
  /** The receipt, when the gate sent one. */
  receipt?: CrossSessionReceipt;
}

/**
 * The outcome of settling a parked message.
 */
export interface CrossSessionSettlement {
  /** What happened to the message. */
  outcome: 'delivered' | 'dropped' | 'dropped-by-guard' | 'gone';
  /** The receipt, when the gate sent one. */
  receipt?: CrossSessionReceipt;
}

/**
 * The cross-session inbound gate.
 *
 * The gate decides what happens to a message that arrives from another
 * session: it is **delivered**, **parked** for the user's approval, or
 * **refused**. Everything the gate does is the target's own; the transport that
 * would carry a delivered message is not here, and {@link deliver} says so.
 */
export class CrossSessionInbound {
  /** The parked messages, oldest first. */
  private readonly parked: HeldMessage[] = [];

  /** The settings sources. */
  private readonly sources: CrossSessionInboundSources;

  /** Whether the kill switch is on. */
  private readonly killSwitch: boolean;

  /** The receiving session's permission mode. */
  private readonly mode: CrossSessionMode | undefined;

  /** The capacity of the hold buffer. */
  private readonly capacity: number;

  /** The receipt sink. */
  private readonly sendReceipt: ((message: HeldMessage, receipt: CrossSessionReceipt) => void) | undefined;

  /** Called when a message is parked. */
  private readonly onHeld:
    | ((message: HeldMessage, count: number, cause: CrossSessionHoldCause) => void)
    | undefined;

  /** Called when a parked message is dropped. */
  private readonly onHoldDropped:
    | ((message: HeldMessage, receipt: CrossSessionReceipt) => void)
    | undefined;

  /** Called when parked messages are released. */
  private readonly onHoldReleased:
    | ((messages: readonly HeldMessage[], reason: string) => void)
    | undefined;

  /** The ingress guard. */
  private readonly guard: ((message: HeldMessage) => boolean) | undefined;

  constructor(options: CrossSessionInboundOptions = {}) {
    this.sources = options.sources ?? {};
    this.killSwitch = options.killSwitch === true;
    this.mode = options.mode;
    this.capacity = options.capacity ?? CROSS_SESSION_HOLD_CAPACITY;
    this.sendReceipt = options.sendReceipt;
    this.onHeld = options.onHeld;
    this.onHoldDropped = options.onHoldDropped;
    this.onHoldReleased = options.onHoldReleased;
    this.guard = options.guard;
  }

  /** The resolved setting. */
  get resolution(): CrossSessionResolution {
    return resolveCrossSessionInbound(this.sources);
  }

  /** The number of parked messages. */
  heldCount(): number {
    return this.parked.length;
  }

  /** The parked messages, oldest first. */
  heldMessages(): readonly HeldMessage[] {
    return this.parked;
  }

  /**
   * The gate's decision when **no message** is in hand.
   *
   * This is the gate the settings screen asks about: the kill switch wins, an
   * explicit setting wins, and otherwise a session that bypasses prompts holds
   * everything.
   */
  defaultPolicy(): CrossSessionPolicy {
    if (this.killSwitch) return { policy: 'refuse', refuseCause: 'kill-switch' };
    const resolution = this.resolution;
    if (resolution.value !== undefined) {
      switch (resolution.value) {
        case 'accept':
          return { policy: 'accept' };
        case 'hold':
          return { policy: 'hold', holdCause: holdCauseFor(resolution.decidedBy) };
        case 'refuse':
          return { policy: 'refuse', refuseCause: 'opt-out' };
      }
    }
    if (this.mode === undefined) return { policy: 'hold', holdCause: 'mode-unknown' };
    if (!isKnownPermissionMode(this.mode.mode)) {
      return { policy: 'hold', holdCause: 'mode-unknown' };
    }
    if (permissionModeClass(this.mode) === 'bypass') {
      return { policy: 'hold', holdCause: 'bypass-default' };
    }
    return { policy: 'accept' };
  }

  /**
   * The gate's decision for one message.
   *
   * An explicit setting wins outright. Otherwise the sender's class and the
   * receiver's class must **match**: a mismatch is held, and a sender that
   * asserted no class is held while the receiver bypasses prompts.
   */
  policyFor(message: HeldMessage): CrossSessionPolicy {
    if (this.killSwitch) return { policy: 'refuse', refuseCause: 'kill-switch' };
    const resolution = this.resolution;
    if (resolution.value !== undefined) {
      switch (resolution.value) {
        case 'accept':
          return { policy: 'accept' };
        case 'hold':
          return { policy: 'hold', holdCause: holdCauseFor(resolution.decidedBy) };
        case 'refuse':
          return { policy: 'refuse', refuseCause: 'opt-out' };
      }
    }

    const origin = message.origin;
    if (origin?.selfSent === true) return { policy: 'accept' };

    if (this.mode === undefined || !isKnownPermissionMode(this.mode.mode)) {
      return { policy: 'hold', holdCause: 'mode-unknown' };
    }

    const receiver = permissionModeClass(this.mode);
    const asserted = origin?.fromMode;
    if (asserted !== undefined) {
      return asserted === receiver
        ? { policy: 'accept' }
        : { policy: 'hold', holdCause: 'mode-mismatch' };
    }
    return receiver === 'bypass'
      ? { policy: 'hold', holdCause: 'no-mode-asserted' }
      : { policy: 'accept' };
  }

  /**
   * Admit a message.
   *
   * The target's own decision function: an accepted message releases whatever
   * was parked, a refused message is refused with its receipt, and a held
   * message is parked — and the buffer evicts its oldest entry when it is
   * full.
   */
  admit(message: HeldMessage): CrossSessionAdmission {
    const policy = this.policyFor(message);
    switch (policy.policy) {
      case 'accept': {
        this.release('policy-accepts');
        return { decision: 'accept' };
      }
      case 'refuse': {
        this.receipt(message, 'refused');
        return { decision: 'refused', receipt: 'refused' };
      }
      case 'hold': {
        if (this.parked.length >= this.capacity) {
          const oldest = this.parked.shift();
          if (oldest !== undefined) {
            this.receipt(oldest, 'expired');
            this.onHoldDropped?.(oldest, 'expired');
          }
        }
        this.parked.push(message);
        this.onHeld?.(message, this.parked.length, policy.holdCause);
        this.receipt(message, 'held');
        return { decision: 'held', receipt: 'held' };
      }
    }
  }

  /**
   * Release the parked messages the gate now admits.
   *
   * Every parked message is **re-evaluated**: the ones the gate now refuses
   * are dropped, the ones it now admits are released, and the rest stay
   * parked.
   */
  release(reason: string): { released: HeldMessage[]; dropped: HeldMessage[] } {
    const released: HeldMessage[] = [];
    const dropped: HeldMessage[] = [];
    const stillParked: HeldMessage[] = [];

    for (const message of this.parked) {
      const policy = this.policyFor(message);
      if (policy.policy === 'accept') {
        if (this.guard === undefined || this.guard(message)) {
          released.push(message);
        } else {
          this.receipt(message, 'dropped');
          this.onHoldDropped?.(message, 'dropped');
          dropped.push(message);
        }
      } else if (policy.policy === 'refuse') {
        this.receipt(message, 'refused');
        this.onHoldDropped?.(message, 'refused');
        dropped.push(message);
      } else {
        stillParked.push(message);
      }
    }

    this.parked.length = 0;
    this.parked.push(...stillParked);

    for (const message of released) this.receipt(message, 'delivered');
    if (released.length > 0) this.onHoldReleased?.(released, reason);
    return { released, dropped };
  }

  /**
   * Approve a parked message.
   *
   * The gate releases it; the transport that would carry it is not here, and
   * {@link deliver} says so.
   */
  approve(id: string): CrossSessionSettlement {
    return this.settle(id, 'approve');
  }

  /** Deny a parked message. */
  deny(id: string): CrossSessionSettlement {
    return this.settle(id, 'deny');
  }

  /** Let a parked message expire. */
  expire(id: string): CrossSessionSettlement {
    return this.settle(id, 'expire');
  }

  /**
   * Settle a parked message.
   *
   * The target's own outcomes: approving a message the policy now refuses
   * drops it, approving a message the ingress guard drops reports
   * `dropped-by-guard`, approving a message releases it, and denying or
   * expiring one drops it with its receipt.
   */
  private settle(id: string, action: 'approve' | 'deny' | 'expire'): CrossSessionSettlement {
    const index = this.parked.findIndex((message) => message.id === id);
    if (index === -1) return { outcome: 'gone' };
    const [message] = this.parked.splice(index, 1);
    if (message === undefined) return { outcome: 'gone' };

    if (action === 'approve') {
      const policy = this.policyFor(message);
      if (policy.policy === 'refuse') {
        this.receipt(message, 'refused');
        this.onHoldDropped?.(message, 'refused');
        return { outcome: 'dropped', receipt: 'refused' };
      }
      if (this.guard !== undefined && !this.guard(message)) {
        this.receipt(message, 'dropped');
        this.onHoldDropped?.(message, 'dropped');
        return { outcome: 'dropped-by-guard', receipt: 'dropped' };
      }
      this.receipt(message, 'delivered');
      this.onHoldReleased?.([message], 'approved');
      return { outcome: 'delivered', receipt: 'delivered' };
    }

    const receipt: CrossSessionReceipt = action === 'deny' ? 'denied' : 'expired';
    this.receipt(message, receipt);
    this.onHoldDropped?.(message, receipt);
    return { outcome: 'dropped', receipt };
  }

  /**
   * Carry a message to the receiving session.
   *
   * **There is no cross-session transport here.** The target carries the
   * message over a socket, a bridge or the cloud; this implementation has
   * none of them, so the call refuses and names the capability it needed.
   */
  deliver(message: HeldMessage): void {
    void message;
    throw new Error(
      'The cross-session inbound path needs a cross-session transport, which this session does not have, so the message was not delivered.',
    );
  }

  /** Send a receipt. */
  private receipt(message: HeldMessage, receipt: CrossSessionReceipt): void {
    this.sendReceipt?.(message, receipt);
  }
}

/* -------------------------------------------------------------------------- */
/* The inbound message form                                                    */
/* -------------------------------------------------------------------------- */

/** The tag a cross-session message is wrapped in. */
export const CROSS_SESSION_MESSAGE_TAG = 'cross-session-message';

/** The tag a teammate message is wrapped in. */
export const TEAMMATE_MESSAGE_TAG = 'teammate-message';

/**
 * The envelope's own fields.
 *
 * The `from` is the **address** the message came from — a socket address, a
 * bridge address or a cloud id — not an agent id; the sender's *name* is in
 * `from-name`.
 */
export interface CrossSessionEnvelope {
  /** The address the message came from. */
  from?: string;
  /** The session id the message came from. */
  fromSession?: string;
  /** The hops the message travelled. */
  hopChain?: string[];
  /** The sender's name. */
  fromName?: string;
  /** The class the sending session asserted. */
  fromMode?: CrossSessionPermissionClass;
  /** The plugin the message came through. */
  fromPlugin?: string;
  /** The message itself. */
  body: string;
}

/** The characters the `from` attribute may carry. */
const FROM_CHARACTERS = 'A-Za-z0-9%:_/.\\-';
/** The shape of a session id. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** The shape of one hop. */
const HOP = /^[0-9a-f]{24}$/;

/**
 * Truncate a value the way the target truncates an attribute.
 */
function truncate(value: string): string {
  const characters = [...value];
  if (characters.length <= 64) return value;
  return `${characters.slice(0, 64).join('')}…`;
}

/**
 * Encode the characters the `from` attribute may not carry.
 *
 * The target percent-encodes an address into the attribute's own alphabet, so
 * the value survives the round trip through the parser.
 */
function encodeFrom(value: string): string {
  return value.replace(/[^A-Za-z0-9:_/.\\-]/gu, (character) => {
    const bytes = new TextEncoder().encode(character);
    return Array.from(bytes, (byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
  });
}

/**
 * Format a cross-session envelope.
 *
 * The attribute order is the target's own: `from`, `from-session`, `hop-chain`,
 * `from-name`, `from-mode`, `from-plugin`.
 */
export function formatCrossSessionEnvelope(envelope: CrossSessionEnvelope): string {
  const attributes: string[] = [];
  if (envelope.from !== undefined && envelope.from !== '') {
    attributes.push(`from="${encodeFrom(envelope.from)}"`);
  }
  if (envelope.fromSession !== undefined && SESSION_ID.test(envelope.fromSession)) {
    attributes.push(`from-session="${envelope.fromSession}"`);
  }
  if (
    envelope.hopChain !== undefined &&
    envelope.hopChain.length > 0 &&
    envelope.hopChain.length <= 32 &&
    envelope.hopChain.every((hop) => HOP.test(hop))
  ) {
    attributes.push(`hop-chain="${envelope.hopChain.join(',')}"`);
  }
  if (envelope.fromName !== undefined && envelope.fromName !== '') {
    attributes.push(`from-name="${truncate(envelope.fromName.replace(/["<>]/g, ''))}"`);
  }
  if (envelope.fromMode !== undefined) {
    attributes.push(`from-mode="${envelope.fromMode}"`);
  }
  if (envelope.fromPlugin !== undefined && envelope.fromPlugin !== '') {
    attributes.push(`from-plugin="${truncate(envelope.fromPlugin.replace(/["<>]/g, ''))}"`);
  }
  const head = attributes.length > 0 ? ` ${attributes.join(' ')}` : '';
  return `<${CROSS_SESSION_MESSAGE_TAG}${head}>\n${envelope.body}\n</${CROSS_SESSION_MESSAGE_TAG}>`;
}

/**
 * Parse a cross-session envelope.
 *
 * The shape is the target's own: the tag, the six optional attributes in
 * order, the body on its own line, and the closing tag.
 */
export function parseCrossSessionEnvelope(text: string): CrossSessionEnvelope | undefined {
  const pattern = new RegExp(
    `^<${CROSS_SESSION_MESSAGE_TAG}` +
      `(?: from="([${FROM_CHARACTERS}]+)")?` +
      `(?: from-session="([A-Za-z0-9_-]{1,80})")?` +
      `(?: hop-chain="([0-9a-f]{24}(?:,[0-9a-f]{24}){0,31})")?` +
      `(?: from-name="([^"<>\\n\\r]+)")?` +
      `(?: from-mode="(bypass|prompting)")?` +
      `(?: from-plugin="([^"<>\\n\\r]+)")?` +
      '>\\n([\\s\\S]*)\\n' +
      `</${CROSS_SESSION_MESSAGE_TAG}>$`,
  );
  const match = pattern.exec(text);
  if (match === null) return undefined;

  const envelope: CrossSessionEnvelope = { body: match[7] ?? '' };
  if (match[1] !== undefined) envelope.from = match[1];
  if (match[2] !== undefined) envelope.fromSession = match[2];
  if (match[3] !== undefined) envelope.hopChain = match[3].split(',');
  if (match[4] !== undefined) envelope.fromName = match[4];
  if (match[5] !== undefined) {
    envelope.fromMode = match[5] as CrossSessionPermissionClass;
  }
  if (match[6] !== undefined) envelope.fromPlugin = match[6];
  return envelope;
}

/**
 * The envelope a **teammate** receives a message in.
 *
 * The target wraps a message that arrives in a teammate's inbox in a
 * `<teammate-message>` tag, and the tag carries the sender's id, its colour
 * and the summary the recipient's human sees first.
 */
export interface TeammateMessageEnvelope {
  /** The sender's id. */
  teammateId: string;
  /** The sender's colour. */
  color?: string;
  /** The one-line summary the recipient's human sees first. */
  summary?: string;
  /** Whether the message's provenance could not be verified. */
  unverified?: boolean;
  /** The message itself. */
  body: string;
}

/**
 * Format a teammate-message envelope.
 *
 * The attribute order is the target's own: `teammate_id`, `color`, `summary`,
 * `verified`.
 */
export function formatTeammateMessageEnvelope(envelope: TeammateMessageEnvelope): string {
  const attributes: string[] = [`teammate_id="${escapeAttributeValue(envelope.teammateId)}"`];
  if (envelope.color !== undefined && envelope.color !== '') {
    attributes.push(`color="${escapeAttributeValue(envelope.color)}"`);
  }
  if (envelope.summary !== undefined && envelope.summary !== '') {
    attributes.push(`summary="${escapeAttributeValue(envelope.summary)}"`);
  }
  if (envelope.unverified === true) attributes.push('verified="false"');
  return `<${TEAMMATE_MESSAGE_TAG} ${attributes.join(' ')}>\n${envelope.body}\n</${TEAMMATE_MESSAGE_TAG}>`;
}

/**
 * Escape the characters an attribute value may not carry.
 */
function escapeAttributeValue(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * Whether a value is one of the two permission-mode classes.
 */
export function isPermissionModeClass(value: unknown): value is CrossSessionPermissionClass {
  return value === 'bypass' || value === 'prompting';
}

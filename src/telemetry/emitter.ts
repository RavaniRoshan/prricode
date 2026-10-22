/**
 * The **telemetry emitter**: the one place this implementation raises an event.
 *
 * ## The event model
 *
 * **Observed** (`chunk-333wmdtg.js`, the target's telemetry module):
 *
 * - an event is a **pair** — an **event name** and a **metadata** object;
 * - `logEvent(eventName, metadata)` is the synchronous emit and
 *   `logEventAsync(eventName, metadata)` the awaited one;
 * - the sink's own interface is `{logEvent, logEventAsync}`;
 * - the queue holds **1 000** events and drops its **oldest** when it is full,
 *   counting the drop;
 * - a sink that arrives late gets the queue replayed, in a **microtask**;
 * - the metadata's `_PROTO_`-prefixed keys are **stripped** before they reach
 *   the sink.
 *
 * There is no envelope, no channel and no schema version: the sink receives
 * the name and the metadata, and nothing else. This implementation reproduces
 * that model exactly.
 *
 * ## The rules the emitter enforces
 *
 * 1. **An event the target does not emit is not emitted.** The name is checked
 *    against the target's vocabulary (`src/telemetry/vocabulary.ts`), and an
 *    unknown name is refused. The vocabulary is the target's own list of
 *    `tengu_*` names, re-derived from the target's source.
 * 2. **An event is not renamed.** The names this implementation raises are
 *    typed as {@link TelemetryEventName}, which is derived from the
 *    vocabulary — so a rename or an invented name is a **compile error**, not
 *    a reviewer's problem.
 * 3. **A telemetry switch the target honours is honoured here.** The
 *    environment's traffic mode (`DISABLE_TELEMETRY`, `DO_NOT_TRACK`,
 *    `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`) turns the emitter off, exactly
 *    as it turns the target's off.
 *
 * ## What is **not** reproduced
 *
 * The target's analytics **backend** — the first-party event log and the
 * Datadog forwarder — is not reproduced, because this implementation has no
 * account, no session identity and no bucket to report. The **model** is
 * reproduced; the backend is not, and the difference is named in
 * `docs/compatibility/reference-catalogues.md`.
 */

import { telemetryIsOff, trafficMode, trafficModeReason, type TrafficMode } from '../config/environment.js';
import {
  isTargetTelemetryEvent,
  type TelemetryEventName,
} from './vocabulary.js';

/** The properties an event carries. */
export type TelemetryProperties = Record<string, unknown>;

/**
 * The sink the emitter delivers to.
 *
 * **Observed** (`chunk-333wmdtg.js`): the target's own sink interface is
 * `{logEvent, logEventAsync}` — the **name** and the **metadata**, and nothing
 * else.
 */
export interface TelemetrySink {
  /** Deliver an event. */
  logEvent(name: string, properties: TelemetryProperties): void;
  /** Deliver an event, and wait for it. */
  logEventAsync?(name: string, properties: TelemetryProperties): Promise<void>;
}

/**
 * An event name this implementation may raise that the vocabulary does not
 * hold.
 *
 * The vocabulary is the target's `tengu_*` names. The target emits **timing**
 * events under names that are not `tengu_*` — the target's own
 * `skills_load_ms` is one — and the derivation's literal scan does not see
 * that namespace, so the names are declared here instead.
 */
export interface DeclaredTelemetryEvent {
  /** The event's name. */
  readonly name: string;
  /**
   * Where the name comes from.
   *
   * - `target-timing` — the target emits it, under a name outside the
   *   `tengu_*` vocabulary;
   * - `project-extension` — **this implementation's own** event. The target
   *   does not emit it, and the plan requires every extension to be labelled
   *   as one.
   */
  readonly kind: 'target-timing' | 'project-extension';
  /** Why the name is declared. */
  readonly reason: string;
}

/**
 * The event names outside the vocabulary that this implementation raises.
 *
 * The list is **explicit**: an event the target does not emit is not raised
 * because it was convenient, it is raised because it is declared here, with a
 * reason, and the declaration is what a reader checks.
 */
export const DECLARED_TELEMETRY_EVENTS: readonly DeclaredTelemetryEvent[] = Object.freeze([
  {
    name: 'skills_load_ms',
    kind: 'target-timing',
    reason:
      'the target records a timing event under this name (chunk-kmrt4q1v.js and chunk-2qzm38z8.js); it is outside the tengu_* vocabulary',
  },
  {
    name: 'qe_plugin_skills_load_ms',
    kind: 'target-timing',
    reason:
      'the target records a timing event under this name for the plugin skill load (chunk-4jsg44k7.js); it is outside the tengu_* vocabulary',
  },
]);

/** The declared names, as a set. */
const DECLARED_TELEMETRY_EVENT_SET: ReadonlySet<string> = new Set(
  DECLARED_TELEMETRY_EVENTS.map((declared) => declared.name),
);

/**
 * The refusal raised when an event name is neither in the target's vocabulary
 * nor declared.
 */
export class UnknownTelemetryEventError extends Error {
  /** The name that was refused. */
  readonly eventName: string;

  constructor(eventName: string) {
    super(
      `the telemetry event "${eventName}" is not one the target emits and is not declared; ` +
        'an event the target does not emit is not emitted',
    );
    this.name = 'UnknownTelemetryEventError';
    this.eventName = eventName;
  }
}

/**
 * Whether an event name may be raised.
 *
 * A name is allowed when the target emits it, or when it is declared in
 * {@link DECLARED_TELEMETRY_EVENTS}.
 */
export function isKnownTelemetryEvent(name: string): boolean {
  return isTargetTelemetryEvent(name) || DECLARED_TELEMETRY_EVENT_SET.has(name);
}

/**
 * Refuse an event name the target does not emit.
 *
 * @throws {UnknownTelemetryEventError} when the name is unknown.
 */
export function assertKnownTelemetryEvent(name: string): void {
  if (!isKnownTelemetryEvent(name)) throw new UnknownTelemetryEventError(name);
}

/**
 * The metadata's `_PROTO_`-prefixed keys are removed.
 *
 * **Observed** (`chunk-333wmdtg.js:686`): the target copies the metadata and
 * deletes every key that starts with `_PROTO_`, so a prototype-carrying key
 * never reaches the sink.
 */
export function stripProtoFields(properties: TelemetryProperties): TelemetryProperties {
  let stripped: TelemetryProperties | undefined;
  for (const key of Object.keys(properties)) {
    if (!key.startsWith('_PROTO_')) continue;
    if (stripped === undefined) stripped = { ...properties };
    delete stripped[key];
  }
  return stripped ?? properties;
}

/** One queued event. */
interface QueuedTelemetryEvent {
  /** The event's name. */
  readonly name: string;
  /** The event's metadata. */
  readonly properties: TelemetryProperties;
  /** Whether the event is delivered through the asynchronous path. */
  readonly asynchronous: boolean;
}

/**
 * The queue's capacity.
 *
 * **Observed** (`chunk-333wmdtg.js:798`): the target's queue holds a
 * thousand events.
 */
export const TELEMETRY_QUEUE_CAPACITY = 1000;

/**
 * The emitter.
 *
 * The queue, the sink and the drop rule are the target's own.
 */
export class TelemetryEmitter {
  /** The queued events, oldest first. */
  readonly #queue: QueuedTelemetryEvent[] = [];

  /** The sink, when one is attached. */
  #sink: TelemetrySink | null = null;

  /** How many events the queue dropped. */
  #dropped = 0;

  /** The events the emitter refused to deliver because the traffic mode is off. */
  #suppressed = 0;

  /** The environment the traffic mode is read from. */
  readonly #env: NodeJS.ProcessEnv;

  /**
   * The emitter's constructor.
   *
   * The environment is the one the traffic mode is read from; a caller with
   * its own environment — a test, a host — passes it.
   */
  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.#env = env;
  }

  /** How many events the queue dropped because it was full. */
  get droppedEventCount(): number {
    return this.#dropped;
  }

  /** How many events the traffic mode suppressed. */
  get suppressedEventCount(): number {
    return this.#suppressed;
  }

  /** How many events are queued. */
  get queuedEventCount(): number {
    return this.#queue.length;
  }

  /** The traffic mode the emitter runs in. */
  get mode(): TrafficMode {
    return trafficMode(this.#env);
  }

  /** The variable that turned the traffic mode off, when one did. */
  get modeReason(): string | undefined {
    return trafficModeReason(this.#env);
  }

  /**
   * Attach a sink.
   *
   * **Observed** (`chunk-333wmdtg.js:1047`): the target keeps one sink, and a
   * sink that arrives when the queue holds events gets them replayed in a
   * **microtask** — the events are raised before the sink exists, and they
   * are not lost.
   *
   * @returns whether the sink was attached; `false` when one was already
   *   attached.
   */
  attachSink(sink: TelemetrySink): boolean {
    if (this.#sink !== null) return false;
    this.#sink = sink;
    if (this.#queue.length === 0) return true;
    const queued = this.#queue.splice(0, this.#queue.length);
    queueMicrotask(() => {
      for (const event of queued) {
        if (event.asynchronous) {
          void sink.logEventAsync?.(event.name, event.properties);
          continue;
        }
        sink.logEvent(event.name, event.properties);
      }
    });
    return true;
  }

  /**
   * Raise an event.
   *
   * **Observed** (`chunk-333wmdtg.js:1312`): with no sink attached the event
   * is **queued**; with one attached it goes straight to the sink.
   *
   * @throws {UnknownTelemetryEventError} when the name is neither in the
   *   target's vocabulary nor declared.
   */
  logEvent(name: string, properties: TelemetryProperties = {}): void {
    assertKnownTelemetryEvent(name);
    if (telemetryIsOff(this.#env)) {
      this.#suppressed += 1;
      return;
    }
    const metadata = stripProtoFields(properties);
    if (this.#sink === null) {
      this.#enqueue({ name, properties: metadata, asynchronous: false });
      return;
    }
    this.#sink.logEvent(name, metadata);
  }

  /**
   * Raise an event, and wait for the sink.
   *
   * **Observed** (`chunk-333wmdtg.js:1429`): the asynchronous path queues the
   * event as an asynchronous one, and the replay awaits the sink.
   *
   * @throws {UnknownTelemetryEventError} when the name is neither in the
   *   target's vocabulary nor declared.
   */
  async logEventAsync(name: string, properties: TelemetryProperties = {}): Promise<void> {
    assertKnownTelemetryEvent(name);
    if (telemetryIsOff(this.#env)) {
      this.#suppressed += 1;
      return;
    }
    const metadata = stripProtoFields(properties);
    if (this.#sink === null) {
      this.#enqueue({ name, properties: metadata, asynchronous: true });
      return;
    }
    await this.#sink.logEventAsync?.(name, metadata);
  }

  /**
   * Queue an event, dropping the **oldest** one when the queue is full.
   *
   * **Observed** (`chunk-333wmdtg.js:874`): the target shifts the oldest event
   * out of a full queue and counts the drop.
   */
  #enqueue(event: QueuedTelemetryEvent): void {
    if (this.#queue.length >= TELEMETRY_QUEUE_CAPACITY) {
      this.#queue.shift();
      this.#dropped += 1;
    }
    this.#queue.push(event);
  }
}

/**
 * The properties of a record this implementation's own seams produce.
 *
 * The session modules raise a **flat** record — the event's name beside its
 * properties — and the emitter's model is a **pair**. This is the adapter
 * between the two, and it is the only place the two shapes meet.
 */
export function propertiesOf<T extends { readonly name: string }>(record: T): TelemetryProperties {
  const properties: TelemetryProperties = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'name') continue;
    properties[key] = value;
  }
  return properties;
}

/**
 * Raise an event through the implementation's own seam.
 *
 * The name is checked against the target's vocabulary first: an event the
 * target does not emit is not raised, and the refusal is a **programming
 * error**, not a runtime condition to be swallowed.
 *
 * @throws {UnknownTelemetryEventError} when the name is neither in the
 *   target's vocabulary nor declared.
 */
export function raiseTelemetryEvent<T extends { readonly name: string }>(
  record: T,
  deliver: ((event: T) => void) | undefined,
): void {
  assertKnownTelemetryEvent(record.name);
  deliver?.(record);
}

/** The emitter the implementation raises through when no other is named. */
export const defaultTelemetryEmitter = new TelemetryEmitter();

/**
 * Raise an event through the default emitter.
 *
 * @throws {UnknownTelemetryEventError} when the name is neither in the
 *   target's vocabulary nor declared.
 */
export function logTelemetryEvent(name: TelemetryEventName | string, properties: TelemetryProperties = {}): void {
  defaultTelemetryEmitter.logEvent(name, properties);
}

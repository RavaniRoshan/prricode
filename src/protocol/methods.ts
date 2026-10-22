/**
 * The method vocabulary.
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §4.
 *
 * **One responsibility:** which methods exist, which area each belongs to, and
 * which of them may only ever be a notification.
 *
 * ## What the specification states
 *
 * | area | the methods | the direction |
 * |---|---|---|
 * | `session/*` | `session/create`, `session/status`, `session/cancel`, `session/dispose` | a client calls |
 * | `turn/*` | `turn/start`, `turn/abort` | a client calls |
 * | `tool/*` | `tool/list`, `tool/describe`, `tool/call` | **both** |
 * | `model/*` | `model/list`, `model/describe`, `model/select` | a client calls |
 * | `approval/*` | `approval/request`, `approval/answer`, `approval/pending` | a client calls; a provider may call `approval/request` against a client |
 * | `capability/*` | `capability/describe` | a client calls |
 * | `event/*` | `event/message`, `event/tool`, `event/stage`, `event/diagnostic` | a peer **notifies** |
 *
 * > **`event/*` is notification-only.** A turn's progress is never polled; the
 * > peer that started the turn receives the events.
 *
 * ## The count, and the one method the table does not list
 *
 * The specification's prose says **"Six areas"** and its table lists
> **seven** rows. The reading this implementation takes is in
> `docs/compatibility/protocol-surface.md`: the six are the areas a **client
> calls** — `session`, `turn`, `tool`, `model`, `approval` and `capability` —
> and the seventh row, `event/*`, is the **notification** area, which the
> direction column marks as "a peer notifies" while every other row is marked
> "a client calls". All seven are implemented, and no method of the table is
> left out.
 *
 * The specification's §5 also names a notification the table does not list:
 * > The turn's end is an `event/message` carrying the turn's final state, or a
> > `turn/failed` notification.
 *
> `turn/failed` is therefore a method of the `turn` area, and it is
> notification-only like every other notification. It is listed here with the
> rest, and it is **not** a request — a turn that has already been answered
> cannot be failed by a second answer.
 */

/** The areas of the vocabulary. */
export const PROTOCOL_AREAS = [
  'session',
  'turn',
  'tool',
  'model',
  'approval',
  'capability',
  'event',
] as const;

/** One of the areas. */
export type ProtocolArea = (typeof PROTOCOL_AREAS)[number];

/** Every method of the vocabulary. */
export const PROTOCOL_METHODS = [
  'session/create',
  'session/status',
  'session/cancel',
  'session/dispose',
  'turn/start',
  'turn/abort',
  'tool/list',
  'tool/describe',
  'tool/call',
  'model/list',
  'model/describe',
  'model/select',
  'approval/request',
  'approval/answer',
  'approval/pending',
  'capability/describe',
  'event/message',
  'event/tool',
  'event/stage',
  'event/diagnostic',
  'turn/failed',
] as const;

/** One of the methods. */
export type ProtocolMethod = (typeof PROTOCOL_METHODS)[number];

/**
 * The methods that may only ever be a notification.
 *
 * The four `event/*` methods, and `turn/failed`. A peer that calls one of them
 * as a request is refused with `method/notification-only` — the call is
 * understood well enough to be refused, and the refusal names the method.
 */
export const NOTIFICATION_ONLY_METHODS: ReadonlySet<string> = new Set<string>([
  'event/message',
  'event/tool',
  'event/stage',
  'event/diagnostic',
  'turn/failed',
]);

/**
 * Whether the method is one of the vocabulary's.
 *
 * The test is exact: a method is `area/verb` with a known area and a known
 * verb, and nothing else is a method.
 */
export function isKnownMethod(method: string): method is ProtocolMethod {
  return (PROTOCOL_METHODS as readonly string[]).includes(method);
}

/**
 * The area a method belongs to, or `undefined` when the method is not of the
 * vocabulary.
 */
export function methodArea(method: string): ProtocolArea | undefined {
  if (!isKnownMethod(method)) return undefined;
  const area = method.slice(0, method.indexOf('/'));
  return (PROTOCOL_AREAS as readonly string[]).includes(area)
    ? (area as ProtocolArea)
    : undefined;
}

/**
 * Whether the method may only be a notification.
 *
 * A method that is not of the vocabulary is not notification-only: it is
 * unknown, and the two refusals are different.
 */
export function isNotificationOnly(method: string): boolean {
  return NOTIFICATION_ONLY_METHODS.has(method);
}

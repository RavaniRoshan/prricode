/**
 * The capability record — and the degradation contract.
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §6 and §9.
 *
 * **One responsibility:** the shape every capability reports, and the rule that
 * a capability which cannot run says so with a reason.
 *
 * ## What the specification states
 *
 * > **Every capability reports the same shape.** One record, asked of anything:
 * >
 * > ```jsonc
 * > {
 * >   "enabled": true,
 * >   "unsupported": null,          // the reason, when it is not enabled
 * >   "…": "…",                     // the capability's own fields, beneath the shared pair
 * > }
 * > ```
 * >
 * > When a capability cannot run, it reports:
 * >
 * > ```jsonc
 * > { "enabled": false, "unsupported": "a running IDE with its extension installed" }
 * > ```
 * >
 * > **The reason is a sentence that names what is missing.** It is never empty,
 * > never a placeholder, and never a success. A capability that is enabled and
 * > does nothing is a **bug**, and the degradation contract exists to make it
 * > impossible to ship quietly.
 *
 * ## How the rule is kept
 *
 * The reason is checked where the record is built, and checked again where it
 * is registered, so a record cannot be assembled by hand in a way that breaks
 * the contract. The check is mechanical: a reason is a **sentence** — it has
 * words in it — and it is not one of the placeholders that would say nothing.
 *
 * A capability that is enabled carries **no** reason: `unsupported` is `null`.
 * A capability that is not enabled **must** carry one. There is no third
 * state, and no way to be "enabled but with a reason".
 */

import { PROTOCOL_ERROR_CODES, protocolError } from './errors.js';

/**
 * The record every capability reports.
 *
 * The shared pair is `enabled` and `unsupported`; a capability's own fields
 * sit beneath it, and they are free-form.
 */
export interface CapabilityRecord {
  /** Whether the capability can run. */
  readonly enabled: boolean;
  /** The reason it cannot, or `null` when it can. */
  readonly unsupported: string | null;
  /** The capability's own fields, beneath the shared pair. */
  readonly [field: string]: unknown;
}

/**
 * The phrases that say nothing and are therefore refused as a reason.
 *
 * A reason that is one of these would be a placeholder, and the specification
 * says a reason is never a placeholder.
 */
export const PLACEHOLDER_REASONS: ReadonlySet<string> = new Set([
  '',
  'unknown',
  'unsupported',
  'not supported',
  'none',
  'null',
  'undefined',
  'n/a',
  'na',
  'todo',
  'tbd',
  'fixme',
]);

/**
 * Whether the given text is a reason that may be reported.
 *
 * A reason must be a **sentence**: it has words, it is not a placeholder, and
 * it is not a success message. The check is deliberately mechanical — a reason
 * that names what is missing cannot be checked for meaning by a program — and
 * the rule the program *can* check is that the reason is a sentence and not a
 * placeholder.
 */
export function isReportableReason(reason: unknown): reason is string {
  if (typeof reason !== 'string') return false;
  const trimmed = reason.trim();
  if (trimmed.length === 0) return false;
  if (PLACEHOLDER_REASONS.has(trimmed.toLowerCase())) return false;
  if (trimmed.split(/\s+/).length < 2) return false;
  return true;
}

/**
 * Build a capability record.
 *
 * The pair is checked here, so a record that breaks the contract cannot be
 * built at all: an enabled capability carries no reason, and a capability that
 * cannot run carries one that is a sentence.
 */
export function capabilityRecord(
  enabled: boolean,
  unsupported: string | null = null,
  fields: Record<string, unknown> = {},
): CapabilityRecord {
  if (enabled) {
    if (unsupported !== null && unsupported !== undefined) {
      throw protocolError(
        PROTOCOL_ERROR_CODES.capabilityUnknown,
        'an enabled capability carries no reason, and this one carries one',
      );
    }
    return { enabled: true, unsupported: null, ...fields };
  }
  if (!isReportableReason(unsupported)) {
    throw protocolError(
      PROTOCOL_ERROR_CODES.capabilityUnknown,
      'a capability that cannot run names what is missing, in a sentence',
      { unsupported },
    );
  }
  return { enabled: false, unsupported: unsupported.trim(), ...fields };
}

/**
 * Whether a record reports a capability that cannot run.
 */
export function isDegraded(record: CapabilityRecord): boolean {
  return record.enabled === false;
}

/**
 * Check a record that was assembled by hand.
 *
 * The registry calls this on every record it takes, so a record that breaks
 * the contract is refused at the door rather than reported to a caller.
 */
export function assertCapabilityRecord(name: string, record: CapabilityRecord): void {
  if (record.enabled) {
    if (record.unsupported !== null) {
      throw protocolError(
        PROTOCOL_ERROR_CODES.capabilityUnknown,
        `the capability "${name}" is enabled and carries a reason, and an enabled capability carries none`,
      );
    }
    return;
  }
  if (!isReportableReason(record.unsupported)) {
    throw protocolError(
      PROTOCOL_ERROR_CODES.capabilityUnknown,
      `the capability "${name}" cannot run and does not name what is missing`,
      { unsupported: record.unsupported },
    );
  }
}

/**
 * The capabilities a peer knows about.
 *
 * The registry is a plain map with a name-keyed lookup, and every lookup of a
 * caller-supplied key is guarded — a capability named `__proto__` is an
 * ordinary name and not a prototype assignment.
 */
export class CapabilityRegistry {
  private readonly records = new Map<string, CapabilityRecord>();

  /** Register a capability, replacing any record it already had. */
  register(name: string, record: CapabilityRecord): void {
    if (typeof name !== 'string' || name.length === 0) {
      throw protocolError(
        PROTOCOL_ERROR_CODES.capabilityUnknown,
        'a capability needs a name',
      );
    }
    assertCapabilityRecord(name, record);
    this.records.set(name, record);
  }

  /** Whether the capability is known. */
  has(name: string): boolean {
    return this.records.has(name);
  }

  /** The record of a capability, or `undefined` when it is not known. */
  get(name: string): CapabilityRecord | undefined {
    return this.records.get(name);
  }

  /** Every known capability's name, in the order it was registered. */
  names(): string[] {
    return [...this.records.keys()];
  }

  /** Every known capability's record, keyed by name. */
  all(): Record<string, CapabilityRecord> {
    const out: Record<string, CapabilityRecord> = {};
    for (const [name, record] of this.records) out[name] = record;
    return out;
  }
}

/**
 * The capabilities a protocol server starts with.
 *
 * The protocol's own two are always enabled — the surface and the session
 * machinery are what this module *is*. The rest are the product's, and they
 * are **not** enabled until something registers them: the honest-degradation
 * contract says a capability that cannot run says so with a reason, and the
 * reason here names what is missing.
 */
export function createDefaultCapabilityRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.register('protocol', capabilityRecord(true, null, { transport: 'stdio' }));
  registry.register('session', capabilityRecord(true, null));
  registry.register('capability', capabilityRecord(true, null));
  registry.register('event', capabilityRecord(true, null));
  registry.register(
    'turn',
    capabilityRecord(false, 'no turn runner is registered in this build'),
  );
  registry.register(
    'tool',
    capabilityRecord(false, 'no tool provider is registered in this build'),
  );
  registry.register('model', capabilityRecord(false, 'no model backend is connected'));
  registry.register('approval', capabilityRecord(false, 'no approval rules are configured'));
  registry.register(
    'sandbox',
    capabilityRecord(false, 'no sandbox backend is registered in this build'),
  );
  registry.register(
    'computer-use',
    capabilityRecord(false, 'no display server with input control is available to this build'),
  );
  registry.register(
    'pipeline',
    capabilityRecord(false, 'no Product Builder stage is registered in this build'),
  );
  return registry;
}

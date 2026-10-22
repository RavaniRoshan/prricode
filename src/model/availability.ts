/**
 * "Connected" is **one predicate**.
 *
 * A provider is available when all three hold:
 *
 * - it is not disabled;
 * - its connection has not changed since it was last checked; and
 * - either it is **force-enabled**, or its integration has **at least one**
 *   connection, or it **has no integration at all**.
 *
 * **The whole picker, the availability filter and the credential resolution
 * follow from that one rule.** There is no second notion of "ready" anywhere.
 *
 * See [`docs/protocol/MODEL-LAYER.md`](../../docs/protocol/MODEL-LAYER.md) §6.
 */

import { connectionIdentity, type Connection } from './credentials.js';
import type { ProviderEntry } from './types.js';

/** The state a provider is checked against. */
export interface AvailabilityOptions {
  /** Whether the provider is turned off. */
  readonly disabled?: boolean;
  /** Whether the provider is turned on whatever its connections say. */
  readonly forceEnabled?: boolean;
  /** The connection identity the provider was last checked with. */
  readonly checkedConnection?: string;
}

/** The answer, and the reason when the answer is no. */
export interface Availability {
  readonly available: boolean;
  /** Why the provider is not available. Absent when it is. */
  readonly reason?: string;
}

/**
 * Whether a provider is available.
 *
 * The predicate is the same wherever it is asked, so the picker, the filter
 * and the credential resolution cannot disagree about a provider.
 */
export function providerAvailability(
  provider: ProviderEntry,
  connections: readonly Connection[],
  options: AvailabilityOptions = {},
): Availability {
  if (options.disabled) {
    return {
      available: false,
      reason: `the provider "${provider.id}" is disabled`,
    };
  }

  const active = connections[0];
  if (options.checkedConnection !== undefined) {
    const current = active ? connectionIdentity(active) : undefined;
    if (current !== options.checkedConnection) {
      return {
        available: false,
        reason:
          `the connection of the provider "${provider.id}" changed ` +
          `(it was "${options.checkedConnection}" and is now "${current ?? 'none'}")`,
      };
    }
  }

  if (options.forceEnabled) return { available: true };

  if (provider.credential.kind === 'none') return { available: true };

  if (connections.length > 0) return { available: true };

  return {
    available: false,
    reason: `the provider "${provider.id}" has no connection`,
  };
}

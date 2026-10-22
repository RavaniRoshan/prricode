/**
 * The provider table — a provider is data.
 *
 * **Adding a provider is adding an entry and a module.** It is never editing a
 * registry, and never a branch in the engine: there is exactly one code path
 * per **shape**, and a provider's own quirks live in its entry.
 *
 * See [`docs/protocol/MODEL-LAYER.md`](../../docs/protocol/MODEL-LAYER.md) §1
 * and §8.
 */

import type { ModelEntry, ProviderEntry } from './types.js';

/** The table of providers. */
export interface ProviderRegistry {
  /** Add a provider. A second entry under the same id is refused. */
  register(entry: ProviderEntry): void;
  /** One provider, or `undefined`. */
  get(id: string): ProviderEntry | undefined;
  /** Every provider, in the order it was registered. */
  list(): readonly ProviderEntry[];
}

/** The in-memory table. */
export class ProviderTable implements ProviderRegistry {
  readonly #providers = new Map<string, ProviderEntry>();

  constructor(entries: readonly ProviderEntry[] = []) {
    for (const entry of entries) this.register(entry);
  }

  register(entry: ProviderEntry): void {
    if (this.#providers.has(entry.id)) {
      throw new Error(`a provider with id "${entry.id}" is already registered`);
    }
    this.#providers.set(entry.id, entry);
  }

  get(id: string): ProviderEntry | undefined {
    return this.#providers.get(id);
  }

  list(): readonly ProviderEntry[] {
    return [...this.#providers.values()];
  }
}

/**
 * An alias of a canonical provider.
 *
 * The alias inherits the canonical provider's **whole definition** — its
 * models, their capabilities, their cost, their limits and the spelling of
 * their overlays — and changes **only** the endpoint and the credential. That
 * is "the same model, but through my own gateway".
 *
 * The models are re-identified to the alias, because a model belongs to the
 * provider it is reached through, and their overlays keep the **per-shape**
 * spellings they carry: an overlay's spelling belongs to the model *and* the
 * shape together, so an alias that speaks another shape is re-spelled rather
 * than mis-spelled.
 */
export function aliasProvider(alias: ProviderEntry, canonical: ProviderEntry): ProviderEntry {
  const headers = { ...(canonical.headers ?? {}), ...(alias.headers ?? {}) };
  return {
    ...alias,
    headers,
    models: canonical.models.map((model) => reidentify(model, alias.id)),
    aliasOf: canonical.id,
  };
}

/** A model, re-identified to another provider. */
function reidentify(model: ModelEntry, provider: string): ModelEntry {
  return { ...model, provider };
}

/**
 * Resolve a provider through its alias chain.
 *
 * An alias whose canonical provider is not registered is returned as it is:
 * the caller then sees a provider with no models, and says so, rather than
 * being handed a definition that was never declared.
 */
export function resolveProvider(
  registry: ProviderRegistry,
  id: string,
  seen: ReadonlySet<string> = new Set(),
): ProviderEntry | undefined {
  const entry = registry.get(id);
  if (!entry) return undefined;
  if (entry.aliasOf === undefined) return entry;
  if (seen.has(id)) return entry;
  const next = new Set(seen);
  next.add(id);
  const canonical = resolveProvider(registry, entry.aliasOf, next);
  if (!canonical) return entry;
  return aliasProvider(entry, canonical);
}

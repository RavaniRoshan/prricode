/**
 * The catalogue — what we know, and where we know it from.
 *
 * The catalogue is **fetched from each connected provider, and merged over a
 * snapshot we ship**. The load order, and why:
 *
 * 1. a **local override** the user wrote — always wins;
 * 2. the **fetched** catalogue — what the connected providers report, cached;
 * 3. the **shipped snapshot** — what we know when a provider is not connected,
 *    or does not report.
 *
 * So a provider that reports nothing does not empty our catalogue: its models
 * are still known, from the snapshot, and simply not connected.
 *
 * **A fetch that returns the same bytes changes nothing** — not the cache, not
 * the refresh, not the notification. A client watching the catalogue is not
 * woken for a no-op.
 *
 * See [`docs/protocol/MODEL-LAYER.md`](../../docs/protocol/MODEL-LAYER.md) §3.
 */

import { parseCataloguePayload } from './entries.js';
import type { CatalogueDocument, ModelEntry, ProviderEntry } from './types.js';

/** The three sources the catalogue merges. */
export interface CatalogueSources {
  /** The local override the user wrote. Always wins. */
  readonly local?: CatalogueDocument;
  /** The fetched catalogue. */
  readonly fetched?: CatalogueDocument;
  /** The shipped snapshot. */
  readonly snapshot: CatalogueDocument;
}

/**
 * Merge the three sources into one document.
 *
 * The merge is **per model**, so a local override that names one model does
 * not empty the rest of that provider's catalogue: the models the override
 * does not name still come from the fetch or the snapshot.
 */
export function mergeCatalogues(sources: CatalogueSources): CatalogueDocument {
  const order: CatalogueDocument[] = [];
  if (sources.local) order.push(sources.local);
  if (sources.fetched) order.push(sources.fetched);
  order.push(sources.snapshot);

  const byProvider = new Map<string, Map<string, ModelEntry>>();
  for (const document of order) {
    for (const entry of document.providers) {
      const models = byProvider.get(entry.provider) ?? new Map<string, ModelEntry>();
      for (const model of entry.models) {
        if (models.has(model.id)) continue;
        models.set(model.id, { ...model, provider: entry.provider });
      }
      byProvider.set(entry.provider, models);
    }
  }

  return {
    providers: [...byProvider].map(([provider, models]) => ({
      provider,
      models: [...models.values()],
    })),
  };
}

/** How a provider's catalogue is fetched. The bytes are what the cache compares. */
export type CatalogueFetcher = (provider: ProviderEntry) => Promise<{ readonly bytes: string }>;

/** What a refresh did. */
export interface CatalogueRefresh {
  /** Whether the catalogue changed. */
  readonly changed: boolean;
  /** Why it did not change, when it did not. */
  readonly reason?: string;
}

/** The change a watcher is woken for. */
export interface CatalogueChange {
  readonly provider: string;
}

/** How the catalogue is built. */
export interface ModelCatalogueOptions {
  /** The shipped snapshot: what we know when a provider does not report. */
  readonly snapshot: CatalogueDocument;
  /** The local override the user wrote. */
  readonly local?: CatalogueDocument;
  /** How a provider's catalogue is fetched. Without one, nothing is fetched. */
  readonly fetchProvider?: CatalogueFetcher;
}

/**
 * The catalogue.
 *
 * The catalogue holds **no secret and no credential**: it knows which models
 * exist, what they can do, and how they are spelled. The credential is
 * resolved elsewhere, and never by the catalogue.
 */
export class ModelCatalogue {
  readonly #snapshot: CatalogueDocument;
  readonly #local: CatalogueDocument | undefined;
  readonly #fetchProvider: CatalogueFetcher | undefined;
  readonly #fetched = new Map<string, CatalogueDocument>();
  readonly #bytes = new Map<string, string>();
  readonly #listeners = new Set<(change: CatalogueChange) => void>();
  #merged: CatalogueDocument | undefined;

  constructor(options: ModelCatalogueOptions) {
    this.#snapshot = options.snapshot;
    this.#local = options.local;
    this.#fetchProvider = options.fetchProvider;
  }

  /** The models a provider offers, after the three sources are merged. */
  models(providerId: string): readonly ModelEntry[] {
    return this.#mergedDocument().providers.find((entry) => entry.provider === providerId)?.models ?? [];
  }

  /** Every provider the catalogue knows. */
  providers(): readonly string[] {
    return this.#mergedDocument().providers.map((entry) => entry.provider);
  }

  /** Every model the catalogue knows. */
  all(): readonly ModelEntry[] {
    return this.#mergedDocument().providers.flatMap((entry) => entry.models);
  }

  /** The bytes the last successful fetch returned for a provider. */
  fetchedBytes(providerId: string): string | undefined {
    return this.#bytes.get(providerId);
  }

  /**
   * Fetch one provider's catalogue.
   *
   * A fetch that fails **degrades with its reason** and changes nothing: the
   * snapshot still stands, and the provider is simply not connected.
   */
  async refresh(provider: ProviderEntry): Promise<CatalogueRefresh> {
    if (!this.#fetchProvider) {
      return { changed: false, reason: 'no fetcher is configured, so no catalogue was fetched' };
    }
    let bytes: string;
    try {
      bytes = (await this.#fetchProvider(provider)).bytes;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { changed: false, reason: `the catalogue of "${provider.id}" could not be fetched: ${reason}` };
    }

    const cached = this.#bytes.get(provider.id);
    if (cached === bytes) {
      // The same bytes change nothing: not the cache, not the merge, and not
      // the notification. A watcher is not woken for a no-op.
      return { changed: false, reason: 'the catalogue did not change' };
    }

    let document: CatalogueDocument;
    try {
      document = parseCataloguePayload(JSON.parse(bytes), provider.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { changed: false, reason: `the catalogue of "${provider.id}" could not be read: ${reason}` };
    }

    this.#bytes.set(provider.id, bytes);
    this.#fetched.set(provider.id, document);
    this.#merged = undefined;
    this.#notify({ provider: provider.id });
    return { changed: true };
  }

  /** Watch the catalogue. The returned function stops watching. */
  subscribe(listener: (change: CatalogueChange) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The merged document, computed once per change. */
  #mergedDocument(): CatalogueDocument {
    if (this.#merged) return this.#merged;
    const fetched: CatalogueDocument = {
      providers: [...this.#fetched].flatMap(([, document]) => document.providers),
    };
    this.#merged = mergeCatalogues({
      ...(this.#local ? { local: this.#local } : {}),
      fetched,
      snapshot: this.#snapshot,
    });
    return this.#merged;
  }

  /** Wake the watchers. */
  #notify(change: CatalogueChange): void {
    for (const listener of [...this.#listeners]) listener(change);
  }
}

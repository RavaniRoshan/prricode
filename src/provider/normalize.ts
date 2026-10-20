/**
 * Driver-agnostic capability normalization.
 *
 * The target's catalog carries per-model metadata in three different shapes:
 * a `capabilities` **name list** (`adaptive_thinking`, `effort`,
 * `context_management`, …), a per-route `eager_input_streaming` map, and a
 * `max_output_tokens` table. The driver layer (CC-006) must not have to know
 * any of those shapes, so this module turns a catalog row plus a route into a
 * single flat object: the flags a driver asks about, the output-token bound
 * the request must respect, and the provider-specific id to send.
 *
 * Nothing here talks to a provider, a credential or the network: the catalog
 * is a table of facts, and this module only reads it.
 *
 * **The mantle fallback this module applies is half of the target's rule.**
 * The target's `wd(model)` also sends an `anthropic.*` model to `mantle` when
 * Bedrock and Mantle are both enabled. That half is implemented in
 * `src/provider/catalog.ts` and is decided by the **enabled-flag set**, which
 * this module does not take — so it is **off** here, exactly as it is for
 * every other two-argument caller. A caller that wants it passes the set in;
 * see the header of `src/provider/catalog.ts`.
 */

import {
  findModel,
  providerIdFor,
  resolveRouteForModel,
  type CatalogModel,
  type ModelCatalog,
} from './catalog.js';
import type { ProviderRoute } from './routes.js';

/**
 * A model, normalized for a route.
 *
 * The object is **driver-agnostic**: it names what a model can do and how big
 * its output may be, never how a request is encoded.
 */
export interface ModelCapabilities {
  /** The logical model id. */
  modelId: string;
  /** The model family. */
  family: string;
  /** The display name. */
  displayName: string;
  /** The knowledge cutoff, as the target writes it. */
  knowledgeCutoff?: string;
  /**
   * The route the model resolves to for the requested route.
   *
   * This is the target's `mantle` fallback: a model the requested route does
   * not serve resolves to `mantle` when `mantle` serves it.
   */
  route: ProviderRoute;
  /** The provider-specific model id to send. */
  providerId: string;
  /** The target's capability names, verbatim. */
  capabilities: string[];
  /** Whether the route streams the request body eagerly. */
  eagerInputStreaming: boolean;
  /** The default and the upper bound of the model's output tokens. */
  maxOutputTokens: { default: number; upper: number };
  /** The context window, when the target declares one. */
  contextWindow?: number;
  /** Whether the model has a native one-million-token context. */
  native1m: boolean;
  /** Whether the model supports the one-million-token beta. */
  supports1mBeta: boolean;
  /** Whether the model supports the one-million-token suffix. */
  supports1mSuffix: boolean;
  /** Whether the model supports adaptive thinking. */
  supportsThinking: boolean;
  /** Whether the model supports the effort parameter. */
  supportsEffort: boolean;
  /** Whether the model supports the `max` effort level. */
  supportsMaxEffort: boolean;
  /** Whether the model supports the `xhigh` effort level. */
  supportsXhighEffort: boolean;
  /** Whether the model supports context management. */
  supportsContextManagement: boolean;
  /** Whether the model supports fast mode. */
  supportsFastMode: boolean;
  /** The default effort level, when the target declares one. */
  defaultEffort?: string;
  /** The advisor rank, when the target declares one. */
  advisorRank?: number;
  /** The third-party fallback model id, when the target declares one. */
  fallback3p?: string;
  /** The image limits, when the target declares them. */
  imageLimits?: Record<string, unknown>;
  /** The Vertex region environment variable, when the target declares one. */
  vertexRegionEnvVar?: string;
  /** The pricing tier key. */
  pricing?: string;
}

/** Whether a model carries a capability name. */
export function hasCapability(model: CatalogModel, capability: string): boolean {
  return Array.isArray(model.capabilities) && model.capabilities.includes(capability);
}

/**
 * Normalize a catalog row for a route.
 *
 * Returns `undefined` when the model is served by neither the route nor
 * `mantle` — that is, when the model is not usable on this route at all.
 */
export function normalizeModel(
  model: CatalogModel,
  route: ProviderRoute,
): ModelCapabilities | undefined {
  const effectiveRoute = resolveRouteForModel(model, route);
  if (effectiveRoute === undefined) return undefined;

  const providerId = providerIdFor(model, effectiveRoute);
  if (providerId === undefined) return undefined;

  const capabilities: ModelCapabilities = {
    modelId: model.id,
    family: model.family,
    displayName: model.displayName,
    route: effectiveRoute,
    providerId,
    capabilities: Array.isArray(model.capabilities) ? [...model.capabilities] : [],
    eagerInputStreaming: model.eagerInputStreaming?.[effectiveRoute] === true,
    maxOutputTokens: {
      default: model.maxOutputTokens.default,
      upper: model.maxOutputTokens.upper,
    },
    native1m: model.context?.native1m === true,
    supports1mBeta: model.context?.supports1mBeta === true,
    supports1mSuffix: model.context?.supports1mSuffix === true,
    supportsThinking: hasCapability(model, 'adaptive_thinking'),
    supportsEffort: hasCapability(model, 'effort'),
    supportsMaxEffort: hasCapability(model, 'max_effort'),
    supportsXhighEffort: hasCapability(model, 'xhigh_effort'),
    supportsContextManagement: hasCapability(model, 'context_management'),
    supportsFastMode: hasCapability(model, 'fast_mode'),
  };

  if (model.knowledgeCutoff !== undefined) capabilities.knowledgeCutoff = model.knowledgeCutoff;
  if (model.context?.window !== undefined) capabilities.contextWindow = model.context.window;
  if (model.defaultEffort !== undefined) capabilities.defaultEffort = model.defaultEffort;
  if (model.advisorRank !== undefined) capabilities.advisorRank = model.advisorRank;
  if (model.fallback3p !== undefined) capabilities.fallback3p = model.fallback3p;
  if (model.imageLimits !== undefined) capabilities.imageLimits = { ...model.imageLimits };
  if (model.vertexRegionEnvVar !== undefined) {
    capabilities.vertexRegionEnvVar = model.vertexRegionEnvVar;
  }
  if (model.pricing !== undefined) capabilities.pricing = model.pricing;

  return capabilities;
}

/**
 * The models a route can actually use.
 *
 * A model the route does **not** serve is filtered out: the `providerIds` map
 * has no key for it, which means the provider does not serve that model. The
 * list is therefore the route's own menu, not the catalog's.
 */
export function usableModels(catalog: ModelCatalog, route: ProviderRoute): ModelCapabilities[] {
  if (!Array.isArray(catalog.models)) return [];
  const usable: ModelCapabilities[] = [];
  for (const model of catalog.models) {
    if (providerIdFor(model, route) === undefined) continue;
    const normalized = normalizeModel(model, route);
    if (normalized !== undefined) usable.push(normalized);
  }
  return usable;
}

/**
 * The normalized model with a logical id, or `undefined` when the route
 * cannot use it.
 */
export function normalizeModelFor(
  catalog: ModelCatalog,
  modelId: string,
  route: ProviderRoute,
): ModelCapabilities | undefined {
  const model = findModel(catalog, modelId);
  if (model === undefined) return undefined;
  return normalizeModel(model, route);
}

/**
 * The `max_tokens` a request may send for a model.
 *
 * The model's `max_output_tokens.upper` is the hard bound. A request that
 * asks for more is clamped down to it; a request that asks for nothing
 * usable falls back to the model's default.
 */
export function clampMaxTokens(model: CatalogModel, requested: number): number {
  const { default: fallback, upper } = model.maxOutputTokens;
  if (!Number.isFinite(requested) || requested <= 0) return fallback;
  const wanted = Math.trunc(requested);
  if (wanted > upper) return upper;
  if (wanted < 1) return fallback;
  return wanted;
}

/** The default `max_tokens` for a model. */
export function defaultMaxTokens(model: CatalogModel): number {
  return model.maxOutputTokens.default;
}

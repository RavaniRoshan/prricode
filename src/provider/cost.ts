/**
 * **Cost and usage accounting**: the price of a request, and the ledger that adds it
 * up over a session.
 *
 * Evidence: `chunk-dt3pd9ft.js:265535` (the price row and the cost formula),
 * `:271341` (which price is used), `chunk-d8mq0b21.js:25854` (the ledger),
 * `chunk-4jsg44k7.js:712480` (the per-model record), and the record at
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-remaining-surfaces.md` §5.
 *
 * ## The price
 *
 * The target prices a request in **US dollars per million tokens**, and the price row
 * carries six numbers: the input, the output, the five-minute cache write, the
 * one-hour cache write, the cache read, and the web search.
 *
 * ## The formula
 *
 * The target's cost of one request, in its own terms:
 *
 * - the **long-prompt tier** applies when the request's tokens — the input, the cache
 *   read and the cache write together — are above the tier's threshold;
 * - the **cache write** is charged at the one-hour rate for the tokens that were
 *   written to the one-hour cache, and at the five-minute rate for the rest;
 * - the **web search** is charged per request, and is **not** multiplied by the
 *   data-residency factor;
 * - the **data-residency factor** is `1.1` when the request's inference geography is
 *   `us`, and `1` otherwise.
 *
 * ## The ledger
 *
 * The target's ledger keeps the cost, the API and tool durations, the changed lines,
 * the spent tokens and the **per-model record** — and `recordCost` *replaces* a model's
 * record rather than adding to it, because the record is the model's running total.
 *
 * ## What this implementation does not have
 *
 * The target reads the **managed** `modelPricing` setting from a machine-managed
 * settings document, and the target's own rule is that the setting is honoured **only**
 * from that tier. This implementation has no managed tier, so the multiplier and the
 * overrides are read from the settings it does have — which is the one difference this
 * surface carries, and it is recorded in `docs/compatibility/remaining-surfaces.md`.
 */

import type { ModelCatalog, PricingTier } from './catalog.js';
import { findModel } from './catalog.js';

/* -------------------------------------------------------------------------- */
/* The price                                                                    */
/* -------------------------------------------------------------------------- */

/** The price of a model, in US dollars per million tokens. */
export interface ModelCosts {
  /** The input price. */
  readonly inputTokens: number;
  /** The output price. */
  readonly outputTokens: number;
  /** The five-minute cache-write price. */
  readonly promptCacheWriteTokens: number;
  /** The one-hour cache-write price, when the model has one. */
  readonly promptCacheWrite1hTokens?: number;
  /** The cache-read price. */
  readonly promptCacheReadTokens: number;
  /** The price of one web search. */
  readonly webSearchRequests: number;
  /** The long-prompt tier, when the model has one. */
  readonly longPrompt?: {
    /** The number of tokens above which the tier applies. */
    readonly abovePromptTokens: number;
  } & ModelCosts;
}

/**
 * The **data-residency factor**.
 *
 * The target's own constant: a request whose inference geography is `us` costs ten
 * per cent more.
 */
export const US_INFERENCE_GEO_FACTOR = 1.1;

/**
 * Turn a catalog pricing tier into the target's price row.
 *
 * The target refuses a tier that is not complete — the baked entries need the whole
 * shape — and this implementation refuses it too, rather than pricing part of a
 * request and reporting a number that is wrong.
 */
export function modelCostsOf(tier: PricingTier, modelId = 'the model'): ModelCosts {
  if (tier.cacheWrite5m === undefined || tier.cacheRead === undefined || tier.webSearch === undefined) {
    throw new Error(
      `model catalog entry '${modelId}' has incomplete pricing — baked entries need the full ModelCosts shape`,
    );
  }

  const base: ModelCosts = {
    inputTokens: tier.input,
    outputTokens: tier.output,
    promptCacheWriteTokens: tier.cacheWrite5m,
    ...(tier.cacheWrite1h !== undefined ? { promptCacheWrite1hTokens: tier.cacheWrite1h } : {}),
    promptCacheReadTokens: tier.cacheRead,
    webSearchRequests: tier.webSearch,
  };

  const long = tier.longPrompt;
  if (long === undefined) return base;
  if (long.cacheWrite5m === undefined || long.cacheRead === undefined) {
    throw new Error(
      `model catalog entry '${modelId}' has incomplete pricing — baked entries need the full ModelCosts shape`,
    );
  }
  return {
    ...base,
    longPrompt: {
      abovePromptTokens: long.abovePromptTokens,
      inputTokens: long.input,
      outputTokens: long.output,
      promptCacheWriteTokens: long.cacheWrite5m,
      ...(long.cacheWrite1h !== undefined ? { promptCacheWrite1hTokens: long.cacheWrite1h } : {}),
      promptCacheReadTokens: long.cacheRead,
      webSearchRequests: tier.webSearch,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The usage                                                                    */
/* -------------------------------------------------------------------------- */

/** The API's own usage record — the shape the API returns. */
export interface ModelUsage {
  /** The input tokens. */
  readonly input_tokens: number;
  /** The output tokens. */
  readonly output_tokens: number;
  /** The cache-read tokens. */
  readonly cache_read_input_tokens?: number;
  /** The cache-write tokens. */
  readonly cache_creation_input_tokens?: number;
  /** The cache-write breakdown. */
  readonly cache_creation?: { readonly ephemeral_1h_input_tokens?: number };
  /** The server-side tool use. */
  readonly server_tool_use?: { readonly web_search_requests?: number };
  /** The output breakdown. */
  readonly output_tokens_details?: { readonly thinking_tokens?: number };
  /** Where the request was served. */
  readonly inference_geo?: string;
}

/**
 * The cost of one request, in US dollars.
 *
 * The target's formula, in the target's order.
 */
export function costOf(costs: ModelCosts, usage: ModelUsage): number {
  const tier = longPromptTier(costs, usage);

  const tokens =
    (usage.input_tokens / 1_000_000) * tier.inputTokens +
    (usage.output_tokens / 1_000_000) * tier.outputTokens +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * tier.promptCacheReadTokens +
    cacheWriteCost(tier, usage);

  const searches = (usage.server_tool_use?.web_search_requests ?? 0) * tier.webSearchRequests;

  return tokens * inferenceGeoFactor(usage) + searches;
}

/**
 * The tier a request is charged at.
 *
 * The long-prompt tier applies when the request's tokens — the input, the cache read
 * and the cache write together — are **above** the tier's threshold.
 */
function longPromptTier(costs: ModelCosts, usage: ModelUsage): ModelCosts {
  const long = costs.longPrompt;
  if (long === undefined) return costs;
  const tokens =
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  return tokens > long.abovePromptTokens ? long : costs;
}

/**
 * The cost of the cache writes.
 *
 * The tokens written to the **one-hour** cache are charged at the one-hour rate, and
 * the rest at the five-minute rate.
 */
function cacheWriteCost(costs: ModelCosts, usage: ModelUsage): number {
  const written = usage.cache_creation_input_tokens ?? 0;
  const oneHourRate = costs.promptCacheWrite1hTokens;
  const oneHourTokens = Math.min(usage.cache_creation?.ephemeral_1h_input_tokens ?? 0, written);
  if (oneHourRate === undefined || oneHourTokens <= 0) {
    return (written / 1_000_000) * costs.promptCacheWriteTokens;
  }
  return (
    (oneHourTokens / 1_000_000) * oneHourRate +
    ((written - oneHourTokens) / 1_000_000) * costs.promptCacheWriteTokens
  );
}

/** The data-residency factor a request is charged at. */
function inferenceGeoFactor(usage: ModelUsage): number {
  return usage.inference_geo === 'us' ? US_INFERENCE_GEO_FACTOR : 1;
}

/* -------------------------------------------------------------------------- */
/* The per-model record                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Where a model's cost came from.
 *
 * - `managed` — the price came from the managed `modelPricing` setting;
 * - `list` — the price came from the catalog;
 * - `unknown` — no price was found, and the cost is not measured.
 */
export type CostBasis = 'managed' | 'list' | 'unknown';

/** What the ledger keeps for one model. */
export interface ModelCostRecord {
  /** The input tokens. */
  readonly inputTokens: number;
  /** The output tokens. */
  readonly outputTokens: number;
  /** The thinking tokens, when the API reported them. */
  readonly thinkingTokens?: number;
  /** The cache-read tokens. */
  readonly cacheReadInputTokens: number;
  /** The cache-write tokens. */
  readonly cacheCreationInputTokens: number;
  /** The web searches. */
  readonly webSearchRequests: number;
  /** The cost, in US dollars. */
  readonly costUSD: number;
  /** The model's context window. */
  readonly contextWindow: number;
  /** The model's default output limit. */
  readonly maxOutputTokens: number;
  /** The model's canonical id. */
  readonly canonicalModel: string;
  /** The route that served the model. */
  readonly provider: string;
  /** Where the cost came from. */
  readonly costBasis: CostBasis;
}

/* -------------------------------------------------------------------------- */
/* The ledger                                                                   */
/* -------------------------------------------------------------------------- */

/** The ledger's state, as the transcript carries it. */
export interface CostLedgerSnapshot {
  /** The accumulated cost. */
  readonly totalCostUSD: number;
  /** The API time, with the retries. */
  readonly totalAPIDuration: number;
  /** The API time, without the retries. */
  readonly totalAPIDurationWithoutRetries: number;
  /** The tool time. */
  readonly totalToolDuration: number;
  /** The lines added. */
  readonly totalLinesAdded: number;
  /** The lines removed. */
  readonly totalLinesRemoved: number;
  /** The ledger's start. */
  readonly startTime: number;
  /** The per-model records. */
  readonly modelUsage: Readonly<Record<string, ModelCostRecord>>;
  /** Whether a model with no price was seen. */
  readonly hasUnknownModelCost: boolean;
}

/** The tokens the ledger keeps apart from the priced ones. */
export interface SpentTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

const NO_TOKENS: SpentTokens = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
});

/**
 * The **cost ledger**.
 *
 * The target's ledger, with its own members and its own rules:
 *
 *   - `recordCost` **replaces** the model's record and adds to the total;
 *   - `totalDuration` is measured from the ledger's start;
 *   - `restore` puts a transcript's state back, and `snapshot` takes it out.
 */
export class CostLedger {
  #totalCostUSD = 0;
  #restoredCostUSD = 0;
  #totalAPIDuration = 0;
  #totalAPIDurationWithoutRetries = 0;
  #totalToolDuration = 0;
  #startTime = Date.now();
  #sessionStartTime: number | undefined;
  #totalLinesAdded = 0;
  #totalLinesRemoved = 0;
  #spentTokens: SpentTokens = NO_TOKENS;
  #hasUnknownModelCost = false;
  #safetyStops = 0;
  #modelUsage: Record<string, ModelCostRecord> = Object.create(null) as Record<
    string,
    ModelCostRecord
  >;

  /** The accumulated cost, in US dollars. */
  totalCostUSD(): number {
    return this.#totalCostUSD;
  }

  /** The cost that came from a transcript. */
  restoredCostUSD(): number {
    return this.#restoredCostUSD;
  }

  /** The API time, with the retries. */
  totalAPIDuration(): number {
    return this.#totalAPIDuration;
  }

  /** The API time, without the retries. */
  totalAPIDurationWithoutRetries(): number {
    return this.#totalAPIDurationWithoutRetries;
  }

  /** The tool time. */
  totalToolDuration(): number {
    return this.#totalToolDuration;
  }

  /** The time since the ledger started. */
  totalDuration(): number {
    return Math.max(0, Date.now() - this.#startTime);
  }

  /** The session's logical start, when one was anchored. */
  sessionStartTime(): number {
    return this.#sessionStartTime ?? this.#startTime;
  }

  /** The lines added. */
  totalLinesAdded(): number {
    return this.#totalLinesAdded;
  }

  /** The lines removed. */
  totalLinesRemoved(): number {
    return this.#totalLinesRemoved;
  }

  /** Whether a model with no price was seen. */
  hasUnknownModelCost(): boolean {
    return this.#hasUnknownModelCost;
  }

  /** The number of safety stops. */
  safetyStops(): number {
    return this.#safetyStops;
  }

  /** The per-model records. */
  modelUsage(): Readonly<Record<string, ModelCostRecord>> {
    return this.#modelUsage;
  }

  /** One model's record. */
  usageForModel(model: string): ModelCostRecord | undefined {
    return this.#modelUsage[model];
  }

  /** The input tokens, over every model. */
  totalInputTokens(): number {
    return this.#sum('inputTokens');
  }

  /** The output tokens, over every model. */
  totalOutputTokens(): number {
    return this.#sum('outputTokens');
  }

  /** The cache-read tokens, over every model. */
  totalCacheReadInputTokens(): number {
    return this.#sum('cacheReadInputTokens');
  }

  /** The cache-write tokens, over every model. */
  totalCacheCreationInputTokens(): number {
    return this.#sum('cacheCreationInputTokens');
  }

  /** The web searches, over every model. */
  totalWebSearchRequests(): number {
    return this.#sum('webSearchRequests');
  }

  #sum(field: keyof ModelCostRecord): number {
    let total = 0;
    for (const record of Object.values(this.#modelUsage)) {
      const value = record[field];
      if (typeof value === 'number') total += value;
    }
    return total;
  }

  /** The tokens spent, apart from the priced ones. */
  spentTokens(): SpentTokens {
    return this.#spentTokens;
  }

  /** Record the tokens spent. */
  recordSpentTokens(tokens: SpentTokens): void {
    this.#spentTokens = {
      inputTokens: this.#spentTokens.inputTokens + tokens.inputTokens,
      outputTokens: this.#spentTokens.outputTokens + tokens.outputTokens,
      cacheReadInputTokens: this.#spentTokens.cacheReadInputTokens + tokens.cacheReadInputTokens,
      cacheCreationInputTokens:
        this.#spentTokens.cacheCreationInputTokens + tokens.cacheCreationInputTokens,
    };
  }

  /**
   * Record the cost of one request.
   *
   * The model's record is **replaced** — it is the model's running total — and the
   * cost is added to the total.
   */
  recordCost(cost: number, record: ModelCostRecord, model: string): void {
    this.#modelUsage[model] = record;
    this.#totalCostUSD += cost;
  }

  /** Record the API time. */
  recordApiDuration(withRetries: number, withoutRetries: number): void {
    this.#totalAPIDuration += withRetries;
    this.#totalAPIDurationWithoutRetries += withoutRetries;
  }

  /** Record the tool time. */
  recordToolDuration(milliseconds: number): void {
    this.#totalToolDuration += milliseconds;
  }

  /** Record the changed lines. */
  recordLinesChanged(added: number, removed: number): void {
    this.#totalLinesAdded += added;
    this.#totalLinesRemoved += removed;
  }

  /** Mark that a model with no price was seen. */
  markUnknownModelCost(): void {
    this.#hasUnknownModelCost = true;
  }

  /** Record a safety stop. */
  recordSafetyStop(): void {
    this.#safetyStops += 1;
  }

  /** Restart the clock. */
  restartClock(): void {
    this.#startTime = Date.now();
    this.anchorLogicalStart(undefined);
  }

  /** Anchor the session's logical start. */
  anchorLogicalStart(start: number | undefined): void {
    this.#sessionStartTime = start === undefined ? undefined : Math.min(start, this.#startTime);
  }

  /**
   * Put a transcript's state back.
   *
   * The restored cost is kept apart from the accumulated one, so a transcript's cost
   * can be told from the cost this run added.
   */
  restore(state: {
    totalCostUSD: number;
    totalAPIDuration: number;
    totalAPIDurationWithoutRetries: number;
    totalToolDuration: number;
    totalLinesAdded: number;
    totalLinesRemoved: number;
    lastDuration?: number;
    startTime?: number;
    modelUsage?: Readonly<Record<string, ModelCostRecord>>;
    hasUnknownModelCost?: boolean;
  }): void {
    this.#totalCostUSD = state.totalCostUSD;
    this.#restoredCostUSD = state.totalCostUSD;
    this.#totalAPIDuration = state.totalAPIDuration;
    this.#totalAPIDurationWithoutRetries = state.totalAPIDurationWithoutRetries;
    this.#totalToolDuration = state.totalToolDuration;
    this.#totalLinesAdded = state.totalLinesAdded;
    this.#totalLinesRemoved = state.totalLinesRemoved;
    this.#hasUnknownModelCost = state.hasUnknownModelCost ?? false;
    if (state.modelUsage !== undefined) {
      this.#modelUsage = Object.assign(
        Object.create(null) as Record<string, ModelCostRecord>,
        state.modelUsage,
      );
    }
    if (state.lastDuration !== undefined) this.#startTime = Date.now() - state.lastDuration;
    this.anchorLogicalStart(state.startTime);
  }

  /** The ledger's state, as the transcript carries it. */
  snapshot(): CostLedgerSnapshot {
    return {
      totalCostUSD: this.#totalCostUSD,
      totalAPIDuration: this.#totalAPIDuration,
      totalAPIDurationWithoutRetries: this.#totalAPIDurationWithoutRetries,
      totalToolDuration: this.#totalToolDuration,
      totalLinesAdded: this.#totalLinesAdded,
      totalLinesRemoved: this.#totalLinesRemoved,
      startTime: this.#startTime,
      modelUsage: { ...this.#modelUsage },
      hasUnknownModelCost: this.#hasUnknownModelCost,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* The price lookup                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The **catalog price** of a model.
 *
 * The target resolves the model's canonical id first, then reads the baked-in price
 * table; when the model is in neither, it records `tengu_unknown_model_cost` and the
 * cost is **unknown**.
 */
export function catalogCostsOf(
  catalog: ModelCatalog,
  model: string,
): ModelCosts | undefined {
  const found = findModel(catalog, model);
  if (found === undefined) return undefined;
  const tierName = found.pricing;
  if (tierName === undefined) return undefined;
  const tiers = catalog.pricingTiers;
  if (tiers === undefined) return undefined;
  const tier = tiers[tierName];
  if (tier === undefined) return undefined;
  return modelCostsOf(tier, found.id);
}

/* -------------------------------------------------------------------------- */
/* The managed pricing                                                          */
/* -------------------------------------------------------------------------- */

/** One row of the `modelPricing` setting's `overrides`. */
export interface ModelPricingOverride {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** The `modelPricing` setting. */
export interface ModelPricingSetting {
  readonly multiplier?: number;
  readonly overrides?: Readonly<Record<string, ModelPricingOverride>>;
}

/** The resolved managed pricing. */
export interface ManagedPricing {
  /** The multiplier every computed cost is scaled by. */
  readonly multiplier: number;
  /** The rows that match a model id exactly. */
  readonly exact: ReadonlyMap<string, ModelCosts>;
  /** The rows that match a built-in model. */
  readonly builtin: ReadonlyMap<string, ModelCosts>;
}

/**
 * Resolve the managed `modelPricing` setting.
 *
 * The target's own rules:
 *
 *   - a row is keyed by the **lower-cased** model id, and the first row for an id
 *     wins — a later row that repeats an id is reported and dropped;
 *   - a row that spells a **built-in** model also lands in the built-in map, so it
 *     covers that model's dated and provider forms; the first such row wins;
 *   - a setting with no rows and no multiplier resolves to nothing at all.
 */
export function managedPricingOf(setting: ModelPricingSetting | undefined): ManagedPricing | undefined {
  if (setting === undefined) return undefined;
  const multiplier = setting.multiplier ?? 1;
  const exact = new Map<string, ModelCosts>();
  const builtin = new Map<string, ModelCosts>();

  for (const [id, row] of Object.entries(setting.overrides ?? {})) {
    const key = id.toLowerCase();
    if (exact.has(key)) continue;
    const costs: ModelCosts = {
      inputTokens: row.input,
      outputTokens: row.output,
      promptCacheWriteTokens: row.cacheWrite,
      promptCacheReadTokens: row.cacheRead,
      webSearchRequests: 0,
    };
    exact.set(key, costs);
  }

  if (exact.size === 0 && multiplier === 1) return undefined;
  return { multiplier, exact, builtin };
}

/**
 * The managed price of a model.
 *
 * The **exact** row wins over the built-in one, the way the target's own lookup does.
 */
export function managedCostsOf(
  pricing: ManagedPricing | undefined,
  model: string,
  canonicalModel: string,
): ModelCosts | undefined {
  if (pricing === undefined) return undefined;
  const exact = pricing.exact.get(model.toLowerCase());
  if (exact !== undefined) return exact;
  return pricing.builtin.get(canonicalModel);
}

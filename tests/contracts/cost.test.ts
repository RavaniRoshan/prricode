/**
 * Contract test: the **cost and usage accounting** — the price of a request, the
 * ledger, and the result document's cost members.
 *
 * Evidence: `chunk-dt3pd9ft.js:265535` (the price row and the cost formula),
 * `:271341` (which price is used), `chunk-d8mq0b21.js:25854` (the ledger),
 * `chunk-4jsg44k7.js:712480` (the per-model record), and the record at
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-remaining-surfaces.md` §5.
 */

import { describe, expect, it } from 'vitest';

import { buildResultDocument, costOfTurn } from '../../src/cli/headless.js';
import { builtinCatalog, findModel } from '../../src/provider/catalog.js';
import {
  CostLedger,
  US_INFERENCE_GEO_FACTOR,
  catalogCostsOf,
  costOf,
  managedCostsOf,
  managedPricingOf,
  modelCostsOf,
  type ModelCosts,
} from '../../src/provider/cost.js';

const COSTS: ModelCosts = {
  inputTokens: 3,
  outputTokens: 15,
  promptCacheWriteTokens: 3.75,
  promptCacheWrite1hTokens: 6,
  promptCacheReadTokens: 0.3,
  webSearchRequests: 0.01,
};

describe('the cost of a request', () => {
  it('charges the input and the output per million tokens', () => {
    const cost = costOf(COSTS, { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(cost).toBeCloseTo(18, 10);
  });

  it('charges the cache read and the cache write', () => {
    const cost = costOf(COSTS, {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.3 + 3.75, 10);
  });

  it('charges the one-hour cache writes at the one-hour rate', () => {
    const cost = costOf(COSTS, {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_1h_input_tokens: 1_000_000 },
    });
    expect(cost).toBeCloseTo(6, 10);
  });

  it('charges the two cache-write rates apart', () => {
    const cost = costOf(COSTS, {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_1h_input_tokens: 400_000 },
    });
    expect(cost).toBeCloseTo(0.4 * 6 + 0.6 * 3.75, 10);
  });

  it('charges the web searches, and does not multiply them by the residency factor', () => {
    const cost = costOf(
      COSTS,
      {
        input_tokens: 0,
        output_tokens: 0,
        server_tool_use: { web_search_requests: 10 },
      },
      // The residency factor applies to the tokens, not to the searches.
    );
    expect(cost).toBeCloseTo(0.1, 10);

    const resident = costOf(
      COSTS,
      {
        input_tokens: 1_000_000,
        output_tokens: 0,
        inference_geo: 'us',
        server_tool_use: { web_search_requests: 10 },
      },
    );
    expect(resident).toBeCloseTo(3 * US_INFERENCE_GEO_FACTOR + 0.1, 10);
  });

  it('multiplies the tokens by the data-residency factor when the geography is us', () => {
    const cost = costOf(COSTS, { input_tokens: 1_000_000, output_tokens: 0, inference_geo: 'us' });
    expect(cost).toBeCloseTo(3 * 1.1, 10);
  });

  it('charges the long-prompt tier only above its threshold', () => {
    const costs: ModelCosts = {
      ...COSTS,
      longPrompt: {
        abovePromptTokens: 1000,
        inputTokens: 6,
        outputTokens: 22.5,
        promptCacheWriteTokens: 7.5,
        promptCacheWrite1hTokens: 12,
        promptCacheReadTokens: 0.6,
        webSearchRequests: 0.01,
      },
    };
    expect(costOf(costs, { input_tokens: 1000, output_tokens: 0 })).toBeCloseTo(0.003, 10);
    expect(costOf(costs, { input_tokens: 1001, output_tokens: 0 })).toBeCloseTo(0.006006, 10);
  });

  it('refuses a price row that is not complete', () => {
    expect(() => modelCostsOf({ input: 3, output: 15 })).toThrow(/incomplete pricing/);
  });
});

describe('the catalog price', () => {
  it('reads the price of a model the catalog knows', () => {
    const costs = catalogCostsOf(builtinCatalog, 'claude-sonnet-4-5');
    expect(costs).toBeDefined();
    expect(costs?.inputTokens).toBeGreaterThan(0);
  });

  it('answers nothing for a model the catalog does not know', () => {
    expect(catalogCostsOf(builtinCatalog, 'not-a-model')).toBeUndefined();
  });

  it('answers nothing for a model with no pricing tier', () => {
    const model = findModel(builtinCatalog, 'claude-sonnet-4-5');
    expect(model?.pricing).toBeDefined();
  });
});

describe('the managed pricing', () => {
  it('resolves nothing for a setting with no rows and no multiplier', () => {
    expect(managedPricingOf({})).toBeUndefined();
    expect(managedPricingOf(undefined)).toBeUndefined();
  });

  it('keys a row by the lower-cased model id', () => {
    const pricing = managedPricingOf({
      overrides: { 'CLAUDE-SONNET-4-5': { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
    });
    expect(pricing?.exact.size).toBe(1);
    expect(managedCostsOf(pricing, 'claude-sonnet-4-5', 'claude-sonnet-4-5')?.inputTokens).toBe(1);
  });

  it('keeps the multiplier', () => {
    expect(managedPricingOf({ multiplier: 0.85 })?.multiplier).toBe(0.85);
  });

  it('drops a row that repeats an earlier id', () => {
    const pricing = managedPricingOf({
      overrides: {
        'claude-sonnet-4-5': { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        'CLAUDE-SONNET-4-5': { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 },
      },
    });
    expect(pricing?.exact.size).toBe(1);
    expect(managedCostsOf(pricing, 'claude-sonnet-4-5', 'claude-sonnet-4-5')?.inputTokens).toBe(1);
  });
});

describe('the cost ledger', () => {
  function record(costUSD: number): Parameters<CostLedger['recordCost']>[1] {
    return {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 7,
      webSearchRequests: 0,
      costUSD,
      contextWindow: 200000,
      maxOutputTokens: 64000,
      canonicalModel: 'claude-sonnet-4-5',
      provider: 'firstParty',
      costBasis: 'list',
    };
  }

  it('adds the cost to the total', () => {
    const ledger = new CostLedger();
    ledger.recordCost(0.5, record(0.5), 'claude-sonnet-4-5');
    ledger.recordCost(0.25, record(0.25), 'claude-sonnet-4-5');
    expect(ledger.totalCostUSD()).toBeCloseTo(0.75, 10);
  });

  it('replaces a model\'s record rather than adding to it', () => {
    const ledger = new CostLedger();
    ledger.recordCost(0.5, record(0.5), 'claude-sonnet-4-5');
    ledger.recordCost(0.75, record(0.75), 'claude-sonnet-4-5');
    expect(ledger.usageForModel('claude-sonnet-4-5')?.costUSD).toBeCloseTo(0.75, 10);
    expect(ledger.totalCostUSD()).toBeCloseTo(1.25, 10);
  });

  it('sums the tokens over every model', () => {
    const ledger = new CostLedger();
    ledger.recordCost(0.5, record(0.5), 'a');
    ledger.recordCost(0.5, record(0.5), 'b');
    expect(ledger.totalInputTokens()).toBe(200);
    expect(ledger.totalOutputTokens()).toBe(40);
    expect(ledger.totalCacheReadInputTokens()).toBe(10);
    expect(ledger.totalCacheCreationInputTokens()).toBe(14);
  });

  it('records the durations, the lines and the safety stops', () => {
    const ledger = new CostLedger();
    ledger.recordApiDuration(100, 80);
    ledger.recordToolDuration(20);
    ledger.recordLinesChanged(3, 1);
    ledger.recordSafetyStop();
    expect(ledger.totalAPIDuration()).toBe(100);
    expect(ledger.totalAPIDurationWithoutRetries()).toBe(80);
    expect(ledger.totalToolDuration()).toBe(20);
    expect(ledger.totalLinesAdded()).toBe(3);
    expect(ledger.totalLinesRemoved()).toBe(1);
    expect(ledger.safetyStops()).toBe(1);
  });

  it('marks an unknown model cost', () => {
    const ledger = new CostLedger();
    expect(ledger.hasUnknownModelCost()).toBe(false);
    ledger.markUnknownModelCost();
    expect(ledger.hasUnknownModelCost()).toBe(true);
  });

  it('keeps the spent tokens apart from the priced ones', () => {
    const ledger = new CostLedger();
    ledger.recordSpentTokens({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4,
    });
    expect(ledger.spentTokens().inputTokens).toBe(10);
    expect(ledger.totalInputTokens()).toBe(0);
  });

  it('restores a transcript\'s state and keeps the restored cost apart', () => {
    const ledger = new CostLedger();
    ledger.restore({
      totalCostUSD: 1.5,
      totalAPIDuration: 10,
      totalAPIDurationWithoutRetries: 8,
      totalToolDuration: 2,
      totalLinesAdded: 4,
      totalLinesRemoved: 2,
      modelUsage: { 'claude-sonnet-4-5': record(1.5) },
    });
    expect(ledger.totalCostUSD()).toBeCloseTo(1.5, 10);
    expect(ledger.restoredCostUSD()).toBeCloseTo(1.5, 10);
    expect(ledger.totalLinesAdded()).toBe(4);
    expect(ledger.usageForModel('claude-sonnet-4-5')?.costUSD).toBeCloseTo(1.5, 10);
  });

  it('takes a snapshot of its state', () => {
    const ledger = new CostLedger();
    ledger.recordCost(0.5, record(0.5), 'claude-sonnet-4-5');
    const snapshot = ledger.snapshot();
    expect(snapshot.totalCostUSD).toBeCloseTo(0.5, 10);
    expect(snapshot.modelUsage['claude-sonnet-4-5']?.costUSD).toBeCloseTo(0.5, 10);
  });
});

describe('the result document', () => {
  it('carries the cost and the per-model usage', () => {
    const document = buildResultDocument({
      isError: false,
      result: 'hello',
      stopReason: null,
      sessionId: 'session-1',
      durationMs: 10,
      numTurns: 1,
      usage: {
        output_tokens_details: { thinking_tokens: 0 },
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: 'standard',
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
        inference_geo: '',
        iterations: [],
        speed: 'standard',
        fallback_credit: null,
      },
      totalCostUsd: 0.25,
      modelUsage: {
        'claude-sonnet-4-5': {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.25,
          contextWindow: 200000,
          maxOutputTokens: 64000,
          canonicalModel: 'claude-sonnet-4-5',
          provider: 'firstParty',
          costBasis: 'list',
        },
      },
      permissionDenials: [],
      uuid: 'uuid-1',
    });

    expect(document.total_cost_usd).toBe(0.25);
    expect(document.modelUsage['claude-sonnet-4-5']?.costUSD).toBe(0.25);
  });

  it('prices a turn out of the catalog', () => {
    const cost = costOfTurn('claude-sonnet-4-5', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    expect(cost.totalCostUsd).toBeGreaterThan(0);
    expect(cost.modelUsage['claude-sonnet-4-5']?.costUSD).toBeCloseTo(cost.totalCostUsd, 10);
  });

  it('measures nothing for a model the catalog does not know', () => {
    const cost = costOfTurn('not-a-model', {
      inputTokens: 1000,
      outputTokens: 1000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    expect(cost.totalCostUsd).toBe(0);
    expect(cost.modelUsage).toEqual({});
  });
});

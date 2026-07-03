// lib/agents/pricing.ts
//
// Blooming-side Anthropic pricing helper. AptKit's `estimateCost` only
// knows OpenAI pricing (see @aptkit/runtime/usage-ledger.js), so any call
// with `provider === 'anthropic'` returns `undefined`. This module fills
// that gap while keeping the API surface compatible with aptkit's shape:
// pass a usage-summary and a model name, receive a CostEstimate.
//
// Prices are per-million-tokens (MTok) in USD. Do NOT include cache-tier
// pricing here — Phase 2 receipts capture only `inputTokens`/`outputTokens`
// (aptkit's model_usage event shape), which already exclude cache-read
// tokens from the input count. Cost estimated here is therefore an
// UPPER BOUND when caching is on.

import type { CostEstimate, TokenUsageSummary } from '@aptkit/core';

type AnthropicPricing = {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

/**
 * Per-million-token prices for Anthropic model families used by blooming.
 * Update when Anthropic changes pricing; add rows for new families.
 */
const ANTHROPIC_PRICING: readonly [RegExp, AnthropicPricing][] = [
  // Sonnet family (4 / 4.5 / 4.6) — $3 in, $15 out per MTok
  [/^claude-sonnet-4/, { inputUsdPerMillion: 3, outputUsdPerMillion: 15 }],
  // Haiku 4.5 — $1 in, $5 out per MTok
  [/^claude-haiku-4/, { inputUsdPerMillion: 1, outputUsdPerMillion: 5 }],
  // Opus 4.7 — $15 in, $75 out per MTok (unused today; here for completeness)
  [/^claude-opus-4/, { inputUsdPerMillion: 15, outputUsdPerMillion: 75 }],
];

/**
 * Provider-neutral entrypoint. Returns aptkit-shaped `CostEstimate` for
 * Anthropic models; falls through to `undefined` for unknown models so
 * report code can degrade gracefully.
 */
export function estimateAnthropicCost(
  usage: Pick<TokenUsageSummary, 'inputTokens' | 'outputTokens'>,
  modelName: string,
): CostEstimate | undefined {
  const normalized = modelName.toLowerCase();
  for (const [pattern, pricing] of ANTHROPIC_PRICING) {
    if (pattern.test(normalized)) {
      const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputUsdPerMillion;
      const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputUsdPerMillion;
      return {
        currency: 'USD',
        inputCost,
        outputCost,
        totalCost: inputCost + outputCost,
        inputUsdPerMillion: pricing.inputUsdPerMillion,
        outputUsdPerMillion: pricing.outputUsdPerMillion,
        estimated: true,
      };
    }
  }
  return undefined;
}

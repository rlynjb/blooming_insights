// lib/agents/budget.ts
//
// Phase-3 per-investigation budget ceiling.
//
// Design: a BudgetTracker is created once per investigation by the caller
// (route handler or eval runner), then passed as an optional hook through
// AgentHooks → AnthropicModelProviderAdapter. Each model turn checks the
// tracker BEFORE dispatching to the Anthropic API; if the accumulated
// spend has already exceeded the ceiling, the adapter throws
// BudgetExceededError instead of making the call. That error propagates
// up through AptKit's agent loop → the DiagnosticAgent / RecommendationAgent
// wrapper → the route handler's try/catch, which emits a graceful NDJSON
// `error` event (existing path).
//
// The tracker is intentionally simple: no per-agent breakdown, no cache-
// tier accounting (aptkit's model_usage event doesn't expose cache tokens).
// Cost math uses Blooming's pricing helper — same numbers as the report.

import { estimateAnthropicCost } from './pricing';

export type BudgetLimit = {
  /** Optional hard cap on total input+output tokens. */
  maxTokens?: number;
  /** Optional hard cap on total estimated USD spend. */
  maxCostUsd?: number;
};

export type BudgetSnapshot = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turns: number;
  estimatedCostUsd: number;
};

/**
 * Accumulates token usage across all model turns within one investigation.
 * Read-only from the model provider's perspective — the adapter calls
 * `add()` after each response and `exceeded()` before the next call.
 */
export class BudgetTracker {
  private inputTokens = 0;
  private outputTokens = 0;
  private turns = 0;

  constructor(
    public readonly limit: BudgetLimit,
    private readonly modelName: string = 'claude-sonnet-4-6',
  ) {}

  add(usage: { inputTokens: number; outputTokens: number }): void {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.turns += 1;
  }

  snapshot(): BudgetSnapshot {
    const est = estimateAnthropicCost(
      { inputTokens: this.inputTokens, outputTokens: this.outputTokens },
      this.modelName,
    );
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      turns: this.turns,
      estimatedCostUsd: est?.totalCost ?? 0,
    };
  }

  exceeded(): boolean {
    const s = this.snapshot();
    if (this.limit.maxTokens != null && s.totalTokens > this.limit.maxTokens) return true;
    if (this.limit.maxCostUsd != null && s.estimatedCostUsd > this.limit.maxCostUsd) return true;
    return false;
  }
}

/**
 * Thrown by AnthropicModelProviderAdapter.complete() when the tracker
 * has already exceeded its limit BEFORE the next model turn dispatches.
 * The route handler's error path emits this as a graceful NDJSON `error`
 * event; the eval runner surfaces it as a receipt field.
 */
export class BudgetExceededError extends Error {
  constructor(
    public readonly snapshot: BudgetSnapshot,
    public readonly limit: BudgetLimit,
  ) {
    super(
      `Investigation budget exceeded: ${snapshot.totalTokens} tokens / $${snapshot.estimatedCostUsd.toFixed(3)} vs limit ${limitToString(limit)}`,
    );
    this.name = 'BudgetExceededError';
  }
}

function limitToString(limit: BudgetLimit): string {
  const parts: string[] = [];
  if (limit.maxTokens != null) parts.push(`${limit.maxTokens} tokens`);
  if (limit.maxCostUsd != null) parts.push(`$${limit.maxCostUsd.toFixed(3)}`);
  return parts.length > 0 ? parts.join(' / ') : 'unlimited';
}

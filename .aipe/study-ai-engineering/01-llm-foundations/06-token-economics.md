# 06 — Token economics

**Type:** Industry standard. Also called: cost ledger, unit economics, per-request cost.

## Zoom out, then zoom in

Every LLM feature in this repo has a cost. The eval harness measures it. The budget ceiling caps it. The pricing helper prices Anthropic (which AptKit's built-in helper doesn't).

```
  Zoom out — where the cost math lives

  ┌─ Receipts (eval/receipts/*.json) ─────────────────────────────────┐
  │  per-case: usage.diagnose.costUsd, usage.recommend.costUsd         │
  │  aggregated: eval/baseline.json → run-total cost                   │
  └─────────────────────────────▲─────────────────────────────────────┘
                                │
  ┌─ Budget & pricing helpers ──┴─────────────────────────────────────┐
  │  lib/agents/budget.ts     BudgetTracker.snapshot().estimatedCost   │
  │  lib/agents/pricing.ts    estimateAnthropicCost(usage, model)      │
  │  ★ THIS CONCEPT ★                                                  │
  └─────────────────────────────▲─────────────────────────────────────┘
                                │
  ┌─ AptKit (usage summary) ────┴─────────────────────────────────────┐
  │  summarizeUsage(CapabilityEvent[]) → TokenUsageSummary             │
  │  estimateCost('openai', ...)     ← knows OpenAI only               │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. AptKit's `estimateCost` returns `undefined` for `provider: 'anthropic'` — its pricing table is OpenAI-only. That gap is why `lib/agents/pricing.ts` exists: a small helper (~60 LOC) with the Anthropic per-million-token prices, called side-by-side with AptKit's function in the eval and report code.

## Structure pass

**Layers:**
- Outer: total cost of a run in USD
- Middle: per-turn cost from token usage × price
- Inner: individual token counts from `response.usage`

**Axis: what unit governs each layer?**
- Outer: USD (rolled up to per-case, per-run)
- Middle: USD-per-MTok times tokens
- Inner: raw tokens

**Seam:** `estimateAnthropicCost(usage, modelName)` in `lib/agents/pricing.ts`. Above the seam, callers ask "what did this cost in USD?". Below, the price table matches `claude-sonnet-4-*`, `claude-haiku-4-*`, `claude-opus-4-*` regex to per-MTok prices.

## How it works

### Move 1 — the mental model

A DB primary key is $0/row. A GPT-4 call is not. You already reason about resource cost when you cache expensive queries or paginate result sets. LLM calls are the same discipline: measure per-call, aggregate, and gate.

```
  Cost per call = (in_tokens × in_price + out_tokens × out_price) / 1M

  Sonnet 4:      $3/MTok in    $15/MTok out    (this repo's default)
  Haiku 4.5:     $1/MTok in    $5/MTok out     (intent classifier)
  Opus 4.7:     $15/MTok in    $75/MTok out    (unused today)
```

Output is always ~5× more expensive than input. That's why schema-constrained outputs (`04-structured-outputs.md`) and Haiku for classification (`06-production-serving/02-llm-cost-optimization.md`) are both cost moves as well as design moves.

### Move 2 — walk the mechanism

**The pricing table.**

`lib/agents/pricing.ts:26-33` — a `[RegExp, {inputUsdPerMillion, outputUsdPerMillion}]` table. Matches by model family, not exact version:

```typescript
// lib/agents/pricing.ts:26-33
const ANTHROPIC_PRICING: readonly [RegExp, AnthropicPricing][] = [
  [/^claude-sonnet-4/, { inputUsdPerMillion: 3, outputUsdPerMillion: 15 }],
  [/^claude-haiku-4/,  { inputUsdPerMillion: 1, outputUsdPerMillion: 5 }],
  [/^claude-opus-4/,   { inputUsdPerMillion: 15, outputUsdPerMillion: 75 }],
];
```

Update this file when Anthropic changes prices or a new family lands. It's the single source of truth for cost math in this codebase.

**Per-turn cost, computed once.**

The eval runner (`eval/run.eval.ts:215-220`) calls both helpers and takes whichever returns a defined value:

```typescript
// eval/run.eval.ts:215-220
const diagnosisUsage = summarizeUsage(diagnosisTrace);
// aptkit's estimateCost only knows OpenAI pricing; fall back to
// Blooming's Anthropic pricing helper for our claude-* models.
const diagnosisCost =
  estimateCost('anthropic', diagnosisUsage, 'claude-sonnet-4-6') ??
  estimateAnthropicCost(diagnosisUsage, 'claude-sonnet-4-6');
```

Fallback pattern preserves forward-compat: if AptKit ships Anthropic pricing later, the primary path picks it up automatically.

**The cost line for the whole investigation.**

`BudgetTracker.snapshot().estimatedCostUsd` at `lib/agents/budget.ts:57-69`. Accumulated across all turns of both diagnostic + recommendation agents (one tracker shared across both). This is the number the budget ceiling checks against.

**Baseline numbers to anchor against.**

From the committed `eval/baseline.json` (runId `2026-07-03T04-08-28-644Z`):
- Per-case cost: ~$0.09 (agent-side, cached)
- 10-case run: $0.913 (agent) + ~$0.40 (judge estimate) = ~$1.30

**Two things pricing.ts is careful about.**

1. **Doesn't try to model cache tiers.** The comment at `lib/agents/pricing.ts:10-13`: "`inputTokens`/`outputTokens` already exclude cache-read tokens from the input count. Cost estimated here is therefore an UPPER BOUND when caching is on." Under-count would mean under-charging the budget; upper-bound means the budget gate errs on the safe side.
2. **Falls through to `undefined` on unknown models.** So report code that reads `cost?.totalCost ?? null` degrades gracefully — the receipt shows `costUsd: null` instead of throwing.

### Move 3 — the principle

Measure per-request cost from the start, not "when it starts to matter." A feature you can't cost is a feature you can't operate — you can't decide whether to run it at 10× volume, you can't compare provider changes, you can't gate spend. The setup cost (one pricing table, one accumulator, one receipt row) is a couple hours. The ongoing benefit is every conversation about optimization has actual numbers.

## Primary diagram

The full cost pipeline — from response.usage to run total.

```
  Cost pipeline

  Anthropic response.usage
         │
         ├─────► BudgetTracker.add() ───► snapshot().estimatedCostUsd
         │                                    │
         │                              gate: exceeded()?
         │                                    ↓
         │                       BudgetExceededError before next turn
         │
         └─────► CapabilityEvent 'model_usage'
                          │
                          ▼
                 summarizeUsage(trace) ─► TokenUsageSummary
                          │                        │
                          ▼                        ▼
                estimateCost('anthropic',    estimateAnthropicCost(
                  usage, 'claude-sonnet-4-6')   usage, 'claude-sonnet-4-6')
                          │                        │
                          └──── first-non-undefined ┘
                                        │
                                        ▼
                          receipt.usage.{diagnose,recommend}
                                        │
                                        ▼
                          baseline.json → run total:
                                $0.913 agent + $0.40 judge = $1.30
```

## Elaborate

Provider pricing changes. Anthropic changed Sonnet 3.5 pricing twice in 2024, both times downward. The regex table in `lib/agents/pricing.ts` is designed so a new family (Sonnet 5, whatever comes next) is a single-line addition. The "Update when Anthropic changes pricing" comment at the top of the file is a real maintenance item, not a formality.

Two things the pricing helper does NOT do: (1) it doesn't discount cache-read tokens (they're excluded from the input count upstream, so the number the helper multiplies is already reduced — under caching, the estimate is an upper bound on actual spend); (2) it doesn't include Anthropic's ~1M-token batch discount (this repo doesn't use batching, so this is a non-issue for now).

## Project exercises

### Exercise — cache-tier cost accounting

- **Exercise ID:** C1.6-A · Case A (concept exercised; refinement).
- **What to build:** extend `estimateAnthropicCost` to accept an optional `{cacheReadInputTokens, cacheCreationInputTokens}` and price them at Anthropic's cache tier (10% for reads, 125% for creations). Read cache tier counts from `response.usage` in `AnthropicModelProviderAdapter.complete()` and thread them through to receipts.
- **Why it earns its place:** turns the "upper bound" cost estimate into a real one. Interviewer signal: "I know exactly what my prompt cache is saving me per case — measured, not estimated."
- **Files to touch:** `lib/agents/pricing.ts` (extend signature), `lib/agents/aptkit-adapters.ts` (capture cache_creation / cache_read counts), `lib/agents/budget.ts` (thread through), `eval/run.eval.ts` (populate receipt).
- **Done when:** the receipt shows `costUsd` reflecting the actual cache-adjusted cost, and running with caching disabled vs enabled shows the delta in `baseline.json`.
- **Estimated effort:** 1-2 days.

## Interview defense

**Q: What does an investigation actually cost?**

About $0.09 agent-side per case, cached. That splits roughly $0.03-0.05 diagnose + $0.04-0.06 recommend. Add judge calls at $0.04/judgment × 4 judgments per case = another ~$0.16 at eval time. Full 10-case run: $0.913 agent + ~$0.40 judge = ~$1.30. Numbers from the committed baseline (`eval/baseline.json`, runId `2026-07-03T04-08-28-644Z`).

**Q: What's the ceiling and why is it there?**

Default `BUDGET_MAX_USD=2.0` per investigation, checked BEFORE every model turn. If the accumulated spend across diagnose + recommend hits $2, the next `AnthropicModelProviderAdapter.complete()` throws `BudgetExceededError` instead of calling the API. That's an escape valve for a runaway loop — at $0.09/case normal spend, it's ~22× the observed cost, so it should never fire on healthy traffic. It fires if something goes badly wrong (a bug in the ReAct loop causing infinite tool calls, or a prompt regression that balloons context).

```
  BudgetTracker (per-investigation)
    │
    ├── add({inputTokens, outputTokens})  ← after each response
    │
    ▼
  snapshot().estimatedCostUsd  ← running total
    │
    ▼
  before next call: exceeded()?  →  throws BudgetExceededError
```

**Q: Why is AptKit's estimateCost not enough?**

AptKit's helper only prices OpenAI models. My repo is Anthropic-only in production. The `estimateAnthropicCost` fallback in `lib/agents/pricing.ts` fills that gap. Small file, ~60 lines, one regex table. If AptKit ships Anthropic pricing in a future release, the eval code's `estimateCost() ?? estimateAnthropicCost()` pattern picks up the upstream version automatically.

## See also

- `02-tokenization.md` — the token unit costs are computed against
- `06-production-serving/01-llm-caching.md` — where the cost reduction actually comes from
- `06-production-serving/02-llm-cost-optimization.md` — Haiku for intent
- `05-evals-and-observability/04-llm-observability.md` — the receipt and report that surface these numbers
- `lib/agents/budget.ts` and `lib/agents/pricing.ts`

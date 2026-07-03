# Token economics

## Subtitle

Per-invocation cost ledger — Industry standard.

## Zoom out, then zoom in

This codebase measures per-run cost with the precision of a stopwatch. The baseline run (`runId 2026-07-03T04-08-28-644Z`, committed as `eval/baseline.json`) records: ~$0.09 agent-side per case, ~$1.30 total for 10 cases (agent + judge), and specific per-phase breakdowns visible in `eval/receipts/*.json`. Every number comes from `response.usage` fields fed through `lib/agents/pricing.ts:41`'s per-million-token math.

```
  Zoom out — where cost is measured and where it's spent

  ┌─ Anthropic ─────────────────────────────────────────┐
  │  response.usage: { input_tokens, output_tokens,      │
  │                    cache_read_input_tokens, ... }    │
  └───────────────────────┬──────────────────────────────┘
                          │  per turn
                          ▼
  ┌─ Adapter → trace sink → CapabilityEvent ───────────┐
  │  BloomingTraceSinkAdapter forwards to hooks         │
  │  lib/agents/aptkit-adapters.ts (BloomingTraceSink)  │
  └───────────────────────┬──────────────────────────────┘
                          │
                          ▼
  ┌─ Receipts / budget / report ★ ──────────────────────┐ ← we are here
  │  eval/report.eval.ts prints p50/p95/p99 + $ per case │
  │  lib/agents/budget.ts checks ceiling before dispatch │
  │  lib/agents/pricing.ts converts tokens → dollars     │
  └──────────────────────────────────────────────────────┘
```

Zoom in: token economics is the discipline of connecting *what you ship* to *what it costs* — pre-flight (budget), in-flight (metering), post-flight (receipts + baseline).

## Structure pass

- **Layers:** provider usage → capability event → summarize → estimate → receipt / budget / report. Five bands.
- **Axis: cost flow.** Where do tokens become dollars? Where does the codebase decide to stop spending? Where does it archive proof of what it spent?
- **Seam:** `estimateAnthropicCost()` in `lib/agents/pricing.ts:41`. That's the boundary where "counts of tokens" becomes "USD." Everything downstream is money; everything upstream is model mechanics.

## How it works

### Move 1 — the mental model

Three prices per model, per direction:

- **Input** — every token you send. Sonnet 4.6: $3/MTok. Haiku 4.5: $1/MTok.
- **Output** — every token you receive. Sonnet 4.6: $15/MTok. Haiku 4.5: $5/MTok.
- **Cache read** — every input token that hit the prompt cache. Anthropic prices this at ~$0.30/MTok for Sonnet, roughly 10% of normal input.

```
  Where the money goes on one invocation

  ┌──────────────────────────────────────────────────────┐
  │ Input tokens (full price)                            │
  │   system prompt (turn 1 only):     ~12000 tokens     │
  │   schema summary:                   ~1500 tokens      │
  │   tool defs:                        ~2500 tokens      │
  │   messages accumulated:             1000→5000 tokens  │
  │   → per turn 1:      ~15500 × $3/MTok  = $0.0465     │
  │   → per turn N>1:    ~1500 fresh × $3  = $0.0045     │
  │                      13000 cached × $0.30 = $0.0039  │
  ├──────────────────────────────────────────────────────┤
  │ Output tokens (full price)                           │
  │   response per turn:  1000-2000 tokens                │
  │   → per turn:         ~1500 × $15/MTok = $0.0225      │
  ├──────────────────────────────────────────────────────┤
  │ Total for a 5-turn diagnostic:                       │
  │   turn 1: $0.0465 in + $0.0225 out = $0.069           │
  │   turns 2–5: $0.0084 in + $0.0225 out ≈ $0.031 each   │
  │   total:  $0.069 + 4×$0.031 = ~$0.19                  │
  │   observed with caching:            ~$0.09/case       │
  └──────────────────────────────────────────────────────┘
```

The 2× gap between rough math and observed cost is the cache_read multiplier plus some turns being much cheaper than others.

### Move 2 — the step-by-step walkthrough

**The pricing table.** `lib/agents/pricing.ts:24-35` — three model families, each with input + output per-million rates:

```ts
// lib/agents/pricing.ts:26-35
const ANTHROPIC_PRICING: readonly [RegExp, AnthropicPricing][] = [
  [/^claude-sonnet-4/, { inputUsdPerMillion: 3, outputUsdPerMillion: 15 }],
  [/^claude-haiku-4/,  { inputUsdPerMillion: 1, outputUsdPerMillion: 5 }],
  [/^claude-opus-4/,   { inputUsdPerMillion: 15, outputUsdPerMillion: 75 }],
];
```

Regex-matched, so a new Sonnet minor version picks up the same price without a config change. This module exists because aptkit's `estimateCost` only knows OpenAI pricing (see the comment at `lib/agents/pricing.ts:2-5`).

**The pre-dispatch budget gate.** `lib/agents/budget.ts:56` — `BudgetTracker` accumulates every turn's usage. The adapter checks `budget.exceeded()` *before* calling the API, so a runaway loop can't overspend past the ceiling:

```ts
// lib/agents/aptkit-adapters.ts:65-67 (inside complete())
if (this.budget?.exceeded()) {
  throw new BudgetExceededError(this.budget.snapshot(), this.budget.limit);
}
```

The route handler catches `BudgetExceededError` and emits a graceful NDJSON `error` event. No half-run investigations, no silent overage.

**The receipts.** `eval/run.eval.ts` writes one JSON file per case per runId to `eval/receipts/`. Each receipt carries:

- Per-phase duration (investigate, diagnose_judge, recommend, recommend_judge, total)
- Per-phase token usage (input, output, cache read)
- Per-phase cost estimate (Anthropic pricing helper)
- Rubric verdicts + per-dimension scores

The `eval/report.eval.ts` script reads all receipts for a run and prints per-phase p50/p95/p99 latency + tokens/cost per case.

Execution trace of the pricing helper on one turn:

```
  estimateAnthropicCost({inputTokens: 13400, outputTokens: 890}, "claude-sonnet-4-6")

  → matches /^claude-sonnet-4/
  → pricing = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 }
  → inputCost  = 13400/1M × 3  = 0.0402
  → outputCost =   890/1M × 15 = 0.01335
  → total      = 0.05355
  → returns { currency: "USD", inputCost, outputCost, totalCost, estimated: true }
```

The `estimated: true` flag matters — this is an *upper bound* when caching is on, because the `usage.inputTokens` from aptkit's `model_usage` event doesn't reflect cache pricing (`lib/agents/pricing.ts:8-14`).

### Move 3 — the principle

If you can't state your feature's per-invocation cost, you can't ship it responsibly. Every LLM feature in this codebase has a receipt trail from tokens → dollars → aggregated report → committed baseline. That's what makes the "we made it cheaper" claim provable rather than assertable.

## Primary diagram

```
  Token economics — full pipeline

  ┌─ Anthropic ─────────────────────────────────────────┐
  │  response.usage per turn                             │
  └──────────────────────┬──────────────────────────────┘
                         │
  ┌─ Adapter ───────────▼──────────────────────────────┐
  │  BudgetTracker.add() every turn                     │
  │  onCapabilityEvent → hook                           │
  └──────────────────────┬──────────────────────────────┘
                         │  CapabilityEvent
  ┌─ Consumers ─────────▼──────────────────────────────┐
  │                                                     │
  │  1. Budget: exceeded() → BudgetExceededError        │
  │     lib/agents/budget.ts:56                         │
  │                                                     │
  │  2. Receipts: eval/run.eval.ts writes per case      │
  │     → eval/receipts/<runId>-<caseId>.json           │
  │                                                     │
  │  3. Report: eval/report.eval.ts reads receipts      │
  │     → prints p50/p95/p99 + $ per case               │
  │                                                     │
  └─────────────────────────────────────────────────────┘
```

## Elaborate

The prompt-caching win in this codebase (see **06-production-serving/01-llm-caching.md**) is why the per-case cost is 40–50% of the pre-caching estimate. Without caching, a 5-turn diagnostic pays full input price for the ~13k system-prompt-plus-schema prefix on every turn; with caching, turns 2+ pay ~10% of that. The `cache_read_input_tokens` field in the response is the proof.

Anthropic pricing changes occasionally. The pricing helper (`lib/agents/pricing.ts`) is the one-line update — no other file references dollar values. That's dependency inversion applied to a boring but important seam.

Related: **../06-production-serving/01-llm-caching.md** (where the cost reduction comes from). **../05-evals-and-observability/04-llm-observability.md** (how the receipts feed the report).

## Project exercises

### B1.6 · Publish a per-run cost dashboard

- **Exercise ID:** B1.6
- **What to build:** A page under `app/eval/` that reads the latest `eval/baseline.json` + recent receipts and renders per-case cost, per-phase latency, and cost trend over time. Live data, not markdown.
- **Why it earns its place:** Turns the "we measured cost" claim into an artifact you can share in an interview. Same tokens, same pricing helper, but rendered.
- **Files to touch:** New `app/eval/page.tsx`, new `app/api/eval/route.ts` (reads `eval/receipts/` server-side), reuses `lib/agents/pricing.ts` for the cost math.
- **Done when:** the page shows p50/p95/p99 for the current baseline runId with 10 case rows; each row shows agent cost + judge cost + total.
- **Estimated effort:** `1–2 days`.

## Interview defense

**Q: What does your codebase actually cost to run?**

The committed baseline: `runId 2026-07-03T04-08-28-644Z`, 10 cases, ~$0.09 per case agent-side, ~$0.13 including judge, ~$1.30 total. That's post-caching. Pre-caching (turns 2+ paying full input price) would be ~2× that. See `eval/baseline.json` for the exact per-case + per-phase breakdown.

**Q: How do you prevent a runaway agent from spending unbounded?**

`BudgetTracker` in `lib/agents/budget.ts`. Callers construct one per investigation with a `{ maxTokens, maxCostUsd }` limit; the tracker accumulates every turn; the adapter checks `budget.exceeded()` *before* dispatching the next API call. On hit: `BudgetExceededError` propagates up through aptkit → the route handler → an NDJSON error event. Load-bearing: the check is *pre-dispatch*, so the overage never actually happens — you're bounded on the way in, not caught after the fact.

## See also

- [02-tokenization.md](02-tokenization.md) — the unit prices are denominated in.
- [../06-production-serving/01-llm-caching.md](../06-production-serving/01-llm-caching.md) — where 40–50% of the cost gets cut.
- [../05-evals-and-observability/04-llm-observability.md](../05-evals-and-observability/04-llm-observability.md) — the trace pipeline the receipts ride on.

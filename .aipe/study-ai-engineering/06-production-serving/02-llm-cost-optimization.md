# 02 — LLM cost optimization

**Type:** Industry standard. Also called: model routing, tiered inference, budget ceiling.

## Zoom out, then zoom in

Three cost moves in this codebase: prompt caching (see previous file), Haiku for intent classification, budget ceiling per investigation.

```
  Zoom out — the cost surface

  ┌─ Prompt caching (~-40-50% per case) ─── previous file                 │
  ┌─ Cheap-model routing ──── Haiku for intent classification              │
  ┌─ Budget ceiling ─── per-investigation kill switch                       │
  ┌─ ★ THIS FILE'S CONCEPT (the second + third)                             │
```

Zoom in. Sonnet is the reasoning workhorse; Haiku is the classifier. Budget ceiling is a runaway-loop escape valve. Neither optimization is exotic; both are load-bearing.

## Structure pass

Axis: which model runs each decision, and what stops runaway spend?
- Cheap-fast model (Haiku): intent classification, potentially structured outputs on classification-shaped calls
- Expensive-slow model (Sonnet): agent loops, judge
- Budget: per-investigation ceiling, catches runaway loops before they spend $X

**Seam:** the model factory + the budget check. Above: the caller (agents, intent classifier). Below: the model call.

## How it works

### Move 1

You've routed hot-path traffic to a fast queue and cold-path to a slow one. Same shape at the LLM boundary — cheap model for cheap decisions, expensive model for expensive decisions.

```
  Model routing

  intent classification    → Haiku 4.5   ($1/$5 per MTok)     ~$0.0001/call
  agent loops (reasoning)  → Sonnet 4.6  ($3/$15 per MTok)    ~$0.05-0.09/case
  judge (rubric scoring)   → Sonnet 4.6  ($3/$15 per MTok)    ~$0.04/judgment
```

### Move 2

**Model routing — Haiku for intent.**

`lib/agents/intent.ts:16`: `const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';`. All other agents default to `AGENT_MODEL` (`claude-sonnet-4-6`). One-decision classify tasks like intent don't need Sonnet's reasoning depth.

**Prompt caching (previous file).**

Applied to every model call. Cuts effective input cost by ~40-50% per case.

**Budget ceiling — `BudgetTracker`.**

`lib/agents/budget.ts:41-77`. Per-investigation ceiling. Default `BUDGET_MAX_USD=2.0` (env-configurable) — very generous vs the ~$0.09 observed. An escape valve, not a normal-path constraint.

Mechanism: `AnthropicModelProviderAdapter.complete()` checks `budget.exceeded()` BEFORE dispatching each turn:

```typescript
// lib/agents/aptkit-adapters.ts:60-66
if (this.budget?.exceeded()) {
  throw new BudgetExceededError(this.budget.snapshot(), this.budget.limit);
}
```

`BudgetExceededError` propagates up through AptKit's loop → the agent wrapper → the route handler's try/catch, which emits a graceful NDJSON `error` event. Runaway loop caught cleanly, no runaway bill.

**Shared tracker across the chain.**

The same `BudgetTracker` instance flows from `DiagnosticAgent` to `RecommendationAgent` (via `hooks.budget`), so the ceiling counts total spend across both stages of an investigation. See `02-context-and-prompts/03-prompt-chaining.md`.

**What the ceiling catches — hypothetical.**

- A bug in the tool-use logic causing infinite tool calls (loop hits AptKit's turnsRemaining first, but if that were misconfigured, budget catches it next).
- A prompt regression that suddenly balloons context (e.g. system prompt bloats from 3K to 30K tokens; budget flags spend > threshold before it's shipped).
- An adversarial anomaly that induces excessive back-and-forth (see `05-evals-and-observability/01-eval-set-types.md` adversarial set).

**What it doesn't catch.**

- Slow drift over many runs — a prompt tweak that adds $0.01/case doesn't trip a per-investigation ceiling but adds $100 across 10K cases. That's what `eval/report.eval.ts` cost aggregation is for.

### Move 3

Three-layer cost defense: cache the stable prefix (Anthropic ephemeral), route classification to the cheap model (Haiku), gate runaway loops with a per-investigation ceiling (BudgetTracker). Any one of these missing = higher cost at scale. All three together = ~$0.09/case, no surprise bills.

## Primary diagram

```
  Cost surfaces in this codebase

  ┌─ Model routing ───────────────────────────────────────────────────┐
  │  intent classification  → Haiku 4.5   $1 / $5 per MTok             │
  │  agents (mon/diag/rec)  → Sonnet 4.6  $3 / $15 per MTok            │
  │  judge (rubric)         → Sonnet 4.6  $3 / $15 per MTok            │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Prompt caching (per model call) ▼────────────────────────────────┐
  │  system prompt wrapped in cache_control: ephemeral                 │
  │  Anthropic transparently caches tools with same breakpoint         │
  │  turn 1: cache_creation                                            │
  │  turn 2-10: cache_read (10% of normal input cost)                  │
  │  ~40-50% cost reduction per case                                   │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Budget ceiling (per investigation) ▼─────────────────────────────┐
  │  BudgetTracker created at the top of each investigation            │
  │  shared between DiagnosticAgent + RecommendationAgent               │
  │  ceiling check BEFORE each model call                              │
  │  throws BudgetExceededError → route emits NDJSON error              │
  │  default: $2.0 (≈ 22× normal case cost — escape valve)             │
  └───────────────────────────────────────────────────────────────────┘

  Net per-case: ~$0.09 agent-side (cached). Per 10-case run: ~$0.913
  agent + ~$0.40 judge = ~$1.30.
```

## Elaborate

Beyond these three, the standard cost-optimization playbook includes:
- **Semantic caching** — cache answers to similar queries (not present here, would need embedding infra)
- **Batch processing** — Anthropic's batch tier is 50% off input cost, up to 24hr latency (not applicable to real-time UX)
- **Smaller embeddings** — use `text-embedding-3-small` over `-large` when quality is comparable (relevant only if RAG is added)
- **Context compression** — summarize old turns to shrink the messages array (relevant only at longer loops than this repo runs)

The load-bearing three (cache, route, ceiling) are the ones with the largest cost delta at this repo's scale.

## Project exercises

### Exercise — cheap-model routing for the judge (opt-in)

- **Exercise ID:** C5.2-A · Case A (routing exercised for intent; extend to judge).
- **What to build:** add `JUDGE_MODEL` env var. Default remains Sonnet. When `JUDGE_MODEL=haiku`, use Haiku for judgments. Session-D pilot showed 100% verdict agreement between judges, so Haiku is defensible for gating (fast cheap sanity check on every PR), Sonnet for baseline (rigorous).
- **Why it earns its place:** cost-savings on the judge path, without losing rigor on baseline. Interviewer signal: "I know when I need Sonnet's precision and when Haiku is enough — measured."
- **Files to touch:** `eval/run.eval.ts` (accept JUDGE_MODEL), maybe move judge instantiation to a helper.
- **Done when:** running `JUDGE_MODEL=haiku npm run eval` produces receipts at ~30% of the judge cost with same verdict distribution.
- **Estimated effort:** 1-4hr.

## Interview defense

**Q: What's your per-case cost?**

~$0.09 agent-side (cached) per the committed baseline. That's cache + Haiku for intent + Sonnet for reasoning. Without caching, per-case would be closer to $0.14. Without cheap-model routing for intent, add another $0.001/query. Neither is huge in absolute dollars for a demo; both are load-bearing at production scale.

**Q: What stops runaway spend?**

`BudgetTracker` at `lib/agents/budget.ts`. Per-investigation ceiling (default $2), checked before every model call. Shared across DiagnosticAgent + RecommendationAgent so it counts total spend across the chain. Throws `BudgetExceededError` before the next call dispatches — no runaway loop can burn past the ceiling.

**Q: What's the ceiling actually protecting against?**

Bug conditions. A ReAct loop with a broken termination check. A prompt regression that inflates context. An adversarial anomaly that triggers back-and-forth. In normal operation the ceiling is never hit — at $2 vs $0.09/case, it's ~22× normal spend, which means the ceiling only fires when something has gone genuinely wrong.

## See also

- `01-llm-caching.md` — the first cost move
- `01-llm-foundations/06-token-economics.md` — the cost math
- `01-llm-foundations/07-heuristic-before-llm.md` — the tier below Haiku (regex, not built)
- `lib/agents/budget.ts`, `lib/agents/pricing.ts`, `lib/agents/intent.ts`

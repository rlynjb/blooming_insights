# LLM cost optimization

## Subtitle

Model routing / budget enforcement / caching — Industry standard.

## Zoom out, then zoom in

blooming stacks four cost knobs, three of which are live: **prompt caching** (see **01-llm-caching.md**), **cheap-model routing** for classification (Haiku for intent, Sonnet for agents), **budget ceiling** (`lib/agents/budget.ts` pre-dispatch check), and **schema-gated coverage** (the categories filter that drops unrunnable tools before they burn calls). The unshipped fourth: bounded tool_result size (see `B2.1` in the context-window file).

```
  Zoom out — where each cost knob turns

  ┌─ Model choice ──────────────────────────────────────┐
  │  Haiku for intent classifier (5× cheaper)            │
  │  Sonnet for agents                                   │
  └─────────────────────────────────────────────────────┘

  ┌─ Prompt caching ────────────────────────────────────┐
  │  ~40-50% off cost of the stable prefix               │
  │  see 01-llm-caching.md                               │
  └─────────────────────────────────────────────────────┘

  ┌─ Budget ceiling ──── LIVE ──────────────────────────┐
  │  BudgetTracker checks BEFORE dispatch                │
  │  lib/agents/budget.ts                                │
  │  runaway loop can't overspend                        │
  └─────────────────────────────────────────────────────┘

  ┌─ Schema-gated coverage ─── LIVE ────────────────────┐
  │  runnableCategories(schema) drops unrunnable tools   │
  │  lib/agents/categories.ts                            │
  │  prevents ~5 wasted rate-limited calls per briefing  │
  └─────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** input assembly → routing → dispatch → budget check → API call. Five bands.
- **Axis: cost per invocation.** Each knob addresses a different multiplier — model rate, cache ratio, ceiling enforcement, gate filtering.
- **Seam:** the pre-dispatch check in `AnthropicModelProviderAdapter.complete()`. That's where budget can veto before spending.

## How it works

### Move 1 — the mental model

Cost = model rate × tokens spent × (1 – cache ratio) × (1 – wasted calls prevented).

Optimizing means turning each knob:

```
  Four cost knobs — each addresses a factor

  Cost = rate × tokens × (1 - cache_ratio) - wasted_calls_prevented

  ┌─ rate ──────────────────────────────────────────────┐
  │  Haiku for cheap tasks (5× off input, 3× off output) │
  │  Sonnet everywhere quality matters                   │
  └─────────────────────────────────────────────────────┘

  ┌─ tokens ────────────────────────────────────────────┐
  │  schemaSummary() bounds the workspace schema         │
  │  filterToolSchemas() bounds tool defs per agent      │
  │  (would-be) bounded tool_result — see B2.1           │
  └─────────────────────────────────────────────────────┘

  ┌─ cache_ratio ───────────────────────────────────────┐
  │  cache_control on system prompt                      │
  │  turn 2+ pay ~10% on the cached prefix               │
  └─────────────────────────────────────────────────────┘

  ┌─ wasted_calls_prevented ────────────────────────────┐
  │  runnableCategories(schema) drops unrunnable tools   │
  │  BudgetTracker.exceeded() vetoes runaway spending    │
  └─────────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Model choice per surface.** `lib/agents/intent.ts:16` — `CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'`. Haiku costs $1/MTok input, $5/MTok output. Sonnet costs $3 / $15. For classification (~500 input, ~50 output), Haiku is roughly 5× cheaper end-to-end. For agents (long context, multi-turn), Sonnet's reasoning is worth the money.

**Prompt caching.** See **01-llm-caching.md** — one `cache_control` marker, 40–50% total per-case cost reduction. This is the single biggest lever.

**Budget ceiling.** `lib/agents/budget.ts` — `BudgetTracker` accumulates per-turn usage; the adapter checks `budget.exceeded()` *before* dispatching the next API call. A runaway agent loop that would have burned $5 gets stopped at the ceiling. The check is pre-dispatch, not post-facto — the overage is prevented, not just detected.

**Schema-gated coverage.** `lib/agents/categories.ts` — the filter drops anomaly categories whose required events aren't in the workspace schema. Without it, the monitoring agent might spend 3–5 rate-limited MCP calls discovering "this workspace has no payment_failure events" only after trying.

**Two more knobs, not yet live.**

- Bounded tool_result at the model boundary (see `B2.1`) — a runaway tool response can't blow the context or waste tokens.
- Provider routing at the adapter — if a request could be served by a cheaper hosted model, route there first. Would need a second `ModelProvider` adapter (see `B1.8`).

**Real numbers, per case.** Baseline runId `2026-07-03T04-08-28-644Z`:

- Agent-side: ~$0.09/case (~$0.033 diagnose, ~$0.045 recommend, ~$0.01 other)
- Judge-side: ~$0.04/case (two rubrics × 4-dim judgments)
- Total 10-case run: ~$1.30 including judge

Cost per case pre-caching (napkin): ~$0.19. Post-caching: ~$0.09. Delta: ~$1 saved on a 10-case run.

Diagram of one turn's cost being shaped by every knob:

```
  One turn's cost — after every knob

  raw model rate: Sonnet 4.6, $3 in / $15 out per MTok
    │
    ▼  cache_control turns the fixed 13k prefix into
    │  10% of that: ~$0.004 instead of ~$0.039
    ▼
  effective input cost: 10% of full-price on cached content
    │
    ▼  bounded schemaSummary means only 1.5k prefix tokens
    │  come from the schema, not 30k
    ▼
  effective token count: bounded
    │
    ▼  pre-dispatch budget check would veto if
    │  cumulative spend > ceiling
    ▼
  effective dispatch: proceeds only if within budget
    │
    ▼  agent call runs; usage flows to receipt +
    │  next-turn budget check
    ▼
  observed: ~$0.02/turn on turns 2+, $0.06 on turn 1
```

### Move 3 — the principle

Cost optimization is layered. Prompt caching is the biggest single win; model routing for cheap tasks is second; pre-dispatch budget enforcement is what makes the whole thing bounded rather than best-effort. Don't over-index on any one knob; measure every layer's contribution and turn the highest-impact one first.

## Primary diagram

```
  Cost optimization in blooming — full frame

  ┌─ Model routing ────────────────────────────────────────┐
  │  intent classifier: Haiku 4.5 (5× cheaper than Sonnet)  │
  │  agents:            Sonnet 4.6                          │
  │  judge:             Sonnet 4.6                          │
  └────────────────────────────────────────────────────────┘

  ┌─ Prompt caching (biggest lever) ───────────────────────┐
  │  cache_control on system prompt                         │
  │  turn 2+ input: ~10% of normal cost                     │
  │  observed savings: 40-50% of per-case total             │
  └────────────────────────────────────────────────────────┘

  ┌─ Budget ceiling ───────────────────────────────────────┐
  │  BudgetTracker pre-dispatch check                       │
  │  runaway agent can't burn past ceiling                  │
  └────────────────────────────────────────────────────────┘

  ┌─ Schema-gated coverage ────────────────────────────────┐
  │  runnableCategories(schema) drops unrunnable tools      │
  │  ~5 wasted MCP calls prevented per briefing             │
  └────────────────────────────────────────────────────────┘

  Total per-case cost: ~$0.09 agent-side, ~$0.13 with judge
  Committed baseline runId: 2026-07-03T04-08-28-644Z
```

## Elaborate

Cost optimization for LLM applications has settled around: (1) prompt caching, (2) model tiering (cheap-first, expensive fallback), (3) per-turn budget enforcement, (4) careful token accounting. Beyond that, the returns diminish; the load-bearing work is measuring where cost actually goes and turning knobs that address the observed dominant cost.

Related: **01-llm-caching.md** (the biggest lever), **../01-llm-foundations/06-token-economics.md** (the math behind the numbers), **../01-llm-foundations/07-heuristic-before-llm.md** (the classifier-routes-first pattern).

## Project exercises

### B6.2 · Bound tool_result at the model boundary

- **Exercise ID:** B6.2 (Case A — the UI trunc exists; extend to model)
- **What to build:** As per `B2.1` (**../02-context-and-prompts/01-context-window.md**), cap raw JSON tool_result payloads at ~8kB before they reach the model. Prevents a runaway EQL result from spending unbounded tokens.
- **Why it earns its place:** Adds the last unshipped cost knob. Interview payoff: showing the discipline of measuring where cost goes and closing the gap.
- **Files to touch:** `lib/agents/aptkit-adapters.ts` (BloomingToolRegistryAdapter.execute — cap content), `test/agents/tool-schemas.test.ts` (add oversize test), receipt row for truncation events.
- **Done when:** an oversized tool result gets truncated with a `"...(truncated, N more rows)"` marker; receipt captures the event.
- **Estimated effort:** `1–4hr`.

## Interview defense

**Q: What's the single most impactful cost knob you've added?**

Prompt caching. One flag on one block in `lib/agents/aptkit-adapters.ts:75-98`; observed 40-50% total per-case cost reduction. Measurable via `cache_read_input_tokens` in the receipt (baseline runId shows 3168 per turn). Load-bearing: I can point at the exact flag, the exact tokens saved, and the exact per-case dollar impact.

**Q: How do you prevent a runaway agent from spending unbounded?**

`BudgetTracker.exceeded()` check in the adapter's `complete()` — pre-dispatch, not post-facto. If cumulative spend exceeds ceiling, throws `BudgetExceededError` before the API call. The route catches it and emits an NDJSON error event. The user sees a graceful error; the budget is not overshot. Load-bearing: the check is before dispatch, so the overage can't happen — it's a gate, not a monitor.

## See also

- [01-llm-caching.md](01-llm-caching.md) — the biggest lever.
- [../01-llm-foundations/06-token-economics.md](../01-llm-foundations/06-token-economics.md) — the numbers behind the claims.
- [04-rate-limiting-backpressure.md](04-rate-limiting-backpressure.md) — the sibling knob for the tool-call side.

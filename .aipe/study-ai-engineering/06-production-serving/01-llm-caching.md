# LLM caching

## Subtitle

Prompt caching / provider-side prefix cache — Industry standard.

## Zoom out, then zoom in

Blooming's prompt caching is live and measurable. `cache_read_input_tokens = 3168` is a real number from a real receipt — that's ~3200 tokens per model turn read from cache at ~10% of normal input cost, for every turn after the first in a diagnostic run. The savings compound across the 5–10 turns per investigation and account for ~40–50% of the observed per-case cost reduction versus a naive uncached implementation.

```
  Zoom out — where caching intervenes

  ┌─ Agent code ────────────────────────────────────────┐
  │  builds ModelRequest with system + tools + messages  │
  └───────────────────────┬──────────────────────────────┘
                          │
                          ▼
  ┌─ Adapter ★ ────────────────────────────────────────┐ ← we are here
  │  attaches cache_control: { type: "ephemeral" } to    │
  │  the system prompt block                             │
  │  lib/agents/aptkit-adapters.ts:75-98                 │
  └───────────────────────┬──────────────────────────────┘
                          │
                          ▼
  ┌─ Anthropic ─────────────────────────────────────────┐
  │  turn 1: cache_creation (~1.25× normal input cost)   │
  │  turn 2+: cache_read (~0.1× normal input cost)       │
  │  cache TTL: 5 minutes                                │
  └──────────────────────────────────────────────────────┘
```

Zoom in: the cache is provider-side; your code opts in with one flag on one block; the savings are measured, not asserted.

## Structure pass

- **Layers:** fixed prefix → cache breakpoint → cached slot → per-turn read. Four bands.
- **Axis: what's stable across turns?** The system prompt + tools + workspace schema are stable. Messages grow every turn. Only the stable part caches.
- **Seam:** the `cache_control` marker. Above it, cached; below it, fresh every turn.

## How it works

### Move 1 — the mental model

Three cache layers you could have. Only the first is live:

```
  Cache layers — three options

  ┌─ Prompt caching (LIVE) ────────────────────────────┐
  │  Provider-side. Long system prompts cached at        │
  │  ~10% cost on cache hits. Anthropic ephemeral cache. │
  └────────────────────────────────────────────────────┘

  ┌─ Semantic cache (not live) ────────────────────────┐
  │  Your side. Embed query, check if similar query was  │
  │  answered recently, return cached answer.            │
  │  Risk: stale answers on live data.                   │
  └────────────────────────────────────────────────────┘

  ┌─ Exact match cache (not live) ─────────────────────┐
  │  Your side. Hash input, return cached output on      │
  │  identical input. Safest, lowest hit rate.           │
  └────────────────────────────────────────────────────┘
```

For blooming, prompt caching alone earns 40–50% cost cut. Semantic caching on live analytics data would be dangerous (data changes; cached answers go stale). Exact-match caching has near-zero hit rate on the varied anomaly inputs.

### Move 2 — the step-by-step walkthrough

**The cache_control breakpoint.** `lib/agents/aptkit-adapters.ts:75-98` — inside `complete()`:

```ts
// simplified — the real code branches on system-prompt presence
if (systemPrompt) {
  params.system = [
    {
      type: 'text',
      text: systemPrompt,
      cache_control: { type: 'ephemeral' },   // ← THE BREAKPOINT
    },
  ];
}
```

Everything before the breakpoint is cache-eligible. The system prompt (~10-12k tokens) is stable across every turn in an investigation, so it caches. Tool definitions and the workspace schema are inside the system prompt, so they cache too.

**What triggers a cache miss vs hit.**

- Turn 1 of a fresh investigation: **cache creation**. Anthropic charges ~1.25× normal input cost for the cached content. It's now in the cache slot with a 5-minute TTL.
- Turn 2–N (within 5 minutes): **cache read**. Cached prefix billed at ~0.1× normal input cost (~$0.30/MTok for Sonnet 4.6 vs $3/MTok normal input).
- New investigation on a different case: **cache miss on that case's system prompt** (if any part differs). Cache slot is per-content-hash, not per-user.

**The math.** Per turn: ~13k cached prefix tokens.

- Uncached: 13k × $3/MTok = $0.039 per turn on the fixed prefix.
- Cached: 13k × $0.30/MTok = $0.0039 per turn — 90% saved per turn.
- Over a 5-turn diagnostic: ~$0.14 saved.

That's why the observed per-case cost is ~$0.09 instead of ~$0.19.

**Receipt evidence.** The trace sink captures `cache_read_input_tokens` from Anthropic's `response.usage`. Receipts include it. The cost report distinguishes cached from uncached input to show the ~80% savings on cached portion (see `lib/agents/pricing.ts:8-14` comment about the upper-bound behavior).

Diagram of the cache lifecycle in one investigation:

```
  Cache lifecycle — one investigation

  turn 1 (cold cache):
    inputTokens:            13400 (fresh)
    cache_creation_tokens:  13400
    billed at 1.25× → $0.050 on prefix
    output:                   890 → $0.013
    total: $0.063
                                 │
                                 ▼ cache slot now holds prefix
  turn 2 (warm cache):
    inputTokens:              310 (only the new user turn)
    cache_read_tokens:      13400
    billed at 0.1× → $0.004 on cached
    fresh input at $3/M → $0.001
    output:                  1120 → $0.017
    total: $0.022
                                 │
                                 ▼ cache still warm
  turn 3-5: same as turn 2, ~$0.02/turn
                                 │
                                 ▼ after 5 min idle, cache expires
```

### Move 3 — the principle

Caching earns its place when a stable prefix is reused. blooming's system prompt is stable across an investigation's turns; that's a natural fit. Caching is opt-in via one flag on one block; the reward is a measured ~40–50% cost cut. Any codebase with a stable multi-turn system prompt should have this.

## Primary diagram

```
  Prompt caching — full frame

  ┌─ Fixed prefix (stable across all turns) ────────────┐
  │  system prompt ~10-12k tokens                        │
  │  tool defs      ~2-3k tokens                         │
  │  schema summary ~1.5k tokens                         │
  │  ────────────────────────  ← cache_control marker    │
  └─────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─ Cached slot (per content hash, 5-min TTL) ─────────┐
  │  turn 1: create (1.25× cost) → slot populated        │
  │  turn 2+ within 5min: read (~10% cost)               │
  │  cache miss after TTL or different content           │
  └─────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─ Growing messages (never cached — always fresh) ────┐
  │  assistant, user (tool_result), assistant, ...       │
  │  billed at full input rate per turn                  │
  └─────────────────────────────────────────────────────┘

  Observed savings: cache_read_input_tokens = 3168 per turn
                    (from real baseline receipt)
                    → ~40-50% total cost reduction per investigation
```

## Elaborate

Anthropic's prompt caching launched mid-2024 as an ephemeral (5-min TTL) cache for stable prefix content. OpenAI has a similar "prompt caching" feature; the exact mechanics differ (auto-applied to prefixes >1024 tokens vs Anthropic's explicit breakpoint). Both provide roughly the same discount on cached content (~10% of normal input rate).

The 5-minute TTL fits interactive workloads well (one user's investigation completes in ~4 min); it's short for batch workloads (a batch that resumes 10 min later loses the cache). For long-running batches, break work into 5-min windows.

Related: **../01-llm-foundations/06-token-economics.md** (the cost math), **../05-evals-and-observability/04-llm-observability.md** (the receipts that prove the savings).

## Project exercises

### B6.1 · Add cache-hit rate to the observability report

- **Exercise ID:** B6.1 (Case A — caching live; add reporting)
- **What to build:** Extend `eval/report.eval.ts` to compute the cache-hit ratio per phase (cache_read_input_tokens / total_input_tokens). Print alongside p50 / cost.
- **Why it earns its place:** Turns "caching is on" into "here's what we're saving." Makes the win visible.
- **Files to touch:** `eval/report.eval.ts` (add cache_hit_ratio computation), `eval/run.eval.ts` (ensure the cache_read tokens are captured in the receipt).
- **Done when:** the report prints `cache-hit ratio: 82% on cached prefix; $ savings vs uncached: ~$0.05/case`.
- **Estimated effort:** `1–4hr`.

## Interview defense

**Q: How much does prompt caching actually save in your codebase?**

Roughly 40–50% of the per-case cost. Real number from the baseline receipt: `cache_read_input_tokens = 3168` per turn after the first, at ~10% of normal input rate. Over a 5-turn diagnostic, that's ~$0.05 saved per case — enough to bring per-case cost from ~$0.19 to ~$0.09. Load-bearing: I can point at the exact field in the response `usage` that proves the savings.

**Q: Why not semantic caching too?**

Data freshness. blooming's diagnoses reference live workspace data; caching answers by embedding-similarity would return stale answers when the underlying metrics change. Prompt caching is safe because it caches the *prompt prefix*, not the model's output — the model still runs; only the input assembly gets cheaper.

## See also

- [../01-llm-foundations/06-token-economics.md](../01-llm-foundations/06-token-economics.md) — where the savings show up.
- [02-llm-cost-optimization.md](02-llm-cost-optimization.md) — the sibling knob.
- [../05-evals-and-observability/04-llm-observability.md](../05-evals-and-observability/04-llm-observability.md) — the receipts that prove the savings.

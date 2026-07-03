# Cross-turn caching

*Industry names: prompt-prefix caching / intra-run memoization / semantic cache · Industry standard*

## Zoom out

```
  Zoom out — caching at three altitudes, only two used here

  ┌─ single-call cache (in study-ai-engineering) ────┐
  │  hash(request) → hit? return : call               │
  └───────────────────────────────────────────────────┘
              ↓ expands to
  ┌─ ★ CROSS-TURN CACHING (this file) ★ ───────────────┐ ← we are here
  │  1. prompt-prefix cache (SHIPPED — provider-side)  │
  │  2. intra-run memoization (SHIPPED — 60s TTL)      │
  │  3. cross-run semantic cache (not yet)             │
  └────────────────────────────────────────────────────┘
```

## Zoom in

Single-call caching keys on one request. An agent runs many turns per task; many tasks repeat sub-steps. Three layers of cache, cheapest to most useful for agents: prompt-prefix (provider-side), intra-run memoization (tool result cache), cross-run semantic (embed the sub-query, reuse similar results). This repo ships the first two; the third has a specific "stale cache poisons trajectory" risk that keeps it deliberate.

## Structure pass

Layers: **provider-side prefix cache** (Anthropic ephemeral) — **DataSource TTL cache** (per name+args) — **cross-run semantic** (not yet, would need vector store).

Axis to hold constant: **what invalidates each cache?**

```
  Cache invalidation — the axis that differs per layer

  Prefix cache:      5-minute TTL, provider-managed
  Intra-run cache:   60s TTL, per name+args (deterministic key)
  Cross-run semantic: content freshness (harder — see below)
```

## How it works

### Move 1 — the shape

You've reasoned about HTTP caching before — CDN edge vs origin, cache keys, TTLs. Same shape, different keys and different failure modes. Prompt-prefix caching is the provider's version; intra-run tool-result caching is the app's version.

```
  Cross-turn cache scopes — three layers

  Single-call cache (ai-eng's version):
    request → hash → hit? return : call

  Cross-turn cache (the agent version):
  ┌───────────────────────────────────────────────┐
  │  Agent run (task A)                           │
  │   turn 1: retrieve "auth flow"  ──┐           │
  │   turn 2: reason                  │ cached    │
  │   turn 3: retrieve "auth flow" ◄──┘ within    │
  │           (same sub-step, cache hit) the run  │
  └───────────────────────────────────────────────┘
  ┌───────────────────────────────────────────────┐
  │  Agent run (task B, later)                    │
  │   turn 1: retrieve "auth flow" ◄── semantic   │
  │           (similar to task A's, cache hit)    │
  │           cache across runs                    │
  └───────────────────────────────────────────────┘
```

### Move 2 — the three layers in this repo

**Layer 1: prompt-prefix caching (shipped).** The system prompt is the largest fixed prefix in the payload — stable across every model call within an investigation (~5-15 ReAct-loop iterations reuse it). `lib/agents/aptkit-adapters.ts` wraps it in `cache_control: 'ephemeral'`:

```
  Prompt-prefix cache — behavior

  First call in an investigation:
    system prompt: cache_creation (~1.25× normal input cost)
    other input: normal cost

  Subsequent calls within 5 minutes (~10 calls in one investigation):
    system prompt: cache_read (~0.1× normal input cost)
    other input: normal cost

  Observed effect in live logs:
    3168-token cache_read hits per turn
    ≈ 80% reduction on system-prompt token cost
```

The economic math: for a diagnostic investigation with 10 model turns and a ~3200-token system prompt, prefix caching saves roughly `10 × 3200 × 0.9 × $3/M = ~$0.09` of what would otherwise be spent on system prompt tokens alone. Since the whole investigation costs ~$0.09 total, the caching is ~50% of what would be the raw price.

**Layer 2: intra-run memoization (shipped — the DataSource cache).** `BloomreachDataSource` maintains a 60s TTL cache keyed by `name:JSON(args)`:

```ts
// lib/data-source/bloomreach-data-source.ts (intra-run cache)
const cacheKey = `${name}:${JSON.stringify(args)}`;
const ttl = options.cacheTtlMs ?? 60_000;

if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
}
```

When the diagnostic agent re-issues the same EQL within 60s (which happens — a hypothesis test needs a data point the model already fetched), the second call returns from cache with `fromCache: true` and `durationMs: 0`. Error results are NOT cached (they'd poison future calls); rate-limit retries write the eventual success into the cache.

**Layer 3: cross-run semantic cache (not shipped).** The pattern: embed each sub-query, and on a new sub-query, check if a previously-cached result is semantically close enough. Would let "USA revenue drop" investigations reuse partial results from previous "USA revenue drop" investigations.

**Deliberately not shipped.** The reason:

```
  The sharper tradeoff — stale cache poisons the WHOLE trajectory

  Single-call cache staleness:  one wrong response, small blast radius
  Cross-run semantic staleness: a stale sub-result feeds the agent's
                                next reasoning turn, which conditions
                                every downstream turn — the WHOLE
                                trajectory inherits the error

  Product context: workspace data changes hourly (customer events
  fire continuously). A cached "TX purchase_revenue -38%" from
  yesterday can be silently wrong today. The agent reasons forward
  on a stale sub-result; the final Diagnosis is wrong.

  Mitigation options:
    (a) Gate the semantic cache on data freshness (don't cache
        retrieval results whose underlying data can change).
    (b) Never cache a tool call that has side effects (moot here —
        all tools are read-only).
    (c) Skip cross-run semantic cache entirely for time-varying
        analytical data (this repo's current choice).
```

For an analytical workspace where data is inherently time-varying, cross-run semantic caching is the wrong optimization. Prefix caching and short-TTL memoization are enough — they save cost within an investigation without poisoning across investigations.

**When cross-run semantic would earn its cost.** Static knowledge sources: documentation Q&A, code search, immutable historical archives. Not analytical data.

### Move 3 — the principle

Cross-turn caching is not one thing; it's three layers with different invalidation semantics. Prefix caching is the cheapest and safest; intra-run memoization is nearly free (short TTL, deterministic key); cross-run semantic caching is the highest reward but carries "stale cache poisons the trajectory" risk that scales with the loop count. Ship the first two; treat the third with the same discipline as any distributed cache — bounded, freshness-gated, or skipped.

## Primary diagram

```
  Cross-turn caching in this repo — two shipped layers, one deliberate skip

  ┌─ Layer 1: prompt-prefix cache (Anthropic ephemeral) ──────────┐
  │  wrap system prompt in cache_control:'ephemeral'              │
  │  first call: cache_creation (~1.25× input cost)               │
  │  subsequent (5min TTL): cache_read (~0.1× input cost)         │
  │  observed: 3168-token cache_read hits                          │
  │  savings: ~50% of investigation cost                           │
  └─────────────────────────┬─────────────────────────────────────┘
                            │
  ┌─ Layer 2: intra-run memoization (DataSource TTL cache) ───────┐
  │  key: `${toolName}:${JSON.stringify(args)}`                   │
  │  TTL: 60s (skipCache option per-call)                          │
  │  fromCache: true / durationMs: 0 on hit                        │
  │  errors NOT cached                                             │
  └─────────────────────────┬─────────────────────────────────────┘
                            │
  ┌─ Layer 3: cross-run semantic cache (NOT SHIPPED) ─────────────┐
  │  would need: vector store, embedder, freshness gate            │
  │  risk: stale sub-result poisons whole trajectory               │
  │  reason skipped: workspace data is time-varying                │
  │  when to add: static knowledge sources only                    │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

Prompt-prefix caching was surfaced as a first-class provider feature by Anthropic (Aug 2024) and OpenAI (Oct 2024). The mechanism is provider-specific but the economic shape is universal — the stable prefix is cached; only the delta pays full price. For agent loops with many turns sharing a system prompt, this is the single highest-leverage cost lever available today.

The interesting frontier is **partial-prompt caching** — caching the system prompt + tool definitions + retrieved context prefix, letting only the conversation history + last user turn pay full price. Anthropic's cache_control breakpoints support up to 4 breakpoints per request, enabling multi-tier caching. This repo uses one breakpoint (the system prompt); the escalation would be adding a breakpoint after the tool definitions for even better hit rates on long conversations.

## Interview defense

**Q: How do you cache across an agent loop?**

Two layers shipped, one deliberate skip.

Prefix cache — Anthropic ephemeral cache_control on the system prompt. First call is cache_creation (~1.25× normal input cost); subsequent calls within 5 minutes are cache_read (~0.1× normal). Live logs show 3168-token hits. Roughly 50% of investigation cost saved.

Intra-run memoization — 60s TTL cache on the DataSource, keyed by tool name + JSON.stringify(args). When an agent re-issues the same EQL within an investigation, second call is `fromCache: true` at `durationMs: 0`. Errors not cached.

Cross-run semantic cache — deliberately skipped. Workspace data is time-varying (customer events fire continuously); a cached "TX -38%" from yesterday can be silently wrong today. Stale sub-result poisons the whole trajectory, not just one call. For static knowledge sources it'd be worth it; for analytical data it's the wrong optimization.

*Anchor visual:* the three-layers diagram above.

**Q: What's the sharpest tradeoff cross-turn caching adds?**

Trajectory poisoning. A stale cross-run cache hit feeds the agent's reasoning; every downstream turn inherits the error. The blast radius is the WHOLE trajectory, not one response. That's why cross-run semantic caching needs freshness gates or is skipped for time-varying data.

Prefix caching doesn't have this issue — the cached prefix is the immutable system prompt, so staleness isn't a semantic problem. Intra-run memoization doesn't have it either at 60s TTL — the model can't get "back to the same sub-question" outside a single investigation.

## See also

- **`04-agent-infrastructure/01-context-engineering.md`** — the stable prefix that gets cached is a context-engineering artifact.
- **`02-fan-out-backpressure.md`** — caching and concurrency compose (a hit doesn't count against the concurrency cap).
- **`.aipe/study-ai-engineering/`** section 06 caching mechanics for a single call.

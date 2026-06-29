# Cross-turn caching

**Industry standard.** Single-call caching keys on one request; agent runs span many turns. **Exercised at two layers** in this repo.

## Zoom out, then zoom in

Sits at the layer below the agent loop, intercepting model calls and tool calls before they cross the wire. Two cache scopes matter for agents: within-run memoization and across-run reuse.

```
  Zoom out — where this concept lives

  ┌─ Agent loop (8 turns)  ─────────────────────────┐
  │  many model calls + many tool calls per run     │
  └────────────────────────┬────────────────────────┘
                           │
       ┌───────────────────┼───────────────────┐
       ▼                                       ▼
  ┌─ Cache: model side ──┐                  ┌─ Cache: tool side ──┐
  │  Anthropic prompt    │                  │  BloomreachDataSource│
  │  prefix cache         │                  │  60s TTL cache       │
  │  (provider-side,      │                  │  (in-process,        │
  │   implicit)           │                  │   per-instance)      │
  └──────────────────────┘                  └─────────────────────┘
```

## Structure pass

Layers: provider-side prefix cache (stable system prompt + tool definitions cached at Anthropic) → in-process tool-result cache (BloomreachDataSource's 60s map) → no cross-run semantic cache (not in this repo).

**Axis traced — "what gets reused, at what scope?":** prefix tokens across every turn of every run. Tool results across turns within ~60s. Nothing across runs older than that.

**Seam:** the cache lookup boundary in `BloomreachDataSource.callTool` (`bloomreach-data-source.ts:147-152`). If the cache key matches and isn't expired, return; otherwise call MCP.

## How it works

### Move 1 — the mental model

You know the difference between caching a whole HTTP response and caching a CDN-edge fragment. Single-call caching is the HTTP response cache — one request, one hash, hit or miss. Cross-turn caching has more places to cache because the agent run is N requests, and many of those share parts. The model's system prompt is identical across every turn; cache it once at the provider. The same EQL query asked twice in one run; cache it in-process. The same diagnostic question asked next week against fresh data; *don't* cache it because the data changed.

```
  Three layers, cheapest to most useful

  ┌────────────────────────────────────────────────────────────┐
  │  1. Prompt-prefix cache (provider side)                    │
  │     stable system prompt + tool defs cached across every   │
  │     turn in one run AND across runs that share prefix       │
  │     cost: input tokens for the prefix dropped to ~10%      │
  └────────────────────────────────────────────────────────────┘

  ┌────────────────────────────────────────────────────────────┐
  │  2. Intra-run tool memoization (in-process)                │
  │     same tool call + args in one task = cache hit          │
  │     scope: this serverless instance, 60s TTL               │
  │     cost: 0 (in-memory map lookup vs MCP wire call)        │
  └────────────────────────────────────────────────────────────┘

  ┌────────────────────────────────────────────────────────────┐
  │  3. Cross-run semantic cache (NOT IN THIS REPO)            │
  │     a later task's sub-step is semantically close to       │
  │     an earlier one; embed and reuse                         │
  │     cost: vector store dep + freshness risk                 │
  └────────────────────────────────────────────────────────────┘
```

### Move 2 — step by step

#### Layer 1 — prompt-prefix caching (Anthropic, implicit)

Anthropic supports prompt-prefix caching server-side. When the same prefix (system prompt + tool definitions, in order) repeats across requests within a window, the provider caches the prefix and bills the cached tokens at ~10% of the standard input rate. The repo benefits from this automatically because the system prompt structure is stable:

- `monitoringPromptPackage.system` (from `@aptkit/prompts`) is a constant template; the slot values (`schema`, `categories`) are the same for every turn within one run.
- Tool definitions are a constant array per agent run.

Within one run of 8 turns, the system prompt + tool definitions are byte-identical across all 8 calls (only the `messages` array changes between turns). Anthropic's cache fires across all 8 turns after the first, paying full price only on turn 1.

Across runs, the cache fires when consecutive runs share the same agent type AND the schema hasn't materially changed. Two diagnostic investigations 5 minutes apart for the same workspace likely hit the prefix cache; investigations 1 hour apart might or might not depending on Anthropic's cache TTL.

This repo doesn't *configure* anything to enable prefix caching — it's automatic on Anthropic's side when the prefix is stable. The architectural choice that helps is keeping the system prompt structure deterministic (template + slots, not free-form construction per turn).

#### Layer 2 — intra-run memoization (`BloomreachDataSource.callTool`)

Open `lib/data-source/bloomreach-data-source.ts:139-188`. The relevant logic:

```ts
// lib/data-source/bloomreach-data-source.ts:144-152
const cacheKey = `${name}:${JSON.stringify(args)}`;
const ttl = options.cacheTtlMs ?? 60_000;

if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
}
```

In-memory `Map<string, {result, expiresAt}>`. The key combines the tool name with a JSON-stringified args object. TTL defaults to 60 seconds; per-call override is possible (the dev tooling uses `cacheTtlMs` to extend or `skipCache: true` to bypass).

The win: an agent that re-derives the same sub-step within one run (e.g. "what's the USA revenue this period?" asked at turn 1 and again at turn 4 during synthesis) pays for the wire call once and gets the cached result the second time. The `fromCache: true` flag surfaces in the trace so the UI's "how this was gathered" panel can show "cache hit (0ms)" instead of a network call.

The scope: the `Map` lives in the `BloomreachDataSource` instance, which lives in the request handler's `dataSource` reference, which is constructed per-request. Across requests on the same serverless instance, the cache survives because the underlying transport is held alive by the cookie-scoped auth state (see `lib/data-source/index.ts:14-18` — Bloomreach is session-scoped, not subprocess-scoped). Across serverless instances on Vercel, the cache does not survive (different instance = different `Map`).

So the layer is *intra-run + best-effort cross-run on the same instance*. Not a strong cross-run guarantee, but free upside when the platform's instance reuse aligns.

#### Layer 3 — cross-run semantic cache (NOT IN THIS REPO)

The pattern would be: embed each tool call's args (or each `Diagnosis` summary) into a vector store; for a new tool call (or new investigation), search for a semantically close past result; if close enough, return the cached result without making the call.

This isn't in the repo. The architecture intentionally avoids a vector store. The closer-to-home version that *could* be in the repo without a vector dep: a longer-TTL cache (24h) keyed on the same tool + args, persisted to disk. The team chose not to because the use case doesn't warrant it — investigations are infrequent, the cache hit rate would be low.

The risk this layer carries is sharper for agents than for single calls: a stale cross-run cache hit poisons the *whole trajectory*, not one response. The agent reasons forward on a stale sub-result and every downstream turn inherits the error. Gating the semantic cache on freshness (don't cache retrieval results whose underlying data can change mid-task) is the standard mitigation; never cache a tool call that has side effects is the absolute rule.

### Move 3 — the principle

**Cache at the right scope for the right reuse pattern.** Prefix caching pays for itself with no design cost — keep your system prompts stable and the provider does it. Intra-run memoization pays for itself when tool calls recur in one run — the in-process Map is cheap and the freshness window (~60s) is short enough to bound staleness. Cross-run semantic caching pays for itself when sub-steps recur across tasks AND the data is stable enough that staleness doesn't poison trajectories — for this repo, neither half of that is true today.

## Primary diagram

```
  The caching layers in this repo, per agent turn

  ┌─ Agent turn N ───────────────────────────────────────────────┐
  │                                                                │
  │   model.complete({                                             │
  │     system: "you are an anomaly scanner..." (stable prefix)    │
  │     messages: [...running conversation...]    (varies per turn)│
  │     tools: [4 tool defs]                       (stable prefix) │
  │   })                                                            │
  │     │                                                            │
  │     ▼                                                            │
  │   ┌─ Anthropic provider ─────────────────────────────────────┐ │
  │   │  prefix matches recent request? cached at 10%             │ │
  │   │  prefix new? full input billing                           │ │
  │   └─────────────────────────────────────────────────────────┘ │
  │                                                                  │
  │   response.content includes tool_use(execute_analytics_eql,..) │
  │                                                                  │
  │   tools.callTool(name, args, { signal })                        │
  │     │                                                            │
  │     ▼                                                            │
  │   ┌─ BloomreachDataSource.callTool ─────────────────────────┐  │
  │   │   cacheKey = "execute_analytics_eql:{...json args...}"  │  │
  │   │   cached + not expired? return { result, durationMs:0,  │  │
  │   │                                  fromCache: true }       │  │
  │   │   else: liveCall (spacing → MCP wire) → cache result    │  │
  │   └─────────────────────────────────────────────────────────┘  │
  │                                                                  │
  │   tool_result block goes back into messages for turn N+1         │
  └────────────────────────────────────────────────────────────────┘

  Across runs: prefix cache may survive at Anthropic if structure stable.
               BloomreachDataSource Map survives ONLY on the same Vercel
               serverless instance (no cross-instance state).
               Cross-run semantic cache: not in this repo (vector dep
               avoided).
```

## Elaborate

Anthropic introduced prompt caching as a paid feature in Claude 3.5 (August 2024) with the explicit ergonomic that callers don't have to do anything special — the provider detects identical prefixes and caches them. The pricing model is: full price on the first cache-creating call, ~10% on cache hits, ~25% write cost when the prefix changes from the cached version. For agent workloads with stable prefixes (this repo's case), the math works out to ~50% input-token cost savings on the *cached portion* of the prompt across a typical run.

The 60s TTL choice in `BloomreachDataSource` is a deliberate balance. Shorter (10-30s) wouldn't help repeat sub-steps in one investigation that runs ~50-120s — the cache would expire mid-run. Longer (5-10min) starts to overlap with the cross-run case where data freshness matters. 60s is "long enough that intra-run repeats hit; short enough that no run sees stale data across most queries." For workspaces with very slowly-changing data (catalog browsing, historical analytics), a longer TTL would be safe; for fast-changing data (real-time event streams), even 60s could be too long. The repo picks the middle ground because the dominant query pattern (period-over-period 90d windows) is robust to a 60s lag.

The Vercel-instance lifecycle is the underrated complication. Caches that survive across requests on the same instance feel like cross-run caching but aren't — Vercel scales instances up and down, requests get routed to whichever instance is warm, and the cache hit rate is roughly proportional to the instance reuse rate. For low-traffic apps this is "rarely fires"; for high-traffic apps it's "often fires." This repo's traffic profile (one user, demo cadence) means the cross-instance reuse is low; the in-process cache is mostly intra-run.

## Interview defense

> **Q: How does caching work for the agents in this codebase?**
>
> Two layers. Layer 1: Anthropic's prompt-prefix cache fires automatically because the system prompt + tool definitions are stable across every turn within a run (the prefix is byte-identical from turn 1 through turn 8). The provider charges ~10% for input tokens on cache hits, so the per-run input-token cost drops substantially after turn 1. Layer 2: `BloomreachDataSource` keeps an in-process 60-second TTL cache keyed by tool name + JSON-stringified args. If the agent re-derives the same EQL query within ~60s (intra-run is the common case; same-instance cross-run is best-effort), the second call returns from the cache in 0ms with `fromCache: true` surfaced in the trace.

> **Q: Why not a cross-run semantic cache?**
>
> Two reasons. The architecture intentionally avoids a vector store dependency. And the failure mode is sharper for agents than for single calls — a stale cross-run hit poisons the *whole trajectory*, not one response. The agent reasons forward on a stale sub-result and every downstream turn inherits the error. The mitigation (gate the semantic cache on freshness, never cache side-effect-bearing tools) is standard but adds design surface. For this repo's traffic and freshness requirements (investigations on real-time analytics, infrequent demos), the 60s in-process cache is the right scope; cross-run semantic caching would be over-engineered.

> **Q: What's the failure mode of the 60s cache?**
>
> Stale data within ~60s of a real change. The Bloomreach workspace updates continuously (event streams flowing in), so a query result cached at T=0s could be slightly stale at T=59s. For period-over-period analytics on 90d windows (the dominant query pattern), this is negligible — 60s of new events in a 90d window is ~0.001% noise. For real-time queries (e.g. "events in the last 10 seconds") the cache would be visibly wrong; if those queries appeared, the call sites could pass `cacheTtlMs: 0` or `skipCache: true` to bypass. The current call sites don't bypass because the dominant pattern is the 90d window.

## See also

- → `04-agent-infrastructure/01-context-engineering.md` — why the prefix is stable (the curated, deterministic system-prompt structure)
- → `03-per-tool-circuit-breaking.md` — the cache interacts with the retry ladder (errors are not cached)
- → `04-agent-infrastructure/03-tool-calling-and-mcp.md` — the wire path the cache short-circuits
- → cross-reference (when generated): `study-ai-engineering`'s single-call caching file — the per-request cache pattern this builds on

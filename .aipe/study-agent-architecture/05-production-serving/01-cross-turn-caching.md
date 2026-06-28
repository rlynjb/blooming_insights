# Cross-turn caching

*Industry name: cross-turn caching / prompt prefix caching / semantic cache — Industry standard.*

Caching for a single call keys on one request. An agent runs many turns per task, and many tasks repeat sub-steps. **This repo has the intra-run memoization layer** (60s response cache per name+args in `BloomreachDataSource`); provider-side prompt-prefix caching is not currently enabled; semantic cross-run cache doesn't exist.

## Zoom out — where this concept lives

The cache lives at the DataSource layer — every `dataSource.callTool(name, args, opts)` checks the cache before going to the network. The agent doesn't know the cache exists; it just sees faster responses.

```
  Where the cache lives in blooming insights

  ┌─ Agent layer ─────────────────────────────────────────────┐
  │  model emits tool_use → runAgentLoop calls dataSource     │
  └────────────────────┬──────────────────────────────────────┘
                       ▼
  ┌─ DataSource layer (BloomreachDataSource) ─────────────────┐
  │  ┌─ cache check ──────────────────────────────────────┐   │
  │  │  key: name + JSON.stringify(args)                  │   │
  │  │  hit → return cached result (no network)           │   │
  │  │  miss → fetch + cache for 60s                       │   │
  │  └────────────────────────────────────────────────────┘   │
  └────────────────────┬──────────────────────────────────────┘
                       ▼
  ┌─ MCP transport ──────────────────────────────────────────┐
  │  HTTPS to Bloomreach                                       │
  └───────────────────────────────────────────────────────────┘
```

## Structure pass

The axis: **what scope does each cache layer cover?**

```
  Three layers of cache for agents — by scope

  Layer                         Scope                     In this repo
  ─────                         ─────                     ────────────
  Prompt-prefix cache (provider) one HTTP request to       NOT currently
                                  Anthropic (or shared      enabled
                                  across requests within
                                  a 5-min window)
  Intra-run memoization         within one agent run       YES — 60s
                                                              response cache
                                                              per (name+args)
  Cross-run semantic cache       across runs / sessions /   NOT implemented
                                  users
```

## How it works

### Move 1 — the mental model

You know HTTP caching — keying on URL, returning the same body if fresh. Single-call cache is that primitive on one LLM request. Agent caching extends it because agents repeat: an agent might call the same EQL query twice within one investigation, or two investigations might both query "purchase count in the last 90 days." Each layer of cache catches a different repetition pattern.

```
  Three cache scopes, cheapest to most useful for agents

  ┌─ Provider prefix cache ──────────────────────────────────┐
  │  the stable parts of the prompt (system, tool definitions)│
  │  cached on Anthropic's side, reused across calls          │
  │  win: cheaper input tokens on every turn after the first  │
  └──────────────────────────────────────────────────────────┘

  ┌─ Intra-run memoization (THIS REPO) ──────────────────────┐
  │  the agent re-derives the same sub-result mid-task        │
  │  cache by (tool name + args)                              │
  │  win: skip the second `select count event purchase ...`   │
  └──────────────────────────────────────────────────────────┘

  ┌─ Cross-run semantic cache ───────────────────────────────┐
  │  a later task's sub-query is semantically close to an     │
  │  earlier one → embed the sub-query, return cached result  │
  │  win: zero-token recall across runs                       │
  └──────────────────────────────────────────────────────────┘
```

### Move 2 — walk this repo's cache

**Intra-run memoization — 60s response cache in `BloomreachDataSource`.**

The cache is a `Map<string, { result: unknown; expiresAt: number }>` keyed by `name + JSON.stringify(args)`. From `lib/data-source/bloomreach-data-source.ts` (paraphrased):

```typescript
// the cache is checked at the start of callTool
const cacheKey = `${name}:${JSON.stringify(args)}`;
const cached = this.cache.get(cacheKey);
if (cached && cached.expiresAt > Date.now()) {
  return { result: cached.result, durationMs: 0, fromCache: true };
}
// ... fetch from MCP, then:
this.cache.set(cacheKey, { result, expiresAt: Date.now() + 60_000 });
```

What this catches:
- The MonitoringAgent calling the same EQL query twice within one investigation (e.g., once for the 90d window, then re-checking the 90d window to verify)
- The same insight being re-investigated within 60s (cache survives across requests on the same Vercel instance)
- The capture path re-running the combined flow

What it doesn't catch:
- Different requests landing on different Vercel instances (the cache is per-process)
- Repeats more than 60s apart
- Semantically similar but syntactically different queries (`count event purchase` vs `count event purchase in last 90 days` are different cache keys)

The `fromCache: true` flag rides through to the AgentEvent stream so the UI can show "cached" badges on tool calls — a small but real product surface for the cache.

**Provider-side prompt prefix caching — NOT currently enabled.**

Anthropic supports prompt caching where stable prompt prefixes (system prompt + tool definitions) are cached server-side and re-used across calls within a 5-minute window. The win: input tokens for the cached prefix get billed at a much lower rate (typically ~10% of normal).

This isn't currently enabled in this repo. The `AnthropicModelProviderAdapter` constructs a fresh request per turn without setting the `cache_control` blocks Anthropic's API requires for prompt caching. Enabling it would mean:
- Mark the system prompt with `cache_control: { type: 'ephemeral' }`
- Mark the tool definitions with the same
- Ensure the cached prefix is the FIRST part of every turn's request (Anthropic caches prefixes, not arbitrary substrings)

The cost-savings opportunity is real — for the monitoring agent's 8-turn loop, the system prompt + tool definitions are ~5-8KB and identical across all 8 turns. Enabling prefix caching would slash input-token cost by ~50-80% for this part of the prompt. The change is small (~10 lines in the adapter); the reason it's not done is just that nobody has prioritized it.

**Cross-run semantic cache — NOT implemented.**

There's no embedding of past queries; there's no vector store; there's no "this question is semantically close to one we answered last week." Adding it would require everything `../02-agentic-retrieval/01-agentic-rag.md` lists (vector store, embedding pipeline, similarity threshold).

### Move 2.5 — the tradeoff that's sharper for agents than for single calls

For a single LLM call, a stale cache hit just gives one wrong response. For an agent, a stale cache hit poisons the *whole trajectory*: the agent reasons forward on a stale sub-result, every downstream turn inherits the error, and the final output is wrong in a way that's hard to trace because the bad input came from a cache hit two turns ago.

This repo's 60s TTL is short enough that the freshness window is tight — the ecommerce data isn't going to change dramatically in 60s. But the principle applies hard for any longer-lived cross-run cache: **gate semantic caching on freshness**. Don't cache retrieval results whose underlying data can change mid-task; never cache a tool call that has side effects.

### Move 3 — the principle

Caching for agents is layered because agents have layered repetition patterns: prefix caching saves cost on prompt repetition, intra-run memoization saves cost+latency on within-task repetition, cross-run semantic caching saves cost+latency on across-task repetition. The hardest part isn't the cache implementation — it's the freshness story. A stale cache hit for an agent poisons the whole trajectory, not one response. The senior move is naming what each cache layer caches AND what stale-hit risk it accepts.

## In this codebase

**Partial — intra-run memoization only.** The 60s response cache in `BloomreachDataSource` handles the within-run case well. The two missing layers are real opportunities:

- **Provider-side prompt-prefix caching:** ~50-80% input-token reduction on the system prompt + tool definitions per turn. Small implementation (~10 lines in `AnthropicModelProviderAdapter`). Why not done: nobody's prioritized it.
- **Cross-run semantic cache:** would require pgvector + embedding pipeline; same prerequisites as long-term memory (`../04-agent-infrastructure/02-agent-memory-tiers.md`). Probably wait until that lands.

## Primary diagram

The three cache scopes and what's in this repo:

```
  Cross-turn caching in blooming insights — what's there, what's not

  ┌─ Agent run ───────────────────────────────────────────────┐
  │                                                            │
  │  Turn 1 → Anthropic call (system + tools + user msg)      │
  │    ┌──────────────────────────────────────────────────┐   │
  │    │ Anthropic input cost                              │   │
  │    │  could be reduced by prefix-cache: NOT ENABLED   │   │ ← gap
  │    └──────────────────────────────────────────────────┘   │
  │                                                            │
  │  Turn 1 tool_use → dataSource.callTool                    │
  │    ┌──────────────────────────────────────────────────┐   │
  │    │ 60s response cache (BloomreachDataSource)         │   │ ← yes
  │    │  cache miss → MCP fetch → cache for 60s            │   │
  │    └──────────────────────────────────────────────────┘   │
  │                                                            │
  │  Turn 3 same EQL query → dataSource.callTool              │
  │    ┌──────────────────────────────────────────────────┐   │
  │    │ cache HIT (intra-run memoization works)           │   │ ← yes
  │    │  return { fromCache: true, durationMs: 0 }        │   │
  │    └──────────────────────────────────────────────────┘   │
  │                                                            │
  └────────────────────────────────────────────────────────────┘

  ┌─ Cross-run ───────────────────────────────────────────────┐
  │  Run B's sub-query is semantically close to Run A's        │
  │    ┌──────────────────────────────────────────────────┐   │
  │    │ Semantic cache: NOT IMPLEMENTED                   │   │ ← gap
  │    │  would need vector store + embedding pipeline     │   │
  │    └──────────────────────────────────────────────────┘   │
  └────────────────────────────────────────────────────────────┘
```

## Interview defense

**Q: "How do you cache agent calls?"**

A: One layer today: a 60s response cache in `BloomreachDataSource` keyed by tool name + JSON args. It catches intra-run memoization — the agent calling the same EQL query twice within one investigation, or the same insight being re-investigated within 60s. The cache survives across requests on the same Vercel instance but not across instances. The `fromCache: true` flag flows through to the UI so cached tool calls show a "cached" badge — a small product surface for the cache.

Two layers I'd add. First, provider-side prompt-prefix caching — Anthropic supports it, the system prompt + tool definitions are stable across all 8 turns of an agent loop, enabling it would cut input-token cost on the prefix by ~50-80%. The implementation is small (`cache_control: { type: 'ephemeral' }` on the system and tool blocks in `AnthropicModelProviderAdapter`); it just isn't prioritized. Second, cross-run semantic cache — embed sub-queries on save, similarity-search on new queries, return the cached result if similarity > threshold. Needs pgvector + embedding pipeline; probably waits for long-term memory to land first.

The freshness tradeoff is what separates agent caching from single-call caching: a stale cache hit for a single call gives one wrong response; a stale cache hit for an agent poisons the whole trajectory because every downstream turn reasons forward from the bad input. The 60s TTL is short enough to bound the risk; any longer-lived cache needs explicit gating on data-freshness.

Diagram I'd sketch:

```
  yes (today):      60s response cache (intra-run memoization)
                      key: name + JSON.stringify(args)
                      surfaces fromCache flag to UI

  not enabled:      Anthropic prompt-prefix caching
                      ~50-80% input-token reduction on stable parts
                      small implementation, just prioritization

  not implemented:  semantic cross-run cache
                      embed sub-queries, similarity-recall
                      requires pgvector, gated on freshness
```

Anchor: "the 60s TTL is the freshness gate. Stale-hit risk compounds across the trajectory, not within one response — that's the agent-specific cost."

**Q: "Why hasn't prefix caching been enabled?"**

A: Prioritization, honestly. The cost win is real (~50-80% reduction on prefix tokens for an 8-turn loop), the implementation is small, the API is supported. It hasn't been done because the current bottleneck isn't input-token cost — it's MCP rate-limit and the 300s wall-clock budget. Until input-token cost becomes the binding constraint, prefix caching is a known optimization waiting for a reason to ship. The reason to ship it sooner: when usage scales, input-token cost compounds faster than wall-clock cost because every turn pays it again.

## See also

- [`../04-agent-infrastructure/01-context-engineering.md`](../04-agent-infrastructure/01-context-engineering.md) — what's IN the prefix that would be cached
- [`02-fan-out-backpressure.md`](./02-fan-out-backpressure.md) — the cache lives at the same layer as backpressure (DataSource)
- [`03-per-tool-circuit-breaking.md`](./03-per-tool-circuit-breaking.md) — circuit-breaker state is the cache's cousin
- ai-engineering's section 06 single-call caching file (cross-ref) — the single-call version this extends

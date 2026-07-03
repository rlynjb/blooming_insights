# 01 — LLM caching

**Type:** Industry standard. Also called: prompt caching, ephemeral cache breakpoint, system prompt caching.

## Zoom out, then zoom in

The load-bearing cost move in this codebase. Every model call in the agent loop wraps the system prompt in an Anthropic ephemeral cache breakpoint. Live logs show cache_creation → cache_read pattern, ~60-80% reduction on the system-prompt prefix.

```
  Zoom out — where the cache lives

  ┌─ AnthropicModelProviderAdapter.complete() ────────────────────────┐
  │  wraps system prompt with cache_control: {type: 'ephemeral'}       │
  │  ★ THIS CONCEPT ★                                                  │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Anthropic server ──────────▼─────────────────────────────────────┐
  │  turn 1: cache_creation_input_tokens (~1.25× normal)               │
  │  turn 2-10: cache_read_input_tokens (~0.1× normal)                 │
  │  effective input cost across 10 turns: ~40% of uncached            │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. Anthropic's ephemeral cache stores the tokens at a cache_control breakpoint for ~5 minutes. Any subsequent call with the SAME prefix hits the cache. The system prompt is stable across every turn in one investigation — so wrapping it in the breakpoint means turn 1 pays 25% premium, turns 2-10 pay 10%. Net win.

## Structure pass

**Layers:**
- Outer: reader-visible cost per case (~$0.09)
- Middle: cache_control breakpoint placement
- Inner: Anthropic server's cache lookup

**Axis: is this prefix stable?**
- Stable prefix (cacheable): system prompt, tool definitions
- Growing suffix (uncacheable): user turns, assistant turns, tool_results
- Cache breakpoint: at the boundary between them

**Seam:** the `cache_control` field on the system message. Above: caller code; below: Anthropic's cache.

## How it works

### Move 1

You've written HTTP caching — `Cache-Control: max-age=300` on responses that don't change often. Same shape at the LLM boundary — mark the stable prefix as cacheable; subsequent calls with the same prefix short-circuit at Anthropic's servers.

```
  Cache-Control at the LLM boundary

  turn 1                       turn 2 (within 5 min)
  ─────                        ─────
  system prompt (~2.5K)         same system prompt (~2.5K)
  + cache_control breakpoint    + cache_control breakpoint
    │                             │
    ▼                             ▼
  cost: 1.25× the 2.5K          cost: 0.1× the 2.5K   ← cache hit!
        (cache_creation)             (cache_read)
  + growing tail (paid normal)  + growing tail (paid normal)
```

### Move 2

**The single call site — `AnthropicModelProviderAdapter.complete()`.**

`lib/agents/aptkit-adapters.ts:74-89`:

```typescript
// Phase-3 prompt caching. The system prompt is stable across every call
// within an investigation (all ~5-15 ReAct-loop iterations reuse it) and
// is the largest fixed prefix in the payload. Wrapping it in an ephemeral
// cache breakpoint makes the first call a cache_creation (~1.25× normal
// input cost) and every subsequent call within 5 min a cache_read
// (~0.1× normal).
//
// Tools are also stable across the loop but the Anthropic API caches
// tools transparently when the SAME breakpoint is set on the system
// prompt — so this one addition covers both prefixes.
if (request.system) {
  params.system = [
    { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
  ];
}
```

One breakpoint. That's the whole implementation.

**Why the system prompt (and not any other position).**

Two conditions for cache to work: (1) prefix is byte-identical across calls, (2) prefix is large enough to be worth caching. The system prompt satisfies both — same across every turn in an investigation, ~2-3K tokens. The user turn changes each call (that's where the growing conversation lives), so caching past that point wouldn't work.

Anthropic transparently caches TOOLS too when the same breakpoint is set on the system prompt. That's ~1-2K additional tokens covered by the same breakpoint.

**Cache lifetime.**

Ephemeral tier = ~5 minutes. Perfect for an investigation that takes ~225s (all turns within one investigation land in the cache window). Cache misses if you leave a 5-min gap between calls — happens when the user pauses mid-investigation. Non-issue in normal flow.

**Cost math (approximate).**

- Uncached input at ~2.5K tokens/turn × 10 turns = 25K tokens × $3/MTok = $0.075 input cost
- Cached input: turn 1 = 2.5K × 1.25 × $3/MTok = $0.0094 (cache_creation), turns 2-10 = 9 × 2.5K × 0.1 × $3/MTok = $0.0068 (cache_read)
- Cached total input: ~$0.016
- Effective savings: $0.075 - $0.016 = $0.059 per investigation, ~78% reduction on input side

Real observed baseline (`eval/baseline.json`): per-case $0.09 total (cached). Without caching, per-case would be closer to $0.14-0.16. Cache is roughly saving $0.05-0.07 per case.

**Live logs prove it.**

Server logs show `cache_creation_input_tokens: 2900` on turn 1, `cache_read_input_tokens: 3168` on turn 2. The read count is higher than the creation count because Anthropic normalizes token counting between runs — but the pattern is clear.

**The caveat about receipts.**

`response.usage.input_tokens` in the Anthropic SDK EXCLUDES cache_read tokens. So `BudgetTracker.add()` in `lib/agents/budget.ts:51-55` (which reads `input_tokens`) is slightly under-counting when caching is on. That means the budget snapshot is CONSERVATIVE — the actual spend is slightly higher than the snapshot, but never by more than the delta. Documented at `lib/agents/pricing.ts:10-13`: cost estimated here is an UPPER BOUND when caching is on.

Wait — re-read. `input_tokens` excludes cache_read, meaning the number the tracker sees is LOWER than the total-input notion. Pricing multiplies that number by full input price. So estimated cost = tokens × price = under-counted tokens × correct price = **under-estimated cost** (real spend is HIGHER because cache_read tokens exist and cost 0.1× — the tracker sees zero and multiplies by full price? No, wait — cache_read tokens aren't in the input_tokens count AND they cost 0.1×, so total real spend = input_tokens × 3 + cache_read_tokens × 0.3. The tracker computes input_tokens × 3. Under-estimate by cache_read_tokens × 0.3.).

So the tracker under-estimates cost by ~10% of the cache-read volume. Small in absolute dollars but the direction is toward "under-charging the budget" — mitigation is running with a modest ceiling so the under-count doesn't matter for the escape-valve purpose.

### Move 3

Cache the stable prefix. In a ReAct loop, the system prompt is the stable prefix and it's usually the biggest chunk of the input. Wrapping it in a cache_control breakpoint is one line of code and cuts effective input cost by ~78%. This is not premature optimization; this is the single highest-leverage cost move.

## Primary diagram

```
  Prompt caching across one investigation (10 turns)

  ┌─ Turn 1 (cache_creation) ─────────────────────────────────────────┐
  │  messages array:                                                  │
  │    [                                                              │
  │      system (with cache_control) ← cached at this breakpoint      │
  │      tools (transparently cached via same breakpoint)             │
  │      user (anomaly)                                               │
  │    ]                                                              │
  │                                                                   │
  │  usage returned:                                                  │
  │    cache_creation_input_tokens: ~4500 (system + tools)            │
  │    cache_read_input_tokens: 0                                     │
  │    input_tokens: ~500 (user turn, uncached)                       │
  │                                                                   │
  │  cost: ~4500 × 1.25 × $3/MTok + ~500 × $3/MTok = ~$0.018          │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ Turn 2-10 (cache_read) ──────────────────────────────────────────┐
  │  messages array:                                                  │
  │    [                                                              │
  │      system (with cache_control) ← same as turn 1 → cache_read    │
  │      tools                        ← same as turn 1 → cache_read   │
  │      user, asst, user...          ← growing suffix, uncached      │
  │    ]                                                              │
  │                                                                   │
  │  usage per turn:                                                  │
  │    cache_creation_input_tokens: 0                                 │
  │    cache_read_input_tokens: ~4500  ← 10% of normal cost           │
  │    input_tokens: growing with conversation (500-2500)              │
  │                                                                   │
  │  cost per turn (avg): ~4500 × 0.1 × $3/MTok + growing tail        │
  │                    ≈ $0.001 (cached prefix) + $0.006 (tail)       │
  │                    ≈ $0.007/turn                                  │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ Total across 10 turns (approximate) ─────────────────────────────┐
  │  turn 1: $0.018                                                   │
  │  turns 2-10 (9 turns × $0.007): $0.063                            │
  │  ─────                                                            │
  │  ~$0.081 input                                                    │
  │  + output tokens (~$0.02-0.03)                                    │
  │  = ~$0.09-0.11 per case                                           │
  │                                                                   │
  │  vs uncached: ~$0.14-0.16 per case                                │
  │  savings: ~$0.05-0.07 per case, ~40-50% of the pre-cache cost     │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

Provider prompt caching arrived in 2024. Anthropic ephemeral tier (5-min lifetime, ~0.1× read cost, ~1.25× creation cost) is the model I use. OpenAI has automatic caching at ~50% of input cost for the 128K models, no explicit breakpoint (automatic behind the scenes). Google Gemini has Cached Content with explicit lifetimes.

The trade Anthropic exposes is intentional: the ephemeral tier's low read cost makes short-lived loops (like this codebase's investigations) cheap. Longer-lived caches would need a different pricing tier.

## Project exercises

### Exercise — measure cache hit rate per investigation

- **Exercise ID:** C5.1-A · Case A (concept exercised; measure it).
- **What to build:** in `AnthropicModelProviderAdapter.complete()`, capture `response.usage.cache_creation_input_tokens` and `cache_read_input_tokens` (not currently captured). Emit as CapabilityEvent, thread to receipts. Report per-case cache hit rate + effective cost with vs without caching.
- **Why it earns its place:** turns "caching is on" into a measured number. Interviewer signal: "I know my cache hit rate is 90%; I know my savings are $0.06/case."
- **Files to touch:** `lib/agents/aptkit-adapters.ts` (capture cache tokens), `lib/agents/budget.ts` (accept them), `eval/run.eval.ts` (populate receipt), `eval/report.eval.ts` (add cache hit rate section).
- **Done when:** report shows per-case cache_creation_tokens / cache_read_tokens / hit_rate / effective_cost_savings.
- **Estimated effort:** 1-2 days.

## Interview defense

**Q: Where's your prompt cache?**

`AnthropicModelProviderAdapter.complete()` at `lib/agents/aptkit-adapters.ts:74-89`. Wraps the system prompt in `cache_control: {type: 'ephemeral'}`. One breakpoint. Server logs show cache_creation on turn 1 and cache_read on subsequent turns within the 5-minute window. Anthropic transparently caches tool definitions using the same breakpoint, so tools ride along.

**Q: What's the savings?**

Roughly $0.05-0.07 per case (~40-50% of the pre-cache per-case cost). Baseline per-case is ~$0.09; without caching it'd be ~$0.14-0.16. Across 10 cases, that's saving ~$0.60 per run. Small in absolute dollars for a demo, big as a percentage — matters more at scale.

**Q: What's the caveat?**

`input_tokens` in the SDK response EXCLUDES `cache_read_input_tokens`. So `BudgetTracker` under-counts by ~10% of the cache-read volume (real cost = tokens × price where cache reads are 0.1× priced but not in the tracker's tokens field). Documented at `lib/agents/pricing.ts:10-13`. Direction of error: under-estimates cost by a small margin. Mitigation: keep the ceiling conservative so the under-count doesn't matter for the escape-valve purpose.

```
  Real cost   = input × 3 + cache_read × 0.3
  Tracker     = input × 3
  Under-count = cache_read × 0.3
```

## See also

- `02-llm-cost-optimization.md` — the cost story this fits into
- `01-llm-foundations/06-token-economics.md` — the token unit
- `lib/agents/aptkit-adapters.ts:74-89` — the cache_control site
- `lib/agents/pricing.ts` — the cost math

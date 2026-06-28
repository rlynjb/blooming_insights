# 01 — LLM caching

**Subtitle:** Prompt cache / semantic cache / exact match · Industry standard (Case B)

## Zoom out, then zoom in

**Case B.** Three cache layers, none currently active in this codebase.
The most impactful one — **Anthropic prompt caching** — is one config
flag away and would cut input cost on multi-turn agent loops by ~50%.

```
  Zoom out — three caches, three places

  ┌─ Browser ───────────────────────────────────────┐
  │  (no LLM cache here)                            │
  └──────────────────────┬──────────────────────────┘
                         │
  ┌─ Blooming server ────▼──────────────────────────┐
  │  ┌─ semantic cache: NOT EXERCISED ────────────┐ │  ← Case B
  │  │  (would embed query, look up similar)      │ │
  │  └─────────────────────────────────────────────┘ │
  │  ┌─ exact-match cache: NOT EXERCISED ─────────┐ │  ← Case B
  │  │  (would hash input, return cached output)  │ │
  │  └─────────────────────────────────────────────┘ │
  └──────────────────────┬──────────────────────────┘
                         │ HTTPS messages.create
                         ▼
  ┌─ Anthropic ─────────────────────────────────────┐
  │  ┌─ prompt cache: NOT EXERCISED ──────────────┐ │  ← Case B
  │  │  cache_control: {type: 'ephemeral'} on     │ │   (biggest lever)
  │  │  system block → ~90% cost reduction on     │ │
  │  │  cached prefix tokens on turn 2+           │ │
  │  └─────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — staleness tolerance.** Prompt cache is safe
    (cached prefix is identical text, same model behavior). Semantic
    cache is risky (similar-but-not-identical queries get the same
    answer, may return stale data). Exact-match is medium (safe if
    nothing relevant changed since the cache write).

## How it works

### Move 1 — the mental model

```
  Three layers, each with different tradeoffs

  ┌─ Prompt cache (provider-side) ────────────────┐
  │  Anthropic / OpenAI cache common system        │
  │  prompts and prefix messages between your      │
  │  calls. You pay ~10% of normal input cost      │
  │  for cached prefix tokens.                     │
  │                                                │
  │  RISK: none — same exact tokens, same          │
  │  behavior                                       │
  │  BIGGEST LEVER for agent loops                  │
  └────────────────────────────────────────────────┘

  ┌─ Semantic cache (your side) ──────────────────┐
  │  Embed the query; if a similar query was       │
  │  answered recently, return the cached answer.  │
  │                                                │
  │  RISK: stale answers if data changed; tuning  │
  │  the similarity threshold is the whole game    │
  └────────────────────────────────────────────────┘

  ┌─ Exact-match cache (your side) ───────────────┐
  │  Hash the input; return cached output if      │
  │  identical input.                              │
  │                                                │
  │  RISK: low — only fires on exact repeat;      │
  │  hit rate is low because most LLM calls aren't │
  │  exact repeats                                  │
  └────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Layer 1 — Anthropic prompt caching is the biggest lever and it's
one config flag away.** Today the adapter sends `system` as a plain
string (`lib/agents/aptkit-adapters.ts:49`):

```typescript
if (request.system) params.system = request.system;
```

To enable caching, send it as a structured array with `cache_control`:

```typescript
if (request.system) {
  params.system = [
    { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
  ];
}
```

That's the whole change. The first call seeds the cache
(`cache_creation_input_tokens > 0`); every subsequent call within the
TTL (5 minutes for ephemeral) reads from cache
(`cache_read_input_tokens > 0`, ~90% cheaper).

**For blooming insights, the cacheable parts are:**
  - The system prompt (~500 tokens, identical across all turns of one
    agent's loop).
  - The schema summary (~1500 tokens, identical within a session).
  - The tool definitions (~1500 tokens, identical per agent).

Total cacheable prefix per turn: ~3.5k tokens. At Sonnet rates:
  - Normal cost: 3500 × $3/M = $0.0105 per turn
  - Cached cost: 3500 × $0.30/M = $0.00105 per turn (cache_read)
  - Savings per turn: $0.0094
  - Across a 6-turn diagnostic loop: ~$0.056 saved per investigation

At ~5 investigations per session, that's ~$0.28 saved per session.
For a heavily-used product, that compounds quickly.

**The `cache_creation_input_tokens` field is already being logged**
(`lib/agents/aptkit-adapters.ts:60` includes `usage` in the log, which
contains these fields per Anthropic's API). They're always zero today
because nothing's been marked as cacheable.

**Layer 2 — semantic cache (Case B).** For blooming insights, the
useful semantic-cache surface would be the QueryBox. If two users (or
the same user in two sessions) asked semantically-equivalent questions
("what's our purchase trend?" vs "show me purchase numbers"), a
semantic cache could return the same answer without re-running the
agent.

Implementation: embed the query, check vector store for similar past
queries with cached answers, return if similarity > threshold.
Tradeoff: tuning the threshold is the whole game. Too high (0.95+) and
hit rate is near zero. Too low (0.7-) and you return stale or
inappropriate answers.

For analytics queries where data changes (today's purchase numbers
differ from yesterday's), semantic cache is risky — even an exact-text
repeat should NOT use a cached answer past some TTL. Better to skip
semantic caching for time-sensitive answers and only apply it to
truly evergreen questions ("how does cart_update work?").

**Layer 3 — exact-match cache (Case B).** Hash the request (system +
messages + tools), return cached response if identical. Low hit rate
in practice — most agent calls have at least slightly different
context turn-to-turn. Useful for idempotent classifier calls (intent
classify on the same query repeats often) but the gain is small.

**Why these aren't built yet.** Demo mode (which is the default) hits
no LLM at all — it replays the snapshot. Live mode is rate-limited by
the Bloomreach side, not the Anthropic side. So today's *bottleneck*
is the MCP server, not the model. Caching would be a cost reduction,
not a latency reduction. Worth doing when (a) live becomes a real
user-facing path, or (b) cost grows past "casual single-user."

### Move 3 — the principle

**Cache where it's safe and where the win is biggest. For agent loops,
that's the provider-side prompt cache — same exact tokens, same
behavior, ~90% discount. Semantic cache buys you cross-query reuse
but at correctness risk. Exact-match cache is the safest but the
hit-rate is too low to matter much.**

## Primary diagram

```
  Caching opportunity per agent loop (today vs prompt-cached)

  Today (one diagnostic investigation, 6 turns):
    turn 1: 4500 input + 200 output  = $0.0165
    turn 2: 6000 input + 300 output  = $0.0225
    turn 3: 8000 input + 300 output  = $0.0285
    turn 4: 10500 input + 500 output = $0.0390
    turn 5: 13500 input + 1000 output= $0.0555
    turn 6: 17500 input + 2000 output= $0.0825
                                       ──────
                                      $0.2445

  With Anthropic prompt cache on system + schema + tools
  (~3500 cacheable per turn):
    turn 1: 4500 input + cache_creation 3500 + 200 output ≈ $0.018
    turn 2: 6000 input - 3500 cached + 300 output  ≈ $0.014
    turn 3: 8000 - 3500 + 300                       ≈ $0.018
    turn 4: 10500 - 3500 + 500                      ≈ $0.029
    turn 5: 13500 - 3500 + 1000                     ≈ $0.045
    turn 6: 17500 - 3500 + 2000                     ≈ $0.072
                                                    ──────
                                                   $0.196

  Savings: ~$0.05 per investigation (~20%)
  At scale: $5/100 investigations
```

## Elaborate

Anthropic introduced prompt caching in August 2024. Adoption is one
config flag (set `cache_control` on the message you want cached).
The TTL is 5 minutes for `ephemeral` cache; persisting longer would
require their as-yet-unreleased "persistent" cache. For agent loops
(which complete in <60s typically), the 5-minute TTL is comfortably
long.

OpenAI's equivalent is implicit prompt caching (no flag needed — they
auto-cache prefixes >1024 tokens). Adoption is automatic on supported
models. Both providers are converging on "cache the prefix, charge
less for re-reads."

The semantic cache idea was popularized by GPTCache (2023) — embed
query, vector-search prior queries+answers, return cached if similarity
> threshold. Works well for narrow Q&A domains where queries cluster;
works badly for analytics domains where data shifts.

## Project exercises

### Exercise — enable Anthropic prompt caching on the system block

  → **Exercise ID:** `study-ai-eng-06-01.1`
  → **What to build:** In `AnthropicModelProviderAdapter.complete()`,
    when `request.system` is present, send it as `[{type: 'text', text:
    request.system, cache_control: {type: 'ephemeral'}}]` instead of as
    a plain string. Verify the next turn's
    `usage.cache_read_input_tokens` is > 0 in the logs.
  → **Why it earns its place:** Biggest cost-reduction move on the
    table. Config flag, immediate ~20% savings on 6-turn loops.
  → **Files to touch:** `lib/agents/aptkit-adapters.ts:49`,
    possibly AptKit `ModelRequest` if `system` needs to be structured
    upstream.
  → **Done when:** Logs show `cache_read_input_tokens > 0` on the
    second turn of any agent loop. A back-of-envelope check shows
    measurable input-cost reduction.
  → **Estimated effort:** `1–4hr` (AptKit upstream may add half a day).

### Exercise — add semantic cache to the QueryBox surface only

  → **Exercise ID:** `study-ai-eng-06-01.2`
  → **What to build:** Add a small semantic cache for the
    `QueryAgent.answer()` flow. Embed the query; check
    `lib/state/query-cache.ts` (a new sqlite-vec-backed store) for past
    queries with similarity > 0.95 AND timestamp within last 5
    minutes; return the cached answer if hit. Otherwise run the agent
    and cache the result.
  → **Why it earns its place:** The QueryBox is the only surface where
    semantic cache buys real wins (repeat questions are common). The
    5-min TTL bounds staleness on time-sensitive answers.
  → **Files to touch:** new `lib/state/query-cache.ts`,
    `app/api/agent/route.ts` (free-form branch), `lib/agents/query.ts`.
  → **Done when:** Two consecutive identical queries to QueryBox return
    in <100ms on the second one (cache hit).
  → **Estimated effort:** `1–2 days`

## Interview defense

**Q: Does this codebase cache LLM calls?**

Not yet. Three caching layers are possible:

  1. **Anthropic prompt caching** (provider-side) — one config flag
     away (`cache_control: {type: 'ephemeral'}` on the system block).
     Cuts input cost on multi-turn loops by ~20% per investigation.
     Biggest lever still on the table.

  2. **Semantic cache** (your side) — embed query, return cached
     answer if similar enough. Risky for time-sensitive data; best
     for QueryBox-style repeated questions with a short TTL.

  3. **Exact-match cache** (your side) — hash input, return cached
     output. Safe but low hit rate.

`response.usage.cache_creation_input_tokens` and
`cache_read_input_tokens` are already being logged
(`lib/agents/aptkit-adapters.ts:60`) — they're just always zero today.

**Anchor line:** "Caching is one config flag away on the provider side.
The usage object already has the cache fields; they're just always
zero."

**Q: Why hasn't caching been enabled?**

Today the bottleneck is the Bloomreach MCP server's "1 per 10s" rate
limit, not the Anthropic side. Demo mode hits no LLM at all. So caching
is a cost reduction, not a latency reduction — worth doing when live
becomes a real user-facing path. The 30-min PR is shovel-ready;
priority is just below "make live actually scale."

## See also

  → `01-llm-foundations/06-token-economics.md` — what the cache saves in $
  → `02-llm-cost-optimization.md` — model routing as the parallel lever
  → `05-evals-and-observability/04-llm-observability.md` — what the
    cache metrics look like once enabled

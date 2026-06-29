# Complexity and Cost Models

Complexity (Big O) · amortized analysis · time vs space · choosing the right cost model — Industry standard

## Zoom out — where this concept lives

Cost models don't sit *in* a layer. They sit *across* every layer — every box below has a complexity story, and the work of choosing the right cost model is asking which one matters at this layer. The map shows where the costs land in this codebase.

```
  Zoom out — where cost shows up across the system

  ┌─ UI layer (browser) ──────────────────────────────────────────────┐
  │  InsightCard render  →  reduce over 4 funnel stages (O(n), tiny) │
  │  NDJSON reader       →  split('\n') buffer (O(n) per chunk)       │
  └──────────────────────────────┬────────────────────────────────────┘
                                 │  NDJSON over fetch
  ┌─ Service layer (Next route) ─▼────────────────────────────────────┐
  │  monitoring agent loop   →  ★ cost lives here ★                   │
  │     · Anthropic call     ~1-3 s   ← dominant constant per turn    │
  │     · MCP tool call      ~1-10 s  ← dominant under rate limit     │
  │     · sort + slice top10 O(n log n) over n=10, ~zero              │
  └──────────────────────────────┬────────────────────────────────────┘
                                 │  MCP / HTTP
  ┌─ Storage layer (provider) ───▼────────────────────────────────────┐
  │  Bloomreach EQL (server-side aggregate)                            │
  │  60s response cache (Map lookup, O(1))                             │
  └────────────────────────────────────────────────────────────────────┘
```

## Zoom in — the concept

Big O is the vocabulary; *picking which cost model matters* is the skill. In this repo, the algorithmic O() is almost never the bottleneck — the wall-clock dominators are the network call (Anthropic + Bloomreach) and the rate-limit ceiling (1 req/s, observed). When you teach yourself complexity, you teach two things at once: the asymptotic notation, and the judgment to know when an O(n²) over n=8 is fine because the *constant* is a 2-second LLM call.

## Structure pass — layers · axes · seams

```
  one axis traced down the stack — "what dominates a single user request?"

  ┌─ UI render ────────────────────────────────┐
  │  10 ms / browser paint                      │   → paint dominates
  └────────────────────────────────────────────┘
  ┌─ NDJSON stream parse ──────────────────────┐
  │  µs per line / O(line length)               │   → free
  └────────────────────────────────────────────┘
  ┌─ Agent loop turn ──────────────────────────┐
  │  ~2 s Anthropic + ~1 s MCP tool call        │   → network dominates
  └────────────────────────────────────────────┘
  ┌─ Bloomreach EQL ───────────────────────────┐
  │  unknown server-side; you don't get to tune │   → opaque
  └────────────────────────────────────────────┘

  the seam: in-process code (free) vs network call (dominant)
  every algorithm decision in this repo sits ABOVE that seam,
  so big-O picking is mostly about not making n large enough to matter
```

- **layers**: UI render, stream parse, agent loop, provider EQL.
- **axis traced**: wall-clock cost of a single user request.
- **seam**: the boundary where the answer flips from "microseconds" to "seconds" — between in-process code and the network. Everything to the left of that seam is free; everything to the right is rate-limited.

## How it works

### Move 1 — the mental model

Big O answers one question: **as the input grows, how does the cost grow?** Not "how long does it take" — that's wall-clock. Not "how much memory" — that's space complexity, a different question. Big O is the *shape* of the cost curve, not its absolute height.

You already think this way when you reach for `useMemo` to skip a recompute. The recompute itself is fast; you cache it because it would run *on every render* and the curve is `O(renders × work)`. Big O is the same instinct, written down with letters.

```
  the cost curves you actually meet

      cost
       │
       │             ╭── O(n²)  ← nested loop over the same list
       │            ╱
       │          ╱
       │        ╱
       │      ╱── O(n log n)  ← comparator sort
       │   ╱╱
       │ ╱╱── O(n)            ← single pass / filter / map
       │╱──── O(log n)        ← binary search (not in this repo)
       │───── O(1)            ← Map.get / Set.has
       └───────────────────────────────────────────► n (input size)
```

The interview reflex: when someone asks the complexity of a loop, name what `n` is, then name what each iteration does, then multiply.

### Move 2 — the moving parts

#### the cost model — pick the right ruler

A "cost model" is just the unit you measure in. The default is time complexity in operations, but for any real system you have a menu:

- **time (operations)** — comparisons, hash lookups, swaps. The textbook default.
- **time (wall-clock)** — seconds. Dominated by network in this repo.
- **space (auxiliary)** — bytes allocated beyond the input. The 60s response cache is `O(unique-tool-call-signatures × result-size)`.
- **amortized time** — average cost per op over a long sequence. The standard example: pushing to a dynamic array is O(1) amortized even though some pushes trigger an O(n) resize.
- **money** — Anthropic charges per token. A 10-turn agent loop at 4k tokens per turn is a real number.

The judgment: when you optimize, you optimize the ruler that matters. The monitoring agent runs at most 6 tool calls (`lib/agents/monitoring-legacy.ts:114`, `maxToolCalls: 6`). Bringing it to 5 saves ~1 second of wall-clock; bringing the comparator sort from O(n log n) to O(n) saves nothing measurable, because n is 10.

```
  pick the ruler that actually constrains you

  ┌────────────────┬──────────────────────────────────────────────┐
  │ ruler          │ when it matters here                          │
  ├────────────────┼──────────────────────────────────────────────┤
  │ ops            │ never — n is always small                     │
  │ wall-clock     │ ALWAYS — Anthropic + Bloomreach calls         │
  │ space          │ caches; per-session Maps stay tiny            │
  │ amortized      │ not exercised — no dynamic resize hot paths   │
  │ money (tokens) │ every prompt — schemaSummary trims to bound it│
  └────────────────┴──────────────────────────────────────────────┘
```

#### what `n` is — the load-bearing question

Half of "what's the complexity" is just **what is `n` here**. Re-read the monitoring loop sort with that question:

```ts
// lib/agents/monitoring-legacy.ts:136
return [...parsed].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]).slice(0, 10);
```

- the spread `[...parsed]` — O(n), n = anomalies emitted by the agent (≤ 10, by convention)
- the comparator sort — O(n log n), same n
- the slice — O(k), k = 10

n is **at most 10**. The whole expression is constant for any practical purpose. If you're sorting the same way over 10 million rows, the conversation is different — same code, different cost story, because `n` is different.

Bridge from what you know: when you put a `.map().filter()` in a React list and someone says "is that slow?" the answer is "what's `list.length`?" Same instinct. Complexity without `n` named is theater.

#### amortized — the dynamic-array story

You won't find this in `blooming_insights` (no hand-rolled dynamic arrays — JS arrays handle it under the hood), but it's the one amortization story every engineer should be able to draw. A dynamic array doubles its capacity when it fills up:

```
  pushing to a dynamic array — execution trace

  capacity = 1, length = 0

  push A   length=1, capacity=1            cost 1     (no resize)
  push B   length=2, capacity=2  RESIZE    cost 1+1   (copy 1 + write)
  push C   length=3, capacity=4  RESIZE    cost 1+2   (copy 2 + write)
  push D   length=4, capacity=4            cost 1     (no resize)
  push E   length=5, capacity=8  RESIZE    cost 1+4   (copy 4 + write)
  push F   length=6, capacity=8            cost 1
  push G   length=7, capacity=8            cost 1
  push H   length=8, capacity=8            cost 1

  total cost across 8 pushes  ≈  16 ops
  amortized per push          ≈  2 ops    →  O(1) amortized
```

The lesson: worst-case for a single op is O(n), but average across a long run is O(1) because the resizes get rarer as the array grows. **Amortized analysis answers "what does the *long run* cost?" — useful any time you have a structure whose worst case is rare.**

#### space — the cache story you DO have

The response cache in the Bloomreach adapter is a real space-vs-time tradeoff:

```ts
// lib/data-source/bloomreach-data-source.ts:122
private cache = new Map<string, { result: unknown; expiresAt: number }>();
```

Each entry costs the size of the result blob. Across a briefing, the agent might call `execute_analytics_eql` 20 times with slightly different args — 20 cache entries, each a few KB. The cache trades **bytes for seconds** (skipping the rate-limit retry ladder).

```
  the tradeoff, drawn

  time saved per cache hit       ←→     bytes held per entry
  ~1-10 s (Bloomreach call)              ~1-10 KB (JSON blob)
  + skips rate-limit ladder              × number of unique calls
                                         × TTL (60 s default)
```

The TTL bounds the space (entries expire); the rate-limit ceiling motivates the cache. Without the cache, two agent turns asking the same EQL pay the full rate-limit penalty twice — which under the parsed-retry-hint waits ~10s per retry. The cache is paying bytes to avoid that.

### Move 3 — the principle

Complexity analysis is two questions, asked in order: **what's `n`, and which ruler matters?** The notation is just bookkeeping. The judgment is recognizing which cost model is the real constraint at this layer — and in a network-bound system, it's usually not the one the textbook chapter is about.

## Primary diagram

The full picture once more — costs by layer, with the seam that decides which ruler matters.

```
  blooming_insights — cost map

  ┌─ UI (browser) ─────────────────────────────────────────────────┐
  │  InsightCard reduce(4)        funnelStage argmin               │
  │     O(n), n=4                 O(n), n=4                        │
  │  readNdjson chunk loop                                          │
  │     O(line length) per chunk                                    │
  └────────────────────────────────────────────────────────────────┘
                  ▼  fetch + ReadableStream
  ┌─ Service (Next API routes) ────────────────────────────────────┐
  │  ★ runAgentLoop — wall-clock dominator ★                       │
  │     network O(turns × ~2s)                                      │
  │     sort top-10 anomalies     O(n log n), n≤10                  │
  │  filterToolSchemas             O(m + k), m=server tools         │
  │  schemaCapabilities            O(events × props)                │
  └────────────────────────────────────────────────────────────────┘
                  ▼  MCP transport (~1 req/s)
  ┌─ Storage (Bloomreach) ─────────────────────────────────────────┐
  │  EQL evaluation                opaque, server-side              │
  │  60s response cache (Map)      O(1) lookup, space O(entries)    │
  └────────────────────────────────────────────────────────────────┘

  ─────── seam ───────
  ABOVE: in-process,     ops ruler, microseconds
  BELOW: network call,   wall-clock ruler, seconds + rate limit
```

## Elaborate

Big O notation comes from Bachmann (1894) via Knuth's adoption in the 1970s as the standard vocabulary for analyzing algorithms. The full asymptotic family is Θ (tight bound), O (upper bound), Ω (lower bound) — in practice, working engineers say "O(n)" and mean "Θ(n)", and that's fine outside of a paper.

**Amortized analysis** is younger — Tarjan formalized the aggregate, accounting, and potential methods in 1985, motivated by data structures like splay trees and Fibonacci heaps where the worst case is misleading. The dynamic-array doubling argument above is the aggregate method in its simplest form.

The cost-model lesson is older than computer science: **measurement requires a unit**. The mistake new engineers make is reaching for "operations" when "wall-clock" or "tokens spent" is the constraint. The mistake senior engineers make is the opposite — micro-optimizing wall-clock when the algorithmic O is about to bite (e.g., shipping an O(n²) that's fine at staging-scale `n` and explodes at production-scale `n`). Both lessons live in the same vocabulary.

Read next: file 06 (sorting), where the n-log-n in `[...parsed].sort(...)` gets walked, and file 02 (hash maps), where O(1) Map lookups are anchored to the session-state code.

## Interview defense

### Q: What's the complexity of the monitoring agent's anomaly ranking?

The expression is `[...parsed].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]).slice(0, 10)`. Asymptotically it's O(n log n) for the sort plus O(n) for the spread and O(k) for the slice — overall O(n log n).

But the load-bearing answer is **n is at most ~10 anomalies** by convention in the prompt. So in practice it's constant — the sort isn't the bottleneck; the LLM call that produced the array took two seconds. If `n` could grow to 10⁶ the question would be different — and at that scale I'd reach for a fixed-size top-K heap instead of sort+slice (O(n log k) beats O(n log n)).

```
  the answer, drawn

  comparator sort   spread     slice
   O(n log n)    +   O(n)   +   O(10)
  ────────────────────────────────────
  practical:    n ≤ 10  →  microseconds
  network call:                ~2 seconds
                ▲
                └── that's the real cost
```

Anchor: `lib/agents/monitoring-legacy.ts:136`.

### Q: When would you choose space over time?

The response cache in `BloomreachDataSource` is the worked example. The Bloomreach server rate-limits ~1 request per 10 seconds and returns an error when you exceed it, and the retry ladder waits the full window before trying again. Two agent turns asking the same EQL would pay ~10s twice. The cache is a `Map<string, {result, expiresAt}>` keyed on `name+args` — each entry is a few KB, TTL 60s. **We trade bytes for seconds, and the TTL bounds the bytes.**

```
  cache vs no-cache, second call same args

  no cache:  call → rate-limit error → wait 10s → call → result
  cache hit: lookup → result   (microseconds)

  space cost: ~few KB per unique signature
  time saved: ~1-10 s per repeat
```

I'd reverse the call (skip the cache) if results were time-sensitive — staleness > 60s would mislead the agent. The 60s window is the staleness budget.

Anchor: `lib/data-source/bloomreach-data-source.ts:122` (the Map), `:139-188` (the cache check + retry ladder).

### Q: Explain amortized O(1) for a dynamic array push.

Single push worst case is O(n) because when capacity fills, the array doubles capacity by allocating a new buffer and copying every element across. But doublings get exponentially rarer — after the resize at capacity 2ᵏ, the next resize is 2ᵏ more pushes away. Across `n` pushes the total copy work is `1 + 2 + 4 + ... + n/2 < n`, so total cost is O(n) across n pushes, which is **O(1) amortized per push**.

```
  pushes 1..8, capacity doubles at 2, 4, 8

  costs:  1, 2, 2, 1, 4, 1, 1, 1   →  total 13
  per push average:  13 / 8  ≈  1.6   →  bounded constant

  the lesson: worst case per op is misleading;
  long-run total is what matters
```

The general principle: when a structure's worst case is rare and the rest is cheap, the *long-run* average is the honest cost. Most JS array operations fall under this — push and pop are amortized O(1), unshift and splice at the front are honestly O(n).

## See also

- 02-arrays-strings-and-hash-maps.md — where the O(1) Map operations live, anchored in the session state.
- 06-sorting-searching-and-selection.md — where the n-log-n comparator sort gets walked.
- 03-stacks-queues-deques-and-heaps.md — for the top-K heap that would replace sort+slice at scale.
- `.aipe/study-system-design/00-overview.md` — the architectural shape these costs sit inside.

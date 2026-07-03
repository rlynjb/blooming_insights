# Complexity and cost models

Industry names: Big-O notation, asymptotic analysis, amortized analysis, streaming vs batch. Type: Industry standard.

## Zoom out — cost models across the layers

You already know cost when you write it out loud: "this loop runs once per user, that one runs once per session." Big-O is just that thought in a portable notation. What matters for *this* repo is picking the right cost model — batch vs streaming, worst-case vs amortized — because the wrong model hides real bugs.

```
  Where cost decisions live in Blooming Insights

  ┌─ UI layer ─────────────────────────────────────┐
  │  React feed  ·  n = insights per session (~10) │  → O(n) fine
  └────────────────────┬───────────────────────────┘
                       │
  ┌─ Service layer ────▼───────────────────────────┐
  │  Agent loop  ·  n = model turns (~5-20)         │
  │  BudgetTracker.add()  ★ streaming ★             │  ← O(1) per turn
  │  filterToolSchemas    n = tools (~40)           │  → O(n·m) fine
  └────────────────────┬───────────────────────────┘
                       │
  ┌─ Transport layer ──▼───────────────────────────┐
  │  cache Map lookup  ·  O(1) amortized            │
  │  rate-limit retry  ·  ≤3 attempts (bounded)     │
  └────────────────────┬───────────────────────────┘
                       │
  ┌─ Eval layer ───────▼───────────────────────────┐
  │  percentiles()  ·  n = tool calls per run       │  ★ batch — O(n log n)
  │  worker pool    ·  N = 20, K = 3                │  → O(N/K) wall
  └────────────────────────────────────────────────┘
```

Only two of these are load-bearing decisions: `BudgetTracker.add()` (streaming — must stay O(1) because it fires once per model turn) and `percentiles()` (batch — allowed to be O(n log n) because it runs *once* at the end).

## Structure pass — the axis is cost

Layers: **UI**, **service**, **transport**, **eval**. Trace one axis — **cost per unit of work** — across all four.

- **UI**: cost = one React render per state change. n is tiny (`~10` insights). No optimization needed.
- **Service**: cost = tokens + wall time per model turn. The dominant cost isn't algorithmic; it's the API call. Local algorithms just can't be worse than the API round-trip.
- **Transport**: cost = HTTP round-trip + rate-limit wait (~10s per retry). Local work is invisible next to network cost.
- **Eval**: cost = the metric itself — we *measure* p50/p95/p99 here. This is where Big-O finally matters.

The seam flips at **service → transport**: cost changes from "CPU time per turn" to "wall-clock waiting on the network." A different cost model applies on each side. Same axis, different answer. Learn to spot which side you're on.

## How it works — three cost models the repo uses

### Move 1 — the mental model

Cost analysis is a magnifying glass at three focal lengths:

```
  Three focal lengths for cost — same operation, different answer

  ┌─ zoom in: per operation ─────────────────────────┐
  │  BudgetTracker.add()  →  3 additions + 1 counter │  → O(1)
  └───────────────────────┬──────────────────────────┘
                          │  aggregate across turns
  ┌─ zoom mid: per request ─▼────────────────────────┐
  │  agent loop  →  add() × T turns                  │  → O(T)
  └───────────────────────┬──────────────────────────┘
                          │  aggregate across load run
  ┌─ zoom out: per run ────▼─────────────────────────┐
  │  percentiles()  →  sort(all call durations)      │  → O(N log N)
  └──────────────────────────────────────────────────┘

  same code path, three cost stories — pick the right one for the question
```

The bug: reasoning about `add()` at the wrong focal length. It looks free (O(1)), but multiplied across `T` turns per request and `N` requests per run, that's `O(N·T)` allocations if you get the wrong data structure inside.

### Move 2 — the three models you'll reach for

**Worst-case Big-O** — the ceiling. What's the slowest this can get on adversarial input?

You use it when the input is bounded or trusted. Example: `filterToolSchemas` at `lib/agents/tool-schemas.ts:13-15` scans all tools once per allowed name.

```
  Worst-case walk: filterToolSchemas(all=40 tools, allowed=8 names)

  step 1:  set  = new Set(allowed)         // O(m)          allowed = 8
  step 2:  for each t in all:               // O(n) loop     all = 40
  step 3:      set.has(t.name)             // O(1) per check
  step 4:  return matches                   // 8 rows

  total:   O(n + m)  →  40 + 8  →  48 ops per bootstrap
```

Real code, side by side:

```ts
// lib/agents/tool-schemas.ts:13-15
const set = new Set(allowed);              // O(m) build
return all
  .filter((t) => set.has(t.name))          // O(n) scan, O(1) probe
  .map((t) => ({ name: t.name, ... }));    // O(k) map over matches
```

Load-bearing part — **`new Set(allowed)` before the filter**. If you skipped the Set and did `allowed.includes(t.name)` inside `.filter`, cost jumps from `O(n+m)` to `O(n·m)`. On this repo's scale (`n=40, m=8`) the difference is 48 vs 320 ops — invisible. On any larger tool catalog the shape of the code is what protects you.

**Amortized cost** — the average across many operations, even when one is slow.

You use it for data structures where most operations are cheap but occasional operations are expensive (dynamic array resize, hash table rehash, Bloom cache eviction). The load-bearing example in this repo is the `Map`-backed cache at `lib/data-source/bloomreach-data-source.ts:122`:

```
  Amortized read: cache.get(key)

  hot path:                       O(1) hash + eq                    [99% of calls]
  cold miss:  callTool + net      O(net) ≈ 200-2000ms                [1% of calls]

  amortized read cost = 0.99 · O(1) + 0.01 · O(net) ≈ O(1) if hit rate stays high
```

The word *amortized* means "we count the rare expensive operation but spread it across the many cheap ones." The cache is only worth it when hit rate is high enough that amortization wins — that's the design contract, not just a nice-to-have.

**Streaming vs batch** — the biggest cost decision in the repo.

Batch: hold all the data, then compute. Streaming: update state as each item arrives, hold nothing extra.

`BudgetTracker.add()` at `lib/agents/budget.ts:51-55` is the streaming case:

```ts
// lib/agents/budget.ts:51
add(usage: { inputTokens: number; outputTokens: number }): void {
  this.inputTokens += usage.inputTokens;      // O(1)
  this.outputTokens += usage.outputTokens;    // O(1)
  this.turns += 1;                            // O(1)
}
```

Three integer adds. Total state: three numbers. Whether the agent runs 3 turns or 300, this method's cost is constant. That's what streaming buys you: memory usage decoupled from input size.

`percentiles()` at `eval/report.eval.ts:161-179` is the batch case:

```ts
// eval/report.eval.ts:169-171
const sorted = [...arr].sort((a, b) => a - b);          // O(n log n) time, O(n) space
const pct = (p: number) => sorted[Math.min(sorted.length - 1,
                                           Math.floor((p / 100) * sorted.length))];
const mean = Math.round(sorted.reduce((s, n) => s + n, 0) / sorted.length);
```

Full copy, full sort, index lookup. This is fine because it runs once at the end of a load run over `~1000` tool-call durations. If you tried to compute p95 streaming (as each call arrives), you'd reach for a t-digest or reservoir sampling — a whole different algorithm.

**The rule of thumb:** if the operation runs *inside a hot loop*, it must be O(1) streaming. If it runs *once at the end*, O(n log n) batch is fine. The bug is confusing which one you're writing.

### Move 3 — the principle

Big-O is not a lecture-hall abstraction; it's the question *"what happens when the input gets 10× bigger?"* asked at three altitudes: per operation, per request, per run. Pick the wrong altitude and you'll optimize what doesn't matter or ignore what does. Every complexity choice in this repo is answering that question at one of those three altitudes — no more, no less.

## Primary diagram — cost model chosen per layer

```
  The three cost models mapped to the four layers

  ┌─ UI layer ──────────────────────────────────────┐
  │  n small → any model works, don't optimize      │
  └────────────────────┬────────────────────────────┘
                       │  seam: local cpu → cost
  ┌─ Service layer ────▼────────────────────────────┐
  │  BudgetTracker.add()   ★ STREAMING ★  O(1)/turn │
  │  filterToolSchemas     WORST-CASE     O(n+m)    │
  └────────────────────┬────────────────────────────┘
                       │  seam: local cpu → network
  ┌─ Transport ────────▼────────────────────────────┐
  │  cache.get()           AMORTIZED      O(1) avg  │
  │  retry ladder          BOUNDED WORST  ≤3 × 10s  │
  └────────────────────┬────────────────────────────┘
                       │  seam: streaming → batch
  ┌─ Eval ─────────────▼────────────────────────────┐
  │  percentiles()         BATCH          O(n log n)│
  │  worker pool wall      BOUNDED WORST  O(N/K)    │
  └─────────────────────────────────────────────────┘
```

## Elaborate

Big-O comes from Bachmann (1894) via Knuth's *The Art of Computer Programming*, but the useful modern shape — worst-case vs amortized vs expected — was formalized by Robert Tarjan in the 1980s (splay trees, union-find). The streaming/batch distinction became load-bearing with big-data systems (MapReduce, Storm, Flink) — the insight that memory usage is a first-class cost, not just runtime.

If you want the streaming quantile story, read **Ted Dunning's t-digest** paper and Facebook's HyperLogLog — the algorithms that let you compute p99 over a billion events without holding a billion floats. Those are what would replace `percentiles()` if the eval harness ever needed to scale to millions of tool calls.

For amortized analysis, read the classic **union-find with path compression** (Tarjan): individual operations look linear in the worst case but amortized cost is inverse-Ackermann — effectively O(1). Same shape as the cache-hit story here, just formalized.

## Interview defense

**Q: What's the time complexity of `filterToolSchemas`?**

Answer: O(n + m) where n = total tools and m = allowed names. Build the Set in O(m), scan tools in O(n) with O(1) membership test per tool. If you skipped the Set and did an array `.includes` inside the filter, it'd degrade to O(n·m).

```
  filterToolSchemas cost

  Set build   :  ● ● ● ●   O(m)
  scan+probe  :  ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪   O(n)   each ▪ = one O(1) probe
  total       :  O(n + m)
```

Anchor: `lib/agents/tool-schemas.ts:13-15`.

**Q: Why is `BudgetTracker.add()` O(1) — and why does it matter?**

Answer: Three integer additions and a counter. It matters because it's called once per model turn inside the agent loop; if it were O(t) where t is prior turns, cumulative cost across a T-turn conversation would be O(T²). Streaming state — three counters, no arrays — is what keeps it linear-total.

```
  Streaming vs batch for the budget

  streaming (current):  add() O(1) × T turns   →  O(T) total
  batch (hypothetical): store usage[], sum on read
                        each read O(T) × R reads  →  O(T·R) total
```

Anchor: `lib/agents/budget.ts:51-55`.

**Q: When is O(n log n) fine and when is it a bug?**

Answer: Fine when it runs once, at the end, over a bounded batch — like `percentiles()` at `eval/report.eval.ts:161` running over the whole receipt set after the load run finishes. It's a bug when the same sort runs *inside* a request path once per event — that turns a 5ms operation into a 5000ms one at n=10k. The tell is whether you're computing over accumulated state (batch) or per-event state (streaming).

```
  Sort-when: batch vs hot-path

  BATCH   :   agent loop done ──► sort receipts ──► print p95      // once
  HOT-PATH:   per event ──► sort history ──► pick threshold        // ✗ bug shape
```

Anchor: `eval/report.eval.ts:161`, contrast with `BudgetTracker.add()` at `lib/agents/budget.ts:51`.

## See also

- `02-arrays-strings-and-hash-maps.md` — the Set/Map primitives whose costs this file cites.
- `06-sorting-searching-and-selection.md` — the `percentiles()` sort, expanded.
- `.aipe/study-performance-engineering/` — how these theoretical costs turn into real p95 latency.

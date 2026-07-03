# Complexity and cost models

*Big-O notation · amortized analysis · streaming vs batch · Language-agnostic*

## Zoom out, then zoom in

Every other file in this guide asks "what does this cost?" — which is a question you can only answer once you've agreed on a cost *model*. Complexity notation is that agreement: a compact way to say "as `n` grows, what does the work do?" The picture below is where that question gets asked in this codebase.

```
  Zoom out — where cost gets counted in blooming_insights

  ┌─ UI layer ───────────────────────────────────────────────────┐
  │  React hooks, NDJSON reader — one line at a time, O(1) per   │
  │  line; total O(response length)                              │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ Route + agent layer ───▼────────────────────────────────────┐
  │  ★ THIS IS WHERE THE MODELS MATTER ★                         │
  │  · budget accumulator — O(1) per turn (streaming)            │
  │  · fault-injector CDF walk — O(k) rates per call             │
  │  · monitoring top-K — O(n log n) sort + slice                │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ Eval layer ────────────▼────────────────────────────────────┐
  │  · percentile via full sort — O(n log n) receipts            │
  │  · load-harness queue — O(1) shift/push, O(n) total          │
  └──────────────────────────────────────────────────────────────┘
```

The middle band is where the "what does this cost as n grows" question actually decides code shape. The UI is bounded by the response size; the eval layer is bounded by the receipt count (tens to hundreds). The agent layer runs per user turn — that's the one place a wrong cost model would blow up the whole system.

**Zoom in.** Complexity notation names the *growth* — the rate at which time or space climbs when input doubles. Amortized analysis names the *average* across a sequence of operations, hiding the occasional expensive one. Streaming vs batch names *when* you pay — one-shot for the whole input, or piece by piece as data arrives. Get all three vocabularies straight before opening the concept files that use them.

## Structure pass

**Layers.** Cost lives at three altitudes:
  1. per-operation cost (`add()` is O(1))
  2. per-request cost (an investigation makes M model turns × O(1))
  3. per-run cost (an eval loops N cases × M turns)

**Axis: what changes as `n` grows?** Hold that question constant down the stack:
  - per-operation → `n` is the *input size* of one call
  - per-request → `n` is the *turn count* per investigation
  - per-run → `n` is the *case count* in the eval

**Seam: where the model flips.** The load-bearing seam is between *streaming* and *batch*. Streaming ops (budget accumulator) never allocate `n` slots — space is O(1). Batch ops (percentile sort) hold all `n` items in memory. That flip is where "does this scale?" gets answered.

## How it works

### Move 1 — big-O is a growth rate, not a stopwatch

You already know this from work: `.map()` over a 10-element array is instant; over a 10-million-element array it isn't. What changed isn't the operation — it's `n`. Big-O drops constants and lower-order terms so the *shape* of that growth is visible without benchmarking.

```
  Growth-rate shapes — how work climbs as n doubles

  n:       1     2     4     8    16    32    64
  ────────────────────────────────────────────────
  O(1)     1     1     1     1     1     1     1    ← constant
  O(log n) 0     1     2     3     4     5     6    ← doubles = +1 step
  O(n)     1     2     4     8    16    32    64    ← doubles = doubles
  O(n log n)     2     8    24    64   160   384    ← sort's shape
  O(n²)    1     4    16    64   256  1024  4096    ← nested loop
  O(2^n)   2     4    16   256 65536 ...            ← unusable past small n
```

Read across a row: as `n` doubles, does the work stay flat, add one step, double, more than double? The answer names the class. Everything else — hidden constants, cache effects, GC pauses — hides inside the shape.

### Move 2 — the streaming vs batch flip

The single most useful move in this file: an operation that looks batch (`sort()`, `filter()`, `reduce()`) becomes streaming the moment you swap the *return* for an *update to a fixed-size accumulator*.

**Case A: batch (allocates n slots).**

```
  Batch pattern — hold everything, then compute

  input:  [t1, t2, t3, …, tN]     ← full array in memory
             │
             ▼
       ┌───────────┐
       │ operation │  reads all N items
       └─────┬─────┘  writes 1 result
             ▼
          result
```

Percentile via sort in `eval/report.eval.ts:161-179` is batch: `[...arr].sort(…)` holds every duration in memory, then indexes. Fine when N is 20-100 receipts. Blows up at millions.

**Case B: streaming (fixed-size state).**

```
  Streaming pattern — collapse each item into state, drop it

  input:  t1 → t2 → t3 → … → tN     ← one at a time
          │    │    │         │
          ▼    ▼    ▼         ▼
       ┌──────────────────────────┐
       │ state (fixed size)       │  ← same size regardless of N
       └────────────┬─────────────┘
                    ▼
                 result
```

`BudgetTracker.add()` in `lib/agents/budget.ts:51-55` is streaming: three integers, updated in place, never grows. `snapshot()` reads the state, doesn't re-scan history.

Load-bearing code, side by side with the pattern:

```ts
// lib/agents/budget.ts:41-55 — streaming O(1) accumulator
export class BudgetTracker {
  private inputTokens = 0;      // ← fixed-size state, three ints
  private outputTokens = 0;
  private turns = 0;

  add(usage: { inputTokens: number; outputTokens: number }): void {
    this.inputTokens += usage.inputTokens;   // ← O(1) per model turn
    this.outputTokens += usage.outputTokens; //   no allocation
    this.turns += 1;
  }
  // ...
}
```

The trick: `add()` is called every time an Anthropic response comes back — potentially dozens of times per investigation. If this had to keep an array of `{ inputTokens, outputTokens }` per turn and sum on read, the exceeded() check would be O(turns) every call — an O(n²) hot path. Making the accumulator streaming makes the whole ceiling-check machinery O(1).

### Move 2 — amortized analysis: the average across a sequence

Big-O of a *single* operation can lie about the *sequence*. A `push()` into a dynamic array is O(1) most of the time and O(n) on the rare copy-to-a-bigger-buffer. Amortized analysis smooths this: divide the worst-case cost of a big operation across the many cheap ones that follow, and each push averages out to O(1).

```
  Amortized cost — smoothing the spike across the run

  op:      1  2  3  4  5  6  7  8  9 …
  cost:    1  1  1  1  4  1  1  1  1     ← op 5 was the resize (copy 4)
                       ▲
                       └── amortized: total cost / n ops = ~1.4 → O(1)
```

Where this matters in the repo: `queue.push(...)` and `queue.shift()` in `eval/load.eval.ts:171-176`. `Array.shift()` in JS is *technically* O(n) because it re-indexes the remaining elements. Load-harness runs are small (LOAD_N up to a couple hundred), so nobody noticed. If the queue held millions of tasks, you'd swap for an index cursor or a real deque — the honest answer under interview pressure.

### Move 3 — the principle

**Pick the model to match the pressure.** For a static array of receipts you'll iterate a few times: O(n log n) sort is honest. For an accumulator that fires per model turn inside a long-running investigation: O(1) streaming is load-bearing. The interview signal isn't quoting Big-O — it's saying "here's what n is, here's how fast it grows in this codebase, here's the model I picked and here's the class of change that would flip the model."

## Primary diagram

The whole story: the batch/stream flip is where the class of scaling changes, and it's chosen by whether the operation returns a value or updates a fixed-size state.

```
  Complexity-model decision — the flip that matters

           ┌─ input size known & bounded? ─────┐
           │                                    │
       yes ▼                                no  ▼
     ┌────────────────┐                ┌────────────────┐
     │ BATCH is fine  │                │ STREAMING wins │
     │                │                │                │
     │ sort + index   │                │ accumulator    │
     │ full-array ops │                │ fixed state    │
     │ O(n log n) OK  │                │ O(1) per item  │
     └────────────────┘                └────────────────┘
       report.eval.ts                    budget.ts
       :161 percentiles                  :51 add()
       (N ≤ hundreds)                    (per model turn)
```

## Elaborate

Big-O comes from Bachmann (1894) and Landau (1909) as an *asymptotic* notation — it describes limits, not concrete times. Knuth popularized it for algorithm analysis in the 1970s. The important thing to internalize: it's a *tool for choosing between shapes*, not a benchmark. Two O(n log n) sorts can differ 10× in wall-clock — one is cache-friendly, one is a mess of pointer-chasing. Big-O tells you the shape; profiling tells you the constant.

Amortized analysis comes from Tarjan's "potential method" (1985) — a way to give sequences of operations honest complexity by lending cheap ops future budget for expensive ones. Dynamic array growth (JS `Array`, Python `list`, C++ `vector`) is the canonical example.

Streaming algorithms have their own literature — Munro-Paterson for streaming quantiles (1980), Flajolet-Martin for streaming cardinality (1985), Morris for streaming approximate count (1978). All share the same shape: fixed-size state, one pass, approximate answers with tight bounds. The `BudgetTracker` is an exact-answer streaming accumulator because it only tracks sums; the moment you'd want p95 across turns, you'd need one of those approximate sketches.

Related reading: CLRS chapter 17 (amortized), Skiena chapter 1 (Big-O), Aggarwal & Vitter (1988) for I/O-model complexity — a totally different cost model where disk-page reads are the unit, not comparisons.

## Interview defense

**Q: This codebase mostly uses O(1) hash maps and O(n) linear scans. What's the interesting cost-model story?**

The streaming-vs-batch flip in `budget.ts` vs `report.eval.ts`. Both track running numbers across a sequence. The budget tracker is streaming — three integer accumulators, O(1) per model turn — because it's called *inside the hot path* of an investigation, potentially hundreds of times. The percentile report is batch — full sort, O(n log n) — because it runs *once at the end* over a fixed array of receipts. The insight is choosing the model based on where in the system the operation lives, not on the operation itself. If `add()` had to hold every turn's usage and re-sum, the ceiling check would be O(n) per turn — O(n²) across the investigation.

```
  The flip — same "track a sequence" problem, two models

  budget.ts (hot path)              report.eval.ts (once-per-run)
  ────────────────────              ─────────────────────────────
  streaming O(1)/turn               batch O(n log n) once
  fixed-size state                  full array in memory
  no revisit of past turns          reads all receipts, sorts, indexes
```

**Anchor:** "The model is chosen by where the operation lives, not what it does — hot path gets streaming, end-of-run gets batch."

**Q: What's O(n log n) actually doing in `sort`?**

Comparison-based sort's lower bound is `log₂(n!) ≈ n log n` comparisons — you can't beat it without exploiting structure (radix sort's O(n) needs digit-count assumptions). JS's `Array.prototype.sort` is Timsort in V8 (adaptive merge sort) — O(n) on nearly-sorted data, O(n log n) worst case. In `report.eval.ts` the durations are unsorted, so it's the worst-case shape.

```
  Why sort can't beat n log n (comparison-based)

  n items → n! possible orderings
  each comparison halves the possibility space
  need ⌈log₂(n!)⌉ ≈ n log n comparisons
  → any comparison sort has this lower bound
```

**Anchor:** "Comparison sort's floor is log(n!) — no algorithm beats it without exploiting structure like digit-count."

**Q: When would you actually replace one of these with a fancier data structure?**

The one place in this repo I'd swap today: `monitoring-legacy.ts:136`'s sort-and-slice-10. It's currently O(n log n) over a small array — the array is small enough that the swap doesn't matter. If a future feature has the agent produce hundreds of anomaly candidates and pick the top 10, a size-10 min-heap gets it to O(n log 10) = O(n). I've built the PriorityQueue in `reincodes` — the swap is one class import, not a research project.

**Anchor:** "The heap swap is one file away — I've built the primitive; the question is when n gets big enough to justify it."

## See also

  → `02-arrays-strings-and-hash-maps.md` — the primitives most of this repo's O(1) and O(n) claims sit on top of
  → `03-stacks-queues-deques-and-heaps.md` — where the heap-vs-sort tradeoff for top-K gets its full treatment
  → `06-sorting-searching-and-selection.md` — where the O(n log n) sort meets the O(log n) binary-search gap
  → `study-performance-engineering` — same cost primitives, different question ("what does this actually take on the box?")

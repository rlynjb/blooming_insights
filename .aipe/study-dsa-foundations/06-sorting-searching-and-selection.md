# Sorting, searching, and selection

*Comparison sort · binary search · quickselect · Industry standard*

## Zoom out, then zoom in

Sort shows up in this repo in exactly the shapes you'd expect for an app that reports evaluation metrics: sort-then-index for percentiles, sort-then-slice for top-K. Search is where the honesty comes in — every "find X in array" call in the codebase is a linear scan, not a binary search. That's fine when arrays are small; naming when it stops being fine is the interview signal.

```
  Zoom out — where sort / search live in blooming_insights

  ┌─ UI ────────────────────────────────────────────────────────┐
  │  (no sort — response order is preserved from the stream)    │
  └─────────────────────────┬───────────────────────────────────┘
                            │
  ┌─ Agent / route layer ───▼───────────────────────────────────┐
  │  · monitoring-legacy.ts:136 — sort + slice(10) for top-K   │
  │  · categories-legacy.ts:120 — new Set for dedup             │
  └─────────────────────────┬───────────────────────────────────┘
                            │
  ┌─ Eval layer ────────────▼───────────────────────────────────┐
  │  ★ THIS CONCEPT LIVES HERE ★                                │
  │  · report.eval.ts:161-179 — sort for percentiles (p50/p95)  │
  │  · load.eval.ts:216 — sort investigations by index          │
  │                                                              │
  │  · gate.eval.ts:180 — new Set for dedup runIds              │
  │  · baseline.eval.ts:123 — new Set for dedup runIds          │
  │                                                              │
  │  no binary search anywhere — all lookups are linear scan    │
  │  or hash-set membership                                     │
  └─────────────────────────────────────────────────────────────┘
```

**Zoom in.** Comparison sort has a fundamental floor: `O(n log n)`. You can't beat it without exploiting structure (digit-count for radix sort, small integers for counting sort). Binary search on a *sorted* array is O(log n). Quickselect (or Median-of-medians) gets you the k-th smallest without fully sorting — O(n) expected. This file walks all three and names when to reach for each.

## Structure pass

**Layers.** Two altitudes:
  1. the *operation* (sort the whole thing, find one item, find the k-th item)
  2. the *precondition* (unsorted → sort or scan; sorted → binary search; small n → don't bother)

**Axis: what does one lookup cost?** Trace it down:
  - unsorted array + linear scan → O(n)
  - sorted array + binary search → O(log n)
  - hash set → O(1) average
  - BST → O(log n) if balanced, O(n) worst-case

**Seams.** The load-bearing seam is between *sortedness* and *lookup cost*. Sort once, search many times → the sort amortizes. Sort once, search once → the sort is wasted; linear scan is cheaper. Every "should this be sorted?" question in an application collapses to that ratio.

## How it works

### Move 1 — comparison sort's floor is `n log n`

You can't sort `n` items using comparisons in less than `⌈log₂(n!)⌉ ≈ n log n` comparisons. The intuition: there are `n!` possible orderings, each comparison eliminates at most half the remaining possibilities, so you need `log₂(n!)` decisions. Everything you know as "fast sort" (Timsort, quicksort, mergesort, heapsort) hits this floor. Radix sort and counting sort beat it by *not being comparison-based* — they use structure in the input (digit width, integer range).

```
  Sort algorithms — the family and their tradeoffs

  algo         avg time      worst        space     stable?  in-place?
  ─────────────────────────────────────────────────────────────────────
  bubble       O(n²)         O(n²)        O(1)      yes      yes
  insertion    O(n²)         O(n²)        O(1)      yes      yes
  selection    O(n²)         O(n²)        O(1)      no       yes
  mergesort    O(n log n)    O(n log n)   O(n)      yes      no
  quicksort    O(n log n)    O(n²)        O(log n)  no       yes
  heapsort     O(n log n)    O(n log n)   O(1)      no       yes
  Timsort      O(n log n)    O(n log n)   O(n)      yes      no
  ─────────────────────────────────────────────────────────────────────
  radix        O(nk)         O(nk)        O(n+k)    yes      no
  counting     O(n+k)        O(n+k)        O(k)      yes      no
```

`Array.prototype.sort` in V8 is Timsort (since 2018) — adaptive merge sort that's O(n) on nearly-sorted data and O(n log n) worst case. Stable. This is what your `.sort()` call actually runs.

### Move 2 — sort-then-index for percentiles (the actual repo use)

`eval/report.eval.ts:161-179` is the biggest sort in the codebase. The shape: sort an array of durations, then pick indices at the desired percentile positions.

```
  Percentile via sort — the classic batch algorithm

  input: durations = [847, 1203, 512, 3401, 998, ..., 1502]

  step 1: sort ascending          O(n log n)
    → [412, 512, 587, ..., 3401]

  step 2: index into positions    O(1) per pick
    p50 = sorted[⌊n × 0.50⌋]      ← median
    p95 = sorted[⌊n × 0.95⌋]
    p99 = sorted[⌊n × 0.99⌋]
    max = sorted[n - 1]
```

The code — the whole helper fits on 20 lines:

```ts
// eval/report.eval.ts:161-179 — batch percentile
function percentiles(arr: readonly number[]): {
  p50: number; p95: number; p99: number; max: number; mean: number;
} {
  if (arr.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...arr].sort((a, b) => a - b);          // ← O(n log n)
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const mean = Math.round(sorted.reduce((s, n) => s + n, 0) / sorted.length);
  return {
    p50: pct(50),                                          // ← O(1) index pick
    p95: pct(95),
    p99: pct(99),
    max: sorted[sorted.length - 1],
    mean,
  };
}
```

Three load-bearing parts:

  **1. The comparator `(a, b) => a - b`.** Without an explicit comparator, `.sort()` converts to string and sorts lexicographically — `[10, 2, 3]` becomes `[10, 2, 3]` (because "10" < "2" alphabetically). The numeric comparator is the load-bearing part that's easy to forget. This is one of the most common JS-native gotchas.

  **2. The copy `[...arr]`.** `.sort()` mutates in place. Without the spread, callers would find their input array reordered — an unpleasant surprise. The copy costs O(n) space but saves you from a data-corruption class of bugs.

  **3. The index clamp `Math.min(sorted.length - 1, ...)`.** For a small array, `Math.floor(0.99 * 3)` is `2`, which is valid. For an array of 1 element, `Math.floor(0.99 * 1)` is `0`, also valid. But `Math.floor(1.0 * n)` is `n`, which is *out of bounds* — the clamp guards against a caller passing p=100 (which nothing does, but the guard is honest defensive coding).

**Cost math.** For a typical eval run:

```
  n = 20 receipts × 5 phases = ~100 durations per phase call
  sort cost: ~100 log 100 ≈ 700 comparisons
  wall time: microseconds
  → the sort is invisible at this scale
```

If `n` crossed 100,000, the O(n log n) sort would still be sub-second — but a *streaming* quantile sketch (t-digest, GK) would beat it. At the scale in this repo, sort is the honest answer.

### Move 2 — top-K via sort-and-slice (the other repo pattern)

`monitoring-legacy.ts:136` is the same shape with a `.slice(K)` on the end:

```ts
// lib/agents/monitoring-legacy.ts:136 — top-K by sort
return [...parsed]
  .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])   // desc by severity
  .slice(0, 10);                                                  // keep top 10
```

Same three load-bearing parts as the percentile helper. The critique of this vs a size-K heap is in `03-stacks-queues-deques-and-heaps.md` — the short version: sort wins for small n (constants), heap wins past ~50-100 items (O(n log K) vs O(n log n)).

### Move 2 — binary search: the O(log n) shape not exercised here

Binary search assumes a sorted array. Each comparison eliminates half the remaining search space, so it terminates in `⌈log₂(n)⌉` iterations.

```
  Binary search — halve the search space each iteration

  sorted array: [3, 7, 12, 18, 24, 31, 42, 55, 68, 79, 90]
                 0  1   2   3   4   5   6   7   8   9  10
  target: 42

  step  lo  hi  mid  arr[mid]  action
  ──────────────────────────────────────
   1     0  10   5      31     31 < 42, go right → lo = 6
   2     6  10   8      68     68 > 42, go left  → hi = 7
   3     6   7   6      42     found → return 6
```

Pseudocode:

```
  function binarySearch(sorted, target):
    lo = 0
    hi = length - 1

    while lo <= hi:                    ← TERMINATION: search space empty
      mid = (lo + hi) >> 1             ← safer than (lo + hi) / 2 for large ints
      if sorted[mid] == target: return mid
      if sorted[mid] < target: lo = mid + 1     ← eliminate left half
      else                   : hi = mid - 1     ← eliminate right half

    return -1                          ← not found
```

**What breaks if you use `<` instead of `<=` in the while?** You miss single-element ranges — when `lo == hi`, the check would exit without ever comparing `arr[lo]` to the target. Off-by-one bug that's famously easy to write and famously hard to spot.

**What breaks if you do `mid = (lo + hi) / 2` instead of the shift?** In languages with fixed-width integers (C, Java, Go), `lo + hi` can overflow when both are near INT_MAX. Not a JS problem (numbers are 64-bit floats), but a genuine C/Java gotcha — Bentley shipped a binary-search bug in the Java standard library for 9 years because of exactly this.

**Why isn't it used in this repo?** Nothing is stored sorted. Every array is either (a) small and iterated linearly, or (b) unsorted event data where a hash set gives O(1) membership. Binary search earns its keep when you have a *big sorted list* and you're doing *many lookups*. Neither condition holds here.

### Move 2 — quickselect: k-th element without fully sorting

If you only need the k-th smallest element (or the median), you don't need to sort. Quickselect is quicksort's partition step, applied recursively only on the side that contains position k. Expected O(n), worst-case O(n²).

```
  Quickselect — quicksort's partition, but only recurse on one side

  input: [7, 2, 8, 1, 4, 9, 3], find k=3rd smallest

  partition around pivot 4:
    [2, 1, 3] [4] [7, 8, 9]
       │       │       │
    len 3   index 3  len 3

  k=3 → we want the pivot itself → return 4

  Total work: O(n) partition + smaller recursion
  Expected: T(n) = O(n) + T(n/2) = O(n)
  Worst case: T(n) = O(n) + T(n-1) = O(n²)  ← bad pivot every time
```

Median-of-medians (Blum-Floyd-Pratt-Rivest-Tarjan, 1973) gives you O(n) *worst-case* selection by choosing a provably-decent pivot. Constants are terrible in practice; quickselect with random pivots is what libraries actually use (`std::nth_element` in C++).

Not used in this repo. Would become relevant if you needed "the median investigation duration" from a *streaming* set of receipts — but you compute percentiles from a fully-materialized array where sort is fine, so quickselect never earns its keep.

### Move 3 — the principle

**Sort when you'll query many times; scan when you'll query once; hash when you only ask membership.** The sort-then-index shape earns its keep in `report.eval.ts` because you compute p50/p95/p99/max/mean from the same sorted array — five queries for one sort. If you only needed max, `arr.reduce((a, b) => Math.max(a, b))` is O(n) with no sort. If you only needed membership, a Set is O(1) with no ordering. Match the shape to the query pattern.

## Primary diagram

The whole story — sort earns its keep here because we query the sorted result several times; binary search never enters because we never store anything sorted.

```
  Sort / search / select in blooming_insights — the surface

  ┌─ SORT-THEN-INDEX (percentiles) ────────────────────────────┐
  │                                                             │
  │  eval/report.eval.ts:161-179                                │
  │  · sort [n] durations, index at p50/p95/p99/max             │
  │  · O(n log n) sort + 5 × O(1) picks                         │
  │  · n = ~100 per phase → invisible                           │
  └─────────────────────────────────────────────────────────────┘

  ┌─ SORT-THEN-SLICE (top-K) ──────────────────────────────────┐
  │                                                             │
  │  lib/agents/monitoring-legacy.ts:136                        │
  │  · sort by severity desc, slice(0, 10)                      │
  │  · O(n log n) — could be O(n log 10) with a size-K heap     │
  │  · n stays tiny today → sort is fine                        │
  └─────────────────────────────────────────────────────────────┘

  ┌─ NOT USED HERE ────────────────────────────────────────────┐
  │                                                             │
  │  · binary search (nothing is stored sorted for lookups)     │
  │  · quickselect / median-of-medians (batch sort is fine)     │
  │  · radix / counting sort (no digit-count structure)          │
  │                                                             │
  │  practice in reincodes / LeetCode                           │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

The comparison-sort lower bound (n log n) comes from information theory — sorting is a decision-tree problem, and a decision tree with `n!` leaves must have depth at least log(n!). This bound holds for *any* algorithm that only uses comparisons. Non-comparison sorts (counting, radix, bucket) beat it by exploiting structure in the input — counting sort is O(n + k) where k is the value range, radix is O(nk) where k is the digit count.

Timsort (Tim Peters, 2002 for CPython; ported to Java 7, V8 2018) is the modern default in most standard libraries. It's adaptive merge sort with two clever optimizations: (1) it detects existing runs (already-sorted subsequences) and merges them directly instead of re-sorting, giving O(n) on nearly-sorted data; (2) it uses "galloping" merge to handle unbalanced merges efficiently. This is why Timsort feels faster than "asymptotic tied with mergesort" would predict — real-world data is often nearly-sorted.

Introsort (Musser, 1997) is the algorithm behind `std::sort` in C++ and `Array.sort` in older V8. It's quicksort with a fallback to heapsort when the recursion depth exceeds `2 log n` — this bounds the worst case to O(n log n) while keeping quicksort's speed in the common case.

Streaming quantile sketches — t-digest (Dunning, 2013), Greenwald-Khanna (2001), HDR Histogram — approximate percentiles in O(1) space with tight error bounds. Datadog, InfluxDB, Prometheus, and other metrics systems all use one of these. Would replace `report.eval.ts`'s sort the moment the receipt count crossed hundreds of thousands.

Related reading: CLRS chapter 8 (sort lower bound + linear-time sorts), 9 (quickselect + median), Sedgewick chapters 2 (elementary sorts) and 3.3 (quicksort). For the streaming-quantile story, "Optimal Quantile Approximation in Streams" (Greenwald & Khanna, 2001) is the seminal paper; the t-digest paper is a shorter modern reference.

## Interview defense

**Q: `report.eval.ts` sorts to compute percentiles. When would you swap for a streaming sketch?**

When N crossed roughly 10^5 receipts *and* the report needed to be produced live rather than at end-of-run. Sort is O(n log n) time, O(n) space — at n=100 that's ~700 comparisons and ~800 bytes; at n=10⁵ that's ~1.6M comparisons and 800KB. Still sub-second, still fine. At n=10⁸ or streaming with unbounded time horizon, you'd swap for t-digest or GK sketch: O(1) space, O(log ε⁻¹) update, tight error bounds. Right now `report.eval.ts` reads ~20 receipts — sort is dramatically the right call.

```
  Percentile approach — the crossover

  n ≤ 10⁴, batch report      → sort + index          ← current
  n ~ 10⁵, still batch       → sort still OK
  n ≥ 10⁶ OR streaming        → t-digest / GK sketch
```

**Anchor:** "Sort at receipt-scale; sketch at metrics-scale. The flip is around 10⁵ or when 'live' is required."

**Q: The top-K in `monitoring-legacy.ts` sorts and slices. When does that become the wrong call?**

When the array crosses ~50-100 items. Sort is O(n log n); size-K heap is O(n log K). At n=1000, K=10, sort does ~10,000 comparisons; heap does ~3,300. At n=100, they're a wash. The current use has n in the low tens — sort wins on constants. The moment a briefing batches anomalies across sessions or the diagnostic pulls hundreds of candidates, the swap earns its keep. I'd measure before swapping (profile the actual n), not preemptively.

**Anchor:** "n < 100 → sort. n > 100 with hot-path top-K → heap. Measure first."

**Q: Why isn't there any binary search in this codebase?**

Because nothing is stored sorted, and the arrays where a lookup happens are small. Every "does this collection contain X?" question uses a `Set` (O(1)). Every "process each item" uses `.map` / `.filter` / `.reduce` (O(n) linear scan). The one place binary search would fit — say, "find the receipt with the closest timestamp to T" — doesn't come up because timestamps aren't a lookup axis in the current UX. Add a "receipt at time T" query over thousands of receipts and I'd sort them by timestamp once at load time and binary-search after that.

**Anchor:** "No binary search because nothing here is (sorted AND big AND queried many times) — all three would need to be true."

**Q: Explain quickselect vs sort.**

Sort produces the entire ordering; quickselect produces one element (the k-th smallest). If you only need the median or one percentile, quickselect is O(n) expected, sort is O(n log n) — a real win for a single query. But if you need *five* percentiles from the same array (like report.eval.ts does), you'd call quickselect five times — 5 × O(n) = O(5n), while one sort is O(n log n) which for n=100 is ~700 (less than 5n=500... actually less than 5 quickselects). So multi-percentile queries flip back toward sort. Rule of thumb: single quantile → quickselect; multiple quantiles from the same batch → sort.

```
  Quickselect vs sort — pick based on # of queries

  1 quantile           → quickselect wins (O(n) < O(n log n))
  5 quantiles          → sort wins (O(n log n) < 5 × O(n) at small n)
  streaming, 1+        → sketch wins (O(1) space)
```

**Anchor:** "Quickselect for one quantile; sort for many from the same batch; sketch for streaming."

## See also

  → `01-complexity-and-cost-models.md` — the O(n log n) floor and the streaming-vs-batch story this file rests on
  → `03-stacks-queues-deques-and-heaps.md` — the heap-based top-K alternative
  → `04-trees-tries-and-balanced-indexes.md` — sorted-container alternatives (BST, B-tree) not exercised here
  → `study-performance-engineering` — same operations, different question ("what does this cost on the box under load?")

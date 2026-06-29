# Sorting, Searching, and Selection

Comparator sort · binary search · top-K selection · linear scan — Industry standard

## Zoom out — where this concept lives

One comparator sort in the service layer (the anomaly top-10 in the monitoring agent), one argmin reduce in the UI (the funnel-stage leak), and a lot of linear scans. **No binary search anywhere.** No quickselect, no merge-K-sorted-lists, no external sorting. The diagram marks the one real sort.

```
  Zoom out — where ordering and lookup happen

  ┌─ UI (browser) ─────────────────────────────────────────────────┐
  │  argmin reduce over 4 funnel stages                             │
  │   funnelStages.reduce((a, b) => (b.v < a.v ? b : a))            │
  │   (InsightCard.tsx:160 — picks the smallest-v stage as "leak")  │
  └────────────────────────────────────────────────────────────────┘
                          ▼
  ┌─ Service (Next API) ───────────────────────────────────────────┐
  │  ★ comparator sort + slice (top-K with K=n) ★                  │
  │  monitoring-legacy.ts:136                                       │
  │  [...parsed]                                                    │
  │    .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]) │
  │    .slice(0, 10)                                                │
  │                                                                 │
  │  linear filter+map all over: tool-schemas, categories,          │
  │  evidence pulls, parseAgentJson candidate scan                  │
  │                                                                 │
  │  NO binary search.                                              │
  │  NO quickselect.                                                │
  └────────────────────────────────────────────────────────────────┘
                          ▼
  ┌─ Storage (Bloomreach) ─────────────────────────────────────────┐
  │  the EQL engine almost certainly sorts internally (ORDER BY)    │
  │  — but we don't see it from this codebase.                      │
  └────────────────────────────────────────────────────────────────┘
```

## Zoom in — the concept

Sorting puts things in order; searching finds one of them; selection finds the k-th by some criterion (the median, the top-K, the smallest). These are three different jobs, and the right algorithm depends on which one you actually need.

The honest take on this repo: **the data is always tiny (≤10 items at any sort site), the keys are always hashable strings, and ordered queries don't happen.** So sorting is one comparator call, searching is `Map.get`, and selection is `sort+slice`. There's nothing wrong with that — it's the right code for the scale. The interview surface is everything *not* exercised: binary search, quickselect, merge sort, the stability question.

## Structure pass — layers · axes · seams

One axis traced: **what cost does each ordering operation pay, and at what input size does the cost stop being free?**

```
  one axis — "when does the cheap version stop being fine?"

  ┌─ linear scan (find / filter / map) ──────────────────────────┐
  │   cost: O(n)                                                   │
  │   fine when: n is small OR you only do it once                 │
  │   stops being fine when: you repeat the scan in a loop         │
  │     → build a Map / Set once, lookup O(1) thereafter (file 02) │
  └──────────────────────────────────────────────────────────────┘
  ┌─ argmin / argmax via reduce ─────────────────────────────────┐
  │   cost: O(n), one pass                                         │
  │   fine when: you need ONE extreme value, not a sorted list     │
  │   stops being fine when: you need the top K → sort or heap     │
  └──────────────────────────────────────────────────────────────┘
  ┌─ comparator sort ────────────────────────────────────────────┐
  │   cost: O(n log n)                                             │
  │   fine when: n is reasonable AND you need order, not just one  │
  │   stops being fine when: n is huge AND K << n → reach for heap │
  └──────────────────────────────────────────────────────────────┘
  ┌─ binary search ──────────────────────────────────────────────┐
  │   cost: O(log n)                                               │
  │   fine when: data is already sorted AND queries are repeated   │
  │   stops being fine when: data mutates between queries          │
  │     → balanced BST (file 04) for query+mutate workloads        │
  └──────────────────────────────────────────────────────────────┘

  the seam in this repo: every site sits at "n is small, linear is fine."
```

- **layers**: same three. The work lives in the service layer (one sort) and the UI (one argmin).
- **axis**: cost vs scale. Each row names when the cheap option breaks.
- **seam**: when `n` crosses the threshold where the asymptotic cost matters. In this repo, it never does — but the interview surface assumes it will.

## How it works

### Move 1 — the mental model

A comparator sort is a function that says "given any two elements, which one comes first?" The sort algorithm shuffles the array until every pair is in agreement. **What makes it O(n log n)** is the divide-and-conquer structure: you can't avoid `n` comparisons (every element must be looked at) and the log n comes from halving the problem repeatedly (merge sort splits in half; quicksort partitions; heapsort builds and tears down a heap, where heap operations are log n).

Binary search is the same divide-and-conquer instinct on lookup: at each step, halve the search range. **Requires the array to be sorted** — that's the precondition that makes it work. Without sortedness, you fall back to linear scan.

```
  binary search — the pattern

  sorted array:  [ 1, 4, 7, 12, 23, 47, 51, 88, 100 ]
  target = 23

  step 1:  lo=0, hi=8, mid=4 → array[4]=23 → found!  done in 1 step.

  target = 50

  step 1:  lo=0, hi=8, mid=4 → array[4]=23  → 50 > 23, go right
                                              lo=5, hi=8
  step 2:  lo=5, hi=8, mid=6 → array[6]=51  → 50 < 51, go left
                                              lo=5, hi=5
  step 3:  lo=5, hi=5, mid=5 → array[5]=47  → 50 > 47, go right
                                              lo=6, hi=5 → not found

  total comparisons: 3 for an array of 9 → log₂(9) ≈ 3.2  ✓
```

Selection (top-K, k-th smallest) sits between sort and search. You can implement it by **sort then take K** (O(n log n)) or by **quickselect** (average O(n)) or by a **fixed-size heap of K** (O(n log K)). The right one depends on whether `K` is small, whether `n` is known, and whether streaming.

### Move 2 — the moving parts

#### the one comparator sort — anomaly ranking

The monitoring agent gets back an array of anomalies in arbitrary order. It ranks them by severity and takes the top 10:

```ts
// lib/agents/monitoring-legacy.ts:59 + 136
const SEV_RANK: Record<Severity, number> = { critical: 3, warning: 2, info: 1, positive: 0 };

// ...

return [...parsed].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]).slice(0, 10);
```

Read line by line:

- **`SEV_RANK`** is the comparator's lookup. Mapping severities to integers so `b - a` gives the comparator signal `Array.prototype.sort` expects (negative = a first, positive = b first).
- **`[...parsed]`** — spread to a new array. The sort is in-place, so spreading avoids mutating the agent's output.
- **`.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])`** — comparator order is `b - a` for descending. `b` first → larger SEV_RANK first → critical above warning above info above positive.
- **`.slice(0, 10)`** — take the first 10. Top-K via sort+slice.

Total cost: O(n) spread + O(n log n) sort + O(k) slice. **For n ≤ 10 (the prompt's cap), it's microseconds.** The whole expression runs after a multi-second LLM call; the sort isn't the bottleneck.

```
  execution trace — 4 anomalies in, ranked + sliced

  parsed = [
    { metric: "x", severity: "warning" },   // SEV_RANK = 2
    { metric: "y", severity: "critical" },  // SEV_RANK = 3
    { metric: "z", severity: "info" },      // SEV_RANK = 1
    { metric: "w", severity: "critical" },  // SEV_RANK = 3
  ]

  spread:    [...parsed] = same 4 items, new array
  sort by (b - a) of SEV_RANK:
    critical (3), critical (3), warning (2), info (1)
    → [y, w, x, z]    (y and w tie; stable sort keeps original order)

  slice(0, 10):   [y, w, x, z]   (k=10, n=4, returns all)
```

**The stability note** — JS `Array.prototype.sort` is guaranteed stable since ES2019. That matters here: two `critical` anomalies stay in the order Claude emitted them. If sort were unstable, you'd get nondeterministic ranking among ties — bad for screenshots, bad for snapshot tests, bad for the demo path.

#### the argmin reduce — the funnel leak

The `InsightCard` finds the funnel stage with the smallest value (the "leak point"):

```ts
// components/feed/InsightCard.tsx:155-161
const funnel = insight.funnel;
const funnelStages = funnel
  ? (['view', 'cart', 'checkout', 'purchase'] as const).map((k) => ({ k, v: funnel[k] }))
  : [];
const leakKey = funnelStages.length
  ? funnelStages.reduce((a, b) => (b.v < a.v ? b : a)).k
  : null;
```

- **`reduce((a, b) => (b.v < a.v ? b : a))`** — argmin via reduce. `a` is the running smallest; if the new `b` is smaller, swap. End of pass, `a` is the smallest.
- The starting accumulator is implicit — calling `reduce` without an initial value uses the first array element as the seed and starts iterating from the second.
- Returns the stage object; `.k` extracts the stage name (`'view'` | `'cart'` | `'checkout'` | `'purchase'`).

Cost: O(n), n = 4. One pass, no allocation beyond the closure. This is the **right primitive when you need ONE extreme** — sorting would waste work, building a heap would be theater.

```
  argmin via reduce — execution trace

  funnelStages = [
    { k: 'view',     v: 1000 },
    { k: 'cart',     v: 600 },
    { k: 'checkout', v: 200 },   ← leak
    { k: 'purchase', v: 180 },   ← actually the smallest
  ]

  reduce:
    a = {k: 'view', v: 1000}, b = {k: 'cart', v: 600}
      → b.v < a.v (600 < 1000) → a = {k: 'cart', v: 600}
    a = {k: 'cart', v: 600},  b = {k: 'checkout', v: 200}
      → 200 < 600 → a = {k: 'checkout', v: 200}
    a = {k: 'checkout', v: 200}, b = {k: 'purchase', v: 180}
      → 180 < 200 → a = {k: 'purchase', v: 180}

  leakKey = 'purchase'    ← O(n) pass picked the smallest
```

The interview hook: **argmin/argmax via reduce is the right move when you need ONE extreme, not a sorted list.** Sorting to get the smallest is O(n log n) when O(n) does the job. The same lesson applies to argmax — flip the comparator.

#### linear filters everywhere — and when they'd stop being fine

The codebase filters arrays in dozens of places: tool-schemas filtering by allowed-set, evidence-pulling for current/prior numbers, hypotheses-tested counts. Each is one pass over a small array. The pattern:

```ts
// lib/agents/tool-schemas.ts:13-16
const set = new Set(allowed);
return all
  .filter((t) => set.has(t.name))
  .map((t) => ({ name: t.name, ... }));
```

The interesting part is the **Set built once, used in the filter callback** — same pattern as the categories one (file 02). Without the Set, `filter` would call `allowed.includes(t.name)` for each tool, which is O(allowed.length) per call, making the total O(n × m). The Set turns it into O(n + m). At n=m=20 it doesn't matter; the discipline matters because it's the right shape.

When linear scan stops being fine:

```
  the seam — scan once vs scan in a loop

  one-shot scan:           array.filter / map / reduce — fine
  scan in a tight loop:    pre-build a Map/Set (file 02), or sort
                           the array once and binary-search per query
  data mutates + queries:  balanced BST (file 04) — beats both above
```

This codebase only ever does one-shot scans, so the linear pattern is right.

#### binary search — the one you don't have

No binary search anywhere in `blooming_insights`. **When would you reach for it?**

```
  binary search — the pattern (pseudocode)

  function binarySearch(sortedArr, target):
    lo = 0
    hi = sortedArr.length - 1
    while lo <= hi:
      mid = (lo + hi) >> 1           // bit-shift for integer division
      if sortedArr[mid] == target:
        return mid
      if sortedArr[mid] < target:
        lo = mid + 1
      else:
        hi = mid - 1
    return -1                        // not found

  termination: when lo > hi (range collapsed without a match)
  cost:        O(log n)              — halve the range each step
```

**The kernel** (Move 2 variant): three load-bearing parts.

```
  binary search kernel — what BREAKS when each part is missing

  1. lo, hi (the search range)    — without them: no notion of where
                                    to look next

  2. mid = (lo + hi) >> 1         — the halving move; the >> 1 is the
                                    integer-overflow-safe form of /2
                                    (in JS we don't have int overflow,
                                    but in C/Java the (lo+hi)/2 overflows
                                    on huge arrays — this is the canonical
                                    interview catch)

  3. termination test (lo > hi)   — without it: infinite loop on misses
                                    (lo and hi keep crossing each other)

  + the precondition: the array MUST be sorted by the same comparator
    you're searching with. unsorted → undefined behavior, not even O(n).
```

The interview hook: **the off-by-one in the termination condition.** `while (lo <= hi)` with `hi = mid - 1` and `lo = mid + 1` is one correct formulation; `while (lo < hi)` with `hi = mid` (or `lo = mid + 1`) is another. They're not interchangeable — get the pair wrong and you either infinite-loop or skip the last element. Most BS bugs are in this corner.

Where it would land here if the surface grew: a sorted insights timeline indexed by `timestamp`, binary-searched for "the insight just before this time." Today the insights are a Map keyed by id and a small array; no use case.

#### quickselect — the K-th smallest in O(n)

Not in this codebase, worth knowing for interviews. **Quickselect is quicksort but you only recurse into the side that contains the K-th element.** Average O(n) instead of O(n log n); worst case O(n²) (same as quicksort) but mitigated with random pivot.

```
  quickselect — the pattern, sketch

  function quickselect(arr, k):
    pivot = pick random element
    less, equal, greater = partition arr by pivot
    if k < less.length:                    return quickselect(less, k)
    if k < less.length + equal.length:     return pivot
    return quickselect(greater, k - less.length - equal.length)

  unlike sort, we DON'T recurse into both sides — only the side
  containing the k-th element. that's where the O(n) average comes from.
```

When to reach for it: when you need the median, the K-th smallest by some criterion, or the top-K but you don't care about the order within the top K. Real use cases: anomaly detection (find the top 1% by severity score), feature selection (top K features by importance), load balancing (the median latency).

### Move 3 — the principle

Sorting answers "in what order?" Searching answers "where is this one?" Selection answers "which one is at position k?" **Different questions get different algorithms** — the mistake is reaching for sort when argmin would do, or for sort when binary search over a stable sorted array would do, or for a hand-rolled K-th when a fixed-size heap is one library call away. The cost ceiling is the same vocabulary as file 01: pick the right ruler, then pick the algorithm that minimizes the right cost.

## Primary diagram

The recap — the one sort, the one argmin, and the gap.

```
  ordering and lookup in blooming_insights

  EXERCISED ─────────────────────────────────────────────────────────
  comparator sort + slice (top-K with K ≥ n)
   monitoring-legacy.ts:136
   [...parsed].sort((a,b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])
              .slice(0, 10)
   n ≤ 10, k = 10 — sort+slice is the right code at this scale.

  argmin via reduce (single extreme, one pass)
   InsightCard.tsx:160
   funnelStages.reduce((a, b) => (b.v < a.v ? b : a)).k
   n = 4, returning ONE extreme — sorting would be wasted work.

  linear filter / map / reduce (one-shot scans)
   tool-schemas, categories, evidence pulls, parseAgentJson search
   n always small, pattern always one-pass — linear is right.

  NOT YET EXERCISED ─────────────────────────────────────────────────
  binary search        — would land where a sorted timeline is queried
                         repeatedly; no such surface today
  quickselect          — would land for K-th smallest at scale
  merge sort           — would land for external sort / streaming sort
  fixed-size top-K heap — the upgrade path for sort+slice at large n

  the decision matrix ────────────────────────────────────────────────
  one extreme:              argmin reduce          (this code)
  full order, small n:      comparator sort        (this code)
  top K, large n:           fixed-size heap        (not here)
  lookup, sorted + stable:  binary search          (not here)
  k-th element:             quickselect            (not here)
  external / streaming:     merge sort variants    (not here)
```

## Elaborate

Sorting is the most-studied algorithm in computer science. The O(n log n) lower bound for comparison-based sorting is information-theoretic — n elements have n! permutations, and binary comparisons distinguish 2 per step, so log₂(n!) ≈ n log n comparisons are necessary. **You can beat it only by giving up generality**: counting sort (O(n) when keys are bounded integers), radix sort (O(nk) for k-digit keys), bucket sort (O(n) when keys are uniformly distributed).

The named comparison sorts:
- **mergesort** — divide, recurse, merge. Stable. Worst case O(n log n). Used in Python's Timsort, V8 for `Array.prototype.sort`. Allocates O(n) extra.
- **quicksort** — pick pivot, partition, recurse. Average O(n log n), worst O(n²). In-place. Cache-friendly. Unstable in the textbook version.
- **heapsort** — build a heap (O(n)), extract-min n times (O(log n) each). Worst case O(n log n). In-place. Unstable.

**JavaScript's `Array.prototype.sort`** is V8's `Timsort` (a hybrid of mergesort + insertion sort) since 2018; it's stable, adaptive (faster on partially-sorted input), and worst-case O(n log n).

**Binary search** appears in Mauchly's 1946 lectures and was published by Bottenbruch in 1962, but Bentley's 1986 *Programming Pearls* observed that an estimated 90% of programmers can't write it correctly on the first try — the off-by-one in the loop bounds is the canonical bug. **Always test with [empty, single-element, target-at-edges, target-missing] inputs.**

**Quickselect** is Hoare 1961 (same paper as quicksort). The introselect variant (Musser, 1997) guarantees worst-case O(n) by switching to median-of-medians on bad pivots; it's what most standard libraries ship as their `nth_element`.

Read next: file 03 (the heap-based top-K that would replace sort+slice at scale), file 04 (the BST that wins over binary search when the data mutates), file 08 (where binary search ranks in your practice plan — high; it's the most commonly-asked easy/medium problem in tech interviews).

## Interview defense

### Q: Walk me through the monitoring agent's anomaly ranking.

It's a comparator sort with a fixed integer lookup, then a slice for the top 10:

```ts
const SEV_RANK: Record<Severity, number> = { critical: 3, warning: 2, info: 1, positive: 0 };
return [...parsed].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]).slice(0, 10);
```

- `SEV_RANK` is the comparator lookup — `critical > warning > info > positive`.
- The comparator returns `b - a` for descending: when `b` has higher rank, the return is positive, which `sort` reads as "b comes first."
- `[...parsed]` is a defensive copy so the sort doesn't mutate the agent's output array.
- `slice(0, 10)` is top-K with K=10.

Cost is O(n log n) for the sort + O(k) for the slice. **n is at most 10 by the prompt's cap, so it's microseconds.** The real cost was the multi-second LLM call that produced `parsed`.

The stability point: V8's sort has been stable since ES2019, so two `critical` anomalies stay in the order Claude emitted them. That's load-bearing for the demo path — instability would mean nondeterministic ordering among ties, which breaks snapshot tests and reproducible screenshots.

The upgrade: if `n` ever grew to thousands of candidates (Claude producing exploratory anomalies, then picking the top 10), I'd switch to a **fixed-size min-heap of K=10**. Walk the array, push each, pop when size > K. End cost O(n log K) — at n=10⁶ that's ~3.3 million operations vs ~20 million for a full sort, and you never hold the full sorted array.

Anchor: `lib/agents/monitoring-legacy.ts:59, 136`.

### Q: When would binary search beat a hash map?

Two cases:

- **range queries.** Hash maps answer "is this exact key in the set?" Binary search on a sorted array answers "find the smallest key ≥ X" or "all keys between A and B" — the hash map can't do this cheaply (you'd scan all keys). A timeline of insights sorted by `timestamp` lets you binary-search for "the insight just before noon" in O(log n).
- **memory locality.** A sorted array is contiguous bytes; a hash map is buckets with pointer hops. For read-mostly data that fits in L2 cache, binary search over a sorted array can beat a hash map's O(1) by a constant factor because the cache lines are friendlier.

The cost of binary search is O(log n) per query but requires the precondition that the array is sorted. **If the data mutates between queries, you pay O(n) per insert** (shift to keep sorted), and at that point you reach for a balanced BST (file 04) which gives O(log n) for both.

```
  the decision matrix

  read mostly, fits in memory:       sorted array + binary search
  read + write mixed:                balanced BST
  exact-key lookups only, mutating:  hash map (O(1))
  point lookups + range queries:     balanced BST or sorted array
```

In `blooming_insights` neither shows up — every data set is either tiny (10 anomalies) or hash-keyed by string id. The binary-search practice is for the interview surface, not the codebase.

Anchor: none here (binary search is `not yet exercised`); pattern lives in your DSA portfolio's `BinarySearchTree.ts` as the tree-flavored cousin.

### Q: Why use `reduce` for argmin instead of `Math.min` or `sort`?

Three reasons in order:

1. **`Math.min` returns the value, not the index/key.** I need the funnel stage *name* (`'view'`, `'cart'`, `'checkout'`, `'purchase'`), not the raw number. `Math.min(...funnelStages.map(s => s.v))` would give me 180 — I'd then have to scan again to find which stage had that value. Two passes for what reduce does in one.

2. **`sort` is O(n log n); reduce-as-argmin is O(n).** Sorting the array to take the first element wastes work — I only need one extreme, not full order. At n=4 it doesn't matter, but the *instinct* matters.

3. **Reduce stays a one-pass functional expression.** It composes inside the JSX render code cleanly; sort would force mutation or an extra spread.

```
  three options, ranked

  funnelStages.reduce((a, b) => (b.v < a.v ? b : a)).k   ← this code
     O(n), one pass, returns the OBJECT

  funnelStages.sort((a, b) => a.v - b.v)[0].k
     O(n log n), mutates, returns the OBJECT

  funnelStages.find(s => s.v === Math.min(...funnelStages.map(x => x.v))).k
     O(n²) (the find scans, the inner map+min scans), returns the OBJECT

  the reduce wins on all three.
```

The general principle: **argmin/argmax via reduce is the right tool when you need one extreme element, not a sorted list.** Same lesson for argmax — flip the comparator.

Anchor: `components/feed/InsightCard.tsx:159-161`.

## See also

- 01-complexity-and-cost-models.md — for the n-log-n vs n decision matrix.
- 02-arrays-strings-and-hash-maps.md — for the "build a Set before filter" pattern that turns scan-in-loop into one O(n) prep.
- 03-stacks-queues-deques-and-heaps.md — for the fixed-size heap that replaces sort+slice at scale.
- 04-trees-tries-and-balanced-indexes.md — for the BST that beats binary search when the data mutates.
- 08-dsa-foundations-practice-map.md — for where binary search and quickselect rank in the practice plan.

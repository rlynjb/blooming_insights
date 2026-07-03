# Sorting, searching, and selection

Industry names: comparison sort, stable sort, binary search, quickselect, percentile-by-sort, top-K selection. Type: Industry standard.

## Zoom out — sorts everywhere, no binary search

Every `.sort()` in this codebase is a comparison sort with a custom comparator, feeding one of three downstream shapes: percentile lookup (sort then index), top-K selection (sort then `.slice(k)`), and pick-latest (sort then `.pop()`). None of them use binary search — the containers are all Sets and Maps, and `Set.has` is O(1) already.

```
  Where sorts live in this codebase

  ┌─ Service layer ─────────────────────────────────┐
  │  monitoring: sort by severity, slice(10)        │  ← top-K
  │  schema:     sort events by count desc          │  ← ordering
  └────────────────────┬────────────────────────────┘
                       │
  ┌─ Eval layer ───────▼────────────────────────────┐
  │  percentiles(): sort ascending, index at p·n    │  ← percentile-by-sort
  │  pickRunId:     sort ascending, .pop() = latest │  ← pick-latest
  └─────────────────────────────────────────────────┘

  not yet exercised: binary search (all lookups are Set.has)
  not yet exercised: quickselect (top-K uses full sort)
```

## Structure pass — trace *comparator + downstream shape*

Axis: **what happens *after* the sort?**

- Sort → **index at position p·n** = percentile query.
- Sort → **`.slice(0, k)`** = top-K.
- Sort → **`.pop()`** = pick-latest / pick-max.

The comparator sets the ordering; the downstream operation extracts the answer. Sorts in this repo never stand alone — they're always paired with an extraction. That pairing is where the *real* algorithm lives; the sort is just the ordering scaffold.

The seam worth tracing: **the sort orders a whole array, but the caller only uses O(1) or O(k) of the result.** That's the tell that a full sort might be overkill — quickselect for percentiles, a heap for top-K. Neither is built here; the current scale (`n ≤ 50`) doesn't justify it.

## How it works — three sort → extract shapes, one missing search

### Move 1 — the comparison-sort kernel

You already know this from every language you've written. JavaScript's `Array.prototype.sort` takes a comparator `(a, b) => number`: negative means `a < b`, zero means equal, positive means `a > b`. V8 uses TimSort (a hybrid merge sort + insertion sort) — O(n log n) worst case, O(n) on nearly-sorted input, stable.

```
  Comparison-sort kernel

  input :  [3, 1, 4, 1, 5, 9, 2, 6]
              │  compare pairs, swap
              ▼
  output:  [1, 1, 2, 3, 4, 5, 6, 9]

  what makes it a comparison sort: only uses (a, b) comparisons
                                     — no info about the values otherwise
  lower bound: O(n log n) — proven, ~ log₂(n!) comparisons needed
  stable    : equal keys keep their relative order (TimSort: yes)
```

Stability matters when you sort by a *secondary* key and want the primary ordering preserved. Nothing in this repo depends on it, but it's the first question an interviewer asks about a language's default sort.

### Move 2 — the four sort sites in this repo

**Sort by severity, top-K by slice** — `lib/agents/monitoring-legacy.ts:136`.

```ts
// lib/agents/monitoring-legacy.ts:136
return [...parsed].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]).slice(0, 10);
```

Load-bearing parts:
1. **`[...parsed]` spread.** `Array.prototype.sort` mutates in place; the spread copies so the caller's array isn't reordered.
2. **`(a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]`** — the descending comparator. Reversing the order (b before a) is idiomatic; a positive number puts b first.
3. **`.slice(0, 10)`** — the top-K extraction. This is where a heap-of-size-K would win at scale (see `03-stacks-queues-deques-and-heaps.md`).

Cost: O(n log n) sort + O(k) slice = O(n log n). At n=50, ~280 comparisons. Fine.

**Sort by event count, ordering** — `lib/mcp/schema.ts:107`.

```ts
// lib/mcp/schema.ts:99-107
const events = (eventPayload?.events ?? [])
  .map((e) => ({
    name: e.type,
    properties: (e.properties?.default_group?.properties ?? []).map((p) => p.property),
    eventCount: eventTypesOverview[e.type]?.event_count ?? 0,
  }))
  .sort((a, b) => b.eventCount - a.eventCount);
```

Ordering-only — no top-K, no percentile. The whole array is used, but sorted so the highest-count events come first (for prompt attention weighting downstream). Cost: O(n log n). Anchor for "when a sort is the *whole* algorithm" vs when it's the setup for something else.

**Sort ascending, index at p·n — percentile by sort** — `eval/report.eval.ts:161-179` and `eval/load.eval.ts:326-333`.

Two byte-identical implementations. First:

```ts
// eval/report.eval.ts:161-179
function percentiles(arr: readonly number[]): { p50: number; p95: number; p99: number; max: number; mean: number } {
  if (arr.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const mean = Math.round(sorted.reduce((s, n) => s + n, 0) / sorted.length);
  return { p50: pct(50), p95: pct(95), p99: pct(99), max: sorted[sorted.length - 1], mean };
}
```

Second, at `eval/load.eval.ts:326`, is identical. **That's a duplication smell** — one of the ranked findings in `00-overview.md`. The teaching point stays: sort-then-index is the simplest correct percentile algorithm. Cost: O(n log n) sort + O(1) index. Batch only; no way to update incrementally.

**Load-bearing parts:**

1. **`[...arr].sort()` copy.** Same as before — don't mutate the caller's array.
2. **`Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))`** — the clamp. At p=100 the naive index `Math.floor(1.0 * n)` is `n`, which is *out of bounds*. The clamp turns it into `n - 1`. Every off-by-one percentile bug you've ever seen is one of these.
3. **`sorted[sorted.length - 1]` for max.** Trivial once sorted; the whole point of computing sorted once.

Contrast with what you *would* do at scale:

```
  Percentile at scale

  sort + index      :  O(n log n) — current, fine at n ≤ 1e4
  quickselect       :  O(n) average — one pass, no full sort
  order-statistic tree:  O(log n) insert, O(log n) query — streaming
  t-digest / HDR    :  O(1) memory — approximate, unbounded stream
```

**Sort ascending, `.pop()` — pick-latest** — `eval/report.eval.ts:210`.

```ts
// eval/report.eval.ts:203-210
const files = readdirSync(RECEIPTS_DIR).filter((f) => f.endsWith('.json'));
const runIds = new Set<string>();
for (const f of files) {
  const m = f.match(/-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+Z)\.json$/);
  if (m) runIds.add(m[1]);
}
if (runIds.size === 0) throw new Error('No receipts found');
return [...runIds].sort().pop() as string;
```

Sort ISO-8601 timestamps as strings (they sort correctly lexicographically), take the last one. That's the "latest run" heuristic. Cost: O(n log n). A single-pass `max()` would be O(n) — same shape as `Math.max(...runIds)`. The sort is wasted work for `n=50`, invisible at scale. The reason you'd *notice* is if you ever wanted the top-2 latest — then a single-pass `max` doesn't extend cleanly and the sort was actually setting you up for it.

### Move 2 (continued) — the missing binary search

**`not yet exercised`: binary search.**

Every lookup in this codebase is `Set.has` (O(1)) or `Map.get` (O(1)). There's no sorted array kept around for range queries or "find the smallest ≥ X" — which are the two shapes binary search wins.

The kernel, for reference:

```
  Binary search — search a sorted array for target

  lo = 0
  hi = arr.length - 1
  while lo <= hi:
    mid = lo + floor((hi - lo) / 2)          // avoids overflow (mid = (lo+hi)/2 can overflow)
    if arr[mid] == target: return mid
    if arr[mid] <  target: lo = mid + 1
    else:                    hi = mid - 1
  return -1                                     // not found

  cost: O(log n) — halves the search space each step
```

The classic off-by-one bugs: forgetting `<= ` instead of `<`, updating `lo = mid` instead of `mid + 1` (infinite loop), computing `mid` as `(lo + hi) / 2` (overflow in fixed-width integers).

**Quickselect** is the other missing primitive. It's the algorithm you'd reach for if you wanted top-K (or the k-th percentile) without a full sort:

```
  Quickselect — like quicksort, but only recurse into the side that contains position k

  quickselect(arr, k):
    if len(arr) == 1: return arr[0]
    pivot = pick_pivot(arr)                    // random or median-of-3
    lows, highs, equals = partition(arr, pivot)
    if k < len(lows):        return quickselect(lows, k)
    if k < len(lows)+len(equals): return pivot
    return quickselect(highs, k - len(lows) - len(equals))

  cost: O(n) average, O(n²) worst-case (bad pivots)
```

If you ever needed to compute p95 over a million-element stream and t-digest wasn't available, quickselect is the answer — one pass, no full sort, exact.

### Move 3 — the principle

**Sorts in this repo are never the algorithm.** They're the scaffold under an extraction — top-K, percentile, pick-latest. Once you name the *extraction*, you can ask: is a full sort the cheapest way to answer this? At this scale, yes. At larger scales, a heap (top-K) or a quickselect (percentile) or a running max (pick-latest) is asymptotically better. The muscle memory: *see a `.sort().slice()`, ask if a heap fits; see a `.sort()[…index…]`, ask if quickselect fits.*

## Primary diagram — the four extraction shapes

```
  Sort → extract: four shapes, three scales of concern

  ┌─────────────────────────────────────────────────┐
  │  sort → SLICE(0, k)              → top-K         │  monitoring-legacy.ts:136
  │  cost:  O(n log n)                                │  fit: heap at n >> k
  │  when better: bounded-size heap, O(n log k)      │
  └─────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────┐
  │  sort → (whole array in order)   → ordering      │  mcp/schema.ts:107
  │  cost:  O(n log n) — required, whole result used │  fit: sort *is* the answer
  └─────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────┐
  │  sort → INDEX(p·n)               → percentile    │  report.eval.ts:161
  │  cost:  O(n log n)                                │  fit: quickselect O(n)
  │  when better: quickselect for one-off, tree      │       order-stat tree for
  │               for streaming, t-digest for scale  │       streaming
  └─────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────┐
  │  sort → POP()                    → pick-latest   │  report.eval.ts:210
  │  cost:  O(n log n)                                │  fit: single-pass max O(n)
  │  when better: max() when k=1                     │
  └─────────────────────────────────────────────────┘
```

## Elaborate

Comparison sort's O(n log n) lower bound is Shannon-theoretic — you need at least log₂(n!) comparisons to distinguish n! possible orderings, and Stirling's approximation makes that ~n log n. That bound doesn't apply to non-comparison sorts: **radix sort** and **counting sort** run in O(n) or O(n·k) where k is the key width, which is why they beat quicksort on integers with bounded range.

TimSort — V8's default — is worth reading about. It exploits *natural runs* (already-sorted subsequences) and does O(n) on nearly-sorted input. If you profile a hot sort and see O(n log n), first check whether the input is nearly sorted; TimSort's constant factors on nearly-sorted data are surprisingly good.

Binary search is deeper than "find in sorted array." The classic **"first index where a predicate flips from false to true"** framing generalizes to problems that aren't obviously about sorting: split arrays, find the smallest capacity that fits, find the first bad version. Whenever you can frame the answer as a monotonic predicate over an ordered domain, binary search fits. That reframe is what interviewers want to see.

Quickselect is the algorithm behind numpy's `np.partition` and C++'s `std::nth_element`. It has the property that after quickselect(arr, k), everything left of position k is ≤ arr[k] and everything right is ≥ — free bonus for range queries downstream.

## Interview defense

**Q: The `percentiles()` function — walk it, name the load-bearing parts.**

Answer: Copy the input (`[...arr]` — don't mutate the caller's array), sort ascending in place on the copy, then index at `Math.floor((p/100) * n)` with a `Math.min(n-1, ...)` clamp to keep p=100 in bounds. Cost is O(n log n) sort + O(1) index per percentile. Load-bearing parts: the copy (avoid mutation), the clamp (off-by-one at p=100), and the fact that this is batch-only — no way to update incrementally as new data arrives.

```
  percentiles(arr) — the shape

  arr → [...arr] copy → sort asc → sorted array
                                       │
                        ┌──────────────┼──────────────┐
                        ▼              ▼              ▼
                    sorted[floor(0.50·n)]
                    sorted[floor(0.95·n)]  clamp to n-1
                    sorted[floor(0.99·n)]
                    sorted[n-1]                       ← max
```

At scale you'd swap to quickselect (O(n) per query), or an order-statistic tree (streaming), or a t-digest (approximate, constant memory).

Anchor: `eval/report.eval.ts:161-179` and `eval/load.eval.ts:326-333`.

**Q: The monitoring code does `sort + slice(10)`. What's the fix at scale?**

Answer: A bounded-size min-heap. Keep a heap of size K=10; for each item, if it beats the heap's min, pop the min and push the new item. Total cost O(n log K) vs the sort's O(n log n). At K=10 fixed, log K is ~3 — you're paying 3× per item vs whatever fraction of log n. At n=50 the sort wins by constant factors; at n=50k the heap wins by an order of magnitude.

```
  Top-K comparison — n = anomalies, K = 10 fixed

  sort + slice   :  O(n log n)
  heap of size K :  O(n log K)  ← wins when n >> K
```

Anchor: `lib/agents/monitoring-legacy.ts:136`.

**Q: There's no binary search in this repo. When would you reach for it?**

Answer: Any time you have a sorted collection and want a lookup faster than linear, or you can frame the answer as "the first index where a predicate flips from false to true." In this codebase every membership check is `Set.has` (O(1)) so binary search would be a downgrade. The place it *would* land is if you kept a sorted array of timestamps and asked "find the first entry after time T" — that's a `lowerBound` binary search, O(log n).

```
  Binary search fits when:

  · data is sorted (or can be sorted once, queried many times)
  · answer is monotonic predicate (F, F, F, T, T, T, T)
  · you want O(log n) not O(n)
```

## See also

- `01-complexity-and-cost-models.md` — the O(n log n) vs O(n) discussion this chapter cites.
- `03-stacks-queues-deques-and-heaps.md` — the heap that would replace the top-K sort.
- `04-trees-tries-and-balanced-indexes.md` — order-statistic trees for streaming percentiles.
- `08-dsa-foundations-practice-map.md` — quickselect and binary search on the drill list.

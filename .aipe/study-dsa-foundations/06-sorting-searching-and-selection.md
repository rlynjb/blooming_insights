# Sorting, searching, and selection

*Comparator-based sort, binary search, partitioning, top-K — Industry standard · sort ★★★ exercised, binary search Case B*

## Zoom out — sorting and searching in this repo

```
  Where sort and search live in this codebase
  ───────────────────────────────────────────

  ┌─ UI layer ────────────────────────────────────┐
  │  funnel.reduce(argmin)  — single-pass min      │
  │    components/feed/InsightCard.tsx:160         │
  └────────────────────────┬──────────────────────┘
                           │
  ┌─ Service layer ────────▼──────────────────────┐
  │  ★ SORT BY COMPARATOR + SLICE TOP-K            │
  │    [...parsed].sort(SEV_RANK cmp).slice(0, 10) │
  │    lib/agents/monitoring-legacy.ts:136         │
  │                                                │
  │  ★ SORT BY ASCENDING (Set → sorted array)      │
  │    [...server].sort()                          │
  │    lib/mcp/tool-coverage.ts:58, 61             │
  │                                                │
  │  ★ SORT BY NUMERIC FIELD DESC                  │
  │    events.sort((a,b) => b.eventCount - a.eventCount)│
  │    lib/mcp/schema.ts:107                       │
  │                                                │
  │  NO BINARY SEARCH (every lookup is hash-keyed) │
  └────────────────────────┬──────────────────────┘
                           │
  ┌─ Provider boundary ────▼──────────────────────┐
  │  Bloomreach sorts on the server (EQL ORDER BY) │
  │  → search algorithms live there, opaque to us  │
  └───────────────────────────────────────────────┘
```

Verdict-first: this repo uses **`Array.prototype.sort`
with a comparator three times** and **never reaches
for binary search**. The reason for the asymmetry:
every lookup in this codebase is *keyed* (Map.get) or
*short-scan* (filter over a ≤ 30 element array), so
the O(log N) win of binary search never pays for the
"keep the array sorted" cost. If a workload changed
— say, you started looking up event names in a
10,000-item alphabetical list — binary search would
suddenly be the right move. It isn't, today.

## Structure pass — sort and search seams

Two operations, one question held constant: *"what
property of the input does the algorithm exploit?"*

```
  One question, two algorithms, two property answers
  ──────────────────────────────────────────────────

  "what input property does this algorithm exploit?"

  ┌─ Sorting ──────────────────────┐
  │ exploits: a TOTAL ORDER on     │
  │   elements (comparator)        │
  │ produces: arr in that order    │
  │ cost: O(N log N) comparator    │
  │       O(N) for special cases   │
  │       (counting/radix sort)    │
  └────────────────────────────────┘

  ┌─ Binary search ────────────────┐
  │ exploits: array IS ALREADY     │
  │   sorted                       │
  │ produces: index (or -1)        │
  │ cost: O(log N)                 │
  │ break case: array not sorted   │
  │   → returns garbage silently   │
  └────────────────────────────────┘
```

The seam these share: **a total order on elements**.
Sort builds the order; binary search exploits it. The
two compose: if you binary-search the same array many
times, the O(N log N) sort cost amortises over the
many O(log N) lookups, beating Map.get's O(1) only
when... never, in JavaScript. (Maps are always
cheaper for single-key lookup. Binary search shines
for *range queries* — "all elements between X and Y" —
which Maps can't answer in sub-O(N).)

Hand off to How it works.

## How it works

#### Move 1 — the mental model

You know `Array.prototype.sort` already, but probably
not what it does under the hood. The mental model:
**sort with a comparator is a "give me a total order
function, I'll return the array in that order"
contract.** The comparator returns negative (a
before b), zero (tie), or positive (b before a).
V8's implementation is TimSort — a hybrid of merge
sort and insertion sort, stable, O(N log N).

```
  Comparator — three return values, three meanings
  ────────────────────────────────────────────────

  cmp(a, b) returns:
    < 0    → a should come before b
    = 0    → order doesn't matter (stable sort
                  preserves original order)
    > 0    → b should come before a

  examples:
    ascending numbers:  (a, b) => a - b
    descending numbers: (a, b) => b - a
    by string field:    (a, b) => a.name.localeCompare(b.name)
    by severity rank:   (a, b) => SEV_RANK[b.sev] - SEV_RANK[a.sev]
                                      ↑
                              note: b first → descending
```

The interview tell: people who write `(a, b) => true`
or `(a, b) => a > b` are returning booleans, which
coerce wrong. The comparator MUST be numeric.

Binary search's mental model: **eliminate half the
remaining space per step**. You start with [0, N),
check the middle, narrow to [lo, mid) or [mid+1, hi).
After log N steps, the range is empty (not found) or
one element (found).

```
  Binary search — halving the search space
  ────────────────────────────────────────

  sorted array (10 elements):
    [1, 3, 5, 7, 9, 11, 13, 15, 17, 19]
     ▲                                ▲
     lo = 0                          hi = 10
                  ↓
              mid = 5                  ← arr[5] = 11
                  ↓
  search for 7:  7 < 11 → discard right half
    [1, 3, 5, 7, 9]                    hi = 5
     ▲           ▲
     lo = 0     hi = 5
              ↓
              mid = 2                  ← arr[2] = 5
                  ↓
                7 > 5 → discard left half
            [7, 9]                     lo = 3
             ▲   ▲
             lo = 3  hi = 5
                  ↓
              mid = 4                  ← arr[4] = 9
                  ↓
                7 < 9 → discard right half
              [7]                      hi = 4
               ▲ ▲
               lo = 3
                  ↓
              mid = 3                  ← arr[3] = 7  ✓
```

Three comparisons for a 10-element array. For
1,000,000 elements: 20 comparisons. That's the win,
and it's why binary search is the canonical "log N
algorithm" everyone has to know.

#### Move 2 — the operations, anchored to your code

**Comparator-based sort — three live examples**

```ts
// lib/mcp/schema.ts:99-107
const events = (eventPayload?.events ?? [])
  .map((e) => ({
    name: e.type,
    properties: (e.properties?.default_group?.properties ?? []).map((p) => p.property),
    eventCount: eventTypesOverview[e.type]?.event_count ?? 0,
  }))
  .sort((a, b) => b.eventCount - a.eventCount);
//                ▲      ▲
//                │      └── b first → descending
//                └── numeric subtraction is the comparator idiom
//                    (also works for floats; for strings use localeCompare)
```

**Why descending by eventCount:** the schema summary
takes `slice(0, 20)` — top 20 events by activity.
Sorting first and slicing is the simplest "top-K"
move. The cost is O(N log N) over typically 50-200
events; the slice is O(K). For the actual N here, the
sort is invisible.

```ts
// lib/agents/monitoring-legacy.ts:136
return [...parsed]
  .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])
  .slice(0, 10);
//                ▲      ▲
//                b      a     ← descending by rank
//                              (critical > warning > info > positive)
```

The `SEV_RANK` is a `Map<Severity, number>` (or a
plain object indexed by string). The comparator reads
both ranks and subtracts. **The pattern to internalise:**
when sorting by a categorical field, build a rank
table once, then compare *ranks* in the comparator.
Comparing strings directly with `localeCompare` would
give alphabetical order ("critical, info, positive,
warning"), not severity order.

```ts
// lib/mcp/tool-coverage.ts:58, 61
return {
  serverTools: [...server].sort(),                        // ← default lexicographic
  // ...
  unusedOnServer: serverToolNames.filter((n) => !configured.has(n)).sort(),
};
```

**The default `Array.prototype.sort()` (no comparator)
sorts by Unicode code-point, treating elements as
strings.** That's fine here because tool names are
strings. **The break case:** `[10, 2, 1].sort()`
returns `[1, 10, 2]`, not `[1, 2, 10]`, because "10"
< "2" lexicographically. Numbers always need an
explicit comparator. This is the most common JS
interview gotcha around sort.

**Argmin via reduce — single-pass selection**

```ts
// components/feed/InsightCard.tsx:155-161
const funnelStages = funnel
  ? (['view', 'cart', 'checkout', 'purchase'] as const).map((k) => ({ k, v: funnel[k] }))
  : [];
const leakKey = funnelStages.length
  ? funnelStages.reduce((a, b) => (b.v < a.v ? b : a)).k
  : null;
```

```
  Argmin via reduce — one pass over 4 elements
  ────────────────────────────────────────────

  funnelStages = [
    {k: 'view',     v: 1000},   ← step 1
    {k: 'cart',     v:  300},   ← step 2
    {k: 'checkout', v:  150},   ← step 3
    {k: 'purchase', v:  100},   ← step 4
  ]

  reduce trace:
    init:   a = {k: 'view', v: 1000}
    step 1: b = {k: 'cart', v: 300}      → 300 < 1000 → a = b
            a = {k: 'cart', v: 300}
    step 2: b = {k: 'checkout', v: 150}  → 150 < 300  → a = b
            a = {k: 'checkout', v: 150}
    step 3: b = {k: 'purchase', v: 100}  → 100 < 150  → a = b
            a = {k: 'purchase', v: 100}

  result: leakKey = 'purchase'
                    ↑ the funnel stage with the smallest count
                    → "where the funnel leaks the most"
```

This is the *correct* O(N) algorithm for "find the
minimum element." Sorting and taking `[0]` is O(N
log N) — wasteful. The `reduce` does it in one pass.
**The skeleton:** keep a running best, compare each
new element, update if better. Generalises to argmax,
min-with-tiebreak, top-K (using a small heap).

**The selection problem — what this *would* use a
heap for**

If the question changed from "single argmin" to
"three lowest funnel stages," the comparable approach
is `sort(asc).slice(0, 3)` for small N, or a max-heap
of size 3 for streaming/large N. (The full top-K
heap walk lives in `03-stacks-queues-deques-and-
heaps.md`.)

**Binary search — not used, but here's when you'd
reach for it**

```
  PSEUDOCODE — binary search on a sorted array
  ────────────────────────────────────────────

  function binarySearch(arr, target):
    lo = 0
    hi = arr.length
    while lo < hi:                      // ← half-open interval [lo, hi)
      mid = lo + (hi - lo) >> 1         // ← avoid (lo+hi) overflow in
                                        //   languages where int wraps
      if arr[mid] == target:
        return mid
      elif arr[mid] < target:
        lo = mid + 1
      else:
        hi = mid
    return -1                           // ← not found

  load-bearing parts (what breaks if you remove each):
    - the interval invariant (half-open vs closed) ← gets off-by-one wrong
    - lo + (hi - lo) >> 1                          ← Java/C++ overflow bug
    - the equality check                          ← infinite loop if missing
    - the < vs > direction                        ← wrong half discarded
```

This repo doesn't reach for binary search because
every lookup target is hash-keyed (Map) or short-
scanned. Where binary search comes back: range
queries on sorted arrays ("all elements between X
and Y"), binary search on the *answer* (parametric
search, e.g. "smallest K such that ..."), and the
canonical "first/last occurrence" variants that show
up in interviews constantly.

#### Move 3 — the principle

Sort is the operation that *creates* a total order;
binary search is the operation that *exploits* one.
Reach for sort when you need ranked output or a top-K
slice. Reach for binary search when the same sorted
array is queried many times *and* hash-keyed lookup
doesn't fit (e.g. range queries). For single-key
lookups in JavaScript, a Map always wins — binary
search shines for ranges, not points.

## Primary diagram

```
  The sort/search decision tree for this repo
  ───────────────────────────────────────────

  ┌─ what are you trying to do? ──────────────────────────┐
  │                                                        │
  │  rank N items by score?                                │
  │    N small (≤ 100):    arr.sort(cmp).slice(0, K)       │
  │    N large/streaming:  min-heap of size K              │
  │                                                        │
  │  find the min / max / argmin?                          │
  │    arr.reduce((best, x) => cmp(x, best) ? x : best)    │
  │    → O(N), one pass, no sort needed                    │
  │                                                        │
  │  lookup one item by key?                               │
  │    Map.get(key)  → O(1)                                │
  │    arr.find / .filter → O(N), only fine for tiny N     │
  │                                                        │
  │  lookup range of items?                                │
  │    sort array, then binary search bounds → O(log N)    │
  │    (or use a sorted structure: TreeMap, B-tree)        │
  │                                                        │
  │  check membership?                                     │
  │    Set.has(key) → O(1)                                 │
  │    arr.includes → O(N), break-even at N ≈ 5-10         │
  └────────────────────────────────────────────────────────┘
```

## Elaborate

JavaScript's `Array.prototype.sort` is required by
the spec to be stable as of ES2019 (V8's TimSort
already was). Stability means "elements that compare
equal preserve their original order." That matters
when you sort by one key first, then by another to
break ties — the first sort's order survives where
the second sort says "equal."

The comparison-based lower bound for sort is O(N log
N): any algorithm that sorts by comparing pairs of
elements cannot beat it. The way to beat it: don't
compare. Counting sort (O(N + K) for K distinct
values), radix sort (O(N × W) for W-character keys)
both beat O(N log N) by exploiting structure in the
keys. Not exercised here; worth knowing for the
"sort 1 billion integers in O(N)" interview question.

Binary search has *families*: lower-bound (first
index ≥ target), upper-bound (first index > target),
exact match. Each has subtle invariant differences;
the C++ STL exposes `lower_bound` / `upper_bound`
exactly for this reason. The "binary search on the
answer" pattern (parametric search) shows up in
"capacity to ship within D days" and "minimum number
of x's such that condition Y holds" problems.

The selection problem (find the K-th smallest in O(N)
average) is solved by Quickselect — partition like
QuickSort but recurse into only the side containing
K. Average O(N), worst O(N²); the median-of-medians
trick makes it O(N) worst-case at the cost of bigger
constants. Not reached for in this repo, on the
practice list.

For deep grounding: CLRS Chapter 8 (sorting in linear
time), Chapter 9 (medians and order statistics).
Sedgewick *Algorithms 4th Ed* §2.1-2.5.

## Interview defense

**Q: Walk me through `[10, 2, 1].sort()`. What does
it return?**

```
  Default sort gotcha
  ───────────────────

  [10, 2, 1].sort()                returns [1, 10, 2]
                                            ↑
  why: default sort treats elements as STRINGS
       "1" < "10" < "2" by Unicode code point

  [10, 2, 1].sort((a, b) => a - b) returns [1, 2, 10]
                          ▲
                          numeric comparator: ALWAYS use
                          one for numbers
```

Model answer: "Returns `[1, 10, 2]`, not `[1, 2, 10]`
— default sort treats elements as strings and
compares Unicode code points. '10' < '2' < '1' is
false; '1' < '10' < '2' lexicographically because '1'
comes before '2'. The fix is always pass a numeric
comparator: `.sort((a, b) => a - b)`. This is the JS
sort gotcha — biting it is a one-second tell that
someone hasn't actually used sort in production."

**Q: How would you find the top-10 anomalies by
severity?**

Model answer: "Build a severity rank table — `SEV_RANK
= {critical:4, warning:3, info:2, positive:1}` — then
`[...arr].sort((a, b) => SEV_RANK[b.severity] -
SEV_RANK[a.severity]).slice(0, 10)`. Note `b` first
for descending. For N ≤ 30 this is one line and O(N
log N); for streaming or N >> 10, switch to a min-
heap of size K at O(N log K). Anchor:
`lib/agents/monitoring-legacy.ts:136`."

**Q: What does binary search need that this codebase
doesn't have?**

Model answer: "A sorted array of meaningful size
that's queried many times. Every lookup here is
hash-keyed (Map.get) or short-scanned (≤ 30 element
arrays), so binary search's O(log N) win never pays
the 'keep sorted' cost. Binary search comes back when
the question is *range*: 'all elements between X and
Y', or 'first occurrence of K', or parametric search
('smallest D such that ...'). Maps can't answer
range questions in sub-O(N); binary search on a
sorted array can. Different shapes, different
algorithms."

**Q: How does `arr.reduce` find the minimum, and why
not just `arr.sort()[0]`?**

Model answer: "Reduce is O(N) — one pass, comparing
each element against the running best. Sort is O(N
log N) — does a lot of work you throw away. For
single-min, reduce is strictly better; for sorted
output, sort wins. The funnel-leak code uses reduce
because it only needs the single minimum stage:
`funnelStages.reduce((a, b) => b.v < a.v ? b : a).k`.
That's the textbook 'argmin in one pass.' Anchor:
`components/feed/InsightCard.tsx:160`."

## See also

- `01-complexity-and-cost-models.md` — when O(N log
  N) is invisible and when it isn't
- `02-arrays-strings-and-hash-maps.md` — Map for
  point lookup vs binary search for range
- `03-stacks-queues-deques-and-heaps.md` — heap for
  top-K when N is large or streaming
- `08-dsa-foundations-practice-map.md` — Quickselect,
  parametric binary search on the practice plan

# Sorting, searching, and selection

**Industry name(s):** comparator-based sort (Timsort, merge sort, quicksort), linear search, binary search, selection (quickselect, partitioning), top-K, bucket / radix sort
**Type:** Industry standard · Language-agnostic

> The three operations on ordered data: **sort** (put everything in order), **search** (find one specific thing), **select** (find the K-th smallest or the top K). This codebase exercises comparator sort with a rank-table, linear search via `Array.prototype.find`/`reduce`, and substring scan as a non-classical search. **Binary search is not yet exercised** because no data here is pre-sorted in a way that demands O(log N) lookup.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Sort and linear search are everywhere in this codebase. `[...parsed].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]).slice(0, 10)` in `lib/agents/monitoring.ts` L119 is the canonical sort-and-truncate pattern — rank table converts string enum to integers, V8 Timsort handles the comparator in O(N log N), `.slice(0, 10)` does a fixed top-K. The substring scan in `lib/mcp/validate.ts` L7–L9 (`candidate.search(/[[{]/)` + `candidate.lastIndexOf(']')`) is a *search* — find the bracket positions in the prose text. Linear searches show up in derivation (`lib/insights/derive.ts` L12–L20 `findCurrentPrior`) and reconciliation (`lib/hooks/useInvestigation.ts` L86–L95 `replaceRunningTool`'s reverse scan). **Binary search is not yet exercised** — no sorted-array-with-O(log N)-lookup pattern shows up, because nothing here is large enough or pre-sorted enough to need it.

```
Zoom out — sorting/searching/selection in this codebase

┌─ Agent layer ──────────────────────────────────────────────┐
│  ★ comparator sort + top-N (monitoring.ts L119) ★         │
│    [...parsed].sort((a,b) => SEV_RANK[b.s] - SEV_RANK[a.s])│
│    .slice(0, 10)                                           │
│                                                             │
│  ★ linear search / find-first (derive.ts L12–L20) ★        │
│    findCurrentPrior — for-loop with typeof narrow          │
│                                                             │
│  ★ argmin reduce (InsightCard.tsx L159–L161) ★             │
│    funnelStages.reduce((a, b) => b.v < a.v ? b : a)        │
└─────────────────────────────────────────────────────────────┘
                             │
┌─ Validation layer ─────────▼─────────────────────────────┐
│  ★ substring scan (validate.ts L7–L9) ★                   │
│    candidate.search(/[[{]/);                              │
│    candidate.lastIndexOf(']')                              │
│  → find the outermost bracket positions                   │
└─────────────────────────────────────────────────────────────┘
                             │
┌─ Reconciliation ───────────▼─────────────────────────────┐
│  ★ reverse linear scan (useInvestigation.ts L86–L95) ★    │
│    for (i = arr.length-1; i >= 0; i--)                   │
│  → find latest running tool by name (LIFO match)          │
└─────────────────────────────────────────────────────────────┘
                             │
┌─ Not yet exercised ────────▼─────────────────────────────┐
│  • binary search (no pre-sorted data needing O(log N))    │
│  • quickselect (no K-th-smallest problem at scale)        │
│  • radix / bucket sort (no integer-keyed data at scale)   │
└──────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when do you reach for which of the three operations, and how do they compose? **Sort** is what you do when downstream code wants ordered output — you pay O(N log N) once. **Search** is what you do when you want one specific item — O(N) linear if unsorted, O(log N) binary if sorted. **Select** is what you do when you want "the K best" — you can sort and take top K (O(N log N)), or you can use quickselect + partition for O(N) average. The codebase uses (a) sort + slice for top-K because N is small enough that the O(N log N) is invisible, and (b) linear search everywhere else because the arrays are small (10 categories, single-digit evidence entries, double-digit items in the reasoning trace). The next sections walk each operation, anchor to the load-bearing repo example, and name the binary-search gap.

---

## Structure pass

**Layers.** Each of the three operations has the same three-layer stack: the **abstract goal** (ordering, lookup, selection), the **algorithm** (Timsort, linear scan, quickselect), and the **cost shape** (O(N log N) sort, O(N) or O(log N) search, O(N) average for select). The abstract goal is what you pick by; the algorithm is the engineering layer; the cost is the proof you picked right.

**Axis: cost.** Same as Chapter 1 — cost is the lens. The interesting sub-question here is *cost as a function of N's distribution*: a sort is O(N log N) regardless of N's contents; a linear search is O(N) worst-case but O(N/2) average (and O(1) best-case when the target is first); a binary search is O(log N) but requires O(N log N) pre-sorting; selection (quickselect) is O(N) average but O(N²) worst-case unless you randomize the pivot. The codebase lives in the world where N is small, distributions are uniform, and these distinctions don't matter — but the moment N grows, picking the right algorithm for the actual distribution is worth real money.

**Seams.** Two seams matter; one is load-bearing in this codebase. **Seam 1 (load-bearing, present): "sort once, then access many times" vs "search once, no order needed."** This is the seam where you decide whether to pay O(N log N) up-front. For N=30 anomalies sorted once per briefing, paying is cheap. For N=10K queried once, linear search wins. **Seam 2 (load-bearing, absent): "is the data pre-sorted?"** This is the seam that *would* enable binary search. The codebase has no pre-sorted data structures (the cache `Map` is hash-ordered, the registry arrays are insertion-ordered, the anomaly array is one-shot sorted right before slice — no subsequent lookup against it).

```
Structure pass — sorting, searching, selection

┌─ 1. LAYERS ─────────────────────────────────────────┐
│  Abstract goal (order/lookup/select) · Algorithm     │
│  (Timsort/linear/binary/quickselect) · Cost shape    │
│  (O(N log N) / O(N) / O(log N) / O(N) avg)           │
└────────────────────────┬─────────────────────────────┘
                         │  pick the axis
┌─ 2. AXIS ─────────────▼──────────────────────────────┐
│  cost: ops per element, sensitivity to N's           │
│  distribution and pre-sort status                    │
└────────────────────────┬─────────────────────────────┘
                         │  trace across layers, find flips
┌─ 3. SEAMS ────────────▼──────────────────────────────┐
│  S1: sort-once-many-access vs search-once ★present   │
│      (pay O(N log N) up-front vs linear per access)  │
│  S2: pre-sorted data → binary search ★absent         │
│      (would buy O(log N) lookup; not used here)      │
└────────────────────────┬─────────────────────────────┘
                         ▼
                 Block 4 — How it works
```

```
S1 seam — "do I sort, or scan?" answered two ways

┌─ Sort once ────────┐    seam     ┌─ Scan per access ─────┐
│  pay O(N log N)    │ ═════╪═════►│  O(N) per lookup       │
│  once, get ordered │  (it flips) │  no pre-cost           │
│  output            │             │  good when only 1-2    │
│                    │             │  lookups happen        │
└────────────────────┘             └────────────────────────┘
        ▲                                       ▲
        └────── same axis (cost), two answers ─┘
                → the codebase sorts when it needs ordered output
                  (top-K severity), scans when it needs one match
                  (findCurrentPrior)
```

The skeleton is mapped — the rest of this file walks each operation in turn.

---

## How it works

### Mental model

Three operations, three questions:

```
  SORT         — "give me everything in order"             O(N log N) best general
  SEARCH       — "find me this one thing"                  O(N) linear, O(log N) binary
  SELECT       — "give me the K best (or the K-th best)"   O(N log N) by sort,
                                                            O(N) average by quickselect
```

The choice between them depends on (a) what downstream wants (sorted output, one match, top K?) and (b) what you already know about the data (sorted? indexed? distributed how?).

### Move 1 — Sorting

Sorting puts the elements of a collection in some order. JavaScript's `Array.prototype.sort` uses **Timsort** in V8 (since Chrome 70 / Node 11) — a hybrid of merge sort and insertion sort, **stable**, O(N log N) worst-case, near-O(N) on partially-sorted input.

```
arr.sort(comparator)
  comparator(a, b) returns:
    negative  → a sorts before b   (ascending if you compute a - b)
    positive  → b sorts before a   (descending if you compute b - a)
    zero      → stable: a and b stay in original relative order

  cost:   O(N log N) comparisons
  space:  O(N) auxiliary (Timsort uses a merge buffer)
  stable: yes (V8 since 7.0 / Node 11; mandated by ES2019)
```

**The load-bearing sort in this codebase** is in `lib/agents/monitoring.ts` L119:

```ts
return [...parsed].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]).slice(0, 10);
```

Three operations composed: (a) `[...parsed]` makes a copy because `sort` mutates; (b) `.sort(comparator)` does the O(N log N) Timsort; (c) `.slice(0, 10)` takes top-N. The comparator subtracts integers from a rank table (`SEV_RANK`) because string enums have no native order — see the full case study in `.aipe/study-dsa-foundations/06-sorting-searching-and-selection.md`.

```
trace for input [{s:"info"}, {s:"critical"}, {s:"warning"}, {s:"positive"}]:

  comparator(a, b) = SEV_RANK[b] - SEV_RANK[a]
                   = (descending by SEV_RANK)

  SEV_RANK = {critical: 3, warning: 2, info: 1, positive: 0}

  V8 Timsort runs O(N log N) comparisons; final order:
  [{s:"critical"}, {s:"warning"}, {s:"info"}, {s:"positive"}]

  .slice(0, 10) returns all 4 (fewer than 10).
```

**Other sorts worth knowing about** (none used here):

```
  algorithm        cost (avg)    cost (worst)   stable?   in-place?   notes
  ──────────────   ───────────   ─────────────  ────────  ──────────  ────────────────
  Timsort (V8)     O(N log N)    O(N log N)     yes       no          hybrid merge+insertion
  merge sort       O(N log N)    O(N log N)     yes       no          divide and conquer
  quicksort        O(N log N)    O(N²)*         no        yes         randomized pivot
                                                                       for avg O(N log N)
  heapsort         O(N log N)    O(N log N)     no        yes         in-place via heap
  insertion sort   O(N²)         O(N²)          yes       yes         O(N) on nearly sorted
  radix sort       O(N·k)        O(N·k)         yes       depends     integers only,
                                                                       k = key length
  counting sort    O(N + K)      O(N + K)       yes       no          integers in [0, K)

  *worst case for naive quicksort; with randomized pivot, expected O(N log N)
```

### Move 2 — Searching

Searching finds one specific element. Two main strategies: linear (walk every element) and binary (split-and-narrow over sorted data).

**Linear search:**

```
linear_search(arr, target):
  for i from 0 to arr.length - 1:
    if arr[i] == target: return i
  return -1

  cost: O(N) worst case, O(N/2) average, O(1) best
  no precondition on arr (unsorted is fine)
```

**Binary search** (requires sorted input):

```
binary_search(arr, target):
  // PRECONDITION: arr is sorted ascending
  low = 0
  high = arr.length - 1
  while low <= high:
    mid = (low + high) // 2
    if arr[mid] == target:    return mid
    if arr[mid] < target:     low = mid + 1
    else:                     high = mid - 1
  return -1

  cost:    O(log N) — halve the search space each iteration
  precon:  arr must be sorted
```

```
binary search trace — find 7 in [1, 3, 5, 7, 9, 11, 13]:

  low=0, high=6, mid=3 → arr[3]=7 → found! return 3
  (one comparison)

  trace — find 8:

  low=0, high=6, mid=3 → arr[3]=7  < 8 → low=4
  low=4, high=6, mid=5 → arr[5]=11 > 8 → high=4
  low=4, high=4, mid=4 → arr[4]=9  > 8 → high=3
  low=4, high=3 → loop ends → return -1
  (three comparisons for N=7; log₂(7) ≈ 2.8 → checks out)
```

**The load-bearing searches in this codebase are all linear:**

- **`findCurrentPrior` in `lib/insights/derive.ts` L12–L20** — find-first scan over evidence:

```ts
// lib/insights/derive.ts L12–L20
export function findCurrentPrior(evidence): {current: number; prior: number} | null {
  for (const e of evidence) {
    const r = e.result;
    if (typeof r?.current === 'number' && typeof r?.prior === 'number') {
      return { current: r.current, prior: r.prior };
    }
  }
  return null;
}
```

Hand-rolled `Array.prototype.find` with a `typeof` narrow inside. Linear scan; first match wins. N is single-digit (evidence entries per anomaly) so O(N) is fine.

- **`replaceRunningTool` in `lib/hooks/useInvestigation.ts` L86–L95** — reverse linear scan for LIFO match:

```ts
// lib/hooks/useInvestigation.ts L86–L95
const replaceRunningTool = (arr, e) => {
  for (let i = arr.length - 1; i >= 0; i--) {
    const it = arr[i];
    if (it.kind === 'tool' && it.toolName === e.toolName && it.status === 'running') {
      arr[i] = { ...it, status: 'done', durationMs: e.durationMs, result: e.result, error: e.error };
      break;
    }
  }
  return arr;
};
```

Reverse scan (highest index first) to pair `tool_call_end` with the most recent matching `tool_call_start`. O(N) worst case (N = items in the trace so far); short-circuits on first match.

- **Substring scan in `lib/mcp/validate.ts` L7–L9** — a *content* search inside a string:

```ts
// lib/mcp/validate.ts L7–L9
const start = candidate.search(/[[{]/);
const end = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
if (start >= 0 && end > start) {
  return JSON.parse(candidate.slice(start, end + 1));
}
```

Two specialized searches: `search(regex)` returns the first index matching the character class, `lastIndexOf` returns the last index of a character. Together they bracket the JSON-looking substring inside arbitrary prose. This is the JSON extraction ladder's third fallback — see the case study in `.aipe/study-dsa-foundations/06-sorting-searching-and-selection.md`.

**Binary search is not yet exercised.** No sorted array has many subsequent lookups against it. The `SEV_RANK` table is a `Record<Severity, number>`, accessed by key (Map-like, O(1)), not by index. The `CATEGORIES` registry is iterated with `.map`, never searched. The TTL cache is a `Map`, hash-keyed, not binary-searched.

### Move 3 — Selection (top-K, K-th smallest)

Selection answers "give me the K-th smallest" or "give me the K smallest" without sorting the whole array. Two main strategies:

**Sort and slice** (the codebase's choice):

```
top_k(arr, k):
  return arr.sort(comparator).slice(0, k)

  cost: O(N log N) — pay full sort cost regardless of K
```

**Quickselect** (the asymptotically better choice for huge N):

```
quickselect(arr, k):
  // partitions the array around a pivot; recurses into the side containing k
  if arr.length <= 1: return arr
  pivot = random element of arr
  less    = elements < pivot
  equal   = elements == pivot
  greater = elements > pivot
  if k < less.length:           return quickselect(less, k)
  if k < less.length + equal.length: return arr[k] (in the equal partition)
  return quickselect(greater, k - less.length - equal.length)

  cost: O(N) average, O(N²) worst case (mitigated by random pivot)
```

**Heap-based top-K** (the streaming choice):

```
top_k_stream(arr, k):
  // maintain a min-heap of size k
  heap = MinHeap()
  for x in arr:
    if heap.size < k:
      heap.insert(x)
    elif x > heap.peek():
      heap.extractMin()
      heap.insert(x)
  return heap.toArray()

  cost: O(N log K) — better than O(N log N) when K << N
  space: O(K)
```

**The load-bearing selection in this codebase** is `.sort().slice(0, 10)` — the sort-and-slice variant — in `lib/agents/monitoring.ts` L119. This is the right choice at N=30, where O(N log N) = ~150 ops is invisible. For N=1M with K=10 (a streaming top-K problem), heap-based would beat sort-and-slice by ~6 orders of magnitude.

**Quickselect and heap-based top-K are not yet exercised.** No million-element selection problem.

### Move 2 variant — the irreducible kernel of each operation

**Sort kernel** (Timsort, the V8 default):

```
  isolate: split into "runs" (already-sorted subarrays), merge them
  what breaks if missing:
    - stability:    ties lose their original order; downstream filters break
    - O(N log N) guarantee:  worst-case input degrades to O(N²)
                            (Timsort hybridizes to avoid this)
    - merge buffer: in-place merging is O(N²); the O(N) extra space buys
                    you O(N log N) total time
```

**Binary search kernel** (when applicable):

```
  isolate: precondition (sorted) + halve search space each step
  what breaks if missing:
    - sorted precondition: bisecting unsorted data gives garbage
    - mid = low + (high - low) / 2: naive (low + high)/2 can overflow
      in fixed-int languages (not JS, but the habit matters)
    - low <= high loop condition: off-by-one bug, infinite loop or
                                  missed target
```

**Linear search kernel:**

```
  isolate: scan, compare, return on match
  what breaks if missing:
    - early return on match: scans the full array even after finding it
                             (wasted cost, especially on long arrays)
    - boundary check: walking off the end → undefined access
```

**Selection (quickselect) kernel:**

```
  isolate: partition + recurse on the side containing K
  what breaks if missing:
    - partition: without it you're sorting, not selecting (O(N log N))
    - random pivot: adversarial input degrades to O(N²)
                    (worst case = always picking the smallest/largest)
    - recurse only on relevant side: O(N²) if you recurse on both sides
```

### Move 3 — the principle

**The right operation depends on what you'll do with the result.** If you need ordered output, sort. If you need one match, search (linear if unsorted, binary if sorted). If you need top-K and N is huge, heap-based selection. If you need top-K and N is small, sort-and-slice — it's simple and asymptotically fine. The codebase makes the small-N choice consistently because N is small; the kernels above are what to reach for when N grows.

---

## Primary diagram

The three operations, their algorithms, cost, and where each lives (or doesn't) in this codebase.

```
                  SORTING, SEARCHING, SELECTION

  ┌─────────────────────┬──────────────────────────┬──────────────────────┐
  │ SORT                │ SEARCH                   │ SELECT (top-K)       │
  ├─────────────────────┼──────────────────────────┼──────────────────────┤
  │ goal: ordered all   │ goal: find ONE element   │ goal: K best,        │
  │                     │                          │       not all sorted │
  ├─────────────────────┼──────────────────────────┼──────────────────────┤
  │ algorithms:         │ algorithms:              │ algorithms:          │
  │ • Timsort (V8)      │ • linear        O(N)     │ • sort+slice O(N logN)│
  │   O(N log N) stable │ • binary        O(log N) │ • quickselect O(N) avg│
  │ • merge sort        │   (sorted only)          │ • min-heap   O(N logK)│
  │ • quicksort         │ • hash lookup   O(1) avg │   for streaming      │
  │ • radix (integers)  │ • substring     O(N·M)   │                      │
  ├─────────────────────┼──────────────────────────┼──────────────────────┤
  │ in repo:            │ in repo:                 │ in repo:             │
  │ • monitoring.ts L119│ • findCurrentPrior       │ • monitoring.ts L119 │
  │   .sort + slice     │   derive.ts L12–L20      │   .sort().slice(0,10)│
  │   (comparator + rank│ • replaceRunningTool     │   (sort-and-slice    │
  │    table)           │   useInvestigation L86–95│    variant; right for│
  │                     │ • substring scan         │    N=30)             │
  │                     │   validate.ts L7–L9      │                      │
  │                     │                          │ NOT YET:             │
  │                     │ NOT YET:                 │ • quickselect        │
  │                     │ • binary search          │ • heap-based         │
  │                     │   (nothing pre-sorted)   │   streaming top-K    │
  └─────────────────────┴──────────────────────────┴──────────────────────┘
```

---

## Implementation in codebase

Four sites — two for sort, two for search — and one honest gap (binary search).

### **Sort — the SEV_RANK comparator (`lib/agents/monitoring.ts` L51 + L119)**

```ts
// lib/agents/monitoring.ts L51
const SEV_RANK: Record<Severity, number> = { critical: 3, warning: 2, info: 1, positive: 0 };

// lib/agents/monitoring.ts L119
return [...parsed].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]).slice(0, 10);
```

The whole sort idiom in one line. `[...parsed]` is a copy (because `.sort()` mutates). The comparator subtracts integers from a rank table — `b - a` is descending, so critical sorts first. `.slice(0, 10)` is the top-N cap. The TypeScript type `Record<Severity, number>` is the compile-time guarantee that every severity has a rank; missing one is a build error, not a runtime NaN. Full case study at `.aipe/study-dsa-foundations/06-sorting-searching-and-selection.md`.

### **Sort — the schema event sort by count (`lib/mcp/schema.ts` L100)**

```ts
// lib/mcp/schema.ts L100
.sort((a, b) => b.eventCount - a.eventCount);
```

A second sort in the codebase: events ordered by event count, descending. Same idiom (`b - a` for descending), no rank table needed because `eventCount` is already a number. Used so downstream code (agents, UI) sees most-active events first.

### **Linear search — `findCurrentPrior` (`lib/insights/derive.ts` L12–L20)**

```ts
// lib/insights/derive.ts L12–L20
export function findCurrentPrior(evidence): {current: number; prior: number} | null {
  for (const e of evidence) {
    const r = e.result;
    if (typeof r?.current === 'number' && typeof r?.prior === 'number') {
      return { current: r.current, prior: r.prior };
    }
  }
  return null;
}
```

Hand-rolled `Array.prototype.find` with a `typeof` narrow inside the body. Why not `evidence.find(...)`? Because the type narrow only flows through an explicit `if` — `.find` would still need a cast or re-narrow after returning. The kernel is linear search: scan, test, return-on-match, fall-through-to-null. N is single-digit (evidence entries on one anomaly).

### **Linear search — reverse scan `replaceRunningTool` (`lib/hooks/useInvestigation.ts` L86–L95)**

```ts
// lib/hooks/useInvestigation.ts L86–L95
const replaceRunningTool = (arr, e) => {
  for (let i = arr.length - 1; i >= 0; i--) {
    const it = arr[i];
    if (it.kind === 'tool' && it.toolName === e.toolName && it.status === 'running') {
      arr[i] = { ...it, status: 'done', durationMs: e.durationMs, result: e.result, error: e.error };
      break;
    }
  }
  return arr;
};
```

Linear search, *reversed*. Walking from the end ensures the most recent matching `tool_call_start` gets paired with the incoming `tool_call_end` — LIFO match. This is the right discipline because tools are dispatched sequentially in this codebase; concurrent dispatches of the same tool would need a unique ID instead of name-matching. Full case study at `.aipe/study-dsa-foundations/02-arrays-strings-and-hash-maps.md`.

### **Substring search — the JSON extraction substring scan (`lib/mcp/validate.ts` L4, L7–L9)**

```ts
// lib/mcp/validate.ts L4
const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);

// lib/mcp/validate.ts L7–L9
const start = candidate.search(/[[{]/);
const end = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
if (start >= 0 && end > start) {
  return JSON.parse(candidate.slice(start, end + 1));
}
```

Two specialized string searches: `match(regex)` finds the first regex match (the fenced block); `search(regex)` finds the first index matching a character class (the outermost `[` or `{`); `lastIndexOf(char)` finds the last index of a specific character. The combination brackets the JSON-looking substring inside arbitrary prose. The cost is roughly O(N·M) per regex/search (N = text length, M = pattern length); for the small text sizes the agents emit, this is fine. Full case study at `.aipe/study-dsa-foundations/06-sorting-searching-and-selection.md`.

### **Argmin reduce — the funnel-leak selection (`components/feed/InsightCard.tsx` L155–L161)**

```ts
// components/feed/InsightCard.tsx L155–L161
const funnel = insight.funnel;
const funnelStages = funnel
  ? (['view','cart','checkout','purchase'] as const).map(k => ({ k, v: funnel[k] }))
  : [];
const leakKey = funnelStages.length
  ? funnelStages.reduce((a, b) => b.v < a.v ? b : a).k
  : null;
```

A *selection* in disguise — find the `k` of the element with the smallest `v` (argmin). This is the K=1 case of top-K. The reduce traverses once (O(N) where N=4 funnel stages), keeping the running min. The `.k` extracts the *key* of the minimum, not the value. This is the most common selection pattern in the codebase; see the full derivation case study at `.aipe/study-dsa-foundations/06-sorting-searching-and-selection.md`.

### **Binary search — `not yet exercised`**

No use of `Array.prototype.findIndex` against sorted data, no manual binary-search implementation, no `bisect`-like utility. The CATEGORIES array is fixed (10 entries — linear search would be fine, and `coverageReport` does `.map` over all 10 anyway). The TTL cache is hash-keyed, not array-of-sorted-keys. The anomalies array is sorted once then sliced — no subsequent searches against it.

**When this changes:** if the codebase grew a sorted index — say, a list of cached MCP results sorted by `expiresAt` so you could binary-search for "the first one that's still valid" — binary search would be the right tool. Today the Map's `.get` + inline `expiresAt > Date.now()` check makes this unnecessary; the lazy-expiry pattern beats maintaining a sorted index. (See the Elaborate block in the TTL cache case study for the cost trade.)

---

## Elaborate

### Where it comes from

**Quicksort** was invented by Tony Hoare in 1959 (he was trying to sort Russian-to-English translation dictionaries). **Merge sort** is older — John von Neumann described it in 1945 in one of the first formal algorithm descriptions for a stored-program computer. **Timsort** is younger (Tim Peters, 2002, for Python's `list.sort`); it became Java's `Arrays.sort` in 2009 and JavaScript's `Array.prototype.sort` in V8 7.0 (2018).

**Binary search** predates computers — it's how you find a word in a dictionary or a name in a phone book. Knuth's TAOCP volume 3 (1973) gives the canonical computer-science treatment, including the famous note that *most* binary search implementations are subtly buggy.

**Quickselect** (Hoare, 1961) is quicksort minus one recursive call — once you've partitioned, you only recurse into the side containing the K-th element.

### The deeper principle

**The three operations form a hierarchy.** Sort is "select everything in order" — strictly more work than selecting just the top K. Search is "find one specific element" — strictly less work than sorting, since you can stop as soon as you've found it. Selection is in between: more work than search (you have to compare K elements against each other), less than sort (you don't need the order of the K-1 you didn't pick).

```
  cost ordering (best case, N elements):

    linear search        O(N)
    binary search        O(log N)   (precondition: sorted)
    quickselect (top-K)  O(N) avg
    heap top-K           O(N log K)
    full sort            O(N log N)
```

The choice between them is "what's the least work that gets me what I need?" Sorting when you only need top 10 of 1M is paying for 999,990 ordered positions you'll never look at.

### Where it breaks down

- **Binary search requires a sorted array.** Sorting is O(N log N), so binary-searching once on freshly-sorted data is *worse* than linear search on the original (O(N log N) + O(log N) > O(N)). Binary search pays off when you do many searches against the same sorted data.

- **Quickselect's worst case is O(N²).** Naive pivot choice (always pick the first element) degrades on already-sorted input. Random pivot mitigates this; "median of medians" pivot guarantees O(N) worst-case but with worse constants.

- **Comparator-based sort is bounded by O(N log N).** No comparison sort can be better than O(N log N) in the worst case (information-theoretic bound). To beat it, you need *non-comparison* sorts that exploit structure in the keys: radix sort (O(N·k) for k-digit integers), counting sort (O(N + K) for keys in a small range).

- **JavaScript's `sort` is in-place** — it mutates the array. The `[...parsed]` copy in `monitoring.ts` L119 isn't decoration; it's correctness. Without it, the original parsed array would be reordered, surprising any caller that held a reference.

### What to explore next

- **Heap-based streaming top-K** — when you have N arriving live and you want the K largest seen so far. Min-heap of size K, push if larger than root. Used in real-time analytics, online recommendation systems.

- **Bisect / `lower_bound` / `upper_bound`** — variants of binary search that find the insertion point for a value in a sorted array. `bisect_left` returns the leftmost index where you could insert to keep the array sorted; `bisect_right` returns the rightmost. Useful for sliding-window problems and counting elements in a range.

- **External sort** — sorting data too big to fit in memory. Merge sort variants that read and write in chunks; used in databases and big-data pipelines.

- **Radix sort and bucket sort** — non-comparison sorts that beat the O(N log N) lower bound for integer keys. Used in string sorting (radix sort on each character), histogram building, and database hash joins.

---

## Interview defense

**What they are really asking.** Whether you can name the right operation for the goal, defend the cost model, and recognize when the cheap operation (linear search, sort-and-slice) is right vs when you'd reach for the fancier one (binary search, quickselect, heap-based top-K). Senior signal: knowing why `[...parsed]` is in front of `.sort()` (it mutates). Architect signal: explaining when O(N log N) is fine and when you'd insist on O(N) selection.

---

**[mid] "Why does `monitoring.ts` L119 do `[...parsed].sort(...).slice(0, 10)` instead of just `parsed.sort(...).slice(0, 10)`?"**

Because `Array.prototype.sort` mutates the array in-place. If `parsed` was passed by reference from a caller (it is — `parsed` is the result of `parseAgentJson`), reordering it would surprise the caller. The spread `[...parsed]` copies into a new array before sorting; the copy is the throwaway. The cost is one extra O(N) allocation, which is invisible at N=30. For N=1M you'd weigh that copy against the in-place mutation; here the safety matters more than the allocation.

---

**[senior] "When would you reach for binary search in this codebase?"**

Not today, because nothing here is pre-sorted in a way that makes binary search pay off. The CATEGORIES array is small (10 entries — linear is fine and `.map`'d over anyway). The cache is a hash map (O(1) lookup, no array). The anomalies array is sorted once then sliced — no subsequent searches. Binary search becomes the right answer when you have a *long-lived sorted index* with *many subsequent lookups*. The plausible scenario: if the cache grew an "expires-by-time" sorted index (a TreeMap or a sorted-by-`expiresAt` array), you'd binary-search for "first entry expiring after now" in O(log N) instead of scanning all entries in O(N). Today the lazy-expiry pattern in `lib/mcp/client.ts` L107–L108 makes this unnecessary — the `expiresAt > Date.now()` check happens inline on lookup, no separate index needed.

```
  scenario triggering binary search:
    long-lived array sorted by some key
    + many subsequent lookups against it
    + N large enough that O(N) per lookup is real cost (~10K+)

  none of these hold in this codebase today.
```

---

**[arch] "The monitoring agent sorts 30 anomalies and slices the top 10. Wouldn't quickselect be asymptotically better?"**

Asymptotically yes, but irrelevantly so at N=30. Sort-and-slice is O(N log N) = ~150 comparisons. Quickselect is O(N) average = ~30 comparisons. The difference is ~120 microseconds; the network call to Bloomreach took ~500ms. Quickselect would matter if N were 10M and K=10 — that's the order of magnitude where O(N) vs O(N log N) is visible (10M vs 230M ops). Until N gets there, sort-and-slice wins on *simplicity* (one line, no custom partition logic, stable, predictable). The right answer is `.sort().slice()` for now; the trigger to switch is N growing 5+ orders of magnitude.

```
  N      sort + slice O(N log N)   quickselect O(N) avg
  ────   ─────────────────────     ────────────────────
  30     ~150 ops                  ~30 ops          ← invisible diff
  10K    ~130K ops                 ~10K ops         ← noticeable
  10M    ~230M ops                 ~10M ops         ← real cost
```

---

**The dodge: "but `Array.prototype.sort` is O(N log N) — isn't that slow for any non-trivial N?"**

O(N log N) is the *information-theoretic lower bound* for comparison-based sorting. You can't do better than O(N log N) when the only thing you can do is compare two elements pairwise (proven by counting decision-tree leaves). To beat it, you need to exploit *structure* in the keys: radix sort on integers (O(N·k) where k is the number of digits), counting sort on small-range integers (O(N + K)), or bucket sort on uniformly distributed data. None of those apply to severity strings or generic anomaly objects. So O(N log N) is the right cost — accept it and pick the sort with good constants and stability (Timsort). Cite the V8 default in `lib/agents/monitoring.ts` L119.

---

**Anchors (cite these in your answer)**

- `lib/agents/monitoring.ts` L51 — `SEV_RANK` rank table for the comparator
- `lib/agents/monitoring.ts` L119 — sort + slice (top-K via sort-and-slice)
- `lib/mcp/schema.ts` L100 — second sort, by `eventCount` descending
- `lib/insights/derive.ts` L12–L20 — linear search with typeof narrow
- `lib/hooks/useInvestigation.ts` L86–L95 — reverse linear scan (LIFO match)
- `lib/mcp/validate.ts` L4, L7–L9 — substring search via regex + `lastIndexOf`
- `components/feed/InsightCard.tsx` L159–L161 — argmin selection (K=1 top-K via reduce)

---

## See also

→ `01-complexity-and-cost-models.md` (where the O(N log N) cost of sort and O(log N) of binary search live) · → `02-arrays-strings-and-hash-maps.md` (the primitives these operations work on) · → `03-stacks-queues-deques-and-heaps.md` (heaps as the streaming top-K data structure) · → `.aipe/study-dsa-foundations/06-sorting-searching-and-selection.md` (full case study of the SEV_RANK sort) · → `.aipe/study-dsa-foundations/06-sorting-searching-and-selection.md` (full case study of the substring scan)
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).

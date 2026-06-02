# Complexity and cost models

**Industry name(s):** time complexity, space complexity, amortized analysis, big-O notation, input-size reasoning
**Type:** Industry standard · Language-agnostic

> Before you can argue that a data structure is right for a job, you need a way to compare the cost of two candidates without running them. Big-O is the vocabulary; amortized analysis is the move that makes "occasionally expensive, mostly cheap" comparable to "always medium."

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Cost reasoning sits *underneath* every other DSA chapter in this guide — it's how you compare two implementations on paper before you write either. In this codebase, the comparisons that actually got made (often implicitly) are: should the TTL cache use a `Map` or an array of `{key, value}` pairs (Map, O(1) vs O(N)); should the coverage gate walk the nested schema per dep or flatten it to a `Set` first (Set, O(N) build then O(1) per query vs O(D·N) per call); should the spacing gate's "1100 ms gap" be modeled per-call or amortized over a burst (amortized — the *average* throughput is the budget, not the worst-case wait).

```
Zoom out — where complexity reasoning lives

┌─ Every other chapter in this guide ───────────────┐
│  02 arrays/maps · 03 queues/heaps · 04 trees · …  │
└─────────────────────────┬──────────────────────────┘
                          │  every "is X cheap enough?" question
┌─ ★ Complexity + cost models ★ ────────────────────┐  ← we are here
│   time complexity   — ops as input grows           │
│   space complexity  — memory as input grows         │
│   amortized cost    — average across many calls     │
│   input-size sense  — pick the right model for N    │
└─────────────────────────┬──────────────────────────┘
                          │  feeds back as the comparison tool
┌─ Concrete repo decisions ──────────────────────────┐
│  Map vs scan      → Map (TTL cache)               │
│  Set vs walk      → Set (coverage gate)           │
│  per-call vs amort → amortized (rate-limit gate)   │
└────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when you say "this is O(N)," what does that mean operationally, what does it ignore (constants, lower-order terms), and when do you need to upgrade from "single-call cost" to "amortized cost across many calls"? The answer is three models in increasing sophistication: **time complexity** (ops as input grows), **space complexity** (memory as input grows), and **amortized analysis** (average cost across a sequence, used when one in N calls is expensive and N-1 are free). The load-bearing trick the codebase uses repeatedly is the same one: **pay O(N) once, get O(1) per query** — `schemaCapabilities` flattens once, the TTL cache fills once per key, the Set-union dedups once at module load. The next sections name the three models, walk the canonical comparisons, and pin them to the repo decisions they explain.

---

## Structure pass

**Layers.** Cost reasoning is a three-layer tower: the **input model** (what is N — bytes? tools? events? distinct callers?), the **cost model** (time, space, or amortized), and the **decision** (which data structure or algorithm wins). All three have to be named to make the comparison useful. "It's O(N)" with no N defined isn't an argument; "it's O(N log N) where N is the number of anomalies returned by one agent call, max 30" is an argument.

**Axis: cost.** This is the only chapter where the axis IS the chapter title — cost is *the* lens. Pick it and everything else falls out. State competes weakly (you need to know what's stored to count space), and control competes weakly (a loop's iteration count is part of cost), but cost is the load-bearer. The interesting work is choosing *which* cost — single-call wall time, throughput, peak memory, amortized? Different N's call for different costs.

**Seams.** Two seams matter; one is load-bearing. **Seam 1 (load-bearing): single-call cost → amortized cost.** Cost flips from "one operation's worst case" to "average across a long sequence." This is the seam the rate-limit gate sits behind — it doesn't matter that one call sleeps 805 ms if the *throughput* over 60 seconds is one call/sec; the amortized cost per call is bounded. **Seam 2: theoretical big-O → measured wall time.** Cost flips from "asymptotic" to "in milliseconds, on this hardware, for this N." Big-O loses information (constants, cache effects, GC pressure) that wall-time measurement keeps. Both views are valid; they answer different questions.

```
Structure pass — complexity and cost models

┌─ 1. LAYERS ─────────────────────────────────────────┐
│  Input model (what is N?) · Cost model (time/space/  │
│  amortized) · Decision (which algorithm wins)        │
└────────────────────────┬─────────────────────────────┘
                         │  pick the axis
┌─ 2. AXIS ─────────────▼──────────────────────────────┐
│  cost: ops/memory/wait per unit of input — the lens  │
│  for every comparison                                │
└────────────────────────┬─────────────────────────────┘
                         │  trace across layers, find flips
┌─ 3. SEAMS ────────────▼──────────────────────────────┐
│  S1: single-call cost → amortized cost ★load-bearing │
│      (one op's worst case → avg across a sequence)   │
│  S2: theoretical big-O → measured wall time          │
│      (asymptotic → ms on this hardware for this N)   │
└────────────────────────┬─────────────────────────────┘
                         ▼
                 Block 4 — How it works
```

```
S1 seam — "is this call expensive?" answered two ways

┌─ Single-call view ─┐    seam     ┌─ Amortized view ─────┐
│  worst case: one   │ ═════╪═════►│  long-run average:    │
│  call sleeps 1.1 s │  (it flips) │  1 call/sec sustained │
│  → looks slow      │             │  → throughput bounded │
└────────────────────┘             └───────────────────────┘
        ▲                                       ▲
        └────── same axis (cost), two answers ─┘
                → the rate-limit gate is defended on the right side
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

---

## How it works

### Mental model

Big-O notation expresses how an algorithm's cost grows with its input size, dropping constants and lower-order terms. It answers "how does this scale?" not "how fast is this in milliseconds?" The two are different questions; both matter, and they don't always agree.

```
  N = input size              cost = f(N)
  ─────────────────────────────────────────────
  1, 10, 100, 1000…           how many operations
                              how much memory
                              how long it sleeps

  big-O drops:                keeps:
    constants     (2N → N)    leading term
    lower order   (N + 5 → N) growth shape
    base of log   (log₂ → log)
```

You read big-O like a *promise about scaling*. O(1) means "cost doesn't grow with N." O(N) means "cost grows linearly with N." O(N log N) means "cost grows a bit faster than linear." O(N²) means "doubling N quadruples cost." The numbers matter less than the *shape* — and the shape predicts whether N=10 and N=10,000 will both be tolerable.

### Move 1 — the seven big-O classes you actually use

Most code lives in five of these. The other two show up rarely but are worth recognizing.

```
  class      name              shape           example in this codebase
  ────────────────────────────────────────────────────────────────────────
  O(1)       constant          flat            Map.get, Set.has, array[i]
  O(log N)   logarithmic       very slow grow  not yet exercised (binary search)
  O(N)       linear            proportional    Array.filter, for-loop over evidence
  O(N log N) linearithmic      slightly super- comparator-based sort (V8 Timsort)
                               linear
  O(N²)      quadratic         doubles → 4×    avoided everywhere (e.g. Set dedup
                                               instead of nested-loop dedup)
  O(2ᴺ)      exponential       doubles → 2×    not yet exercised (brute backtrack)
  O(N!)      factorial         catastrophic    not yet exercised (permutations)
```

The codebase deliberately lives in the top three rows: O(1), O(N), O(N log N). When it could have slipped into O(N²) — like the Set-union dedup that *would* have been a nested loop — the implementation pays an extra O(N) hash table build to stay linear. That's the explicit cost trade.

### Move 2 — the comparisons that matter

The interesting move isn't naming big-O; it's *picking the right comparison*. Six comparisons keep recurring in this codebase:

#### **lookup: Map vs linear scan**

```
  question: "given a key, get the value"

  linear scan an array of {key, value} pairs:
    for (const entry of arr) if (entry.key === key) return entry.value
    cost: O(N) per lookup, O(1) per write (push)

  Map.get(key):
    cost: O(1) per lookup (average), O(1) per write
    space: O(N) (no different from the array)

  when N > ~30 and lookups outnumber writes: Map wins decisively.
  when N < 10 and you do one lookup: array is fine (cache-friendly,
    no hash overhead).
```

The TTL cache picks Map because it does many reads per key over a session. The CATEGORIES registry stays as an array because there are 10 of them and the only "lookup" is a `.map` over all of them.

#### **dedup: Set vs nested loop**

```
  question: "given an array with duplicates, return one with no duplicates"

  nested loop:
    result = []
    for x in arr:
      if x not in result: result.push(x)  ← .indexOf is O(N)
    cost: O(N²)

  Set:
    result = [...new Set(arr)]
    cost: O(N) build + O(N) spread = O(N)
    space: O(N) (the Set itself)
```

`queryTools` uses the Set approach for the union of three tool arrays. The space cost is the price of going from O(N²) to O(N) — you can't get linear time without linear space here.

#### **frame: per-chunk vs amortized over the stream**

```
  question: "how expensive is parsing the NDJSON stream?"

  per-chunk view:
    buf += decoded         O(buf.length + chunk.length)   ← string concat
    lines = buf.split('\n') O(buf.length)
    for line: JSON.parse(line)  O(line.length) each

  amortized over the full stream of K total bytes:
    every byte appended once          O(K)
    every byte split once              O(K)
    every line parsed once             O(K)  (sum of all line lengths = K)
    total per stream                   O(K)
```

The per-chunk view looks bad — three O(buf) passes per iteration. The amortized view shows the actual cost is linear in the *total* bytes. Both views are valid; the amortized view is the one you use to defend the design.

#### **rate-limit: worst-call vs steady-state throughput**

```
  question: "is the 1100ms spacing gate slow?"

  worst-call:  one call may wait up to 1100 ms.   ← scary
  amortized:   over a long sequence, throughput
               is bounded at 1/1.1 ≈ 0.9 req/sec. ← that's the point
```

The whole purpose of the spacing gate is to *bound* the amortized throughput. The per-call wait isn't a bug, it's the load-bearer.

#### **traversal: O(C·D) walk-per-cat vs O(N) flatten-once**

```
  question: "for 10 categories with D deps each, against a schema of N items,
             how expensive is the coverage check?"

  walk-per-cat:
    for each cat: for each dep: search the nested schema
    cost: O(C · D · N) per briefing

  flatten-once:
    build flat Set from schema   O(N) once
    for each cat: for each dep: set.has(dep)  O(1) each
    cost: O(N + C·D) per briefing  — almost always linear in N for small C·D
```

This is the same "pay O(N) once, get O(1) per query" pattern as the Map. The coverage gate's whole performance argument is in this comparison.

#### **sort: comparator stable sort cost**

```
  question: "what does .sort() cost?"

  V8 Timsort:  O(N log N) comparisons, stable, near-O(N) on partially-sorted
               input (the common case for already-mostly-sorted data).
  space:       O(N) auxiliary (Timsort uses a merge buffer)

  for N=10 anomalies, this is ~33 comparisons. invisible cost.
  for N=10 million, this is ~230 million comparisons. real cost.
```

Knowing the sort is O(N log N), not O(N²), is what lets `MonitoringAgent.scan` `.sort()` and `.slice(0, 10)` without worrying about N being 30 instead of 10. Slicing *before* sorting wouldn't be a meaningful optimization at this N.

### Move 2 variant — the irreducible kernel of amortized analysis

Amortized analysis is the one cost model people consistently get wrong. The kernel is small.

```
amortized_cost(operation):
  total_cost  = sum of costs across a sequence of M operations
  amortized   = total_cost / M

  // the trick: even if ONE op costs O(N), if the next N-1 ops cost O(1),
  // the amortized cost per op is O(1) — not O(N).
```

**Name each part by what breaks when missing:**

```
Removed                       What breaks
──────────────────────────    ─────────────────────────────────────
sequence-of-M view             You report worst-case per call (1100 ms)
                               and the rate-limit gate looks broken.
                               It isn't — averaged over the run, it's
                               1 call/sec, which IS the budget.

total_cost as the numerator    You can't distinguish "expensive once"
                               from "expensive every time." A
                               dynamic-array push is O(N) when it
                               resizes — but resizing happens O(1/N)
                               of the time, so amortized push = O(1).

count M as the denominator     You can't normalize. Saying "the build
                               cost N" is meaningless without "but
                               every subsequent query is O(1) and we
                               do M of them."
```

**Skeleton vs hardening:**

```
SKELETON (the kernel)              HARDENING (advanced extras)
─────────────────────────────      ─────────────────────────────────
total_cost / M                     amortized accounting method
worst-case ≠ amortized             potential method (Ψ function)
                                   competitive analysis (vs offline opt)
```

For 95% of the code you'll write, the kernel is enough: name M, name the total, divide.

### Move 3 — the principle

**Pick the model that matches the question.** Big-O is for "does this scale?" Amortized is for "is the average call bounded?" Wall time is for "is this fast enough on my hardware for my N?" Reach for the wrong one and you'll defend the wrong tradeoff.

---

## Primary diagram

Every cost-model decision in this codebase, in one frame.

```
                      THE COST DECISION TREE

  question: which cost model?
                   │
       ┌───────────┼────────────────────────────────┐
       ▼           ▼                                ▼
  "does it    "is one call's worst              "how big is N
   scale?"     case the same as its             on my hardware?"
       │       amortized cost?"                     │
       ▼            │                               ▼
  ┌─────────┐       ▼                          ┌──────────┐
  │ big-O   │  ┌──────────┐                    │ wall time│
  │ time +  │  │ amortized│                    │  + memory│
  │ space   │  │ analysis │                    │  profile │
  └─────────┘  └──────────┘                    └──────────┘
       │            │                               │
       ▼            ▼                               ▼
  e.g. Map.get      rate-limit gate                  is N=30 anomalies
  is O(1); array     1100 ms per call,                fast enough? yes
  scan is O(N);     ~1 req/sec averaged              (V8 Timsort, ~33
  Set dedup is      over a burst.                    compares).
  O(N), not O(N²)
```

---

## Implementation in codebase

Where cost reasoning shaped a real decision in this repo. Three sites.

### **`lib/mcp/client.ts` L80 — the TTL cache uses a `Map`, not an array**

```ts
// lib/mcp/client.ts L80
private cache = new Map<string, { result: unknown; expiresAt: number }>();
```

Why a `Map` and not an `Array<{key, value, expiresAt}>`? Because `callTool` does many lookups per key across a session. Lookup on an array is O(N) — every call would walk the cache from the start. Lookup on a `Map` is O(1) average — the cost doesn't grow with the number of cached tools. The space cost is identical (both store one entry per key); the time cost is the difference between O(1) per call and O(N) per call. With N growing across a session, this is the comparison the design has to win, and `Map` wins it asymptotically.

### **`lib/mcp/tools.ts` L38–L40 — Set-union dedup avoids the O(N²) nested loop**

```ts
// lib/mcp/tools.ts L38–L40
export const queryTools = [
  ...new Set<string>([...monitoringTools, ...diagnosticTools, ...recommendationTools]),
] as const;
```

The "natural" implementation of dedup would be a nested loop: for each candidate, check whether it's already in the result. That's O(N²). The `new Set(...)` version is O(N) — one pass to insert (each insertion is O(1) hash), one pass to spread. The cost trade is *space*: the Set holds N entries in a hash table. For N=15 tools that's nothing; the principle scales to N=15 million the same way.

### **`lib/agents/categories.ts` L116–L127 — flatten once, query many**

```ts
// lib/agents/categories.ts L116–L127
export function schemaCapabilities(schema): Set<string> {
  const set = new Set<string>();
  for (const e of schema.events ?? []) {
    set.add(e.name);
    for (const p of e.properties ?? []) set.add(`${e.name}.${p}`);
  }
  for (const c of schema.catalogs ?? []) set.add(`catalog:${c.name}`);
  return set;
}
```

This is the "amortized" decision made explicit. Building the `Set` is O(schema size). Then every category check is O(deps) with O(1) `has` per dep. Naive walk would be O(categories × deps × schema) per check — multiply by 10 categories and it's a real cost. The trade is the same: O(N) once to build, O(1) per query thereafter. The `has` calls in `coverageFor` (L131–L136) collect the payoff.

### **`lib/mcp/client.ts` L148–L163 — the spacing gate is amortized cost made physical**

```ts
// lib/mcp/client.ts L148–L163 (excerpt)
const elapsed = Date.now() - this.lastCallAt;
if (elapsed < this.minIntervalMs) {
  await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
}
```

This sleep is the cost being paid to *enforce* an amortized throughput bound of 1 call per `minIntervalMs`. Per-call worst case: 1100 ms wait. Amortized throughput over a long sequence: 0.9 req/sec. The design defends itself only when you read it amortized — per-call, it looks like wasted time.

### **`.aipe/study-software-design/audit.md#complexity-in-this-codebase`** — design complexity (a different sense of the word)

That file uses "complexity" in the *A Philosophy of Software Design* sense — interface complexity, conceptual load on the reader. This file uses "complexity" in the *algorithmic* sense — operations per N. Same word, different lens; both apply to this codebase, and they don't always agree. A simple algorithm (linear scan) can have ugly cost (O(N²)); a complex algorithm (Timsort) can have great cost (O(N log N)). Don't conflate them.

---

## Elaborate

### Where it comes from

Big-O notation was introduced into computer science by Donald Knuth in the 1970s, borrowed from number theory (Bachmann, 1894). The amortized analysis vocabulary is younger — Robert Tarjan formalized it in the mid-1980s, partly to defend dynamic arrays (which look O(N) per push if you only look at the resize) and splay trees (which look bad per-operation but are excellent across a sequence).

The asymptotic-vs-measured tension is older than computing — it's a real tradeoff in all engineering. Big-O is the *asymptotic* view, valid as N grows; wall-time measurement is the *operational* view, valid right now on this hardware. Real engineers reach for both.

### The deeper principle

**Asymptotic cost is a promise about scaling. Wall-time is a measurement of right now. They don't replace each other.** When N is small enough that constants dominate (10 anomalies, 10 categories, 15 tools), wall-time wins — the asymptotic argument is moot because everything is fast enough. When N grows beyond what you tested (10 million events from a future workspace, 1000 concurrent users), asymptotic wins — the wall-time measurement at N=10 doesn't tell you what happens at N=10⁷.

This codebase lives mostly in the small-N regime. Its bottleneck is *latency to the LLM and to Bloomreach*, not local compute. Most of the cost-model work is "make sure the local steps don't accidentally do something quadratic so that the linear network costs dominate." That's why every internal data structure here is O(1) or O(N) — to stay invisible.

### Where it breaks down

- **Big-O hides constants that matter at small N.** A "O(1)" `Map.get` involves a hash, a bucket lookup, a chain walk. A "O(N)" array scan over N=5 entries is faster — fewer instructions, all cache-hot. At N=5 the array wins; at N=500 the Map wins. Knowing the crossover requires measurement.

- **Amortized cost can mislead about tail latency.** The dynamic array push is "amortized O(1)" — but the resize is O(N) and happens at *some specific call*. If that call is in your hot path (e.g. a request that triggers the resize), the user sees the full O(N), not the amortized average. P99 latency is not the average.

- **Space complexity tends to get ignored.** Every "pay O(N) once" trick in this codebase *adds* O(N) space. That's fine here because N is small (15 tools, 10 categories, a few hundred cached MCP results). At larger N, the memory cost is the limit, not the time cost.

### What to explore next

- **Master theorem** — closed-form solutions for the recurrence relations that show up in divide-and-conquer algorithms (merge sort, binary search). You'll need it when you start writing recursive solutions, which the next chapters do.

- **Cache-oblivious algorithms** — algorithms whose performance is good across all levels of the memory hierarchy without being tuned for any specific cache size. Tim Sort uses some of these ideas; understanding them is what makes "O(N log N)" feel different from "O(N log N) but actually fast."

- **Amortized analysis methods** — there are three formal techniques (aggregate, accounting, potential function). The aggregate method (`total cost / M`) covers most cases; the potential method is the heavy machinery for when one of N operations is genuinely expensive and you need to "credit" the cheap ones.

---

## Interview defense

**What they are really asking.** When an interviewer asks "what's the time complexity?" they want to see two things: that you name the asymptotic class correctly, and that you name *what N is*. "It's O(N)" without saying what N is is a dodge. They also want to see you reach for amortized analysis when the per-call cost varies — that's the senior signal.

---

**[mid] "What's the time complexity of `Array.prototype.sort` in JavaScript?"**

O(N log N) average, where N is the array length. V8 uses Timsort (since Chrome 70 / Node 11), which is stable and adaptive — it's faster on partially-sorted input, approaching O(N) when the input is nearly sorted. The space is O(N) auxiliary because Timsort uses a merge buffer. For the codebase's case in `monitoring.ts` L119 — N=10 to 30 anomalies — this is around 30-150 comparisons. Invisible.

```
  N         compares (~N log₂ N)
  ──────    ────────────────────
  10        ~33
  100       ~660
  10,000    ~130,000
  1,000,000 ~20,000,000
```

The shape doubles slightly faster than linear. The "log" part of N log N matters less than the "N" part as long as the constants are small.

---

**[senior] "The TTL cache is a `Map`. Why not just use a plain object `{}`?"**

Three reasons that matter at non-toy size. First, asymptotic: `Map.get(key)` is O(1) regardless of the key type, while a plain object's property access can hit slow paths for certain keys (`__proto__`, numeric keys that get reordered, hidden-class deoptimizations in V8). Second, semantics: `Map` accepts any key (including objects), iterates in insertion order, and reports its size in O(1) via `.size`. Third, garbage collection: a `Map` doesn't have a prototype chain, so adding entries doesn't risk colliding with `Object.prototype`. The TTL cache (`lib/mcp/client.ts` L80) needs none of these *specific* features, but `Map` is the safe default — O(1) is guaranteed, not aspirational.

```
  property of Map vs {}                 affects cost?
  ─────────────────────────────────     ──────────────
  guaranteed O(1) on any key            yes (assured)
  no prototype-chain collision          yes (defensive)
  iteration in insertion order          no (correctness)
  .size in O(1)                         no (convenience)
```

---

**[arch] "The rate-limit gate sleeps 1100 ms per call. Isn't that catastrophically slow?"**

It's catastrophic if you measure per-call worst case. It's *exactly the design* if you measure amortized throughput. The Bloomreach MCP server enforces a ~1 req/sec rate limit; the proactive spacing gate (`lib/mcp/client.ts` L148–L163) sleeps just enough between calls to stay under that limit. The amortized cost is what matters: over a long sequence of M calls, total wait time is ≤ M × 1100 ms, and amortized cost per call is ≤ 1100 ms. The alternative — no spacing — produces a flood of 429s, each of which triggers the retry loop, each of which sleeps the parsed retry-after (often 10s+), so the *real* per-call cost without spacing is *higher*, not lower.

```
  with spacing gate:
    worst-call:   1100 ms (predictable)
    amortized:    1 call / 1.1 s (the budget)

  without spacing gate:
    worst-call:   no bound — every burst triggers 429 + 10s+ retry
    amortized:    1 call / (1.1 s + retry-after) — strictly worse
```

This is the case where amortized analysis is the *only* analysis that defends the design.

---

**The dodge: "isn't all of this just premature optimization?"**

For some of it, yes — and that's fine. The codebase doesn't pre-tune for huge N; it picks data structures that *stay correct* as N grows. The Set-union dedup in `tools.ts` L38–L40 isn't a hot path (it runs once at module load), so its O(N) vs O(N²) difference isn't worth defending operationally. It *is* worth defending architecturally: if the tool list grew to 1500 instead of 15, the O(N²) version would break and the O(N) version wouldn't. Picking the right asymptotic shape early costs nothing now and avoids a rewrite later. The honest version: cost-model thinking is mostly *defensive*, not optimizing.

---

**Anchors (cite these in your answer)**

- `lib/mcp/client.ts` L80 — `Map` chosen for O(1) lookup
- `lib/mcp/tools.ts` L38–L40 — `Set` dedup avoids O(N²)
- `lib/agents/categories.ts` L116–L127 — flatten-once for amortized O(1) per query
- `lib/mcp/client.ts` L148–L163 — spacing gate as amortized-throughput bound
- `lib/agents/monitoring.ts` L119 — `.sort()` O(N log N) at N ≤ 30, invisible cost

---

## Validate

### Level 1 — reconstruct

Without looking, write the seven big-O classes from O(1) to O(N!), with one example of each from this codebase (or "not yet exercised"). Then write the kernel formula for amortized cost: `amortized = total_cost / M` and one sentence explaining when you reach for it instead of single-call cost.

### Level 2 — explain

Open `lib/mcp/client.ts` L80 and L149. Explain the asymptotic complexity of the `cache` field at L80 (lookup, write, space) and the spacing gate at L149 (worst-case wait, amortized throughput). State why each cost model is the right one for that line.

### Level 3 — apply

Scenario: a new feature wants to take the 10 categories and rank them by "most-missing-deps first" so the UI shows the closest-to-runnable ghost tiles at the top. You need to (a) compute `missingFor(cat)` for each category and (b) sort the results by `missing.length`. Cite `lib/agents/categories.ts` L139–L141 for the `missingFor` cost and `lib/agents/monitoring.ts` L119 for the sort pattern. What is the total complexity for one briefing? What is N for each step? Does this require any structural change to the existing data structures?

### Level 4 — defend

A teammate says: "Move the TTL cache to Redis so it's shared across processes." Defend the current in-process `Map` choice on cost grounds. Address: per-call latency cost (Map.get vs Redis network roundtrip), space cost (process heap vs Redis memory), and the amortized vs worst-case question (when does cross-process consistency become worth the per-call cost?). Reference `lib/mcp/client.ts` L80 and L102–L110.

### Quick check

- What does V8's `Array.prototype.sort` use under the hood, and what is its space complexity? (Timsort, O(N) auxiliary.)
- For N=15 distinct tool names, how many operations does `new Set([...a, ...b, ...c]).size` cost? (O(15) ≈ 15 insertions + 15 spread = ~30 ops.)
- Per-call cost of the spacing gate is up to 1100 ms; what is the amortized cost per call over a long sequence? (≤ 1100 ms — and that's the budget, not a failure.)
- What is the space complexity of `schemaCapabilities` for a schema with E events and P properties per event? (O(E + E·P + C) = O(E·P) dominated.)
- Why is `Map.get(key)` "O(1) average" and not "O(1) worst case"? (Hash collisions can degrade to O(N); worst case is rare in V8's hash implementation but exists.)

## See also

→ `02-arrays-strings-and-hash-maps.md` (where O(1) lookup shows up most) · → `06-sorting-searching-and-selection.md` (where O(N log N) shows up) · → `.aipe/study-software-design/audit.md#complexity-in-this-codebase` (the design-complexity lens, different sense of the word)

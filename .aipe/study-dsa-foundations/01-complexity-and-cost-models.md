# Complexity and cost models

*Big-O, amortized analysis, the right unit of cost — Industry standard*

## Zoom out — where cost reasoning lives in this repo

```
  Cost surfaces, top to bottom — pick the right one
  ─────────────────────────────────────────────────

  ┌─ UI layer ──────────────────────────────────────┐
  │ React render: O(N) over N insights (N ≤ 10)     │
  │ → CPU cost is *negligible* here                 │
  └────────────────────────┬────────────────────────┘
                           │
  ┌─ Streaming kernel ─────▼────────────────────────┐
  │ split('\n') + JSON.parse per line               │
  │ → cost is amortized over chunk size, not lines  │
  └────────────────────────┬────────────────────────┘
                           │
  ┌─ Service layer ────────▼────────────────────────┐
  │ Map.get O(1) · Array.filter O(N) · sort O(N log N)│
  │ → still negligible: N is single digits          │
  └────────────────────────┬────────────────────────┘
                           │  ★ THE REAL COST LIVES HERE
  ┌─ Provider boundary ────▼────────────────────────┐
  │ Anthropic call: ~3-10s · MCP call: ~1 req/s     │
  │ → wall-clock + tokens + $$ dominate everything   │
  └─────────────────────────────────────────────────┘
```

The DSA "cost" in this repo is not CPU. It's tokens,
wall-clock, and rate-limited round-trips. A `Map`
swapped for an `Array.find` would not move the needle
— a missed `cache.get` that triggers another 3-second
Claude call would. **Pick the cost model that names
the dominant term.**

## Structure pass — the four axes that matter here

Three layers (UI / Service / Provider), one question
held constant: *"what does one unit of work cost?"*

```
  One question, three altitudes, three different answers
  ──────────────────────────────────────────────────────

  "what does one unit cost?"

  ┌─ UI render ─────────────────┐  → microseconds (negligible)
  └─────────────────────────────┘    unit = one DOM commit

  ┌─ Service ops ───────────────┐  → microseconds (negligible)
  └─────────────────────────────┘    unit = one Map.get / Array.sort

  ┌─ Provider round-trip ───────┐  → SECONDS + tokens + $$
  └─────────────────────────────┘    unit = one Claude call,
                                            one MCP tool call
```

The seam where the answer flips: the boundary between
service and provider. That's the only altitude where
you have to think about cost. The axes that matter
*at that seam* are:

- **time**     — wall-clock, not CPU cycles
- **money**    — tokens × per-token rate
- **rate**     — 1 req/s ceiling per Bloomreach user
- **memory**   — schema summary capped at top-20 events

Hand off to How it works with the skeleton named:
analyse the *seam*, not the layer.

## How it works

#### Move 1 — the mental model

You already do this when you read `useState` complexity
notes: "this hook is O(1) per call, the array of
listeners is O(N)." Same primitive here, just
generalised. The question is always *"what grows when
the input grows?"* and the answer is always a *family*
of functions — constant, linear, log-linear, etc. —
not a single number.

```
  Big-O — the growth families you'll meet here
  ────────────────────────────────────────────

  cost
   ▲
   │             N²       ← never reached in this repo
   │           ╱
   │         ╱           N log N  ← sort top-10 by severity
   │       ╱        ╱
   │     ╱     ╱
   │   ╱  ╱            N      ← linear scans (filter, map)
   │  ╱╱           ─────────
   │ ╱        ─────              log N  ← (not reached here)
   │╱   ─────                    1     ← Map.get, Set.has
   └────────────────────────────► input size N
```

The lesson: don't memorise the curves. Memorise the
**operations that produce each curve** — and what
each one buys you.

#### Move 2 — the operations and what they cost

Walk the operations one at a time, naming the cost
and where it lives in this repo.

**O(1) — single-step lookups**

The cheapest operation in the language. You hand the
data structure a key, it returns the value in one
hop, regardless of how many entries are stored. This
is the *whole point* of hash maps.

```
  O(1) — hash → bucket → value
  ────────────────────────────

  key "abc" ──hash──► bucket 7  ──► value
                       │
                       └── time to find the bucket
                           does not depend on N

  N entries in the map · still one hop per lookup
```

Where this lives in this repo:

```ts
// lib/state/insights.ts:73-75
export function getInsight(sessionId: string, id: string): Insight | null {
  return state.get(sessionId)?.insights.get(id) ?? null;
  //          ▲                       ▲
  //          │                       └── O(1) hop inside the session sub-map
  //          └── O(1) hop on the outer session map
}
```

Two `Map.get` calls, both O(1). It does not matter
whether there are 5 sessions or 500: the cost is
constant. **The break case:** if you replaced the
outer `Map<string, SessionFeed>` with
`Array.find(s => s.id === sessionId)`, every
read becomes O(N) in active sessions. On a warm
Vercel instance serving many users, that's a real
regression.

**O(N) — linear scans**

The next family up. Walk every element once. In this
repo, N is almost always tiny (≤ 30 events, ≤ 10
insights, ≤ 4 funnel stages), so O(N) reads as "free"
— but the *shape* still teaches you when it isn't.

```
  O(N) — one pass over the input
  ──────────────────────────────

  for each element:           N elements
    do constant work          ├── 1 hop
                              ├── 1 hop
                              ├── 1 hop
                              ▼  ...
                              └── total: N × constant
```

Where this lives in this repo:

```ts
// lib/mcp/tool-coverage.ts:39-41
const server = new Set(serverToolNames);
const absent = (list: readonly string[]) =>
  list.filter((n) => !server.has(n));
//                    ▲
//   one pass: O(L) where L = length of `list`
//   each `server.has(n)` is O(1), so total = O(L), not O(L × S)
```

The pattern that pops: a `Set` built up-front so the
inner check is O(1). Without the `Set`, every
`list.includes(n)` is itself a linear scan — making
the whole thing O(L × S). **Naming this gives you the
single most common DSA optimization in working code:
"hoist the lookup into a Set/Map."**

**O(N log N) — comparator-based sort**

JavaScript's `Array.prototype.sort` is implemented as
TimSort under the hood (V8). The cost is O(N log N)
comparisons. In this repo it's reached for exactly
once on the hot path:

```ts
// lib/agents/monitoring-legacy.ts:136
return [...parsed]
  .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])
  .slice(0, 10);
//   ▲                              ▲
//   │                              └── O(1) once sorted
//   └── O(N log N) — N = number of anomalies the LLM returned
//                    (typically 10-30; cost is invisible)
```

Verdict-first: this is not the right algorithm for
the *general* "top-K" problem. The classical answer
is a min-heap of size K, O(N log K). For N ≤ 30 and
K = 10, the constant factors of sort+slice win — and
the code reads in one line. That's the tradeoff this
codebase deliberately took. (Walked again in
`03-stacks-queues-deques-and-heaps.md` under the heap
discussion.)

**Amortized — the cost averaged over many calls**

A `Map.set` is *usually* O(1) but occasionally pays
to resize the underlying hash table — O(N) for one
unlucky call. Averaged over many calls, it's still
O(1). That averaging is called *amortized analysis*.

You don't write this analysis yourself in this repo;
you *consume* it. When the docs say `Map.set` is
amortized O(1), they mean: don't budget for the worst
single call, budget for the average. Same logic
applies to `Array.push` (the underlying array
occasionally re-allocates).

**The real cost — wall-clock + tokens**

```ts
// lib/data-source/bloomreach-data-source.ts:122
private cache = new Map<string, { result: unknown; expiresAt: number }>();
// ...:144
const cacheKey = `${name}:${JSON.stringify(args)}`;
// ...:148-151
const cached = this.cache.get(cacheKey);
if (cached && cached.expiresAt > Date.now()) {
  return { result: cached.result as T, durationMs: 0, fromCache: true };
}
//                          ▲
//   O(1) Map.get saves a ~1-second MCP round-trip and a token cost
//   downstream — THIS is where the cost model pays off
```

The whole reason for the `Map` cache is not Big-O —
it's avoiding a 1-second rate-limited round-trip and
the tokens that come with feeding the same data to
Claude twice. The cost model that matters here is
*time × money*, not CPU comparisons.

#### Move 3 — the principle

Big-O is the right tool when input size dominates
cost. When *network or model latency dominates*, the
right tool is wall-clock + tokens — and the DSA work
becomes "what data structure prevents an extra round-
trip." The two cost models compose; they don't
compete. Pick the one that names your dominant term,
then use the other to keep the code honest.

## Primary diagram

```
  The cost-model decision — name your dominant term
  ─────────────────────────────────────────────────

  ┌─ where does the cost ACTUALLY live? ──────┐
  │                                            │
  │  CPU-bound?  → Big-O is your tool          │
  │                 (sort, scan, hash)         │
  │                                            │
  │  Network/model-bound? → wall-clock + $$    │
  │                  (cache hits, batch sizes, │
  │                   token budget)            │
  │                                            │
  │  This repo: 99% network/model-bound.       │
  │  Big-O still applies, but the DOMINANT     │
  │  optimization is "avoid the extra call."   │
  └────────────────────────────────────────────┘
```

## Elaborate

The misuse to avoid: applying Big-O reasoning to
operations where N is bounded by something small and
constant. Sorting 10 anomalies is not "expensive"
even if you do it on every request — the *constant
factor* dwarfs the asymptotic class. The interview
move is to *name the N* and *bound it* before
declaring any operation a bottleneck.

The other side: when N is unbounded by user input
(an array of all customers, an array of all events
over 90 days), Big-O comes back hard. This codebase
never accumulates that scale in-process — it queries
through Bloomreach, which returns aggregates. But a
nearby production app *would* hit it, and that's the
cost-model lesson worth carrying.

For deeper grounding, read CLRS Chapters 2–4
(complexity, divide-and-conquer, amortized) and
Sedgewick's *Algorithms 4th Ed* §1.4 (analysis of
algorithms).

## Interview defense

**Q: What's the complexity of your monitoring agent's
top-K selection?**

```
  The top-K story — sort or heap?
  ───────────────────────────────

  sort + slice          heap of size K
  ────────────          ──────────────
  O(N log N)            O(N log K)
  ├── 1 line of code    ├── needs a PriorityQueue
  ├── stable, simple    ├── streaming-friendly
  ├── wins for N ≤ 30   └── wins for N >> K, or
  └── what we ship           streaming N where
                             you can't see it all
```

Model answer: "It's `sort(cmp).slice(0, 10)` —
O(N log N) where N is the LLM's anomaly output,
typically 10-30. The classical answer is a min-heap
of size K at O(N log K), but the constant factors of
TimSort dominate at that size and the one-liner is
honest about what it costs. If N grew to thousands or
became a stream, I'd switch to the heap." Anchor:
`lib/agents/monitoring-legacy.ts:136`.

**Q: Why is `Map<sessionId, SessionFeed>` correct and
not "premature optimization"?**

Model answer: "It's not optimization, it's
correctness. A warm Vercel instance serves many
concurrent users; a module-level `Map<insightId,
Insight>` would let session B's `putInsights` call
`.clear()` and wipe session A's feed mid-briefing.
The nested-Map shape gives me O(1) session lookup
*and* per-session isolation in one move. The
complexity argument is incidental; the isolation
argument is load-bearing." Anchor:
`lib/state/insights.ts:14-23`.

**Q: When does Big-O reasoning stop being the right
tool?**

Model answer: "When the dominant term isn't CPU.
This repo spends 99% of its wall-clock waiting on
Anthropic and Bloomreach. A `Map.get` that saves a
round-trip is worth a thousand `Array.find`-vs-
`Map.get` micro-wins. So Big-O still applies, but
it's the *secondary* model — wall-clock + tokens is
primary, and the data structure choice is judged by
'does this prevent another network hop?' more than
'is this O(1) vs O(N)?'" Anchor:
`lib/data-source/bloomreach-data-source.ts:122`.

## See also

- `02-arrays-strings-and-hash-maps.md` — the O(1)/
  O(N) workhorses
- `03-stacks-queues-deques-and-heaps.md` — the heap
  vs sort+slice argument worked end-to-end
- `06-sorting-searching-and-selection.md` — what
  the comparator costs you
- `08-dsa-foundations-practice-map.md` — where
  amortized comes back (rolling-array DP)

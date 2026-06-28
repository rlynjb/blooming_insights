# DSA foundations — overview

The reusable data-structures-and-algorithms vocabulary
behind this repo, ranked by what actually carries
weight in the running code.

## Zoom out — what shape of DSA repo is this?

```
  Blooming-insights, viewed through a DSA lens
  ─────────────────────────────────────────────

  ┌─ UI layer ─────────────────────────────────────┐
  │ React: lists (.map), funnel argmin reduce      │
  │   InsightCard.tsx · CoverageGrid.tsx           │
  └────────────────────────┬───────────────────────┘
                           │ NDJSON over fetch
  ┌─ Streaming kernel ─────▼───────────────────────┐
  │ split('\n') + pop() line-buffer                │
  │   lib/streaming/ndjson.ts                      │
  └────────────────────────┬───────────────────────┘
                           │
  ┌─ Service layer ────────▼───────────────────────┐
  │ Map<sessionId, SessionFeed> · Set capability   │
  │ gate · SEV_RANK sort+slice · Map<id, cache>    │
  │   lib/state/insights.ts · agents/categories.ts │
  │   agents/monitoring-legacy.ts (top-10)         │
  │   data-source/bloomreach-data-source.ts        │
  └────────────────────────┬───────────────────────┘
                           │
  ┌─ Provider boundary ────▼───────────────────────┐
  │ Anthropic (Claude) · Bloomreach MCP server      │
  └────────────────────────────────────────────────┘
```

Verdict, first: this is a **flat-array, hash-map,
linear-scan** codebase. Everything load-bearing is a
`Map`, a `Set`, an `Array.prototype.sort` with a
comparator, or a `for`/`reduce` over a single-digit-
length array. There are no trees, no graphs, no
priority queues, no dynamic programming, no binary
search. That's not a gap to apologise for — it's the
honest shape of an LLM-orchestration app where the
heavy lifting lives in network round-trips and prompt
tokens, not in CPU-bound algorithms.

That framing matters because it sets which concepts
are *exercised* (and therefore taught against your
code) and which are *missing* (and therefore taught
as foundations to deliberately practice).

## Ranked findings — the DSA primitives in this repo

```
  what's exercised        ★ rating   load-bearing example
  ─────────────────       ────────   ─────────────────────────────────
  hash maps (Map, Set)    ★★★★★      session-keyed insights, capability
                                      gate, response cache (60s TTL)
  arrays + linear scans   ★★★★★      filter/map over tool name lists,
                                      coverage cross-check, funnel
  strings + buffers       ★★★★       NDJSON split('\n') + TextDecoder;
                                      AES-256-GCM Buffer concat
  comparator-based sort   ★★★        SEV_RANK sort + slice top-10;
                                      events sorted by eventCount
  argmin reduce           ★★★        funnel.reduce(min by .v) for leak
                                      stage in InsightCard
  recursion (one level)   ★          encode/decode helpers; no deep
                                      recursion anywhere
```

```
  what's not exercised    why it doesn't show up here
  ─────────────────       ─────────────────────────────────
  trees / tries           no hierarchical data; agent output is flat
  graphs / BFS / DFS      no dependency graph in the running code
  priority queues         no scheduler; severity is one sort + slice
  binary search           every lookup is hash-keyed or short scan
  dynamic programming     no overlapping subproblems anywhere
  backtracking            agent search is delegated to the LLM
  union-find / segment    no clustering or range-query workload
```

The shape that pops: every "rank the top N" moment in
this repo is solved by `[...arr].sort(cmp).slice(0,
N)`. Every "what fired already" check is solved by a
`Set.has(...)`. Every "look this up by id" is solved
by a `Map.get(...)`. The DSA budget is consciously
small.

## Reading order

```
  start here ─►  01-complexity-and-cost-models
                 (the language you'll use to reason
                  about everything below)
                              │
                              ▼
                 02-arrays-strings-and-hash-maps
                 (★★★★★ — the workhorse of this repo)
                              │
                              ▼
                 03-stacks-queues-deques-and-heaps
                 (sort+slice is your current heap;
                  real heap is Case B — taught from
                  fundamentals, anchored to reincodes)
                              │
                              ▼
                 04-trees-tries-and-balanced-indexes
                 (Case B — none here; anchor to your
                  BST/Tree implementations in reincodes)
                              │
                              ▼
                 05-graphs-and-traversals
                 (Case B — anchor to your Graph.ts,
                  Graph2.ts, BFS over state space)
                              │
                              ▼
                 06-sorting-searching-and-selection
                 (sort exercised, binary search Case B)
                              │
                              ▼
                 07-recursion-backtracking-and-dynamic-
                    programming
                 (Case B — repo doesn't go deep here)
                              │
                              ▼
                 08-dsa-foundations-practice-map
                 (the deliberate-practice plan that
                  closes the gap between this repo's
                  scope and the interview surface)
```

## On "not yet exercised"

When a concept file is marked Case B (not exercised
in this repo), the file teaches the primitive from
fundamentals and — where you've already built it in
the `reincodes` repo (your DSA portfolio) — anchors
to that code. That's the honest split. The
blooming_insights code teaches what it teaches; the
reincodes implementations teach what blooming doesn't
need to reach for. Combined, they cover the
interview surface.

## See also

- `01-complexity-and-cost-models.md`
- `02-arrays-strings-and-hash-maps.md`
- `03-stacks-queues-deques-and-heaps.md`
- `04-trees-tries-and-balanced-indexes.md`
- `05-graphs-and-traversals.md`
- `06-sorting-searching-and-selection.md`
- `07-recursion-backtracking-and-dynamic-programming.md`
- `08-dsa-foundations-practice-map.md`

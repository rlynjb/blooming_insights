# Overview — DSA Foundations in `blooming_insights`

The one-page map. If you read only one file in this folder, read this one.

## What this repo actually exercises

This is a flat Map+Set codebase. The data-structure work is shallow on purpose — Bloomreach is the storage, the agents are the compute, and everything in memory is a session-scoped index or a stream buffer. The reusable structures that show up:

```
  the DSA surface of blooming_insights

  ┌─ data structures ──────────────────────────────────────────────┐
  │                                                                 │
  │   hash map      lib/state/insights.ts:14                        │
  │   (Map)         lib/state/investigations.ts:11                  │
  │                 lib/agents/aptkit-adapters.ts:101                │
  │                 lib/data-source/bloomreach-data-source.ts:122    │
  │                 lib/mcp/auth.ts:36                               │
  │                                                                 │
  │   set           lib/agents/categories-legacy.ts:120              │
  │   (Set)         lib/agents/tool-schemas.ts:13                    │
  │                 lib/mcp/tool-coverage.ts:40                      │
  │                                                                 │
  │   array +       schema.events, anomaly[], evidence[], steps[]   │
  │   linear scan   all over lib/agents/ and lib/insights/          │
  │                                                                 │
  │   string +      lib/streaming/ndjson.ts:30 (split('\n') buffer) │
  │   buffer        lib/mcp/auth.ts:65    (Buffer.concat for AES)   │
  │                                                                 │
  └─────────────────────────────────────────────────────────────────┘

  ┌─ algorithms ───────────────────────────────────────────────────┐
  │                                                                 │
  │   comparator sort  lib/agents/monitoring-legacy.ts:136          │
  │                    (rank by severity, top 10)                   │
  │                                                                 │
  │   argmin reduce    components/feed/InsightCard.tsx:160          │
  │                    (funnel-stage leak: smallest v)              │
  │                                                                 │
  │   linear filter    everywhere — categories, tool-schemas,       │
  │                    evidence pulls, hypothesis tested counts     │
  │                                                                 │
  │   recursion        lib/agents/base-legacy.ts:114 — ONE level    │
  │                    (the tool-use loop; flat `for`, not a tree)  │
  │                                                                 │
  └─────────────────────────────────────────────────────────────────┘
```

That's the whole DSA surface. No trees walked, no graphs traversed, no priority queue, no binary search, no DP, no backtracking. The list of *not yet exercised* primitives is long — see the per-file `not yet exercised` notes and the practice map at the end.

## The verdict

The structures are the right shape for what the code does. Hash-map indirection is the load-bearing primitive — the session map (`state`) keeps two warm Vercel users from clobbering each other's feed (`lib/state/insights.ts:14`); the response cache (`this.cache`) absorbs repeat tool calls under the 1 req/s rate limit (`lib/data-source/bloomreach-data-source.ts:122`); the active-tool-calls queue (`activeToolCalls`) lines `tool_call_start` up with its `tool_call_end` partner when both fire from the AptKit trace sink (`lib/agents/aptkit-adapters.ts:101`).

Where the code reaches for *less* than it could: the monitoring agent re-ranks the anomaly list every time with a comparator sort then takes the top 10 (`lib/agents/monitoring-legacy.ts:136`). With ten anomalies and four severity buckets, a bucket sort or a fixed top-K heap is overkill — the comparator is the right cost. **The honest take is: this repo is comfortable in O(n) over small n, and that's correct.** The DSA gap isn't in the repo's code, it's in the foundations the repo never had to reach for. That's what this guide ranks at the end.

## How to read this folder

Reading order — each file uses the full `format.md` template (Zoom out → Structure pass → How it works → Primary diagram → Elaborate → Interview defense → See also):

```
  01-complexity-and-cost-models.md            ← cost vocabulary first
  02-arrays-strings-and-hash-maps.md          ← the everyday primitives
  03-stacks-queues-deques-and-heaps.md        ← ordering disciplines
  04-trees-tries-and-balanced-indexes.md      ← mostly NOT yet exercised
  05-graphs-and-traversals.md                 ← NOT yet exercised
  06-sorting-searching-and-selection.md       ← one comparator sort + the gap
  07-recursion-backtracking-and-dynamic-programming.md  ← one-level loop only
  08-dsa-foundations-practice-map.md          ← ranked learning plan
```

Files 04, 05, and most of 07 teach foundations the repo does not currently exercise — they exist because the next AI-engineering interview will ask you to draw BFS on a whiteboard whether or not your shipped code uses it. The practice map (08) ranks where to spend hours.

## See also

- `.aipe/study-system-design/00-overview.md` — the architectural shape these structures sit inside (sessions, routes, agent loop). Cross-link when a file needs the bigger box.

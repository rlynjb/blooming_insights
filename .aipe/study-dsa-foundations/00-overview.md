# DSA Foundations — overview

Industry names: data structures & algorithms, computational thinking. Type: Language-agnostic.

## Zoom out — where DSA lives in this repo

Blooming Insights is an agentic e-commerce anomaly detector: a Next.js edge layer talks to Claude (agent loop), Claude talks to Bloomreach through an MCP transport, and evals verify the whole thing offline. Most of the "algorithm" work here is boring on purpose — the *interesting* algorithms live in the agent, not the plumbing. But the plumbing has picked up more DSA over the last three weeks: a running-accumulator budget tracker, a worker-pool load harness, a seedable PRNG for fault injection, and percentile stats on receipts.

```
  Where reusable DSA shows up in the codebase

  ┌─ UI layer ───────────────────────────────────────┐
  │  React feed  ·  (no algorithms — pure display)   │
  └────────────────────┬─────────────────────────────┘
                       │  fetch NDJSON
  ┌─ Service layer ────▼─────────────────────────────┐
  │  Agent loop  ·  BudgetTracker (running accum)    │  ← DSA lives here
  │  filterToolSchemas (Set membership)              │
  │  monitoring sort-slice(10) (top-K by comparator) │
  └────────────────────┬─────────────────────────────┘
                       │  MCP callTool
  ┌─ Transport layer ──▼─────────────────────────────┐
  │  BloomreachDataSource: cache Map + rate ladder   │  ← DSA lives here
  │  FaultInjectingDataSource: xorshift32 + weighted │
  │    probabilistic selection                       │
  └────────────────────┬─────────────────────────────┘
                       │  HTTP MCP
  ┌─ External ─────────▼─────────────────────────────┐
  │  Bloomreach MCP · Anthropic API                  │
  └──────────────────────────────────────────────────┘

  ┌─ Offline test/eval layer (parallel to service) ──┐
  │  percentiles() (sort + index)                    │  ← DSA lives here
  │  load.eval worker pool (index queue + K workers) │
  │  Set-based runId dedup                           │
  └──────────────────────────────────────────────────┘
```

## Zoom in — what this guide covers

Eight concept files. Each starts from a real file in this repo and teaches the transferable vocabulary around it. Where the repo doesn't exercise a foundation — trees, graphs, heaps, DP, binary search — the file says `not yet exercised` plainly and teaches the primitive anyway, because it will show up in an interview even if it never shows up in this codebase.

## Ranked findings — what actually matters here

1. **Percentile-by-sort (`percentiles()`) lives in two places.** `eval/report.eval.ts:161` and `eval/load.eval.ts:326` implement byte-identical `sort + index` percentile helpers. That's a duplication smell and also the repo's clearest example of a classic O(n log n) tradeoff — cheap to write, wrong at high N (streaming quantiles like t-digest would win). See `06-sorting-searching-and-selection.md`.

2. **Worker pool beats naive `Promise.all` at `eval/load.eval.ts:171-211`.** Index-queue + K workers is the load harness's concurrency primitive. Uses `shift()` (O(n) at high N — flag it) and depends on the JS single-threaded event loop for atomicity. See `03-stacks-queues-deques-and-heaps.md`.

3. **xorshift32 PRNG for reproducible faults at `lib/data-source/fault-injecting.ts:157-166`.** A three-line register PRNG plus a weighted-probabilistic accumulator (`acc += r.timeout; if (roll < acc)`) at `lib/data-source/fault-injecting.ts:84-100`. This is the repo's most compact DSA — worth reading twice. See `02-arrays-strings-and-hash-maps.md` (accumulator pattern) and `01-complexity-and-cost-models.md` (PRNG cost model).

4. **Running-accumulator threshold in `BudgetTracker.add()` at `lib/agents/budget.ts:51-55`.** O(1) per turn, streaming over the agent loop. The single most important cost primitive in the repo — every model turn touches it. See `01-complexity-and-cost-models.md`.

5. **Session-scoped `Map<string, ...>` in `lib/state/insights.ts:14`.** Nested Maps keyed by sessionId. Teaches why `Map` over plain object for user-controlled keys (prototype safety, iteration, size). See `02-arrays-strings-and-hash-maps.md`.

6. **Bounded degenerate-tree walk in `formatError()` at `lib/mcp/transport.ts:82-97`.** Walks the `error.cause` chain — a tree where every node has degree 1, capped at depth 5. The repo's only recursion-shaped traversal (though written iteratively). See `04-trees-tries-and-balanced-indexes.md` and `07-recursion-backtracking-and-dynamic-programming.md`.

## Reading order

Follow the numeric order:

1. `01-complexity-and-cost-models.md` — the vocabulary everything else needs (O-notation, amortized, streaming vs batch).
2. `02-arrays-strings-and-hash-maps.md` — the heavy chapter for this repo. Almost every service-layer file uses `Map` or `Set`.
3. `03-stacks-queues-deques-and-heaps.md` — one live queue (load harness), zero heaps (teach where a heap would win).
4. `04-trees-tries-and-balanced-indexes.md` — mostly `not yet exercised`. One thin exception in `formatError()`.
5. `05-graphs-and-traversals.md` — `not yet exercised`. Teaches the BFS/DFS kernel and names where a graph might land later.
6. `06-sorting-searching-and-selection.md` — comparator sorts + percentile pattern + honest binary-search gap.
7. `07-recursion-backtracking-and-dynamic-programming.md` — mostly `not yet exercised`. The iterative cause-chain walk is the one anchor.
8. `08-dsa-foundations-practice-map.md` — the ranked drill plan; what to practice for interviews, tied to what this codebase would benefit from next.

## Not yet exercised (be honest)

The repo does not currently exercise:

- **Trees** — no B-tree, no AVL, no red-black. The error-cause chain is the closest thing, and it's a degenerate list.
- **Tries** — tool-schema lookups are `Set` membership + linear filter. A trie would be premature.
- **Balanced indexes** — no ordered map, no interval tree, no BTreeMap. Percentiles resort every time instead.
- **Graphs** — no adjacency list, no BFS, no DFS, no shortest-path. `category.requires` at `lib/agents/categories.ts:32` is structurally a DAG but treated as a flat array filter.
- **Heaps / priority queues** — `monitoring-legacy.ts:136` does `sort + slice(10)` where a heap would be O(n log k) instead of O(n log n). Fine at n=50; wrong at n=50_000.
- **Dynamic programming** — no memoization, no tabulation. The nearest thing is `BudgetTracker`'s running total (an accumulator, not DP).
- **Binary search / quickselect** — every "find the p95" resorts the array; every "does this tool exist" is a `Set.has`. No binary search in the repo.
- **Backtracking** — no state-space search. The agent loop is state-machine-ish but not a backtrack.

Each of these gets a `not yet exercised` block in the relevant chapter that teaches the primitive anyway.

## Cross-links to sibling guides

- Architecture, scale, and where a data structure *would* need to land later — see `.aipe/study-system-design/`.
- Big-O impact on real request latency and the p95 story — see `.aipe/study-performance-engineering/`.
- Agent loop, ReAct, tool selection — the "algorithm" of Claude — see `.aipe/study-agent-architecture/`.
- What's tested and what's a coverage gap — see `.aipe/study-testing/`.

The rest of this guide sticks to reusable primitives: arrays, maps, sorts, PRNGs, and the shapes you'll get asked to whiteboard.

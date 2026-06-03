# Chapter 04 — DSA

DSA-shaped refactors are the algorithm and data-structure moves: replacing a linear scan with a hash lookup, switching a queue for a priority queue, picking the right tree, sequencing a traversal. The catalog calls these out because they're the highest-leverage type of refactor when they apply — a single Map-instead-of-Array can turn an O(n²) load failure into an O(n) one and ship a 100x improvement in one diff.

In this codebase they almost never apply. The chapter is short, honest, and the takeaway is itself the lesson: **not every codebase has DSA-shaped issues, and pretending otherwise is the failure mode the catalog warns about.**

## Map of the territory

- **BRIEF — Map keyed by composite string (`McpClient.cache`).** The one DSA-shaped choice in the codebase. It's the right choice; no refactor needed; named here because the alternative shape would matter.
- **MENTION** — The `truncate` function at `lib/agents/base.ts:31-34` is O(n) string concat at the boundary (16k char ceiling). Fine. Would matter if the ceiling moved by an order of magnitude.
- **MENTION** — The `filterByStep` function at `app/api/agent/route.ts:66-84` is O(n) over the event list per replay. Fine at ~100-200 events per investigation. Would matter at 10k+.
- **NOT FOUND** — Graph traversal. No graph. The agent loop is sequential, not a graph traversal.
- **NOT FOUND** — Priority queue. No queueing problem. The 1-req/s spacing gate is a `setTimeout`, not a queue with depth.
- **NOT FOUND** — Tree / hierarchical structure. No tree. Even the AgentEvent discriminated union is flat.
- **NOT FOUND** — Dynamic programming. No DP-shaped problem. The agent loop is not an optimization over overlapping subproblems.
- **NOT FOUND** — Union-find, segment tree, suffix array, trie, heap. None of these fit any problem the codebase actually solves.
- **NOT FOUND** — Sorting. Two sort calls in the codebase, both `.sort()` on small arrays. The right choice; not worth a refactor.

---

### Map keyed by composite string — McpClient.cache (BRIEF)

**Where it shows up.** `lib/mcp/client.ts:80`:

```
private cache = new Map<string, { result: unknown; expiresAt: number }>();
```

Keyed at `:102`: `const cacheKey = `${name}:${JSON.stringify(args)}``. The lookup is O(1) average (JavaScript Map is a hash table). The cardinality is bounded by `unique (toolName, argsJson) pairs` per investigation — empirically ~10-15 pairs per investigation, max ~30 across the run of the warm instance. Cache hits bypass both spacing and network and return `durationMs: 0, fromCache: true`.

**Take.** This is correct. The interesting question isn't "should this be a Map?" (obviously yes) but "is the key shape right?" Three alternatives worth naming briefly:

1. **Hash the key.** `cacheKey = sha1(`${name}:${JSON.stringify(args)}`)`. Smaller keys, faster comparisons. At ~30 entries the difference is unmeasurable; don't bother.
2. **Nested map by tool name first.** `Map<toolName, Map<argsJson, entry>>`. Cleaner introspection ("show all cache entries for `execute_analytics_eql`"). Not needed today; would matter if you wanted per-tool eviction policies. Don't preempt.
3. **LRU cache.** Bounded size with eviction. The current map has no eviction except instance death; in a warm instance running many investigations across many users (which won't happen at current scale), the map grows unboundedly. The perf audit (`study-performance-engineering/audit.md` finding #5) names the same shape for `lib/state/investigations.ts:11`, where `investigations.set(id, events)` has no `.delete` — *that* one is the actual unbounded-growth risk (events are large, count grows with traffic). The `McpClient.cache` per-instance footprint is bounded by the 60s TTL — a stale entry sits in the map until it's looked up and noticed-expired, but the working set is small.

The deeper observation: this is the only DSA choice in the codebase that actually matters. Every other "data structure choice" is forced by the API shape (the `messages: MessageParam[]` in `runAgentLoop` is an array because the SDK expects an array; the `toolCalls: ToolCall[]` is an array because order matters and length is small). The Map at `McpClient.cache` is the one place the engineer chose a structure over an alternative — Map vs Object, composite-string key vs nested map — and they chose right.

**Verdict.** Don't change it. Add a one-line comment naming the cardinality assumption ("typical bound: ~30 entries per warm instance; never empirically observed >50") so the next contributor doesn't speculatively add LRU eviction prematurely. The `investigations` map's unbounded growth is a real concern (covered in Chapter 02 under Effect Isolation and in the perf audit); this Map's apparent unbounded growth is bounded by the TTL.

---

## What this codebase doesn't exercise — and why

This is the chapter section that's worth more than the BRIEF + MENTIONs combined. The DSA portfolio in `me.md` is rich: Graph (BFS, DFS, Dijkstra, Eulerian, connected components), Binary Search Tree with all traversals, Binary Heap, Priority Queue with `updatePriority`, Tree generators, five sorting algorithms with animated visualizers, state-space search (river-crossing puzzle). **None of these patterns appear in blooming insights.** The honest reason:

- **The work is I/O-bound.** Per the perf audit (`study-performance-engineering/audit.md` section "cpu-memory-and-allocation"): single-digit seconds of CPU per investigation across ~100s of wall-clock — a ~100:1 wait-to-CPU ratio. There is no computation hot path. There is no traversal. There is no optimization problem. The dominant CPU work is `JSON.stringify` on tool results and a string truncation at 16k chars. Neither benefits from a clever data structure.

- **The agents don't navigate state spaces; they navigate text.** The DSA portfolio's `PG.ts` (river-crossing puzzle, BFS over implicit graph) is the closest analog — a search through a finite state space, terminating when goal is reached. The agent loop is shape-adjacent (turn → tool call → text → terminate when text-with-no-tool-use appears) but the search space is not finite, the goal is fuzzy (parseable JSON), and the "next state" generation is a model call, not a graph expansion. **The agent loop is not BFS.** Calling it BFS would be the catalog-pattern-matching failure mode this chapter is explicitly warning against.

- **The data shapes are flat.** `AgentEvent` is a tagged union, not a tree. `WorkspaceSchema` is a record with arrays of strings, not a graph. `Insight` and `Anomaly` are flat records with primitive-valued fields. `Diagnosis` has a `hypothesesConsidered` array but no recursion. **There is no nested structure that earns a tree traversal.**

The chapter could try to invent DSA-shaped refactors here. It would be wrong. The DSA portfolio's strength is the rich set of structures the engineer has built and understands; the right move when reading this codebase against that portfolio is **honest naming** — none of those structures fit this app's problem shape, and reaching for them speculatively would be the over-engineering failure mode.

The one place where the DSA portfolio could actually land: the eval harness from Chapter 02 will eventually want a regression set, and a regression set needs a way to detect "which previously-failing cases now pass and which previously-passing cases now fail." That's a set-difference problem (O(n)) over labeled run results. Trivially expressible as two Sets and a difference; doesn't warrant naming. **When the regression set crosses ~100 cases**, the engineer might want to score per-cause-class (precision/recall/F1 over a confusion matrix) — that's a 2D array indexed by (predicted, expected) class. Still not interesting from a DSA perspective; the structure is forced by the problem.

---

## Chapter close

This chapter is short because the honest verdict is short: **blooming insights has no DSA-shaped refactor opportunities worth the staff engineer's attention.** The codebase's complexity is structural (modules, boundaries, dependencies — Chapters 02 and 05) and behavioral (composition, recovery, patterns — Chapters 01 and 03). The DSA layer is a non-event because the workload doesn't reach for it.

What this tells you about the codebase, viewed from the DSA axis: **the engineer has chosen problems where I/O and integration are the hard parts, and the data-structure layer is held down to the minimum viable.** Some codebases earn their complexity from clever data structures (the engineer's own reincodes repo is exactly this); blooming insights earns its complexity from external-API mediation, prompt construction, and structured-output parsing. Different shape of work, different toolkit.

The discipline lesson this chapter carries forward: **the catalog's existence doesn't obligate the codebase to exercise it.** A refactor book that invented DSA opinions because the catalog has a DSA chapter would be the catalog teaching the codebase the wrong question. The chapter that's honest about "this category doesn't apply" is more valuable than the chapter that strains to find six BRIEF mentions to look complete.

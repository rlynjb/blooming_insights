# study-dsa-foundations — overview

The question this guide answers: **which reusable data structures and algorithms actually explain this repo — and which foundational ones don't show up here that you should still practice for interviews?**

The honest verdict up front: this is a *flat* Map+Set codebase. Almost every "data structure" in it is either a hash map, a hash set, an array, or a small linear scan. The heavy lifting sits inside the LLM, the MCP server, and the Anthropic API — not inside your own algorithms. That's the right shape for an agent app. It also means the DSA vocabulary you already have from `reincodes` (graphs, BFS/DFS, heaps, PriorityQueue, BSTs, sorts) mostly isn't reached for here — and that's worth naming, because it changes what to study for interviews vs what to walk in this repo.

## The DSA surface in one picture

Two bands: the primitives the repo actually exercises, and the ones it doesn't. Both get taught, both get anchored — the anchor for the second band is `reincodes`, not this repo.

```
  Blooming_insights DSA surface — what's here, what isn't

  ┌─ EXERCISED in blooming_insights ────────────────────────────┐
  │                                                              │
  │  hash map / hash set     lib/agents/tool-schemas.ts:13       │
  │                          eval/report.eval.ts:204             │
  │                          eval/gate.eval.ts:121               │
  │                                                              │
  │  arrays + linear scan    everywhere — filter, map, reduce    │
  │                                                              │
  │  running accumulator     lib/agents/budget.ts:51             │
  │  (streaming O(1))                                            │
  │                                                              │
  │  comparator sort +       lib/agents/monitoring-legacy.ts:136 │
  │  slice-K (top-K)         eval/report.eval.ts:169             │
  │                                                              │
  │  percentile via sort     eval/report.eval.ts:161             │
  │  (O(n log n) + O(1) idx)                                     │
  │                                                              │
  │  index-queue semaphore   eval/load.eval.ts:169-211           │
  │  (K workers + shared idx)                                    │
  │                                                              │
  │  xorshift32 PRNG         lib/data-source/fault-injecting.ts  │
  │                          :167-175                            │
  │                                                              │
  │  weighted probabilistic  lib/data-source/fault-injecting.ts  │
  │  selection (CDF walk)    :86-106                             │
  │                                                              │
  │  fallback / precedence   lib/mcp/connect.ts:42-46            │
  │  chain (?? cascade)      lib/mcp/config.ts (many)            │
  │                                                              │
  │  base64 round-trip       lib/mcp/config.ts:77-100            │
  │  (btoa/atob w/ Node fb)                                      │
  │                                                              │
  │  structural type-guard   lib/mcp/config.ts:50-60             │
  │  (O(field count))                                            │
  │                                                              │
  │  test-shim key-value     test/mcp/config.test.ts:127-149     │
  │  store (localStorage sim)                                    │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘

  ┌─ NOT YET EXERCISED — teach as Case B, anchor to reincodes ──┐
  │                                                              │
  │  trees / tries / balanced indexes                            │
  │  graphs / BFS / DFS / adjacency lists                        │
  │  heaps for real top-K (would win at monitoring-legacy:136)   │
  │  dynamic programming                                         │
  │  binary search on sorted arrays                              │
  │  backtracking / branch-and-bound                             │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
```

The top band is what this guide anchors to `file:line` here. The bottom band gets taught from first principles, then anchored to `reincodes` (`Graph.ts`, `BinaryHeap.ts`, `PriorityQueue.ts`, `BinarySearchTree.ts`, `PG.ts`) so the fundamentals aren't taught in a vacuum. That's the "Case B" pattern — teach the primitive, then point at where you've already built it.

## Top findings (verdict-first)

Read these before opening the concept files. The ranked practice map lives in `08-dsa-foundations-practice-map.md`.

  → **The biggest single win the repo *doesn't* take: replace the top-K sort with a min-heap of size 10.** `lib/agents/monitoring-legacy.ts:136` does `[...parsed].sort((a,b) => …).slice(0, 10)` — O(n log n) to get the 10 most severe anomalies out of an array that's currently always small (a handful of items from one LLM turn). It works. The moment that array grows — a future briefing that batches anomalies across sessions, or a diagnostic that pulls hundreds of candidates — the cost jumps and the fix is a size-10 min-heap: O(n log 10) = O(n). You've built the primitive already (`reincodes/BinaryHeap.ts`, `PriorityQueue.ts`). This is the classic "sort-and-slice today, heap tomorrow" tradeoff — the sort is fine while `n` is small; naming the swap is the interview-worth signal.

  → **The load-bearing DSA move in this repo is a running accumulator, not a data structure.** `lib/agents/budget.ts:51-55` — `BudgetTracker.add()` increments three integers, O(1) per model turn, streaming across the whole investigation. Zero allocation, zero copy, no revisit of past turns. `snapshot()` computes cost lazily from the accumulator. That's the shape the agent's per-investigation cost ceiling depends on: the moment you'd need to keep every turn's usage in an array is the moment the cost blows up. The idiom generalizes — Welford's online mean, reservoir sampling, HyperLogLog — all "collapse the stream into a fixed-size state" patterns.

  → **The percentile computation is the honest one for the scale.** `eval/report.eval.ts:161-179` sorts an array and picks indexed positions — O(n log n) time, O(n) space. That's the textbook "batch percentiles from a known array" approach. For 20-100 investigation receipts it's the right call — a t-digest or quantile sketch would be complexity theater at this scale. The moment the receipt count crosses tens of thousands (Datadog-scale metrics) the choice flips, and the honest interview answer is "for this size, sorting is fine; for streaming metrics I'd reach for a t-digest or Greenwald-Khanna."

  → **The concurrency primitive is a shared index queue with K workers — a hand-rolled semaphore.** `eval/load.eval.ts:169-211` — one array of indices, K workers each pulling `queue.shift()` in a while loop, `Promise.all(workers)` at the top. No `p-limit`, no `Bottleneck`. This is worth calling out because most people reach for a library the moment they need bounded concurrency; the shared-index pattern is small enough to own. The load-bearing part: the check is `while (queue.length > 0)` + `queue.shift()` — a worker that reads the length and *then* races another worker for the shift is fine here because JS is single-threaded within an event-loop turn; port this to a language with real threads and you'd need a mutex.

  → **`xorshift32` is 3 lines of bit-twiddling that make faults reproducible.** `lib/data-source/fault-injecting.ts:167-175`. `s ^= s << 13; s ^= s >>> 17; s ^= s << 5`. That's the whole PRNG. Seeded → deterministic → the same 9-fault / 3-investigation sequence replays on every eval run. This is the primitive behind reproducible chaos testing: an unseeded `Math.random()` would let one run pass and the next fail identically-configured. Worth knowing the family (LCG, xorshift, PCG) enough to say "xorshift32 is the smallest thing with a decent-enough period for a fault harness" in an interview.

  → **Weighted probabilistic selection uses a CDF walk over independent rates.** Same file `:86-106` — one `random()` roll, then walk `timeout | rateLimit | serverError | malformedJson` accumulating rates; the first bucket whose cumulative sum exceeds the roll wins. Higher-severity errors checked first so a heavy config yields disruptive faults preferentially. This is the same primitive behind weighted-choice sampling anywhere — every A/B bucketing, every content-recommendation weight roll, every rejection-sampling shape.

  → **The fallback chain is the working-code idiom.** `lib/mcp/connect.ts:42-46` — `override?.url ?? process.env.MCP_URL ?? process.env.BLOOMREACH_MCP_URL ?? 'https://loomi-…'`. Four sources of truth, one nullish-coalescing cascade, O(chain length) = O(4). It looks trivial. The signal is that the *order* encodes precedence: per-request override beats env beats legacy env beats hardcoded default. That's the same shape as any config-resolution chain — dotenv → env vars → CLI flags → defaults. Get the order right and everything downstream reads one variable.

  → **The base64 round-trip is a runtime-detection idiom, not a fancy DSA.** `lib/mcp/config.ts:77-100`. `typeof btoa === 'function' ? btoa(json) : Buffer.from(json).toString('base64')`. O(n) in string length. Ships one function to both browser (`btoa`/`atob`) and Node (`Buffer.from`) — the same detection pattern any isomorphic library uses. The DSA insight: base64 is a fixed 4:3 expansion — three input bytes become four ASCII characters. Nothing algorithmic; a table lookup encoded as a bit-shift. Worth knowing the size math ("~33% overhead") for interview questions about "why does that cookie feel so big?"

  → **The structural type-guard is O(field count) — a hash-map schema walk.** `lib/mcp/config.ts:50-60` — `isMcpConfigOverride` checks three fields against a `VALID_AUTH_TYPES = new Set([...])` for the enum member. O(3) time, one hash-set lookup for the enum. This is the working idiom for "TypeScript's `unknown` boundary meets runtime data" — the type-guard is the seam between "the compiler knows this shape" and "we just parsed JSON off the wire." The set-based enum membership check is the same primitive that shows up in every `allowedTools.has(name)` check across the agent codebase (`lib/agents/tool-schemas.ts:13`).

  → **The test-side localStorage shim is a hash-map with a DOM-shaped API.** `test/mcp/config.test.ts:127-149`. `Record<string, string>` with three methods (`getItem`, `setItem`, `removeItem`) — that's literally a JavaScript object masquerading as `Storage`. This is the Case-A use of a hash map: not just "look things up by key" but "conform to an interface the code under test expects, when the DOM version isn't available." Same shape as any in-memory cache stub, any test-time database fake. The DSA vocabulary: this is a *decorator* over a plain object, presenting the DOM Storage contract.

## What is `not yet exercised`

Named honestly so the concept files can teach these primitives without pretending they hide somewhere in the codebase.

  → **Trees / tries / balanced indexes.** No BST, no trie, no B-tree traversal in production code paths. React's virtual DOM and the module dependency graph exist, but they're framework internals, not code you own. Any hierarchical structure you'd think of (nested categories, agent conversation branches) collapses to flat arrays here. Would become relevant if you added an autocomplete over event property names (trie) or a persistent index over receipts (B-tree). Teach these from `reincodes/BinarySearchTree.ts` and `reincodes/Tree.ts`.

  → **Graphs / BFS / DFS / adjacency lists.** No graph traversal in this repo. The agent's "path through tool calls" is a linear list, not a graph — no cycles, no branching, no traversal decisions. If the future adds a dependency graph of investigation steps or a state-machine of tool preconditions, this becomes real. Teach from `reincodes/Graph.ts`, `Graph2.ts`, `PG.ts` (river-crossing) — you've built all four.

  → **Heaps for real top-K.** The one place a heap would win (`monitoring-legacy.ts:136`) currently doesn't — the array is small. But the concept is worth teaching against your own `BinaryHeap.ts` + `PriorityQueue.ts` so the swap is one file away when it matters.

  → **Dynamic programming.** No memoized recursion, no tabulation, no DP anywhere in the repo. This is a genuine curriculum gap in `reincodes` too — worth practicing outside this repo (LeetCode medium DP, longest-common-subsequence, coin change).

  → **Binary search.** No sorted-array lookup. Every array scan here is linear. Binary search shows up when data is (a) sorted and (b) large enough that O(log n) beats O(n). Neither holds in this repo. Practice against `reincodes` — you have the sorting primitives; the binary-search-over-sorted-array move is a natural extension.

  → **Backtracking / branch-and-bound.** No constraint-satisfaction problems in the codebase. The closest thing is the LLM's own reasoning, and that's inside the model. Practice as a standalone interview primitive (N-queens, Sudoku, subset-sum).

## Reading order

Start with `01-complexity-and-cost-models.md` — it gives you the vocabulary (`O(n)`, amortized, streaming vs batch) the other files lean on. Then `02-arrays-strings-and-hash-maps.md` because that's the primitive most heavily exercised in this repo, and where "hash-map as everything" gets its examples. `03-stacks-queues-deques-and-heaps.md` picks up the load-harness queue and the missed top-K opportunity. `04` and `05` (trees, graphs) are the honest Case-B files — teach from first principles, anchor to `reincodes`. `06-sorting-searching-and-selection.md` walks the percentile sort and the binary-search gap. `07-recursion-backtracking-and-dynamic-programming.md` is where the DP gap gets its practice map. End with `08-dsa-foundations-practice-map.md` — the ranked learning plan, exercised concepts first, missing foundations second.

## See also

  → `study-runtime-systems` — where the shared-index semaphore, event-loop cooperation, and Promise concurrency get their concurrency-model teaching. This guide covers the *data structure* (queue); that guide covers the *runtime model*.
  → `study-performance-engineering` — same primitives, different question ("what does this cost under load?" rather than "what's the shape?").
  → `study-networking` — the fallback chain in `lib/mcp/connect.ts` shows up there as an addressing story; here it's an O(k) precedence walk.
  → `study-testing` — the localStorage shim is a testing-seam story there; here it's a hash-map application.

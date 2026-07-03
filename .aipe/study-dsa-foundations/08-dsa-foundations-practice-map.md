# DSA foundations — the ranked practice map

*Learning plan · gap analysis · Project-specific*

## Zoom out, then zoom in

The other seven files walked the primitives — what the repo exercises, what it doesn't, and how each pattern actually works. This file ranks the practice: what to sharpen because the repo *does* use it (defensive practice), what to build because the repo *doesn't* use it but interviews do (offensive practice), and what to skip because it's beyond the scope of a working AI engineer's day-to-day. Verdict-first: three ranked bands, ordered by leverage.

```
  Zoom out — the practice map

  ┌─ BAND 1: EXERCISED HERE — sharpen the swaps ───────────────┐
  │                                                             │
  │  concepts the repo actually uses as load-bearing            │
  │  practice = "know when the current shape flips"             │
  │  time to defend: hours to days                              │
  └─────────────────────────────────────────────────────────────┘

  ┌─ BAND 2: NOT HERE BUT INTERVIEW-EXPECTED — build the gap ─┐
  │                                                             │
  │  concepts you built in reincodes but haven't reinforced     │
  │  + concepts you haven't built anywhere yet                  │
  │  practice = "implement from scratch, add to reincodes"      │
  │  time to close: 1-4 weeks per concept                       │
  └─────────────────────────────────────────────────────────────┘

  ┌─ BAND 3: DEFER — return only if job requires ──────────────┐
  │                                                             │
  │  competitive-programming DSA, advanced number theory,       │
  │  specialty data structures                                  │
  │  practice = "know the name, don't spend time"               │
  └─────────────────────────────────────────────────────────────┘
```

**Zoom in.** Ranking is by *marginal signal per hour*. Band 1 items give you the highest signal in the fastest interviews (senior engineers asking "why did you build it this way?"). Band 2 is where you close standardized-interview gaps. Band 3 is where you say "no" and protect your time.

## Structure pass

**Axis: what's the leverage of studying this?** Trace it down each item:
  - can you defend the design choice with an anchor from your codebase? → Band 1
  - can you implement the primitive on a whiteboard cold? → Band 2
  - is this something that only matters at competitive-programming scale? → Band 3

**Seams.** The line between Band 1 and Band 2 is *exercise in your codebase*. The line between Band 2 and Band 3 is *how often it shows up in senior interviews for the roles you're targeting* (AI engineer, senior frontend, product engineer). Band 3 items are IOI/ACM material — not senior-hire material.

## How it works

### Move 1 — the ranking as one picture

Each item earns its rank by *what breaks* if you don't have it — the same "load-bearing part" question the concept files ask about primitives.

```
  The practice ranking — one picture

  BAND 1: sharpen the swaps you already made
  ─────────────────────────────────────────
   1  the sort-and-slice vs heap top-K tradeoff       ★ highest leverage
   2  streaming vs batch cost models
   3  the shared-queue semaphore in JS event loop
   4  the CDF walk / weighted probabilistic selection
   5  set-based membership + type-guard as O(k) walk

  BAND 2: build the primitives you haven't yet
  ─────────────────────────────────────────────
   6  DP ladder (Fibonacci → LCS → edit distance → 0/1 knapsack)
   7  binary search variants (canonical, lower-bound, first-true)
   8  balanced BST — implement AVL rotations from scratch
   9  backtracking template (N-queens, subset sum, Sudoku)
  10  advanced graph algos (topo sort, SCC, Bellman-Ford)
  11  trie implementation + prefix-match / autocomplete
  12  union-find (disjoint-set) + Kruskal's MST

  BAND 3: defer unless the role demands it
  ──────────────────────────────────────────
  13  segment trees / Fenwick trees                    ★ competitive-only
  14  suffix arrays, Aho-Corasick, Manacher's
  15  min-cut / max-flow (Ford-Fulkerson, Edmonds-Karp)
  16  advanced DP (bitmask, digit, DP on subsets)
```

The ordering within each band matches "highest signal to close first" — item 1 in Band 1 is the shortest path to a strong senior-interview answer; item 6 in Band 2 is the biggest unlock for standardized DSA screens.

### Move 2 — Band 1: defend the swaps

These are the items where the repo *already* uses the primitive, and practice means being able to *defend the design choice* and *name the swap*. This is what senior engineers ask about — not "can you implement a heap?" but "you built this, tell me why."

#### 1. The sort-and-slice vs heap top-K tradeoff (highest leverage)

  **What to defend:** `monitoring-legacy.ts:136` does `.sort().slice(0, 10)` — O(n log n) — and it's the right call today because n is small. The swap to a size-K min-heap is O(n log K) — worth it when n crosses ~50-100.

  **Why it earns rank 1:** it's the single most common "why didn't you use the fancy data structure?" question in senior interviews, and you have a real answer grounded in your own code. Plus you built the PriorityQueue in `reincodes/PriorityQueue.ts` — the swap is one import away.

  **What to practice:** be able to sketch the size-K min-heap trace (the execution trace in file 03) from memory, name the crossover point (~50-100), and cite your reincodes implementation.

  **Done when:** you can defend the current shape *and* name the exact conditions that flip the tradeoff, in under 60 seconds.

  **Estimated effort:** 1-2 hours to internalize; you already have the primitive.

#### 2. Streaming vs batch cost models

  **What to defend:** the `budget.ts` accumulator is O(1) streaming because it lives on the hot path; `report.eval.ts` is O(n log n) batch because it runs end-of-run over a small array. Both are the right call *because of where they live*, not because of what they do.

  **Why it earns rank 2:** the "where does this run, and what's the cost model for that location?" framing is a staff-level thinking move. Being able to name the streaming-vs-batch flip fluently is what separates "I read Big-O" from "I chose Big-O deliberately."

  **What to practice:** be able to name the flip for any operation the interviewer proposes. Percentiles: batch here, sketch at 10⁵+. Sum: streaming everywhere. Median: quickselect single-shot, sort for many-shot, sketch for streaming.

  **Done when:** you never say "O(n log n) is fine" without qualifying "because n stays small in this context."

  **Estimated effort:** 2-3 hours of drilling with different operations.

#### 3. The shared-queue semaphore + JS event-loop atomicity

  **What to defend:** the `load.eval.ts:169-211` hand-rolled semaphore works without a mutex *because* of the event-loop model — the check-then-modify is atomic within a synchronous block. This is a real "I know the difference between the data structure and the runtime" signal.

  **Why it earns rank 3:** concurrency questions come up in every senior interview, and being able to say "this is safe here for reasons specific to the JS event loop, and here's what would change in Go or Rust" is a differentiator.

  **What to practice:** be able to translate the pattern to Go (channel + goroutines) and Rust (mpsc + tokio::spawn) at least conceptually.

  **Done when:** you can name three reasons the naive shared-queue pattern would break in a real-threaded language.

  **Estimated effort:** 3-4 hours.

#### 4. Weighted probabilistic selection (CDF walk)

  **What to defend:** the `fault-injecting.ts:86-106` pattern — accumulate probabilities in order, first bucket whose cumulative sum exceeds the roll wins. O(k) in the number of buckets. The ordering encodes severity (timeout before malformed).

  **Why it earns rank 4:** shows up in A/B testing systems, weighted-random-choice UIs, load balancers with weighted round-robin. Named primitive that transfers.

  **What to practice:** be able to write the pattern in 10 lines cold, and know the alternative (alias method — O(1) after O(k) preprocessing).

  **Done when:** you can name the alias method as the O(1) alternative and say why the naive CDF walk is fine here (k is 4, preprocessing beats runtime).

  **Estimated effort:** 2 hours.

#### 5. Set-based membership + type-guard as O(k) walk

  **What to defend:** `isMcpConfigOverride` (config.ts:50-60) walks a 3-field schema in O(3), with a set lookup for enum membership. This is the working idiom for the TypeScript `unknown` boundary.

  **Why it earns rank 5:** shows up in every "how do you validate input at a boundary?" question. Being able to name Zod / ajv / io-ts as the scaling answer, and hand-rolled as the small-schema answer, closes the discussion cleanly.

  **What to practice:** know the tradeoff between hand-rolled and library-based validation. Practice writing a type guard for a nested-object schema (2-3 levels deep).

  **Done when:** you can defend when to hand-roll and when to reach for Zod based on schema size + error-UX needs.

  **Estimated effort:** 2 hours.

### Move 2 — Band 2: build the primitives you haven't yet

These are the standardized-interview closers. You've done most of DSA in `reincodes` — what's missing is enough to notice.

#### 6. DP ladder (Fibonacci → LCS → edit distance → 0/1 knapsack) — biggest single gap

  **Why it earns rank 6:** DP is the single most common "medium+hard" LeetCode category and shows up in every senior interview loop. It's also the biggest genuine gap in your `reincodes` portfolio.

  **What to build:** four canonical problems, implemented top-down (memoized) and bottom-up (tabulated), checked into `reincodes`:
    - `Fibonacci.ts` — the "why do we memoize?" primer
    - `LCS.ts` (longest common subsequence) — 2D DP table, first "what does dp[i][j] mean?" moment
    - `EditDistance.ts` (Levenshtein) — three-way transition (insert / delete / replace)
    - `Knapsack01.ts` — bounded resources, include/exclude decision pattern

  **Done when:** you can write any of the four cold in 15 minutes, explain the recurrence to a whiteboard, and reduce space to O(n) (rolling row) for LCS/knapsack.

  **Estimated effort:** 3-4 weeks at one problem per week.

#### 7. Binary search variants (canonical, lower-bound, first-true)

  **Why it earns rank 7:** binary search is *the* off-by-one trap in interviews. The three canonical variants (find equal, find leftmost, find first-true-in-monotonic-predicate) are what senior interviewers use as a warmup.

  **What to build:** a `BinarySearch.ts` in `reincodes` with all three variants + tests. The first-true variant is the powerful one — most "find the smallest X such that predicate(X) is true" problems (Koko-eating-bananas, split-array-largest-sum) reduce to it.

  **Done when:** you can write all three variants cold with correct loop invariants and no off-by-one bugs.

  **Estimated effort:** 1 week.

#### 8. Balanced BST — implement AVL rotations from scratch

  **Why it earns rank 8:** you built the unbalanced BST — the missing piece is the rotation logic that keeps it balanced. AVL is stricter than red-black (and slightly harder to get right on delete), so implementing AVL well signals depth.

  **What to build:** `reincodes/AVLTree.ts` with `insert`, `delete`, `search`, and the four rotation cases (LL, LR, RL, RR). The load-bearing test: insert 1..10 in ascending order and confirm the tree height stays ≤ ⌈log₂(10)⌉ + 1 = 4.

  **Done when:** you can draw the four rotation cases from memory and explain why each restores the AVL invariant.

  **Estimated effort:** 2 weeks.

#### 9. Backtracking template (N-queens, subset sum, Sudoku)

  **Why it earns rank 9:** backtracking is a distinct problem family that DP doesn't cover — constraint-satisfaction and combinatorial-generation problems. Solid backtracking chops signal that you can handle "generate all X satisfying Y" cleanly.

  **What to build:** `reincodes/backtracking/` with three problems:
    - `NQueens.ts` — the canonical example
    - `SubsetSum.ts` — the "include vs exclude" pattern
    - `Sudoku.ts` — real-world constraint propagation

  **Done when:** you can write the backtracking template (try / recurse / undo) cold and adapt it to a new problem in under 20 minutes.

  **Estimated effort:** 2 weeks.

#### 10. Advanced graph algorithms (topo sort, SCC, Bellman-Ford)

  **Why it earns rank 10:** you have BFS, DFS, Dijkstra. What's missing is topological sort (Kahn's + DFS post-order), strongly-connected-components (Tarjan's or Kosaraju's), and Bellman-Ford for negative-edge shortest path.

  **What to build:** extensions to your existing `Graph.ts` / `Graph2.ts` — one new method per week.

  **Done when:** you can explain when each earns its keep — topo for build-system ordering, SCC for module-cycle detection in monorepos, Bellman-Ford for currency-arbitrage detection.

  **Estimated effort:** 3 weeks.

#### 11. Trie implementation + prefix-match / autocomplete

  **Why it earns rank 11:** the missing "prefix" primitive. Frontend engineers see this a lot (route matching, autocomplete UIs). Trie interviews are usually medium-easy — the pattern is straightforward once implemented once.

  **What to build:** `reincodes/Trie.ts` with `insert`, `search`, `startsWith`, and a `wordsWithPrefix(prefix)` method that returns all completions.

  **Done when:** you can write the trie cold in 20 minutes with tests, and explain the space tradeoff vs a sorted array + binary search.

  **Estimated effort:** 1 week.

#### 12. Union-find (disjoint-set) + Kruskal's MST

  **Why it earns rank 12:** union-find is the primitive behind Kruskal's MST, connected-component queries, cycle detection in undirected graphs, and dynamic-equivalence problems. Path compression + union-by-rank gets you nearly-O(1) amortized per operation (inverse Ackermann).

  **What to build:** `reincodes/UnionFind.ts` with path compression and union-by-rank, plus a `KruskalMST.ts` that uses it.

  **Done when:** you can explain why the amortized cost is nearly-constant and cite the O(α(n)) bound.

  **Estimated effort:** 1 week.

### Move 2 — Band 3: defer unless the role demands it

These items are legitimate DSA topics that mostly don't come up in senior software-engineer or AI-engineer interviews. Know they exist; don't invest until a specific job requires them.

  **13. Segment trees / Fenwick trees (BIT).** Range-sum + point-update in O(log n). Competitive-programming and specialty databases. Skip unless applying to systems/DB companies.

  **14. Suffix arrays, Aho-Corasick, Manacher's.** Advanced string algorithms — pattern matching, palindrome finding. Not senior-interview material for the roles you're targeting.

  **15. Min-cut / max-flow.** Beautiful algorithm (Ford-Fulkerson), rarely comes up in interviews outside operations-research or specialty-DB roles. Read the Wikipedia page; don't implement.

  **16. Advanced DP (bitmask, digit, DP on subsets).** Once you're solid on the four canonical DP problems in Band 2, more advanced DP is diminishing returns. Bitmask DP shows up occasionally (traveling salesman with n ≤ 20); the others are competitive-programming territory.

### Move 3 — the principle

**Practice by leverage per hour, not by topic completeness.** DSA curricula are exhaustive by design — they cover everything so you can pick. The interview-signal question is different: *what closes the biggest gap in the interview loops you're preparing for, per hour of practice?* For a senior frontend / AI engineer targeting product-engineering roles, Band 1's defensive practice (things you already built) has the highest signal — followed by Band 2's DP ladder. Band 3 is a trap; the marginal signal per hour is close to zero for your target roles.

## Primary diagram

The whole plan in one frame — three bands ranked by leverage, with rough effort estimates.

```
  Practice map — ranked by leverage per hour

  ┌─ BAND 1 · defend what's already here (highest signal) ────┐
  │                                                             │
  │   1  sort-vs-heap top-K       ★★★★★    ~2 hrs              │
  │   2  streaming vs batch       ★★★★★    ~3 hrs              │
  │   3  shared-queue semaphore   ★★★★     ~4 hrs              │
  │   4  weighted CDF walk        ★★★      ~2 hrs              │
  │   5  type-guard as O(k) walk  ★★★      ~2 hrs              │
  │                                                             │
  │   Band 1 total: ~13 hours                                  │
  └─────────────────────────────────────────────────────────────┘

  ┌─ BAND 2 · build the standardized-interview gap ────────────┐
  │                                                             │
  │   6  DP ladder                ★★★★★    ~4 weeks   ← biggest │
  │   7  binary search variants   ★★★★     ~1 week            │
  │   8  AVL rotations            ★★★      ~2 weeks           │
  │   9  backtracking template    ★★★      ~2 weeks           │
  │  10  advanced graphs          ★★★      ~3 weeks           │
  │  11  trie                     ★★       ~1 week            │
  │  12  union-find + Kruskal     ★★       ~1 week            │
  │                                                             │
  │   Band 2 total: ~14 weeks (at focused pace)                │
  └─────────────────────────────────────────────────────────────┘

  ┌─ BAND 3 · defer (know the name, skip the work) ────────────┐
  │                                                             │
  │  13-16: segment trees, suffix arrays, max-flow, bitmask DP │
  │                                                             │
  │  return only if a specific role requires them              │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

The "leverage per hour" framing comes from Cal Newport's "So Good They Can't Ignore You" and Andy Matuschak's memory-systems writing — the observation that intense focus on the *highest-marginal-return* studying beats broad coverage. For a working engineer, this means: things you already partially know get easier to defend fast; primitives you've never built take longer but close the biggest signal gaps.

The three-band structure mirrors the "spaced repetition + progressive overload" pattern from motor-skill research and language learning. Band 1 is retrieval practice on things you've done — spaced repetition maintains them. Band 2 is deliberate practice on novel skills — long-form projects that build competence. Band 3 is what you say no to so the first two get the attention they need.

For DSA specifically, the LeetCode "Blind 75" curriculum (or Neetcode's ordering) covers most of Band 2 — Fibonacci, LCS, edit distance, coin change, 0/1 knapsack, N-queens, all of the graph algorithms, union-find, trie. The curriculum overlap is intentional; if you close Band 2, you're covered for standardized DSA screens too.

Interview Kickstart's own DSA program (which you're partway through) tends to cover Band 1 and Band 2 material with the emphasis inverted — more time on trees / graphs / DP than on the "defend what you built" framing. Both are useful; the ranked map is the missing bridge from "I finished the curriculum" to "I can defend my choices in a system-design-heavy senior interview."

Related reading: "A Common-Sense Guide to Data Structures and Algorithms" (Wengrow) for a fast readable refresher on Band 1 material. "Algorithm Design Manual" (Skiena) for depth on Band 2 and how to reason about "which structure fits this problem?" The Skiena chapters on graph algorithms are the clearest introduction to items 10-12 I've seen.

## Interview defense

**Q: You've built a lot of DSA in reincodes but not DP. Why?**

Two reasons. First, DP didn't show up in the shape of the projects I chose — the frontend and system-shape work in dryrun, buffr, contrl, aipe, and AdvntrCue is heavy on graphs (for AdvntrCue's tool routing) and heaps (for the animations) but doesn't have overlapping-subproblem structure. Second, DP is the biggest signal gap I know about, and I've explicitly put it in Band 2 of my practice plan — the ladder is Fibonacci → LCS → edit distance → 0/1 knapsack, one problem per week, checked in to reincodes. I'm honest that I need to sharpen this to be strong on it in interviews; I'm also honest that the reason it's a gap is the projects didn't need it.

**Anchor:** "DP is the biggest gap; I've planned a four-week ladder to close it — Fibonacci, LCS, edit distance, 0/1 knapsack, top-down and bottom-up each."

**Q: You built the BST but not the AVL. Is that a red flag?**

Not for the roles I'm targeting. The unbalanced BST teaches the primitive (invariant, traversals, delete cases). The AVL adds the rotation logic that keeps the invariant under adversarial insert order. AVL is the correct next step, and it's on my Band 2 list at rank 8 — two-week focused study. If I were interviewing at a company where balanced-BST-from-scratch was table-stakes (specialty DB companies, kernel-scheduler teams), I'd close this first. For AI-engineer and senior-frontend roles, the unbalanced BST + heap I've built already covers what usually comes up.

**Anchor:** "Unbalanced BST + heap covers most senior interviews; AVL is a two-week focused study, and I know exactly what the four rotation cases are."

**Q: What's the highest-leverage thing you could practice this week?**

The sort-vs-heap top-K story from `monitoring-legacy.ts:136`. It's Band 1, item 1 in the ranked map — a real design choice I made, with a real anchor in the codebase, with a real swap named and the primitive already built in `reincodes/PriorityQueue.ts`. Being able to defend "sort here because n is small, heap when n crosses ~50-100" in 60 seconds with an execution-trace sketch is the strongest signal I can produce per hour of practice this week.

**Anchor:** "Top-K in monitoring-legacy — Band 1, one-hour practice, biggest defensive signal I can polish quickly."

**Q: Isn't skipping segment trees and max-flow just avoiding hard material?**

No — it's saying "no" so Band 1 and Band 2 get the attention they need. Segment trees are legitimate, but they show up in senior software-engineer interviews for AI/frontend/product roles maybe 1 in 100 loops. Max-flow shows up even less. Meanwhile, DP shows up in *every* senior loop, and I have a real gap there. The right move is to close the high-frequency gap first. If a specific role explicitly requires segment trees, I'll invest — until then, that's competitive-programming-adjacent territory and the ROI is worse than a fifth DP problem.

**Anchor:** "Time is finite; frequency of appearance in target loops is the ranking dimension. DP > segment tree by an order of magnitude."

## See also

  → `00-overview.md` — the repo-grounded map that this practice plan hangs off
  → `01-complexity-and-cost-models.md` — the vocabulary Band 1 items rest on
  → `03-stacks-queues-deques-and-heaps.md` — the specific top-K swap that's Band 1 item 1
  → `07-recursion-backtracking-and-dynamic-programming.md` — the DP ladder that dominates Band 2
  → `study-agent-architecture` — the system-level defense of design choices this practice plan feeds

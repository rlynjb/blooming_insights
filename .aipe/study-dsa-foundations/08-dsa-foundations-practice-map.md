# DSA foundations practice map

**Industry name(s):** learning roadmap, capability gap analysis, ranked study plan
**Type:** Project-specific

> A ranked plan for what to study next. The seven preceding chapters each ended with a verdict — *applies*, *partial*, or *not yet exercised*. This chapter ranks the gaps so you know where to spend your hours. Exercised primitives go first (so you can defend the repo); high-leverage missing primitives go second (so the next codebase has them too).

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** This is the practice map — the file you open when you've read the other seven and want to know "okay, what do I actually study tomorrow morning?" The map sits *after* the audit, *before* the implementation hours. It draws on two inputs: (a) the verdict for each category in chapters 01–07, and (b) the user's own portfolio outside this codebase (`reincodes/Graph.ts`, `BinaryHeap.ts`, `PriorityQueue.ts`, `BinarySearchTree.ts`, etc., per `me.md`) to avoid recommending what's already been built and rehearsed.

```
Zoom out — where the practice map sits

┌─ Chapters 01–07: audit ────────────────────────────────┐
│  per-category verdict (applies / partial / not yet)    │
│  + load-bearing repo example for each "applies"        │
│  + trigger description for each "not yet"              │
└────────────────────────────┬──────────────────────────┘
                             │
┌─ This chapter: practice map ▼─────────────────────────┐
│  ★ rank the gaps ★                                     │  ← we are here
│  by:                                                    │
│    - interview frequency                                │
│    - distance from already-built portfolio              │
│    - leverage at next career-pivot project              │
│                                                          │
│  output: a ranked list of "what to drill next"          │
└────────────────────────────┬──────────────────────────┘
                             │
┌─ Implementation hours ─────▼─────────────────────────┐
│  drill the top items                                  │
│  IK curriculum + your own portfolio extensions        │
└──────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: of the seven foundational categories, which ones should you spend the next 20-40 study hours on — and in what order? The answer comes from three lenses applied in sequence: **interview frequency** (heaps and binary search show up in 80% of senior interviews; tries show up in maybe 10%), **distance from your portfolio** (you've already built heaps and BSTs from scratch — drilling those is rehearsal, not building; you haven't built DP problems from scratch — drilling those is new ground), and **leverage at the next codebase** (the codebase after `blooming_insights` is more likely to need graph traversal than dynamic programming). The next sections produce a single ranked list with one-line justifications and then a per-week schedule.

---

## Structure pass

**Layers.** The practice map has a three-layer structure: the **audit layer** (chapter verdicts, repo evidence), the **prioritization layer** (interview frequency × portfolio gap × leverage), and the **plan layer** (ranked items, time estimates, success criteria). The audit is fixed by the codebase; the prioritization is calibrated to the reader (`me.md`); the plan is the actionable output.

**Axis: cost** — the same lens as Chapter 1, but applied to *learning hours* instead of CPU cycles. Each gap costs some hours to close (varying by current familiarity), and each closes some value (interview leverage + codebase readiness). The ranked list maximizes value per hour spent.

**Seams.** Two seams matter; both load-bearing in the *plan*. **Seam 1: exercised vs not-yet-exercised.** Exercised primitives need *defense rehearsal* (you can already build them; you need to articulate the design choices). Not-yet-exercised primitives need *fresh learning* (build the kernel from scratch, walk an interview-style problem). **Seam 2: in-portfolio vs out-of-portfolio.** Things in your `reincodes/` portfolio (heaps, BSTs, graphs, sort) need rehearsal only; things outside it (DP, tries, segment trees) need building.

```
Structure pass — the practice map

┌─ 1. LAYERS ─────────────────────────────────────────┐
│  Audit (per-category verdict) · Prioritization      │
│  (frequency × gap × leverage) · Plan (ranked items, │
│  hours, criteria)                                    │
└────────────────────────┬─────────────────────────────┘
                         │  pick the axis
┌─ 2. AXIS ─────────────▼──────────────────────────────┐
│  cost: learning hours per closed gap, weighted by   │
│  interview/career value                              │
└────────────────────────┬─────────────────────────────┘
                         │  trace across layers, find flips
┌─ 3. SEAMS ────────────▼──────────────────────────────┐
│  S1: exercised (rehearse) vs not-yet (build)        │
│  S2: in-portfolio (rehearse) vs out (build)         │
└────────────────────────┬─────────────────────────────┘
                         ▼
                 Block 4 — How it works
```

The skeleton is mapped — the rest of this file produces the ranked plan.

---

## How it works

### Mental model — three lenses, one ranking

Each gap gets scored on three dimensions; the ranking is the weighted sum.

```
                  RANKING FORMULA

  score = interview_frequency  (1-5)
        × portfolio_gap         (1-5: 1 = already built, 5 = never seen)
        × leverage              (1-5: 1 = niche, 5 = appears in next codebase)

  higher score = study sooner
```

Interview frequency captures "how often does this show up in senior interviews." Portfolio gap captures "how much new building, vs rehearsal, does this need." Leverage captures "how likely is this to be useful in the next pivot project." None of these is a hard number; they're calibration heuristics.

### Move 1 — the per-category audit summary

A one-line verdict for each of chapters 01–07, copied from each chapter's introduction:

```
chapter                                       verdict      portfolio status
─────────────────────────────────────────────────────────────────────────────
01 complexity-and-cost-models                 applies      mental model rehearsed
                                                            via IK curriculum
02 arrays-strings-and-hash-maps               applies      built in every project
03 stacks-queues-deques-and-heaps             partial      queues implicit;
                                                            HEAPS BUILT in
                                                            reincodes/BinaryHeap.ts
                                                            and PriorityQueue.ts
04 trees-tries-and-balanced-indexes           not yet      BST + Tree BUILT in
                                                            reincodes; TRIE not built
05 graphs-and-traversals                      not yet      Graph + Graph2 + BFS +
                                                            DFS + Dijkstra BUILT
                                                            in reincodes
06 sorting-searching-and-selection            partial      ALL 5 SORTS BUILT in
                                                            reincodes/Sorting;
                                                            binary search NOT built
07 recursion-backtracking-and-dynamic-prog.   not yet      RECURSION exercised in
                                                            reincodes (BST, sort);
                                                            BACKTRACKING via state-
                                                            space search in PG.ts;
                                                            DP NOT YET BUILT
```

The portfolio status column matters because it changes the work *type*: built-but-not-in-this-codebase is *rehearsal* (articulate the design choices, port to TypeScript if needed); never-built is *fresh learning* (start with the kernel, do interview problems).

### Move 2 — apply the three lenses

Now score each category. Interview frequency from common senior interview data (LeetCode tagging, Glassdoor questions, IK curriculum weight). Portfolio gap from the table above. Leverage from "what kind of codebase is likely next, given the AdvntrCue + dryrun + buffr + contrl + aipe portfolio shape."

```
category                                   freq  gap  lev   score   rank
                                           1-5   1-5  1-5   prod    (1=first)
─────────────────────────────────────────  ────  ───  ────  ─────   ────
01 complexity-and-cost-models               5    2    5      50      4
02 arrays-strings-and-hash-maps             5    1    5      25      6
03 heaps (the gap within ch 3)              4    2    4      32      5
03 deques (the other gap)                   2    4    2      16      —
04 BST / balanced (in portfolio)            3    2    3      18      —
04 tries (out of portfolio)                 3    5    3      45      3
05 BFS / DFS (in portfolio)                 5    2    4      40      2
05 Dijkstra (in portfolio)                  4    2    3      24      —
05 topological sort (not in portfolio)      4    4    4      64      1 ★
05 union-find (not in portfolio)            3    5    3      45      3-tie
06 binary search (gap within ch 6)          5    4    4      80      1 ★★
06 quickselect / heap top-K (gap)            3    4    3      36      —
07 dynamic programming (gap)                 5    5    4     100     1 ★★★
07 backtracking (drilled via PG.ts)         4    3    3      36      —

★★★ = highest priority. Three items tied for the top of the list:
  • dynamic programming
  • binary search
  • topological sort
```

The math isn't sacred — interview frequencies are estimates, leverage is a guess. What's load-bearing is the *ordering* the formula produces, which matches a working senior engineer's gut feeling: DP > binary search > graph extensions > heaps rehearsal > arrays rehearsal.

### Move 3 — the ranked plan (the actual output)

Sorted by score, with one-line justification and a time estimate. The estimate assumes 3-5 problems per topic at IK/LeetCode medium difficulty, plus enough writing-up time to articulate the kernel.

```
RANK 1 — DYNAMIC PROGRAMMING (10-15 hours)
─────────────────────────────────────────────────────────────────
What:    The DP recipe + 5 canonical problems (coin change,
         longest common subsequence, edit distance, 0/1 knapsack,
         longest increasing subsequence).
Why:     Highest score; appears in 60-80% of senior interviews;
         entirely missing from your portfolio.
Done when:
  - You can write memoized recursion AND bottom-up tabulation for
    each of the five canonical problems.
  - You can state the recurrence relation for an unseen DP problem
    within 5 minutes of reading the prompt.
  - You can identify *whether* a problem is DP-shaped (overlapping
    subproblems + optimal substructure) before writing code.
Foundation: chapter 07, recursion-backtracking-and-dp.

RANK 2 — BINARY SEARCH (5-8 hours)
─────────────────────────────────────────────────────────────────
What:    The kernel (sorted precondition, halve search space,
         low <= high) + the variants (bisect_left, bisect_right,
         binary search on the *answer*, search-in-rotated-array).
Why:     Highest individual gap; you've shipped 5 sorts but no
         binary search; binary-search-on-the-answer is a senior
         interview favorite.
Done when:
  - You can write iterative binary search from memory without
    off-by-one errors.
  - You can use binary search to find the smallest X satisfying
    a monotone predicate ("binary search on the answer").
  - You can explain why the precondition is "monotone," not
    "sorted."
Foundation: chapter 06, sorting-searching-and-selection.

RANK 3 — TOPOLOGICAL SORT + UNION-FIND (8-12 hours, combined)
─────────────────────────────────────────────────────────────────
What:    Topo sort via DFS post-order (reversed); union-find with
         path compression and union by rank; Kruskal's MST as the
         classical application.
Why:     Both build on your existing Graph + BFS/DFS portfolio;
         both show up in 30-50% of senior interviews; you've never
         had a codebase reason to build them.
Done when:
  - You can compute a topo order of a DAG given as an adjacency
    list, in O(V+E).
  - You can write union-find with both optimizations and explain
    the inverse-Ackermann amortized cost.
  - You can solve "course schedule" (topo sort) and "number of
    islands" (union-find or DFS) from memory.
Foundation: chapters 04 (trees as DAGs) and 05 (graphs).

RANK 4 — COMPLEXITY REHEARSAL + AMORTIZED ANALYSIS DEEP-DIVE (4-6 hours)
─────────────────────────────────────────────────────────────────
What:    Sharpen your articulation of amortized cost. Practice
         saying "the spacing gate is 1.1s per call but amortized
         throughput is 1/sec — the worst case is the budget, not a
         failure." Reach for amortized analysis when defending
         dynamic arrays, hash table resize, splay trees.
Why:     This codebase already applies complexity reasoning, but
         your articulation of *why* a design wins on amortized
         grounds is the senior-signal interviewers test.
Done when:
  - You can defend `Array.prototype.push` being amortized O(1)
    despite dynamic-array resizes being O(N).
  - You can defend the spacing gate (`lib/mcp/client.ts` L148–L163)
    as a *throughput-bounding* mechanism, not a *latency-adding* one.
  - You can name when amortized analysis is misleading (P99 tail
    latency under bursts).
Foundation: chapter 01, complexity-and-cost-models.

RANK 5 — HEAPS REHEARSAL + STREAMING TOP-K (4-6 hours)
─────────────────────────────────────────────────────────────────
What:    You've built BinaryHeap and PriorityQueue from scratch.
         What you haven't drilled: when to *reach for them* vs
         sort-and-slice. Practice the streaming top-K problem
         (min-heap of size K, push if larger than root). Practice
         Dijkstra with a heap (you have Dijkstra in Graph2 but
         confirm it uses your PriorityQueue).
Why:     Skill is already built; the rehearsal is to make the
         *trigger to use it* automatic.
Done when:
  - You can articulate when sort-and-slice loses to heap-based
    top-K (streaming, or N huge with K small).
  - You can write streaming top-K from memory using your
    PriorityQueue.
  - You can defend the choice of min-heap vs max-heap for top-K
    largest (min-heap; the root is the smallest of the K, so you
    pop it when a larger one arrives).
Foundation: chapter 03, stacks-queues-deques-and-heaps.

RANK 6 — ARRAYS/STRINGS/MAPS REHEARSAL (4-6 hours)
─────────────────────────────────────────────────────────────────
What:    You use these in every project. The rehearsal: drill the
         *combination patterns* — two-pointer, sliding window,
         prefix sum, character-count map — that compose primitives
         into algorithms. Trie not in portfolio (rank 7).
Why:     Skill is already exercised, but the *idiomatic combos*
         (sliding window with hash map, two pointers on sorted
         arrays, prefix sum + hash map) are interview workhorses.
Done when:
  - You can solve "longest substring without repeating chars"
    (sliding window + map) in 10 minutes.
  - You can solve "two sum II" on sorted input (two pointers) in
    5 minutes.
  - You can solve "subarray sum equals K" (prefix sum + map) in
    10 minutes.
Foundation: chapter 02, arrays-strings-and-hash-maps.

RANK 7 — TRIES (3-5 hours)
─────────────────────────────────────────────────────────────────
What:    The trie kernel: edges labeled by characters, terminator
         flags, O(M) insert/lookup. Drill: autocomplete, "implement
         trie," "word break II" (trie + DP combo).
Why:     Lower interview frequency than the items above, but
         entirely missing from your portfolio. Closes a known gap.
Done when:
  - You can implement a trie with insert, search, startsWith in
    one sitting.
  - You can solve "word search II" (trie + backtracking on a
    board) which is the canonical trie interview problem.
Foundation: chapter 04, trees-tries-and-balanced-indexes.

LOWER PRIORITY — DEQUES, SEGMENT TREES, ADVANCED GRAPH ALGORITHMS
─────────────────────────────────────────────────────────────────
Skip for now. Reach for these only after the top 7 are solid:
  • monotonic deque (sliding window max) — useful but specialized
  • segment tree / Fenwick tree — competitive-programming, rare
    in production interviews
  • Tarjan's SCC, A*, Bellman-Ford — niche graph algorithms
```

### Move 3 — the principle

**Rank by leverage, then drill in order.** The temptation is to study what you find most interesting or what's closest to what you already know. Both are wrong heuristics for time-bounded preparation. Rank by *frequency × gap × leverage*, then attack from the top of the list. The items at the top of the list above are not necessarily the most interesting; they're the ones that close the biggest gaps for the lowest effort.

---

## Primary diagram

The practice map in one frame — input (chapter verdicts), pipeline (three lenses), output (ranked list).

```
                THE PRACTICE-MAP PIPELINE

  ┌─────────────────────────────────────────────────────────────────┐
  │  INPUT: per-chapter verdicts (from chapters 01–07)               │
  │                                                                  │
  │  ch 01 → applies          ch 05 → not yet (BFS/DFS in portfolio) │
  │  ch 02 → applies          ch 06 → partial (binary search NOT)    │
  │  ch 03 → partial (heaps   ch 07 → not yet (DP not in portfolio)  │
  │           in portfolio)                                          │
  │  ch 04 → not yet (trie                                           │
  │           not in portfolio)                                      │
  └────────────────────────┬────────────────────────────────────────┘
                           │
                           ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │  PIPELINE: three lenses                                          │
  │                                                                  │
  │   frequency (1-5)   ×   portfolio gap (1-5)   ×   leverage (1-5) │
  │   "how often in         "build vs rehearse"       "value in next │
  │    interviews?"          (already in portfolio?)   codebase?"     │
  │                                                                  │
  │   = score (max 125)                                              │
  └────────────────────────┬────────────────────────────────────────┘
                           │
                           ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │  OUTPUT: ranked list (sorted by score, descending)               │
  │                                                                  │
  │   1. ★★★ Dynamic programming                10-15 hrs            │
  │   2. ★★  Binary search                       5-8 hrs             │
  │   3. ★   Topological sort + union-find       8-12 hrs            │
  │   4.     Complexity / amortized rehearsal    4-6 hrs             │
  │   5.     Heap rehearsal + streaming top-K    4-6 hrs             │
  │   6.     Array/string/map combo patterns      4-6 hrs             │
  │   7.     Tries                                3-5 hrs             │
  │                                                                  │
  │   TOTAL: ~38-58 hours, ~4-6 weeks at 8-10 hrs/week               │
  └─────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

This chapter is a plan, not a piece of code. There's no file to anchor — but here's how the plan grounds in the codebase's audit.

### **The audit evidence — chapter by chapter**

```
chapter   verdict     evidence in repo (file:line if applies)
────────  ──────────  ────────────────────────────────────────────────────
01        applies     lib/mcp/client.ts L80 (Map for O(1) lookup)
                      lib/mcp/tools.ts L38–L40 (Set dedup for O(N))
                      lib/agents/categories.ts L116–L127 (flatten-once)
                      lib/mcp/client.ts L148–L163 (amortized throughput)
02        applies     lib/mcp/client.ts L80 (Map cache)
                      lib/agents/categories.ts L116–L127 (Set capabilities)
                      lib/mcp/tools.ts L38–L40 (Set-union dedup)
                      lib/hooks/useInvestigation.ts L184–L208 (string buf)
03        partial     lib/hooks/useInvestigation.ts L184–L208 (implicit
                       queue); NO file for stack/deque/heap
04        not yet     (closest: lib/mcp/schema.ts L8–L18 nested object,
                       but iterated with flat loops in categories.ts)
05        not yet     (closest: lib/mcp/schema.ts L151–L192 bootstrap
                       chain, which is a fixed pipeline not a traversal)
06        partial     lib/agents/monitoring.ts L51 + L119 (sort + slice)
                      lib/mcp/schema.ts L100 (second sort)
                      lib/insights/derive.ts L12–L20 (linear search)
                      lib/mcp/validate.ts L7–L9 (substring scan)
                      lib/hooks/useInvestigation.ts L86–L95 (reverse scan)
                      components/feed/InsightCard.tsx L159–L161 (argmin)
                      NO file for binary search
07        not yet     (only "recursive" mention is app/api/mcp/capture/
                       route.ts mkdir({recursive: true}) — stdlib param)
```

### **The portfolio evidence — what's already built outside this codebase**

From `me.md`:
- `reincodes/Graph.ts` — adjacency list, BFS, DFS, valid-tree, connected components, Eulerian
- `reincodes/Graph2.ts` — weighted edges, supports Dijkstra
- `reincodes/BinarySearchTree.ts` — insert, search, delete, all three traversals
- `reincodes/BinaryHeap.ts` — MinHeap, MaxHeap, heapifyUp/Down
- `reincodes/PriorityQueue.ts` — heap-backed, with updatePriority
- `reincodes/Tree.ts` — n-ary, pre/post traversal with generators
- `reincodes/Sorting/` — selection, bubble, insertion, merge, quick, heap sort + visualizers
- `reincodes/PG.ts` — state-space search for the river-crossing puzzle (this IS backtracking)

What's missing from the portfolio:
- **Dynamic programming** — never built any DP problem from scratch
- **Binary search** — never built the algorithm or any of its variants
- **Trie** — never built
- **Topological sort** — never built (though you have DFS in Graph.ts, the topo-sort wrapper isn't there)
- **Union-find** — never built
- **Segment tree / Fenwick tree** — never built
- **Suffix array / suffix tree** — never built

The practice ranking comes from the cross-product of "what the codebase doesn't exercise" × "what your portfolio doesn't already build."

### **The 4-6 week study schedule**

Assuming 8-10 hours/week of focused study time, ordered to match the ranking:

```
WEEK 1-2 — Dynamic programming (10-15 hours)
  drill: coin change, LCS, edit distance, 0/1 knapsack, LIS
  format: memoized recursion first, then bottom-up tabulation
  build: a personal "DP cheatsheet" page in your `reincodes/DP/` directory

WEEK 3 — Binary search (5-8 hours)
  drill: iterative kernel, bisect variants, search in rotated array,
         binary search on the answer (find K-th smallest in matrix)
  build: `reincodes/BinarySearch.ts` with all variants + tests

WEEK 4 — Topological sort + union-find (8-12 hours)
  drill: course schedule (topo), number of islands (union-find or DFS),
         Kruskal's MST
  build: extend `reincodes/Graph.ts` with topoSort method;
         create `reincodes/UnionFind.ts` with path compression + union by rank

WEEK 5 — Complexity rehearsal + heap rehearsal (8-12 hours)
  practice articulating amortized vs worst case for 5 design decisions
  rebuild streaming top-K from scratch using your PriorityQueue
  drill: median maintenance, k-merge using min-heap

WEEK 6 — Arrays/strings combos + tries (8-12 hours)
  drill: longest substring without repeating chars, two-sum II,
         subarray sum equals K, word break, word search II
  build: `reincodes/Trie.ts` with insert/search/startsWith;
         then use it for word search II
```

**Total: ~38-58 hours over 4-6 weeks.** At the end, every "not yet exercised" category in chapters 01–07 has a built artifact in `reincodes/` or a rehearsed interview problem, and you can defend the existing repo's choices with the senior signal that comes from amortized-analysis fluency.

---

## Elaborate

### Where the ranking heuristic comes from

The frequency × gap × leverage formula is a working-engineer's calibration, not a research finding. Three sources:

- **Interview question frequency tables** (LeetCode tagging frequency, Glassdoor question reports, IK curriculum weighting) inform the first dimension. DP and graph problems are weighted heaviest in nearly every senior frontend / fullstack interview pipeline; trees / heaps / graphs typically follow; tries and segment trees are rarer.

- **Andy Matuschak's "spaced rehearsal vs new learning"** distinction informs the portfolio-gap dimension. Rehearsing a built skill takes 1/3 the hours of building a new one; the practice plan should weight gaps accordingly.

- **The career-pivot leverage dimension** is calibrated to the portfolio shape in `me.md`. Your next codebase is likely either AI-native (RAG, agents, on-device ML) or product-engineering (B2C frontend with backend depth). Both lean on graph algorithms (tool dependency, recommendation traversal) and DP (scheduling, optimization), less on tries (autocomplete is the main use case, often handed off to a search service).

### Why this ranking might be wrong for *you*

The ranking is calibrated to a working senior engineer pivoting into AI. Three reasons it might be wrong:

1. **If you have an interview next week**, frequency dominates. Drill DP and graph problems hard, defer tries entirely.

2. **If you're targeting a specific company with known interview style**, the company's history wins. Some companies (Google, Meta) lean on DP heavily; others (startups, design-focused) lean on system-design and never ask DP.

3. **If the next codebase is *known* and *unusual***, leverage shifts. Building an autocomplete-heavy app makes tries higher leverage; building a database makes B-trees and skip lists higher leverage.

The framework is the load-bearer; the specific scores are estimates you can recalibrate.

### What the ranking deliberately does *not* include

- **Hardware-level data structures** (cache-oblivious, lock-free, CRDTs) — too specialized for a foundational guide; these belong in a runtime-systems or distributed-systems study guide.

- **Concurrency primitives** (locks, semaphores, channels) — these are runtime / concurrency topics, not DSA foundations. Out of scope.

- **Big-O cheatsheet memorization** — the ranking assumes you internalize the cost shapes through *use*, not flashcards. Doing 5 DP problems teaches you O(states × work-per-state) better than reading a table.

- **Competitive-programming specialties** (Mo's algorithm, heavy-light decomposition, persistent data structures) — high cost, low interview leverage, not on the plan.

### What to do after the 6 weeks

Once the top 7 are solid:

- **Re-audit this codebase.** Has it grown? Are the "not yet exercised" verdicts still accurate? Update them.
- **Pick the next codebase deliberately.** A project that *forces* you to use the newly-built primitives (a path-planning grid for graphs, an autocomplete for tries, a recommendation optimizer for DP) is worth 10× the same hours spent on random LeetCode.
- **Move to the lower-priority items.** Segment trees, advanced graphs, deques, advanced string algorithms. These are bonus material; reach for them when a real problem calls.

---

## Interview defense

**What they are really asking.** When an interviewer asks "what are you working on / studying right now?" — they're checking for two things: deliberateness (do you know what you don't know?) and prioritization (are you spending your hours on the highest-leverage gaps?). The ranking in this chapter is the answer to both.

---

**[mid] "What are you studying right now?"**

Three categories, in order: dynamic programming (the biggest gap — 10-15 hours over 2 weeks), binary search (medium gap — 5-8 hours over the next week), and topological sort plus union-find (8-12 hours building on my existing graph implementations). The rest of the foundational categories I've either built from scratch in my `reincodes` portfolio or am applying in production code; I'm specifically targeting the gaps interview pipelines test heaviest.

---

**[senior] "How do you decide what to study?"**

A three-lens framework: interview frequency, portfolio gap, and leverage at the next codebase. Each gets a 1-5 score; the product gives a rank. The output is a 6-week plan with roughly 8-10 hours per week of focused drilling. The honest answer is the framework is calibration, not measurement — the scores are estimates I update when I get new information (a friend's interview report, a job posting that emphasizes a specific topic, a side project that exposes a real gap). What the framework prevents is studying the most *interesting* thing instead of the most *leveraged* thing.

```
  the bad heuristic:   "I'll study what's most interesting right now"
  the good heuristic:  "I'll study what closes the biggest gap per hour"
```

---

**[arch] "Why DP first and not, say, advanced graph algorithms?"**

Because DP scores higher on all three lenses. Frequency: DP appears in ~60-80% of senior pipelines vs maybe 20-30% for advanced graph algorithms. Gap: I've never built a DP problem from scratch; I've built BFS, DFS, Dijkstra, connected components in my `reincodes/Graph.ts`. Leverage: optimization-under-constraints problems show up everywhere — recommendation systems, scheduling, layout, resource allocation. Advanced graph algorithms (Tarjan's SCC, A*, max-flow) are higher-ceiling but lower-frequency for the role I'm targeting. If I were going for a graph-DB infrastructure role specifically, the ranking would flip.

---

**The dodge: "isn't this all just LeetCode prep?"**

Partly, yes — interview frequency *is* one of the three lenses, and LeetCode is the canonical interview practice surface. But the framework's other two lenses (portfolio gap, real-codebase leverage) keep it grounded. The output is a list of *foundational data structures and algorithms* I can defend and reach for in real code, not a list of "100 problems to grind." The DP rank is high because DP problems are everywhere in real codebases (recommendation optimization, scheduling, resource allocation), and high leverage in interviews because they reveal whether you can decompose a problem under pressure. Both motivations reinforce each other; that's the rank.

---

## Validate

### Level 1 — reconstruct

Without looking, write the three lenses in the ranking formula (interview frequency, portfolio gap, leverage) and explain in one sentence what each measures. Then write the top 3 items of the ranked list and why they're at the top.

### Level 2 — explain

Open chapters 03, 05, and 07. For each "not yet exercised" sub-item (heaps, BFS/DFS, DP), identify (a) its position in the ranked list above, (b) the rationale in one sentence, (c) the time estimate, and (d) the trigger that would make it suddenly *more* urgent (a job posting? an interview scheduled? a side project starting?).

### Level 3 — apply

**Scenario:** You get a senior interview at a company in 2 weeks. The recruiter says "expect a lot of dynamic programming and at least one graph problem." Re-rank your 2 weeks of study time. Do you skip binary search to spend more time on DP? Do you defer topological sort entirely? Justify the re-ranking against the original 6-week plan.

### Level 4 — defend

A teammate says: "You should drill tries before DP — they're easier and you'll feel productive faster." Defend the DP-first ranking. Address: (a) interview frequency, (b) portfolio gap (you've never built DP from scratch; tries are also new but lower-frequency), (c) leverage in real codebases (DP shows up in optimization problems; tries show up mainly in autocomplete and IP routing). State without hedging which one wins on each axis and why the product favors DP.

### Quick check

- Which item is rank 1 in the practice plan? (Dynamic programming.)
- Which item is rank 2? (Binary search.)
- What does "portfolio gap" measure? (How much *new building* vs *rehearsal* the topic needs, given what you've already built in `reincodes/`.)
- What's the total time estimate for the 6-week plan? (~38-58 hours.)
- Which item from chapters 03–07 is *not* on the ranked plan, and why? (Deques and segment trees — both scored too low on frequency × leverage to make the top 7.)

## See also

→ chapters 01 through 07 (the audits this plan ranks) · → `me.md` (the portfolio status that calibrates "build vs rehearse") · → IK curriculum (the structured drilling path many of the ranked items follow)

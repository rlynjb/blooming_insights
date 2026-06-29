# DSA Foundations Practice Map

The ranked learning plan — Project-specific

## Zoom out — where this concept lives

This file is the audit's final word: a ranked map of what to drill, in what order, with what evidence anchor. It sits *outside* the running code — it's the bridge from "what `blooming_insights` exercises" to "what the next AI-engineering interview will ask you to whiteboard."

```
  Zoom out — the practice plan in two halves

  ┌─ what the codebase ALREADY exercises ─────────────────────────┐
  │  hash map (Map) · set · array · string buffer                 │
  │  comparator sort + slice (top-K via sort)                     │
  │  argmin via reduce                                            │
  │  iterative bounded loop (recursion shape, iterative impl)     │
  │                                                                │
  │  → these are SHIPPED. drill maintenance only — name them      │
  │     well in an interview and move on.                          │
  └────────────────────────────────────────────────────────────────┘

  ┌─ what the codebase does NOT exercise (the real practice list) ─┐
  │  Tier 1 (must drill, asked constantly):                        │
  │     · binary search                                            │
  │     · BFS / DFS                                                │
  │     · heap / priority queue                                    │
  │     · two pointers + sliding window                            │
  │                                                                │
  │  Tier 2 (asked in mid/senior loops):                           │
  │     · dynamic programming (1D + 2D)                            │
  │     · backtracking                                             │
  │     · binary search tree (balanced semantics)                  │
  │     · Dijkstra / shortest path                                 │
  │     · union-find                                               │
  │                                                                │
  │  Tier 3 (signal for senior+, niche real-world):                │
  │     · trie                                                     │
  │     · topological sort                                         │
  │     · segment tree / Fenwick tree                              │
  │     · monotonic stack/queue                                    │
  └────────────────────────────────────────────────────────────────┘
```

## Zoom in — the concept

The practice plan ranks by **interview frequency × distance from your portfolio**. Things you've shipped (BFS, DFS, Dijkstra, BSTs, heaps in `reincodes`) need maintenance drills, not first-time learning. Things you've *never* shipped (binary search, two-pointer/sliding-window, DP, backtracking, union-find, trie) need the most hours.

The honest framing: the gap isn't in `blooming_insights`'s code — the code is right for its scale. The gap is in what the code never had to reach for. This file names that gap and ranks the hours.

## Structure pass — layers · axes · seams

One axis traced: **how much interview-time does each topic warrant, ranked by frequency × current weakness?**

```
  one axis — "where does each hour invested pay off most?"

  ┌─ Tier 0 — already exercised in blooming_insights ────────────┐
  │   hash map, set, array scan, sort+slice, argmin reduce        │
  │   → maintenance: name them precisely; can be drawn in 30s     │
  └──────────────────────────────────────────────────────────────┘
  ┌─ Tier 0.5 — already shipped in reincodes portfolio ──────────┐
  │   BFS, DFS, Dijkstra, BST, BinaryHeap, PriorityQueue,         │
  │   sorting algorithms (selection / bubble / insertion /        │
  │   merge / quick / heap), Eulerian cycle, connected components │
  │   → maintenance: re-read the code, rebuild ONE from scratch   │
  │     under timed conditions before the next interview          │
  └──────────────────────────────────────────────────────────────┘
  ┌─ Tier 1 — high frequency, weak coverage ─────────────────────┐
  │   binary search (every loop, every variant)                   │
  │   two pointers + sliding window                               │
  │   heap / priority queue (top-K applied, not just impl)        │
  │   BFS/DFS APPLIED to grids and matrices                       │
  │   → these are the next 20 hours of focused drilling           │
  └──────────────────────────────────────────────────────────────┘
  ┌─ Tier 2 — mid/senior frequency, no coverage ─────────────────┐
  │   dynamic programming (1D first, then 2D)                     │
  │   backtracking (N-queens, subsets, permutations)              │
  │   balanced BST semantics (AVL / red-black: API not internals) │
  │   union-find (Kruskal, connected components on edges)         │
  │   Dijkstra APPLIED (you've implemented; drill the application)│
  │   → these are the next 30 hours after Tier 1                  │
  └──────────────────────────────────────────────────────────────┘
  ┌─ Tier 3 — senior+ signal, low frequency ─────────────────────┐
  │   trie (autocomplete, prefix sum, IP routing)                 │
  │   topological sort (DAG scheduling, dependency resolution)    │
  │   segment tree / Fenwick (range sum / range update)           │
  │   monotonic stack / queue (sliding-window max, NGE)           │
  │   → these are the signal-for-senior topics                    │
  └──────────────────────────────────────────────────────────────┘

  the seam: tier 1 = "asked constantly, you have no portfolio anchor"
            tier 0.5 = "shipped, just keep sharp"
```

## How it works

### Move 1 — the mental model

This is a **prioritized backlog**, not a syllabus. The ordering is interview-pull-weighted: tier 1 topics show up in nearly every front-end / AI-engineering loop, tier 3 topics show up in senior+ system-design-adjacent rounds. **Drill top-down**: never spend an hour on tier 2 until tier 1 is solid.

The maintenance tier (0.5) is the cheapest leverage: you've already shipped these. Rebuilding `BinaryHeap.ts` from scratch in 30 minutes under timed conditions before an interview is more useful than learning a tier-3 topic cold — interviewers prefer mastery of fundamentals over breadth of buzzwords.

```
  the practice loop — per topic

  read     → re-derive on paper, no IDE
   ↓
  pattern  → name the kernel parts (what BREAKS if removed?)
   ↓
  impl     → code from scratch, no library
   ↓
  apply    → solve 3-5 problems that use the structure
   ↓
  defend   → write the interview answer; rehearse it cold
```

### Move 2 — the moving parts

#### Tier 0 — already exercised in `blooming_insights`

These are real anchors you can name in an interview. Maintenance only.

```
  Tier 0 — your shipped surface in blooming_insights

  hash map        lib/state/insights.ts:14  · activeToolCalls per tool
                  lib/data-source/bloomreach-data-source.ts:122  · TTL cache
                  + 3 other Maps (auth, investigations, sub-feeds)

  set             lib/agents/categories-legacy.ts:120  · schemaCapabilities
                  lib/agents/tool-schemas.ts:13         · filterToolSchemas
                  lib/mcp/tool-coverage.ts:40           · cross-check

  string buffer   lib/streaming/ndjson.ts:30  · NDJSON line buffer

  comparator sort lib/agents/monitoring-legacy.ts:136  · top-10 by severity

  argmin reduce   components/feed/InsightCard.tsx:160  · funnel leak

  iterative loop  lib/agents/base-legacy.ts:114  · agent tool-use loop
```

**What to do**: when an interviewer asks "what's interesting in your code, complexity-wise?" — these are the answers. You don't need to study them; you just need to be able to name them and the seam each one sits at (file 01 has the cost map; files 02, 03, 06, 07 have the deep walks).

#### Tier 0.5 — already shipped in `reincodes`, drill maintenance

You have working implementations of these. The interview risk is that they go stale.

```
  Tier 0.5 — your reincodes portfolio

  Graph (adj list)        Graph.ts          BFS, DFS, Eulerian, valid-tree
  Graph2 (node+edge)      Graph2.ts         weighted, drives Dijkstra
  Binary Search Tree      BinarySearchTree.ts  full insert/delete/traversals
  Binary Heap             BinaryHeap.ts     min + max, heapifyUp/Down
  Priority Queue          PriorityQueue.ts  heap-backed, updatePriority
  Tree (n-ary)            Tree.ts           pre/post traversal, generators
  Sorting (5)             utils/notes/Sorting/  bubble/insertion/selection
                                                 + merge/quick + heap +
                                                 React visualizers
  State-space search      PG.ts             BFS over river-crossing puzzle
```

**What to do** (in order of leverage):
1. **30 min before an interview**: re-read ONE — pick whichever the role's domain leans toward. Frontend role → re-read your sort visualizers. AI/agents role → re-read `PG.ts` (state-space BFS — that's the right anchor for "how would you explore branching agent paths?").
2. **Weekly maintenance**: implement one from scratch from memory, timed (20 minutes). Rotate which one. The act of rebuilding catches what's drifted; the time pressure simulates the interview.
3. **Before any DSA round**: rebuild `BinaryHeap.ts` from scratch. It's the load-bearing primitive — touches sorting (heapsort), graphs (Dijkstra), top-K, scheduling. One implementation buys you four interview hooks.

#### Tier 1 — high frequency, weak coverage (next 20 hours)

These are the topics asked in nearly every loop where you have no shipped anchor.

```
  Tier 1 — drill order, ~5 hours each

  1. binary search (and ALL its variants)
     - find target (basic)
     - first occurrence / last occurrence (with comparator twist)
     - find insertion point (lower_bound / upper_bound)
     - binary search the answer (peak finding, allocation problems)
     - rotated sorted array search
     anchor problems: LC 704, 34, 33, 162, 875, 1011
     why: this is THE most-asked easy/medium. low effort, huge ROI.
     pattern files: 04 (BST cousin), 06 (the searching half)

  2. two pointers + sliding window
     - two pointers from opposite ends (sorted-array two-sum, palindrome)
     - two pointers same direction (remove dupes, partition)
     - sliding window (max/min/sum in window of size K)
     - sliding window with hash map (longest substring no-repeat)
     anchor problems: LC 167, 26, 283, 643, 3, 76, 209
     why: zero portfolio coverage, asked constantly, pattern transfers
     to manyOther problems. visualize bars sliding (your sorting visualizer
     instinct works here).

  3. heap / priority queue APPLIED (you have the impl, drill the use)
     - top-K via fixed-size heap (the upgrade from sort+slice — file 06)
     - merge K sorted lists (heap of heads)
     - K-closest points (max-heap of size K)
     - find median in a stream (two-heap pattern)
     anchor problems: LC 215, 23, 973, 295
     why: your reincodes BinaryHeap + PriorityQueue gives you the structure;
     these problems give you the application. "I shipped this — here's how
     I'd apply it" is a strong interview opener.

  4. BFS / DFS APPLIED to grids and matrices (you have graph impl)
     - number of islands (DFS / BFS on a grid)
     - flood fill (the classic grid BFS)
     - rotting oranges (multi-source BFS — important pattern)
     - word ladder (BFS on implicit graph)
     - course schedule (DFS + cycle detection on a DAG)
     anchor problems: LC 200, 733, 994, 127, 207
     why: you have BFS/DFS implemented as abstract algorithms; the
     "grid as implicit graph" trick is what these problems test.
```

#### Tier 2 — mid/senior frequency, no coverage (next 30 hours after Tier 1)

```
  Tier 2 — drill order, ~6 hours each

  1. dynamic programming — 1D first (file 07)
     - climbing stairs (the canonical "DP is fib")
     - house robber (decision per element)
     - coin change (min coins for amount)
     - longest increasing subsequence (O(n²) DP, then optional O(n log n))
     pattern: define dp[i] in one English sentence; base cases; recurrence
     anchor problems: LC 70, 198, 322, 300

  2. dynamic programming — 2D
     - unique paths in a grid
     - longest common subsequence
     - edit distance (Levenshtein)
     - 0/1 knapsack
     anchor problems: LC 62, 1143, 72, 416
     why: 2D DP is the signal-for-senior — the table layout is the lesson

  3. backtracking (file 07)
     - permutations / combinations / subsets (the three siblings)
     - N-queens (the canonical apply/undo)
     - word search (DFS + backtracking on a grid)
     - generate parentheses (constraint-driven)
     anchor problems: LC 46, 78, 51, 79, 22

  4. balanced BST semantics (API, not internals)
     - "what does TreeMap give you that HashMap doesn't?"
     - range queries, floor/ceiling, ordered iteration
     - implementing a simplified TreeMap-like API on top of your BST
     anchor problems: LC 729 (calendar), 855 (exam room), 220 (contains nearby dupe III)
     why: you have BST; drill the ORDERED queries that hash maps can't answer

  5. union-find (disjoint sets) — completely new
     - implementation: parent array + path compression + union by rank
     - applications: connected components on edges, Kruskal's MST, redundant edge
     anchor problems: LC 547, 684, 200 (alt soln), 1319
     why: small implementation, huge interview ROI, no portfolio coverage

  6. Dijkstra APPLIED (you have the impl)
     - network delay time (basic Dijkstra)
     - cheapest flights within K stops (Dijkstra variant)
     - swim in rising water (Dijkstra on a grid)
     anchor problems: LC 743, 787, 778
```

#### Tier 3 — senior+ signal, low frequency (after Tier 2)

```
  Tier 3 — drill order, ~4-6 hours each

  1. trie (file 04)
     - implementation: nested map of char → node
     - applications: autocomplete, word search II (trie + DFS), prefix sum
     anchor problems: LC 208, 211, 212, 648

  2. topological sort (file 05)
     - Kahn's algorithm (BFS-based, indegree counting)
     - DFS post-order reversal
     - applications: course schedule, build order, parallel job scheduling
     anchor problems: LC 207, 210, 269, 1462

  3. segment tree / Fenwick tree (binary indexed tree)
     - range sum query with point update
     - range min / max query
     - Fenwick is the lighter, less-flexible cousin
     anchor problems: LC 307, 315, 218
     why: senior-only, but the pattern is elegant — drill if interviewing
     at companies that go deep on algorithmic rounds (Google, Citadel)

  4. monotonic stack / monotonic queue
     - next greater element (monotonic decreasing stack)
     - largest rectangle in histogram (the canonical monotonic stack)
     - sliding window max (monotonic deque)
     anchor problems: LC 496, 84, 239
     why: the pattern that "looks like" you need DP but actually needs
     a clever stack discipline. impressive to nail in an interview.
```

### Move 3 — the principle

The DSA practice plan is **portfolio-aware**: the topics you've already shipped are maintenance work, not first-time learning. The topics that show up constantly in interviews but never landed in your code are where the marginal hour pays off. **Drill top-down through the tiers; within a tier, drill in the order listed.** When the next interview's loop is announced, re-read the relevant Tier 0/0.5 anchor (which lives in your shipped code) — that's the 30-minute prep that makes Tier 1+ drills land as "applied" instead of "abstract."

## Primary diagram

The recap — the whole practice surface, ranked.

```
  blooming_insights DSA practice map — full picture

  ┌─ Tier 0 — shipped in blooming_insights (maintenance only) ────┐
  │  hash map · set · string buffer · array scan                  │
  │  comparator sort + slice · argmin reduce · iterative loop     │
  │  → name these in 30s; cite line numbers (files 01, 02, 03, 06)│
  └──────────────────────────────────────────────────────────────┘

  ┌─ Tier 0.5 — shipped in reincodes (warm-up before interviews) ─┐
  │  BFS · DFS · Dijkstra · BST · BinaryHeap · PriorityQueue      │
  │  sorting (selection / bubble / insertion / merge / quick /    │
  │  heap) · Tree n-ary · Eulerian cycle · state-space BFS        │
  │  → 30 min re-read OR 20 min rebuild before each DSA round     │
  └──────────────────────────────────────────────────────────────┘

  ┌─ Tier 1 — drill next, ~20 hours total ────────────────────────┐
  │  1. binary search (all variants)        ~5 h                  │
  │  2. two pointers + sliding window       ~5 h                  │
  │  3. heap APPLIED (top-K, K-merge)       ~5 h                  │
  │  4. BFS/DFS APPLIED (grids, matrices)   ~5 h                  │
  └──────────────────────────────────────────────────────────────┘

  ┌─ Tier 2 — drill after Tier 1, ~30 hours total ────────────────┐
  │  5. 1D DP                                ~5 h                  │
  │  6. 2D DP                                ~6 h                  │
  │  7. backtracking                         ~5 h                  │
  │  8. balanced BST semantics (TreeMap-API) ~4 h                  │
  │  9. union-find                           ~4 h                  │
  │ 10. Dijkstra APPLIED                     ~4 h                  │
  └──────────────────────────────────────────────────────────────┘

  ┌─ Tier 3 — senior+ signal (after Tier 2) ──────────────────────┐
  │ 11. trie                                 ~4 h                  │
  │ 12. topological sort                     ~4 h                  │
  │ 13. segment tree / Fenwick               ~6 h                  │
  │ 14. monotonic stack / queue              ~4 h                  │
  └──────────────────────────────────────────────────────────────┘

  total path:  Tier 1 (~20h) → Tier 2 (~30h) → Tier 3 (~18h)
  the 20-hour Tier-1 push is the highest-ROI investment.
```

## Elaborate

This map is portfolio-shaped, not curriculum-shaped. A standard DSA curriculum (CLRS, Skiena) covers all of this in textbook order — sorting before graphs before DP — and that's correct for first exposure. **You're past first exposure.** Your `reincodes` portfolio shows you've mastered the graph + tree + heap layer; the IK curriculum gave you structured exposure to the standard algorithms; what's left is **applied drilling on the topics most likely to be asked** in your next AI-engineering interview, ranked by where the hours pay off most.

**On LeetCode anchor problems**: I name them by number throughout. Working LC at this point isn't about learning the topic — it's about **applying** a structure you already understand. The 5-problem-per-topic rule isn't arbitrary: 3-5 problems is the threshold where pattern recognition kicks in. After 5 sliding-window problems you don't *think* about the pattern; you see it.

**On time estimates**: the ~5 hours per Tier-1 topic is real-time, focused, no-distractions. Skim-reading a topic in 20 minutes doesn't count. The hour budget is the time it takes to read the pattern, derive the kernel on paper, implement from scratch with no library, solve 3-5 problems with the pattern, and write the interview defense.

**On the AI-engineering shift**: AI/agents companies test classical DSA — they're hiring engineers, not LLM prompt operators. The shift in interview content is that **system-design** rounds add LLM-specific patterns (RAG, agents, eval); the **coding** rounds stay classical (binary search, BFS, DP). This file covers the classical layer.

Read the rest of this folder for the per-concept depth; this file is the ordering. The right reading sequence from here: re-read file 01 (cost models) → pick the first Tier-1 topic → use file 06 (binary search) or file 03 (heap) or file 05 (graphs) as the depth reference while drilling.

## Interview defense

### Q: Walk me through the most interesting data structure in your codebase.

The two-level session map. `blooming_insights` runs on Vercel; a single warm instance serves multiple users at once. The naive shape would be `Map<insightId, Insight>` — but `putInsights` calls `clear()` on every briefing, which on a flat shared map would wipe **every user's** feed when one user kicked off a new briefing.

The fix is a Map of Maps: `state: Map<sessionId, SessionFeed>`, where `SessionFeed` is itself three Maps (insights, investigations, anomalies). The outer Map is never cleared; the inner Maps are cleared per-session per-briefing. Both `.get()` calls are O(1), so the namespacing costs nothing.

```
  the multi-tenant bug a flat map would have

  flat:    user A briefs → clear() → user B's items gone
  nested:  user A's sessionState("A").insights.clear() →
           user B's sessionState("B") untouched
```

The lesson: **for multi-tenant in-memory state, namespace by the tenant key before the data key.** Same principle works for cache partitioning, rate-limiter token buckets, anything where multiple identities share a process.

Anchor: `lib/state/insights.ts:8-23`.

### Q: What's the next data structure you'd add to this codebase if it grew?

Two candidates, depending on what grew:

1. **A fixed-size min-heap for top-K anomaly ranking.** The monitoring agent currently uses `sort+slice` to take the top 10 anomalies by severity (`lib/agents/monitoring-legacy.ts:136`). With n=10 today that's fine. If we ever ran exploratory anomaly generation — Claude producing hundreds of candidates and us picking the top 10 — I'd swap to a fixed-size heap. O(n log K) instead of O(n log n), and it streams (no need to hold the full array).

2. **A graph + topological sort for category dependencies.** Today the categories list is flat — each category names its required event types and they're checked against a Set. If categories ever depended on each other (e.g., "run 'revenue drop' analysis only after 'conversion drop' has produced a result"), that's a DAG and I'd reach for topological sort to compute the run order. Cycle detection at config time catches bad inputs.

Neither is needed today; the honest answer is "the current structures match the current scale." But knowing the upgrade path is the senior signal — it's the difference between "this works" and "this works AND I know when it'll stop working."

Anchors: `lib/agents/monitoring-legacy.ts:136` (the current sort), `lib/agents/categories-legacy.ts` (the flat deps).

### Q: How would you sequence your DSA study if you had 50 hours before a senior frontend / AI loop?

Top-down through this practice map, with a 30-minute warm-up the morning of each interview.

**Hours 1-20 — Tier 1.** Binary search (all variants — 5h), two pointers + sliding window (5h), heap applied (5h), BFS/DFS applied to grids (5h). These are the four topics asked constantly that I have no shipped anchor for. Each gets ~5 hours: read the pattern, derive the kernel on paper, code from scratch, solve 3-5 LeetCode problems with the pattern, write the interview defense answer.

**Hours 21-50 — Tier 2.** 1D DP (5h), 2D DP (6h), backtracking (5h), balanced BST semantics (4h), union-find (4h), Dijkstra applied (4h). Skip Tier 3 unless the role is signal-for-senior-algo at a company that goes deep (Google, Citadel, Two Sigma).

**The morning-of warm-up.** 30 minutes re-reading the shipped anchor closest to the role's domain. AI/agents role → `reincodes/PG.ts` (state-space BFS over a river-crossing puzzle — the right narrative for "explore branching agent paths"). Frontend role → the sorting visualizers (the React + animation + DSA combo). The warm-up turns Tier 1 drills from "abstract patterns" into "applied — like the time I did X in my project."

```
  the 50-hour plan, drawn

  ┌── morning of  ──┐ 30 min reincodes warm-up
  ├── pre-loop     ─┤
  │                 │
  │   Tier 1: 20 h  │  binary search · sliding window · heap · BFS/DFS
  │   ────────────  │  the "asked constantly, no anchor" topics
  │                 │
  │   Tier 2: 30 h  │  DP 1D · DP 2D · backtracking · BST API ·
  │                 │  union-find · Dijkstra applied
  │                 │  the "mid/senior signal" topics
  └─────────────────┘
       total: 50 h    skip Tier 3 unless senior-algo company
```

The principle: **drill what's asked, not what's interesting.** Tier 3 topics are interesting; Tier 1 topics are the ones the interviewer will actually ask. Allocate hours by frequency × current weakness, not by personal curiosity.

Anchors: the entire practice map above; the shipped portfolio in `reincodes` (cross-referenced in `me.md`).

## See also

- 00-overview.md — the codebase's DSA surface, one-page.
- 01-complexity-and-cost-models.md — for the cost vocabulary every drill should produce.
- 03-stacks-queues-deques-and-heaps.md — for the heap that Tier 1 #3 drills.
- 04-trees-tries-and-balanced-indexes.md — for Tier 2 #4 (BST API) and Tier 3 #1 (trie).
- 05-graphs-and-traversals.md — for Tier 1 #4 (BFS/DFS applied) and Tier 2 #10 (Dijkstra).
- 06-sorting-searching-and-selection.md — for Tier 1 #1 (binary search, all variants).
- 07-recursion-backtracking-and-dynamic-programming.md — for Tier 2 #5-7 (DP, backtracking).
- `.aipe/study-system-design/00-overview.md` — for the architectural anchors when the interviewer pivots from coding to system design.

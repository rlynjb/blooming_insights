# DSA foundations — practice map

*The deliberate-practice plan — ranked by leverage for closing the gap between this repo's surface and a senior interview's surface*

## Zoom out — the gap

```
  This repo's DSA surface vs senior interview surface
  ───────────────────────────────────────────────────

  ┌─ Exercised in blooming-insights ──────────────┐
  │ ★★★★★ hash maps (Map, Set)                    │
  │ ★★★★★ arrays + linear scans                   │
  │ ★★★★  strings, line-buffering, buffers        │
  │ ★★★   comparator-based sort                   │
  │ ★★★   argmin reduce                           │
  │ ★     recursion (one level)                   │
  └────────────────────────┬──────────────────────┘
                           │
                           │  ★ THE GAP — what interviews ask
                           │             that this repo doesn't reach for
                           ▼
  ┌─ Not in blooming-insights (but in reincodes) ─┐
  │ ★★★★★ trees (BST, traversals, n-ary)          │
  │ ★★★★★ graphs (BFS, DFS, Dijkstra, components) │
  │ ★★★★★ heaps + priority queues                 │
  └────────────────────────┬──────────────────────┘
                           │
  ┌─ Not in EITHER repo — the highest-leverage gap▼┐
  │ ★★★★★ dynamic programming (memo + tabulation) │
  │ ★★★★  binary search variants (lower-bound,    │
  │       parametric search)                       │
  │ ★★★★  backtracking (N-queens, permutations,   │
  │       sudoku)                                   │
  │ ★★★   union-find / disjoint set                │
  │ ★★★   tries                                    │
  │ ★★    sliding window / monotone deque          │
  │ ★★    quickselect                              │
  │ ★     segment trees / Fenwick trees            │
  └───────────────────────────────────────────────┘
```

Verdict-first: **the highest-leverage gap is dynamic
programming.** It's the technique most interview
questions reach for that you've built *zero* of, in
either repo. Everything else is either covered by
reincodes (trees, graphs, heaps) or is a smaller-
surface follow-up (tries, segment trees) that you
can land in a week or two.

The plan below sequences practice by leverage — *what
buys you the most interview surface per hour* — not
by topic order.

## Structure pass — what makes a "leverage" judgment

Three axes, one question: *"what return do I get for
the time I spend?"*

```
  Practice-leverage axes
  ──────────────────────

  axis 1: interview frequency
    → how often does this topic show up?
    (DP > graphs > sorting > tries)

  axis 2: depth required to "hold ground"
    → can you stop after the canonical 3-5 problems,
      or do you need 30+?
    (DP needs 30+; tries need ~5)

  axis 3: distance from what you've built
    → how much of the underlying primitive do you
      already own?
    (graphs near; DP far; tries between)

  leverage = frequency × (you-don't-have-it) ÷ depth
                                                ↑
                                        time cost to cover
```

The seam: DP is high-frequency, far-from-built, and
deep — three multipliers compound. Tries are medium-
frequency, near-to-built (Map of Maps), shallow —
three smaller multipliers. DP wins on leverage by an
order of magnitude.

## Practice plan — ranked

#### Tier 1 — close the dynamic-programming gap (~3-4 weeks)

This is the headline. DP is the single most-asked
technique you haven't built. The plan is the **DP
canon** — six classic problems, learn the *shape* of
each, then variations come for free.

**1.1 — Fibonacci, three ways**

```
  Exercise: fib(n) — naive recursion, memoized, tabulated, O(1) space
  ───────────────────────────────────────────────────────────────────

  goals:
    - feel the O(2^N) → O(N) memoization payoff
    - feel the recursion → iteration conversion
    - feel the O(N) → O(1) space optimization

  done when: you can write all four variants from memory,
             explain the call-tree overlap, and name when
             each variant wins
```

**1.2 — Climb stairs / minimum cost climbing stairs**

A direct sibling of Fibonacci. Trains "define the
subproblem" before writing the recurrence.

**1.3 — Coin change (min coins, then number of ways)**

Two flavors of the same problem teach the difference
between *optimization* DP (min coins, take min over
choices) and *counting* DP (number of ways, sum over
choices). Both 1D DP; both essential.

**1.4 — Longest common subsequence (LCS)**

The canonical 2D DP. `dp[i][j]` = LCS of first i of
A and first j of B. Recurrence: match → `1 +
dp[i-1][j-1]`, else `max(dp[i-1][j], dp[i][j-1])`.
**This problem unlocks edit distance, diff
algorithms, sequence alignment.**

**1.5 — 0/1 knapsack**

`dp[i][w]` = best value using first i items with
weight ≤ w. The choice: include item i or skip. This
shape generalises to "subset sum," "partition equal
subset sum," and every "pick a subset under
constraint" problem.

**1.6 — Longest increasing subsequence (LIS)**

Two solutions: O(N²) DP and O(N log N) using binary
search + patience-sorting. Building both makes you
*see* the connection between DP and binary search —
the same problem solved two ways, with different
recurrences and different cost models.

**Done-when for Tier 1:** you can pattern-match a new
DP problem (interview-style) to one of these six
shapes in 2-3 minutes, write the recurrence on a
whiteboard before you write the code, and explain the
space-optimization step. ~40 hours over 3-4 weeks at
a sane pace.

#### Tier 2 — backtracking + binary-search variants (~2 weeks)

These two are smaller surfaces than DP but high
interview frequency. They share a property: you've
*almost* built each (recursion in reincodes, binary-
search-mental-model from this study guide) but
haven't done the canonical problems.

**2.1 — Backtracking trio: N-queens, permutations,
combinations**

```
  Done when: you can write the "choose / recurse / undo"
             skeleton from memory and explain why the
             undo is load-bearing (sibling-branch
             pollution). 1 week.
```

**2.2 — Binary search variants: lower-bound,
upper-bound, first/last occurrence**

The interview ask is rarely "find this element" —
it's almost always "find the first index where
condition X holds" or "smallest K such that...". The
binary-search-on-the-answer (parametric search)
pattern shows up in:

- "capacity to ship within D days"
- "minimum largest sum after splitting an array into K
  pieces"
- "median of two sorted arrays"

```
  Done when: you can write lower_bound and upper_bound
             from memory, distinguish "half-open vs
             closed" interval invariants, and solve one
             parametric-search problem cold. 1 week.
```

#### Tier 3 — union-find + tries + sliding window (~2 weeks)

Three smaller techniques with frequent interview
appearances and shallow surfaces.

**3.1 — Union-Find (disjoint-set)**

The data structure that makes "connected components"
queries fast. Two optimizations: union by rank,
path compression. Together they make ops nearly O(1)
amortized (technically O(α(N)), inverse Ackermann).

Canonical problems: number of islands, redundant
connection, accounts merge, Kruskal's MST.

**3.2 — Trie (prefix tree)**

The data structure from `04-trees-tries-and-balanced-
indexes.md`. Implementation is short — `Map<char,
Node>` plus an `isWord` flag. Practice problems:
implement trie, word search (with backtracking),
autocomplete, longest common prefix.

**3.3 — Sliding window (with monotone deque for
max/min)**

The pattern: maintain a window over an array, slide
it, update an aggregate in O(1) amortized. The
canonical hard variant uses a monotone deque to track
the current max in the window. Problems: longest
substring without repeating characters, minimum
window substring, sliding window maximum.

```
  Done-when for Tier 3: each technique has a "shape" you
                        recognize immediately, plus 2-3
                        canonical problems solved cold.
                        ~30 hours total.
```

#### Tier 4 — depth in graph + tree algorithms (~ongoing)

You've built BFS, DFS, Dijkstra, BST. The Tier 4
move is *variations* on what you own:

**4.1 — Topological sort (DFS-based and Kahn's
algorithm)**
**4.2 — Bellman-Ford (negative weights, cycle
detection)**
**4.3 — A* (Dijkstra + heuristic)**
**4.4 — Lowest common ancestor (Euler tour + RMQ, or
binary lifting)**
**4.5 — Red-black / AVL trees (one self-balancing
implementation from scratch)**

Lower priority because the foundations transfer —
once you can write Dijkstra, you can write A* in an
afternoon. Topological sort is just DFS with a post-
order stack.

#### Tier 5 — exotic but interview-mentioned (~as needed)

Things to *know exist and the shape of*, but not
necessarily implement from scratch:

- **Segment tree / Fenwick tree (BIT)** — range
  queries on mutable arrays. O(log N) for both
  update and query.
- **Quickselect** — find K-th smallest in O(N)
  average. The selection sibling of QuickSort.
- **KMP / Rabin-Karp string matching** — sub-O(N*M)
  substring search.
- **Suffix array / suffix tree** — substring queries
  in O(M log N) or better.
- **Reservoir sampling** — sample K from a stream
  of unknown length, uniformly.

```
  Done when: you can sketch the idea of each in 30
             seconds and name a problem it solves.
             Implementation is interview-deep-dive
             material; recognition is the bar.
```

## Sequencing — the calendar

```
  12-week practice arc (sane pace, alongside building)
  ────────────────────────────────────────────────────

  weeks 1-4    Tier 1   dynamic programming canon
                          → highest-leverage gap, do this first

  weeks 5-6    Tier 2   backtracking + binary search variants
                          → small surfaces, high frequency

  weeks 7-8    Tier 3   union-find + tries + sliding window
                          → fast wins, shallow techniques

  weeks 9-12   Tier 4   graph/tree variations + Tier 5 awareness
                          → depth over what you already own

  result: interview surface from "weak on DP / no DP / no
          tries / no union-find" to "comfortable across
          the senior loop"
```

## Recognition checklist — what "ready" looks like

```
  Per-topic readiness signals
  ───────────────────────────

  topic              "ready" looks like
  ─────              ──────────────────
  DP                 pattern-match new problem to a canon
                     shape in 2-3 min; write recurrence on
                     whiteboard before code; explain space
                     optimization step
  backtracking       write choose/recurse/undo from memory;
                     name why the undo is load-bearing
  binary search      lower_bound + upper_bound from memory;
                     solve one parametric search cold
  union-find         implement with rank + path compression;
                     solve number-of-islands two ways (DFS
                     and UF)
  trie               implement insert/search/startsWith from
                     memory; explain when trie beats Set
  sliding window     identify "window over array, slide,
                     update in O(1)" problems by shape;
                     know when to reach for monotone deque
```

## Honest framing — what this plan is NOT

This plan is *not* leetcode grind. It's not "300
problems in 90 days." It's the **shapes** that
recur: 6-10 canonical problems per technique, learned
deeply enough that variations are obvious in 2-3
minutes.

The bar this targets: a senior frontend / AI
engineering loop at Series B-to-large companies.
Competitive-programming-deep DP (digit DP, bitmask
DP, DP on trees with rerooting) is **out of scope**
unless you're targeting top-tier FAANG L6+ or
algorithm-heavy quant roles. Even there, the canon
above is the foundation those harder problems build
on.

What IS in scope: the techniques senior interviewers
actually expect, calibrated to "can you recognize the
shape and execute cleanly" — not "have you memorized
50 obscure problems."

## Anchors — where the practice happens

```
  Where to practice each technique
  ────────────────────────────────

  language: TypeScript (your daily tool — translates
            cleanly to interview pseudo-code)

  workspace: reincodes (you already have it set up with
             your own DSA implementations to compare
             against)

  problem source:
    - DP canon         → NeetCode 150 DP section
                          (well-curated, has video walkthroughs)
    - backtracking     → NeetCode "Backtracking" section
    - binary search    → NeetCode "Binary Search" + LeetCode
                          parametric-search list
    - union-find       → LeetCode "Union Find" tag
    - tries            → LeetCode "Trie" tag (top 8 problems
                          cover the surface)
    - sliding window   → NeetCode "Sliding Window" section
```

## Top finding — the one-line summary

**The single highest-leverage move is closing the
dynamic-programming gap.** You've built trees, graphs,
heaps in reincodes; you've built hash-map-and-array
mastery in blooming-insights. DP is the only major
technique missing from both, it shows up constantly
in interviews, and you can land it in 3-4 weeks of
focused practice on the canonical six shapes.

## See also

- `01-complexity-and-cost-models.md` — amortized
  comes back hard in DP and union-find
- `03-stacks-queues-deques-and-heaps.md` — sliding-
  window max needs the monotone deque
- `04-trees-tries-and-balanced-indexes.md` — trie
  is the Tier-3 implementation target
- `05-graphs-and-traversals.md` — Tier 4 builds
  variations on what you already have
- `06-sorting-searching-and-selection.md` — binary
  search variants are Tier 2
- `07-recursion-backtracking-and-dynamic-
  programming.md` — the fundamentals for Tier 1 and
  Tier 2

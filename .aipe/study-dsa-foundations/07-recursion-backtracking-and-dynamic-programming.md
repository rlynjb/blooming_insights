# Recursion, backtracking, and dynamic programming

*State spaces · memoization · tabulation · Industry standard*

## Zoom out, then zoom in

Recursion shows up in this codebase in exactly one shape: JSON parsing (V8 native) and the fault-injector's CDF walk (which is technically a loop, not recursion). Backtracking doesn't appear. Dynamic programming doesn't appear. This is the file where the honest "curriculum gap" shows up loudest — you have practice to do here that doesn't map onto the repo.

```
  Zoom out — recursion / backtracking / DP in blooming_insights

  ┌─ UI ────────────────────────────────────────────────────────┐
  │  (nothing here — no recursive components, no DP)            │
  └─────────────────────────┬───────────────────────────────────┘
                            │
  ┌─ Agent / route layer ───▼───────────────────────────────────┐
  │  · JSON.parse — recursive descent (V8 internal, not yours) │
  │  · aptkit agent loop — iterative, not recursive             │
  │  · fault-injecting.ts CDF walk — iterative accumulator      │
  └─────────────────────────┬───────────────────────────────────┘
                            │
  ┌─ Eval layer ────────────▼───────────────────────────────────┐
  │  · report/gate/baseline — iterative loops over receipts     │
  │  · load harness — iterative worker loop                     │
  └─────────────────────────────────────────────────────────────┘

  ┌─ Where recursion LIVES in your other work ─────────────────┐
  │                                                              │
  │  reincodes/BinarySearchTree.ts                               │
  │    · recursive insert / search / delete                      │
  │    · pre / in / post-order traversals                        │
  │                                                              │
  │  reincodes/Tree.ts                                           │
  │    · pre / post traversal via generators                     │
  │    · call-stack visualizers                                  │
  │                                                              │
  │  reincodes/PG.ts                                             │
  │    · BFS over implicit state graph (technically iterative)   │
  │                                                              │
  │  DP: not built in reincodes yet — curriculum gap             │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** Recursion is a function calling itself with a smaller problem. Backtracking is DFS on an implicit graph — try, fail, undo, try something else. Dynamic programming is "cache the subproblem answers so you don't recompute." All three share the same shape: decompose the problem, solve the pieces, combine. What varies is how you *store* the pieces.

## Structure pass

**Layers.** Two altitudes:
  1. the *decomposition* (split the problem into smaller subproblems)
  2. the *state* (nothing / call stack / cache table)

**Axis: how do you avoid recomputing?** Trace it down:
  - naive recursion → no state, recomputes everything, often exponential
  - memoized recursion (top-down DP) → hash-map cache, O(subproblem count)
  - tabulation (bottom-up DP) → array cache filled in order, O(subproblem count)
  - backtracking → no cache, but *prunes* by cutting hopeless branches

**Seams.** The load-bearing seam is between *overlapping subproblems* (DP earns its keep) and *disjoint subproblems* (plain recursion is fine). Fibonacci recomputes the same subproblems exponentially — DP takes it from O(2^n) to O(n). Merge sort's subproblems are disjoint — no DP needed, plain recursion is O(n log n).

## How it works

### Move 1 — recursion is "shrink the problem, call yourself, combine"

You know functions. Recursion is a function that calls itself with a smaller version of the same problem. Every recursive function has two parts:

```
  Recursion — the two-part skeleton

  function solve(problem):
    if problem is trivial:            ← BASE CASE (terminates)
      return direct answer

    smaller = shrink(problem)          ← the "make it smaller" step
    piece = solve(smaller)             ← RECURSIVE CALL
    return combine(piece, problem)     ← what to do with the piece
```

**What breaks if you drop the base case?** Stack overflow. The recursion never terminates. The base case is the load-bearing part.

**What breaks if `shrink` doesn't actually make the problem smaller?** Same thing — infinite recursion. This is subtler; a common bug is calling `solve(n)` from inside `solve(n)` via a code path you didn't spot.

You built this in `reincodes/BinarySearchTree.ts`'s recursive traversals — the base case is `if node is null: return`, the shrink is descending to `node.left` or `node.right`, the combine is concatenating results.

### Move 2 — recursion in the codebase (there isn't much)

The one place recursion shows up in your own code in this repo is inside V8's `JSON.parse` — a recursive-descent parser that handles nested `{}` and `[]`. You don't own that code. Everything else here is iterative.

The closest thing to "recursion in your app code" is the aptkit agent loop, which is *iterative* — a `while` loop over model turns until the agent stops or hits a budget. It could be written recursively (each turn calls the next turn's function) but iteration is the sane choice for anything with unbounded depth — no risk of stack overflow.

The CDF walk in `fault-injecting.ts:86-106` isn't recursion either — it's an accumulator loop. But it's shaped like a recursion base case sequence:

```ts
// lib/data-source/fault-injecting.ts:86-106 — iterative CDF walk
let acc = 0;
if (r.timeout != null && r.timeout > 0) {
  acc += r.timeout;
  if (roll < acc) return this.fireTimeout(name);       // ← "base case" hit
}
if (r.rateLimit != null && r.rateLimit > 0) {
  acc += r.rateLimit;
  if (roll < acc) return this.fireRateLimit(name);     // ← "base case" hit
}
// ... etc
return this.inner.callTool(name, args, opts);          // ← default "base case"
```

Four branches, each a probability threshold. First one whose accumulated probability exceeds the roll wins. This is the *pattern* of a decision tree, unrolled into iteration for readability. Same shape you'd write for a recursive weighted-choice search — but iteration is fine because the branching is fixed.

### Move 2 — backtracking: DFS on an implicit graph

Backtracking is the standard tool for constraint-satisfaction problems: N-queens, Sudoku, subset-sum, graph coloring. The shape:

```
  Backtracking — try, fail, undo, try again

  function backtrack(state):
    if state is a complete solution:      ← BASE CASE (success)
      record it
      return

    for each choice from state:            ← BRANCHING
      if choice is valid:
        apply(choice)                       ← try
        backtrack(state + choice)           ← recurse
        undo(choice)                        ← unwind on return

    return                                  ← implicit "fail" (empty choices)
```

The load-bearing bits:

  **1. Base case for success.** Without it, the algorithm records nothing — you'd search the whole tree and return silence.

  **2. Validity check before recursing.** Without pruning, backtracking degenerates to exhaustive search — a Sudoku solve would try every cell = every digit, ~10^80 combinations. The pruning is what makes backtracking *work*.

  **3. Undo on return.** Without it, state accumulates across branches — the second sibling's search starts from wherever the first sibling ended. Correctness bug that's easy to write.

Example — N-queens:

```
  N-queens (n=4) — one backtracking trace

  place queen in row 0, col 0 → ok
    place queen in row 1, col 2 → ok
      place queen in row 2, col ?
        col 0? no (attacked by q0)
        col 1? no (attacked by q1)
        col 2? no (attacked by q1)
        col 3? no (attacked by q1 diagonally)
        → dead end, backtrack
      undo q at (1, 2)
    place queen in row 1, col 3 → ok
      place queen in row 2, col 1 → ok
        place queen in row 3, col ?
          col 0? no ...
          → dead end, backtrack
        undo q at (2, 1)
      ... etc
```

Not in this repo. Not in `reincodes` beyond the state-space BFS in `PG.ts` (which is BFS, not DFS-backtracking — different shape). Practice this as a standalone interview primitive.

### Move 2 — dynamic programming: cache the subproblem answers

The classic motivating example is Fibonacci:

```
  Naive recursion — exponential because subproblems repeat

  fib(5):
    fib(4) + fib(3)
     │        │
     │       fib(2) + fib(1)
     │        │        (1)
     │       fib(1) + fib(0)
     │        (1)     (0)
    fib(3) + fib(2)      ← already computed above, recomputed
     │        │
    ... etc

  time: O(2^n), because each fib(k) branches into two calls,
        and the tree isn't pruned
```

The DP fix — memoize the answer for each subproblem:

```
  Memoized (top-down) — hash-map cache prevents recompute

  cache = new Map<number, number>()

  function fib(n):
    if n < 2: return n                       ← base case
    if cache.has(n): return cache.get(n)     ← cache hit → O(1)
    result = fib(n - 1) + fib(n - 2)         ← recursive shrink
    cache.set(n, result)
    return result

  time: O(n), because each fib(k) is computed exactly once
  space: O(n) for cache + O(n) for call stack
```

Tabulation (bottom-up) — fill an array in order:

```
  Tabulated (bottom-up) — array filled in dependency order

  function fib(n):
    if n < 2: return n
    dp = new Array(n + 1)
    dp[0] = 0
    dp[1] = 1
    for i from 2 to n:                       ← fill in known order
      dp[i] = dp[i-1] + dp[i-2]
    return dp[n]

  time: O(n)
  space: O(n) — can be reduced to O(1) by keeping only the last two
```

**When to reach for DP:**
  - problem has *overlapping subproblems* (same subproblem solved many times in naive recursion)
  - problem has *optimal substructure* (optimal solution to whole = combination of optimal solutions to parts)

Classic DP problems: longest common subsequence, edit distance (Levenshtein), coin change, 0/1 knapsack, matrix chain multiplication, longest increasing subsequence. None are in this repo. Interview-prep territory.

### Move 2 — the memoization axis: top-down vs bottom-up

The tradeoff between the two DP flavors is subtle. Same time complexity, different characteristics:

```
  Top-down (memoized) vs Bottom-up (tabulated)

                    top-down (memoized recursion)     bottom-up (tabulation)
                    ─────────────────────────────     ──────────────────────
  code shape        recursion + cache                 loops filling array
  hits              only subproblems reached          all subproblems in range
  call stack        O(depth) — can overflow           O(1) — flat iteration
  cache miss cost   O(1) hash lookup                  O(1) array index
  natural fit       sparse subproblem space           dense subproblem space
  when to prefer    you don't hit every subproblem    you fill the whole table
```

For Fibonacci, both are fine. For "longest palindromic substring" where the DP table is dense, bottom-up wins because you fill everything anyway. For "coin change with a sparse denomination set" where most subproblems are unreachable, top-down wins because you only compute what you need.

### Move 3 — the principle

**Recursion is the shape; DP is the shape *with a cache*; backtracking is the shape *with pruning*.** They're the same skeleton — decompose, recurse, combine — with different answers to "what state do I keep between calls?" Nothing (plain recursion) → the call stack (backtracking) → a hash map or array (DP). Learn the skeleton once and the variants become "which state store fits this problem?"

## Primary diagram

The whole family — same shape, different state management.

```
  Recursion / backtracking / DP — one skeleton, three state models

  ┌─ PLAIN RECURSION ─────────────────────────────────────────┐
  │                                                            │
  │  no cache, no pruning                                      │
  │  works when subproblems are DISJOINT                       │
  │  · merge sort         (T(n) = 2T(n/2) + O(n) = O(n log n)) │
  │  · BST traversals                                          │
  │  · tree recursion in reincodes                             │
  └────────────────────────────────────────────────────────────┘

  ┌─ BACKTRACKING ────────────────────────────────────────────┐
  │                                                            │
  │  no cache, but PRUNES hopeless branches                    │
  │  works when the search space is a tree of choices          │
  │  · N-queens                                                │
  │  · Sudoku                                                  │
  │  · subset sum                                              │
  │  · not in reincodes yet ← practice target                  │
  └────────────────────────────────────────────────────────────┘

  ┌─ DYNAMIC PROGRAMMING ─────────────────────────────────────┐
  │                                                            │
  │  cache subproblem answers                                  │
  │  works when subproblems OVERLAP                            │
  │  · Fibonacci                                               │
  │  · longest common subsequence                              │
  │  · edit distance                                           │
  │  · coin change                                             │
  │  · not in reincodes yet ← practice target                  │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

Recursion as a formal concept comes from Kleene's fixed-point theorem (1930s) and Church's lambda calculus (same era). The `Y combinator` in lambda calculus is how you define recursion without giving the function a name — an elegant but impractical trick. In real languages, recursion is a call-stack game.

Dynamic programming was named by Richard Bellman in the 1950s. He chose "dynamic programming" because "programming" was 1950s-speak for "planning" (as in linear programming), and "dynamic" made the name sound impressive to funders — the actual meaning is "solving a sequence of overlapping subproblems." Bellman's optimality principle (an optimal policy has the property that whatever the initial state, the remaining decisions must be optimal with regard to the state resulting from the first decision) is the theoretical backbone.

Memoization is the top-down implementation; tabulation is the bottom-up. Both compute the same subproblems; the difference is control flow. In FP languages, `memoize(f)` is a higher-order function that wraps any pure function in a cache — this is why Haskell's lazy evaluation gets memoization "for free" via CAFs (constant applicative forms) in some cases.

Backtracking as a general technique goes back to Golomb and Baumert (1965). The classic reference for its use is Knuth's "Dancing Links" (2000) for exact-cover problems like Sudoku — a beautiful data structure that makes the "undo" step O(1). Worth reading once for the "wait, that works?" moment.

DP has enough sub-topics to fill a course: state compression, bitmask DP, digit DP, interval DP, tree DP, DP on subsets, DP on graphs. Competitive-programming DP goes very deep. For working engineers, understanding the three canonical shapes (longest-common-subsequence, edit-distance, 0/1 knapsack) is enough to recognize the pattern in the wild.

Related reading: CLRS chapter 15 (DP), 34 (NP-completeness — many backtracking problems are NP-hard). "Introduction to Algorithms" or Kleinberg-Tardos both have solid DP chapters. For DP as a mental discipline, "Algorithms" by Dasgupta-Papadimitriou-Vazirani has the clearest introduction — freely available online.

## Interview defense

**Q: Explain when to memoize vs when to tabulate.**

Both give you the same time complexity; the tradeoff is control flow and stack depth. Memoize (top-down) when the recursion is natural, the subproblem space is sparse (you don't hit every combination), or the base case is easier to write recursively. Tabulate (bottom-up) when the subproblem space is dense (you fill every cell), when you're worried about stack overflow on deep recursion, or when you can reduce space by only keeping the last few rows. In interviews, I usually write memoized first (the recursion mirrors the problem definition) and then convert to tabulation if the interviewer asks about space optimization.

```
  Choose the DP flavor

  natural recursion + sparse hits  → memoize (top-down)
  dense DP table                    → tabulate (bottom-up)
  deep recursion, stack concerns    → tabulate
  optimizing space to O(1)          → tabulate + rolling window
```

**Anchor:** "Memoize when the recursion mirrors the problem; tabulate when you fill the whole table or need bounded stack."

**Q: You haven't built DP in reincodes. What's your practice plan?**

Honest answer: three problems, one per week, ramping in shape. Week one: Fibonacci and coin change — both linear-DP, both hit the "overlapping subproblems → cache" insight cleanly. Week two: longest common subsequence and edit distance — 2D DP tables, teaches you to reason about "what does dp[i][j] mean?" Week three: 0/1 knapsack — bounded resources, teaches the "include vs exclude" decision pattern. That's the canonical DP progression from every algorithms textbook and covers 80% of what shows up in interviews. Once those are cold, I'd add tree DP (house-robber-on-a-tree) and bitmask DP (traveling salesman with n=20). I'd implement each in TypeScript and check in to my reincodes repo the same way I did the graph and heap primitives.

**Anchor:** "Fibonacci → LCS/edit distance → 0/1 knapsack is the canonical DP ladder; three problems get you the pattern."

**Q: N-queens is backtracking. Why not brute-force?**

Brute-force would try every placement of N queens in N² cells — C(N², N) = ~N^(2N)/N! placements for N=8, that's ~40 million. Backtracking prunes: as soon as a queen is placed, we skip all future placements that would put another queen in the same column or diagonal. For N=8, backtracking finds all 92 solutions in a few thousand steps — a 10,000× speedup from pruning alone. The pattern generalizes: any CSP (constraint-satisfaction problem) benefits from backtracking + constraint propagation. Sudoku is the classic example.

```
  Brute-force vs backtracking for N-queens (N=8)

  brute-force:  C(64, 8) ≈ 4 × 10⁹ placements
  backtracking: ~2000 nodes explored (99.99995% pruned)
```

**Anchor:** "Backtracking = DFS with a validity check that prunes hopeless branches — it's the difference between minutes and years on constraint problems."

**Q: This codebase has no recursion. Is that a red flag?**

No — it's the right call for the shapes involved. The agent loop is iterative because model-turn count is unbounded and stack depth is a real production risk. The eval loops are iterative because the receipt count is dynamic and streaming-style processing keeps memory flat. The one recursion in the app path — `JSON.parse` — is V8's problem, not yours. If a future feature added tree-shaped state (like a tree of investigation branches for a Tree-of-Thoughts agent), recursion would earn its keep there. Right now nothing's tree-shaped.

**Anchor:** "Iterative because everything here is a flat stream or a fixed sequence; recursion would earn its keep the moment tree-shaped state shows up."

## See also

  → `04-trees-tries-and-balanced-indexes.md` — the tree traversals you own in reincodes are the cleanest recursion examples
  → `05-graphs-and-traversals.md` — DFS is recursion on a graph; backtracking is DFS on an implicit graph
  → `01-complexity-and-cost-models.md` — DP is the primitive that takes exponential-time recursion to polynomial
  → `08-dsa-foundations-practice-map.md` — the ranked plan lists the DP ladder to practice

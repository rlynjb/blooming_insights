# Recursion, backtracking, and dynamic programming

*State spaces, repeated subproblems, memoization, tabulation — Industry standard · Case B (not exercised; taught from fundamentals)*

## Zoom out — recursion-shaped work in this repo (very little)

```
  Recursion / DP shapes in this codebase
  ──────────────────────────────────────

  ┌─ UI layer ────────────────────────────────────┐
  │  React itself recurses through the component   │
  │  tree (framework concern; you don't write it)  │
  └────────────────────────┬──────────────────────┘
                           │
  ┌─ Service layer ────────▼──────────────────────┐
  │  ★ NO RECURSIVE FUNCTIONS in lib/             │
  │  ★ NO BACKTRACKING                             │
  │  ★ NO DYNAMIC PROGRAMMING                      │
  │                                                │
  │  The closest thing: JSON.stringify/parse       │
  │  recurses internally — opaque to you           │
  └────────────────────────┬──────────────────────┘
                           │
  ┌─ Provider boundary ────▼──────────────────────┐
  │  Agent loop "explores" but the LLM picks the   │
  │  next move — no recursive search you wrote     │
  └───────────────────────────────────────────────┘
```

Verdict-first: this repo has **zero hand-written
recursion, zero backtracking, zero DP**. The agent
loops are iterative (an iteration budget plus a
while-loop inside AptKit); state is flat (Maps and
arrays); there are no overlapping subproblems anywhere.
The only recursion that runs is what
`JSON.stringify`/`JSON.parse` do internally on
nested objects, and that's opaque.

So this file is Case B end-to-end: teach recursion,
backtracking, and DP from fundamentals, anchored to
your reincodes work (Tree traversals as generators,
BST recursion) and to canonical interview problems.
The DP gap is real and consequential — it's the
single largest gap between this repo's surface and a
senior interview's surface.

## Structure pass — three techniques, one root question

Three techniques, one question held constant: *"is
this problem made of smaller versions of itself?"*

```
  One question, three answers
  ───────────────────────────

  "is this problem made of smaller versions of itself?"

  ┌─ Plain recursion ────────────────────┐
  │ YES, and each subproblem is unique   │
  │ → just recurse; nothing to cache     │
  │ examples: tree traversal, divide-    │
  │   and-conquer (merge sort, quicksort)│
  └──────────────────────────────────────┘

  ┌─ Backtracking ───────────────────────┐
  │ YES, and you're exploring CHOICES;   │
  │ when one path fails, undo and try    │
  │ another                              │
  │ examples: N-queens, sudoku, regex    │
  │   matching, generating permutations  │
  └──────────────────────────────────────┘

  ┌─ Dynamic programming ────────────────┐
  │ YES, and the SAME subproblem appears │
  │ many times → MEMOIZE / TABULATE      │
  │ examples: Fibonacci, longest common  │
  │   subsequence, coin change, knapsack │
  └──────────────────────────────────────┘
```

The seam where these flip: **whether subproblems
repeat**. Pure recursion when they don't. Backtracking
when you need to explore branches with undo.
DP when subproblems overlap enough that caching
amortizes the cost. Get this wrong (recurse a DP
problem without memoizing) and your runtime explodes
from O(N) to O(2^N).

Hand off to How it works.

## How it works

#### Move 1 — the mental model

You already use recursion every time React renders a
component that renders another component. The shape:
**a function that calls itself on a smaller version
of the input.** The smaller version is what makes it
terminate — without it, you'd loop forever.

```
  Recursion — the shape
  ─────────────────────

  function f(input):
    if input is base case:           ← termination
      return base answer
    smaller = reduce(input)          ← shrink the problem
    sub = f(smaller)                 ← recurse on smaller
    return combine(input, sub)       ← build answer from sub

  two parts that MUST be there:
    1. base case — otherwise infinite recursion
    2. reduction toward base — otherwise also infinite
```

The most common recursion shape — your BST traversal
in reincodes:

```ts
// reincodes — BinarySearchTree.ts
function inorder(node):
  if node == null:                   // base case
    return
  inorder(node.left)                 // recurse left
  visit(node.value)                  // process self
  inorder(node.right)                // recurse right
```

That's the kernel. Three lines, the entire algorithm.
Pre-order moves `visit(node)` to the top; post-order
moves it to the bottom. Same recursion, different
visit time.

```
  Recursion execution — call stack for inorder
  ────────────────────────────────────────────

  tree:        5
             ╱   ╲
           3       8
          ╱ ╲
         1   4

  inorder(5)
    inorder(3)
      inorder(1)
        inorder(null) → return
        visit(1)                    ← 1 emitted
        inorder(null) → return
      visit(3)                      ← 3 emitted
      inorder(4)
        inorder(null) → return
        visit(4)                    ← 4 emitted
        inorder(null) → return
    visit(5)                        ← 5 emitted
    inorder(8)
      inorder(null) → return
      visit(8)                      ← 8 emitted
      inorder(null) → return

  result: 1, 3, 4, 5, 8             ← sorted! the BST payoff
```

The call stack IS your data structure here. Each
recursive call pushes a frame; each return pops one.
**The break case if you go too deep:** stack
overflow. Languages typically allow 10,000-100,000
frames before they blow. For balanced trees that's
fine (depth = log N). For degenerate trees
(insert-sorted) it's a real risk.

#### Move 2 — the three techniques worked through

**Plain recursion — divide and conquer**

The cleanest example: merge sort. Split, recurse on
both halves, merge.

```
  PSEUDOCODE — merge sort
  ───────────────────────

  function mergeSort(arr):
    if arr.length <= 1:                 // base case
      return arr
    mid    = arr.length / 2
    left   = mergeSort(arr[0..mid])     // recurse left
    right  = mergeSort(arr[mid..end])   // recurse right
    return merge(left, right)           // combine

  function merge(a, b):
    result = []
    i = j = 0
    while i < a.length and j < b.length:
      if a[i] <= b[j]:
        result.push(a[i++])
      else:
        result.push(b[j++])
    return result + a[i..] + b[j..]    // drain remaining

  cost: T(N) = 2·T(N/2) + O(N)         // master theorem
                                        // → T(N) = O(N log N)
```

You've implemented this in reincodes (Sorting/
visualizers — merge sort animation). The animation
showing recursion *splitting* then *merging back* is
the picture to keep.

**Backtracking — explore-with-undo**

Backtracking is recursion plus "try a choice, recurse,
if it fails undo the choice and try another." The
canonical example: N-queens.

```
  N-queens — place 8 queens on an 8x8 board so none attack
  ────────────────────────────────────────────────────────

  PSEUDOCODE
  ──────────
  function place(row, board):
    if row == N:                        // all queens placed
      record(board)
      return
    for col in 0..N-1:
      if safe(row, col, board):         // doesn't attack any prior queen
        board[row] = col                // CHOOSE
        place(row + 1, board)           // RECURSE
        board[row] = -1                 // UNDO  ← the backtracking move

  load-bearing parts (what breaks if you remove each):
    - the safe() check       ← would place attacking queens
    - the recursion          ← would only try one row
    - the UNDO step          ← side-effects from one branch
                                pollute the next branch
```

**The hallmark of backtracking: the explicit "undo"
after the recursive call.** You're maintaining
mutable state (the board) across calls, and you have
to leave it the way you found it for sibling branches.
If you don't undo, branch B inherits branch A's
choices and you produce garbage.

This repo has zero backtracking; the right anchor for
practicing it is the river-crossing puzzle in your
reincodes `PG.ts`, which solves the same shape with
BFS instead. BFS is *not* backtracking — it explores
states in parallel by enqueueing them all — but the
problem class is the same: search a state space.
Backtracking is the depth-first variant with
explicit undo.

**Dynamic programming — caching repeated subproblems**

The Fibonacci example everyone uses, because it
shows the catastrophe of *not* caching:

```
  Naive recursive Fibonacci — overlapping subproblems
  ───────────────────────────────────────────────────

  function fib(n):
    if n < 2: return n
    return fib(n - 1) + fib(n - 2)

  call tree for fib(5):

                  fib(5)
                /        \
            fib(4)        fib(3)
            /    \        /    \
        fib(3)  fib(2)  fib(2) fib(1)
        /   \    / \    / \
     fib(2) fib(1) ...

  fib(3) computed TWICE, fib(2) THREE times.
  cost: O(2^N) — exponential
```

The fix is *memoization*: cache each subproblem's
answer the first time you compute it, return the
cached value on subsequent calls.

```
  Memoized Fibonacci — top-down DP
  ────────────────────────────────

  cache = Map()                          // memo table

  function fib(n):
    if n < 2: return n
    if cache.has(n): return cache.get(n) // ← the cache check
    result = fib(n - 1) + fib(n - 2)
    cache.set(n, result)
    return result

  cost: O(N) — each subproblem computed once
```

The other flavor is *tabulation*: build the answers
bottom-up in a table, no recursion.

```
  Tabulated Fibonacci — bottom-up DP
  ──────────────────────────────────

  function fib(n):
    if n < 2: return n
    dp = [0, 1]
    for i in 2..n:
      dp[i] = dp[i-1] + dp[i-2]
    return dp[n]

  cost: O(N) time, O(N) space
  → can reduce to O(1) space by only keeping last two
```

**The DP skeleton — five parts:**

1. **Define the subproblem** — what does `dp[i]`
   mean? "Best answer considering the first `i`
   inputs." **What breaks without it:** you can't
   write the recurrence.

2. **Write the recurrence** — `dp[i] = f(dp[i-1],
   dp[i-2], ...)`. **What breaks without it:** no
   algorithm, just a name.

3. **Identify base cases** — what's the answer for
   the smallest input? **What breaks without it:** the
   recurrence has nowhere to bottom out.

4. **Choose direction** — top-down (recursion +
   memo) or bottom-up (iteration + table). Both work;
   bottom-up uses less stack.

5. **Optimize space if possible** — if `dp[i]` only
   depends on `dp[i-1]` and `dp[i-2]`, you don't need
   the whole array. **What breaks without it:** O(N)
   space when O(1) was possible.

This is the technique that doesn't show up in
blooming-insights and is the highest-leverage gap to
close before a senior interview. The practice plan in
`08-dsa-foundations-practice-map.md` sequences the
canonical DP problems.

#### Move 2.5 — recursion → iteration conversion

Any recursion can be converted to iteration using an
explicit stack. Three reasons to do it:

1. **Avoid stack overflow** on very deep recursion.
2. **Save function-call overhead** in hot loops.
3. **Get tail-call optimization** in languages that
   don't auto-TCO (most JS engines do not).

The pattern:

```
  Recursion → iteration with explicit stack
  ─────────────────────────────────────────

  recursive                          iterative
  ─────────                          ─────────
  function dfs(node):                stack = [start]
    if node == null: return          while stack not empty:
    visit(node)                        node = stack.pop()
    dfs(node.left)                     if node == null: continue
    dfs(node.right)                    visit(node)
                                       stack.push(node.right)
                                       stack.push(node.left)
                                       //          ↑
                                       //  push RIGHT first so
                                       //  LEFT pops first — same
                                       //  traversal order as recursion
```

You've implemented both in reincodes (BST insert is
shown both recursive and iterative). The iterative
version is what you reach for when N might be very
deep.

#### Move 3 — the principle

Recursion is a description style — "the answer for N
in terms of the answer for N-1 (or N/2, etc.)."
Backtracking is recursion plus undo — used when you
explore alternatives and one branch's state must not
leak into another's. Dynamic programming is recursion
plus memoization — used when subproblems repeat
exponentially often. The decision is *not* "which
technique?", it's *"do my subproblems overlap?"* If
no, plain recursion. If yes and you're exploring
choices, backtracking. If yes and you're optimizing
a value, DP.

## Primary diagram

```
  The three techniques — pick by the subproblem shape
  ───────────────────────────────────────────────────

  ┌──────────────────────────────────────────────────────┐
  │ situation                       technique            │
  ├──────────────────────────────────────────────────────┤
  │ recurse, each subproblem        plain recursion      │
  │ unique                          (tree ops, merge     │
  │                                  sort, quicksort)    │
  │                                                      │
  │ explore choices, each branch    backtracking         │
  │ tries one option then undoes    (N-queens, sudoku,   │
  │                                  permutations)       │
  │                                                      │
  │ optimal value, subproblems      dynamic programming  │
  │ overlap (same args called       (memoization or      │
  │ exponentially often)             tabulation)         │
  │                                                      │
  │ recursion too deep to fit       iterative + explicit │
  │ on the call stack               stack                │
  └──────────────────────────────────────────────────────┘

  blooming-insights uses NONE of these.
  Anchors live in reincodes: Tree.ts (n-ary recursion
  with generators), BinarySearchTree.ts (recursive +
  iterative variants).
```

## Elaborate

Dynamic programming was named by Richard Bellman in
the 1950s — the term was chosen partly to sound
impressive to grant funders, not because it
describes the technique well. A more honest name
would be "recursion with caching." The canonical
problems — Fibonacci, longest common subsequence,
edit distance, coin change, knapsack, matrix-chain
multiplication, longest increasing subsequence —
are worth knowing as patterns, because most DP
problems are variations on these few shapes.

The space-optimization step (notice `dp[i]` only
depends on `dp[i-1]` and `dp[i-2]` → keep two
variables, not an array) is the move that separates
"I know DP exists" from "I can write production DP
code." Interview problems frequently *require* the
space optimization for the solution to fit memory
constraints.

Backtracking is the direct ancestor of constraint
solvers (SAT, SMT) and game-tree search (alpha-beta
pruning). Both add pruning heuristics on top of
backtracking's "try, undo" skeleton. Real chess
engines are backtracking + alpha-beta + transposition
tables (a DP-style cache of previously-evaluated
positions).

Recursion's deepest payoff is *divide and conquer* —
the proof technique that gets you the master theorem
(T(N) = a·T(N/b) + f(N)). Merge sort, quicksort,
binary search, FFT, Karatsuba multiplication are all
divide-and-conquer. The recurrence relation IS the
analysis.

For deep grounding: CLRS Chapters 4 (divide and
conquer), 15 (dynamic programming), and the
backtracking material in Chapter 16. Sedgewick
*Algorithms 4th Ed* §1.1 (recursion warmup), §6.3
(reductions and intractability).

## Interview defense

**Q: Walk me through Fibonacci three ways: naive,
memoized, tabulated.**

Model answer: "Naive recursion is `fib(n) = fib(n-1)
+ fib(n-2)`, base cases `fib(0)=0`, `fib(1)=1`. Cost
is O(2^N) because the call tree has overlapping
subproblems — `fib(3)` computed three times in
`fib(5)`. Memoization adds a cache: check the map
before recursing, store after computing. Cost drops
to O(N), one entry per subproblem. Tabulation skips
recursion entirely — build `dp[0..n]` bottom-up.
Same O(N), no stack risk. The final move: since
`dp[i]` only depends on `dp[i-1]` and `dp[i-2]`,
keep two variables instead of an array — O(1)
space."

**Q: What's the most-forgotten part of backtracking?**

Model answer: "The undo step after the recursive
call. The kernel is choose → recurse → undo, and
people skip the undo because in simple examples the
code happens to work. The break case: mutable state
from one branch pollutes the next sibling branch.
For N-queens, that means trying column 0 in row 0,
recursing, and never being able to try column 1 in
row 0 because the board still shows a queen at (0,
0). The explicit `board[row] = -1` after `place(row+
1)` returns is the load-bearing line."

**Q: When do you reach for DP vs greedy vs
backtracking?**

Model answer: "Greedy when each local choice is
provably optimal (Dijkstra, Huffman, interval
scheduling). DP when subproblems overlap and the
optimal solution decomposes into subproblems
(knapsack, LCS, edit distance). Backtracking when
you have to *enumerate* feasible solutions or find
*any* solution by exploring choices (N-queens,
sudoku, permutations). The decision tree: 'can I
prove a local choice is always right?' → greedy. If
not, 'do my subproblems overlap?' → DP. If they
don't overlap but I'm exploring → backtracking."

**Q: Why doesn't blooming-insights use any of these?**

Model answer: "The workload doesn't ask. The agent
loops are iterative with a budget — that's the
right shape because the LLM is the search policy, not
my code. State is flat (Maps and arrays); there's no
optimization problem that decomposes into overlapping
subproblems. If I grew an evaluator that scored
agent transcripts and wanted *optimal* tool sequences
(rather than the model's choice), DP or A* would
become relevant. Right now, the iterative budget +
LLM-as-policy combination is honest. Hands-on for
the missing techniques lives in reincodes (Tree.ts
recursive generators, BinarySearchTree.ts recursive
+ iterative variants) and on the practice plan."

## See also

- `03-stacks-queues-deques-and-heaps.md` — the
  call stack is itself a stack, and DFS via explicit
  stack mirrors recursion
- `04-trees-tries-and-balanced-indexes.md` — tree
  operations are the canonical first recursion
- `05-graphs-and-traversals.md` — DFS is recursion;
  backtracking is DFS with undo
- `08-dsa-foundations-practice-map.md` — the DP
  canon (Fibonacci, LCS, edit distance, knapsack, coin
  change, LIS) on the practice plan

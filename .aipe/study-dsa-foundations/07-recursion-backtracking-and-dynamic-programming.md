# Recursion, backtracking, and dynamic programming

Industry names: recursion, tail call, backtracking / state-space search, memoization, tabulation, dynamic programming. Type: Industry standard.

## Zoom out — no recursion, no DP, one iterative walk

This is the most honest `not yet exercised` chapter in the guide. The codebase has no recursion (the one candidate — `formatError` — was written iteratively for a good reason), no backtracking, and no DP. The nearest thing is `BudgetTracker` — a running accumulator — but that's an *accumulator*, not DP. Accumulators combine as you go; DP breaks a problem into overlapping subproblems and remembers their answers.

```
  Where recursion / DP could land

  ┌─ Transport layer ───────────────────────────────┐
  │  formatError: iterative walk of cause chain     │  ← iterative on purpose
  └─────────────────────────────────────────────────┘

  not yet exercised: recursion (all traversals are iterative)
  not yet exercised: tail-call optimization (JS engines skip it anyway)
  not yet exercised: backtracking (no state-space search)
  not yet exercised: memoization
  not yet exercised: tabulation
  not yet exercised: dynamic programming in any form
```

## Structure pass — the axis is *how you decompose a problem*

Axis: **how does this algorithm break the input into smaller pieces, and does it reuse those pieces?**

- **Iteration**: process one element at a time; state is a running accumulator; no subproblems.
- **Recursion**: reduce input to a smaller version of the same problem; combine the answer with the current step.
- **Backtracking**: recurse *and* undo — try an option, recurse, if it doesn't work restore state and try another.
- **DP**: recurse *and* remember — same subproblems appear multiple times; cache the answer.

The seam is *whether subproblems overlap*. If they don't, you don't need DP — you need recursion or backtracking. If they do (Fibonacci is the canonical example), memoization turns an exponential recursion into a polynomial one.

## How it works — the one anchor and the three missing kernels

### Move 1 — the recursion kernel

Recursion has one shape: **base case + reduction step**. Miss either and you're broken.

```
  Recursion kernel

  function solve(input):
    if input is base case: return answer          // ← the terminator
    smaller = reduce(input)                        // ← must be strictly smaller
    return combine(current step, solve(smaller))

  what makes it a recursion: solve calls solve on strictly-smaller input
  what breaks it           : missing base case → stack overflow
                            : reduction not smaller → infinite recursion
```

The single fact worth memorizing: **a while loop and a recursion are the same computation.** Every recursion has an iterative equivalent using an explicit stack; every iterative loop with an accumulator has a recursive equivalent. Pick whichever expresses the *shape of the problem* better.

### Move 2 — the one iterative anchor + when recursion wins

**Iterative cause-chain walk** — `lib/mcp/transport.ts:82-97`.

This is the code from `04-trees-tries-and-balanced-indexes.md`, revisited from the recursion angle:

```ts
// lib/mcp/transport.ts:82-97
export function formatError(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  let depth = 0;
  while (cur && depth < 5) {                    // ← iterative loop
    if (cur instanceof Error) {
      parts.push(cur.stack ?? cur.message);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(String(cur));
      cur = null;
    }
    depth++;
  }
  return parts.join('\n  caused by: ');
}
```

The recursive version would look like:

```
  // pseudocode — the recursive shape
  function formatErrorRec(e, depth = 0):
    if e is null or depth >= 5: return []              // ← base cases (both!)
    if e is Error:
      return [e.stack ?? e.message, ...formatErrorRec(e.cause, depth + 1)]
    else:
      return [String(e)]                                // ← non-Error base case
```

Both work. Both are correct. But the iterative version was picked. Two reasons:

1. **The depth cap is visible.** In the iterative form, `depth < 5` is right there in the loop condition. In the recursive form, it's tucked inside a base case; a maintainer could miss it and turn "iterate the chain" into an unbounded recursion.
2. **JavaScript doesn't tail-call optimize.** V8 removed TCO support after briefly having it in Safari. A deeply-nested chain (even one bounded at 5 here — hypothetically deeper elsewhere) would burn stack frames. Iteration is O(1) stack; recursion is O(depth) stack.

That's the transferable lesson: **in JS/TS, prefer iteration unless the recursive shape genuinely helps you.** In languages with TCO (Scala, Erlang, some LISPs) the tradeoff flips.

### Move 2 (continued) — the three missing primitives, taught anyway

**`not yet exercised`: recursion for tree/graph traversal.**

The canonical recursion example is a binary tree traversal:

```
  Recursive in-order traversal — a tree that isn't in this repo

  function inorder(node):
    if node is null: return                    // ← base case
    inorder(node.left)                          // ← recurse smaller
    visit(node)                                 // ← in-order: process between
    inorder(node.right)                         // ← recurse smaller
```

The base case is `null`; the reduction is "walk one child pointer down." Every path in the tree terminates because trees are finite.

**`not yet exercised`: backtracking.**

Backtracking is recursion + undo. Try an option, recurse, if the recursion says "no good" restore the state and try another option. It's the algorithm behind Sudoku solvers, N-queens, permutation generation, and word search on a grid.

```
  Backtracking kernel

  function backtrack(state):
    if state is complete: record solution; return
    for each choice in candidates(state):
      apply(choice, state)                       // ← try
      backtrack(state)                            // ← recurse
      undo(choice, state)                         // ← the "back" in backtrack

  what makes it backtracking: undo before trying the next option
  what breaks it            : forgetting undo → state bleeds between branches
```

Load-bearing part — **the undo step, right before the next iteration.** Forget it and every recursive branch inherits the last one's mutations, so the search space collapses. This is the interview trap.

Where it would land in a codebase like this: any "generate all valid combinations under constraint C" problem. Nothing in Blooming Insights needs one today. If you ever built a "pick 5 anomalies whose combined severity is above threshold X, don't repeat categories" feature, backtracking would fit.

**`not yet exercised`: dynamic programming.**

DP is recursion + memoization (top-down) or a table filled bottom-up (tabulation). The two conditions that make DP applicable:

1. **Overlapping subproblems** — the same recursive call happens many times.
2. **Optimal substructure** — the answer to the whole problem is composed from answers to sub-problems.

Fibonacci is the canonical example — `fib(5)` calls `fib(3)` and `fib(4)`; `fib(4)` also calls `fib(3)`. Naive recursion is O(2^n); memoization drops it to O(n).

```
  Fibonacci — recursion vs memoization

  Naive recursion tree (fib(5)):
                          fib(5)
                         /       \
                     fib(4)      fib(3)
                     /    \      /    \
                 fib(3) fib(2) fib(2) fib(1)
                 ...

  → fib(3) computed TWICE, fib(2) THREE times → exponential total work

  Memoization:
    cache = {}
    function fib(n):
      if n in cache: return cache[n]              // ← the win
      if n < 2: return n
      answer = fib(n-1) + fib(n-2)
      cache[n] = answer
      return answer

  → each fib(k) computed exactly once → O(n) total
```

For DP, the interview vocabulary is: **state definition** (what the subproblem is), **transition** (how you go from one state to the next), **base case** (where recursion stops), **order of computation** (top-down memoized vs bottom-up tabulation).

Where it would land in this repo: nowhere today. The nearest problem shape is *"given a budget, pick the subset of investigations that maximizes some quality score."* That's a knapsack problem, DP-tractable. Not built.

### Move 3 — the principle

Recursion, backtracking, and DP are all the same primitive with different constraints:
- **Recursion** — recurse, no state changes to undo.
- **Backtracking** — recurse and *undo state before the next branch*.
- **DP** — recurse and *remember answers to subproblems that repeat*.

If subproblems don't overlap, DP doesn't help; you're just doing recursion. If state isn't mutable, backtracking's undo is a no-op. The muscle memory for interviews: name the base case first, prove reduction, then ask about repeats and mutations.

## Primary diagram — the three shapes, one skeleton

```
  Recursion family — same kernel, different constraints

  ┌─ Recursion ─────────────────────────────────────┐
  │  base case + reduce + combine                    │
  │  fits: tree walks, divide-and-conquer sorts      │
  │  cost: T(n) = f(n) + T(reduced)                  │
  └─────────────────────────────────────────────────┘
              │  add mutable state + undo
              ▼
  ┌─ Backtracking ──────────────────────────────────┐
  │  recurse; try; undo; try next                    │
  │  fits: state-space search (Sudoku, N-queens)    │
  │  cost: exponential in choice-tree depth          │
  └─────────────────────────────────────────────────┘

  ┌─ Recursion ─────────────────────────────────────┐
  │  base case + reduce + combine                    │
  └─────────────────────────────────────────────────┘
              │  add memoization
              ▼
  ┌─ Dynamic programming ───────────────────────────┐
  │  recurse; cache; reuse                           │
  │  fits: overlapping subproblems, opt. substructure│
  │  cost: polynomial in state-space size            │
  └─────────────────────────────────────────────────┘

  all three: base case is the terminator — miss it, blow the stack
```

## Elaborate

Recursion goes back to Church and Kleene's work on computability in the 1930s; the practical vocabulary (base case, reduction) crystallized in the LISP tradition (McCarthy, 1958). Backtracking as a named technique dates to Walker (1960) for permutation problems. Dynamic programming is Bellman (1957) — the name was chosen because Bellman's boss at RAND didn't like the word "programming" but "dynamic" sounded impressive. History books, no exaggeration.

For interviews, DP is the topic that separates candidates. The five DP problems every interviewer has memorized: **climbing stairs** (linear DP, warmup), **coin change** (unbounded knapsack), **longest common subsequence** (2D DP over strings), **edit distance** (Levenshtein — 2D DP with three transitions), **word break** (1D DP + set lookup). Practice these until you can write the recurrence in under a minute; the *hard* part is the state definition, not the code.

The recursion-vs-iteration decision in JavaScript deserves a note. V8 briefly supported proper tail calls (2016-ish, ES6 spec) then removed the implementation because it broke stack traces for debugging. Node's stack limit is around 10-11k frames. Deep recursion needs iterative rewrite or explicit-stack simulation; there's no compiler magic to save you. This is why the `formatError` chain walk at `lib/mcp/transport.ts:82` is iterative — the depth cap is small, but the shape sets the right habit.

## Interview defense

**Q: The `formatError` walk at `lib/mcp/transport.ts:82` is iterative. Rewrite it recursively — and defend which one you'd ship.**

Answer: Recursive version is straightforward — pass depth as a parameter, base case on `null` or `depth >= 5`, return a joined string of the current message plus the recursive call on `.cause`. I'd still ship the iterative version. Two reasons: JavaScript doesn't do tail-call optimization, so recursion consumes stack frames per level; and the depth cap is more visible in the loop condition than tucked inside a base case where a maintainer might overlook it.

```
  Iterative vs recursive — same computation, different tradeoffs

  iterative:  while (cur && depth < 5)      ← cap visible in condition
              → O(1) stack, O(depth) time

  recursive:  formatErrorRec(cur, depth=0)  ← cap hidden in base case
              → O(depth) stack, O(depth) time
              → JS has no TCO — real stack growth
```

Anchor: `lib/mcp/transport.ts:82-97`.

**Q: When would you reach for DP?**

Answer: Two conditions have to hold. First, the problem's recursive decomposition produces *overlapping subproblems* — the same subproblem shows up many times in the call tree. Second, the answer to the whole problem is composed from answers to sub-problems (optimal substructure). If both hold, memoize the recursive version (top-down) or fill a table (bottom-up) — either way the cost drops from exponential to polynomial in the state-space size.

The move I make first is naming the state: *what parameters uniquely identify a sub-problem?* If I can name the state, I can write the recurrence. If I can't, the problem probably isn't DP.

```
  DP decision — the two-part test

  Q1: do subproblems overlap in the recursion tree?  no → not DP
                                                     yes ↓
  Q2: does the answer compose from sub-answers?      no → not DP
                                                     yes ↓
  → DP. Memoize (top-down) or tabulate (bottom-up).
```

**Q: There's no backtracking in this repo — talk through the kernel.**

Answer: Recurse, but before the next branch, undo any state mutations you made for the current branch. The load-bearing part is the undo — forget it and mutations leak between branches, corrupting the search. The interview version: try a choice, recurse; if the recursion succeeds, propagate; if not, undo the choice and try the next option.

```
  Backtracking — the undo step is what makes it backtrack

  for each choice:
    apply(choice)     ← mutation
    if backtrack():   ← recurse
      return true
    undo(choice)      ← THIS LINE
  return false
```

Where it would fit in this codebase: nowhere today, but a "pick K non-overlapping investigations under a budget" feature would be a natural backtracking + memoization problem.

## See also

- `03-stacks-queues-deques-and-heaps.md` — every recursion has an iterative equivalent using an explicit stack.
- `04-trees-tries-and-balanced-indexes.md` — the tree walk shape this chapter cites.
- `05-graphs-and-traversals.md` — DFS is naturally recursive; the visited set is what backtracking's undo isn't.
- `08-dsa-foundations-practice-map.md` — the DP problems on the drill list.

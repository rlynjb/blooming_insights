# Recursion, backtracking, and dynamic programming

**Industry name(s):** recursion (direct, tail, mutual), backtracking (depth-first search of state spaces), dynamic programming (memoization / tabulation), divide and conquer
**Type:** Industry standard · Language-agnostic

> Three related techniques for problems that can be broken into smaller versions of themselves. **Recursion** is the syntax. **Backtracking** is recursion with explicit undo for state-space search. **Dynamic programming** is recursion plus memoization to avoid recomputing overlapping subproblems. **None of these are exercised in this codebase** — the code is flat, sequential, and never needs to solve a problem by reducing it to a smaller version of itself.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** **Not yet exercised.** The codebase has no recursive functions of its own. The only recursion in `lib/` and `app/` is `mkdir({recursive: true})` in `app/api/mcp/capture/route.ts` — and that recursion happens inside the Node standard library, not in the codebase's code. There's no backtracking — no state-space search where you try a choice, recurse, and undo on dead-end. There's no dynamic programming — no overlapping subproblems, no memoization table, no tabulation. Every algorithm here is a flat loop or a higher-order array operation (`.map`, `.filter`, `.reduce`). This is honest: the problems this codebase solves don't *call for* recursion. The next sections teach all three techniques, name the load-bearing kernels, and end with the triggers that would put them in this repo.

```
Zoom out — what this chapter teaches vs what the repo uses

┌─ Everywhere in the codebase ─────────────────────────────┐
│  flat loops, .map/.filter/.reduce, await sequences        │
│                                                            │
│  • no recursive function in lib/ or app/                  │  ← not yet exercised
│  • no backtracking (no state-space search)                │  ← not yet exercised
│  • no DP (no overlapping subproblems)                     │  ← not yet exercised
│  • no divide-and-conquer (no problem split into halves)   │  ← not yet exercised
└────────────────────────────┬─────────────────────────────┘
                             │
┌─ The one recursive thing ──▼─────────────────────────────┐
│  mkdir({recursive: true})                                  │
│  in app/api/mcp/capture/route.ts                          │
│  → recursion happens INSIDE Node's standard library,      │
│     not in our code                                        │
└──────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when does a problem call for recursion? The answer is when (a) the problem has a *natural self-similar structure* — solving it for N reduces to solving it for N-1 or N/2 (factorial, tree walks, divide-and-conquer sort), (b) you need to *explore a state space* with the ability to *undo* (n-queens, sudoku, maze solving — that's backtracking), or (c) you have *overlapping subproblems* where the same subcomputation appears in many recursion branches (Fibonacci, edit distance, coin change — that's dynamic programming). This codebase has none of these patterns. Its problems are flat data transformations: take an array, run some validators, produce a smaller array. The next sections walk all three techniques' kernels and end with the triggers that would put them in this repo.

---

## Structure pass

**Layers.** Each technique has the same three-layer stack: the **base case** (the recursion's stopping condition — load-bearing; miss it and you stack-overflow), the **recursive case** (the part that calls itself with a smaller input — must make progress toward the base case), and the **combination step** (how you build the answer for N from the answer for N-1 or smaller). For DP, add a fourth layer: the **memo** (the table that caches subproblem results so you don't recompute them).

**Axis: control.** Who decides what to recurse into, what to back off from, what to remember? For recursion, the caller drives — each call picks the next smaller problem. For backtracking, the algorithm tries-then-undoes — control flows forward on a guess and backward on a dead-end. For DP, the algorithm computes-once-cache-always — control flows up the dependency DAG of subproblems. Picking the wrong axis (treating a flat loop as recursion, or recursion as iteration) is the most common bug — and the most common code-review request ("rewrite this as a loop").

**Seams.** Two seams matter; both absent here. **Seam 1: recursion vs iteration.** Same algorithm, two phrasings — recursion is sometimes clearer (tree walks), iteration is always more efficient (no stack frames). **Seam 2: plain recursion vs memoized recursion.** Same recursive structure, two cost profiles — plain recursion recomputes overlapping subproblems exponentially; memoized recursion (top-down DP) computes each subproblem once. The codebase exercises neither today because it has no recursive structure to begin with.

```
Structure pass — recursion, backtracking, DP

┌─ 1. LAYERS ─────────────────────────────────────────┐
│  Base case (stop condition) · Recursive case (call  │
│  smaller version) · Combination step (build N from  │
│  N-1) · Memo (cache subproblem results, for DP)     │
└────────────────────────┬─────────────────────────────┘
                         │  pick the axis
┌─ 2. AXIS ─────────────▼──────────────────────────────┐
│  control: who picks the next subproblem, who decides │
│  when to back off, who decides what to cache         │
└────────────────────────┬─────────────────────────────┘
                         │  trace across layers, find flips
┌─ 3. SEAMS ────────────▼──────────────────────────────┐
│  S1: recursion vs iteration (same algo, two forms)   │
│      — absent (no recursion in this codebase)        │
│  S2: plain vs memoized recursion (DP)                │
│      — absent (no overlapping subproblems)           │
└────────────────────────┬─────────────────────────────┘
                         ▼
                 Block 4 — How it works
```

```
A real recursion seam — "do I recompute or remember?" answered two ways

┌─ Plain recursion ──┐    seam     ┌─ Memoized (DP) ───────┐
│  fib(n) = fib(n-1) │ ═════╪═════►│  memo[n] cached;       │
│         + fib(n-2) │  (it flips) │  fib(n) returns memo[n]│
│  cost: O(2^n)      │             │  if cached, else       │
│  (exponential —    │             │  computes once         │
│  recomputes fib(3) │             │  cost: O(n)            │
│  hundreds of times)│             │                        │
└────────────────────┘             └────────────────────────┘
        ▲                                       ▲
        └────── same axis (control), two answers ─┘
                → memoization is what turns exponential into linear
                  for problems with overlapping subproblems
```

The skeleton is mapped — the rest of this file teaches all three techniques.

---

## How it works

### Mental model

Three techniques, ordered by sophistication:

```
  RECURSION              — a function that calls itself
                           (need: base case + recursive case)

  BACKTRACKING           — recursion + explicit undo
                           (need: state, try a choice, recurse,
                            undo on dead-end)

  DYNAMIC PROGRAMMING    — recursion + memoization
                           (need: overlapping subproblems +
                            optimal substructure)
```

The trick everyone learns: recursion is just a loop in fancy clothes — usually. The exceptions are problems where the data structure is naturally recursive (trees) or where you need to *unwind* state (backtracking) or where memoization buys you exponential-to-polynomial speedup (DP). For everything else, write a loop.

### Move 1 — recursion (the syntax)

A recursive function calls itself with a smaller input. Two parts: the **base case** (the input is small enough to answer directly, no further recursion) and the **recursive case** (call yourself with a reduced input, combine the result).

```
factorial(n):
  if n <= 1: return 1          // base case
  return n * factorial(n - 1)  // recursive case

factorial(4):
  4 * factorial(3)
      3 * factorial(2)
          2 * factorial(1)
              return 1        ← base case
          return 2 * 1 = 2
      return 3 * 2 = 6
  return 4 * 6 = 24
```

```
the call stack during factorial(4):

  TOP   factorial(1)   ← currently executing
        factorial(2)
        factorial(3)
        factorial(4)
  BOTTOM (main)

  each call has its own frame: parameters, local vars, return address
  base case returns first; results bubble back up the stack
```

**Critical rules:**

1. **Every recursive call must reduce toward the base case.** `factorial(n-1)` reduces; `factorial(n)` doesn't (infinite recursion). `factorial(n+1)` actively moves away from the base case (stack overflow).

2. **The base case must terminate.** `if n == 1: return 1` works for `factorial(positive integer)`; for `factorial(-1)` it never hits and overflows. Real code defensively checks the precondition.

3. **Tail recursion** — when the recursive call is the *last* thing the function does — can be optimized into a loop by some compilers (Scheme, Scala, Kotlin with `tailrec`). JavaScript engines do NOT do this in practice (the spec allows it; no major engine implements it). Don't rely on tail-call optimization in JS.

**Where recursion shines:**

- **Tree walks** — `walk(node) { visit(node); for each child: walk(child); }` — natural fit for the data structure.
- **Divide and conquer** — sort, search, FFT, matrix multiply — split the problem, recurse, combine.
- **Mathematical definitions that are inherently recursive** — factorial, Fibonacci, Ackermann.
- **Backtracking** (next move).
- **Parser recursion** — recursive-descent parsers mirror the grammar's structure.

**Where iteration wins:**

- **Linear scans of arrays** — `for (const x of arr) ...` is clearer than `process(arr[0]) ; process_rest(arr.slice(1))`.
- **Fixed-step state machines** — explicit `state = 'A'; while (state !== 'done') ...` beats recursive state transitions.
- **Anywhere stack depth could exceed the call stack limit** — JavaScript's typical limit is ~10K-30K frames; recursion deeper than that overflows.

**In this codebase: not yet exercised.** Every loop is a `for` or a higher-order array method. The deepest "recursive structure" is the 2-level schema, which is read with two flat loops. The user's portfolio (`reincodes/Tree.ts`, `BinarySearchTree.ts`, sorting visualizers) has recursive implementations — the codebase doesn't reach for that style.

### Move 2 — backtracking (state-space search with undo)

Backtracking is recursion plus **explicit undo**. You try a choice, recurse, and if the recursion fails (no solution found), you undo the choice and try the next one. The classic kernel:

```
backtrack(state):
  if state is a complete solution:
    record/return solution
    return
  for each choice from state.candidates():
    apply choice to state
    backtrack(state)
    undo choice from state          // ← the "backtrack" part
```

**The four backtracking problems everyone learns:**

```
  problem        what's the state          what's a choice
  ────────────   ────────────────────      ─────────────────────────
  n-queens       board configuration       place a queen in next column
  sudoku         partial grid              fill next empty cell with 1-9
  subset sum     current subset            include/exclude next element
  maze solver    current position          step N/S/E/W
```

```
n-queens for N=4 — backtracking tree (abbreviated):

  place column 0:
    row 0 → place column 1:
      row 0 → conflict, fail
      row 1 → conflict, fail
      row 2 → place column 2:
        row 0 → conflict, fail
        row 1 → conflict, fail
        row 2 → conflict, fail
        row 3 → conflict, fail
        → UNDO column 1 row 2
      row 3 → place column 2:
        row 1 → place column 3:
          row 2 → SOLUTION!  ← record
                                 [0,3,1,2]
```

The "undo" is what makes it *backtracking* and not *enumerate all*. Without explicit undo, the algorithm would either modify state and never restore it (wrong solutions), or copy state on every branch (exponential memory).

**Where backtracking shows up:**

- **Constraint satisfaction** — n-queens, sudoku, scheduling under constraints.
- **Combinatorial generation** — generate all subsets, all permutations, all combinations.
- **Maze and puzzle solving** — find a path, find all paths, find the shortest path with constraints.
- **Compiler register allocation** — assign variables to registers under constraints.

**In this codebase: not yet exercised.** No constraint satisfaction problem. No combinatorial generation. No state-space search.

**What would trigger reaching for backtracking?** If an agent had to generate a *valid combination of tool calls* satisfying multiple constraints (call this before that; if A is called, can't call B; total token budget ≤ X), backtracking would be the natural search strategy. Today the tool calls are linear (the LLM decides what to call next; no constraint solver runs).

### Move 3 — dynamic programming (recursion + memoization)

Dynamic programming applies when a recursive problem has **overlapping subproblems** and **optimal substructure**. The same subcomputation appears in many recursion branches; memoizing it turns exponential into polynomial.

**Naive recursion for Fibonacci:**

```
fib(n):
  if n <= 1: return n
  return fib(n-1) + fib(n-2)

fib(5):
              fib(5)
              /    \
          fib(4)   fib(3)        ← fib(3) computed once here…
          /    \   /    \
       fib(3) fib(2)…  …          ← …and AGAIN here
       /    \
    fib(2) fib(1)
    /    \
  fib(1) fib(0)

  cost: O(2^n) — every node in the tree is a call
```

**Memoized recursion (top-down DP):**

```
memo = {}
fib(n):
  if n in memo: return memo[n]
  if n <= 1: return n
  memo[n] = fib(n-1) + fib(n-2)
  return memo[n]

  cost: O(n) — each fib(k) computed once, then cached
  space: O(n) — the memo
```

**Tabulation (bottom-up DP):**

```
fib(n):
  if n <= 1: return n
  table = [0, 1, ...]
  for i from 2 to n:
    table[i] = table[i-1] + table[i-2]
  return table[n]

  cost: O(n)
  space: O(n) — or O(1) if you only keep the last two values
```

**The DP recipe** (Steven Skiena's formulation):

1. Express the answer as a recursive function of smaller subproblems.
2. Identify the dimensions of state (what arguments does your recursive function take?).
3. Tabulate or memoize. Top-down (memoize) is easier; bottom-up (tabulate) saves stack space.

**The two preconditions:**

- **Overlapping subproblems** — the recursion tree has repeated nodes. Without overlap, memoization buys nothing (each subproblem is solved exactly once anyway, e.g. binary tree walk).
- **Optimal substructure** — the answer for N can be computed from optimal answers to smaller subproblems. Without it, DP doesn't apply (e.g. longest *simple* path in a graph is NP-hard precisely because optimal substructure fails).

**Where DP shows up:**

- **Sequence alignment** — edit distance, longest common subsequence, sequence-to-sequence matching.
- **Coin change** — fewest coins to make N cents; how many ways to make N cents.
- **Knapsack** — best subset of items under a weight constraint.
- **Longest increasing subsequence** — classic O(N²) DP, refinable to O(N log N).
- **Matrix chain multiplication** — optimal parenthesization.
- **Optimal binary search trees** — given access frequencies, build the BST that minimizes expected access time.

**In this codebase: not yet exercised.** No problem here has overlapping subproblems. The agent pipeline is a fixed sequence. The derivation functions are pure projections. The sort is one-shot. No optimization-under-constraints problem with subproblem structure.

**What would trigger reaching for DP?** If the recommendation agent had to *choose the optimal subset of recommendations to present* under a constraint (e.g., "fit 3 recommendations that together exceed K total expected impact and don't conflict"), that's a 0/1 knapsack variant — DP territory. Today recommendations are presented as-is, no optimization.

### Move 2 variant — the irreducible kernel of each technique

**Recursion kernel:**

```
RECURSION (the kernel)
─────────────────────────────────
  base case (must terminate)
  recursive case (must reduce input)
  combination step (build N from N-1's result)

  what breaks if missing:
    base case → infinite recursion → stack overflow
    reduction → infinite recursion → stack overflow
    combination → result for N never built; useless return
```

**Backtracking kernel:**

```
BACKTRACKING (the kernel)
─────────────────────────────────
  state representation
  candidate generation (what choices to try)
  recursion into chosen state
  undo step (the "backtrack")
  base case (complete solution or dead-end)

  what breaks if missing:
    undo → state corrupted across branches; wrong solutions
    candidate gen → can't explore the space
    base case → never recognize a solution or a dead-end
```

**DP kernel:**

```
DYNAMIC PROGRAMMING (the kernel)
─────────────────────────────────
  state (the subproblem identifier)
  recurrence (how N's answer builds from smaller subproblems)
  memo table (cache subproblem results)
  base case for the recurrence

  what breaks if missing:
    memo → exponential blowup (recompute every subproblem)
    recurrence → no way to combine subproblems
    state identifier → memo lookups miss (or collide); wrong answers
```

**Skeleton vs hardening:**

```
SKELETON                              HARDENING
─────────────────────────────         ─────────────────────────────────
recursion: base + recursive case      tail-call optimization (some langs)
backtracking: state + undo            constraint propagation (faster cuts)
DP: state + recurrence + memo         space-optimized DP (O(1) instead of O(N))
                                      iterative DP avoiding stack (bottom-up)
```

### Move 3 — the principle

**Recursion is for problems that are self-similar; iteration is for problems that aren't.** A flat list of items being transformed one at a time is not self-similar — write a loop. A tree being walked is self-similar — write recursion. A state space being searched with backtracking is self-similar — write backtracking recursion. A subproblem that overlaps with itself is *especially* self-similar — write DP.

The codebase has only flat-list-being-transformed problems today. That's why no recursion appears. The day it gets a problem with self-similar structure, recursion will be the right answer.

---

## Primary diagram

The three techniques, their kernel, when each applies, and the codebase's gap.

```
                THE RECURSION FAMILY — when to reach for each

  ┌────────────────────┬────────────────────────┬────────────────────────┐
  │ RECURSION          │ BACKTRACKING           │ DYNAMIC PROGRAMMING    │
  │ (plain)            │ (recursion + undo)     │ (recursion + memo)     │
  ├────────────────────┼────────────────────────┼────────────────────────┤
  │ apply when:        │ apply when:            │ apply when:            │
  │ • data is recursive│ • state-space search   │ • overlapping subprobs │
  │   (tree, AST)      │ • need to try / undo   │ • optimal substructure │
  │ • problem reduces  │ • generate combinations│                        │
  │   to smaller N     │   under constraints    │                        │
  ├────────────────────┼────────────────────────┼────────────────────────┤
  │ kernel:            │ kernel:                │ kernel:                │
  │ • base case         │ • state                │ • state                │
  │ • recursive case    │ • candidate generation  │ • recurrence relation │
  │ • combination       │ • try → recurse → undo  │ • memo table          │
  │                     │ • base case             │ • base case           │
  ├────────────────────┼────────────────────────┼────────────────────────┤
  │ cost:              │ cost:                  │ cost:                  │
  │ varies — O(N) for  │ exponential in state   │ O(states × work/state) │
  │ linear recursion,  │ size — usually O(b^d)  │ — usually polynomial   │
  │ O(2^N) for naive   │ where b = branching,   │                        │
  │ Fibonacci          │ d = depth              │                        │
  ├────────────────────┼────────────────────────┼────────────────────────┤
  │ examples:          │ examples:              │ examples:              │
  │ • tree walk         │ • n-queens             │ • Fibonacci            │
  │ • DFS               │ • sudoku               │ • edit distance        │
  │ • factorial         │ • subset sum           │ • coin change          │
  │ • merge sort        │ • maze solver          │ • knapsack             │
  │ • divide & conquer  │ • permutations         │ • LCS / LIS            │
  ├────────────────────┼────────────────────────┼────────────────────────┤
  │ in repo:           │ in repo:               │ in repo:               │
  │ NOT YET EXERCISED  │ NOT YET EXERCISED      │ NOT YET EXERCISED      │
  └────────────────────┴────────────────────────┴────────────────────────┘

  trigger to start using:
  • recursion: data becomes tree-shaped or a recursive grammar appears
  • backtracking: need to generate valid configurations under constraints
  • DP: optimization problem with overlapping subproblems shows up
```

---

## Implementation in codebase

The honest report: no recursion, no backtracking, no DP in `lib/` or `app/`. One use of `recursive: true` as a parameter to a stdlib function. Three plausible triggers.

### **The only "recursive" thing — `mkdir({recursive: true})` (`app/api/mcp/capture/route.ts`)**

```ts
// app/api/mcp/capture/route.ts (paraphrased — the only occurrence of "recursive" in the repo)
await mkdir(dir, { recursive: true });
```

This isn't *our* recursion — it's a parameter to Node's `fs.promises.mkdir` telling the stdlib to create intermediate directories. The recursion happens inside Node, not in the codebase's code. From the codebase's perspective, this is just a flag.

It belongs in this chapter only as a footnote: a beginner sometimes counts "I use `{recursive: true}`" as "my codebase exercises recursion." It doesn't.

### **No recursive function definitions**

Confirmed by grep across `lib/` and `app/`: no function calls itself. The deepest function-call nesting is `agent.scan() → runAgentLoop() → mcp.callTool() → liveCall() → transport.callTool()` — five levels, all distinct functions, no self-call.

### **No backtracking**

No state-space search anywhere. The closest abstraction is the JSON extraction fallback ladder in `lib/mcp/validate.ts` L3–L13 — three attempts in order, each falls through to the next on failure. But it's not backtracking: there's no *undo*, no shared state being modified-and-restored, no recursive descent into branches. It's a flat sequential fallback.

```
parseAgentJson (validate.ts L3–L13):

  try fenced-block regex  ──► success: return
                              fail: continue
  try bare JSON.parse     ──► success: return
                              fail: continue
  try substring scan      ──► success: return
                              fail: throw

  NOT backtracking — no undo, no state modification, no recursion.
  Just three attempts in a linear ladder.
```

### **No dynamic programming**

No memoization table, no tabulation, no recurrence. The TTL cache (`lib/mcp/client.ts` L80) is a *cache* of tool-call results, not a memoization table for subproblems — there's no recursive structure being cached. The derivation functions (`lib/insights/derive.ts`) recompute on every call; there's no overlapping subproblem to memoize.

### **What would trigger reaching for each?**

```
  technique          plausible trigger in this codebase
  ─────────────      ────────────────────────────────────────────────────
  recursion          schema grows deeper than 3-4 levels; recursive walker
                     becomes the cleanest expression. OR: a grammar appears
                     in the agent intent classifier and recursive-descent
                     parser is the natural form.

  backtracking       agent has to generate a valid *combination* of tool
                     calls under constraints (call order, conflicts, budget).
                     Today the LLM picks one call at a time linearly, but
                     constrained generation could become a backtracking
                     search.

  dynamic            optimization-under-constraints problem appears:
  programming        "pick K recommendations totaling impact ≥ T without
                     conflicting." That's a 0/1 knapsack — classical DP.
                     Today recommendations are independent; no selection
                     optimization runs.
```

None of these triggers has fired. The chapter is here so you recognize them when they arrive.

---

## Elaborate

### Where they come from

**Recursion** as a programming concept is as old as Lisp (1958) and Algol 60. The mathematical idea is older — Peano's axioms (1889) defined natural numbers recursively. Before recursion-aware languages, programmers simulated it with explicit stacks.

**Backtracking** was named by D. H. Lehmer in the 1950s in the context of combinatorial enumeration. The basic strategy (try, recurse, undo) appears in 19th-century puzzle-solving algorithms (n-queens has a backtracking solution dating to 1850).

**Dynamic programming** was coined by Richard Bellman in the 1950s. The name "dynamic programming" was chosen partly for political reasons — Bellman was working at RAND and needed a name that didn't sound like mathematical research (which would have lost funding). "Programming" referred to planning, not coding. The technique itself is a systematic application of memoization to recursive optimization problems.

### The deeper principle

**Recursion expresses problems where the solution for N is naturally expressed in terms of the solution for a smaller version of the same problem.** That's the test. If you can't say "the answer for N is some function of the answer for N-1 (or N/2, or some subset)," you don't have a recursive problem — you have a sequential one, and a loop is clearer.

**Backtracking is recursion plus a state machine.** The state represents "what choices have I made so far?" The recursion explores "what choice should I make next?" The undo restores the state when the recursion returns. The combination — recursion plus reversible state mutation — is what makes it backtracking.

**DP is recursion plus a cache plus a proof.** The cache (memo) is the implementation. The proof is *optimal substructure*: an optimal solution to the problem contains optimal solutions to the subproblems. Without that proof, memoization doesn't help — you might be caching wrong intermediate answers.

```
  problem characteristics → technique:

  self-similar structure                             → recursion
  + state-space search + need to undo                → backtracking
  + overlapping subproblems + optimal substructure   → dynamic programming
```

### Where they break down

- **Recursion blows the stack.** JavaScript engines limit call-stack depth to ~10K-30K frames. Deep recursion overflows. The fix is conversion to iteration with an explicit stack (DFS), or to tabulation (DP).

- **Backtracking is exponential.** The search space size is `b^d` where b is the branching factor and d is the depth. Pruning helps — early termination on partial-state infeasibility — but worst case is still exponential. NP-hard problems (SAT, traveling salesman) are NP-hard precisely because no algorithm escapes the exponential.

- **DP memo blows memory.** For 2D DP (e.g. edit distance over strings of length M and N), the table is O(M·N). For long sequences this is the limit. Space-optimization reduces 2D to two rows (current + previous), O(min(M, N)).

- **DP requires *optimal substructure*.** Some problems look DP-shaped but aren't — e.g., longest *simple* path in a graph (no repeated vertices) doesn't have optimal substructure, so DP doesn't apply (and the problem is NP-hard).

### What to explore next

- **Master theorem** — closed-form solution for the recurrence T(N) = aT(N/b) + f(N) common in divide-and-conquer. Tells you the cost of merge sort (O(N log N)), binary search (O(log N)), Strassen's matrix multiply (O(N^2.81)) at a glance.

- **Memoization decorators** — Python's `@functools.lru_cache`, JavaScript libraries like `memoize-one`, Reselect (Redux) — turn any pure recursive function into a memoized one without changing the function body.

- **Iterative deepening DFS (IDDFS)** — combines BFS's optimality with DFS's memory efficiency by repeatedly doing depth-limited DFS with increasing depth bounds. Used in chess engines and some IK pathfinding problems.

- **Branch-and-bound** — backtracking with an upper bound that prunes branches that can't beat the current best. Used in integer linear programming and combinatorial optimization.

- **Your own portfolio** — recursion shows up in your sorting visualizers (merge sort, quicksort) and tree traversals (`reincodes/BinarySearchTree.ts` insert/delete). Those are the kernels rehearsed; the codebase hasn't asked for them yet.

---

## Interview defense

**What they are really asking.** Whether you can name the three techniques and distinguish them. Senior signal: identifying when a problem is genuinely recursive vs when it just looks recursive. Architect signal: recognizing the trigger for DP (overlapping subproblems + optimal substructure) and knowing when *not* to reach for it.

---

**[mid] "What's the difference between recursion and dynamic programming?"**

Recursion is the syntax — a function that calls itself. Dynamic programming is recursion *plus memoization* applied to problems with overlapping subproblems. Naive recursive Fibonacci is exponential (O(2^N)) because `fib(3)` gets computed many times in the recursion tree. Memoized recursive Fibonacci is linear (O(N)) because each `fib(k)` is computed once and cached. The recursion is the *structure*; the memoization is what turns it from "elegant but slow" into "elegant and fast."

```
  recursion only           recursion + memoization (DP)
  ────────────────         ─────────────────────────────
  fib(40) = ~10^12 ops     fib(40) = 40 ops
  (exponential)             (linear, with O(N) memo space)
```

---

**[senior] "When would you *not* reach for DP, even if a problem looks DP-shaped?"**

Three cases. First: when **subproblems don't overlap**, memoization buys nothing — a binary tree walk visits each node exactly once even without a memo. Second: when **optimal substructure fails** — longest *simple* path in a graph (no repeated vertices) can't be built from optimal solutions to smaller subproblems because a "longer" sub-path might force you to revisit a vertex. Third: when **state space is too large to memoize** — DP over real numbers can't tabulate, and DP over very high-dimensional state explodes the table. The first two are theoretical (DP doesn't apply); the third is practical (DP applies but isn't tractable).

```
  problem characteristic                  DP applies?
  ─────────────────────────────────       ──────────────────────
  no overlapping subproblems              no (memo buys nothing)
  no optimal substructure                 no (subprob answers wrong)
  state space too large                   technically yes, but
                                          infeasible memory
```

---

**[arch] "This codebase has no recursion of its own. Is that a problem? When would you add it?"**

It's not a problem — the data is flat. Every algorithm here is a linear scan or a higher-order array op, and that matches the data shape (flat arrays of insights, evidence, recommendations). Three triggers would change my mind: (1) the schema grows recursive (deep nested objects with arbitrary depth), and a recursive walker is the cleanest expression; (2) an agent needs to generate a valid combination of tool calls under constraints — backtracking is the right search strategy; (3) an optimization problem appears where the same subcomputation recurs — like "pick the K recommendations that together maximize expected impact" (knapsack), which is classical DP. None of those has fired. The skill is recognizing the trigger when it arrives, not preemptively adding recursion for elegance points.

---

**The dodge: "but you have `mkdir({recursive: true})` — doesn't that count?"**

No. The `recursive: true` is a parameter passed to Node's `fs.promises.mkdir`. The recursion happens inside Node's standard library — Node walks the path, creates intermediate directories. The codebase's code doesn't have a recursive function. Calling this "the codebase uses recursion" inflates the description; it's like saying "I use binary trees" because I called `Map.set` (V8's Map uses a balanced tree internally for huge sizes). Library internals don't count. Cite `app/api/mcp/capture/route.ts`.

---

**Anchors (cite these in your answer)**

- `app/api/mcp/capture/route.ts` — only occurrence of "recursive" in the codebase, and it's a stdlib parameter
- `lib/mcp/validate.ts` L3–L13 — three-attempt fallback ladder (sequential, not backtracking)
- `lib/mcp/client.ts` L80 — TTL cache (cache, not memoization — no recursive structure being cached)
- (No file paths for recursion, backtracking, or DP — these are `not yet exercised`.)

---

## See also

→ `04-trees-tries-and-balanced-indexes.md` (trees are the natural data structure for recursion; tree walks are the canonical recursive algorithm) · → `05-graphs-and-traversals.md` (DFS is recursion with a visited set; backtracking is DFS plus undo) · → `06-sorting-searching-and-selection.md` (merge sort, quicksort, quickselect are all recursive/divide-and-conquer — `not yet exercised` directly here, but V8's Timsort uses recursion internally) · → `08-dsa-foundations-practice-map.md` (where these three rank in the practice plan)

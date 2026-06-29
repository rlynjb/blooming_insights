# Recursion, Backtracking, and Dynamic Programming

Recursion · base case · backtracking · memoization · tabulation · dynamic programming (DP) — Industry standard

## Zoom out — where this concept lives

This codebase runs **one shallow loop** that looks recursive on a whiteboard but is implemented as a flat `for` — the agent's tool-use loop in `lib/agents/base-legacy.ts:114`. That's the entire recursion surface. **No backtracking, no memoization, no DP** anywhere. The diagram marks where the "looks recursive" code lives and notes that the implementation is iteration.

```
  Zoom out — recursion's footprint in this codebase

  ┌─ UI (browser) ─────────────────────────────────────────────────┐
  │  React's render is recursive internally (component tree walk),  │
  │  but the code we WRITE here is flat — no manual tree walks.    │
  └────────────────────────────────────────────────────────────────┘
                          ▼
  ┌─ Service (Next API) ───────────────────────────────────────────┐
  │  ★ the one "loop with depth" ★                                  │
  │  runAgentLoop  — base-legacy.ts:114                             │
  │     for (let turn = 0; turn < maxTurns; turn++) {                │
  │       ask Claude → if tool calls → run them → repeat            │
  │     }                                                            │
  │  this is the iterative form of a recursive search; the          │
  │  recursion would be:                                            │
  │     askClaude(state)                                            │
  │       if no tool call: return                                   │
  │       results = run tool calls                                  │
  │       return askClaude(state + results)                         │
  │  same shape, written as a for-loop because:                    │
  │     1. bounded by maxTurns (no stack-blowing risk)             │
  │     2. easier to reason about budgets in iterative form        │
  │     3. cleaner cancellation via signal.throwIfAborted()        │
  └────────────────────────────────────────────────────────────────┘
                          ▼
  ┌─ Storage (Bloomreach) ─────────────────────────────────────────┐
  │  (opaque)                                                       │
  └────────────────────────────────────────────────────────────────┘
```

No tree walk, no graph search (file 05 noted: also not exercised), no expression evaluation, no permutation/combination generator, no DP. The entire surface is "iterate a bounded loop until done."

## Zoom in — the concept

Recursion is **a function defined in terms of itself**, with a base case that stops the chain. The most concrete way to read it: every recursive call pushes a frame onto the call stack, the base case pops back up, and the call stack does the bookkeeping the data-structure section of file 03 explained you'd otherwise do by hand with an explicit stack.

Backtracking is **recursion that explores choices and undoes them on failure** — the canonical pattern for "try every combination subject to a constraint" problems (N-queens, sudoku, permutations, subset sum). Dynamic programming is **recursion + a cache** — when the recursive call tree has overlapping subproblems, you memoize the answers so each unique subproblem is computed exactly once.

`blooming_insights` doesn't reach for any of this because the problems don't have that shape. The agent loop bounds depth at `maxTurns = 8`, so even if it were recursive there'd be no overlapping subproblems to memoize. The interview surface is the part to drill.

## Structure pass — layers · axes · seams

One axis traced: **how is "the work to do next" remembered, and what bounds the depth?**

```
  one axis — "how does the algorithm remember what's left, and when does it stop?"

  ┌─ iteration (flat for/while) ─────────────────────────────────┐
  │   remembers via: loop variable                                │
  │   stops when:    loop bound or break condition                │
  │   max depth:     O(1) on the call stack                       │
  │   used here:     yes — runAgentLoop                           │
  └──────────────────────────────────────────────────────────────┘
  ┌─ recursion (direct call) ────────────────────────────────────┐
  │   remembers via: call stack (implicit)                        │
  │   stops when:    base case returns                            │
  │   max depth:     limited by stack size (~10K in JS)           │
  │   used here:     no                                            │
  └──────────────────────────────────────────────────────────────┘
  ┌─ recursion + memoization (top-down DP) ──────────────────────┐
  │   remembers via: call stack + memo cache                      │
  │   stops when:    base case OR cache hit                       │
  │   used here:     no                                            │
  └──────────────────────────────────────────────────────────────┘
  ┌─ tabulation (bottom-up DP) ──────────────────────────────────┐
  │   remembers via: explicit table, iterative fill               │
  │   stops when:    table filled                                 │
  │   used here:     no                                            │
  └──────────────────────────────────────────────────────────────┘
  ┌─ backtracking (recursion + undo) ────────────────────────────┐
  │   remembers via: call stack + per-branch state mutation       │
  │   stops when:    base case (solution) OR prune (dead end)     │
  │   used here:     no                                            │
  └──────────────────────────────────────────────────────────────┘

  the seam: when "remember by call stack" stops being viable
  (recursion depth too high OR overlapping subproblems wasting work),
  you move to either explicit data-structure-driven iteration
  or to memoization.
```

- **layers**: just the service layer for the one exercised case.
- **axis**: how the algorithm remembers pending work and when it terminates.
- **seam**: when call stack stops being the right place to hold state — at depth (stack overflow) or at duplication (re-computing the same subproblem). The codebase never hits either.

## How it works

### Move 1 — the mental model

A recursive function calls itself on a **smaller version of the same problem** until it hits a **base case** that returns directly. The two parts are non-negotiable:

```
  recursion — the kernel

  function solve(problem):
    if base_case(problem):
      return direct_answer(problem)
    smaller = reduce(problem)
    answer  = solve(smaller)
    return combine(problem, answer)

  three parts:
    1. base case          — without it: infinite recursion → stack overflow
    2. reduction step     — without it: every call is on the same problem,
                            infinite recursion → stack overflow
    3. combine            — without it: you've found the answer but you're
                            throwing it away on the way back up
```

You already use recursion every time you walk a JSON tree, traverse a DOM, or render a React component tree (React internally recurses through children). **The bridge: every recursive function is implicitly using the call stack as a queue/stack** (file 03). You can always rewrite recursion as an explicit while-loop with your own stack — the two are interchangeable in correctness; they differ in clarity and stack-overflow risk.

### Move 2 — the moving parts

#### the one loop with depth — `runAgentLoop`

The agent loop is iterative, but it has the *shape* of a recursive search. Each iteration is "one turn": ask Claude, if Claude wants tools, run them, feed results back, repeat.

```ts
// lib/agents/base-legacy.ts:114-206 (excerpted)
for (let turn = 0; turn < maxTurns; turn++) {
  signal?.throwIfAborted();
  const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
  const forceFinal = turn === maxTurns - 1 || budgetSpent;
  const params = {
    model: AGENT_MODEL,
    max_tokens: maxTokens,
    system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
    messages,
  };
  if (!forceFinal) params.tools = toolSchemas;
  const res = await anthropic.messages.create(params, signal ? { signal } : undefined);

  messages.push({ role: 'assistant', content: res.content });

  const textBlocks = res.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text');
  if (textBlocks.length > 0 && onText) onText(textBlocks.map((b) => b.text).join(''));

  const toolUses = res.content.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use');
  if (toolUses.length === 0) { finalText = textBlocks.map((b) => b.text).join(''); break; }

  // run each tool, collect results
  const toolResults = [];
  for (const tu of toolUses) {
    // ... call dataSource.callTool, push to toolResults
  }
  messages.push({ role: 'user', content: toolResults });
}
```

Read it line by line:

- **`for (let turn = 0; turn < maxTurns; turn++)`** — the bound. **`maxTurns = 8`** in the monitoring case. This is the equivalent of a recursion-depth limit, except it's enforced by a loop counter instead of a stack-overflow.
- **`signal?.throwIfAborted()`** — cancellation point at the top of each iteration. Cheap to check; the route's `req.signal` aborts the loop when the client navigates away. The iterative form makes this trivial; the recursive form would need to thread the signal through every recursive call.
- **`budgetSpent = toolCalls.length >= maxToolCalls`** — a second termination condition. The monitoring agent caps at **6 tool calls** total (`maxToolCalls: 6`); after that, no more tools are offered and the model is forced to synthesize an answer.
- **`forceFinal = turn === maxTurns - 1 || budgetSpent`** — on the last allowed turn, the model gets no tools — only the synthesis instruction. Guarantees the loop terminates with a non-empty text answer.
- **`if (toolUses.length === 0) break`** — the natural base case. When the model returns text without asking for tools, we have the final answer.
- **`messages.push(...)` twice** — the loop carries the entire conversation forward across iterations. This is the "smaller problem" of the recursion analogy: each iteration is the same problem with one more turn of history.

The equivalent recursion would be:

```
  the recursion this loop would be

  function runAgentLoop(messages, turn):
    if turn >= maxTurns:        return synthesizeFinal(messages)
    if budgetSpent(toolCalls):  return synthesizeFinal(messages)
    res = askClaude(messages)
    messages.push(res)
    if no tool uses in res:     return res.text     ← base case
    results = runToolCalls(res.toolUses)
    messages.push(results)
    return runAgentLoop(messages, turn + 1)         ← recurse

  same termination conditions, same state-passing.
  WHY the for-loop wins here:
    1. bounded depth — no stack-blow risk, but iterative is clearer at this size
    2. the cancellation check sits at one place (loop top), not inside every frame
    3. the budget accounting is straightforward to reason about in one block
    4. the for-loop carries messages by reference — no awkward "return the new
       messages array" pattern that recursion would force for clean style
```

The lesson: **recursion and iteration are interchangeable; pick by clarity.** For a bounded, single-thread loop with cancellation, iteration is clearer. For tree/graph walks with branching, recursion is clearer (the call stack is the frontier). The agent loop is the first kind.

#### the call stack as implicit data structure

When you write recursion, you're using the call stack as a stack — frames push on the way down, pop on the way up. This is the load-bearing self-similarity with file 03's explicit stack. **A DFS via recursion and a DFS via explicit stack are the same algorithm**; the difference is who's holding the frontier.

```
  recursion vs explicit stack — same DFS, two implementations

  RECURSIVE                       ITERATIVE WITH STACK
  function dfs(node):              function dfs(start):
    visited.add(node)                stack = [start]
    for child of node.children:      visited = {start}
      if not visited:                while stack not empty:
        dfs(child)                     node = stack.pop()
                                       for child of node.children:
                                         if not visited.has(child):
                                           visited.add(child)
                                           stack.push(child)

  same behavior. recursion uses the JS call stack as the structure;
  iteration uses an explicit array as the stack. the only differences:
    - recursion risks stack overflow at ~10K-depth in V8
    - iteration is more verbose but trivially cancellable mid-flight
```

#### backtracking — the pattern, not exercised here

Backtracking is recursion that **makes a choice, recurses, and undoes the choice if the recursive call failed**. The canonical example: N-queens. Place a queen in a column, recurse to the next column, if no valid placement → backtrack and try a different row.

```
  backtracking — the pattern (pseudocode)

  function solve(state):
    if isGoal(state):     return state
    if isDeadEnd(state):  return failure
    for choice in choices(state):
      apply(choice, state)              ← make the move
      result = solve(state)
      if result is not failure:
        return result                   ← propagate success
      undo(choice, state)               ← undo and try the next
    return failure                      ← no choice worked
```

The kernel parts:

```
  backtracking kernel — what BREAKS without each part

  1. apply / undo pair          — without symmetric undo: state leaks
                                  across branches; later branches see
                                  the previous branch's "tentative" move

  2. isGoal check               — without it: never know when to stop

  3. isDeadEnd / pruning check  — without it: still correct, but explores
                                  the full exponential search space; with
                                  pruning, real-world inputs become tractable
```

Where this would land in `blooming_insights`: nowhere today. The agent doesn't fork hypotheses or explore branches. If the agent loop ever became "try this hypothesis path; if confidence stays low, back up and try another tool call sequence," that's backtracking.

#### dynamic programming — the cache idea, not exercised

DP is recursion plus memoization. The trick: when the recursive call tree has **overlapping subproblems** (the same input recurs in different branches), cache the answer the first time you compute it. The classic teaching example is Fibonacci:

```
  Fibonacci without memo — exponential
                                       fib(5)
                                      /        \
                                   fib(4)        fib(3)
                                  /     \        /     \
                              fib(3)   fib(2)  fib(2)  fib(1)
                              /    \                    ...
                           fib(2)  fib(1)
                           ...
   each fib(n) for small n is computed many times — O(2^n)

  Fibonacci with memo — linear
   on fib(2)'s first call: compute and cache. on every subsequent
   call: O(1) lookup. total work: O(n) computations.
```

Two flavors:

- **top-down DP (memoization)** — write the recursion naturally, add a cache check at the top: "have I computed this input before? return the cached answer; else compute and cache."
- **bottom-up DP (tabulation)** — flip the recursion into iteration; fill a table from base cases outward.

Where this would land in `blooming_insights`: nowhere today. **DP problems show up when**: optimal-path-through-a-grid, edit distance, knapsack, coin change, longest common subsequence, parsing, route optimization. None of these are in the codebase or its near future. Drill them anyway — they're standard interview fare (file 08).

### Move 3 — the principle

Recursion delegates state-management to the call stack. Backtracking is recursion that undoes on failure. DP is recursion that caches. **All three are forms of "explore a solution space," distinguished by what they do at each branch:** recursion just recurses; backtracking undoes when a branch fails; DP caches when a branch's input repeats. The agent loop in this codebase exercises none of these — it's a flat iteration with two termination conditions, and that's the right shape for its problem. **The interview surface is where this teaching pays off, not the codebase.**

## Primary diagram

The recap — the one loop the codebase runs, and the full family of patterns that aren't yet exercised.

```
  recursion / backtracking / DP in blooming_insights

  EXERCISED ─────────────────────────────────────────────────────────
  iterative loop with bounded depth + budget
   runAgentLoop — base-legacy.ts:114
   for (let turn = 0; turn < maxTurns; turn++) {
     askClaude → run tool calls → push results → repeat
     break on (no tool calls in response)
     break on (budget spent)  →  forceFinal synthesis
   }

  shape: equivalent to a tail-recursion with two termination conditions
  why iterative: bounded depth (no stack-blow), simple cancellation,
                 easier budget accounting

  NOT YET EXERCISED ─────────────────────────────────────────────────
  recursion (direct call)        — no tree walks, no JSON deep traversal
  backtracking (apply/undo)      — no constraint-satisfaction problem
  top-down DP (recursion + memo) — no overlapping subproblems
  bottom-up DP (tabulation)      — no grid/sequence optimization
  divide-and-conquer recursion   — no mergesort, no quickselect (file 06)
  tree recursion (BST walks)     — file 04: trees not yet exercised either

  the family map ────────────────────────────────────────────────────
  recursion            "smaller version of the same problem"
   + base case         "stop when trivially answered"
   + memo              → DP top-down  "cache repeated subproblems"
   + undo on failure   → backtracking "try, fail, retry differently"
   + table fill        → DP bottom-up "iterate from base cases out"
```

## Elaborate

Recursion is a function defining itself in terms of itself — the idea is older than computing, formalized in Church's lambda calculus (1936) and Kleene's recursion theorem (1938). **The fixed-point view**: a recursive function is the fixed point of a functional that maps "approximation of f" to "next approximation of f." You don't need this for working code, but it's the formal basis.

**Backtracking** has roots in 19th-century puzzle solving (the eight-queens problem dates to 1848). The modern formalization is from Walker (1960). The canonical "real" applications: SAT solvers (DPLL, 1962), constraint satisfaction (graph coloring, sudoku), parsing with arbitrary lookahead (CYK, Earley parsers).

**Dynamic programming** is Bellman (1953). Bellman coined the name to disguise the math from his Air Force funders, who he believed would defund anything called "research" — "dynamic" sounded operational, "programming" was 1950s slang for "planning." The two prerequisites for DP are **optimal substructure** (the optimal solution contains optimal solutions to subproblems) and **overlapping subproblems** (the same subproblem recurs in the call tree). Without overlapping subproblems, it's just plain recursion or divide-and-conquer.

**Stack-overflow in JS**: V8's default stack depth is ~10K frames. For tree walks deeper than that (huge JSON, deeply nested DOMs, long linked lists processed recursively), reach for the iterative form with an explicit stack — it has no fixed depth limit, only memory. **The transformation is mechanical**: any tail-recursive function becomes a `while` loop trivially; any general-recursion function becomes an iterative function with an explicit stack of "what to do next" frames.

Read next: file 04 (where tree recursion would live if trees were exercised), file 05 (where graph traversal — implicit recursion — would live if graphs were exercised), file 08 (where DP and backtracking rank in the practice plan).

## Interview defense

### Q: Why is the agent loop iterative when it has the shape of a recursive search?

Four reasons:

1. **Bounded depth.** `maxTurns = 8` means there's no risk of stack overflow either way, but the iterative form makes the bound visible as the loop condition. Recursion would hide it in a `turn` parameter.
2. **Cancellation.** `signal?.throwIfAborted()` at the top of each iteration is one place to check. Recursion would either thread the signal through every recursive call (verbose) or rely on the SDK's signal forwarding (less explicit about when the check fires).
3. **Budget accounting.** `toolCalls.length >= maxToolCalls` is checked once per iteration in one place. Recursion would force the budget into the function arguments and compare in every frame.
4. **State carried by mutation.** The `messages` array is pushed-to in two places per iteration. Recursion would push the recursive call to return a *new* messages array each time (or accept it as mutable, which defeats the recursive style).

```
  the equivalent recursion — to contrast

  function loop(messages, turn, toolCalls):
    if turn >= maxTurns: return synthesizeFinal()
    if toolCalls.length >= maxToolCalls: return synthesizeFinal()
    res = askClaude(messages)
    if no tool uses: return res.text
    results = runTools(res.toolUses)
    return loop([...messages, res, results], turn + 1, [...toolCalls, ...results])

  WORKS, but: spread-allocation on every recurse is wasteful;
  the cancellation point is at the top of askClaude only;
  every termination condition lives inside the function body.

  the for-loop is just cleaner at this scale.
```

The general principle: **recursion and iteration are interchangeable; pick by clarity at the call site.** For bounded loops with mutation-friendly state, iteration. For unbounded tree/graph walks where the call stack naturally tracks the frontier, recursion.

Anchor: `lib/agents/base-legacy.ts:114-206`.

### Q: What's the difference between memoization and tabulation?

Both are dynamic programming; both eliminate redundant recomputation. The difference is **the direction**:

- **Memoization (top-down)** — write the recursion naturally, add a cache check at the top: "have I computed `fib(n)` before? return the cached answer." Computes only the subproblems actually needed.
- **Tabulation (bottom-up)** — flip to iteration, fill a table from base cases outward: `dp[0] = 0; dp[1] = 1; for i from 2 to n: dp[i] = dp[i-1] + dp[i-2]`. Computes every subproblem from 0 up to `n`, in order.

```
  the tradeoffs

  memoization                       tabulation
  ─────────────────────────────────────────────────────────────────
  natural recursive code            iterative, often simpler loop
  computes ONLY needed subproblems  computes ALL subproblems up to n
  call-stack overhead per call      no recursion overhead
  risk: stack overflow on deep n    no stack risk
  cache structure: hash map         array (when keys are integers)

  pick memo when:    you don't visit every subproblem
                    (sparse recursion tree)
  pick table when:   you visit most subproblems anyway
                    (dense, like longest common subsequence)
                    AND iteration is clearer than recursion
                    AND avoiding stack overflow matters
```

Worked example: Fibonacci. Memoized: `fib(n)` only computes `fib(n), fib(n-1), …, fib(0)` — n+1 subproblems total. Tabulated: same n+1 fills. For Fibonacci they're equivalent; for problems with sparse recursion trees (where only some subproblems matter), memoization wins.

`blooming_insights` doesn't exercise either — no overlapping-subproblem problem in the codebase. The drill surface is interview fare: coin change, longest common subsequence, edit distance, knapsack, longest increasing subsequence.

Anchor: none here (DP is `not yet exercised`); pattern lives in interview drills (file 08).

### Q: When would you reach for backtracking?

When the problem is **"explore every combination subject to constraints, return the ones that satisfy."** The canonical signal: the problem can be phrased as a tree of choices where every leaf is "is this configuration valid?" and most paths are dead ends.

```
  the signature of a backtracking problem

  - solution = sequence of choices         ("place a queen on col 0, col 1, ...")
  - constraints rule out partial solutions early  ("no two queens on same row")
  - you want one (or all) valid leaf       (placement, permutation, subset)

  the kernel:
    for each choice at this level:
      apply choice
      if recurse succeeds: return solution
      undo choice
    return failure
```

The load-bearing part: **the apply/undo pair must be symmetric.** If you apply a state change before recursing, you must undo it before trying the next sibling — otherwise the next branch sees stale state from the previous attempt.

Classic backtracking problems: N-queens, sudoku, permutations of a string, subset sum, parenthesizations, word-break with dictionary constraints, regex matching with `*` and `?`.

Not exercised in `blooming_insights`. The hook into interview prep: any time the prompt says "find all subsets" or "all permutations" or "place N items subject to a constraint" — that's backtracking, and the apply/undo pair is the part to draw on the whiteboard first.

Anchor: none here (`not yet exercised`); pattern lives in interview drills (file 08).

## See also

- 01-complexity-and-cost-models.md — for the exponential-without-memo vs linear-with-memo cost story (Fibonacci is the canonical example).
- 03-stacks-queues-deques-and-heaps.md — for the explicit-stack rewrite of recursive walks.
- 04-trees-tries-and-balanced-indexes.md — tree walks are recursion's canonical case.
- 05-graphs-and-traversals.md — DFS via recursion uses the implicit call stack as the frontier.
- 08-dsa-foundations-practice-map.md — where DP, backtracking, and tree recursion rank in the practice plan.

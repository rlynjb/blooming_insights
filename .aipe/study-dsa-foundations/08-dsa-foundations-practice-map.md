# DSA foundations — the practice map

Industry names: interview prep, algorithm portfolio, LeetCode drills. Type: Project-specific curriculum.

## Zoom out — two lists, ranked by leverage

Every previous chapter said what's here and what isn't. This chapter turns that into a plan. Two lists in priority order: (a) concepts this codebase *does* exercise — lock them in with drills, because you can talk to your own code; (b) foundations the codebase doesn't touch — drill them for interview readiness because they'll come up anyway.

```
  The practice map — two lists, one axis (leverage)

  ┌─ Exercised in the repo — lock these in ────────┐
  │  1. Percentile-by-sort (n log n)                │  eval/report.eval.ts:161
  │  2. Worker-pool concurrency                     │  eval/load.eval.ts:171-211
  │  3. Set/Map for allow-list + cache              │  agents/tool-schemas.ts:13
  │  4. Weighted probabilistic selection            │  data-source/fault-injecting.ts:84
  │  5. xorshift32 PRNG                             │  data-source/fault-injecting.ts:157
  │  6. Running accumulator threshold               │  agents/budget.ts:51
  │  7. Regex extraction to structured value        │  data-source/bloomreach:64
  └─────────────────────────────────────────────────┘

  ┌─ Not exercised — drill for interviews ─────────┐
  │  1. Binary search (all four framings)           │  ← highest leverage
  │  2. BFS / DFS + visited set                     │  ← second-highest
  │  3. Top-K with a heap                           │  ← would improve real code
  │  4. Quickselect / partition                     │
  │  5. Trie / prefix tree                          │
  │  6. Backtracking (N-queens, permutations)       │
  │  7. Classic DP (knapsack, LCS, edit distance)   │
  │  8. Topological sort (Kahn's, DFS-tri-color)    │
  │  9. Union-find with path compression            │
  │ 10. Sliding-window / two-pointer                │
  └─────────────────────────────────────────────────┘
```

## Structure pass — leverage across the two axes

Axis for exercised concepts: **can you talk to your own code with fluency?** If you can pull up `eval/load.eval.ts:171` and walk the worker-pool pattern from memory, that's the highest-leverage story you have — it's *real* and *yours*, and it beats any LeetCode answer for signaling seniority.

Axis for missing foundations: **what's the ROI of drilling this?** Binary search shows up in every FAANG interview loop. Top-K with a heap fixes real code in this repo. DP is the topic most candidates fumble. Rank drills by that ROI, don't spray uniformly.

## The plan — drills, ranked

### Part A: Exercised concepts — build muscle memory on your own code

Each drill points at a real file. The "done when" test is whether you can pull it up in an interview and walk through it without hedging.

#### A1 — Percentile-by-sort, then defend the batch choice

- **What to build:** Nothing new. Read `eval/report.eval.ts:161-179` and `eval/load.eval.ts:326-333`. Consolidate the two duplicate implementations into one shared helper (this is also a `.aipe/audit-refactor` candidate).
- **Why it earns its place:** Two identical implementations is the kind of thing an interviewer will notice on a code walkthrough — either you own the smell and have a plan, or you get caught not knowing your own repo.
- **Files to touch:** `eval/report.eval.ts`, `eval/load.eval.ts`. Move `percentiles()` to a shared `eval/lib/stats.ts`.
- **Done when:** You can (1) write `percentiles()` from memory, (2) explain the O(n log n) cost and the `Math.min` clamp, (3) name three alternatives (quickselect for one-off, order-stat tree for streaming, t-digest for scale) and when each wins.
- **Estimated effort:** 30 minutes drill; 30 minutes refactor.

#### A2 — Worker pool from scratch

- **What to build:** Reimplement `eval/load.eval.ts:171-211` from memory in a scratch file. Then compare to the real version and notice what you missed.
- **Why it earns its place:** The concurrency question is the top-3 backend interview shape. You've built this; you should be able to reproduce it in five minutes.
- **Files to touch:** New scratch — `scratch/worker-pool.ts` (not committed).
- **Done when:** You can (1) reproduce the index-queue + K workers shape, (2) explain why per-worker try/catch matters, (3) name the O(n) shift() cost and its scale-out fix.
- **Estimated effort:** 45 minutes.

#### A3 — Set/Map choice: whiteboard the three tradeoffs

- **What to build:** Prep a one-minute answer to *"why Map instead of a plain object here?"* pointing at `lib/state/insights.ts:14`. Three tradeoffs: prototype safety, iteration order, O(1) size.
- **Why it earns its place:** Interviewers ask it constantly; strong answer signals you think about the container's contract, not just its convenience.
- **Files to touch:** none — pure prep.
- **Done when:** You can deliver the answer in under 90 seconds without reading, with `Set`/`Map` complexity call-outs.
- **Estimated effort:** 15 minutes.

#### A4 — Weighted probabilistic selection

- **What to build:** Read `lib/data-source/fault-injecting.ts:84-100`. Reimplement the "roll once, walk an accumulator" pattern for a *different* problem (weighted A/B routing).
- **Why it earns its place:** This is the most compact DSA in the repo and the pattern generalizes to any weighted choice problem — load balancing, weighted sampling, roulette wheel selection in genetic algorithms.
- **Files to touch:** scratch.
- **Done when:** You can explain why it's O(k) where k = number of options (not O(n) over inputs), and why *rolling once* keeps the failure modes independent.
- **Estimated effort:** 30 minutes.

#### A5 — xorshift32 PRNG

- **What to build:** Read `lib/data-source/fault-injecting.ts:157-166`. Understand the three shifts (`13, 17, 5`) as register scrambling; explain why the seed makes runs deterministic.
- **Why it earns its place:** PRNGs come up in system-design and testing questions. Being able to say "I used xorshift32 because I needed reproducibility across test runs" is signal.
- **Files to touch:** none — read only.
- **Done when:** You can explain the difference between a *pseudo-random* number generator (deterministic given seed) and true randomness, and why seedable is the right choice for tests.
- **Estimated effort:** 20 minutes.

#### A6 — Running-accumulator threshold

- **What to build:** Read `lib/agents/budget.ts:41-77`. Prep the "streaming vs batch" story pointing at this file: three counters, O(1) add, O(1) check, decoupled from turn count.
- **Why it earns its place:** The streaming pattern generalizes to rate limiters, circuit breakers, and every "check a running total against a threshold" shape.
- **Files to touch:** none — prep.
- **Done when:** You can contrast this with the batch percentile pattern (`eval/report.eval.ts:161`) and name why one is O(1)-per-op and the other is O(n log n)-once.
- **Estimated effort:** 20 minutes.

#### A7 — Regex-to-structured-value

- **What to build:** Read `lib/data-source/bloomreach-data-source.ts:64-71`. Understand the two regex variants and why loose matching (`[^0-9]*`, `i` flag) is the right call for unstructured error strings.
- **Why it earns its place:** String-parsing questions are common; owning a real example where you had to parse two variants of the *same* server error is a differentiator.
- **Files to touch:** none — read only.
- **Done when:** You can walk through both regexes and explain what would break if you tightened either one.
- **Estimated effort:** 15 minutes.

### Part B: Missing foundations — drill for interview readiness

Each item: (1) what to build, (2) why it earns its place, (3) how to know you're done. In descending ROI.

#### B1 — Binary search, all four framings

- **What to build:** Solve these five problems: LC 704 (basic), LC 34 (first/last position), LC 33 (rotated sorted array), LC 875 (Koko eating bananas — binary search on the answer), LC 4 (median of two sorted arrays).
- **Why it matters:** Binary search shows up in ~30% of coding-loop interviews. The "binary search on the answer" reframe (Koko-style) is the pattern that separates mid-level from senior candidates.
- **Done when:** You can write the loop without any off-by-one bugs on the first try, and you recognize the "monotonic predicate" framing on sight.
- **Estimated effort:** 3 hours across a week.

#### B2 — BFS/DFS with visited set

- **What to build:** LC 200 (number of islands — both BFS and DFS), LC 133 (clone graph — DFS with hash map), LC 210 (course schedule — topological sort with Kahn's).
- **Why it matters:** Second most-tested category after arrays/strings. The topological-sort variant tests whether you understand what BFS *is* vs the standard "shortest path" framing.
- **Done when:** You can write the BFS kernel (frontier + visited set + expand) from memory and name why marking visited on enqueue not dequeue matters.
- **Estimated effort:** 4 hours.

#### B3 — Top-K with a heap

- **What to build:** LC 215 (kth largest — both quickselect and heap-of-size-K solutions), LC 347 (top K frequent — heap + hash map).
- **Why it matters:** Directly improves `lib/agents/monitoring-legacy.ts:136`. Owning a real code-change proposal ("I'd swap this to a bounded heap at scale") beats the hypothetical answer.
- **Done when:** You can implement a min-heap from scratch (push, pop, sift-up, sift-down) and know when to use language-provided vs hand-rolled.
- **Estimated effort:** 3 hours.

#### B4 — Quickselect / partition

- **What to build:** Implement quickselect from scratch. Solve LC 215 with it (already noted above but do this one twice).
- **Why it matters:** The one-pass alternative to sort-then-index. Ties directly to `percentiles()` at `eval/report.eval.ts:161`.
- **Done when:** You can explain the pivot-choice pitfall (worst-case O(n²)) and how random or median-of-3 pivots avoid it.
- **Estimated effort:** 2 hours.

#### B5 — Trie / prefix tree

- **What to build:** LC 208 (implement a trie), LC 212 (word search II — trie + DFS + backtracking).
- **Why it matters:** Word search II is the classic multi-technique problem — trie for prefix pruning, DFS for grid walk, backtracking for the visited-set undo. Solving it cleanly is a strong signal.
- **Done when:** You can implement trie insert/search/startsWith from memory and use it inside a grid DFS.
- **Estimated effort:** 3 hours.

#### B6 — Backtracking

- **What to build:** LC 46 (permutations), LC 78 (subsets), LC 51 (N-queens), LC 39 (combination sum).
- **Why it matters:** State-space search shows up in mid-difficulty questions constantly. The "recurse + undo" shape is what interviewers test.
- **Done when:** You can write the kernel `apply → recurse → undo` without thinking, and you never forget the undo.
- **Estimated effort:** 4 hours.

#### B7 — Classic DP

- **What to build:** LC 70 (climbing stairs), LC 322 (coin change), LC 1143 (LCS), LC 72 (edit distance), LC 139 (word break).
- **Why it matters:** DP is the topic most candidates fumble. Getting solid on these five covers 80% of DP interview questions.
- **Done when:** For any of these, you can (1) define the state, (2) write the recurrence, (3) choose top-down or bottom-up and justify. Under ten minutes per problem.
- **Estimated effort:** 8 hours across two weeks.

#### B8 — Topological sort

- **What to build:** LC 210 (course schedule II) with both Kahn's algorithm and DFS + tri-color marking.
- **Why it matters:** Ties to the DAG shape hiding in `lib/agents/categories.ts:32`. Also the algorithm behind every build tool.
- **Done when:** You can name the cycle-detection variant of both approaches (Kahn: nodes left over; DFS: hitting a gray node).
- **Estimated effort:** 2 hours.

#### B9 — Union-find with path compression

- **What to build:** LC 547 (number of provinces), LC 684 (redundant connection).
- **Why it matters:** The nearly-O(1) inverse-Ackermann amortized cost is a beautiful example of the amortized analysis technique from `01-complexity-and-cost-models.md`.
- **Done when:** You can implement both path compression and union-by-rank, and cite the α(n) complexity.
- **Estimated effort:** 2 hours.

#### B10 — Sliding window / two pointers

- **What to build:** LC 3 (longest substring without repeat), LC 76 (minimum window substring), LC 42 (trapping rain water).
- **Why it matters:** Foundational array-manipulation pattern; O(n) alternatives to O(n²) brute force. Very common in phone screens.
- **Done when:** You recognize "find shortest / longest subarray satisfying condition C" as a sliding-window problem on sight.
- **Estimated effort:** 3 hours.

## Primary diagram — the whole plan on one page

```
  The 60-day drill map — leverage-ordered

  Week 1 — the two must-haves
    · B1 binary search      (3h)  ← highest interview leverage
    · B2 BFS/DFS            (4h)  ← second-highest
    · A2 worker pool drill  (0.75h) ← your codebase story
    · A1 percentile refactor (1h) ← real repo debt

  Week 2 — the two that fix your own code
    · B3 top-K with heap    (3h)  ← would replace monitoring:136
    · B4 quickselect        (2h)  ← would replace percentiles()

  Week 3 — the multi-technique story
    · B5 trie + DFS + backtrack   (3h)
    · B6 backtracking             (4h)
    · A4 weighted selection       (0.5h)

  Week 4 — the topic candidates fumble
    · B7 DP (5 canonical)         (8h)

  Week 5 — the graph tail
    · B8 topological sort         (2h)
    · B9 union-find               (2h)
    · B10 sliding window          (3h)
    · A3-A7 finish the repo prep  (1.5h)

  total: ~ 40 hours over 5-6 weeks
```

## Elaborate

The two-list structure is deliberate. Part A (exercised) is your *portfolio* — the things you can point at and say "I built this, here's why." Part B (missing) is your *coverage* — the things every interviewer will ask about regardless of what you've shipped. The mistake candidates make is drilling only Part B and losing the story-telling advantage of owning a real codebase. The other mistake is only knowing their own code and blanking when asked about anything else.

The 40-hour estimate is conservative if you can already write the basics from memory. If you can't reproduce a BFS kernel without looking it up, add 50% — you're building the skill, not just refreshing it.

For real interview prep, pair this list with **NeetCode 150** (the curated LC subset) and grind the Blind 75 as a warmup layer. But if you only have 40 hours, this repo-anchored plan is a stronger use of them because it leans on stories you can actually tell.

## Interview defense

**Q: Pick one concept in your repo that shows real DSA thinking and walk it through.**

Answer: The worker pool at `eval/load.eval.ts:171-211`. Index queue, K workers, per-item try/catch, `Promise.all` at the end. The event loop is the implicit lock — `queue.shift()` is atomic because JavaScript can't interleave synchronous code. The `if (index == null) return` guard handles the race between two workers seeing `queue.length > 0`. The load-bearing insight is that per-worker try/catch is what prevents one investigation's failure from stopping the rest — a `Promise.all` at the top level would fail-fast, but the pool's try/catch keeps N-1 workers running.

Then push scale: at N=20 the O(n) shift is invisible; at N=100k I'd swap to a linked-list queue or a ring buffer with head pointer. That's the shape interviewers want — recognize the current scale, know the limit, know the fix.

**Q: What DSA gap in this codebase would you fix first?**

Answer: `lib/agents/monitoring-legacy.ts:136` does `sort + slice(10)` — O(n log n) — where a bounded min-heap would give O(n log 10). At today's n≈50 it's invisible; if the anomaly count ever grew, the heap-of-size-K is the right shape. That's a clean 20-line refactor with a clear tradeoff — good candidate for `.aipe/refactor/` when the time comes.

**Q: Which interview topics should you drill first, given this codebase?**

Answer: Binary search and BFS/DFS. Not because the codebase uses them (it doesn't) but because they're the highest-frequency FAANG interview topics — probably 60% of coding-loop questions. Everything else in Part B is second-order.

## See also

- `00-overview.md` — the ranked findings this plan enumerates.
- `01-complexity-and-cost-models.md` through `07-recursion-backtracking-and-dynamic-programming.md` — the conceptual chapters this plan operationalizes.
- `.aipe/rehearse-interview-defense/` — for the story-telling layer over this DSA plan.
- `.aipe/audit-refactor/` — for the `percentiles()` deduplication as an actual code change.

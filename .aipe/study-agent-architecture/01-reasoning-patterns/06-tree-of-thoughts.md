# Tree of Thoughts

*Industry name: Tree of Thoughts (ToT) · Language-agnostic*

## Zoom out

```
  Zoom out — ToT branches the step function

  ┌─ agent loop skeleton ────────────────────────┐
  │  step + execute + accumulate + terminate     │
  └─────────────────┬────────────────────────────┘
                    ▼
  ┌─ step() shapes ──────────────────────────────┐
  │  ReAct — one path                             │
  │  ★ Tree of Thoughts — branch, score, pick ★  │ ← we are here
  │  (rarely worth it in production)             │
  └──────────────────────────────────────────────┘
```

## Zoom in

Explore multiple reasoning branches at each step, score them, keep the best. Not currently used in this repo, and honestly rarely worth it in production. This file exists so you recognize the pattern and can defend NOT using it — which is the more common interview answer.

## Structure pass

Layers: **root question** — **branch expansion** (K branches per turn) — **scorer** (evaluates each) — **best-branch selector**.

Axis to hold constant: **what does each branch cost?**

Every branch is a full model call. Branching factor K means K× the tokens per turn. Over a multi-turn task the cost multiplies fast — this is why the tradeoff is steep enough to skip.

## How it works

### Move 1 — the shape

You've used BFS to find the shortest path in `PG.ts` — expand all neighbors, score them (distance-to-goal), pick the frontier. Tree of Thoughts is BFS over reasoning — at each step, branch into K candidate next-thoughts, score them, keep the best (or top-N).

```
  Tree of Thoughts — branching search over reasoning

           root question
          ┌──────┼──────┐
          ▼      ▼      ▼
        path A  path B  path C   ← branch (K=3)
          │      │      │
        score  score  score      ← scorer (LLM or heuristic)
          └──────┼──────┘
                 ▼
            best path wins       ← select top-1 or top-N
```

### Move 2 — the mechanics, and why the tradeoff is steep

**Branching factor cost.** If each turn branches K ways, and the task takes N turns:

```
  Cost model — ToT vs ReAct

  ReAct (K=1):    N turns × 1 call = N calls
  ToT (K=3):      N turns × 3 branches × 1 scorer/branch = ~4N calls

  For a 5-turn diagnostic, that's 20 calls vs 5 calls — 4x cost.
```

For the diagnostic path in this repo (baseline p50 50s, ~$0.09), ToT would push per-case cost to ~$0.36 and latency past the Vercel 300s budget. That's the operational reason to skip it.

**Where ToT actually wins.** Highly branching search problems where a wrong turn is expensive to recover from (proof search, planning puzzles with many dead ends, game trees). The famous ToT paper example is Game of 24 — a search over arithmetic combinations where exhausting one branch cheaply is worth the extra evaluation cost.

**Why analyst tasks don't need it.** The diagnostic path is not deeply branching — the model reads an observation, forms one hypothesis at a time, tests it. If a hypothesis fails, the model backtracks in the next turn (ReAct is naturally a tree walk, just depth-first with one branch). The branching-factor cost buys nothing because there's no wrong turn expensive enough to justify parallel exploration.

**The escalation ladder makes this the last stop.** In order of when to reach for each:

```
  Escalation order

  1. ReAct baseline           (default)
  2. Plan-and-execute         (structured tasks)
  3. Reflexion / self-critique (uneven quality)
  4. Multi-agent decomposition (specialties)
  5. Tree of Thoughts         (deep branching search — rare)
```

ToT is #5 for a reason.

### Move 3 — the principle

Be blunt: this is rarely worth it in production. The branching multiplies token cost by the branch factor and rarely beats a well-prompted ReAct loop on real business tasks. Cover it so you recognize it and can say why you *didn't* use it. That's usually the stronger interview answer.

## Primary diagram

```
  Tree of Thoughts — the branching search shape

  ┌────────────────────────────────────────────────────────┐
  │                                                        │
  │              ┌──── root state ─────┐                   │
  │              │                     │                   │
  │              ▼                     ▼                   │
  │        ┌──────────┐          ┌──────────┐             │
  │        │ branch A │          │ branch B │             │
  │        │ (call 1) │          │ (call 2) │             │
  │        └────┬─────┘          └────┬─────┘             │
  │             │                     │                   │
  │        scorer                scorer                   │
  │             │                     │                   │
  │             └───── keep top-N ────┘                   │
  │                       │                                │
  │                       ▼                                │
  │             (repeat until termination                  │
  │              or budget exhausted)                      │
  │                                                        │
  └────────────────────────────────────────────────────────┘
```

## Elaborate

Tree of Thoughts was named by Yao et al. (Princeton / DeepMind, May 2023). The paper showed strong gains on Game of 24, creative writing, and mini-crosswords — tasks where the search space is genuinely branching. It has not translated well to open-ended agentic tasks because the branching factor + evaluation cost dwarfs the quality gain.

The closest cousins are **self-consistency** (Wang et al., 2022 — sample N completions, majority-vote) and **best-of-N** (sample N, pick the best via a scorer). Both are cheaper than ToT because they don't branch iteratively — one round of sampling, then pick. In practice, best-of-N with N=3 is a more pragmatic quality lever than ToT for most tasks.

## Interview defense

**Q: Did you consider Tree of Thoughts for the diagnostic path?**

Considered and skipped. ToT multiplies token cost by the branching factor per turn — for a 5-turn diagnostic at K=3, that's roughly 4x my current baseline (~$0.09 → ~$0.36 per case, plus latency well past the 300s route budget).

More fundamentally, my diagnostic path is not deeply branching. The model forms one hypothesis, tests it, moves on. If a hypothesis fails, ReAct naturally backtracks in the next turn — it's already tree-walking, just depth-first with a branching factor of one. ToT buys parallel exploration; my problem doesn't have wrong turns expensive enough to justify that.

Where I'd reach for it: proof search, game trees, or planning puzzles with dead ends. Not for iterative analyst work.

*Anchor visual:* the branching-shape diagram above.

**Q: What's the cheaper version of the same idea?**

Best-of-N. Sample N candidate outputs in parallel, pick the best via a scorer. Same "explore multiple options" intuition, but one round instead of iterated branching — much cheaper. Anthropic and OpenAI both support this natively via `n` parameters. If I ever wanted diversity in the diagnostic conclusions, best-of-3 would be the first thing I'd try.

## See also

- **`03-react.md`** — the pattern this repo actually uses.
- **`04-plan-and-execute.md`** — the pattern above ToT in the escalation ladder.
- **`.aipe/study-prompt-engineering/`** self-consistency concept — the sibling technique that's cheaper.

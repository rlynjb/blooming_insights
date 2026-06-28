# Tree of Thoughts

*Industry name: Tree of Thoughts (ToT) — Industry standard. Mostly research, rarely production.*

Explore multiple reasoning branches, score them, pick the best. Not in this repo and almost certainly not worth it for this product. Covered here so you can name *why* you didn't use it.

## Zoom out — where this concept would live

If adopted, it'd replace the per-turn step inside a single agent's loop — instead of one `step → execute` per turn, the loop would emit N branches, score each, and continue down the best. It would sit *inside* one of the existing agents, not as a new agent.

## Structure pass

The axis: **how many candidate next-moves does the model consider on each turn?**

```
  ReAct                              ToT
  ─────                              ───
  1 candidate per turn               N candidates per turn
  pick & commit                      score → pick best → continue
  cost: 1 LLM call/turn              cost: N+1 LLM calls/turn (the +1 is scoring)
```

## How it works

### Move 1 — the mental model

You know breadth-first search over a tree — explore neighbors, score them, expand the best. ToT is BFS over reasoning paths: at each step the model emits multiple candidate next-thoughts, the model (or a separate scoring step) ranks them, and the loop continues down the highest-scoring branch.

```
  Tree of Thoughts — branching reasoning

           root question
          ┌──────┼──────┐
          ▼      ▼      ▼
        path A  path B  path C    ← N candidate next-moves
          │      │      │
        score  score  score        ← model scores each
          └──────┼──────┘
                 ▼
            best path wins         ← only the winner continues
            (recurse or commit)
```

### Move 2 — why it's rarely worth it in production

The token cost multiplies by the branch factor. Three branches per step = 3x the tokens of ReAct. And the scoring step is itself an LLM call. So a 6-tool-call ReAct loop becomes (6 turns × 3 branches × 2 calls/branch) = 36 LLM calls vs ReAct's 6. That's 6x cost for an improvement that rarely shows up on real tasks — the paper's wins were on game-of-24 and creative-writing benchmarks, not data analysis or tool use.

For this repo's workload (anomaly detection, diagnosis, recommendation) there's no documented case where ToT beats ReAct enough to justify 6x the cost. The diagnostic agent's "generate 2-3 hypotheses up front" is a one-level ToT with no scoring — you commit to all three hypotheses and test each, which is cheaper and works as well.

## In this codebase

**Not implemented and not planned.** The diagnostic prompt's "2-3 hypotheses" instruction is a degenerate case of one-level ToT (consider multiple paths) without the branching cost (test them in sequence rather than scoring and pruning).

## Primary diagram

The cost contrast:

```
  Cost comparison — 6-step task across reasoning patterns

  ReAct:        ●━━●━━●━━●━━●━━●           6 LLM calls
                turn1 turn2 ... turn6

  Plan-execute: ●━━━┓
                     ┣━━●━━●━━●━━●━━●     1 plan + 5 exec = 6 calls
                     ┗━━(cheap model)

  ToT (3 branches):
                ●───●───●                   per turn:
                ●───●───●  → score → pick    3 branches + 1 score
                ●───●───●                   = 4 calls/turn × 6 turns = 24 calls

                                            (and 6 of those scoring calls
                                             are themselves expensive)
```

## Elaborate

ToT was introduced by Yao et al. (2023). The genuine contribution: for tasks where the right answer is one of a discrete set of plans (game-of-24, creative writing prompts, crossword puzzles), exploring multiple branches and scoring beats committing to one path. The cited improvements were 70%+ on game-of-24 vs ReAct's 4%.

The cited failure mode: on open-ended tasks with continuous output spaces (analysis, summarization, tool-driven Q&A), the branching cost dominates and the quality gains evaporate. Production teams generally land on "ToT for narrow puzzle-shaped tasks, ReAct for everything else."

The pattern that *did* survive into production is one-level "self-consistency" — generate N candidate answers, pick the most common — which is cheaper and often delivers most of ToT's win without the recursive scoring.

## Interview defense

**Q: "Did you consider Tree of Thoughts?"**

A: Considered, ruled out. ToT's win profile is narrow-puzzle tasks (game-of-24, crosswords) where the right answer is one of a discrete set. Data analysis and diagnosis are continuous output spaces — the cost multiplies (3 branches × scoring = 4x ReAct per turn) without proportional quality gain. The diagnostic prompt does the cheap version: "generate 2-3 hypotheses then test each" gives you path diversity without the recursive scoring overhead. If we ever needed it, self-consistency (sample N answers, take majority) is the production-friendly version — much cheaper, often most of the win.

Diagram I'd sketch:

```
  ToT cost:                            ReAct cost:
  ┌──┬──┬──┐                           ┌──┐
  │A │B │C │  per turn → 3 calls       │A │  per turn → 1 call
  └─┬┴─┬┴─┬┘     + 1 scoring call      └──┘
    └──┼──┘
       ▼ pick                          6 turns = 6 calls
  N turns × 4 = 4N total

  4-6x cost for narrow-puzzle wins; not our workload.
```

Anchor: "the diagnostic prompt's '2-3 hypotheses up front' captures ToT's diversity without ToT's scoring cost. That's the cheap version that works for our task shape."

## See also

- [`03-react.md`](./03-react.md) — the pattern we actually use
- [`05-reflexion-self-critique.md`](./05-reflexion-self-critique.md) — the other "spend more tokens for quality" escalation

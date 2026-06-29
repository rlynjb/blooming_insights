# Tree of thoughts

**Industry standard.** A branching reasoning pattern. **Not implemented** in this codebase and unlikely to earn its place here.

## Zoom out, then zoom in

Sits at the reasoning layer, like every other named pattern. The difference is it doesn't run *one* loop — it branches into N parallel reasoning paths, scores them, and picks a winner.

```
  Zoom out — where this would sit

  ┌─ Reasoning layer ───────────────────────────────┐
  │  ReAct (today, everywhere)                       │
  │  ★ Tree of thoughts (branch + score + pick) ★   │ ← we are here
  │  (rarely worth the cost in production)           │
  └──────────────────────────────────────────────────┘
```

The honest framing: this is covered so the reader recognizes the pattern and can explain *why they didn't use it.* In a real interview, "I considered tree-of-thoughts and chose not to because [reason]" is more common than the rare "I used tree-of-thoughts because…"

## Structure pass

Layers: branching strategy (how many paths, how deep) → per-path execution → scoring (a judge model rates each path) → selection (pick the best).

**Axis traced — "what's being multiplied?":** tokens, primarily. Cost is roughly proportional to branch_factor × depth × per-step-cost. A 3-branch, 4-deep tree is 12 reasoning steps where ReAct would have 4.

**Seam:** the scoring function. Same problem as reflexion — if the scorer shares blind spots with the producers, the winning branch is the one that fooled the scorer, not the right one.

## How it works

### Move 1 — the mental model

You know the difference between a forward-only search and a beam search. ReAct is forward-only — pick the next step, commit. Tree-of-thoughts is beam search — explore several next steps in parallel, score them, prune the bad ones, recurse.

```
  The tree-of-thoughts shape

           root question
             │
       ┌─────┼─────┐
       ▼     ▼     ▼
     path A path B path C    ← branch (3 paths)
       │     │     │
       │     │     │           per-path: one ReAct loop
       ▼     ▼     ▼
     score score score        ← judge each path
       └─────┼─────┘
             ▼
       best path wins         ← selection
       (or continue branching
        from the best)
```

In the simplest form, you branch once at the root, run N independent ReAct loops, score them, return the best. In the recursive form, you branch at every step — N branches at depth 1, M per branch at depth 2, etc. — exploring a tree of partial reasoning paths.

### Move 2 — step by step

#### Why it's expensive

The token cost multiplies by the branch factor and the depth. A 3-branch tree of depth 3 is 9 leaf paths, each running a full ReAct loop, plus the scorer call per leaf, plus the final selection. Compared to a single ReAct run of comparable depth, that's roughly 10x the token cost for one answer. The bet you're making is that one of those 9 paths is meaningfully better than what plain ReAct would have produced.

#### Why it rarely pays off in production

Two reasons that show up empirically:

1. **The right path is usually obvious by turn 2.** For most production agent tasks, the model gets to a good trajectory quickly. The 9 branches end up exploring 9 minor variations of the same path; the "best" one isn't meaningfully different from any of the others.
2. **The scorer is the bottleneck.** Same problem as reflexion — a model scoring model-generated paths shares the blind spots that produced them. The branch that wins the score is often the one that *sounds* most confident, not the one that's most correct.

For research benchmarks where the task is genuinely hard (the original ToT paper used Game of 24, creative writing, mini crosswords), the multiplier earns its overhead. For "find the cause of this revenue drop" or "propose a recommendation" — tasks where ReAct's first trajectory is usually correct — the multiplier is wasted.

#### Why this repo doesn't run it

The agent tasks here are bounded and the right path is usually clear by turn 2:

- Monitoring scan: the categories are enumerated, the EQL queries are templated, the model picks which categories to query first. There's no "branch on strategy."
- Diagnostic investigation: hypotheses are tested sequentially; if hypothesis A doesn't pan out, the agent tests hypothesis B. That's ReAct's strength.
- Recommendation: read scenarios, read segments, propose. The path is structured by the Bloomreach feature taxonomy.

None of these benefit from exploring multiple parallel paths because the *correct* path doesn't have meaningful alternatives.

### Move 3 — the principle

**The honest framing for tree-of-thoughts is "cover so you can explain why you didn't use it."** In production agent work, the canonical answer is: "I considered ToT, but the failure modes in my domain weren't 'the model picks a bad initial strategy and commits' — they were 'tool calls fail intermittently' and 'the structured output drifts.' Those are handled by retry/backoff and structured-output recovery, not by branching."

## Primary diagram

```
  Tree-of-thoughts — full shape, with cost annotation

           question
              │
        ┌─────┼─────┐
        ▼     ▼     ▼
      branch branch branch        depth 1: 3 paths
        │     │     │             COST: 3x baseline ReAct
        │     │     │
     ┌──┼──┐  │  ┌──┼──┐
     ▼  ▼  ▼  ▼  ▼  ▼  ▼
     l  l  l  l  l  l  l         depth 2: ~9 leaf paths
                                  COST: 9x baseline ReAct
        ▼     ▼     ▼            each leaf: full ReAct loop
      score score score          + judge/scorer call
        └─────┼─────┘
              ▼
        selection                 + selection call
              │
              ▼
         final answer

  Total: ~10-12x token cost for one answer.
  Wins: if the "correct" trajectory isn't the
        first one the model would pick.
  Loses: if the first ReAct trajectory was already
         going to be correct (the common case in
         production agent work).
```

## Elaborate

The original Tree of Thoughts paper (Yao et al., 2023) showed strong gains on tasks where the search space has many wrong-but-locally-plausible paths — Game of 24 (many wrong arithmetic sequences look fine for several steps before failing), creative writing (the first draft is usually local-optimum), and crosswords (lots of plausibly-fitting words that lock out the right one). The shared property: a greedy search commits to a bad path early and can't recover.

The production-agent failure modes don't have that shape. When a monitoring agent picks the wrong category to query first, the recovery is cheap (it tries another category next turn). When a diagnostic agent tests a hypothesis that doesn't pan out, the recovery is also cheap (test another hypothesis). The greedy-commits-to-bad-path failure that ToT solves doesn't dominate; the failure modes that do dominate (tool errors, structured output drift) have their own cheaper fixes.

There's a less-discussed cousin pattern: *self-consistency*, which runs ReAct N times in parallel with sampling temperature > 0 and takes the majority answer. That's a degenerate ToT (no scorer, vote instead) and it does sometimes earn its overhead for arithmetic/code-generation tasks where the right answer is rare-but-recognizable. The repo doesn't use this either, for the same reason — the costly branch multiplier doesn't pay off when the first trajectory is usually correct.

## Interview defense

> **Q: Have you considered tree-of-thoughts for this repo?**
>
> Considered and didn't ship. ToT earns its 10x cost when the agent's failure mode is "greedy commits to a locally-plausible but wrong path early." The investigations in this repo don't have that shape — when the diagnostic agent picks the wrong hypothesis first, the recovery is cheap (it tests another hypothesis next turn) because the search space is shallow and the wrong-but-plausible problem doesn't bite. The failure modes that actually dominate are tool-call errors and structured-output drift, which are handled by `BloomreachDataSource`'s retry ladder and `tryParseAnomalies`'s recovery prompt respectively. Both are cheaper than ToT and address the actual failure modes.

> **Q: When *would* you reach for tree-of-thoughts?**
>
> When the task has many locally-plausible-but-globally-wrong paths and the wrong ones don't reveal themselves until many steps in. Code generation with implicit constraints is the canonical example: the model writes a function, three out of four implementations look fine until you test the edge case the fourth one handles. ToT (or self-consistency with a test-based scorer) is the right shape because the per-leaf cost is justified by the cost of shipping the wrong code. Bloomreach anomaly investigation isn't this shape — the cost of "we tested the wrong hypothesis first" is one extra tool call, not a customer outage.

> **Q: Tree-of-thoughts vs reflexion — both add cost. When each?**
>
> Different escalations from baseline ReAct. ToT diversifies the *search* — explore N parallel paths, pick the best. Reflexion adds a *gate* — run one path, judge the output, revise if flawed. ToT pays for exploring paths you might not have considered; reflexion pays for catching errors in the path you committed to. They address different failure modes. Stack them only at the top of the cost ladder when the stakes justify 5-10x baseline cost.

## See also

- → `03-react.md` — the baseline ToT branches from
- → `05-reflexion-self-critique.md` — the orthogonal "catch errors after committing" pattern
- → cross-reference (when generated): `study-ai-engineering`'s sampling file — the temperature + self-consistency mechanics

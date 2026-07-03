# Tree of Thoughts

_Industry standard._

## Zoom out, then zoom in

Explore multiple reasoning branches, score them, pick the best. **Not used in blooming_insights.** Not planned. This file covers it so you can recognize the pattern and, more importantly, name *why you didn't use it* — which is the more common interview answer.

```
  Zoom out — where ToT would sit (it doesn't)

  ┌─ DiagnosticAgent — currently single-branch ReAct ──────────┐
  │                                                            │
  │   ToT alternative:                                         │
  │   root: anomaly                                            │
  │        ├── branch A: "check regional traffic"              │
  │        ├── branch B: "check funnel conversion"             │
  │        └── branch C: "check campaign timing"               │
  │   score each · pick best · continue                        │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: cost multiplies by branch factor; wins rarely materialize on real tasks. Cover it, name the failure mode, move on.

## Structure pass

**Layers:** root task · branch generation · branch scoring · pruning · selection.
**Axis:** *how much of the token budget is spent on paths you abandon?*
**Seam:** the scoring function — it decides which branches live. A cheap-to-run bad scorer is worse than no ToT at all.

```
  Cost multiplier by branch factor

  ReAct:     turn cost × depth
  ToT b=3:   turn cost × depth × 3   ← 3x
  ToT b=5:   turn cost × depth × 5   ← 5x

  Win: only if the answer quality lift > 3-5x
  Reality on structured tasks: rarely
```

## How it works

### Move 1 — the mental model

You've written backtracking search before — DFS on a state space, prune paths that can't win. ToT is that pattern with the *model* generating candidate next-thoughts at each node and *another model call* scoring them. It's search over reasoning trajectories with LLM calls as node expansions.

```
  Pattern: Tree of Thoughts

          root question
         ┌──────┼──────┐
         ▼      ▼      ▼
       path A  path B  path C
       (LLM)   (LLM)   (LLM)     ← generate
         │      │      │
       score  score  score        ← evaluate
       (LLM)  (LLM)  (LLM)         (another N calls)
         └──────┼──────┘
                ▼
           best path expands
           (or all prune and re-generate)
```

### Move 2 — the walkthrough

**In this codebase.** Not used. If it were, DiagnosticAgent would look like: from the anomaly, generate 3 candidate investigation strategies; run each partially (2-3 tool calls); score which one has the most explanatory power; continue with the winner. That'd be 3x the tool calls and 3x the Sonnet turns for the first 2-3 rounds.

**Why it's rarely worth it in production.** Two reasons:

1. **Cost multiplier compounds.** For DiagnosticAgent at maxTurns=8, maxToolCalls=6: baseline is ~$0.045/investigation. ToT with b=3 at the first 3 levels would be ~$0.135, minimum. That's a 3x cost hit for a *hoped-for* quality lift.

2. **Scoring is the load-bearing failure.** ToT's whole value depends on the scorer picking the right branch. If the scorer shares the producer's biases, ToT is expensive noise. Blooming's diagnostic conclusions are graded downstream by the `EvidencePanel` UI (does the evidence support the conclusion?) — but building that evaluator into a scoring function for inline ToT would need a golden-trajectory dataset, which is the eval work in `04-agent-infrastructure/04-agent-evaluation.md`.

**What Blooming does instead.** Sequential ReAct with `maxToolCalls=6` and a well-shaped system prompt. The model still explores — turn 2's query can differ from turn 1's based on the observation — but the exploration is *depth-first* (one branch, informed by data) not *breadth-first* (three branches, scored).

**Where ToT does earn its keep in general.** Math and coding tasks with verifiable answers (unit tests can be the scorer, deterministic and cheap). Neither applies here — the "right" diagnostic conclusion is judged qualitatively.

### Move 3 — the principle

Cover ToT so you can name *why not*. Interview-grade posture is "I know it exists, I considered it, here's the specific reason I chose single-branch instead." The reason is almost always: scoring is expensive or unreliable, and the b-factor cost eats the quality lift.

## Primary diagram

```
  Recap — ToT is a branch factor multiplier

  Sequential ReAct (this repo):
  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌───────┐
  │ turn 1     │→ │ turn 2     │→ │ turn 3     │→ │ final │
  │ 1 branch   │  │ 1 branch   │  │ 1 branch   │  └───────┘
  └────────────┘  └────────────┘  └────────────┘
  cost: 4 model calls

  ToT b=3:
  ┌───┐┌───┐┌───┐  ┌───┐┌───┐┌───┐  ┌───┐┌───┐┌───┐  ┌───────┐
  │A1││B1││C1│  │A2││B2││C2│  │A3││B3││C3│→ │ final │
  └───┘└───┘└───┘  └───┘└───┘└───┘  └───┘└───┘└───┘  └───────┘
   +3 scorer calls per level = 6 scorer calls
  cost: 15 model calls (~3.75x)
```

## Elaborate

ToT was named in Yao et al. 2023 ("Tree of Thoughts: Deliberate Problem Solving with Large Language Models"). Its benchmark wins were on Game of 24, Creative Writing, and Crossword — tasks with narrow answer spaces where the scorer could be nearly deterministic. On open-ended production tasks the picture is dramatically different: the scorer's noise dominates the branch generation's variance, and you spend 3-5x compute for a coin flip on quality.

The more useful cousins ToT points at: (a) **best-of-N sampling** at the *final answer* stage only, where the scorer is a simple validator — cheaper than tree search and covers most of the reliability win. (b) **plan-and-execute** with a re-plan on failure — spends the branch cost only when the first plan didn't work, not eagerly.

## Interview defense

**Q: Did you consider Tree of Thoughts for the diagnostic loop?**
A: Yes, and rejected it. Two reasons: cost multiplier of ~3-5x with b=3, and the scoring function is where ToT actually earns or loses. For a diagnostic conclusion, "which branch is best" is a qualitative judgment — I'd need a golden-trajectory eval to build a reliable scorer, which is the same eval infra I don't have yet. Sequential ReAct with a well-shaped prompt and a `maxToolCalls=6` budget converges in 3-5 tool calls; ToT would make it 15-25 calls for a hoped-for lift I can't measure.

Diagram: the b-factor cost multiplier + the "no reliable scorer" callout.
Anchor: `lib/agents/diagnostic.ts` for baseline; hypothetical ToT branch cost.

**Q: When WOULD Tree of Thoughts pay off?**
A: When the answer is verifiable. Coding agents where the scorer is "did the tests pass" are the canonical case — deterministic, cheap, reliable. Math puzzles similarly. As soon as scoring becomes a Sonnet call graded against subjective criteria, you're paying LLM cost twice per node with LLM noise on top. Blooming's diagnostic conclusion isn't verifiable that way — the answer is qualitative — so ToT is the wrong shape.

Diagram: quadrant chart — "verifiable + expensive to solve → ToT wins", "qualitative + cheap ReAct → skip ToT".
Anchor: n/a, general reasoning.

## See also

- `03-react.md` — the pattern this repo runs instead.
- `04-plan-and-execute.md` — the other direction of "spend more compute on planning".
- `04-agent-infrastructure/04-agent-evaluation.md` — the eval work ToT would need before it could earn its keep.

# Tree of Thoughts

**Industry name(s):** Tree of Thoughts (ToT), branch-and-score reasoning, search-based agent reasoning, beam-search-over-thoughts
**Type:** Industry standard · Language-agnostic

> Explore N reasoning paths in parallel, score each, pick the best. blooming insights correctly does NOT use this — branching multiplies token cost by the branch factor, the MCP rate limit is ~1 req/s, and the per-investigation ceiling is 300s. ToT's cost shape is the opposite of what this codebase can afford.


---

## Why care

You've probably written this in a brute-force algorithm interview: explore every possible move, score the resulting positions, pick the move that led to the best score. Chess engines do it. Sudoku solvers do it. You start at a root state, you branch out, you evaluate, you pick. The cost is the branching factor — at branch factor 3 and depth 5 you've evaluated 243 leaves to commit to one root move.

Now picture the same shape with a reasoning task. Instead of board positions, the nodes are "candidate thoughts" — the model writes three different ways to start a diagnosis ("check the time series first", "segment by country first", "check campaigns first"), runs each one a couple of steps, scores the resulting partial-investigations, and picks the branch with the highest score. The branching factor is the number of thoughts the model considers per step; the depth is the number of steps before you commit; the cost is the product.

That's the question this file answers: **when does explicit branch-and-score reasoning earn its cost over a single ReAct path, and why does this codebase almost certainly never want it?**

**Why answering that question matters:** because Tree of Thoughts looks academically rigorous and is, in production, almost always a worse deal than a well-prompted single-path ReAct loop. Every time the branch factor goes up by 1, your token spend and latency multiply. A b=3, d=4 tree explores 81 partial paths to commit to one — that's 81x the tokens of a single ReAct trajectory, plus the cost of scoring each. For a system with a ~1 req/s MCP rate limit and a 300-second ceiling, 81x cost is not "more rigorous"; it's "this run won't finish."

Knowing why you *didn't* use ToT is the interview-grade answer here. The wrong answer is "I didn't think of it." The right answer is "I considered it and the budget arithmetic killed it before I wrote any code."

Without naming the cost shape:
- "Should we try Tree of Thoughts on the diagnostic agent?"
- Someone wires up branch factor 3, depth 3, scorer model = same model
- One investigation now fires 27 partial trajectories instead of 1
- 6 tool calls per trajectory × 27 trajectories × ~1s per MCP call ≈ 162s of serial calls
- Vercel times out at 300s; the investigation never returns

With the cost shape named:
- "Tree of Thoughts would multiply our tool calls by the branch factor"
- "Our MCP rate is ~1 req/s; our ceiling is 300s; our current run is ~100–115s"
- "Anything above 2x is over the ceiling. ToT is a non-starter."
- Decision made in 30 seconds without writing code

One-line summary: **Tree of Thoughts is minimax over reasoning paths — it earns its cost only on tasks where (a) the branches lead to measurably different end-states and (b) you can afford branch-factor × depth × per-step cost.** Neither holds here.

---

## How it works

**The mental model: BFS or beam search over thought sequences, with the model as both the branch generator and the scorer.** At each step, instead of committing to one next thought, the model generates K candidate next thoughts. Each candidate is run forward a few steps (or evaluated immediately). Branches are scored; low-scoring branches are pruned; high-scoring branches are explored further. The final answer comes from the best-scoring leaf.

```
The tree — branch factor B, depth D

                  ┌─ thought 1 ─ score 0.6 ─ ✗ pruned
   root question ─┤
   "diagnose      ├─ thought 2 ─ score 0.8 ─ explored
    the drop"     │              │
                  │              ├─ subthought 2a ─ 0.9 ─ explored
                  │              └─ subthought 2b ─ 0.7 ─ pruned
                  └─ thought 3 ─ score 0.4 ─ ✗ pruned

   Cost ≈ B^D model calls just for thought generation,
          plus B^D scorer calls.
```

The strategy in plain English: **don't commit to a path until you've seen what alternatives look like.** ReAct commits one step at a time and reacts to observations. ToT explores N partial futures and commits to the most promising one. The win is when a wrong early commitment leads to an unrecoverable bad answer; the cost is the multiplication of every per-step cost by the branching factor.

### Move 2.1 — Branch generation

The technical thing: at each node, the model is prompted to produce K distinct candidate next thoughts (not just one). Typical implementations prompt the model with "give me 3 different ways to approach this" and parse the K candidates from the response.

If you're coming from frontend, this is like calling `fetchSuggestions()` with `count=3` and rendering all three as previews, then picking one — except every "preview" is itself a model call to generate.

```
One node, K branches — pseudocode

  candidates = await model.create({
    system: "Generate 3 distinct next steps for this investigation.",
    messages: [history],
  });
  // candidates: ["check time series", "segment by country", "check campaigns"]
```

The practical consequence: K candidates means K * (cost of one ReAct step) per node, not 1 step. At K=3 and a 4-step investigation, you're paying for 12 first-step generations and you haven't yet picked a path.

The condition under which it works: the K candidates have to be *meaningfully different* — exploring three minor rewordings of the same approach wastes K-1 calls. Prompting for diversity is its own engineering problem.

### Move 2.2 — Scoring

The technical thing: each candidate (or each partial path) gets a numeric score from a scorer model — usually the same model with a "rate the promise of this path from 0 to 1" prompt. Branches with low scores are pruned; high-score branches are explored further or returned as the answer.

If you're coming from frontend, this is `array.sort((a, b) => b.score - a.score).slice(0, topK)` — a beam search keeping the top-K candidates per depth. The scorer is the comparator.

```
Beam search over thoughts — pseudocode

  beam = [root]
  for d in 0..D:
    expanded = []
    for node in beam:
      kids = generateBranches(node, K)    ← K model calls per node
      scored = await Promise.all(kids.map(score))   ← K scorer calls
      expanded.push(...scored)
    beam = expanded.sort(byScore).slice(0, beamWidth)
  return beam[0].path
```

The practical consequence: at each depth, you pay K * |beam| generation calls plus K * |beam| scorer calls. Even a tiny beam width of 2 with K=3 and D=4 fires 2 * 3 * 4 = 24 generations and 24 scorings — ~50 LLM calls for one task. That's before any tool calls inside the explored branches.

The condition under which it works (and where it doesn't): the scorer's judgments have to *track which branch will lead to a good final answer*. If the scorer can't tell — because the difference between branches is subtle, or because the scorer shares the producer's blind spots (see `04-reflexion-self-critique.md`) — you're paying a multiplier on cost to commit to randomness.

### Move 2.3 — When this earns its cost

The technical thing: ToT earns its multiplier when the *answer surface has cliffs* — where a small early choice leads to a hugely different end state, and where the cost of recovering from a wrong early choice exceeds the cost of evaluating alternatives up front. The canonical examples are puzzle solving (24 game, crosswords) and constrained generation (writing tasks with specific structural goals).

If you're coming from frontend, the case for ToT is the case for `Promise.all` over alternatives when you can't tell which one will succeed: cheaper to race them than to retry serially after the first fails. The catch: in ToT you're not racing parallel requests against an external service — you're racing them against your own LLM budget.

```
ToT earns its cost when:                ToT loses when:
─────────────────────────                ────────────────────
answer surface has cliffs                answer surface is smooth
(early wrong → very wrong end)           (a wrong early step is
                                          recoverable mid-trajectory)
scorer reliably ranks branches           scorer can't tell good from
(domain has clear evaluation)             plausible
branches lead to MEASURABLY               branches converge to similar
DIFFERENT end states                      end states
total budget room for B^D                 budget room for 1x ReAct
```

The condition under which this codebase qualifies: it doesn't. Diagnostic investigations have a *smooth* answer surface — most reasonable early queries (volume, revenue, conversion) lead to similar diagnoses because the underlying data is the same. The cost of a wrong early query is one wasted MCP call (~1s) inside a ReAct loop that can re-decide on the next turn, not a 6-step trajectory locked in by step 1.

### Move 2.4 — Why blooming insights cannot afford it (the explicit budget arithmetic)

The honest version, with numbers from this codebase:

```
Constraints (from this codebase):
  MCP rate limit:          ~1 req/s spacing
  Per-investigation ceiling: 300s (Vercel Pro max — app/api/agent/route.ts L20)
  Current investigation:    ~100–115s (route.ts L18–L19 comment)
  Per-agent maxToolCalls:   6 (monitoring/diagnostic/query) or 4 (recommendation)
                            base.ts L60, monitoring.ts L101,
                            diagnostic.ts L62, recommendation.ts L57

ReAct cost (baseline):
  1 trajectory × 6 tool calls × ~1s/call = ~6s of MCP serialization
  + Sonnet generation per turn ≈ ~100s total/agent (most is MCP wait)

ToT with b=3, d=3 (modest):
  27 partial trajectories × 6 tool calls × ~1s/call = 162s of MCP work
  + 27 scorer calls
  + scorer-tree-traversal logic
  TOTAL: > 300s ceiling, before answering anything

ToT with b=2, d=2 (minimal):
  4 partial trajectories × 6 tool calls × ~1s/call = 24s of MCP work
  + 4 scorer calls
  + 4x the Sonnet token cost
  TOTAL: still 2-3x ReAct's cost for an investigation type whose
          answer surface is smooth (so branching doesn't help)
```

The principle: **ToT's cost is structural; it's not a parameter you can tune past the multiplier.** Even the minimal beam-search shape multiplies the per-trajectory cost by the branch factor, and a rate-limited system with a hard time ceiling can't absorb that multiplier without breaking the ceiling. ToT isn't wrong; it's wrong *for systems with rate limits and time ceilings on smooth answer surfaces.* This codebase is one of those.

The full picture is below.

---

## Tree of Thoughts — diagram

```
The three positions you can take

  POSITION A: pure ReAct (THIS REPO, all 4 agents)
  ┌─────────────────────────────────────────────────────────────┐
  │ root ─► one trajectory, one budget, ~6 tool calls            │
  │   cost: 1× per-step                                          │
  │   fits in 300s ceiling: yes (~100s typical)                  │
  └─────────────────────────────────────────────────────────────┘

  POSITION B: beam search (b=2, d=2, BEST CASE for ToT)
  ┌─────────────────────────────────────────────────────────────┐
  │ root ──► thought 1 ──► subthought 1a                          │
  │     └──► thought 2 ──► subthought 2b                          │
  │   cost: ~4× per-step × scoring overhead                       │
  │   fits in 300s? maybe — depends on MCP rate × tool depth     │
  │   buys: alternative early commitments                         │
  └─────────────────────────────────────────────────────────────┘

  POSITION C: full ToT (b=3, d=3 — the canonical "worth it" shape)
  ┌─────────────────────────────────────────────────────────────┐
  │ root ──► t1, t2, t3                                           │
  │           ├ st1.a, st1.b, st1.c                               │
  │           ├ st2.a, st2.b, st2.c                               │
  │           └ st3.a, st3.b, st3.c (then each branches again)    │
  │   cost: 27× per-step + scorer calls                           │
  │   fits in 300s? NO — under our MCP rate limit                 │
  │   buys: extensive branch evaluation                            │
  └─────────────────────────────────────────────────────────────┘

  This repo: A everywhere. Why: smooth answer surface +
  rate-limited MCP + 300s ceiling. B and C are non-starters.
```

---

## Implementation in codebase

**Not yet implemented (Case B — and correctly so).** No agent branches over candidate thoughts. All four run linear ReAct trajectories via `runAgentLoop` (`lib/agents/base.ts` L48–L176).

**The constraints that rule it out**

- MCP rate: ~1 req/s spacing (referenced in `app/api/agent/route.ts` L18–L19 comment and across the codebase as a known floor).
- Per-investigation ceiling: 300s (`app/api/agent/route.ts` L20 — `export const maxDuration = 300`).
- Current investigation depth: ~100–115s for the diagnostic → recommendation chain (per the route file's comment).
- Per-agent tool budget: `maxToolCalls: 6` (monitoring/diagnostic/query) or `4` (recommendation) — `lib/agents/monitoring.ts` L101, `lib/agents/diagnostic.ts` L62, `lib/agents/recommendation.ts` L57, `lib/agents/query.ts` L41.

The arithmetic at the smallest viable ToT (b=2, d=2): 4 partial trajectories × ~6 tool calls × ~1s/call = ~24s of MCP work *for one node depth*, then × multiple depths. The headroom between current ~100s and the 300s ceiling is roughly 2x — only enough for a minimal ToT, and the minimal shape doesn't measurably improve answer quality on tasks with smooth answer surfaces. So the cost-vs-quality math doesn't pencil out.

**Why this is the correct decision, not a missed opportunity**

Diagnostic investigations have a smooth answer surface: the underlying data is the same regardless of which query you start with, and a wrong early query just costs ~1s before the loop re-decides. The cliff scenarios ToT is designed for — where step 1's choice locks you out of recoverable end-states — don't show up here. Adding ToT would multiply cost by the branch factor for a task whose structure doesn't reward branching.

```
shape (what ToT would look like — illustrative, NOT in repo):

  // Hypothetical ToT-augmented diagnostic (not present)
  async function diagnoseWithToT(anomaly, b=3, d=3) {
    let beam = [{ history: [], score: 1.0 }];
    for (let depth = 0; depth < d; depth++) {
      const expanded = [];
      for (const node of beam) {
        // K candidate next steps — K LLM calls
        const candidates = await generateBranches(anomaly, node.history, b);
        // K scorer calls
        const scored = await Promise.all(candidates.map(c =>
          scoreBranch(anomaly, node.history, c)));
        expanded.push(...scored);
      }
      beam = expanded.sort(byScore).slice(0, beamWidth);
    }
    return beam[0].history;   // best partial trajectory
  }
```

---

## Elaborate

### Where this pattern comes from

Tree of Thoughts came from the 2023 Yao et al. paper (same lead author as ReAct) that adapted classical tree search to language-model reasoning. The core observation was that LLMs benefit from being able to *evaluate partial paths* and *prune* — the same intuition that drives minimax in chess engines. The benchmark wins were on Game of 24 (constraint-satisfaction puzzles) and creative writing under structural constraints, both tasks where a wrong early choice locks out good end-states. The pattern entered the agent-orchestration vocabulary in 2024 as one of the "advanced reasoning patterns" to consider above pure ReAct.

### The deeper principle

Branching is a tax on linear cost; it pays only when the answer surface has cliffs that branching avoids. The general principle from search algorithms: **explicit search earns its multiplier when the cost of evaluating a partial path is lower than the cost of recovering from a wrong committed path.** For LLMs, this means ToT is a fit when (a) the evaluator (scorer) is reliable enough to prune well, and (b) the alternative paths lead to genuinely different end-states. Take either condition away and the multiplier becomes pure overhead.

```
   When branching is taxed cleanly:        When branching is overhead:
   ───────────────────────────────         ─────────────────────────
   answer surface has cliffs               answer surface is smooth
   scorer ranks reliably                   scorer rubber-stamps
   branches diverge in end-state           branches converge anyway
   budget tolerates b^d multiplier         rate limit or time ceiling
                                            kills b^d at small b
```

### Where this breaks down

When the scorer can't distinguish good branches from plausible ones — and same-model scoring is the common case in practice — the search just commits to randomness more expensively. When the answer surface is smooth (most data-analysis tasks fall here, including diagnostic investigations), branching doesn't reduce error meaningfully because all reasonable paths converge. When the system has a time ceiling and a rate-limited tool surface (this codebase: 300s and ~1 req/s), even small branch factors push past the ceiling. When the team can't articulate which failure mode ToT is fixing, the multiplier is paying for nothing measurable.

### What to explore next
- `02-react.md` → the baseline ToT escalates from; in this codebase, ReAct is the entire reasoning surface
- `03-plan-and-execute.md` → a cheaper escalation than ToT when the structure of the answer is knowable up front
- `04-reflexion-self-critique.md` → a different family of escalation that adds *quality checking* rather than *branch exploration*
- `06-routing.md` → branching's much cheaper cousin — pick one path before committing, instead of exploring N

---

## Interview defense

### What an interviewer is really asking
When an interviewer asks about Tree of Thoughts, they're often probing whether you can resist a fancy-sounding pattern when your constraints rule it out. The strong signal is "I considered it, here's the cost calculation, here's why it doesn't fit." The weak signal is either "yes I used ToT" (without naming the failure it solved) or "no I don't know what that is" (revealing you didn't consider it).

### Likely questions

[mid] Q: Do any of your agents use Tree of Thoughts?

A: No, and that's deliberate. All four agents (`monitoring`, `diagnostic`, `recommendation`, `query`) run linear ReAct via `runAgentLoop` at `lib/agents/base.ts` L48–L176. The reason ToT is out: it multiplies cost by the branch factor at each depth, and this system has a ~1 req/s MCP rate limit with a 300s per-investigation ceiling. Current investigations sit at ~100–115s; the smallest viable ToT shape (b=2, d=2) would push past 200s for the branch exploration alone, before answering anything.

Diagram:
```
   ReAct (here):           ToT (b=2, d=2 minimum):
   1 trajectory             4 partial trajectories
   ~6 MCP calls             ~24 MCP calls (1 req/s)
   ~100s wall time          ~200s wall time for branching
                            (still need recommendation after)
```

[senior] Q: But ToT is better for open-ended reasoning. Why not use it for the diagnostic agent, which has the most open task?

A: Because the diagnostic answer surface is smooth — most reasonable starting queries (purchase volume, revenue, conversion funnel) converge to similar diagnoses because the underlying Bloomreach data is the same. ToT pays off when the answer surface has cliffs — where step 1's choice locks out good end-states. We don't have that here. A wrong early query just costs ~1s under the MCP spacing before the ReAct loop re-decides on the next turn. The fix for "loop chose a bad start" is one extra turn, not 27 partial trajectories.

Diagram:
```
   Cliff surface (ToT wins):       Smooth surface (this repo):
   ─────────────────────             ──────────────────────────
   step1: choice A → end A           step1: choice A ─┐
                                                       ▼
   step1: choice B → end B           step1: choice B ─► similar
                                                       ▲   evidence
   ends are STRUCTURALLY             step1: choice C ─┘   tree
   different → branch to compare      all converge → branching
                                       is overhead
```

[arch] Q: At a higher MCP rate limit and no time ceiling, would ToT make sense here?

A: The rate limit and ceiling are necessary but not sufficient conditions to even consider it. The structural condition is the answer surface. Even at unlimited rate and no ceiling, ToT on diagnostic would explore 27 partial trajectories whose evidence trees mostly overlap — so the cost multiplier still buys negligible quality improvement. ToT would start to earn its keep if the *categories* expanded to ones with cliff surfaces (e.g. attribution analysis where the choice of attribution model locks downstream evidence), AND the rate limit didn't break the multiplier, AND a reliable scorer existed. Three independent conditions. Just lifting the rate limit doesn't get you there.

Diagram:
```
  What would unlock ToT here:
  ┌─ rate limit lifted        ┐
  ┌─ time ceiling raised      ┤ necessary but not sufficient
  └─ NEW: cliff-shape categories ─ STRUCTURAL — must exist first
  └─ NEW: reliable scorer        ─ otherwise pruning is random
```

### The question candidates always dodge
Q: You're saying you avoided ToT because of cost — but every advanced pattern has overhead. Isn't this just an excuse not to learn it?

A: Honest answer: knowing how to skip a pattern correctly is *the* learning. I know what ToT is, why it pays off on Game of 24 and constraint satisfaction, and where it falls down. The discipline here was naming three independent conditions ToT needs — cliff surface, scorer reliability, budget headroom — and recognizing that zero of three hold in this codebase. The wrong move would be adopting ToT to put it on a resume; the right move is the cost calculation, which I did before writing any code. If a different category of investigation surfaces tomorrow that genuinely has a cliff surface (and the rate limit eased), I'd come back to this decision. Until then, "I considered ToT and ruled it out, here's the arithmetic" is the rigorous answer, not the avoidance answer.

Diagram:
```
   What I considered:                  Decision:
   ─────────────────                   ──────────────
   ToT b=3, d=3                        > 300s ceiling
   ToT b=2, d=2                        2-3x cost, no
                                        measurable quality
                                        gain on smooth surface
   Plan-and-execute                    cheaper escalation if
                                        path is knowable
                                        (see 03-plan-and-execute.md)
   Reflexion / critic                  cheaper escalation if
                                        failure is recognizable
                                        (see 04-reflexion-self-critique.md)

   Chose: pure ReAct (this file's baseline)
```

### One-line anchors
- "ToT's cost is b^d × per-step — and our MCP rate limit plus 300s ceiling kills the multiplier at small b."
- "Diagnostic answer surfaces are smooth; branching doesn't buy quality when branches converge."
- "Three conditions for ToT to earn its keep here: cliff surface, reliable scorer, budget headroom. Zero hold."
- "Knowing why you didn't use a pattern is the interview-grade answer — the calculation is the rigor, not the adoption."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Draw the three positions from memory: pure ReAct (this repo's all-four-agents shape), beam-search ToT b=2 d=2 (the minimal worth-trying shape), and full ToT b=3 d=3 (the canonical worth-it shape). For each, label the cost multiplier and whether it fits the 300s ceiling under ~1 req/s MCP spacing.

Open the file. Compare.

✓ Pass: you have three positions, you label the cost multipliers (1×, 4×, 27×), and you correctly mark only pure ReAct as fitting the ceiling
✗ Fail: re-read Move 2.4 and the budget arithmetic, wait 10 minutes, try again

### Level 2 — Explain it out loud
Explain "why don't you use Tree of Thoughts" to a colleague who just asked. No notes. Under 90 seconds.

Checkpoints — did you:
- Name the cost shape (b^d × per-step)?
- Cite the rate limit (~1 req/s) and time ceiling (300s — `app/api/agent/route.ts` L20)?
- Explain why diagnostic answer surface is smooth?
- Name at least one condition under which you'd reconsider?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
A product manager asks: "Can the diagnostic agent try 3 different starting queries in parallel and pick the best one?" Without looking at the file: what shape is the PM asking for, what would it cost in MCP calls and wall time, and is there a cheaper way to get the same value?

Write your answer (3–5 sentences). Then open `app/api/agent/route.ts` L18–L20 to confirm the time ceiling and `lib/agents/diagnostic.ts` L62 to confirm the per-loop `maxToolCalls`, and check whether the PM's "in parallel" assumption holds under MCP's serial rate limit.

### Level 4 — Defend the decision you'd change
"If you were starting today with a 600s ceiling (instead of 300s) and a 5 req/s MCP rate (instead of ~1), would ToT be on the table for the diagnostic agent? Why or why not? Which specific category of investigation would be the first candidate, and what would the scorer model be?"

Reference the code: point to the current ReAct loop at `lib/agents/base.ts` L85–L172 for the baseline, and describe what a ToT-augmented branch generator + scorer would add structurally (a new file, a new prompt, a beam data structure).

### Quick check — code reference test
Without opening any files:
- Does this repo use Tree of Thoughts? (No.)
- What's the rate limit and time ceiling that rule it out?
- Name the three conditions that would have to hold for ToT to earn its keep here.

Open and verify. ✓ The "no" answer, the rate-limit / ceiling numbers, and the three conditions are what matter; line numbers drifting is fine.

## See also

→ 02-react.md · → 03-plan-and-execute.md · → 04-reflexion-self-critique.md · → 06-routing.md · → react: `../../study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md`

---
Updated: 2026-05-29 — created
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.

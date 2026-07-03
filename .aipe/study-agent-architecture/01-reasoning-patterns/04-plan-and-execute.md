# Plan-and-execute

_Industry standard._

## Zoom out, then zoom in

The escalation up from ReAct: decouple planning from execution. One expensive model call produces the full plan; cheap fast calls execute each step. **Not used in blooming_insights.** This file names why, and what would change to introduce it.

```
  Zoom out — where plan-and-execute would sit if adopted

  ┌─ Service (route.ts) ──────────────────────────────────────┐
  │  Currently: ★ hand-coded chain: diagnose → recommend ★    │
  │                                                            │
  │  Plan-execute alternative:                                 │
  │    Planner (Opus/Sonnet, ONE call) →  plan: [q1,q2,q3]     │
  │    Executor (Haiku, N cheap calls) →  each query runs      │
  │    Synthesizer (Sonnet, ONE call) →   final answer         │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: this pattern beats ReAct when the tasks are *structured and predictable enough to plan* but too variable to hard-code. This repo's diagnostic path is genuinely exploratory (the next query depends on the last one's result), which is exactly where ReAct wins.

## Structure pass

**Layers:** planner (one call, expensive) · plan artifact (list of steps) · executor (many cheap calls) · optional re-plan trigger.
**Axis:** *when does the model reason about the whole task?*
**Seams:** the plan artifact itself is the seam — it's the contract between planner and executor. A schema violation there is where the pattern fails.

```
  Plan-and-execute vs sequential ReAct

  Sequential ReAct (this repo):
    turn 1: think + query A → observe
    turn 2: think + query B → observe    ← model re-plans every turn
    turn 3: think + query C → observe
    turn 4: think + FINAL

  Plan-and-execute (alternative):
    plan-turn: think ALL steps upfront → [A, B, C]
    exec-turn: run A                                    ← no re-planning
    exec-turn: run B
    exec-turn: run C
    synth-turn: aggregate → FINAL
```

## How it works

### Move 1 — the mental model

You've built a CI pipeline before — `plan: [lint, test, build, deploy]` written declaratively, then a runner executes each step. Plan-and-execute is the LLM version: the model produces the plan as data, then the runner walks the plan. The win: you can use Opus for planning (expensive but rare) and Haiku for execution (cheap but frequent).

```
  Pattern: plan-and-execute

  ┌─ Plan phase (one expensive call) ──────────────────┐
  │  Opus / Sonnet:                                    │
  │  input: task + context                             │
  │  output: [step1, step2, step3, deps]               │
  └────────────────────────────┬───────────────────────┘
                               │  plan (structured)
                               ▼
  ┌─ Execute phase (many cheap calls) ─────────────────┐
  │  Haiku (or deterministic):                         │
  │  for each step: run(step) → collect result         │
  └────────────────────────────┬───────────────────────┘
                               │
  ┌─ Optional re-plan trigger ─▼───────────────────────┐
  │  if execution diverges: back to plan phase         │
  └────────────────────────────────────────────────────┘
```

### Move 2 — the walkthrough

**In this codebase.** Not yet implemented. The diagnostic loop does not separate planning from execution — the model decides "what to query next" one turn at a time inside `runAgentLoop`. That's Sequential ReAct.

**Where it would earn its keep.** Consider the recommendation phase. Today, `RecommendationAgent.propose` runs a fresh ReAct loop that may re-derive strategy multiple times. If the product grew to require *multi-recommendation sequences* — "produce 3 scenarios for scenario, segment, campaign; for each, generate steps; then rank" — plan-and-execute would fit:

Hypothetical:
```ts
// hypothetical lib/agents/plan-execute-recommendation.ts
async propose(anomaly, diagnosis) {
  const plan = await this.planner.plan(anomaly, diagnosis);
  //          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ one Sonnet call
  //          returns: { steps: [{action: 'draft-scenario', args: {...}}, ...] }
  const results = await Promise.all(plan.steps.map(step =>
    this.executor.run(step)     // ← Haiku each, parallel
  ));
  return this.synthesizer.synthesize(results);
  //     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ one Sonnet call
}
```

Line-by-line: one Sonnet plan call ($0.02), N Haiku exec calls (~$0.003 each), one Sonnet synth call ($0.02). Sequential ReAct today costs ~$0.045 for the recommendation phase. Plan-execute would only pay off past N=5 recommendations. **Not there yet.**

**The failure this pattern introduces.** *Plan brittleness.* If step 2 fails or returns unexpected data, the pre-planned step 3 was assuming step 2's shape. Sequential ReAct doesn't have this — the model sees step 2's result before deciding step 3. Mitigation is a re-plan trigger, which reintroduces most of the coordination cost.

### Move 3 — the principle

Plan-and-execute wins when (a) the task is genuinely decomposable in advance, (b) the executor steps are cheap enough that saving re-planning overhead matters, and (c) you can tolerate brittleness or afford a re-plan branch. This repo's diagnostic path is *exploratory* by construction — the next query depends on the last one's data — so re-planning IS the value the model provides. Plan-execute would kill that.

## Primary diagram

```
  Recap — plan-execute vs the current shape

  CURRENT (Sequential ReAct in DiagnosticAgent):
  ┌──────────────────────────────────────────────────┐
  │  turn 1 → query 1 → observe                       │
  │  turn 2 → query 2 (depends on obs 1) → observe   │
  │  turn 3 → query 3 → observe                       │
  │  turn 4 → FINAL                                   │
  │  8 model calls, all Sonnet, ~50s                  │
  └──────────────────────────────────────────────────┘

  ALTERNATIVE (Plan-Execute — not implemented):
  ┌──────────────────────────────────────────────────┐
  │  plan turn → [q1, q2, q3]     (Sonnet, ~5s)      │
  │  exec parallel → r1, r2, r3   (Haiku, ~3s each)  │
  │  synth turn → FINAL           (Sonnet, ~5s)      │
  │  5 calls, mixed model, ~15s                       │
  │  BUT: fails when q2 depends on q1's result       │
  └──────────────────────────────────────────────────┘
```

## Elaborate

Plan-and-execute is the pattern LangChain popularized under that name; the reference for a production audience is Wang et al. 2023 ("Plan-and-Solve Prompting") plus the LangGraph docs' "Plan-and-Execute" tutorial. In practice, teams reach for it when they observe ReAct wasting turns on re-planning: same task, same domain, same shape, and the model spends turn 2 re-deriving what it already decided in turn 1.

The failure mode the Blooming diagnostic path exhibits that WOULD make plan-execute tempting: the model sometimes runs a "coverage check" query first (e.g. is customer.country populated?), then does the real investigation. Plan-execute would frontload that. But the coverage checks are cheap enough (single EQL count) that saving them isn't worth the brittleness.

## Interview defense

**Q: Why didn't you use plan-and-execute in the diagnostic path?**
A: Because the diagnostic path is exploratory. Query 2 depends on what query 1 returned. Plan-and-execute front-loads the plan, which means it assumes the plan won't need to change based on data — and here it will. If I forced plan-execute, I'd end up needing a re-plan branch on every step, which is coordination overhead with no win. Sequential ReAct keeps the model in the loop, which is where the value is when the path is data-dependent.

Diagram: the fork — "plan generalizable? yes → plan-execute; no → ReAct."
Anchor: sequential ReAct today in `lib/agents/diagnostic.ts` + `run-agent-loop.js`.

**Q: When would you introduce plan-and-execute here?**
A: When the recommendation phase grew to require N-recommendation sequences with genuinely independent branches — draft 3 scenarios, 2 segments, 1 campaign, in parallel, then rank. That's decomposable in advance, the branches are cheap Haiku calls, and the synthesis at the end is one Sonnet. Today RecommendationAgent generates a small handful of recommendations from one Sonnet loop; not worth the split.

Diagram: the hypothetical `plan-execute-recommendation.ts` shape.
Anchor: the current `lib/agents/recommendation.ts` for the "not yet" baseline.

## See also

- `03-react.md` — the current pattern.
- `05-reflexion-self-critique.md` — the other escalation direction.
- `03-multi-agent-orchestration/03-sequential-pipeline.md` — the multi-agent version of a plan-execute chain.
- `06-orchestration-system-design-templates/03-agentic-coding-system.md` — where plan-execute is the standard architecture.

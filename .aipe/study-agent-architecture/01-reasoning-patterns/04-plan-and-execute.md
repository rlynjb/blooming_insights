# Plan-and-execute

**Industry standard.** A reasoning pattern that separates planning from doing. **Not yet implemented** in this codebase.

## Zoom out, then zoom in

Sits at the same layer as ReAct — a prompting strategy the agent loop runs. The difference is the conversation shape: one expensive call up front, then many cheap calls executing the plan.

```
  Zoom out — where this concept WOULD live

  ┌─ Reasoning layer ───────────────────────────────┐
  │  (today: every agent runs ReAct)                 │
  │  (would: an agent could run plan-and-execute)    │
  └────────────────────────────┬────────────────────┘
                               │
  ┌─ Runtime layer ───────────▼────────────────────┐
  │  runAgentLoop  (the skeleton)                   │
  └────────────────────────────┬────────────────────┘
                               │  prompted with...
  ┌─ Prompting layer ─────────▼────────────────────┐
  │  ReAct (today)   ◄── escalation point           │
  │  ★ Plan-and-execute (when ReAct hits a ceiling)★│ ← we are here
  └─────────────────────────────────────────────────┘
```

This file places the pattern in the escalation family. The repo doesn't run it; if a future investigation got long enough that the path was knowable in advance, this is what you'd reach for.

## Structure pass

Layers: planner call (one expensive model) → execute calls (many cheap models) → optional re-plan trigger when execution diverges.

**Axis traced — "where does the strategy come from?":** all up front, in one call, from the expensive model. Execute calls don't re-decide the strategy; they only do the next step.

**Seam:** the plan itself is the typed handoff between the two phases. Plans tend to be a list of `{step, dependencies, expectedOutput}` objects — structured enough that the execute phase can iterate over them mechanically.

## How it works

### Move 1 — the mental model

You know the difference between a fresh debugger session and a written runbook. ReAct is the debugger — every move is "look at what I just learned, decide the next thing." Plan-and-execute is the runbook — someone (the expensive model, once) writes the steps in order; someone else (the cheap model, many times) follows them.

```
  The two-phase shape

  ┌─ Plan phase (ONE expensive call) ─────────────────────────┐
  │  input:  user goal + tools + context                       │
  │  model:  Claude Sonnet (or a heavier reasoning model)      │
  │  output: ordered list of steps with dependencies           │
  │                                                             │
  │   plan = [                                                  │
  │     { step: 1, action: "query revenue", depends: [] },      │
  │     { step: 2, action: "localize by country", depends: [1]},│
  │     { step: 3, action: "test churn hypothesis", depends: [1│
  │     { step: 4, action: "synthesize", depends: [2, 3] },     │
  │   ]                                                         │
  └─────────────────────────────┬──────────────────────────────┘
                                │  plan
                                ▼
  ┌─ Execute phase (MANY cheap calls) ────────────────────────┐
  │  for each step in topological order:                       │
  │     model: Claude Haiku (or cheap/fast)                    │
  │     input: the step's action + relevant prior results      │
  │     output: the step's result                              │
  │                                                             │
  │  cheap models cannot re-plan — they only execute            │
  └────────────────────────────────────────────────────────────┘
```

The win is decoupling strategy from grunt work. One expensive call decides the plan; many cheap calls execute it. The cost-per-investigation can drop substantially when the plan has more than ~5-6 steps; below that, the planning overhead doesn't amortize.

### Move 2 — step by step

#### What this would look like in this repo

The diagnostic agent (`lib/agents/diagnostic.ts`) is the natural candidate. Today it runs straight ReAct: `DiagnosticInvestigationAgent.investigate(anomaly)` calls `runAgentLoop` with maxTurns=8 and lets the model decide each turn.

A plan-and-execute version would split into two AptKit-shaped passes:

```ts
// hypothetical lib/agents/diagnostic-planning.ts (not implemented)
class PlanningDiagnosticAgent {
  constructor(
    private planner: ModelProvider,    // Sonnet
    private executor: ModelProvider,   // Haiku
    private tools: ToolRegistry,
    // ... ports as today
  ) {}

  async investigate(anomaly: Anomaly, hooks: AgentHooks): Promise<Diagnosis> {
    // Phase 1: plan
    const plan = await runAgentLoop({
      capabilityId: 'diagnostic-planner',
      model: this.planner,
      tools: this.tools,
      system: PLAN_SYSTEM_PROMPT,
      userPrompt: `Plan a diagnostic investigation for ${anomaly.metric}.`,
      maxTurns: 2,  // tight cap — planning, not investigation
      parseResult: parsePlan,
    });

    // Phase 2: execute
    const results = [];
    for (const step of plan.parsed.steps) {
      const result = await runAgentLoop({
        capabilityId: 'diagnostic-executor',
        model: this.executor,
        tools: this.tools,
        system: EXECUTE_SYSTEM_PROMPT,
        userPrompt: `Execute step: ${step.action}. Prior results: ${
          JSON.stringify(results.filter(r => step.depends.includes(r.step)))
        }`,
        maxTurns: 3,
      });
      results.push({ step: step.step, result: result.finalText });
    }

    return synthesizeDiagnosis(anomaly, results);
  }
}
```

Two notes on this shape:

- Each call to `runAgentLoop` is still one of the same skeleton from `02-agent-loop-skeleton.md`. Plan-and-execute is *two skeletons stacked*, not a new primitive.
- The planner and executor are *different model providers* (different cost tiers). Sonnet plans, Haiku executes. The model adapter (`AnthropicModelProviderAdapter`) takes the model name in its constructor (`lib/agents/aptkit-adapters.ts:31-37`) so this is trivial to wire — pass a different `AGENT_MODEL` to each ` ModelProvider` instance.

#### The re-plan trigger — where plan-and-execute breaks honestly

The brittle part: a plan assumes the path through the data; when an execute step's result invalidates the plan ("step 2 said the cause is churn, but the data shows no churn"), the remaining steps are wrong. The mitigation is a *re-plan trigger* — after each execute step, a cheap check ("does this result confirm or contradict the plan's assumption?") and if it contradicts, restart from the planning phase with the new information.

That trigger turns plan-and-execute into "ReAct with a plan-shaped scratchpad." If the trigger fires every step, you've collapsed back to ReAct's cost. If it never fires, you've got the canonical plan-and-execute win. The breakpoint for this repo's diagnostic agent: if 80%+ of investigations would execute the planned steps without contradiction, the pattern earns its overhead.

### Move 3 — the principle

**Plan-and-execute is the right escalation when the path is knowable but long.** "Knowable" is the load-bearing word: the planner has to be able to write a useful plan from the goal + context alone, without needing to see intermediate results. "Long" is the supporting word: the cost of the planning call needs many execute calls to amortize over. If the path is *not* knowable up front (the diagnostic agent's case today — which hypothesis to test next depends on what the previous query returned), ReAct is the correct choice and plan-and-execute will just add a useless first call.

## Primary diagram

```
  Plan-and-execute as two skeletons stacked

  ┌─ Plan skeleton ────────────────────────────────────────────────┐
  │  user prompt: "investigate this anomaly"                        │
  │   ▼                                                              │
  │  Sonnet (expensive)                                              │
  │   ▼                                                              │
  │  one model.complete call, no tools (or tools to peek at schema) │
  │   ▼                                                              │
  │  plan = { steps: [...with dependencies...] }                    │
  └─────────────────────────────┬──────────────────────────────────┘
                                │  plan
                                ▼
  ┌─ Execute skeleton (run N times) ──────────────────────────────┐
  │  per step in topological order:                                 │
  │    user prompt: "execute step X; prior results: ..."            │
  │     ▼                                                            │
  │    Haiku (cheap)                                                 │
  │     ▼                                                            │
  │    runAgentLoop with maxTurns=2-3, tools allowed                │
  │     ▼                                                            │
  │    result = step output                                          │
  │  collect results[]                                              │
  └─────────────────────────────┬──────────────────────────────────┘
                                │  results[]
                                ▼
  ┌─ Optional re-plan check ──────────────────────────────────────┐
  │  if any step's result contradicts the plan's assumption:        │
  │     loop back to Plan skeleton with new info                    │
  │  else: synthesize final answer from results                     │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The most common implementation pattern uses LangGraph (or an equivalent state-machine library) to express the plan-and-execute shape as a graph — a planner node, a router that dispatches each step to a per-step executor node, and a re-plan node gated by a contradiction check. The graph framing is more robust than the for-loop framing above because it makes the dependencies between steps inspectable and makes the re-plan path a first-class edge instead of a control-flow hack.

The Anthropic blog's "extended thinking + tool use" post argues a related point: for *some* problem shapes, the right pattern isn't plan-and-execute at all but extended-thinking ReAct — let the model think for many tokens before each action, but keep the per-turn structure of ReAct. The two patterns are competing answers to "the model wanders mid-run." Plan-and-execute solves it by removing per-step decisions; extended thinking solves it by giving the model more room per decision. Both are escalations from baseline ReAct; the choice between them depends on whether the wandering is "the model doesn't know the strategy" (plan-and-execute wins) or "the model knows but reasons too shallowly per step" (extended thinking wins).

## Interview defense

> **Q: Why doesn't this codebase use plan-and-execute?**
>
> The path through the data isn't knowable up front. The diagnostic agent's investigations depend on what each query returns — "revenue dropped, now localize by country, now check whether the dropping country has a churn correlation, now test whether the churn correlation appears in any specific segment." The next hypothesis to test depends on the previous result. A plan written before turn 1 would be guessing; by turn 3 it would need re-planning, which collapses back to ReAct's cost. The breakpoint where this would change: if diagnostic investigations grew to 15+ tool calls AND the hypothesis order became standardizable per anomaly category. Neither is true today.

> **Q: If you had to add plan-and-execute, where would it go and what would it cost?**
>
> The recommendation agent is the better candidate, not the diagnostic agent. Recommendations follow a more predictable path: read scenarios, read segments, read campaigns, then propose. A planner could list "step 1: read scenarios for this anomaly's category; step 2: read segments matching the affected customer profile; step 3: read recent campaigns; step 4: synthesize" before any execute call runs. The cost: one extra Sonnet call up front (~2-3K tokens, ~$0.02), then 3-4 Haiku execute calls instead of 3-4 Sonnet ReAct turns. Net win is roughly 60-70% on tokens for the recommendation phase. The risk: if step 1 returns no scenarios for this category, the rest of the plan is wrong and we re-plan — paying the planning cost twice.
>
> Anchor: hypothetical refactor of `lib/agents/recommendation.ts` to split into planner + executor wrappers over `runAgentLoop`.

> **Q: Plan-and-execute vs extended-thinking ReAct — when each?**
>
> Plan-and-execute when the model's failure mode is "doesn't know the strategy" — the path is knowable, the model just needs to commit to it before getting distracted. Extended thinking when the failure mode is "knows but reasons too shallowly" — give the model more tokens per decision instead of removing decisions. Both are escalations from baseline ReAct, not replacements. The interview signal is naming the failure mode that picked one over the other, not picking one because it's the newer paper.

## See also

- → `03-react.md` — the baseline this escalates from
- → `05-reflexion-self-critique.md` — the orthogonal "catch wrong outputs" escalation
- → `03-multi-agent-orchestration/02-supervisor-worker.md` — what plan-and-execute becomes when each step is a different specialist
- → `06-orchestration-system-design-templates/03-agentic-coding-system.md` — the system design template where plan-and-execute is canonical

# Plan-and-execute

*Industry name: plan-and-execute / plan-and-solve — Industry standard.*

Separate the strategy (one expensive call) from the execution (many cheap calls). Not in this repo. The diagnostic agent comes closest but stays ReAct.

## Zoom out — where this concept would live

If adopted, it would sit at the agent layer alongside the existing ReAct loops — likely as a refactor of the DiagnosticAgent where the "hypothesize, then test each" structure becomes an explicit two-phase agent instead of a prompt instruction inside one loop.

```
  Where plan-and-execute WOULD live (not yet implemented)

  ┌─ Service layer ──────────────────────────────────────────┐
  │  /api/agent?step=diagnose                                 │
  └─────────────────────┬────────────────────────────────────┘
                        ▼
  ┌─ Agent layer ────────────────────────────────────────────┐
  │  Today:   DiagnosticAgent (ReAct, plans in-loop)         │
  │  Future:  DiagnosticPlanner (sonnet, plans hypotheses)   │ ← would live here
  │         + DiagnosticExecutor (haiku per hypothesis)      │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

The axis: **when does the strategy get decided — once up front, or every turn?**

```
  ReAct (now)                          Plan-and-execute (alternative)
  ───────────────────                  ──────────────────────────────
  every turn: model re-decides         turn 1: model commits to plan
  the next move based on the last      turns 2..N: cheaper model runs
  tool result                          each step; rarely re-plans

  cost: full-power model every turn    cost: full-power once + cheap N times
  risk: model wanders if data is noisy risk: plan breaks if reality diverges
```

## How it works

### Move 1 — the mental model

You know the "make a plan before you start coding" rule. Plan-and-execute is that rule applied to the model: one expensive "what's the plan" call up front, then a series of cheap "do step N" calls. The plan is the artifact; the executors don't deviate from it.

```
  Plan-and-execute — two phases, hard split

  ┌─ Plan phase (one expensive call) ──────────────────┐
  │  model.complete("here's the goal; output the plan") │
  │  → plan: [step1, step2, step3, ...]                 │
  └──────────────────────────┬──────────────────────────┘
                             ▼
  ┌─ Execute phase (N cheap calls, optionally parallel) ┐
  │  for step in plan:                                    │
  │    result = cheap_model.execute(step)                 │
  │    if step fails badly → re-plan trigger             │
  └──────────────────────────────────────────────────────┘
```

### Move 2 — what it would look like in this repo

The diagnostic agent today (`lib/agents/diagnostic.ts` → `@aptkit/agent-diagnostic-investigation`) uses a soft plan-and-execute inside ReAct: the prompt says "generate 2-3 hypotheses before the first tool call." But the model can (and does) revise its hypotheses mid-loop as evidence comes in. That's ReAct's flexibility, not plan-and-execute's commitment.

A real plan-and-execute refactor would look like:

```
  Hypothetical diagnostic refactor — two AptKit agents instead of one

  ┌─ DiagnosticPlanner ──────────────────────────────────────┐
  │  model: claude-sonnet-4-6 (the expensive one)            │
  │  tools: none (pure reasoning over the anomaly)            │
  │  output: { hypotheses: [{id, statement, query}, ...] }    │
  │  budget: 1 turn, ~2K tokens                                │
  └──────────────────────────┬───────────────────────────────┘
                             ▼
  ┌─ DiagnosticExecutor (parallel, one per hypothesis) ──────┐
  │  model: claude-haiku-4-5 (cheap)                          │
  │  tools: execute_analytics_eql only                        │
  │  task: run this one query, score support 0..1, return     │
  │  budget: 1-2 turns each, ~1K tokens                        │
  └──────────────────────────┬───────────────────────────────┘
                             ▼
  ┌─ DiagnosticSynthesizer ──────────────────────────────────┐
  │  model: claude-sonnet-4-6 (the expensive one again)       │
  │  tools: none                                              │
  │  input: planner output + executor scores                  │
  │  output: Diagnosis (existing shape)                       │
  └──────────────────────────────────────────────────────────┘
```

The wins this would buy:
- **Lower total cost** — haiku per hypothesis is much cheaper than sonnet per turn
- **Parallel execution** — hypotheses are independent; testing them in parallel cuts latency
- **Inspectable plan** — the plan is a JSON artifact you can store, eval, regression-test

The costs it would pay:
- **Brittleness on bad data** — if a hypothesis turns out to be irrelevant mid-execution, the executor has no way to swap it for a better one; needs a re-plan trigger
- **Two new AptKit agent classes** — currently one; would become three (planner, executor, synthesizer)
- **Coordination tax** — now the route handler is orchestrating three agents instead of one; closer to true multi-agent territory (see `../03-multi-agent-orchestration/`)

### Move 3 — the principle

Plan-and-execute trades flexibility for cost and parallelism. The win is real when the task has a known shape and the steps are independent (a research question with N sub-questions, a coding task with N file edits). The loss is real when the data can surprise the plan — the model commits to "check checkout funnel" and then the evidence says "actually it's payment processor errors." ReAct adapts; plan-and-execute has to bail to a re-plan.

## In this codebase

**Not yet implemented.** The diagnostic agent uses a ReAct loop with a planning *prompt instruction*, not a two-phase architecture. The current DiagnosticAgent at `lib/agents/diagnostic.ts:35-44` is a single `runAgentLoop()` call where the model interleaves hypothesizing and testing within the same loop.

Why not implemented: the diagnostic agent's quality ceiling under ReAct has not been measured against a workload that would expose ReAct's failure mode (the model wandering off the hypothesis list). With ~1 req/s MCP rate-limit, parallel execution would also require coordinating concurrency at the data-source layer, which is its own refactor (see `../05-production-serving/02-fan-out-backpressure.md`).

The system-design template for adopting it lives in `../06-orchestration-system-design-templates/03-agentic-coding-system.md`'s "How to make it apply" bullet.

## Primary diagram

The contrast between today's ReAct diagnostic and a future plan-and-execute diagnostic:

```
  Comparison — current vs hypothetical diagnostic

  TODAY (ReAct, one agent):                  FUTURE (plan-and-execute, three):
  ┌────────────────────────┐                 ┌─────────────┐
  │  DiagnosticAgent       │                 │  Planner    │  sonnet ×1
  │  prompt: "generate     │                 │  hypotheses │
  │   2-3 hypotheses then  │                 └──────┬──────┘
  │   test each"           │                        │ parallel
  │                        │                  ┌─────┴─────┬─────┐
  │  while not done {      │                  ▼           ▼     ▼
  │    pick next move      │                ┌────┐   ┌────┐  ┌────┐
  │    (test, re-plan,     │                │exec│   │exec│  │exec│  haiku ×N
  │     conclude)          │                │ H1 │   │ H2 │  │ H3 │
  │  }                     │                └─┬──┘   └─┬──┘  └─┬──┘
  │  maxToolCalls=6        │                  └────────┼──────┘
  └────────────────────────┘                           ▼
                                              ┌──────────────┐
                                              │ Synthesizer  │  sonnet ×1
                                              │ → Diagnosis  │
                                              └──────────────┘
```

## Elaborate

Plan-and-execute crystallized in 2023 around papers like "Plan-and-Solve Prompting" (Wang et al.) and the LangChain pattern of the same name. The key insight: pure ReAct re-evaluates the whole strategy on every turn, which is expensive AND lets the model wander. Decoupling planning from execution gives you the same quality on structured tasks for less money.

The "re-plan trigger" is the usual production tax. A pure plan-and-execute breaks the first time reality diverges from the plan. Production implementations add a re-plan condition: if an executor returns "this doesn't make sense" or a confidence score below threshold, the planner runs again with the new context. At that point you've nearly recreated ReAct, just at a coarser granularity.

The right thing to take away: plan-and-execute is ReAct with a cost-shifting move — pay more up front for the plan so each step costs less. It earns its complexity when the per-step savings × N steps exceeds the planning overhead, which is roughly "N > 4 and the steps are similar in shape."

## Interview defense

**Q: "Why didn't you use plan-and-execute for the diagnostic agent?"**

A: Because ReAct hasn't hit a ceiling that justifies the refactor. The diagnostic prompt asks for 2-3 hypotheses up front — a soft plan — and the model usually follows it. The cases where it doesn't (the data surprises the hypothesis list) are exactly the cases where ReAct's flexibility helps. If we measured the trajectory traces and found the model consistently wasting tool calls on already-rejected hypotheses, that would be the failure mode that justifies the escalation. Right now the failure mode is more "the model's first hypothesis is too broad" — a prompt fix, not an architectural one.

Diagram I'd sketch:

```
  ReAct here                Plan-execute would be:
  ┌──────────┐              ┌─────────┐  → ┌──────┬──────┬──────┐  → ┌──────┐
  │ hypoth.  │              │planner  │    │exec  │exec  │exec  │    │synth │
  │ + test   │              │(sonnet) │    │(haiku)              │    │(sonnet)│
  │ in loop  │              └─────────┘    └──────┴──────┴──────┘    └──────┘
  └──────────┘
  one agent                 three agents — closer to multi-agent
```

Anchor: "the prompt at `lib/agents/legacy-prompts/diagnostic.md` already does the soft plan-and-execute. The escalation is from 'prompt-instructed plan' to 'separate planner agent' — that's the breakpoint we haven't crossed."

## See also

- [`03-react.md`](./03-react.md) — what the diagnostic agent currently is
- [`05-reflexion-self-critique.md`](./05-reflexion-self-critique.md) — the other escalation past ReAct
- [`../03-multi-agent-orchestration/02-supervisor-worker.md`](../03-multi-agent-orchestration/02-supervisor-worker.md) — what this becomes if you take the next step
- [`../06-orchestration-system-design-templates/03-agentic-coding-system.md`](../06-orchestration-system-design-templates/03-agentic-coding-system.md) — template where plan-execute is the standard architecture

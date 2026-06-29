# Graph orchestration

**Industry standard.** Control flow as an explicit state machine with nodes, edges, and checkpointed state. **Not exercised** in this codebase.

## Zoom out, then zoom in

Sits one layer above any of the other topologies. Graph orchestration is the *expression mechanism* for supervisor-worker, pipeline, debate — any of them can be drawn as a graph with explicit state, conditional edges, and checkpointing for human review.

```
  Zoom out — where this WOULD live

  ┌─ Orchestration layer ───────────────────────────┐
  │  Today: imperative TypeScript in route handlers  │
  │  Would: ★ explicit state machine ★              │ ← we are here
  │  (nodes = agents/checks; edges = transitions;    │
  │   state = shared, checkpointed)                  │
  └──────────────────────────────────────────────────┘
```

## Structure pass

Layers: nodes (agents, checks, transformations) → edges (transitions, with conditional logic) → shared state (the graph's accumulated context) → checkpoint store (durable state for human-in-the-loop pauses + resumes).

**Axis traced — "how is the orchestration expressed?":** in this repo, as imperative TypeScript (`if`, `await`, `switch`). In a graph version, as a declarative graph definition the runtime walks.

**Seam:** the state at each node. The graph's state is shared across nodes (any node can read/write); checkpointing persists state between transitions so a paused graph can resume.

## How it works

### Move 1 — the mental model

You know the multi-step form pattern in a frontend app — `Stepper` component, each step is its own page, the form state lives in a store the steps share, you can navigate back, and a "save and resume later" button persists the state to a server. Graph orchestration is that pattern applied to agents — each step is a node (often an agent), the shared state is the conversation + accumulated outputs, checkpointing makes the graph resumable.

```
  Graph shape

  ┌──────┐    ┌──────┐    ┌──────┐
  │ node │───►│ node │───►│ node │
  │  A   │    │  B   │    │  C   │
  └──────┘    └──┬───┘    └──────┘
                 │ conditional edge
                 ▼
              ┌──────┐
              │ node │  (loop back / branch)
              │  D   │
              └──────┘
```

The win is debuggability and human-in-the-loop pauses: you can stop at any node, inspect the state, ask a human to approve, then resume. The cost is structural — you have to *define the graph* up front instead of letting the model freewheel.

### Move 2 — step by step

#### Where this could land in this repo

The investigation pipeline (`monitoring → diagnose → recommend` with the user clicking through) is already a state machine of sorts — three states, two user-driven transitions. A graph version would make it explicit:

```ts
// hypothetical graph definition (using something like LangGraph,
// not implemented in this repo)
const investigationGraph = createGraph({
  nodes: {
    'await_anomaly_pick': awaitAnomalyPick,        // pause for user click
    'diagnose': diagnosticAgentNode,
    'await_recommend_click': awaitRecommendClick,  // pause for user click
    'recommend': recommendationAgentNode,
    'done': doneNode,
  },
  edges: [
    { from: 'await_anomaly_pick', to: 'diagnose' },
    { from: 'diagnose', to: 'await_recommend_click' },
    { from: 'await_recommend_click', to: 'recommend' },
    { from: 'recommend', to: 'done' },
    // conditional: if recommendations are empty, loop back to diagnose
    {
      from: 'recommend',
      to: 'diagnose',
      condition: (state) => state.recommendations.length === 0,
    },
  ],
  state: investigationStateSchema,  // typed shared state
});
```

The conditional edge ("if recommendations are empty, loop back to diagnose") is the kind of branching the current `if`-statement approach struggles to express cleanly once you have more than a couple. The state machine makes it declarative.

#### The win that's load-bearing

The two real wins from graph orchestration:

1. **Resumability across requests.** The graph's state is persisted at each checkpoint, so a graph can pause (for a human approval, a tool result, a time-based trigger) and resume later — even across server instances. This repo today fakes resumability via the client's `sessionStorage` (`03-sequential-pipeline.md`); a graph runtime would do it via a checkpoint store on the server.

2. **Inspectable transitions.** The graph definition IS the documentation of the orchestration. Reading the route handler today, you have to trace `if`s through 300 lines of TypeScript. Reading a graph definition, you see the nodes and edges at a glance.

#### Why this repo doesn't reach for it today

Three reasons:

1. **No persistent state store.** The project intentionally avoids a database. A graph runtime would need to persist checkpoints — adding a Redis/Postgres dependency the architecture has avoided.
2. **The orchestration is simple.** Three stages + two user transitions don't require a graph. The route handlers' `if`s express it fine.
3. **No human-in-the-loop pauses for approval.** The current "human in the loop" is the user clicking through screens, which the SPA navigation handles. There's no "agent pauses, waits for approval, resumes" pattern.

If any of these change — a graph runtime gains traction in the team's stack, the orchestration grows to 10+ conditional branches, the product adds approval gates for recommendations before they show — the calculus tips toward adopting graph orchestration.

#### The composition with other topologies

Graph orchestration *contains* the other topologies as sub-shapes. A supervisor-worker is a graph where one node fans out to N worker nodes and a synthesis node merges. A debate is a graph with two producer nodes and a judge node. A pipeline is a graph with a linear sequence of nodes. The graph runtime gives you the inspectable state and checkpointing for free across all of them.

This is why production agent systems that hit a certain complexity threshold adopt a graph runtime (LangGraph being the dominant one in the LangChain stack): the runtime cost amortizes across multiple agent topologies in the same product.

### Move 3 — the principle

**Graph orchestration is the right escalation when the orchestration grows beyond what imperative code can express cleanly OR when resumability becomes a hard requirement.** The first is a code-quality threshold; the second is a product requirement. For systems where neither applies (this repo today), imperative orchestration is fine and cheaper. For systems where one or both apply (agentic coding tools that pause for human review at each PR, customer support systems that resume after a customer reply), the graph runtime pays for itself in inspectability and resumability.

## Primary diagram

```
  Graph orchestration applied to this repo's investigation flow (hypothetical)

  ┌─ investigation graph ────────────────────────────────────────────┐
  │                                                                    │
  │   ┌─────────────────────┐                                          │
  │   │ await_anomaly_pick  │  (paused — checkpoint here)              │
  │   └──────────┬──────────┘                                          │
  │              │ user clicks an InsightCard                          │
  │              ▼                                                     │
  │   ┌─────────────────────┐                                          │
  │   │   diagnose          │  (node = run DiagnosticAgent)            │
  │   │   reads: anomaly    │                                          │
  │   │   writes: diagnosis │                                          │
  │   └──────────┬──────────┘                                          │
  │              │                                                      │
  │              ▼                                                     │
  │   ┌─────────────────────┐                                          │
  │   │ await_recommend_clk │  (paused — checkpoint here)              │
  │   └──────────┬──────────┘                                          │
  │              │ user clicks "see recommendations →"                 │
  │              ▼                                                     │
  │   ┌─────────────────────┐                                          │
  │   │   recommend         │  (node = run RecommendationAgent)        │
  │   │   reads: anomaly,   │                                          │
  │   │          diagnosis  │                                          │
  │   │   writes: recs      │                                          │
  │   └──────────┬──────────┘                                          │
  │              │                                                      │
  │              ├─ if recs.length == 0 ──┐                            │
  │              │                         ▼                            │
  │              │                  (loop back to diagnose with        │
  │              │                   "no recommendations found —        │
  │              │                    explore more hypotheses")         │
  │              │                                                      │
  │              ▼                                                      │
  │   ┌─────────────────────┐                                          │
  │   │    done             │                                          │
  │   └─────────────────────┘                                          │
  │                                                                    │
  │   State (persisted at each checkpoint):                            │
  │     { anomaly, diagnosis?, recommendations[], traceEvents[] }      │
  │                                                                    │
  │   Resumable across requests via a checkpoint store                 │
  │   (Postgres / Redis — this repo doesn't have one today)            │
  └──────────────────────────────────────────────────────────────────┘
```

## Elaborate

LangGraph (LangChain's state-machine library for agent orchestration) is the dominant graph runtime in the LLM tooling ecosystem. Microsoft's Semantic Kernel has a similar shape (Workflows). The pattern emerged because the "agent as a one-shot ReAct loop" framing breaks down once production systems need: (a) human-in-the-loop gates between stages, (b) durable resumability for long-running tasks, (c) inspectable orchestration definitions for compliance and debugging.

The cost of adopting a graph runtime in a working system isn't trivial. The state schema has to be designed up front; the checkpoint store has to be operational (with all the deployment complexity that adds); the team has to learn the graph DSL or library. Teams that don't *need* these things should not pay these costs. Teams that do need them get clean orchestration + resumability + inspectability all at once.

The "everything is a graph" framing is more useful as an analytical tool than as an implementation forcing function. You can *describe* every multi-agent topology as a graph (it's the lingua franca for orchestration shapes). That doesn't mean you have to *implement* every system using a graph runtime — the route handlers in this repo are perfectly readable as imperative code, and the orchestration shape they implement IS a graph (you can draw it; it's just not declared as one).

## Interview defense

> **Q: Would graph orchestration help this codebase?**
>
> Today, no. The orchestration is three stages with two user-driven transitions — a state machine simple enough that the route handlers' `if`s express it cleanly. Adopting a graph runtime would add a checkpoint-store dependency the project intentionally avoids and learning overhead for a team that doesn't need the inspectability win at this complexity. The escalation point would be: if the orchestration grew to 10+ conditional branches OR if the product added agent pauses for human approval (e.g. "show this recommendation to a human before sending"), the graph runtime starts to earn its cost.

> **Q: How does graph orchestration relate to the other topologies?**
>
> Graph is the expression mechanism for the others. Supervisor-worker, pipeline, debate, swarm — all can be drawn as graphs with explicit state and edges. The graph runtime gives you inspectability + resumability + checkpointing for free across whichever topology you pick. That's why production agent systems that hit a complexity threshold adopt a graph runtime: the runtime cost amortizes across multiple topology shapes in the same product. For a single-topology system (this repo's deterministic pipeline) the amortization doesn't apply.

> **Q: What would change if you needed resumable investigations?**
>
> The architecture would need a checkpoint store (Postgres or Redis), the orchestration would migrate to a graph runtime (LangGraph or equivalent), and the client-side `sessionStorage` handoff between step 2 and step 3 would move server-side. The user experience would gain "abandon the investigation mid-step, come back later, resume from where you left off." The cost is the database dependency the architecture has resisted plus the operational complexity of the checkpoint store. Today the user's "abandon and restart" cost is acceptable because investigations are 1-3 minutes total, not multi-hour.

## See also

- → `02-supervisor-worker.md` — one topology graph orchestration can express
- → `03-sequential-pipeline.md` — the current orchestration shape (which IS a graph, just not declared as one)
- → `05-debate-verifier-critic.md` — another topology graph orchestration can express
- → `08-shared-state-and-message-passing.md` — the state model graph orchestration formalizes

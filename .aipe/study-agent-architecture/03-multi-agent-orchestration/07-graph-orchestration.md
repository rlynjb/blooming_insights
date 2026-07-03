# Graph orchestration

*Industry names: graph orchestration / stateful workflow / LangGraph-style · Language-agnostic*

## Zoom out

```
  Zoom out — explicit state machine as the orchestrator

  ┌─ SECTION C topologies ──────────────────────┐
  │  supervisor-worker (this repo)               │
  │  sequential pipeline                         │
  │  parallel fan-out                            │
  │  debate / verifier-critic                    │
  │  swarm / handoff                             │
  │  ★ graph orchestration ★                     │ ← we are here
  └──────────────────────────────────────────────┘
```

## Zoom in

Control flow as an explicit state machine: nodes are agents (or steps), edges are transitions (with conditions), state is shared and checkpointed. This is the topology that makes the others inspectable — supervisor-worker, pipeline, and debate can all be expressed as graphs. This repo does *not* use a graph framework; the sequence is inline TypeScript in the route handler. That's a real tradeoff worth naming.

## Structure pass

Layers: **graph definition** (nodes + edges) — **state schema** — **runtime** (walks the graph) — **checkpointer** (persists state across pauses).

Axis to hold constant: **what's inspectable at each hop?**

```
  Graph vs inline sequencing — what's inspectable

  Inline route (this repo):        Graph orchestration:
    read the .ts file to know       read the graph definition to
    the sequence                    know the sequence
    debug via console.log            debug via runtime state snapshots
    modify by editing code           modify by editing the graph
    no checkpoint / no pause         checkpoint-and-resume built in
    UI shows what code emitted       UI can show the graph itself
```

## How it works

### Move 1 — the shape

You've written a form-wizard component with a state machine driving which step renders. Same shape. In a graph orchestration framework (LangGraph is the reference), each "step" is either a single node function or an LLM agent, and the state is the payload every node reads and writes.

```
  Graph orchestration — nodes, edges, state

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

### Move 2 — what's inline in this repo today vs what a graph would give

**Today.** The sequence is TypeScript in `app/api/agent/route.ts`. Reading the route tells you the sequence. There is a state — the shared `WorkspaceSchema`, `BudgetTracker`, tools, and the `Diagnosis` handed between steps — but it's a set of local variables passed as function arguments, not a first-class typed state schema.

```
  Today — the sequence is inline

  ┌─ app/api/agent/route.ts ──────────────────────┐
  │  schema = await bootstrap()                   │
  │  allTools = await dataSource.listTools()      │
  │  budget = new BudgetTracker({ maxCostUsd: … })│
  │                                               │
  │  if step === 'diagnose' || !step:             │
  │    diagAgent = new DiagnosticAgent(…)         │
  │    diagnosis = await diagAgent.investigate(…) │
  │    send({type: 'diagnosis', diagnosis})       │
  │                                               │
  │  if step === 'recommend' || !step:            │
  │    recAgent = new RecommendationAgent(…)      │
  │    recs = await recAgent.propose(anomaly,     │
  │                                  diagnosis,…) │
  │    for r in recs: send(…)                     │
  └───────────────────────────────────────────────┘
```

**With a graph framework (hypothetical).** The same sequence as a LangGraph-style declaration:

```
  Same sequence, expressed as a graph

  ┌─ (hypothetical) lib/agents/graph.ts ──────────┐
  │  const graph = new StateGraph<InvState>()     │
  │                                               │
  │  graph.addNode('bootstrap',    bootstrap)     │
  │  graph.addNode('list_tools',   listTools)     │
  │  graph.addNode('diagnostic',   runDiagnostic) │
  │  graph.addNode('recommendation', runRec)      │
  │                                               │
  │  graph.addEdge('bootstrap', 'list_tools')     │
  │  graph.addEdge('list_tools', 'diagnostic')    │
  │  graph.addConditionalEdge('diagnostic', s =>  │
  │    s.step === 'recommend' ? 'recommendation'  │
  │                            : END)             │
  │                                               │
  │  const runtime = graph.compile({              │
  │    checkpointer: new PostgresCheckpointer(),  │
  │  })                                           │
  │                                               │
  └───────────────────────────────────────────────┘
```

**The four things a graph framework buys you.**

1. **Inspectable structure.** The graph definition IS the sequence. You can render it as a diagram automatically; you can serialize it for the UI. No need to read TS code to know the flow.
2. **Checkpoint and resume.** State persists at every node boundary. Pause on user input, wait weeks, resume from the exact same state. This is the *human-in-the-loop* substrate — see `04-agent-infrastructure/05-guardrails-and-control.md`.
3. **Typed state schema.** The `InvState` shape is the contract every node reads/writes. Refactor-safe — adding a field is a type change, not a hidden coupling.
4. **First-class conditional edges.** The if/else in the route becomes `addConditionalEdge(source, condFn)`. Testable in isolation.

**What you give up.**

1. **Framework tax.** LangGraph is TypeScript + Python; the TS story is less mature. Adopting adds a dependency, a learning curve, and one more thing that can go wrong.
2. **Overkill for stable sequences.** If your sequence is three stages that never branch, the graph declaration is more ceremony than the inline if/else buys back.
3. **Debug indirection.** You now debug both the graph (why did this edge fire?) AND the node (what did the agent do?). Two loops of context-switching per bug.

**When to reach for graph orchestration.**

- **Human-in-the-loop pauses.** If any node needs to pause for human approval and resume days later, graph's checkpointer is the substrate. Rolling your own is painful.
- **Branching decisions on state.** If different anomalies would need genuinely different paths ("critical anomalies get an extra approval node; positive anomalies skip diagnosis"), graph's conditional edges are cleaner than nested ifs.
- **UI wants to show the flow.** If you want to render the workflow as a diagram in the UI, the graph is already the diagram.

**Why this repo hasn't reached for it yet.** The sequence is stable (three stages, no branching), the state is simple (Diagnosis passes through), and human-in-the-loop is limited to "user clicks 'see recommendations' between step 2 and step 3" (handled by client-side navigation, not server checkpointing). The inline route wins on simplicity. If any of those three preconditions changed — branching, complex state, or genuine multi-day pauses — graph would be the right refactor.

### Move 3 — the principle

Graph orchestration is the topology that makes the others inspectable. Supervisor-worker, pipeline, debate — all expressible as graphs with explicit state. The tradeoff is up-front structure vs implicit sequencing. Reach for the graph when the sequence branches, when human-in-the-loop pauses matter, or when the UI needs to render the flow. Skip it when the sequence is stable and the inline version is readable.

## Primary diagram

```
  Graph orchestration — what a framework version of this repo would look like

  ┌─ StateGraph<InvestigationState> ──────────────────────────┐
  │                                                            │
  │  START                                                     │
  │    │                                                       │
  │    ▼                                                       │
  │  ┌────────────┐                                            │
  │  │ bootstrap  │  loads schema, tools, budget               │
  │  └─────┬──────┘                                            │
  │        ▼                                                   │
  │  ┌────────────┐                                            │
  │  │ diagnostic │  (an agent node — runs ReAct loop inside)  │
  │  └─────┬──────┘                                            │
  │        │ writes state.diagnosis                            │
  │        ▼                                                   │
  │  ┌────────────────────┐                                    │
  │  │ conditional edge:  │                                    │
  │  │   step==='recommend│──── yes ───┐                       │
  │  │      or step===null│            ▼                       │
  │  │   step==='diagnose'│─── no ──► END                      │
  │  └────────────────────┘            │                       │
  │                                    ▼                       │
  │                              ┌─────────────┐               │
  │                              │recommendation│               │
  │                              └──────┬──────┘               │
  │                                     ▼                       │
  │                                    END                     │
  │                                                            │
  │  checkpointer: persists state at every node boundary       │
  │  → could pause between diagnostic and recommendation       │
  │    for hours/days and resume with same state              │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

Graph orchestration became a first-class pattern with LangGraph (2024, LangChain team). The framework's contribution was reifying "the agent workflow" as a serializable graph rather than a Python function — you can inspect it, checkpoint it, render it. LlamaIndex Workflows, CrewAI Flow, and Temporal-style durable execution are variations of the same idea (state + explicit transitions + checkpointing).

The deeper principle is **making state explicit**. Once state is a first-class typed schema, you can: pause + resume, restore from failure, run the same state through different runtimes (dev vs prod), replay for debugging, and expose the graph as a UI artifact. All of these are hard to bolt onto an inline route handler.

The frontier now is **agent DAGs with parallel branches** — a graph where multiple parallel nodes fan out and merge — LangGraph's `parallel_state` and CrewAI's `Flow` both support this. That's where graph orchestration meets fan-out (`04-parallel-fan-out.md`).

## Interview defense

**Q: Why aren't you using LangGraph?**

Three reasons.

First, the sequence is stable — three stages that don't branch. Graph's advantage is expressing conditional edges cleanly; I have one conditional (`step === 'diagnose' || 'recommend'`) and it's fine as an if/else.

Second, state is simple — the Diagnosis JSON passes through from step 2 to step 3 via URL param. There's no complex state shape that would benefit from a typed schema.

Third, human-in-the-loop is coarse — the "pause" between diagnostic and recommendation is the user navigating between pages, handled client-side. There's no need for server-side checkpointing across days.

Where I'd reach for it: if the sequence started branching per anomaly type, if state grew beyond the Diagnosis handoff, or if I needed multi-day pauses for real human approval flows.

*Anchor visual:* the today-inline vs hypothetical-graph comparison above.

**Q: What does graph orchestration buy you that supervisor-worker doesn't?**

Inspectable structure and checkpointing. The graph definition IS the sequence — you don't need to read the route code to understand the flow. And checkpointing lets you pause on human input and resume from the exact state. My supervisor-worker version has neither — the sequence is inline TS, and any "pause" is really the client re-issuing a fresh request.

## See also

- **`02-supervisor-worker.md`** — the topology this repo picked instead.
- **`04-parallel-fan-out.md`** — graph orchestration + fan-out is the frontier.
- **`08-shared-state-and-message-passing.md`** — the state schema is the graph's substrate.
- **`04-agent-infrastructure/05-guardrails-and-control.md`** — checkpointing is the human-in-the-loop substrate.

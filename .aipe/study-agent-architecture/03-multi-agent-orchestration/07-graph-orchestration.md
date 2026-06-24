# Graph orchestration

**Industry name(s):** Graph orchestration, agent state graph, StateGraph, LangGraph-style orchestration, checkpointed multi-agent
**Type:** Industry standard · Language-agnostic

> Control flow expressed as an explicit state machine — nodes, edges, conditional transitions, checkpointed state. blooming insights' orchestration is imperative route code, NOT a checkpointed agent-state graph. The UI ProcessStepper is a UI state machine, not an agent-orchestration runtime. The topology that earns its overhead when you need debuggability, human-in-the-loop pause/resume, or branching control flow the route's `if`-ladder can't express.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Graph orchestration would replace the Pipeline coordinator band's *implementation*, not its position — same place in the stack, but the imperative `.then()` chain in `lib/agents/pipeline.ts` becomes an explicit graph (nodes, conditional edges, checkpointed state) executed by a graph runtime. In blooming insights, the Pipeline band is imperative: a ~50-line `if`-ladder plus sequential function calls. No graph runtime, no checkpointing, no resume. The UI's `ProcessStepper` is a state machine but it's a *UI* state machine — not the orchestration graph.

```
  Zoom out — where graph orchestration WOULD live

  ┌─ Route handler ─────────────────────────────────┐
  │  app/api/agent/route.ts                          │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Pipeline coordinator ──▼────────────────────────┐  ← we are here
  │  ★ GRAPH ORCHESTRATION shape (★ THIS ★, absent):  │
  │    nodes(monitor, diagnose, human_review,         │
  │          recommend, final)                        │
  │    + conditional edges + checkpointed state       │
  │  ── absent in blooming insights ──                │
  │                                                   │
  │  blooming insights' actual shape:                 │
  │    imperative route + sequential function calls   │
  │    no graph runtime, no checkpoints, no pause     │
  │    (ProcessStepper UI is not the graph runtime)   │
  └─────────────────────────┬────────────────────────┘
  ┌─ Per-agent definitions ─▼────────────────────────┐
  │  workers identical either way                     │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when does it pay to express orchestration as an explicit state graph — instead of as imperative route code (this codebase) or as a supervisor agent reasoning over transitions? The win is *inspectability* — the orchestration becomes data you can replay, pause, and resume. The cost is a runtime to operate and a state store to persist checkpoints. blooming insights' orchestration is small enough (3 stages, fixed order) that imperative code reads fine; the breakpoint is when transitions multiply or human-in-the-loop pauses become a requirement. Below, you'll see the graph mechanics and what would have to change to adopt them here.

---

## Structure pass

**Layers.** A would-be graph orchestration setup has four layers: the **Graph definition** (nodes, edges, conditions — declared as data, not as control-flow code), the **Graph runtime** (walks the graph, fires nodes, evaluates conditional edges), the **Checkpoint store** (persists graph state across pauses and resumes), and the **Per-agent worker nodes** (the same agents this codebase already has — they don't change). In blooming insights the first three are absent; the Pipeline coordinator band holds an imperative `.then()`-chain `if`-ladder, no graph runtime, no checkpoints.

**Axis: control.** Who decides which node fires next — imperative engineer-written code, a model supervisor, or an explicit data-driven graph the runtime walks? This is the right axis because the entire move graph orchestration makes is *moving the control-flow description out of code and into data the runtime can introspect*. State is a tempting alternate (checkpointing IS about state) but state-persistence is the *capability* the graph enables; the control-flow-as-data choice is what unlocks it.

**Seams.** Two seams matter. Seam 1 sits between the Graph definition and the Graph runtime — control flips from declarative (DATA describing what could happen) to operational (RUNTIME firing one node at a time). This seam is what makes the graph inspectable — replay tools read the same definition the runtime walks. Seam 2 sits between the Graph runtime and the Checkpoint store — control flips from in-memory (runtime walks the graph) to persisted (state lives long enough to pause, resume, route a human into the loop). Seam 2 is the load-bearing one for *production* graph orchestration because that's where pause/resume and human-in-the-loop earn the whole topology. In blooming insights both seams are absent — the orchestration is small enough that imperative code reads fine.

```
  Structure pass — Graph orchestration (would-be shape)

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  Graph definition (nodes + edges as data)      │
  │  Graph runtime (walks, evaluates conditions)   │
  │  Checkpoint store (persists state)             │
  │  Per-agent worker nodes (unchanged)            │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  control: who decides which node fires next?   │
  │           (code, model, or a data graph?)      │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  Seam 1: Graph definition ↔ Runtime            │
  │          (DATA → RUNTIME) makes flow           │
  │          inspectable                           │
  │  Seam 2: Runtime ↔ Checkpoint store            │
  │          (in-memory → persisted)               │
  │          ★ load-bearing — enables pause/       │
  │          resume + human-in-the-loop            │
  │  In this repo: imperative if-ladder; no graph  │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the node/edge/checkpoint mechanics and what would have to change to adopt them here.

---

## How it works

**The mental model: a multi-step-form's state machine, except each step is an agent and the state carries between agents.** Nodes own work; edges own transitions; state owns context. The engine walks the graph, runs nodes, evaluates edges, persists state.

```
Graph orchestration in one picture

   ┌──────────────────────────────────────────┐
   │  Graph definition (the data)              │
   │                                          │
   │   nodes: { monitor, diagnose, review,    │
   │            recommend, final }            │
   │   edges: { monitor → diagnose,           │
   │            diagnose → review,            │
   │            review → diagnose (if reject),│
   │            review → recommend (if ok),   │
   │            recommend → final }           │
   │   state schema: { anomaly, diagnosis?,   │
   │                   recommendations?, … }  │
   └──────────────────────────────────────────┘
                  │
                  ▼
   ┌──────────────────────────────────────────┐
   │  Engine (the runtime)                    │
   │   - reads current node                   │
   │   - runs it (typically an agent loop)    │
   │   - reads updated state                  │
   │   - picks next edge by condition         │
   │   - checkpoints state                    │
   │   - repeats                              │
   └──────────────────────────────────────────┘
```

The strategy in plain English: **make the orchestration into data so you can inspect it, debug it, pause it, replay it.** Imperative code expresses transitions in syntax (`if`/`else`/`await`); graphs express them as named edges in a definition. The latter is queryable and serializable; the former isn't. blooming insights has neither a graph definition nor a graph runtime — the orchestration is imperative TypeScript in `route.ts`, and the closest cousin (the `ProcessStepper` UI component) is a *UI* state machine, not a server-side agent-orchestration runtime. Conflating the two is the most common category error this file pre-empts.

### Layer 1 — nodes (the units of work)

The technical thing: a *node* is a function that takes the current graph state and returns an updated state. In agent graphs, the node usually wraps an agent loop — the node runs the agent, reads the agent's output, updates the state with that output.

If you're coming from frontend, a node is a `step` component in a multi-step form — it owns its own rendering and state mutations, and when it's done it tells the parent state machine to transition.

```
A node, conceptually

  function diagnose_node(state):
    diagnosis = diagnostic_agent.investigate(state.anomaly)
    return { ...state, diagnosis: diagnosis }

  // in a real graph definition:
  graph.add_node("diagnose", diagnose_node)
```

The practical consequence: each node has a clean input/output signature. You can test it in isolation. You can replace one node with a different implementation without touching the others. You can mock a node for testing the graph.

The condition under which this works: each node's job has to be expressible as "read state, do work, update state." Agents fit this well because each agent has a clear `investigate(...)` / `propose(...)` shape that maps to "read state, run loop, return updated state."

### Layer 2 — conditional edges (the transitions)

The technical thing: an *edge* is a transition from one node to another, optionally guarded by a condition over the current state. In the simplest case, every edge is unconditional ("from A go to B"). In the interesting case, edges have conditions ("from A go to B if state.confidence > 0.7; otherwise to C").

If you're coming from frontend, conditional edges are XState's `on` transitions with `cond` guards, or `useReducer` actions whose effect depends on the current state. The shape: edge = (from_node, to_node, condition).

```
Conditional edges

  Unconditional:           Conditional:
   diagnose ──► recommend   diagnose ──► review_if_low_conf
                                  │
                                  └─► recommend_if_high_conf

  // in a graph engine:
  graph.add_conditional_edge(
    "diagnose",
    lambda state: "review" if state.diagnosis.confidence == "low" else "recommend",
  )
```

The practical consequence: the graph's branching is *data*. You can serialize the graph, draw it, audit it, version it. An imperative route's branching is syntax that you have to read line-by-line to understand. The first time a junior engineer asks "which agent runs when?" the graph answers with a picture; the imperative route answers with a code walkthrough.

The condition under which this works: the transition conditions have to be expressible as functions of the state. If a transition depends on something *external* (a clock, a side-channel signal), you have to bring it into the state — which is good discipline anyway.

### Layer 3 — checkpointed state (the resumability)

The technical thing: after each node runs, the engine *persists* the updated state to a checkpoint store (in-memory, Redis, SQLite, whatever). If the run fails or pauses, you can resume from the last checkpoint — you don't have to re-run nodes that already succeeded.

If you're coming from frontend, this is `redux-persist` or `localStorage.setItem(state)` after every reducer dispatch — the next time the page loads, you start from the last state, not from the initial state. Same principle, just at the agent-orchestration layer.

```
Checkpointing

  run #1:
   monitor   ─► state checkpoint 1 (anomaly identified)
   diagnose  ─► state checkpoint 2 (diagnosis added)
   recommend ─► ERROR
   (run halted)

  resume:
   load state checkpoint 2  ── already have diagnosis
   recommend (retry)
   final

  no need to re-run monitor or diagnose
```

The practical consequence: failures don't cost you the whole run. Replay is fast. Human-in-the-loop pauses are trivial — the engine writes a checkpoint at the human node, the UI prompts the user, when the user responds the engine resumes from that checkpoint. None of this is possible with an imperative route file unless you build all of it yourself.

The condition under which this works: the state has to be serializable, and node side effects (MCP calls, LLM calls, etc.) have to be either idempotent or already-recorded. If a node makes a live LLM call and then the run resumes, you don't want to re-pay for the call — graph runtimes usually persist node outputs alongside state for this reason.

### Layer 4 — human-in-the-loop pauses (the gated nodes)

The technical thing: a *human node* is a node that *yields* control to a human and waits. The engine writes a checkpoint, returns control to the caller (often the UI), and the run is paused. When the human responds, the response is added to the state and the engine resumes.

If you're coming from frontend, this is a multi-step form's confirmation step: the form fills in everything up to "please confirm," then waits for the user to click. Until the click, no further work happens. State is persisted; the user can refresh; the form picks up where it left off.

```
A human-in-the-loop node

  diagnose
     │
     ▼
  review_diagnosis  ◄── HUMAN NODE
     │  (engine pauses here, UI prompts user)
     │  user clicks "looks good" or "redo"
     │
     ▼
  state.user_approval = "approved" | "rejected"
     │
     ▼
  conditional edge: if approved → recommend
                    if rejected → diagnose (loop)
```

The practical consequence: human-in-the-loop becomes a first-class concept, not a hack. The codebase's current "user clicks 'see recommendations'" gate is already conceptually a human node — but it's not implemented in a graph engine; the route file just splits the work into two requests and uses session storage to bridge them.

The condition under which this works: the UI has to support pause/resume — which means the UI has to know which checkpoint to resume from when the user responds. Graph frameworks handle this with a thread id; the UI passes the thread id when resuming.

### Phase A vs Phase B — imperative route vs graph runtime

```
        Now (imperative route)                If quality/debuggability forced it
┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐
│ the route handler                   │  │ Graph definition (declarative)       │
│   if-ladder + sequential function   │  │   nodes: monitor, diagnose, review,  │
│   calls                             │  │           recommend, final           │
│   no checkpointing                  │  │   edges: with conditions             │
│   no graph runtime                  │  │   state schema (typed)               │ ←
│                                     │  │                                      │
│ UI step-stepper:                    │  │ Graph engine (e.g. LangGraph)         │
│   client-side state machine for      │  │   reads node, runs agent, persists  │
│   which step is rendered             │  │   state, picks edge, repeats         │
│   does NOT carry agent context       │  │                                      │
│   cannot resume server-side runs    │  │ UI step-stepper:                     │
│                                     │  │   subscribes to graph events,        │
│                                     │  │   pauses on human nodes, resumes     │
│                                     │  │   via thread id                      │ ←
└─────────────────────────────────────┘  └─────────────────────────────────────┘
   moving from left to right: agents unchanged, route replaced
   by graph definition + engine, UI gains a checkpoint-aware
   resume hook
```

*Now:* the orchestration is imperative TypeScript in the route handler. The step-stepper UI component is a UI state machine for *rendering* the step UI — it tracks which view is active (diagnose, recommend, complete) but it doesn't own agent state. Agent state is collected in the SSE stream and accumulated client-side in an investigation hook. The "step 2 → step 3" gate works because the client persists the typed Diagnosis to session storage; the route's step 3 request reads it back. This is pause/resume *manually implemented* via the cross-request handoff — it's not graph orchestration.

*If a graph runtime were adopted:* the route file would shrink dramatically. Each agent would be wrapped in a node function. Edges would express the transitions. The graph engine would own state persistence — session storage would become a thread id passed to the engine. Human-in-the-loop pauses would be first-class. Debugging would shift from "read the route file and replay one trajectory" to "open the graph viewer and see which node failed at which state."

The takeaway: **graphs trade imperative simplicity for inspectable orchestration.** Worth it when the orchestration grows complex enough that imperative is opaque, or when checkpointing/human-in-the-loop becomes a hard requirement.

This is what people mean by "make orchestration into data." The cost is upfront ceremony (the graph definition); the win is everything that's possible once orchestration is queryable.

The full picture is below.

---

## Graph orchestration — diagram

```
Graph orchestration — full picture

  ┌─ GRAPH DEFINITION (declarative — the data) ──────────────────┐
  │                                                              │
  │   nodes:                                                      │
  │     • monitor      (monitoring agent)                         │
  │     • diagnose     (diagnostic agent)                         │
  │     • review_diag  (HUMAN — waits for "approve" / "redo")    │
  │     • recommend    (recommendation agent)                     │
  │     • final        (emit + persist)                           │
  │                                                              │
  │   edges:                                                      │
  │     monitor → diagnose                                       │
  │     diagnose → review_diag                                   │
  │     review_diag → diagnose       (if rejected)               │
  │     review_diag → recommend      (if approved)                │
  │     recommend → final                                        │
  │                                                              │
  │   state schema (typed):                                       │
  │     anomaly, diagnosis?, user_approval?, recommendations?    │
  └──────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─ ENGINE (runtime — the executor) ────────────────────────────┐
  │                                                              │
  │   for each step:                                              │
  │     1. read current node                                      │
  │     2. read current state from checkpoint store               │
  │     3. run the node (agent loop or human pause)               │
  │     4. update state                                           │
  │     5. write checkpoint                                       │
  │     6. evaluate outgoing edges' conditions                    │
  │     7. pick next node                                         │
  │     8. if human node next → pause, return to caller           │
  │     9. else → repeat                                          │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─ CHECKPOINT STORE ───────────────────────────────────────────┐
  │   thread id → list of (node, state) snapshots                 │
  │   in-memory / Redis / SQLite / whatever                      │
  │                                                              │
  │   used for: resume after failure, resume after human         │
  │             interaction, replay for debugging                 │
  └──────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─ UI (the resume hook) ───────────────────────────────────────┐
  │   subscribes to engine events                                 │
  │   on human node: prompts user, sends user response back       │
  │                  with thread id                              │
  │   on completion: renders final state                          │
  └──────────────────────────────────────────────────────────────┘

  blooming insights TODAY: NOT IMPLEMENTED. Orchestration is
  imperative TypeScript in the route handler. The step-stepper
  UI component is a UI state machine, NOT an agent-orchestration
  graph runtime.
```

---

## Implementation in codebase

**Not yet implemented as an agent-orchestration graph runtime.**

blooming insights' orchestration is imperative TypeScript in `app/api/agent/route.ts` — a 50-line `if`-ladder + sequential function calls. There is no graph definition, no engine, no checkpoint store, no human-in-the-loop pause primitive.

The honest sentence: **the UI ProcessStepper is a UI state machine — it tracks which view is rendered — but it is NOT an agent-orchestration graph runtime.** A graph runtime would own server-side state, persist checkpoints, and expose pause/resume APIs. The ProcessStepper does none of this. The "user gates step 3" UX works because the client persists the typed `Diagnosis` to `sessionStorage` and the next request reads it back — this is pause/resume *manually implemented*, not via a graph engine.

For the refactor: `../06-orchestration-system-design-templates/` includes a "graph-based investigation workflow" template that names the LangGraph nodes, edges, and state schema this codebase would adopt; the four agents themselves wouldn't change — they'd be wrapped in node functions.

**The imperative orchestration (what graph would replace)**
**File:** `app/api/agent/route.ts`
**Function / class:** `GET` stream `start()` body
**Line range:** L199–L249 — lead-agent select, query branch, pipeline transitions, error handling

**The UI step state machine (NOT the graph runtime)**
**File:** `lib/hooks/useInvestigation.ts` and the ProcessStepper UI component
**Function / class:** the SSE handler's reducer of event types into UI state
**Line range:** L66–L150 — accumulates agent events into UI state; does not own agent context or expose checkpoints

**The manual cross-request pause/resume (the "human-in-the-loop" today, not via a graph engine)**
**File:** `lib/hooks/useInvestigation.ts`
**Function / class:** the `case 'done':` handler
**Line range:** L130–L143 — writes the `Diagnosis` to `sessionStorage`; the next request reads it via `parseDiagnosis` in `route.ts` L86–L97

```
shape (the absence — what a graph definition would look like, not current code):

  // hypothetical: graph.ts
  const graph = new StateGraph(InvestigationState)
    .add_node("monitor",     monitorNode)
    .add_node("diagnose",    diagnoseNode)
    .add_node("review_diag", humanReviewNode)
    .add_node("recommend",   recommendNode)
    .add_conditional_edge("diagnose", (s) =>
      s.diagnosis.confidence === "low" ? "review_diag" : "recommend"
    )
    .add_conditional_edge("review_diag", (s) =>
      s.user_approval === "approved" ? "recommend" : "diagnose"
    )
    .add_edge("monitor", "diagnose")
    .add_edge("recommend", END);

  // route.ts would become:
  const engine = graph.compile({ checkpointer: new SqliteSaver(...) });
  const events = engine.stream({ anomaly }, { configurable: { thread_id: insightId }});
  for await (const e of events) send(e);
```

---

## Elaborate

### Where this pattern comes from

Graph orchestration of agents got its current popular framing from LangGraph (open-sourced 2024, the LangChain team's response to the limitations of imperative chains). The deeper roots are in workflow engines (Apache Airflow, Temporal) and state-machine libraries (XState, Robot, Spring Statemachine) — both of which expressed control flow as graphs with persisted state long before LLMs. LangGraph's specific contribution was making the agent the unit of work in the graph, with state schema enforcement and built-in checkpointing for multi-agent runs. OpenAI Agents SDK followed in 2025 with its own graph-mode for multi-agent workflows.

### The deeper principle

**Make orchestration into data so you can inspect it.** Imperative code expresses control flow in syntax (`if`/`await`/`throw`); the meaning is only visible when you read the code. Graph definitions express control flow as named nodes and named edges; the meaning is queryable, drawable, and persistable. The cost is upfront ceremony; the win is everything you can do once orchestration is queryable.

```
   Imperative orchestration   ─►  control flow is syntax
                                   to read it, you read the code
                                   to debug it, you replay execution
                                   to change it, you edit lines

   Graph orchestration        ─►  control flow is data
                                   to read it, you draw the graph
                                   to debug it, you load the checkpoint
                                   to change it, you edit the definition
```

This is the same principle as React's declarative UI — describe the UI as data (JSX), let the framework render. Imperative DOM manipulation works at small scale; declarative wins at any scale beyond trivial. Same here.

### Where this breaks down

Graph orchestration breaks when the graph is *small enough* that the ceremony is more code than the imperative version. A 3-node sequential graph isn't worth the runtime; a 50-line route file with 3 stages isn't worth replacing. The break-even is somewhere around 5–8 nodes with at least one conditional edge — beyond that, the inspectability win dominates.

It also breaks when the engine's checkpointing model doesn't match the work shape. If a node makes a *streaming* LLM call (token-by-token), most graph engines have to either record the full stream and replay it or re-run the node — neither is great. The fix is moving streaming concerns outside the graph (the graph runs and writes the final result; streaming happens to the client separately) — which adds back imperative glue.

### What to explore next
- `./03-sequential-pipeline.md` → the imperative shape graph replaces
- `./08-shared-state-and-message-passing.md` → state in graphs is the shared-state pattern, by default
- `./02-supervisor-worker.md` → graphs can express supervisor-worker as a hub-and-spoke graph with conditional edges
- `../06-orchestration-system-design-templates/` → the "graph-based investigation workflow" refactor template

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "do you use a graph runtime" or "do you use LangGraph" they're testing whether you can name the distinction between *orchestration as code* and *orchestration as data*. The strong signal is naming exactly what's in your codebase (imperative route) and naming what would have to change to adopt a graph (declarative definition, engine, checkpoint store, UI resume hook). The weak signal is confusing the UI state machine with the agent-orchestration state machine — a category error some candidates make.

### Likely questions

[mid] Q: Do you use LangGraph or any graph orchestration framework?

A: No. The orchestration is imperative TypeScript in `app/api/agent/route.ts` L199–L249 — an `if`-ladder that picks the lead agent and a few sequential function calls for the pipeline transitions. The UI has a `ProcessStepper` component that's a state machine for which view to render, but that's a UI state machine, not an agent-orchestration state machine. The distinction matters: the ProcessStepper doesn't own server-side agent context and doesn't expose checkpoints; a real graph runtime would.

Diagram:
```
  ┌─ What we have ─────────────────────────────────────┐
  │ route.ts: imperative TS                             │
  │   - if-ladder picks agent                           │
  │   - sequential function calls (diag → rec)          │
  │   - no checkpointing                                │
  │                                                     │
  │ ProcessStepper UI: client-side step state machine   │
  │   - renders the right view per step                 │
  │   - does NOT own agent context                      │
  │   - does NOT carry server-side state                │
  └─────────────────────────────────────────────────────┘

  ┌─ What a graph runtime would add ──────────────────┐
  │ graph def: nodes + edges + state schema            │
  │ engine: runs nodes, persists state, picks edges    │
  │ checkpoint store: durable per-thread state         │
  │ UI resume hook: pauses on human nodes, resumes      │
  │   with thread_id                                    │
  └─────────────────────────────────────────────────────┘
```

[senior] Q: Would adopting LangGraph improve the codebase?

A: At the current scale, no — and that's the deliberate call. The orchestration is 50 lines, 3 stages, 1 conditional branch (the lead-agent select). Adopting LangGraph would mean a Python service (LangGraph's primary SDK) or LangGraph.js (less mature in 2026), a checkpoint store, and an engine wrapper. The win would be first-class resumability and inspectable orchestration; the cost would be a framework dependency, a learning curve, and probably a cross-runtime split. Worth it if we grew past ~5 conditional branches, OR added a "save and resume investigation" feature, OR the team grew enough that the imperative orchestration became opaque to new hires. None of those are true today.

Diagram:
```
  When LangGraph earns its overhead

  ┌────────────────────────────────────────┐
  │  Orchestration size                    │
  │   ≤ 5 nodes, ≤ 1 conditional   ─► imperative │
  │   > 5 nodes or > 2 conditionals ─► graph     │
  └────────────────────────────────────────┘
  ┌────────────────────────────────────────┐
  │  Resumability requirement              │
  │   single-request runs            ─► imperative │
  │   pause/resume across hours      ─► graph     │
  └────────────────────────────────────────┘
  ┌────────────────────────────────────────┐
  │  Team size                              │
  │   ≤ 3 engineers, mostly stable   ─► imperative │
  │   ≥ 5 engineers, churn          ─► graph     │
  └────────────────────────────────────────┘
```

[arch] Q: How would you handle a failure mid-recommendation today, and how would graph orchestration change that?

A: Today: the whole run errors and is lost. The diagnostic agent's `Diagnosis` was streamed to the client (so the UI shows it) and stored client-side in `sessionStorage`, but server-side the run is gone — there's no checkpoint store. If the user retries, the recommendation runs from scratch, with the diagnosis re-read from sessionStorage via the `?diagnosis=` URL param. So the user-visible recovery works, but it's manually implemented via cross-request handoff.

With graph orchestration: a checkpoint is written after the diagnostic node succeeds. The recommendation node errors. The engine knows the run is paused at the recommendation node. On retry, the engine loads the checkpoint, sees diagnostic's output is already there, and re-runs only recommendation. No client-side state-management gymnastics. Resumability is server-side and first-class.

Diagram:
```
  Today (imperative)              With graph runtime
  ───────────────────────         ──────────────────────────
  diag succeeds → stream          diag succeeds → checkpoint
   to client, sessionStorage      rec errors → graph paused
  rec errors → request fails      retry:
   client retries with               load checkpoint
   ?diagnosis= URL param            run rec only
  rec re-runs with re-read         resume
   diagnosis
```

### The question candidates always dodge

Q: Isn't the UI ProcessStepper basically a graph runtime? It tracks the step, transitions between them, handles pause for the user click.

A: No — and conflating the two is a category error that some teams make. The ProcessStepper is a *UI state machine*: it owns which view is rendered (`diagnose`, `recommend`, `complete`), it tracks client-side derived state from the SSE stream, and it advances when the user clicks. What it does NOT do: own server-side agent context, persist checkpoints durably, expose a thread_id, or resume a paused server run when the user comes back tomorrow. A real agent-orchestration graph runtime owns all four. The reason the distinction matters: if I called the ProcessStepper a graph runtime, I'd be claiming features the codebase doesn't have (durable checkpoints, server-side pause/resume, thread-id-based isolation) — and the first time a user's session expired mid-run, I'd be debugging the gap. The honest framing: the ProcessStepper handles step UI, the route file handles orchestration, sessionStorage manually bridges them across user gates. None of that is a graph runtime. Adopting LangGraph would replace the route's imperative orchestration AND give the ProcessStepper a real server-side state to subscribe to — they're complementary, not the same.

Diagram:
```
The two state machines, not to be confused

  ┌─ UI ProcessStepper (client) ────────────────┐
  │  states: 'detect' | 'diagnose' | 'recommend' │
  │          | 'complete'                        │
  │  events: user clicks, SSE events             │
  │  scope:  UI rendering only                    │
  │  persistence: none (in-memory + sessionStorage│
  │               for the cross-request handoff)  │
  └──────────────────────────────────────────────┘

  ┌─ Agent-orchestration graph (server) ────────┐
  │  states: { anomaly, diagnosis?, recs?, … }   │
  │  events: node completions, edge conditions   │
  │  scope:  agent context, durable across       │
  │          requests and crashes                 │
  │  persistence: checkpoint store (durable)      │
  │                                              │
  │  NOT IMPLEMENTED in blooming insights         │
  └──────────────────────────────────────────────┘

   the UI state machine ≠ agent state machine
```

### One-line anchors

- "Graph orchestration is nodes + edges + state, with checkpointing and first-class human-in-the-loop — orchestration as data, not code."
- "blooming insights uses imperative route code; the UI ProcessStepper is a UI state machine, not an agent-orchestration runtime."
- "The breakpoint for adopting LangGraph: orchestration past 5 conditional branches, OR resumability as a hard requirement, OR onboarding tax."
- "Checkpointing is the load-bearing feature — it makes resumability first-class instead of manual sessionStorage gymnastics."

---

## See also

→ `./03-sequential-pipeline.md` · → `./02-supervisor-worker.md` · → `./08-shared-state-and-message-passing.md` · → `./09-coordination-failure-modes.md` · → systems view: `../../study-system-design/06-multi-agent-orchestration.md`

---

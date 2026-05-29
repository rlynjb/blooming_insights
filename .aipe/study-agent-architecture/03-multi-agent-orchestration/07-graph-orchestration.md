# Graph orchestration

**Industry name(s):** Graph orchestration, agent state graph, StateGraph, LangGraph-style orchestration, checkpointed multi-agent
**Type:** Industry standard · Language-agnostic

> Control flow expressed as an explicit state machine — nodes, edges, conditional transitions, checkpointed state. blooming insights' orchestration is imperative route code, NOT a checkpointed agent-state graph. The UI ProcessStepper is a UI state machine, not an agent-orchestration runtime. The topology that earns its overhead when you need debuggability, human-in-the-loop pause/resume, or branching control flow the route's `if`-ladder can't express.

**See also:** → `./03-sequential-pipeline.md` · → `./02-supervisor-worker.md` · → `./08-shared-state-and-message-passing.md` · → `./09-coordination-failure-modes.md` · → systems view: `../../study-system-design-dsa/01-system-design/06-multi-agent-orchestration.md`

---

## Why care

### Move 1 — the scenario (lead with the shape)

```
The graph orchestration shape

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

  state lives in a checkpointed graph context;
  edges are transitions; conditions live on edges
```

You've built a multi-step form. Step 1 collects an email, step 2 collects a name, step 3 confirms — and there's a side path: if the email is already taken, step 1 redirects to step 4 (sign in) instead. The form's state lives in a state machine (`useReducer`, XState, whatever); each step is a node; the conditional edge from step 1 to step 4 is a transition condition; the user can refresh the page and the form picks up where they left off because the state is persisted.

Now picture the same shape, except each *node is an agent*, the *state is shared agent context*, and the *edges are agent turns*. The user can pause the run between any two nodes for human review; the engineer can replay a checkpoint to debug. The whole multi-agent run is one inspectable graph with explicit transitions.

### Move 2 — name the question

That second shape is what graph orchestration names. The question this file answers: **when does it pay to express agent orchestration as an explicit state graph — instead of as imperative route code (this codebase) or as a supervisor agent reasoning over transitions?**

The technical hinges: explicit nodes (each step is a named graph vertex), conditional edges (transitions can depend on state), checkpointed state (you can pause and resume), human-in-the-loop pauses (the graph can stop on a designated node and wait for human input).

### Move 3 — why answering that question matters

**Why you need to answer that question at all:** because agent orchestration becomes hard to debug, hard to evolve, and hard to recover from failure once it has more than a handful of transitions — and the cure is *making the orchestration inspectable*. An imperative route file like blooming insights' `app/api/agent/route.ts` is easy to read at 50 lines; at 500 lines with branches it becomes opaque. A supervisor agent is even harder — its reasoning is in the model. A state graph is the third option: explicit, inspectable, debuggable.

In this codebase: orchestration is imperative. The route file is a 50-line `if`-ladder + sequential function calls. There's no graph runtime. There's no checkpointing — if the diagnostic stage errors mid-way, you lose the whole run; if you want to retry the recommendation step with a different prompt, you re-run everything. The UI's `ProcessStepper` component is a state machine, but it's a *UI* state machine (which step is rendered) — it doesn't carry agent context or know how to resume a paused run on the server.

The clarification this file insists on: **the ProcessStepper is not the graph runtime.** It's the visualization of step progression. A real agent-orchestration graph runtime (LangGraph, OpenAI Agents SDK graph mode) would own server-side state, expose checkpoints, and let the UI pause a run between nodes. The ProcessStepper today doesn't do any of that.

### Move 4 — concrete before/after

Imperative route code (this codebase, today):
- Route reads query params → picks lead agent
- Calls `diagAgent.investigate(...)` → returns `Diagnosis`
- Calls `recAgent.propose(inv, diagnosis, ...)` → returns recommendations
- Streams events to client
- If anything throws mid-run, the request errors; no partial state survives

Graph orchestration (hypothetical):
- Graph defined with nodes (`monitor`, `diagnose`, `human_review`, `recommend`, `final`)
- Edges: `monitor → diagnose`, `diagnose → human_review` (conditional: if confidence < 0.7), `human_review → diagnose` (loop, if rejected) or `human_review → recommend` (if approved), `recommend → final`
- State (the typed `Diagnosis`, the anomaly, the user's choices) lives in a graph context object
- Engine runs nodes, evaluates edges, persists state to a checkpoint store after each node
- If `recommend` errors, you replay from the last checkpoint — `diagnose`'s output is already there

### Move 5 — one-line summary

A graph runtime turns the orchestration *itself* into data you can inspect — a multi-step-form's state machine, but the state is shared agent context. blooming insights uses imperative route code instead; here's how graph orchestration works and what would have to change to adopt it.

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

The strategy in plain English: **make the orchestration into data so you can inspect it, debug it, pause it, replay it.** Imperative code expresses transitions in syntax (`if`/`else`/`await`); graphs express them as named edges in a definition. The latter is queryable and serializable; the former isn't.

### Layer 1 — nodes (the units of work)

The technical thing: a *node* is a function that takes the current graph state and returns an updated state. In agent graphs, the node usually wraps an agent loop — the node runs the agent, reads the agent's output, updates the state with that output.

If you're coming from frontend, a node is a `step` component in a multi-step form — it owns its own rendering and state mutations, and when it's done it tells the parent state machine to transition.

```
A node, conceptually

  function diagnose_node(state):
    diagnosis = DiagnosticAgent.investigate(state.anomaly)
    return { ...state, diagnosis: diagnosis }

  // in a real LangGraph definition:
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

  // in LangGraph:
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

The practical consequence: human-in-the-loop becomes a first-class concept, not a hack. The codebase's current "user clicks 'see recommendations'" gate is already conceptually a human node — but it's not implemented in a graph engine; the route file just splits the work into two requests and uses sessionStorage to bridge them.

The condition under which this works: the UI has to support pause/resume — which means the UI has to know which checkpoint to resume from when the user responds. Frameworks like LangGraph handle this with a thread_id; the UI passes the thread_id when resuming.

### Phase A vs Phase B — imperative route vs graph runtime

```
        Now (imperative route)                If quality/debuggability forced it
┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐
│ app/api/agent/route.ts L199–L249    │  │ Graph definition (declarative)       │
│   if-ladder + sequential function   │  │   nodes: monitor, diagnose, review,  │
│   calls                             │  │           recommend, final           │
│   no checkpointing                  │  │   edges: with conditions             │
│   no graph runtime                  │  │   state schema (typed)               │ ←
│                                     │  │                                      │
│ UI ProcessStepper:                  │  │ Graph engine (e.g. LangGraph)         │
│   client-side state machine for      │  │   reads node, runs agent, persists  │
│   which step is rendered             │  │   state, picks edge, repeats         │
│   does NOT carry agent context       │  │                                      │
│   cannot resume server-side runs    │  │ UI ProcessStepper:                   │
│                                     │  │   subscribes to graph events,        │
│                                     │  │   pauses on human nodes, resumes     │
│                                     │  │   via thread_id                      │ ←
└─────────────────────────────────────┘  └─────────────────────────────────────┘
   moving from left to right: agents unchanged, route replaced
   by graph definition + engine, UI gains a checkpoint-aware
   resume hook
```

*Now:* the orchestration is imperative TypeScript in `app/api/agent/route.ts`. The ProcessStepper component is a UI state machine for *rendering* the step UI — it tracks which view is active (`diagnose`, `recommend`, `complete`) but it doesn't own agent state. Agent state is collected in the SSE stream and accumulated client-side in `useInvestigation`. The "step 2 → step 3" gate works because the client persists the typed `Diagnosis` to `sessionStorage`; the route's step 3 request reads it back. This is pause/resume *manually implemented* via the cross-request handoff — it's not graph orchestration.

*If a graph runtime were adopted:* the route file would shrink dramatically. Each agent would be wrapped in a node function. Edges would express the transitions. The graph engine would own state persistence — `sessionStorage` would become a thread_id passed to the engine. Human-in-the-loop pauses would be first-class. Debugging would shift from "read route.ts and replay one trajectory" to "open the graph viewer and see which node failed at which state."

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
  │     • monitor      (MonitoringAgent)                          │
  │     • diagnose     (DiagnosticAgent)                          │
  │     • review_diag  (HUMAN — waits for "approve" / "redo")    │
  │     • recommend    (RecommendationAgent)                      │
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
  │   thread_id → list of (node, state) snapshots                 │
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
  │                  with thread_id                              │
  │   on completion: renders final state                          │
  └──────────────────────────────────────────────────────────────┘

  blooming insights TODAY: NOT IMPLEMENTED. Orchestration is
  imperative TypeScript in app/api/agent/route.ts L199–L249.
  The ProcessStepper UI component is a UI state machine, NOT
  an agent-orchestration graph runtime.
```

---

## In this codebase

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

## Tradeoffs

The decision was: **imperative route code — no graph runtime.** The alternative is to adopt LangGraph (or equivalent) and express orchestration as nodes + edges + state.

┌──────────────────┬─────────────────────────────┬─────────────────────────────┐
│ Cost dimension   │ Imperative route (chosen)   │ Graph runtime (alternative) │
├──────────────────┼─────────────────────────────┼─────────────────────────────┤
│ Build cost       │ ~50 lines route.ts          │ graph definition + engine   │
│                  │                             │ wiring + checkpoint store   │
│ Runtime cost     │ none extra                  │ engine overhead per node    │
│                  │                             │ transition; checkpoint writes│
│ Debuggability    │ read route.ts + replay      │ inspect graph state at any  │
│                  │ trajectory                  │ checkpoint                  │
│ Resumability     │ none — failures lose the    │ first-class — resume from   │
│                  │ run                         │ last checkpoint             │
│ Human-in-the-loop│ manual (sessionStorage +    │ first-class (human nodes,   │
│                  │ cross-request)              │ thread_ids)                 │
│ Branching        │ if-ladder in code (opaque   │ conditional edges (queryable)│
│                  │ at >5 branches)             │                             │
│ Visualization    │ none — read the code        │ auto-rendered graph diagram │
│ Onboarding       │ engineer reads route.ts +   │ engineer reads graph def +  │
│                  │ each agent class            │ understands engine API       │
│ Framework        │ none — vanilla TS           │ LangGraph (Python primarily)│
│ availability     │                             │ or LangGraph.js (less mature)│
│ Stops being      │ when orchestration grows    │ stops being right when      │
│ right when…      │ past ~5 conditional         │ orchestration is small and  │
│                  │ branches OR resumability    │ stable and imperative is    │
│                  │ becomes a hard requirement  │ readable                    │
└──────────────────┴─────────────────────────────┴─────────────────────────────┘

### What we gave up

We gave up first-class resumability. Today, if the recommendation stage errors after the diagnostic stage succeeded, we lose both — the user has to re-run the whole investigation. A graph runtime with checkpointing would let us retry just the failed node.

We gave up declarative debugging. The orchestration's branching today is in `route.ts` L199–L249 — to understand "when does the QueryAgent run vs the DiagnosticAgent" you read the if-ladder. With a graph definition, the answer is a labeled edge in a drawable graph.

We gave up first-class human-in-the-loop. The "user gates step 3" UX works, but it's manually implemented via sessionStorage + cross-request handoff. With a graph runtime, it would be a `human_review` node with first-class pause semantics; the UI would resume by sending the user's response back with the thread_id.

### What the alternative would have cost

If we'd built on LangGraph from day one, the up-front cost would have been substantial: LangGraph's primary SDK is Python (the TS port is less mature in 2026), so we'd either go cross-runtime (Python service for orchestration, Next.js for UI) or accept the rough edges in LangGraph.js. Either way, the codebase shape would have a `graph.ts` defining nodes and edges, a checkpoint store (likely SQLite or Redis), and an engine wrapper in `route.ts` that streams graph events to the client.

Per-run cost: each node transition writes to the checkpoint store (~5–10ms of disk/network); the engine adds a small overhead per node (~10–50ms). At our run volume this is negligible. The bigger cost is *operational* — running LangGraph means understanding its execution model, its persistence layer, its retry semantics, its versioning story. It's a real framework with a real learning curve.

The win: a 5-node graph with the conditional edges we'd actually want (confidence-based human review, retry-on-low-confidence) would be ~100 lines of declarative code with first-class debugging and resumability. The imperative equivalent today (route.ts + sessionStorage + parseDiagnosis + filterByStep) is more code, not less.

### The breakpoint

This stays the right call until the orchestration grows past ~5 conditional branches, OR resumability becomes a hard requirement (e.g. a future "save and resume investigation later" feature), OR the team grows past ~3 engineers and onboarding cost on the imperative orchestration becomes meaningful. At those breakpoints, a graph runtime's declarative shape and first-class checkpointing earn their overhead.

### What wasn't actually a tradeoff

Building our own graph runtime was not a real alternative. Persistent agent state, checkpoint semantics, conditional edge evaluation, human-in-the-loop pause/resume — these are well-trodden ground; rolling our own would be re-inventing LangGraph poorly. If the breakpoint hits, the right move is adopting a framework, not building one.

Treating the UI ProcessStepper as the "graph runtime" was also not a real option. The ProcessStepper is client-side state for *which view to render*; it doesn't own agent context, doesn't checkpoint server-side state, doesn't know how to resume a paused server-side run. Conflating UI step state with agent orchestration state is a category error that some teams make — naming the distinction here is the discipline.

---

## Tech reference

### LangGraph (Python primary, LangGraph.js secondary)

- **Codebase uses:** not used.
- **Why it's here:** LangGraph is the canonical framework for expressing agent orchestration as a state graph with checkpointing and human-in-the-loop pauses.
- **Leading today:** LangGraph — innovation-leading for graph-style multi-agent orchestration, 2026.
- **Why it leads:** explicit `StateGraph`, conditional edges, built-in checkpoint savers (SQLite, Postgres, Redis), `interrupt_before`/`interrupt_after` for human-in-the-loop, first-class subgraphs for nested orchestration.
- **Runner-up:** OpenAI Agents SDK graph mode — simpler model, less ceremony, no built-in checkpointing yet (2026), but easier interop with OpenAI tools.

### XState (the frontend state-machine ancestor)

- **Codebase uses:** not used in this codebase; the comparison is conceptual.
- **Why it's here:** XState is the React-ecosystem state machine library that taught the frontend community to think of multi-step UIs as declarative graphs. The graph orchestration pattern for agents is the same idea, one layer up.
- **Leading today:** XState — adoption-leading for React state machines, 2026.
- **Why it leads:** declarative state machines + visualizer + first-class typing; the model devs reach for when imperative state grows past `useReducer`.
- **Runner-up:** Robot (smaller, simpler), Zustand with finite-state-machine middleware (more ad-hoc, less ceremony).

### LangGraph checkpointers (SQLite / Redis / Postgres)

- **Codebase uses:** not used.
- **Why it's here:** the checkpointer is the piece that makes resumability work — it persists graph state at each node transition.
- **Leading today:** SqliteSaver for local + PostgresSaver for production — adoption-leading for LangGraph state persistence, 2026.
- **Why it leads:** drop-in serializers, thread_id-based isolation, time-travel debugging (load any historical checkpoint).
- **Runner-up:** RedisSaver — faster for high-volume runs, less durable than Postgres.

---

## Summary

Graph orchestration expresses agent control flow as an explicit state machine — named nodes, named edges, conditional transitions, checkpointed state — making orchestration into queryable, drawable, resumable data. blooming insights does NOT use graph orchestration: the route file (`app/api/agent/route.ts` L199–L249) is imperative TypeScript, the UI ProcessStepper is a UI state machine (not an agent runtime), and the cross-request "human-in-the-loop" gate is manually implemented via `sessionStorage`. The constraint that made imperative right is that orchestration is small (3 product flows, ~50 lines) and stable; the cost is no first-class checkpointing, no first-class human-in-the-loop, no declarative debugging. The breakpoint: orchestration grows past ~5 conditional branches, OR resumability becomes a hard requirement, OR team size makes opaque imperative orchestration an onboarding tax — at which point LangGraph (or equivalent) earns its overhead.

- Graph orchestration is nodes (work) + edges (transitions) + state (context) — make orchestration into data so you can inspect, debug, pause, and replay it.
- Checkpointing is the load-bearing feature — it makes resumability first-class instead of manually implemented.
- Human-in-the-loop pauses are a node type, not a hack; the UI resumes by passing a thread_id back.
- blooming insights uses imperative route code; the UI ProcessStepper is NOT a graph runtime, just step rendering.
- Worth it past ~5 conditional branches or when resumability matters; not worth it for a 50-line route file with 3 stages.

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

## Validate your understanding

### Level 1 — Reconstruct the diagram

Close this file. Draw the graph orchestration shape from memory: nodes, conditional edges, checkpoint store, human node, engine. Then annotate what blooming insights has instead (imperative route + UI ProcessStepper + manual sessionStorage handoff).

Open the file. Compare.

✓ Pass: you drew nodes-edges-state-engine-checkpoint, named human nodes, and contrasted with the imperative route + UI state machine pair this codebase has
✗ Fail: re-read How it works Layers 1–4, wait 10 minutes, try again.

### Level 2 — Explain it out loud

Explain to a colleague who said "we have a ProcessStepper — that's our graph runtime, right?" — under 90 seconds, no notes.

Checkpoints — did you:
- Distinguish UI state machine from agent-orchestration runtime?
- Name what a graph runtime owns (server-side state, checkpoints, thread_ids)?
- Name what the ProcessStepper does (UI step rendering, derived client-side state)?
- Name the manual sessionStorage handoff as what stands in for human-in-the-loop today?

If you skipped any: you let the conflation slide; the colleague will keep believing it.

### Level 3 — Apply it to a new scenario

A product manager wants a "save and resume investigation later" feature: the user starts an investigation, closes the browser, comes back 2 days later, and resumes from where they left off.

Without looking at the file: does this work today with `sessionStorage`? Why or why not? What would need to change — graph runtime adoption, server-side state store, both? What's the minimum architecture that earns the feature?

Write your answer (3–5 sentences). Then open `lib/hooks/useInvestigation.ts` L138 (the sessionStorage write) and consider its scope (per-tab, cleared on tab close).

### Level 4 — Defend the decision you'd change

"If you were starting this project today and you knew the product team would ship a 'save and resume' feature within 6 months, would you start with imperative route code (this codebase's choice) or with LangGraph from day one? Why? What's the cost of getting it wrong in either direction — premature graph adoption for a 50-line orchestration, or imperative-then-rewrite when the feature lands?"

Reference the code: `app/api/agent/route.ts` L199–L249 (current imperative orchestration), `lib/hooks/useInvestigation.ts` L138 (current manual sessionStorage handoff), `lib/mcp/types.ts` L95–L104 (the typed `Diagnosis` that would be part of any graph state schema).

### Quick check — code reference test

Without opening any files:
- Does blooming insights use a graph runtime? (Yes / No)
- Is the UI ProcessStepper a graph runtime? Why or why not?
- What manually-implemented mechanism stands in for human-in-the-loop pause/resume today?

Open and verify. ✓ File + function names matter; line numbers drifting is fine.

---
Updated: 2026-05-29 — created

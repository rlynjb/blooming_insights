# Graph orchestration

*Industry name: graph orchestration / state-machine agents — Industry standard (LangGraph).*

Control flow as an explicit state machine with nodes, edges, and checkpointed state. **Not in this repo in the LangGraph sense.** But the *primitive* — an explicit state machine for agent control — is present: the URL routing table IS the graph; the route handler is the state-machine runtime.

## Zoom out — where this concept lives

In a LangGraph-style implementation, the graph is its own runtime construct — nodes are agents/functions, edges are conditional transitions, state is a checkpointed shared blob. In this repo, the equivalent lives in the route handler's `if`/`else` and the URL parameters.

```
  Where the "graph" actually lives in blooming insights

  ┌─ URL space (THE GRAPH NODES) ───────────────────────────┐
  │  /api/briefing                                            │
  │  /api/agent?insightId=X&step=diagnose                     │
  │  /api/agent?insightId=X&step=recommend&diagnosis={...}    │
  │  /api/agent?q=...                                         │
  └────────────────────────┬─────────────────────────────────┘
                           ▼
  ┌─ Route handler (THE GRAPH RUNTIME) ─────────────────────┐
  │  app/api/agent/route.ts                                  │
  │   if (q && !insightId) → QueryAgent node                 │
  │   if (step === 'diagnose') → DiagnosticAgent node        │
  │   if (step === 'recommend') → RecommendationAgent node   │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

The axis: **what is the state machine made of?**

```
  LangGraph-style explicit graph:        This repo's URL graph:
  ─────────────────────────────────      ─────────────────────────────
  nodes:     agents/functions            nodes:     URL endpoints
  edges:     conditional transitions     edges:     `if` branches in route.ts
  state:     checkpointed shared blob    state:     URL params + sessionStorage
  inspect:   graph visualization tool    inspect:   read the route file
  pause:     graph.pause() + resume()    pause:     close tab; resume = re-navigate
  budget:    per-node config            budget:    per-agent maxToolCalls
```

Both are state machines; the difference is whether the state machine is a *runtime data structure* you can introspect with code, or an *implicit table* encoded in source.

## How it works

### Move 1 — the mental model

You know multi-step forms in React — each step is a state, each transition is a button that validates and advances, the form data accumulates across steps. Graph orchestration is that pattern for agent control: each node is a state (an agent or step), each edge is a transition (often conditional on the previous output), the shared state accumulates.

```
  Graph orchestration — explicit state machine for agents

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

### Move 2 — this repo's graph, drawn out

The route handler at `app/api/agent/route.ts` is the graph runtime. Reading the file from top to bottom is reading the state machine's transition table. Here's the implicit graph:

```
  blooming insights — the implicit graph

  ┌─ entry ─────────────────────────────────────────────────┐
  │                                                          │
  │  GET /api/agent?... → resolveAnomaly / classifyIntent   │
  │                                                          │
  └──────────────────────────┬───────────────────────────────┘
                             │
              ┌──────────────┼──────────────┬──────────────┐
              ▼              ▼              ▼              ▼
       (q && !insightId)  (step==='diagnose')  (step==='recommend')  (combined)
              │              │              │              │
              ▼              ▼              ▼              ▼
       ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────────┐
       │ classify    │ │ Diagnostic │ │ Recommend- │ │ Diagnostic +   │
       │ intent (1   │ │ Agent      │ │ ation Agent│ │ Recommendation │
       │ haiku call) │ │ (ReAct)    │ │ (ReAct)    │ │ (in sequence)  │
       └─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └────────┬───────┘
             ▼              ▼              ▼                 ▼
       ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
       │ QueryAgent │  │ stream     │  │ stream     │  │ stream     │
       │ (ReAct)    │  │ diagnosis  │  │ recommen-  │  │ both +     │
       │            │  │ STOP       │  │ dations    │  │ save cache │
       └────────────┘  └────────────┘  └────────────┘  └────────────┘
```

The graph is small (~4 entry edges, ~5 nodes) and entirely encoded in TypeScript conditionals. There's no LangGraph node-and-edge data structure; you read the source and reconstruct the graph mentally.

### Move 2.5 — current state vs LangGraph-style

The contrast is useful:

```
  Current state — URL-as-graph

  ┌─ pros ─────────────────────────────────────────────────┐
  │  zero dependency (no LangGraph package)                │
  │  zero runtime cost (TypeScript dispatch)               │
  │  pauses are free (close tab; resume = re-navigate)     │
  │  every state is a URL — bookmarkable, shareable         │
  └──────────────────────────────────────────────────────────┘
  ┌─ cons ─────────────────────────────────────────────────┐
  │  the graph isn't inspectable as data (read the source) │
  │  no graph visualization tool                            │
  │  adding nodes = adding URL params + route code         │
  └──────────────────────────────────────────────────────────┘

  Hypothetical LangGraph-style

  ┌─ pros ─────────────────────────────────────────────────┐
  │  graph as data (inspectable, diagrammable, visual tool) │
  │  checkpointed state (graph.pause() + resume)           │
  │  human-in-the-loop pauses are first-class               │
  │  adding nodes = adding to the graph definition          │
  └──────────────────────────────────────────────────────────┘
  ┌─ cons ─────────────────────────────────────────────────┐
  │  one more runtime dependency to maintain                │
  │  shared state often becomes a kitchen-sink blackboard   │
  │   (see 08-shared-state-and-message-passing.md)         │
  │  graph evolves into its own dialect of "code"           │
  └──────────────────────────────────────────────────────────┘
```

### Move 3 — the principle

Graph orchestration is the topology that makes the others inspectable. Supervisor-worker, pipeline, debate can ALL be expressed as graphs with explicit state, conditional edges, and checkpointing. The win when you adopt it: debuggability and human-in-the-loop pauses as first-class. The cost: up-front structure (you define the graph instead of letting the model freewheel). This repo's URL-as-graph is the cheap version — same primitive, no runtime dependency, less inspectability.

## In this codebase

**Not implemented as LangGraph or any graph framework.** The "graph" is the URL routing table. The route handler at `app/api/agent/route.ts` is the state-machine runtime. Reading the route file IS reading the graph.

Why this is fine right now:
- **The graph is small.** 5 nodes, ~4 entry edges. A graph framework's overhead would outweigh the inspectability gain.
- **Pauses are free.** Browser navigation is the pause primitive — close the tab, the request cancels (via `req.signal`); navigate back, start a new request. No checkpoint to manage.
- **State sharing is forced minimal.** Vercel serverless = ephemeral instances; shared state across requests has to be serialized (URL params, sessionStorage, file system in dev). The architecture already forbids the blackboard anti-pattern (`08-shared-state-and-message-passing.md`).

The case for adopting LangGraph or similar: when the graph grows past ~10 nodes, or when human-in-the-loop pauses become a product feature (not just "the user closes the tab"). Neither has happened yet.

## Primary diagram

The implicit graph as a state-machine diagram:

```
  blooming insights — the implicit graph drawn explicitly

      ┌─ idle ─┐
      │         │
      │         ▼ GET /api/briefing
      │   ┌──────────┐
      │   │ Monitor  │
      │   └────┬─────┘
      │        ▼ insights streamed; user reads feed
      │   ┌──────────┐
      │   │ user clicks card                  ─────────────┐
      │   └────┬─────┘                                       │
      │        ▼ GET /api/agent?step=diagnose                │
      │   ┌──────────┐                                       │
      │   │ Diagnose │                                       │
      │   └────┬─────┘                                       │
      │        ▼ diagnosis streamed; user reads EvidencePanel│
      │   ┌──────────┐                                       │
      │   │ user clicks "see recommendations →"              │
      │   └────┬─────┘                                       │
      │        ▼ GET /api/agent?step=recommend&diagnosis=... │
      │   ┌──────────┐                                       │
      │   │ Recommend│                                       │
      │   └────┬─────┘                                       │
      │        ▼ recommendations streamed                    │
      └────────┘ ◄──────────────────────────────────────────┘

      Parallel branch: GET /api/agent?q=... → classifyIntent → QueryAgent
```

## Interview defense

**Q: "Do you use graph orchestration?"**

A: Not in the LangGraph sense — the "graph" is the URL routing table, and the route handler is the state-machine runtime. Five nodes (Monitor, Diagnose, Recommend, Query, intent-classify), four entry edges (the URL `?step=` cases). Pauses are free — browser navigation is the pause primitive; closing the tab cancels via `req.signal`. No checkpoint to manage because Vercel serverless instances are ephemeral anyway — state is forced to round-trip through URL params + sessionStorage.

The case for adopting LangGraph: when the graph grows past ~10 nodes, or when human-in-the-loop pauses become a product feature (not just "user closes tab"). Today, the URL-as-graph is the cheap version of the same primitive — same shape, no runtime dependency, less inspectability.

Diagram I'd sketch:

```
  the "graph" today:
     URL routing table = the graph definition
     route.ts conditionals = the transitions
     URL params + sessionStorage = the shared state
     browser nav = the pause primitive

  what LangGraph would add:
     graph as data (inspectable, diagrammable)
     graph.pause() / graph.resume() as first-class
     trades for: another dependency, kitchen-sink-blackboard risk
```

Anchor: "the graph is the URL space. Read the route file, reconstruct the graph. Adding graph-as-data would be the right call when the graph grows past what fits in your head."

## See also

- [`02-supervisor-worker.md`](./02-supervisor-worker.md) — the supervisor (route handler) IS the graph runtime
- [`08-shared-state-and-message-passing.md`](./08-shared-state-and-message-passing.md) — why graph-style shared state would clash with this repo's architecture
- [`../04-agent-infrastructure/05-guardrails-and-control.md`](../04-agent-infrastructure/05-guardrails-and-control.md) — human-in-the-loop pauses are part of the control envelope

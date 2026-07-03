# Shared state and message passing

*Industry names: shared state / blackboard vs message passing · Language-agnostic*

## Zoom out

```
  Zoom out — how agents actually communicate

  ┌─ SECTION C topologies ──────────────────────┐
  │  supervisor-worker, pipeline, fan-out, …     │
  │  → they all need agents to communicate       │
  │  ★ SHARED STATE vs MESSAGE PASSING ★         │ ← we are here
  │  (this is the mechanism underneath)          │
  └──────────────────────────────────────────────┘
```

## Zoom in

Two ways agents share information: **shared state** (a blackboard every agent reads and writes) and **message passing** (each agent sees only what's passed to it). This repo uses message passing across the multi-agent boundary — each worker sees exactly the arguments the route hands it. That's a deliberate choice with real cost implications.

## Structure pass

Layers: **communication mechanism** (state or message) — **context each agent sees** — **coupling** (who knows about who).

Axis to hold constant: **what does each agent see?**

```
  What each agent sees — the axis that flips per mechanism

  Shared state (blackboard):    Every agent sees everything
                                that was written to the state
  Message passing:              Each agent sees only what
                                the sender chose to pass
```

## How it works

### Move 1 — the shape

You've reasoned about React state before — global store (Redux, Zustand, Context) vs props drilling. Same tradeoff, different scale. Blackboard = global store; message passing = props drilling with explicit contracts.

```
  Shared state (blackboard):       Message passing:
  ┌──────────────────────┐        agent A ──msg──► agent B
  │   shared context     │        agent B ──msg──► agent C
  │  (all agents read     │        (each agent sees only
  │   and write here)     │         what's passed to it)
  └──────────────────────┘
   ▲      ▲       ▲
   A      B       C
```

### Move 2 — how message passing works in this repo

**The route as the message broker.** In this repo, each worker gets constructor arguments (Anthropic client, DataSource, WorkspaceSchema, tool list, session id) and a method call with the payload (Anomaly, or Anomaly + Diagnosis, or free-form query + intent). Nothing is a global mutable store. The workers do not see each other. The Diagnosis crosses the pipeline boundary as an explicit argument.

```
  Message passing in this repo — the route curates what each worker sees

  ┌─ Route ─────────────────────────────────────────────┐
  │  loads: schema, allTools (fetched once)             │
  │         BudgetTracker (shared across workers)       │
  │         Anthropic client                            │
  │         DataSource                                  │
  │                                                     │
  │  ┌──► DiagnosticAgent.investigate(                 │
  │  │        anomaly,                                  │
  │  │        { budget, signal, ...hooks }              │
  │  │    ) → Diagnosis                                 │
  │  │                                                  │
  │  │  ── diagnosis handed forward ───►                │
  │  │                                                  │
  │  └──► RecommendationAgent.propose(                 │
  │           anomaly,                                  │
  │           diagnosis,     ← from previous worker    │
  │           { budget, signal, ...hooks }              │
  │       ) → Recommendation[]                          │
  └─────────────────────────────────────────────────────┘
```

The workers never share anything except what the route explicitly passes. If Diagnostic accumulated some helpful side context ("the workspace has weird timezone data"), Recommendation doesn't see it — only the final Diagnosis crosses.

**The one thing that IS shared: the BudgetTracker.** This is a deliberate exception. The tracker is a single mutable object passed by reference to both agents; both agents accumulate into it. This is *scoped shared state* — the pattern is message passing at the coordination layer, blackboard at the resource-accounting layer.

Why the split: budget accounting has to be cross-agent by definition — the ceiling is per-investigation, not per-agent. If each agent had its own budget, a diagnostic that spent $0.20 could hand off to recommendation with a "fresh" $0.30, and the request would blow the actual ceiling of $0.30 total. The shared tracker enforces the invariant.

**What message passing costs.**

- **Curation discipline.** The sender has to decide what to pass. Miss a field the receiver needs → the receiver acts on incomplete info. This is why `Diagnosis` is a typed structured output with a validated shape — the discipline is enforced by the type.
- **Serialization.** Passing across a page boundary (Diagnostic on page 2, Recommendation on page 3) means serializing to a URL param. Big diagnoses hit URL length limits (Vercel: ~14KB effective). For this repo the Diagnosis stays under 4KB; if it grew, the pattern would need to switch to server-side stashing with a lookup key.
- **No incidental sharing.** Two agents can't stumble into shared context that "just works." Any information one has and the other needs must be explicitly passed. This is both the strength (no implicit coupling) and the cost (more up-front design).

**What shared state costs.**

- **Context bloat scales with agent count.** Every agent sees everything → longer contexts → lost-in-the-middle problems worsen. See `.aipe/study-ai-engineering/`'s context-window file.
- **Race conditions.** Two agents writing to the same state field simultaneously is a real problem in parallel topologies. Requires locking or CRDT-shaped state.
- **Debugging is harder.** A wrong value in state could have been written by any agent at any point.

**The production answer.** **Multi-agent context routing** — passing role-specific context to each agent. Each agent gets exactly what its role needs, no more. This is the message-passing side with careful curation, and it's a direct application of context engineering (see `04-agent-infrastructure/01-context-engineering.md`).

In this repo, the route curates: DiagnosticAgent gets Anomaly + shared schema; RecommendationAgent gets Anomaly + Diagnosis + shared schema. Neither sees the other's tool traces (those go to the UI, not to the other agent). Neither sees the free-form query context. Each gets what its role needs.

### Move 2.5 — hybrid patterns

Real production systems mix both. In this repo:

```
  Hybrid — message passing at coordination, scoped blackboard for resources

  Coordination layer (workers ↔ workers): MESSAGE PASSING
    - Diagnosis crosses via URL param
    - Neither worker sees the other's runtime

  Resource layer (all workers ↔ shared resources): SCOPED BLACKBOARD
    - BudgetTracker (all workers accumulate here)
    - WorkspaceSchema (all workers read here)
    - allTools list (all workers read here)
    - Anthropic client (all workers dispatch through here)
    - DataSource (all workers call through here)

  UI streaming layer (workers → UI): MESSAGE PASSING
    - Each worker's AgentEvents stream out via hooks
    - The UI is the "final receiver," not another worker
```

The hybrid is honest: pure message passing is expensive when every worker needs the same resource; pure blackboard is expensive when workers coincidentally see each other's state. Scoping the blackboard to resources (not coordination) is the sweet spot.

### Move 3 — the principle

The tradeoff that matters: **shared state is simple to reason about but every agent sees everything (context bloat, lost-in-the-middle scales with agent count). Message passing scopes each agent's context to what it needs (cheaper, less noise) but requires deciding what to pass — and a bug there means an agent acts on missing information.** Production systems are hybrid: scoped blackboard for resources, message passing for coordination.

## Primary diagram

```
  This repo's hybrid — where each mechanism lives

  ┌─ SCOPED BLACKBOARD (resources) ────────────────────────┐
  │                                                        │
  │  ┌── BudgetTracker ──────────────────┐                 │
  │  │  read/write by all agents         │                 │
  │  └───────────────────────────────────┘                 │
  │  ┌── WorkspaceSchema ────────────────┐                 │
  │  │  read by all agents (immutable)   │                 │
  │  └───────────────────────────────────┘                 │
  │  ┌── allTools list ──────────────────┐                 │
  │  │  read by all agents (immutable)   │                 │
  │  └───────────────────────────────────┘                 │
  │  ┌── DataSource, Anthropic client ──┐                  │
  │  │  called by all agents             │                 │
  │  └───────────────────────────────────┘                 │
  └────────────────────────────────────────────────────────┘
              ▲                        ▲
              │ passed as              │ passed as
              │ constructor args       │ constructor args
              │                        │
  ┌─ MESSAGE PASSING (coordination) ─────────────────────┐
  │                                                       │
  │  Route                                                │
  │    ├─► DiagnosticAgent.investigate(Anomaly)          │
  │    │     returns Diagnosis                           │
  │    │                                                  │
  │    │  ── Diagnosis crosses as explicit arg ──►       │
  │    │                                                  │
  │    └─► RecommendationAgent.propose(Anomaly,          │
  │           Diagnosis) returns Recommendation[]        │
  │                                                       │
  │  Workers do NOT see each other's runtimes             │
  │                                                       │
  └───────────────────────────────────────────────────────┘
              │                          │
              │ per-worker AgentEvents   │
              ▼                          ▼
        ┌─────────────────────────────────────┐
        │  UI (StatusLog, cards)              │
        │  message passing to final receiver  │
        └─────────────────────────────────────┘
```

## Elaborate

Shared state (blackboard) has been in AI since the HEARSAY-II speech-understanding system (1970s) — a shared knowledge source that multiple specialists read and write. Message passing has been in software since the actor model (Hewitt 1973). The two are the classic distributed-systems tradeoff (shared memory vs message queues) applied to agent runtime.

Modern frameworks lean toward message passing with typed schemas. LangGraph's typed edges, CrewAI's task delegation with explicit outputs, aptkit's per-agent method signatures — all favor "the sender declares what crosses the boundary." The reasons are the same as they are in a microservice architecture: implicit coupling via shared mutable state is where bugs hide, and typed contracts are where they show up early.

The interesting frontier is **context routing at the multi-agent layer** — each agent gets a per-agent context object shaped by role, with the router doing the curation. LangGraph's `MessagesState` + per-node message filtering is the reference implementation.

## Interview defense

**Q: How do your agents communicate?**

Message passing at the coordination layer, scoped blackboard at the resource layer. Workers don't see each other's runtime — the route passes `Anomaly` to Diagnostic, gets `Diagnosis` back, passes both to Recommendation. Nothing implicit.

The one exception is the `BudgetTracker` — a single mutable object passed by reference to both agents. That's deliberate: the ceiling is per-investigation, not per-agent, so both have to accumulate into the same tracker. Scoped shared state at the resource layer, message passing at the coordination layer.

*Anchor visual:* the hybrid diagram above.

**Q: Why not use shared state throughout?**

Two reasons. First, context bloat scales with agent count — every agent seeing everything makes the context window a garbage dump, and the lost-in-the-middle problem worsens. Message passing lets me scope each agent's context to what its role needs.

Second, no incidental coupling. If I moved to shared state, adding a new field would silently affect every agent's context. With message passing, adding a field requires an explicit change at each boundary — annoying, but the annoyance is what catches bugs.

**Q: What's the failure mode of message passing?**

Missing a field the receiver needs. The sender curates; if the curation is wrong, the receiver acts on incomplete info. Mitigation is typed structured outputs — `Diagnosis` in `lib/mcp/types.ts` has a typed shape, `parseDiagnosis()` validates it at the receiving side. Types + a parse gate. Same discipline as any typed contract in a distributed system.

## See also

- **`02-supervisor-worker.md`** — the supervisor is the message broker.
- **`03-sequential-pipeline.md`** — the Diagnosis handoff is the canonical message-passing case here.
- **`04-agent-infrastructure/01-context-engineering.md`** — context routing IS role-based message passing.
- **`.aipe/study-ai-engineering/`** context-window and lost-in-the-middle files.

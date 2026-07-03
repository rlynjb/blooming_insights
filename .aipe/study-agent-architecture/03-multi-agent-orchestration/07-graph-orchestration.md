# Graph orchestration

_Industry standard._

## Zoom out, then zoom in

Control flow as an explicit state machine with nodes, edges, and checkpointed state — the shape LangGraph and similar frameworks popularized. This codebase does not use graph orchestration today; the supervisor in `app/api/agent/route.ts` is a simple sequential dispatch, not a graph runtime with pause/resume. This file names where graph orchestration would earn its keep and what the migration would cost.

```
  Zoom out — the graph runtime that isn't here

  ┌─ Blooming today: sequential supervisor ─────────────────────┐
  │  await classifyIntent(...)                                  │
  │  await diagAgent.investigate(...)                           │
  │  await recAgent.propose(...)                                │
  │                                                             │
  │  ★ No node/edge structure. No checkpoint store. No pause. ★ │
  └─────────────────────────────────────────────────────────────┘

  ┌─ Graph orchestration (hypothetical) ────────────────────────┐
  │  node(classify) → edge → node(diagnose) → edge → node(rec)  │
  │  edges can be conditional; state is checkpointed at nodes;  │
  │  a graph run can pause after any node for human review      │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the payoff of graph orchestration is human-in-the-loop pauses — the flow can halt after diagnosis for approval before recommendations run. Blooming currently exposes the same functionality via URL routing (the user manually navigates to `/investigate/[id]/recommend`), which is *effectively* a checkpoint without a graph runtime. That's the reason this repo hasn't reached for LangGraph — the URL already IS the checkpoint.

## Structure pass

**Layers:** graph definition (nodes + edges) · state store (checkpoints) · scheduler (which node runs next) · human gates (pause points).
**Axis:** *is the topology a state machine that needs explicit checkpointing, or a sequential flow the URL can express?*
**Seam:** the checkpoint interface. In graph runtimes, state is serialized to a store (in-memory, Redis, Postgres) between nodes. Blooming's equivalent seam is the URL + Diagnosis serialized in URL params.

```
  Checkpoint mechanism — where state lives between "nodes"

  Graph runtime:                     Blooming (URL-as-checkpoint):
  ┌─ node A ─┐                        ┌─ /investigate/[id] ─┐
  │ diagnose │                        │ diagnose runs       │
  └────┬─────┘                        └────┬────────────────┘
       ▼ checkpoint(state)                 ▼ diagnosis serialized to URL
  ┌─ store ─────────┐                  ┌─ browser URL ──────┐
  │ session:diag={} │                  │ ?diagnosis=<json>  │
  └────┬────────────┘                  └────┬───────────────┘
       ▼ scheduler picks next node          ▼ user clicks "recommend"
  ┌─ node B ─┐                        ┌─ /investigate/[id]/recommend ─┐
  │ recommend│                        │ recommend runs                │
  └──────────┘                        └───────────────────────────────┘
```

## How it works

### Move 1 — the mental model

You've built a multi-step form. Each step has its own URL, back/forward works, state carries between steps (usually via query params or `sessionStorage`). That's a graph orchestration in the wild — nodes are pages, edges are navigation, state is the form data. Blooming's investigate → recommend flow is the same pattern: two pages, edges are navigation, state is the Diagnosis. It's a two-node graph implemented as URL routes.

```
  Pattern: graph as URL routes

  ┌──────────┐  navigate  ┌────────────────────┐  navigate  ┌────────┐
  │ /feed    │ ─────────► │ /investigate/[id]  │ ─────────► │ …/rec  │
  └──────────┘            └────────┬───────────┘            └────────┘
                                    │
                              serialize Diagnosis
                              into next URL
```

### Move 2 — the walkthrough

**The URL as a graph checkpoint — `app/investigate/[id]/page.tsx` and `.../recommend/page.tsx`.** The Diagnosis produced on the investigate page is stashed via `sessionStorage` (see `lib/hooks/useInvestigation.ts`) and re-hydrated on the recommend page. That's structurally identical to a LangGraph checkpoint store, just implemented with browser primitives.

The pause point: after the investigate page runs, the user *manually* clicks "see recommendations →." That's a human-in-the-loop gate, no graph runtime required.

**What graph orchestration would add — pause-in-the-server.** Today the pause lives in the browser (the user navigates when ready). With a graph runtime, the pause could live server-side — the flow suspends after Stage A, an approval webhook resumes it. That matters when:

- the human reviewer is *different* from the flow initiator (a manager approves an analyst's recommendation before it dispatches),
- the flow needs to survive browser refresh / user leaving the tab (server-side state, not `sessionStorage`),
- multiple humans need to review the same checkpoint before proceeding.

None of these are in blooming's product surface today. The user IS the reviewer, the browser IS the state store, one refresh per session is tolerable (the Diagnosis is re-derivable from the URL).

**What graph orchestration would cost.**

- A checkpoint store (Redis or Postgres). Currently blooming has "no database" — session state is in-memory Maps + `sessionStorage`. Adding a checkpoint store means adding a database.
- A scheduler process. Currently `route.ts` runs synchronously in one request. A graph runtime typically needs a scheduler that can pick up suspended flows, which means a worker process separate from the web tier.
- Serialization contracts for every node's input/output. Blooming has this for `Diagnosis`, but the discipline has to expand.

**Where blooming DOES have a graph-shaped affordance — session isolation.** `lib/state/insights.ts:14` keeps a `Map<sessionId, SessionFeed>` so each user's investigations don't collide on a warm Vercel instance. That's not a graph runtime, but it's the shape of what a graph runtime would sit on top of — session-scoped state that a checkpoint store would extend to disk.

```
  Layers-and-hops — what graph orchestration would replace

  Blooming today:                     Blooming with graph runtime:
  ┌─ browser ────────┐                ┌─ browser ────────┐
  │ URL + session-   │                │ URL + resume-    │
  │ Storage(diag)    │                │ token            │
  └────┬─────────────┘                └────┬─────────────┘
       │ HTTP                              │ HTTP
       ▼                                    ▼
  ┌─ route.ts ───────┐                ┌─ route.ts ───────┐
  │ awaits agents    │                │ resume(token)    │
  │ in sequence      │                │ picks next node  │
  └──────────────────┘                └────┬─────────────┘
                                            ▼
                                     ┌─ Redis / Postgres ┐
                                     │ checkpoint store   │
                                     └────────────────────┘
```

### Move 3 — the principle

Graph orchestration is worth the framework overhead when *state has to survive the request* — when a flow pauses server-side, when multiple humans review the same checkpoint, when the topology has real conditional branches that can't be expressed as URL routes. If your topology is sequential with a human gate at a natural URL boundary, you already have graph orchestration; you just implemented it with routes and browser storage. The interview-grade point: name what the framework buys you (server-side pause, multi-actor approval, complex conditional edges) and be honest about when your product doesn't need it.

## Primary diagram

```
  Recap — blooming's implicit graph vs an explicit runtime

  Implicit graph (what this repo has):
    node A = /investigate/[id]           browser URL is the edge
    node B = /investigate/[id]/recommend  Diagnosis in sessionStorage
    edge   = user click                   is the checkpoint

  Explicit graph runtime (LangGraph-style, not adopted):
    ┌─ node A ─┐  checkpoint(state)   ┌─ node B ─┐
    │ diagnose │ ────────────────────►│ recommend│
    └──────────┘                       └──────────┘
       │                                  ▲
       ▼ conditional edge                 │ scheduler picks
    ┌─ node C ─┐                          │ next after human
    │ escalate │                          │ approves
    └──────────┘

  Trigger to adopt: server-side pause, multi-actor review,
  or conditional edges beyond what URL routes can express.
```

## Elaborate

LangGraph, LlamaIndex Workflows, and similar frameworks package graph orchestration as a state machine + checkpoint store + scheduler. The value proposition is human-in-the-loop pauses and complex conditional flows expressed as edges rather than nested `if` statements. The cost is framework buy-in and the checkpoint store.

Blooming's current shape — sequential agents + URL as checkpoint — is what you build *before* you need a graph runtime. It scales fine for a single-user analyst app where the reviewer is the initiator. The trigger to migrate is a product change: a manager-approves-analyst flow, or a background job that runs recommendations asynchronously after a diagnosis lands. Neither is on the roadmap, so this repo defers the framework.

The upside of NOT adopting a graph framework today: the whole flow is readable in `app/api/agent/route.ts` (< 300 lines). Adding LangGraph would double the concepts a new engineer has to learn to understand the flow. The tradeoff — flexibility vs immediate readability — is worth the readability at this stage of the product.

## Interview defense

**Q: Would you use LangGraph or a similar graph runtime here?**
A: Not today. Blooming's flow is sequential (diagnose → recommend) with a natural human pause point that's implemented via URL routing — the user manually navigates from `/investigate/[id]` to `.../recommend`. The URL is the checkpoint, `sessionStorage` is the state store, the click is the scheduler. That's a graph orchestration in disguise, implemented with primitives every web dev already knows. Adopting LangGraph would add a framework and a checkpoint store for zero product benefit at current scope. The migration trigger would be a server-side pause requirement — for example, a manager approving an analyst's recommendation before it dispatches. At that point the framework earns its overhead.

Diagram: the URL-as-checkpoint pattern beside the LangGraph shape.
Anchor: `app/investigate/[id]/page.tsx` + `.../recommend/page.tsx` + `lib/hooks/useInvestigation.ts` (the session storage of the Diagnosis).

**Q: What's the load-bearing thing a graph runtime provides that you can't get with URLs?**
A: Server-side pause with resumability. A graph runtime can suspend the flow after node A, persist the state to a store, and resume from any other client (another user, an approval webhook, a scheduled worker) using a resume token. URLs plus `sessionStorage` can't do this — if the browser closes or the user hands off to someone else, the state is gone. When the product needs multi-actor review or async resumption, that's when you reach for the framework.

Diagram: the resume-token flow; the client that resumes is different from the client that started.
Anchor: general — blooming doesn't have this, and that's the point.

## See also

- `02-supervisor-worker.md` — the sequential supervisor blooming actually uses.
- `03-sequential-pipeline.md` — the diagnose → recommend chain that a graph would express as two nodes.
- `04-agent-infrastructure/05-guardrails-and-control.md` — the human-in-the-loop gate that URL routing provides today.
- `06-orchestration-system-design-templates/02-agentic-support-system.md` — a shape where graph orchestration earns its keep.

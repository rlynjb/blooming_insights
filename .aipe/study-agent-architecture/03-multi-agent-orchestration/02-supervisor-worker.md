# Supervisor-worker

*Industry names: supervisor-worker / manager-workers / orchestrator-executors · Industry standard*

## Zoom out

```
  Zoom out — the topology this repo actually ships

  ┌─ SECTION C topologies ──────────────────────┐
  │  ★ supervisor-worker (this repo) ★           │ ← we are here
  │  sequential pipeline (sub-shape here)        │
  │  parallel fan-out                            │
  │  debate / verifier / critic                  │
  │  swarm / handoff                             │
  │  graph orchestration                         │
  └──────────────────────────────────────────────┘
```

## Zoom in

The most common and most useful topology. A supervisor decomposes the task, delegates to specialist workers, and synthesizes their results. This repo's version has a **code supervisor** (a Next.js route handler) — a form of supervisor-worker with maximum determinism at the top. That distinction is load-bearing.

## Structure pass

Layers: **supervisor** (owns the task, picks workers, merges results) — **workers** (each owns one specialty) — **tools** (each worker's own tool set).

Axis to hold constant: **who decides which worker runs?**

```
  Supervisor kinds — the axis that flips per implementation

  supervisor kind         decides which worker runs
  ─────────────────       ─────────────────────────
  LLM supervisor          the LLM (per task)
  code supervisor         the code (deterministic)
  hybrid                  code for known paths,
                          LLM for ambiguous ones

  This repo: code supervisor.
```

## How it works

### Move 1 — the shape

You've written a React manager component that renders three child components based on props before — parent picks which child, passes props down, aggregates results back up. Supervisor-worker is that shape with LLM agents as the children.

```
  Supervisor-worker — the canonical shape

  ┌───────────────────────────────────────────────┐
  │              Supervisor                        │
  │   (decomposes task, delegates, synthesizes)   │
  └───────┬───────────────┬───────────────┬───────┘
          ▼               ▼               ▼
      ┌────────┐      ┌────────┐      ┌────────┐
      │worker 1│      │worker 2│      │worker 3│
      │(spec.) │      │(spec.) │      │(spec.) │
      └────┬───┘      └────┬───┘      └────┬───┘
           └───────────────┼───────────────┘
                           ▼
                  supervisor synthesizes
                  worker results → answer
```

### Move 2 — the specific instance in this repo

**Where the supervisor lives.** Two files, both Next.js route handlers:

- `app/api/briefing/route.ts` — the supervisor for the monitoring stage. Constructs `MonitoringAgent`, wires hooks, streams to the browser.
- `app/api/agent/route.ts` — the supervisor for the diagnostic + recommendation stages, and for the free-form Q&A path. Picks worker based on `?step=…` or `classifyIntent(q)`.

Both are TypeScript. Neither runs an LLM to make the routing decision.

**The route as supervisor — real code.**

```ts
// app/api/agent/route.ts (route handler = supervisor)
if (step === 'diagnose' || !step) {
  stepFor('diagnostic', 'thought', 'starting diagnostic investigation…');
  const diagAgent = new DiagnosticAgent(anthropic, dataSource, schema, allTools, sid);
  const diagnosis = await diagAgent.investigate(anomaly, {
    ...hooksFor('diagnostic'),
    budget: sharedBudget,   // shared with recommendation
    signal: req.signal,
  });
  send({ type: 'diagnosis', diagnosis });
}
if (step === 'recommend' || !step) {
  const recAgent = new RecommendationAgent(anthropic, dataSource, schema, allTools, sid);
  const recs = await recAgent.propose(anomaly, diagnosis, {
    ...hooksFor('recommendation'),
    budget: sharedBudget,   // continues from diagnostic
    signal: req.signal,
  });
  for (const r of recs) send({ type: 'recommendation', recommendation: r });
}
```

The route does three supervisor jobs explicitly:

1. **Decompose** — reads `?step=…` and decides which workers to run.
2. **Delegate** — constructs each worker with its dependencies (Anthropic client, DataSource, WorkspaceSchema, tool definitions, session id) and calls its main method.
3. **Synthesize** — collects worker outputs (Diagnosis, Recommendation[]) and streams them to the UI as NDJSON.

Nothing in the LLM layer knows there are other workers. The workers see the DataSource + their own hooks; the route sees the sequence.

**The decision that stays explicit: workers-as-tools vs handoff.** The reader-grade question:

```
  Two ways the supervisor can call workers

  Tools-style (this repo):        Handoff-style:
    supervisor stays in control      control transfers to worker
    knows about all workers          worker doesn't know about
    can override / redirect          successor; supervisor may not
                                     re-enter
    easier to trace                  more flexible, harder to trace

  This repo: tools-style. The route always regains control between
  workers and always drives the next hop.
```

Tools-style is the correct pick for this product because the sequence is fixed (feed → diagnose → recommend), and the UI depends on the supervisor knowing what stage the user is in.

**The synthesis step, made concrete.** The supervisor synthesizes worker outputs by:

1. Streaming each worker's `AgentEvent`s to the UI as they arrive (real-time synthesis for the user).
2. Passing the Diagnosis from step 2 to step 3 via URL param + sessionStorage (`?diagnosis=<encoded>`), so the recommendation worker sees the diagnosis as context.
3. Sharing the `BudgetTracker` across workers so they don't blow the ceiling independently.
4. Sharing the `WorkspaceSchema` and tool list (fetched once at supervisor start) so workers don't redundantly bootstrap.

**What breaks without the supervisor.** The workers would each have to bootstrap the schema, own their own budget, and figure out what stage they're in. The route consolidates all of that — worker construction is one line each.

### Move 2.5 — code supervisor vs LLM supervisor, side-by-side

```
  Two supervisors, one topology

  ┌── LLM supervisor ──────────────┐   ┌── Code supervisor (this repo) ─┐
  │  Sonnet call per hop            │   │  Zero LLM calls to route        │
  │  Cost:   ~$0.05 per decision    │   │  Cost:   $0                     │
  │  Latency: ~2-3s per decision    │   │  Latency: nanoseconds           │
  │  Decides which worker           │   │  Decides via if/switch           │
  │  Adapts to novel decompositions │   │  Fails for undesigned paths     │
  │  Hard to trace decisions        │   │  Every route is git-diffable    │
  │  Prompt is the routing rules    │   │  Code is the routing rules      │
  └────────────────────────────────┘   └────────────────────────────────┘
```

Neither is universally better. Code supervisor wins when the routing is stable; LLM supervisor wins when it isn't. This repo's product has three well-known stages that map 1:1 to UI screens — the routing is stable by design, so code wins.

### Move 3 — the principle

The supervisor's core job is **routing (SECTION A) + synthesis**. The topology's power comes from the specialists at the worker layer, but the supervisor is where the coordination cost lives. Naming whether the supervisor is code or LLM up front tells you where the cost is going — and choosing code-routed when the sequence is stable is a strong senior-grade signal.

## Primary diagram

```
  Supervisor-worker in this repo — code supervisor, four workers

  ┌─ Browser ─────────────────────────────────────────────────────────┐
  │  useInvestigation / useBriefingStream                              │
  └───────────────────────────┬───────────────────────────────────────┘
                              │ /api/briefing or /api/agent
  ┌─ SUPERVISOR (TypeScript route handler) ───────────────────────────┐
  │                                                                    │
  │  briefing route:                                                   │
  │    stage 1  → MonitoringAgent                                      │
  │                                                                    │
  │  agent route:                                                      │
  │    if step=diagnose  → DiagnosticAgent                             │
  │    if step=recommend → RecommendationAgent (with diagnosis)        │
  │    if q (free-form)  → classifyIntent → QueryAgent(intent)         │
  │                                                                    │
  │  shared across workers within a request:                           │
  │    - Anthropic client                                              │
  │    - DataSource (Bloomreach MCP, Synthetic, or Fault-injected)     │
  │    - WorkspaceSchema (bootstrapped once)                           │
  │    - tool list (listTools once)                                    │
  │    - BudgetTracker (Diagnostic + Recommendation share one)         │
  │    - req.signal (cancellation)                                     │
  └──┬─────────────────────┬─────────────────────┬──────────────────┬──┘
     ▼                     ▼                     ▼                  ▼
  ┌───────────┐   ┌───────────────┐   ┌────────────────┐   ┌────────────┐
  │Monitoring │   │  Diagnostic   │   │ Recommendation │   │   Query    │
  │  (ReAct)  │   │   (ReAct)     │   │    (ReAct)     │   │  (ReAct)   │
  │  find     │   │  test         │   │  propose       │   │  answer    │
  │  anomalies│   │  hypotheses   │   │  Bloomreach    │   │  free-form │
  │           │   │               │   │  actions       │   │  question  │
  └─────┬─────┘   └───────┬───────┘   └────────┬───────┘   └─────┬──────┘
        │                 │                    │                 │
        └─────────────────┴────────────────────┴─────────────────┘
                                    │ each worker calls
                                    ▼ DataSource.callTool
                          ┌───────────────────────┐
                          │  DataSource seam      │
                          │  → MCP or synthetic   │
                          └───────────────────────┘
```

## Elaborate

Supervisor-worker traces to the AI-planning literature (STRIPS, HTN planners) and the actor-model (Erlang, Akka) supervision trees. The modern LLM incarnation surfaced with early LangChain "router chains" and matured through AutoGen's `GroupChat` + `Manager` pattern (2023) and LangGraph's `create_supervisor` (2024).

The recurring debate is LLM supervisor vs code supervisor. The industry is settling on: **use code when the sequence is stable, LLM when it isn't, hybrid when part of it is stable**. Anthropic's "Building Effective Agents" essay explicitly recommends the hybrid — deterministic outer flow with LLM decisions only at the ambiguous nodes. This repo's shape (fully deterministic outer flow) is the far end of that spectrum, which is the right pick for a product with UI-visible stages.

## Interview defense

**Q: What's your supervisor?**

A Next.js route handler — `app/api/agent/route.ts` and `app/api/briefing/route.ts`. Code, not LLM. It decomposes the task by reading `?step=…` or a Haiku intent classification for free-form Q&A, constructs the specialist worker with shared dependencies (Anthropic client, DataSource, schema, budget tracker, cancellation signal), and streams the worker's `AgentEvent`s to the UI as NDJSON.

The decision to make code-routed vs LLM-routed: the three-stage sequence (monitor → diagnose → recommend) is stable and UI-visible, so an LLM supervisor would cost ~$0.05 per hop and buy nothing.

*Anchor visual:* the four-workers-under-code-supervisor diagram above.

**Q: Workers-as-tools or handoff?**

Tools-style. The route always regains control between workers. Reasons: (a) the sequence is fixed, (b) the UI depends on the supervisor knowing which stage the user is in, (c) tracing is much simpler — every hop is git-diffable code.

Handoff would be right for a swarm where any worker can hand to any peer specialist. Not this product.

**Q: What breaks if you removed the supervisor?**

Each worker would have to bootstrap the schema, own its own budget, own its cancellation signal, and figure out what stage it's in. The route consolidates all of that — worker construction is one line each. Removing the supervisor means either duplicating that setup in every worker, or restructuring the workers into a single agent that adapts (which is the "collapse to single-agent" refactor, not viable given the different final output shapes).

## See also

- **`01-when-not-to-go-multi-agent.md`** — the gate before picking this topology.
- **`03-sequential-pipeline.md`** — how diagnostic → recommendation flows inside this supervisor.
- **`08-shared-state-and-message-passing.md`** — how the supervisor passes context to workers.
- **`04-agent-infrastructure/05-guardrails-and-control.md`** — how the supervisor enforces caps and budgets.

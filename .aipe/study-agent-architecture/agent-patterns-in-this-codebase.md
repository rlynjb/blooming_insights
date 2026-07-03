# Agent patterns in this codebase

*Type: repo-specific pattern inventory*

What this repo actually uses. Every row is a real feature; every diagram is a real loop or topology in the code.

## The patterns table

```
  ┌───────────────────────────┬──────────────────────────┬─────────────────────────────┐
  │ Feature (route/agent)     │ Pattern / shape          │ Why this pattern            │
  ├───────────────────────────┼──────────────────────────┼─────────────────────────────┤
  │ Briefing (feed)           │ Single-agent ReAct       │ Dynamic path — which        │
  │  /api/briefing            │ (MonitoringAgent)        │ metric to check next        │
  │                           │                          │ depends on prior results    │
  ├───────────────────────────┼──────────────────────────┼─────────────────────────────┤
  │ Investigate step 2        │ Single-agent ReAct       │ Hypothesis test loop; the   │
  │  /api/agent?step=diagnose │ (DiagnosticAgent)        │ next EQL depends on last    │
  │                           │                          │ finding                     │
  ├───────────────────────────┼──────────────────────────┼─────────────────────────────┤
  │ Investigate step 3        │ Single-agent ReAct       │ Grounded proposal loop;     │
  │  /api/agent?step=recommend│ (RecommendationAgent)    │ pulls Bloomreach features   │
  │                           │                          │ that fit the diagnosis      │
  ├───────────────────────────┼──────────────────────────┼─────────────────────────────┤
  │ Free-form Q&A (QueryBox)  │ Router + single-agent    │ Intent varies; classifier   │
  │  /api/agent?q=…           │ (classifyIntent + Query) │ picks agent tuning          │
  ├───────────────────────────┼──────────────────────────┼─────────────────────────────┤
  │ Full investigation        │ Multi-agent pipeline     │ Diagnosis feeds recommend;  │
  │  (step 2 → step 3)        │ (Diagnostic → Recommend) │ two specialties, sequential │
  ├───────────────────────────┼──────────────────────────┼─────────────────────────────┤
  │ Whole product             │ Code-routed supervisor-  │ Three well-known stages;    │
  │  (feed → step 2 → step 3) │ worker (route is the     │ deterministic routing beats │
  │                           │ supervisor)              │ an LLM supervisor here      │
  └───────────────────────────┴──────────────────────────┴─────────────────────────────┘
```

## The topology, as drawn

The overall shape is supervisor-worker with a code supervisor and pipeline structure between two of the workers.

```
  End-to-end topology — 3 routes, 4 workers, 1 code supervisor

  ┌─ Supervisor (code) ──────────────────────────────────────────────┐
  │  app/api/briefing/route.ts    → step 1: monitoring               │
  │  app/api/agent/route.ts       → step 2 or 3: diagnostic |        │
  │                                              recommendation      │
  │                                → free-form: classifyIntent +     │
  │                                              query               │
  │  budget tracker per request; hooks stream every event            │
  └─────┬────────────────┬───────────────┬───────────────┬───────────┘
        │                │               │               │
        ▼                ▼               ▼               ▼
  ┌───────────┐   ┌────────────┐   ┌────────────┐   ┌───────────┐
  │Monitoring │   │ Diagnostic │──►│ Recommend. │   │  Query    │
  │  (ReAct)  │   │  (ReAct)   │   │  (ReAct)   │   │  (ReAct)  │
  └─────┬─────┘   └─────┬──────┘   └─────┬──────┘   └─────┬─────┘
        │               │                │                │
        └───────────────┴────────────────┴────────────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │  DataSource seam      │
                    │  (Bloomreach default) │
                    └───────────────────────┘
```

## Loop 1 — the MonitoringAgent (briefing)

`lib/agents/monitoring.ts:73-116` wraps aptkit's `AnomalyMonitoringAgent`. One ReAct loop over the whole workspace: reads schema, picks which metrics to check (from a 10-category coverage report), runs `execute_analytics_eql` for each, ranks anomalies by severity, returns `Anomaly[]`.

```
  MonitoringAgent — one ReAct loop, schema-gated

  ┌──────────────────────────────────────────────────────┐
  │  agent.scan(hooks, categories)                       │
  │    while not done:                                   │
  │      pick next category to check                     │
  │      → execute_analytics_eql(90d current vs prior)   │
  │      → observe % change + significance               │
  │      if enough anomalies OR all categories checked:  │
  │        return Anomaly[]                              │
  └──────────────────────────────────────────────────────┘
```

Control envelope: aptkit iteration cap, per-tool 30s timeout, ~1 req/s spacing at the DataSource, budget tracker optional (not used on briefing today). Eval: category coverage (10 tiles fill in step with the reasoning trace).

## Loop 2 — the DiagnosticAgent

`lib/agents/diagnostic.ts:36-67` wraps aptkit's `DiagnosticInvestigationAgent`. Takes one `Anomaly`, runs a hypothesis-test loop until a `Diagnosis` is reached (conclusion + evidence + hypothesesConsidered + affectedCustomers).

```
  DiagnosticAgent — hypothesis test loop

  input: Anomaly (metric, scope, change)
    │
    ▼
  ┌──────────────────────────────────────────────────────┐
  │  form hypotheses (segment / product / channel / …)   │
  │  while not confident:                                │
  │    pick highest-value hypothesis                     │
  │    → execute_analytics_eql to test                   │
  │    → observe: supported? refuted? partial?           │
  │    update evidence                                   │
  │  return Diagnosis { conclusion, evidence, tried }    │
  └──────────────────────────────────────────────────────┘
```

Control envelope: iteration cap (aptkit), budget tracker (default $0.30, hits `BudgetExceededError` if exceeded), `req.signal` cancellation. Baseline: p50 50s, ~$0.09 per case.

## Loop 3 — the RecommendationAgent

`lib/agents/recommendation.ts:17-47` wraps aptkit's `RecommendationAgent`. Takes the diagnosis (handed over as JSON via `?diagnosis=`), proposes 1-3 concrete Bloomreach actions (scenario / segment / campaign / voucher / experiment), each with rationale + steps + confidence + expectedImpact.

```
  RecommendationAgent — grounded proposal loop

  input: Anomaly + Diagnosis
    │
    ▼
  ┌──────────────────────────────────────────────────────┐
  │  brainstorm Bloomreach actions matching the cause    │
  │  while not enough grounded proposals:                │
  │    → get_segment_definitions / list_scenarios / …    │
  │    → check feasibility against workspace catalogs    │
  │    → shape one Recommendation with expected impact   │
  │  return Recommendation[]                             │
  └──────────────────────────────────────────────────────┘
```

Control envelope: same tracker as diagnostic (accumulates across the two), `req.signal`. Baseline: p50 51s.

## The pipeline — diagnostic feeding recommendation

Two workers, sequential, output-feeds-input. The route handles the handoff explicitly.

```
  Investigation pipeline

  app/investigate/[id]/page.tsx        app/investigate/[id]/recommend/page.tsx
  ┌────────────────────────┐            ┌──────────────────────────────────┐
  │  useInvestigation('diagnose')       │  useInvestigation('recommend')   │
  │  → /api/agent?step=diagnose         │  → /api/agent?step=recommend     │
  │                                     │      ?diagnosis=<encoded>        │
  │  streams NDJSON                     │                                  │
  │  final: Diagnosis                   │  streams NDJSON                  │
  │  ↓ stash in sessionStorage          │  final: Recommendation[]         │
  │  ↓ hand off via ?diagnosis=…        │                                  │
  └────────────────────────┘            └──────────────────────────────────┘
```

This is the SECTION C sequential-pipeline pattern. The handoff shape (sessionStorage → URL param) is explicit; the diagnosis is a serializable Diagnosis JSON that both sides agree on.

## The router — free-form Q&A

The `?q=…` path is the only place the repo uses LLM routing: `classifyIntent(anthropic, q)` runs Haiku to pick an `Intent` (`diagnostic` | `monitoring` | `recommendation`), then hands to the `QueryAgent` (which tunes its prompt to the intent). Not a "supervisor deciding which agent to run" — the QueryAgent is the only worker for the Q&A path — but a real routing gate.

```
  Free-form Q&A

  user asks: "why did revenue drop last week?"
    │
    ▼
  ┌───────────────────────────────────┐
  │  classifyIntent (Haiku)           │  ~50ms, deterministic-enough
  │  → 'diagnostic'                   │
  └────────────┬──────────────────────┘
               ▼
  ┌───────────────────────────────────┐
  │  QueryAgent.answer(q, intent)     │
  │  (ReAct loop with all MCP tools,  │
  │   prompt shaped by intent)        │
  └───────────────────────────────────┘
```

## What this repo does NOT do (honest inventory)

- **No LLM supervisor.** Multi-agent routing is code, not an LLM. This is a design choice, not an oversight — the three stages are well-known so an LLM decision adds cost without buying anything.
- **No parallel fan-out.** Each investigation runs one diagnostic loop then one recommendation loop, sequential. Fan-out would help if the diagnostic branched hypotheses independently, but the current shape (`AptKitDiagnosticInvestigationAgent`) picks one branch at a time.
- **No verifier/critic.** There is no second-model review step. Eval is offline (frozen golden trajectories, LLM-as-judge outside the request path).
- **No swarm handoff.** Agents don't cede control to each other peer-to-peer — the route handler owns the sequence.
- **No graph orchestration framework.** No LangGraph, no explicit state machine — the sequence is inline TypeScript in the route handler.
- **No vector RAG.** Retrieval is tool-driven (agent picks the EQL query), not embedding-based. See `02-agentic-retrieval/03-retrieval-routing.md` for why this is still a form of retrieval routing (deterministic routing to the right tool).

## The refactor to add each

Each SECTION C topology file's Move 2 in this guide names the refactor that would adopt it. As a summary here:

- **Parallel fan-out** — split diagnostic hypotheses into independent branches, run in parallel through `Promise.allSettled`, merge in a synthesis step. Concrete file to change: `lib/agents/diagnostic.ts` + adapter tweaks in `aptkit-adapters.ts` if aptkit's loop needs a branching hook.
- **Verifier/critic** — add a `DiagnosisCriticAgent` that scores the diagnosis against a rubric; loop on low-confidence. New file: `lib/agents/diagnosis-critic.ts` plus route wiring in `app/api/agent/route.ts`.
- **Graph orchestration** — port the route-handler sequence to a state machine. Not obviously worth the up-front cost yet; the three-stage sequence is stable.

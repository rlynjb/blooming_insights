# Sequential / pipeline

*Industry names: sequential pipeline / chain-of-agents · Language-agnostic*

## Zoom out

```
  Zoom out — pipeline is the shape between two of this repo's workers

  ┌─ SECTION C topologies ──────────────────────┐
  │  supervisor-worker (whole topology)          │
  │  ★ sequential pipeline (sub-shape here) ★    │ ← we are here
  │  parallel fan-out                            │
  │  …                                           │
  └──────────────────────────────────────────────┘
```

## Zoom in

Output of one agent feeds the next. In this repo, the diagnostic → recommendation flow is exactly this shape — the Diagnosis from step 2 is handed as input to step 3. Isolated failures, cheap early stages, sequential latency — the tradeoff triangle of pipelines.

## Structure pass

Layers: **stage 1 (producer)** — **handoff (state passing)** — **stage 2 (consumer)** — **… stage N**.

Axis to hold constant: **what travels between stages?**

```
  What crosses each seam

  If a well-defined output travels:  clean pipeline
  If ambiguous state travels:        implicit shared state
                                     (not a pipeline; go read
                                     shared-state-and-message-passing)
```

## How it works

### Move 1 — the shape

You've written `parseInput().then(validate).then(transform).then(save)` before. Sequential agents are that shape where each `.then()` is a full agent run and the value being passed is a structured output.

```
  Sequential pipeline — the shape

  ┌─────────┐   draft   ┌─────────┐  reviewed  ┌─────────┐
  │ Agent A │ ────────► │ Agent B │ ─────────► │ Agent C │
  │ (write) │           │ (edit)  │            │ (format)│
  └─────────┘           └─────────┘            └─────────┘
```

### Move 2 — how the diagnostic → recommendation pipeline works here

**Where the pipeline lives — across pages.** The pipeline crosses page boundaries in this repo. Step 2 (diagnostic) is one page (`app/investigate/[id]/page.tsx`); step 3 (recommendation) is the next page (`app/investigate/[id]/recommend/page.tsx`). Each page has its own `/api/agent` request. The handoff between them is the value the pipeline passes: the **Diagnosis** JSON.

**The handoff, step by step.**

```
  Diagnosis handoff — three hops

  ┌─ Page 2 (investigate) ────────────────────────────────┐
  │                                                        │
  │  useInvestigation('diagnose') runs                     │
  │    → /api/agent?step=diagnose&insight=…                │
  │    → streams NDJSON                                    │
  │    → receives final: { type: 'diagnosis', diagnosis }  │
  │                                                        │
  │  On done: stash in sessionStorage                      │
  │    key: 'bi:inv:diagnose:<id>'                          │
  │    value: { diagnosis, items[], … }                    │
  │                                                        │
  │  User clicks "see recommendations →"                   │
  │  → navigate to /investigate/<id>/recommend             │
  │    with ?diagnosis=<JSON.stringify(diagnosis)>          │
  └────────────────────────┬───────────────────────────────┘
                           │
                           ▼
  ┌─ Page 3 (recommend) ──────────────────────────────────┐
  │                                                        │
  │  useInvestigation('recommend') runs                    │
  │    → /api/agent?step=recommend&insight=…&diagnosis=…   │
  │                                                        │
  │  Route parses diagnosis param:                         │
  │    const d = parseDiagnosis(diagnosisParam)            │
  │    // typed validation on { conclusion, evidence,      │
  │    //                        hypothesesConsidered }    │
  │                                                        │
  │  Constructs RecommendationAgent, passes diagnosis      │
  │  → recAgent.propose(anomaly, diagnosis, hooks)         │
  └────────────────────────────────────────────────────────┘
```

**The parse gate at page 3.** The route uses `parseDiagnosis(diagnosisParam)` to validate the shape (`conclusion: string`, `evidence: any[]`, `hypothesesConsidered: any[]`) before passing to the RecommendationAgent. If the URL param is malformed, the route falls back to a lookup from cached state. This is the pipeline's **schema gate** — validate the handoff, don't just trust the caller.

**Why not run both in one request.** Two reasons.

1. **UX.** The user reads the diagnosis, sits with it, and *decides* to go to recommendations. That's meaningful — sometimes the diagnosis alone is enough. Running both up front would waste ~50s of recommendation compute if the user doesn't need it.
2. **Vercel maxDuration budget.** Both stages together run ~100-115s p50. Vercel Pro's max is 300s. Running as separate requests keeps headroom for retries and the ~1 req/s MCP spacing.

**When you would run both in one request.** The `?step=null` path in the route does exactly that — used by the demo-capture tooling to record a full trajectory for the snapshot. Not the user-facing path.

**The tradeoffs the pipeline shape carries.**

```
  Pipeline tradeoffs

  Benefit                                 Cost
  ─────────────────────────────────       ────────────────────────────
  Isolated failures — you know which      Total latency = sum of stages
  stage broke                             (no parallelism)
  Cheap early stages — could use a         Handoff schema is a load-bearing
  cheaper model on the first stage        contract; misspell a field and
  (this repo uses Sonnet for both,        step 2 breaks silently
  hasn't optimized this yet)
  Debuggable — you can re-run a           Every stage runs even when the
  single stage without redoing prior      previous stage's output is
                                          weak — no early exit
```

**The escalation to fix pipeline latency.** If p95 pipeline latency became a blocker, the escalation is to **parallelize the branches inside a stage** (see `04-parallel-fan-out.md`) — the diagnostic could parallelize hypothesis testing. Not the pipeline shape itself; the pipeline shape is correct here.

### Move 3 — the principle

Pipelines are the multi-agent version of function composition. The clean version is when a well-defined structured output travels between stages; the messy version is when ambiguous state travels (which is really shared state pretending to be a pipeline, and worth reading `08-shared-state-and-message-passing.md` for). Same benefit as single-purpose function chains — isolated failures, per-stage debuggability, cheaper models per stage — same cost — sequential latency, contract fragility.

## Primary diagram

```
  The diagnostic → recommendation pipeline — full contract

  ┌─ STAGE 1: DIAGNOSTIC ────────────────────────────────────────┐
  │                                                              │
  │  input:  Anomaly { metric, scope, change, severity, ... }   │
  │  agent:  DiagnosticAgent (ReAct loop)                        │
  │  tools:  execute_analytics_eql, get_event_schema, ...        │
  │  output: Diagnosis {                                         │
  │           conclusion:            string,                     │
  │           evidence:              Evidence[],                 │
  │           hypothesesConsidered:  Hypothesis[],               │
  │           affectedCustomers?:    number                      │
  │         }                                                    │
  │                                                              │
  └─────────────────────────┬────────────────────────────────────┘
                            │ handoff:
                            │   1. sessionStorage stash (client-side)
                            │   2. ?diagnosis=<encoded> URL param
                            │   3. parseDiagnosis() validates on next page
                            ▼
  ┌─ STAGE 2: RECOMMENDATION ────────────────────────────────────┐
  │                                                              │
  │  input:  Anomaly + Diagnosis                                 │
  │  agent:  RecommendationAgent (ReAct loop)                    │
  │  tools:  list_scenarios, get_segment_definitions, ...        │
  │  output: Recommendation[] {                                  │
  │           title, rationale, bloomreachFeature,               │
  │           steps, estimatedImpact, confidence                 │
  │         }                                                    │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

Sequential pipelines are the oldest and most-used multi-agent shape — it's function composition applied to agents. The classic production examples are content-generation chains (research → outline → draft → edit → format) and the diagnostic → prescription pipelines in agentic support systems.

The subtle failure mode is **contract drift** — one stage changes its output schema, the next stage silently uses a partial version, downstream errors show up far from the actual cause. The mitigation is exactly what this repo does: a typed schema for the handoff (`Diagnosis` in `lib/mcp/types.ts`), a parser at the receiving side (`parseDiagnosis()`), and typed contracts on the URL params. LangGraph's typed edges and Pydantic-driven CrewAI outputs are variations of the same discipline.

## Interview defense

**Q: How do diagnosis and recommendation communicate?**

Explicit handoff via a typed structured output. The diagnostic agent emits a `Diagnosis` JSON (conclusion + evidence + hypotheses + affected customers) as its final output. The client stashes it in sessionStorage and passes it to the recommendation route as a URL param `?diagnosis=<encoded>`. The recommendation route validates the shape with `parseDiagnosis()` before constructing the RecommendationAgent with it.

The reasons for the two-request split: (a) the user reads the diagnosis and sometimes doesn't need recommendations — saves 50s of compute per skip, (b) Vercel's 300s cap means one big request would eat headroom for retries and the ~1 req/s MCP spacing.

*Anchor visual:* the two-stage handoff diagram above.

**Q: What's the failure mode of this pipeline?**

Contract drift. If I change the `Diagnosis` shape and forget to update `parseDiagnosis()`, step 3 breaks silently — partial validation, weird downstream errors. Mitigation is the typed contract at both sides + optional fields staying optional so older snapshots still validate.

The other failure mode is **latency accumulation**. Total time is sum of stages; if diagnostic ever went from 50s to 90s, the whole pipeline shifts. Escalation would be parallelizing hypothesis testing inside diagnostic (fan-out), not restructuring the pipeline.

## See also

- **`02-supervisor-worker.md`** — the containing topology.
- **`04-parallel-fan-out.md`** — the parallelization escalation for latency.
- **`08-shared-state-and-message-passing.md`** — the alternative when structured handoff isn't feasible.
- **`04-agent-infrastructure/05-guardrails-and-control.md`** — how the shared BudgetTracker crosses the pipeline stages.

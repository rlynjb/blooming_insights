# Sequential / pipeline

**Industry standard.** Output of one agent feeds the next. **Exercised** in this codebase as the orchestration shape — with the load-bearing distinction that the pipe between stages is deterministic code, not LLM coordination.

## Zoom out, then zoom in

Sits at the orchestration layer. The user-facing pipeline (`monitoring → diagnose → recommend`) is one chain of three agents; the handoff between diagnose and recommend is unusual — it goes through the *client's* `sessionStorage`, not server-side resumable state.

```
  Zoom out — where this concept lives

  ┌─ UI layer ──────────────────────────────────────┐
  │  Feed page → Investigate step 2 → Investigate    │
  │  step 3 (the user clicks through the pipeline)   │
  └────────────────────────────┬────────────────────┘
                               │
  ┌─ Orchestration layer ─────▼────────────────────┐
  │  briefing/route.ts    /api/agent (diagnose)      │ ← we are here
  │      → MonitoringAgent    → DiagnosticAgent      │
  │                            /api/agent (recommend)│
  │                              → RecommendationAgent│
  └──────────────────────────────────────────────────┘
```

## Structure pass

Layers: stage 1 agent → typed output → stage 2 agent → typed output → stage 3 agent.

**Axis traced — "where does the next stage's input come from?":** the previous stage's typed output. Specifically: `Anomaly` (monitoring stage output) → `Diagnosis` (diagnostic stage output) → `Recommendation[]` (recommendation stage output). Each interface is in `lib/mcp/types.ts`.

**Seam:** the typed handoff. Each stage produces a TypeScript-typed value the next consumes; no shared blackboard, no coordination protocol.

## How it works

### Move 1 — the mental model

You know `.then().then().then()` — a Promise chain where each callback transforms the previous resolution. The agent pipeline is that, where each callback is a single-agent ReAct loop instead of a pure function.

```
  ┌─────────┐   anomaly  ┌─────────┐  diagnosis ┌─────────┐
  │MonitorAg│ ─────────► │DiagAg   │ ─────────► │RecAg    │
  │ (scan)  │            │(investig│            │(propose)│
  └─────────┘            └─────────┘            └─────────┘

  Each stage is one ReAct loop. The arrows are typed handoffs.
```

Same isolation benefit as a single-purpose-functions chain: each stage is independently testable (the 144 Vitest tests prove this — each agent has its own test file with mocked predecessor inputs), failures are localized (you know which stage broke from the trace), and you can run a cheaper model on early stages if needed (today they're all Sonnet because the budget is fine).

The latency cost is the sum of all stages, by definition — no parallelism between them, because each depends on the previous one's output.

### Move 2 — step by step

#### Stage 1 — monitoring

Lives in `app/api/briefing/route.ts`. The agent runs once, produces an `Anomaly[]`, the route emits `insight` NDJSON events to the UI. Investigations don't auto-start; the user picks one from the feed by clicking a card.

#### The cross-stage gap — what's *not* server state

When the user clicks an `InsightCard`, the UI stashes the picked `Insight` in `sessionStorage` (via `useBriefingStream.ts:56`) and navigates to `/investigate/[id]`. The investigation page's `useInvestigation` hook reads the stash. **This is the cross-stage handoff.**

The server doesn't carry state across `/api/briefing` → `/api/agent`. The `insightId` is the lookup key; the actual `Insight` flows through the client's `sessionStorage` because Vercel's serverless instances don't share memory across requests. The in-memory `lib/state/insights.ts` map only works on a same-instance follow-up — and the alpha demo path uses the committed `lib/state/demo-insights.json` snapshot as the canonical resolution.

The `resolveAnomaly` function (`app/api/agent/route.ts:35-60`) makes this explicit — it tries the client-provided `?insight=...` JSON first, then the in-memory map, then the demo snapshot. The cross-stage handoff is "client carries the typed value forward."

#### Stages 2 and 3 — the two-step investigation

The single `/api/agent` route handles BOTH stages, branching on the `step` query param:

- `step=diagnose`: run `DiagnosticAgent.investigate(anomaly)`, emit `diagnosis` NDJSON, do **not** run the recommendation.
- `step=recommend`: read the `diagnosis` from the `?diagnosis=...` query param (handed over from step 2), run `RecommendationAgent.propose(anomaly, diagnosis)`, emit `recommendation` NDJSON for each.

The relevant code in `app/api/agent/route.ts:267-297` is straight `if/else` on `step`. The handoff between step 2 and step 3 again goes through the *client's* `sessionStorage` (see `useInvestigation.ts:134-140`):

```ts
// useInvestigation.ts:134-140 (abridged)
sessionStorage.setItem(
  stashKey(step, id),
  JSON.stringify({ diagnosis: cDiag, ... }),
);
sessionStorage.setItem(diagHandoffKey(id), JSON.stringify({ diagnosis: cDiag }));
```

The diagnosis is written to `sessionStorage` after step 2 completes, then the user clicks "see recommendations →" which navigates to `/investigate/[id]/recommend`. That page's `useInvestigation` hook reads the diagnosis back from sessionStorage and includes it in the step 3 fetch as the `?diagnosis=` query param.

**This client-side handoff is the unusual part.** Most server-side agent pipelines hand state directly between stages in process memory or in a state store (Redis, Postgres, etc.). This repo's design accepts the cost — the client carries the typed value — in exchange for not needing a session store on the server (matches `## What must not change` in the project context: "no database; state lives in in-memory maps").

The captured demo snapshot is the alternative path: when `live=false` and a cached investigation exists, the route replays the recorded NDJSON stream filtered by step (`app/api/agent/route.ts:125-141`). Then the diagnosis comes from the cached stream's `diagnosis` event, not from sessionStorage.

#### Why this is a pipeline and not a multi-agent system

The agents never talk to each other. The pipeline is:

```
Monitoring → emits Anomaly[] (typed)
   ▼ via client sessionStorage
Diagnostic → emits Diagnosis (typed)
   ▼ via client sessionStorage
Recommendation → emits Recommendation[] (typed)
```

Each stage receives a typed value and produces a typed value. The orchestration is *deterministic code* — the route handler decides which stage runs based on `step`, the client decides which step is "next" based on the user's click. There's no LLM coordination. This is what the spec calls "the pipeline shape with the load-bearing distinction that the orchestrator is code, not a model."

### Move 3 — the principle

**Sequential pipelines work when the stage order is genuinely known and stages don't need to coordinate.** The handoff is a typed value, not a coordination message. The latency cost (sum of stages) is the price you pay for the structural simplicity (every stage is independently testable, traceable, retryable).

The variant in this repo — handing state through the client between stages — is unusual but appropriate when the server is stateless by design. The cost is: state is lost if the user closes the tab between steps. The mitigation: the demo path's committed snapshot acts as a canonical investigation; live investigations are recoverable from the URL + the client's sessionStorage; the unrecoverable failure mode is "user closed tab mid-investigation" which is just "they have to start over."

## Primary diagram

```
  The full pipeline — three agents, two route handlers, client-side handoffs

  USER CLICKS "monitoring is fresh"  (loads feed page)
        │
        ▼
  ┌─ /api/briefing ─────────────────────────────────────────────────┐
  │   bootstrap schema → coverage gate                               │
  │     → MonitoringAgent.scan() [1 ReAct loop, maxToolCalls=6]      │
  │     → emit insights[] as NDJSON                                  │
  └─────────────────────────────┬───────────────────────────────────┘
                                │  insights[] over NDJSON wire
                                ▼
  ┌─ UI ─────────────────────────────────────────────────────────────┐
  │   feed page renders InsightCards                                  │
  │   USER CLICKS A CARD                                              │
  │   sessionStorage.setItem('bi:insight:${id}', JSON.stringify(i))   │
  │   navigate to /investigate/${id}                                  │
  └─────────────────────────────┬───────────────────────────────────┘
                                │
                                ▼
  ┌─ /api/agent?insightId=...&step=diagnose ─────────────────────────┐
  │   resolveAnomaly (reads ?insight= param or session map or demo)   │
  │     → DiagnosticAgent.investigate(anomaly) [1 ReAct loop]         │
  │     → emit diagnosis NDJSON                                       │
  │     → DO NOT run recommendation (step is 'diagnose')              │
  └─────────────────────────────┬───────────────────────────────────┘
                                │  diagnosis over NDJSON wire
                                ▼
  ┌─ UI ─────────────────────────────────────────────────────────────┐
  │   EvidencePanel renders                                           │
  │   sessionStorage.setItem(diagHandoffKey(id), {diagnosis})         │
  │   USER CLICKS "see recommendations →"                             │
  │   navigate to /investigate/${id}/recommend                        │
  └─────────────────────────────┬───────────────────────────────────┘
                                │
                                ▼
  ┌─ /api/agent?insightId=...&step=recommend&diagnosis=... ──────────┐
  │   resolveAnomaly (same)                                           │
  │   parseDiagnosis from ?diagnosis= query param                     │
  │     → RecommendationAgent.propose(anomaly, diagnosis) [1 ReAct]   │
  │     → emit recommendation NDJSON per item                         │
  └──────────────────────────────────────────────────────────────────┘
```

## Elaborate

The "client-side handoff" pattern this repo uses is unconventional but defensible when the server is stateless by design. Most production agent pipelines run on infrastructure with a per-session store (Redis, Postgres, Convex), and the server can hand state through between stages without involving the client. This repo's "no database" constraint (see `lib/state/` — in-memory maps that don't survive across serverless instances) forces the client to be the state carrier.

The alternative would be: combined `/api/agent` with `step=null` (which still exists — used by the demo-snapshot capture path) runs both diagnose and recommend back-to-back in one request, no client handoff needed. The split into two steps exists for the user-facing flow because the diagnosis takes 50-80s to produce and the user wants to read it (and potentially abandon the flow) before paying for the recommendation. The two-step flow saves recommendation cost when the user reads the diagnosis and decides not to drill further.

The diagnosis-via-query-param is a small but load-bearing detail. The query param is JSON-stringified, URL-encoded, and can carry ~5-10KB of diagnosis (which fits typical diagnoses — `Diagnosis` is small: a conclusion string, an evidence array of strings, a hypotheses array). For larger handoffs the URL would overflow and a server-side store would become necessary. The current shape is "lightweight enough to fit the URL," which is fine for this domain.

## Interview defense

> **Q: How does the investigation flow work, end to end?**
>
> Three deterministic stages. Stage 1: `/api/briefing` runs the monitoring agent and emits anomalies as an NDJSON stream the UI renders as `InsightCard`s. The user clicks a card, which writes the picked insight to `sessionStorage` and navigates to `/investigate/[id]`. Stage 2: `/api/agent?step=diagnose&insightId=...` reads the insight (from the client's stash or the demo snapshot fallback), runs the diagnostic agent, emits the diagnosis. The UI renders it and writes it back to `sessionStorage`. The user clicks "see recommendations" and navigates to `/recommend`. Stage 3: `/api/agent?step=recommend&insightId=...&diagnosis=...` reads the diagnosis from the query param, runs the recommendation agent, emits the recommendations. The whole pipeline is deterministic — no model picks which stage runs.

> **Q: Why does the diagnosis go through the client's sessionStorage instead of staying on the server?**
>
> Vercel serverless instances don't share memory across requests, and the project intentionally avoids a database. So between step 2 (`/api/agent?step=diagnose`) and step 3 (`/api/agent?step=recommend`), the server has no place to store the diagnosis it produced. The client carries the typed `Diagnosis` value forward via `sessionStorage` and submits it back as the `?diagnosis=` query param in step 3. The route reads it via `parseDiagnosis` in `app/api/agent/route.ts:84-95`. The unusual handoff path is a direct consequence of the no-database constraint. The failure mode is recoverable — closing the tab loses the diagnosis, the user has to start over.

> **Q: Is this pipeline a multi-agent system?**
>
> No. Three single-agent loops dispatched by deterministic code, with typed values handed between stages. The agents never talk to each other; the orchestrator is TypeScript, not an LLM. This is the "workflow with agent steps" shape, not multi-agent. Multi-agent vocabulary (supervisor, coordination protocol, handoff) doesn't apply because there's no LLM coordination layer.

## See also

- → `01-when-not-to-go-multi-agent.md` — the deliberate non-escalation that produced this shape
- → `02-supervisor-worker.md` — what this would become with an LLM coordinator
- → `08-shared-state-and-message-passing.md` — the typed-handoff pattern in this pipeline
- → `04-parallel-fan-out.md` — what stages 1 and 2 could become if independent queries grew
- → cross-reference (when generated): `study-system-design`'s streaming NDJSON pattern — the wire format every stage's output rides on

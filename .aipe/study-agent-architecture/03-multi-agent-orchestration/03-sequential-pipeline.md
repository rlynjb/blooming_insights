# Sequential pipeline

*Industry name: sequential pipeline / chain-of-agents / agent chain — Industry standard.*

**THIS is the pattern this repo uses.** Output of one agent feeds the next, in a fixed order. Three agents, three stages: monitoring → diagnostic → recommendation. Plus a hard split between stage 2 and stage 3 at the HTTP boundary so the user reviews before recommendations run.

## Zoom out — where this pattern lives

The pipeline spans the whole stack — UI prompts the next stage by navigating to the next URL; the route handler dispatches the next agent; each agent runs on its own request. The pipeline is the *product workflow*.

```
  Where the sequential pipeline lives in blooming insights

  ┌─ UI layer ──────────────────────────────────────────────┐
  │  app/page.tsx          → /api/briefing  (stage 1)        │
  │  app/investigate/[id]/page.tsx                            │
  │     → /api/agent?step=diagnose (stage 2)                  │
  │  app/investigate/[id]/recommend/page.tsx                  │
  │     → /api/agent?step=recommend (stage 3)                 │
  └───────────────────┬──────────────────────────────────────┘
                      ▼
  ┌─ Service layer ─────────────────────────────────────────┐
  │  /api/briefing → MonitoringAgent                         │
  │  /api/agent?step=diagnose → DiagnosticAgent              │
  │  /api/agent?step=recommend → RecommendationAgent         │
  └───────────────────┬──────────────────────────────────────┘
                      ▼
  ┌─ Agent layer ───────────────────────────────────────────┐
  │  THE PIPELINE: monitoring → diagnostic → recommendation │ ← we are here
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

The axis: **how does one agent's output become the next agent's input?**

```
  Sequential pipeline — the data flow

  ┌──────────────┐  Anomaly[]   ┌──────────────┐  Diagnosis   ┌────────────────┐
  │ Monitoring   │ ───────────► │ Diagnostic   │ ───────────► │ Recommendation │
  │ Agent        │              │ Agent        │              │ Agent          │
  └──────────────┘              └──────────────┘              └────────────────┘
       ▲                              ▲                              ▲
       │ trigger:                     │ trigger:                     │ trigger:
       │ GET /api/briefing            │ GET /api/agent?              │ GET /api/agent?
       │                              │   insightId=X&               │   insightId=X&
       │                              │   step=diagnose              │   step=recommend
       │                              │                              │   &diagnosis={...}
       │                              │                              │
       │                              │ stash anomaly                │ pass diagnosis
       │                              │ via insightParam URL          │ via diagnosis URL
       │                              │ (survives Vercel cold start) │  param
```

Three stages, three HTTP boundaries. The pipeline is *split across requests* — that's the unusual part. The split makes sense because the user reviews each stage before continuing; running all three in one request would deny the user the chance to read the diagnosis before recommendations are generated.

## How it works

### Move 1 — the mental model

You know `Promise.resolve().then(a).then(b).then(c)` — the chain you wrote where each function's output becomes the next's input. Sequential pipeline is that, except each function is a full ReAct loop and the chain is split across HTTP requests so the user can pause between stages.

```
  Sequential pipeline — output of one feeds the next

  ┌─────────┐   draft   ┌─────────┐  reviewed  ┌─────────┐
  │ Agent A │ ────────► │ Agent B │ ─────────► │ Agent C │
  │ (write) │           │ (edit)  │            │ (format)│
  └─────────┘           └─────────┘            └─────────┘
       │                     │                       │
       └─── each is a full ReAct loop, not just an LLM call ───┘
```

### Move 2 — walk this repo's pipeline

**Stage 1 — Monitoring.**

Triggered by `GET /api/briefing`. The agent scans the workspace and emits an array of anomalies.

```typescript
// app/api/briefing/route.ts:257-281 (paraphrased)
const agent = new MonitoringAgent(anthropic, dataSource, schema, allTools, sid);
const anomalies = await agent.scan({
  onToolCall: (tc) => { send({ type: 'tool_call_start', ... }); ... },
  onToolResult: (tc) => send({ type: 'tool_call_end', ... }),
  onText: (t) => { if (t.trim()) step(t.trim()); },
  signal: req.signal,
}, runnable);

const insights = anomalies.map(anomalyToInsight);
putInsights(sid, insights, anomalies);
for (const insight of listInsights(sid)) send({ type: 'insight', insight });
```

Output: `Anomaly[]` (the agent's native shape) mapped to `Insight[]` (the UI's shape). Each insight gets streamed to the feed as it's emitted. **The pipeline pauses here** — the user reads the cards on the feed and decides which one to investigate.

**Stage 2 — Diagnostic.**

Triggered by `GET /api/agent?insightId=X&step=diagnose&insight={...}`. The user clicked a card; the URL carries the insight back to the server (or the server resolves it from the session cache).

```typescript
// app/api/agent/route.ts:273-285 (paraphrased)
stepFor('diagnostic', 'thought', `investigating "${inv.metric}" ...`);
const diagAgent = new DiagnosticAgent(anthropic, dataSource, schema, allTools, sid);
const t_diag = performance.now();
diagnosis = await diagAgent.investigate(inv, { ...hooksFor('diagnostic'), signal: req.signal });
recordPhase('diagnostic_investigate', t_diag);
send({ type: 'diagnosis', diagnosis });
```

Output: a `Diagnosis` object with `conclusion`, `evidence[]`, `hypothesesConsidered[]`, optionally `affectedCustomers`. Streamed to the EvidencePanel UI. **The pipeline pauses again** — the user reads the diagnosis and clicks "see recommendations →" to proceed.

The hard split: line 289 of the same file says `if (step !== 'diagnose')` — meaning when `step === 'diagnose'`, the route NEVER runs the recommendation agent. The user has to explicitly proceed to stage 3.

**Stage 3 — Recommendation.**

Triggered by `GET /api/agent?insightId=X&step=recommend&diagnosis={...}`. The browser carries the diagnosis from stage 2 in sessionStorage, then passes it as a URL param to stage 3.

```typescript
// app/api/agent/route.ts:267-272, 289-296 (paraphrased)
if (step === 'recommend') {
  diagnosis = parseDiagnosis(diagnosisParam);
  if (!diagnosis) {
    throw new Error('no diagnosis was handed over — open the diagnosis step first');
  }
}
// ...
if (step !== 'diagnose') {
  stepFor('recommendation', 'thought', 'proposing actions based on the diagnosis…');
  const recAgent = new RecommendationAgent(anthropic, dataSource, schema, allTools, sid);
  const recommendations = await recAgent.propose(inv, diagnosis!, { ...hooksFor('recommendation'), signal: req.signal });
  for (const r of recommendations) send({ type: 'recommendation', recommendation: r });
}
```

Output: `Recommendation[]` (up to 3) streamed one at a time to the RecommendationCard UI. End of pipeline.

**Why split stage 2 and stage 3 across requests?**

The product reason: the user reviews the diagnosis before recommendations run. If the diagnosis is wrong, generating recommendations from it wastes tokens AND misleads the user. The split forces a human-in-the-loop pause.

The architectural cost: the diagnosis has to round-trip through the browser (sessionStorage + URL param) because Vercel serverless instances are ephemeral. Different requests might land on different instances; in-memory state doesn't survive. So the diagnosis has to be *serializable* and small enough to fit in a URL — both constraints shaped the `Diagnosis` interface.

### Move 2.5 — the in-process variant (capture-only)

The route ALSO supports a combined run (when `step == null`), which is used by the demo-snapshot capture path:

```typescript
// app/api/agent/route.ts:302
if (step == null) saveInvestigation(insightId!, collected);
```

When `step` is omitted, both agents run in series within one request — diagnostic, then recommendation, then the entire trace gets saved to `lib/state/investigations.ts`. This is the in-process variant of the pipeline, no HTTP split. It's used to generate the committed demo snapshot (`lib/state/demo-investigations.json`) that the demo mode replays.

So there are *two* sequencing strategies in the codebase:

```
  Two ways to run the diagnose→recommend pipeline

  Production (split across HTTP):
   step 2 request  →  DiagnosticAgent  →  diagnosis to browser
   step 3 request  →  RecommendationAgent  (with diagnosis from URL)
   USER PAUSES BETWEEN
   benefit: human review; works across Vercel cold starts

  Capture (combined in one request):
   single request  →  DiagnosticAgent  →  RecommendationAgent  →  save
   no pause
   benefit: one trace for the demo snapshot; in-process handoff
```

### Move 3 — the principle

Sequential pipeline is the cheapest multi-agent topology that gives you specialization. Each agent has a narrower prompt, a narrower tool grant, and a known input shape — three real benefits. The cost is latency: stages run in series, so total time is the sum of all stages. In this repo that's acceptable because the user reviews between stages anyway — the user's review time dwarfs the pipeline's compute time, so the sequential constraint is invisible.

The pattern works when:
- The stages have a natural order (you can't recommend before diagnosing; you can't diagnose without knowing what to investigate)
- Each stage's output is the next stage's input (no fan-in/fan-out)
- The cost of review-between-stages is acceptable (the user wants to look at the diagnosis before recommendations are spent on it)

When you'd reach for something else: fan-out when stages don't depend on each other; supervisor when the order isn't known; debate when the stages need to argue. None of those apply here.

## Primary diagram

The pipeline as it actually runs, including the HTTP split:

```
  Sequential pipeline — production flow, split across requests

  ┌─ Request 1: GET /api/briefing ──────────────────────────────┐
  │  route → bootstrap → schemaCapabilities → runnableCategories │
  │  → MonitoringAgent.scan() [ReAct, 8 turns, 6 tool calls]    │
  │  → Anomaly[] mapped to Insight[]                             │
  │  → stream each insight as NDJSON                             │
  └──────────────────────────┬──────────────────────────────────┘
                             ▼
                  USER reads feed, clicks a card
                             │
                             ▼
  ┌─ Request 2: GET /api/agent?insightId=X&step=diagnose ───────┐
  │  route → resolveAnomaly (insight from URL or session)        │
  │  → DiagnosticAgent.investigate(anomaly) [ReAct, 8, 6]       │
  │  → Diagnosis (conclusion, evidence, hypotheses)              │
  │  → stream `diagnosis` event                                  │
  │  STOPS — does NOT run RecommendationAgent                    │
  └──────────────────────────┬──────────────────────────────────┘
                             ▼
                  USER reads EvidencePanel, clicks "see recommendations →"
                  (browser stashed `diagnosis` in sessionStorage)
                             │
                             ▼
  ┌─ Request 3: GET /api/agent?insightId=X&step=recommend       │
  │            &diagnosis={...}                                  │
  │  route → parseDiagnosis (from URL param)                     │
  │  → RecommendationAgent.propose(anomaly, diagnosis) [ReAct, 6, 4]│
  │  → Recommendation[] (up to 3)                                │
  │  → stream each recommendation as NDJSON                      │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

The sequential pipeline is the agent-architecture equivalent of an ETL pipeline — same shape, same tradeoffs. The win is specialization: each stage has a narrower mandate, a narrower tool grant, smaller prompts, and you can swap models per stage (cheap model for the last stage, expensive for the hard one). This repo doesn't currently swap models — all three use `claude-sonnet-4-6` — but the structure would let you (RecommendationAgent's tighter budget would let it switch to haiku for cost without losing much quality).

The HTTP split is the unusual part of this repo's pipeline and the most senior-engineer-y choice. Most agent pipelines run end-to-end in one request and report the whole thing to the user at the end. This one explicitly stops between stage 2 and stage 3 so the human reviews the diagnosis. The architectural cost is real — the diagnosis has to round-trip through the browser — but the product cost of NOT doing this would be larger: an agent generating recommendations from a wrong diagnosis would mislead the user and waste tokens.

The pipeline doesn't preclude going multi-agent later. If the diagnostic agent's quality plateaus, the natural next step is replacing it with a planner+executor+synthesizer (see `../01-reasoning-patterns/04-plan-and-execute.md`) — a sub-pipeline inside stage 2. The outer pipeline stays sequential; one stage gets internal complexity. That's the right escalation path: nest specialization inside an existing stage rather than restructuring the outer pipeline.

## Interview defense

**Q: "Walk me through your multi-agent topology."**

A: Sequential pipeline — three agents, three stages, fixed order: monitoring → diagnostic → recommendation. Each stage is one full ReAct loop (8 turns, 6 tool calls for monitoring/diagnostic; 6 turns, 4 tool calls for recommendation since it mostly reasons from the upstream output). The supervisor is route code — `app/api/agent/route.ts` dispatches based on the URL `?step=` param. The pipeline is *split across HTTP requests* between stage 2 and stage 3 so the user reviews the diagnosis before recommendations run; the diagnosis round-trips through the browser's sessionStorage and a URL param to make the split work across Vercel's ephemeral serverless instances.

Diagram I'd sketch:

```
  /api/briefing          /api/agent?step=diagnose         /api/agent?step=recommend
       │                          │                              │
       ▼                          ▼                              ▼
  ┌─────────┐               ┌─────────┐                     ┌─────────┐
  │Monitor- │  Anomaly →    │Diagnos- │   Diagnosis →       │Recommen-│
  │ ing     │  (URL stash)  │ tic     │   (sessionStorage   │ dation  │
  │ (ReAct) │               │ (ReAct) │    + URL param)     │ (ReAct) │
  └─────────┘               └─────────┘                     └─────────┘
       │ stream                  │ stream                         │ stream
       └─── all output flows back as AgentEvent NDJSON ───────────┘
```

Anchor: "the split between stage 2 and stage 3 is the load-bearing UX choice. Without it, the user has no chance to catch a wrong diagnosis before recommendations are generated from it."

**Q: "Why split stage 2 and stage 3 across requests instead of one combined run?"**

A: Two reasons. First, product: the user reviews the diagnosis before recommendations are generated. If the diagnosis is wrong, generating recommendations from it wastes tokens AND misleads the user. The split forces a human-in-the-loop pause. Second, architectural: Vercel serverless instances are ephemeral — between requests we can't rely on in-memory state. Splitting forces the handoff to be serializable (the `Diagnosis` shape), which is good architecture-pressure: it keeps the agent outputs as plain data, not references to live objects. The combined run still exists (when `step == null`) for the demo-snapshot capture path — it's how we generate the committed snapshot the demo mode replays.

## See also

- [`01-when-not-to-go-multi-agent.md`](./01-when-not-to-go-multi-agent.md) — why this is the right minimal topology for this product
- [`02-supervisor-worker.md`](./02-supervisor-worker.md) — the supervisor is the route code that runs the pipeline
- [`08-shared-state-and-message-passing.md`](./08-shared-state-and-message-passing.md) — the diagnosis handoff is forced message-passing
- [`../06-orchestration-system-design-templates/02-agentic-support-system.md`](../06-orchestration-system-design-templates/02-agentic-support-system.md) — the standard architecture for this product shape

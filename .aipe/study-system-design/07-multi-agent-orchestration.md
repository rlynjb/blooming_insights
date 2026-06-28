# Multi-agent orchestration — sequential pipeline with an intent router

**Industry name:** sequential agent pipeline + intent router · Language-agnostic

## Zoom out, then zoom in

Five agents (monitoring, diagnostic, recommendation, query, intent), wired
in two distinct shapes. The investigation pipeline runs diagnostic →
recommendation in a fixed order (the decision is NOT made until after the
diagnosis). The query flow runs intent → (one of: diagnostic | recommendation |
query) — a router-then-specialist pattern. The monitoring scan runs once per
briefing, before either flow.

You know how a `useEffect` hook can chain effects — fetch, then derive,
then render — each step using the previous's output? Same shape here, but
each "step" is an agent: a model + a tool registry + a trace sink running a
loop until it produces a typed result. The pipeline shape decides what the
NEXT agent gets, not how each agent reasons.

```
  Zoom out — where multi-agent orchestration lives

  ┌─ Service layer ──────────────────────────────────────────────────────┐
  │                                                                       │
  │  /api/briefing                /api/agent                              │
  │  ────────────                 ──────────                              │
  │  MonitoringAgent.scan         Branch by params:                      │
  │   → anomalies                  → q only:   intent → one specialist   │
  │   → insights                   → insightId: diagnostic →             │
  │                                              recommendation           │
  │                                                                       │
  │  ★ ORCHESTRATION SHAPE — the route handler decides ★                 │ ← we are here
  │                                                                       │
  │   each agent is a thin wrapper over AptKit                            │
  │   (see 04-aptkit-primitive-boundary.md)                               │
  │                                                                       │
  └──────────────────────────────────────────────────────────────────────┘
```

This file is about the shape of the agent COMPOSITION. The shape of one
agent's internal loop is AptKit's job (see `04-aptkit-primitive-boundary.md`);
the shape of how agents combine into a product flow is the orchestration.

## Structure pass — layers, axis, seams

**Layers:** Route handler (orchestrator) → Agent wrapper → AptKit primitive
→ Model + tools.

**Axis (held constant): "what does the next agent receive?"** Trace it
across the pipeline.

```
  Axis: what does the next agent receive?

  ┌─ Monitoring scan ──────────────────────────────────────────┐
  │  inputs:  WorkspaceSchema, runnable categories              │
  │  output:  Anomaly[]   (no further agent runs in /api/briefing)
  └────────────────────────────────────────────────────────────┘

  ┌─ Investigation pipeline ───────────────────────────────────┐
  │  Diagnostic                                                 │
  │    inputs:  Anomaly, WorkspaceSchema, tools                 │
  │    output:  Diagnosis  ───────────►  hand to Recommendation │
  │                                                              │
  │  Recommendation                                              │
  │    inputs:  Anomaly, Diagnosis, WorkspaceSchema, tools      │
  │    output:  Recommendation[]                                 │
  └────────────────────────────────────────────────────────────┘

  ┌─ Query flow ───────────────────────────────────────────────┐
  │  Intent (haiku, no tools)                                   │
  │    inputs:  query string                                    │
  │    output:  Intent  ───────────►  selects ONE specialist    │
  │                                                              │
  │  QueryAgent (or another)                                     │
  │    inputs:  query, intent, WorkspaceSchema, tools           │
  │    output:  natural-language answer string                   │
  └────────────────────────────────────────────────────────────┘
```

**Seams (boundaries where the next-agent input flips):**

- **Diagnostic → Recommendation** — diagnosis carries forward;
  recommendation gets BOTH anomaly and diagnosis. The hand-off is
  load-bearing: see step 2 below + `08-client-stream-handoff.md` for
  the cross-instance variant.
- **Intent → specialist** — the intent classifier doesn't reason
  about the data, just the intent. The router decision is one model
  call, and a cheap model (haiku) at that.
- **Monitoring → nothing** — monitoring's output goes to state, not to
  another agent. The diagnostic agent later reads the anomaly back
  from state via `resolveAnomaly` (`app/api/agent/route.ts:35-60`).

## How it works

### Move 1 — the mental model

The shape is two distinct compositions over the same set of agents:

```
  Pattern A — sequential pipeline (the investigation flow)

   ┌────────────────┐   diagnosis   ┌──────────────────┐   recs
   │  Diagnostic    │ ────────────► │  Recommendation  │ ──────►
   │  agent         │               │  agent            │
   └────────────────┘               └──────────────────┘
        │
        ▼
     anomaly
     in


  Pattern B — router + specialist (the query flow)

                    ┌───── 'diagnostic' ───► DiagnosticAgent
                    │
   ┌──────────────┐ │
   │  Intent      │ ┼────── 'recommendation' ───► RecommendationAgent
   │  classifier  │ │
   │  (haiku)     │ │
   └──────────────┘ └───── 'query' ───► QueryAgent
        ▲
        │
     query


  Pattern C — one-shot (the monitoring flow)

   ┌─────────────────────────────────────────┐
   │  MonitoringAgent.scan(runnableCategories)│ ──► Anomaly[]
   │  iterates internally per category        │
   └─────────────────────────────────────────┘
```

Three shapes, one toolbox of agent wrappers. The shape isn't a property
of the agent — it's a property of the route handler that composes them.

### Move 2 — the step-by-step walkthrough

#### Step 1 — monitoring is a one-shot, internally batched

`MonitoringAgent.scan(hooks, runnableCategories)` runs the agent ONCE,
handing the model the full list of categories the workspace can answer.
AptKit's internal loop iterates per category — but from the orchestrator's
perspective, it's one call.

```typescript
// app/api/briefing/route.ts:260-281 (abridged)
step(`checking ${runnable.length} of 10 anomaly categories against this workspace…`);
const t_scan = performance.now();
const anomalies = await agent.scan({
  onToolCall:   (tc) => { send({ type: 'tool_call_start', ... });
                          step(describeToolCall(tc)); },
  onToolResult: (tc) => send({ type: 'tool_call_end', ..., result: trunc(tc.result), error: tc.error }),
  onText:       (t)  => { if (t.trim()) step(t.trim()); },
  signal:       req.signal,
}, runnable);
recordPhase('monitoring_scan', t_scan);
const insights = anomalies.map(anomalyToInsight);
putInsights(sid, insights, anomalies);
```

The hooks fire as the agent works; the trace appears in the UI in real
time. The route doesn't decide tool order or category order; the agent
does that internally, gated by the runnable list.

#### Step 2 — the investigation pipeline (diagnostic → recommendation)

The investigation route runs two agents in fixed order, with the
diagnosis handed to recommendation:

```typescript
// app/api/agent/route.ts:264-297 (abridged)
const inv = anomaly!;
let diagnosis: Diagnosis | null = null;

// STEP 2 (diagnose) or the combined run: run the diagnostic agent.
if (step === 'recommend') {
  diagnosis = parseDiagnosis(diagnosisParam);
  if (!diagnosis) throw new Error('no diagnosis was handed over — open the diagnosis step first');
} else {
  req.signal.throwIfAborted();
  stepFor('diagnostic', 'thought', `investigating "${inv.metric}" (${...})…`);
  const diagAgent = new DiagnosticAgent(anthropic, dataSource, schema, allTools, sid);
  const t_diag = performance.now();
  diagnosis = await diagAgent.investigate(inv, { ...hooksFor('diagnostic'), signal: req.signal });
  recordPhase('diagnostic_investigate', t_diag);
  send({ type: 'diagnosis', diagnosis });
}

// STEP 3 (recommend) or the combined run: run the recommendation agent.
if (step !== 'diagnose') {
  req.signal.throwIfAborted();
  stepFor('recommendation', 'thought', 'proposing actions based on the diagnosis…');
  const recAgent = new RecommendationAgent(anthropic, dataSource, schema, allTools, sid);
  const t_rec = performance.now();
  const recommendations = await recAgent.propose(inv, diagnosis!, { ...hooksFor('recommendation'), signal: req.signal });
  recordPhase('recommendation_propose', t_rec);
  for (const r of recommendations) send({ type: 'recommendation', recommendation: r });
}
```

Three branches keyed by the `step` parameter:

```
  ?step=diagnose         ?step=recommend             ?step=null (legacy combined)
  ──────────────         ───────────────             ────────────────────────────
  diagnose only          recommend only              diagnose then recommend
  output: diagnosis      input: ?diagnosis=...       output: diagnosis + recs
  client stashes it      from sessionStorage          cached on disk for replay
  → step 3 reuses it     (see 08-client-stream-handoff)
```

**Why split into two requests?** Vercel's per-request 300s ceiling
(`maxDuration = 300`). A combined diagnose+recommend run can take
~100-115s. Two requests buy double the budget — if step 2 is fast and
step 3 hits a retry storm, step 3 still has its own 300s budget. Also:
the UI navigates between the two steps as separate pages
(`app/investigate/[id]/page.tsx` vs `.../recommend/page.tsx`), so the
HTTP request boundary aligns with the navigation boundary.

```
  Layers-and-hops — the investigation split across requests

  ┌─ Browser ──────┐                       ┌─ Route ─────────────────┐
  │ click card     │                       │                          │
  │ navigate to    │                       │                          │
  │ /investigate/X │                       │                          │
  └───────┬────────┘                       │                          │
          │ GET /api/agent?insightId=X     │                          │
          │ &step=diagnose                 │                          │
          └────────────────────────────►   │ DiagnosticAgent          │
                                           │ → diagnosis (~30-60s)    │
          ◄────── NDJSON stream            │ → send 'diagnosis' event │
          stash diagnosis in               │ → send 'done'             │
          sessionStorage[bi:diag:X]        │                          │
                                           └──────────────────────────┘

  ┌─ Browser ──────┐                       ┌─ Route ─────────────────┐
  │ click "see     │                       │                          │
  │ recommendations"                       │                          │
  │ navigate to    │                       │                          │
  │ .../recommend  │                       │                          │
  └───────┬────────┘                       │                          │
          │ GET /api/agent?insightId=X     │                          │
          │ &step=recommend                │                          │
          │ &diagnosis=<sessionStorage val>│                          │
          └────────────────────────────►   │ RecommendationAgent      │
                                           │ → recommendations (~30-60s)
          ◄────── NDJSON stream            │ → send 'recommendation' × N
                                           │ → send 'done'             │
                                           └──────────────────────────┘
```

#### Step 3 — the query flow (intent router + specialist)

The free-form query path uses a router:

```typescript
// app/api/agent/route.ts:247-260 (abridged)
if (q && !insightId) {
  req.signal.throwIfAborted();
  const t_intent = performance.now();
  const intent = await classifyIntent(anthropic, q, sid, req.signal);
  recordPhase('intent_classify', t_intent);
  stepFor('coordinator', 'thought', `interpreting your question as a ${intent} query…`);
  const queryAgent = new QueryAgent(anthropic, dataSource, schema, allTools, sid);
  const t_query = performance.now();
  const answer = await queryAgent.answer(q, intent, { ...hooksFor('coordinator'), signal: req.signal });
  recordPhase('query_answer', t_query);
  stepFor('coordinator', 'conclusion', answer);
  send({ type: 'done' });
  return;
}
```

`classifyIntent` uses `claude-haiku-4-5-20251001` (cheap, fast, no
tools — `lib/agents/intent.ts:16`). The intent maps to one of three
specialists; today only `QueryAgent` is wired downstream (the
DiagnosticAgent and RecommendationAgent specialists are dispatched
through the `?insightId=` path, not the `?q=` path). The intent value
itself is passed into `QueryAgent.answer(q, intent, hooks)` so the
QueryAgent can tune its prompt per intent.

```
  Pattern — router + specialist with model-size selection

  query string
       │
       ▼
   ┌──────────────────────────┐
   │ classifyIntent           │   ← claude-haiku-4-5 (cheap, ~100ms)
   │ system: "classify this"  │     no tools, just a label out
   │ → 'diagnostic' |          │
   │   'recommendation' |      │
   │   'query'                 │
   └──────────┬───────────────┘
              │
              ▼
   ┌──────────────────────────┐
   │ QueryAgent.answer(       │   ← claude-sonnet-4-6 (smart, with tools)
   │   q, intent, hooks)       │
   │ runs full agent loop      │
   │ with intent-tuned prompt  │
   └──────────────────────────┘
```

#### Step 4 — what's INSIDE one agent's run

Inside any of these calls, the AptKit primitive runs the standard
agent loop: model → tool_use → tool_result → model → ... until the
model emits a final answer (or hits its iteration budget). The
wrapper's job (see `04-aptkit-primitive-boundary.md`) is to construct
the three adapters and call AptKit's run method; the wrapper does NOT
own the loop.

This is the key separation: the route handler owns the SHAPE OF
COMPOSITION (pipeline, router, one-shot); AptKit owns the SHAPE OF
ONE AGENT'S REASONING (the model + tool loop).

```
  Two layers of "what happens next"

  ┌─ Route handler ────────────────────────────────┐
  │  decides which agent runs next                  │   CODE decides phases
  │  (intent → specialist; diagnostic → recommendation)
  └──────────────┬─────────────────────────────────┘
                 │
  ┌─ AptKit primitive (one agent run) ─────────────┐
  │  decides which tool to call next                │   LLM decides per turn
  │  (model picks from the tool registry)
  └────────────────────────────────────────────────┘
```

#### Step 5 — the hooks-as-wiring pattern

Every agent call takes a `hooks` object that translates AptKit's
internal events into NDJSON events. The `hooksFor(agent)` helper
(`app/api/agent/route.ts:196-210`) builds them per-agent so the trace
events carry the right `agent` tag.

```typescript
const hooksFor = (agent: AgentName) => ({
  onText: (t: string) => {
    if (t.trim()) stepFor(agent, 'thought', t);
  },
  onToolCall:   (tc: ToolCall) => send({ type: 'tool_call_start', toolName: tc.toolName, agent }),
  onToolResult: (tc: ToolCall) =>
    send({ type: 'tool_call_end', toolName: tc.toolName, agent,
           durationMs: tc.durationMs ?? 0, result: trunc(tc.result), error: tc.error }),
});
```

The hooks are how the orchestration shows up on the wire — each
agent's tool calls and reasoning steps are interleaved in the NDJSON
stream, tagged with the agent name, so the UI can color them
differently in the trace panel. Without the hooks, the stream would
emit `'done'` and nothing in between; the orchestration would be
invisible to the user.

### Move 2.5 — sequential, not parallel

`Promise.all` is not used anywhere in this pipeline. The reason isn't
that the agents *can't* run in parallel — it's that the downstream
data source (Bloomreach) rate-limits per user globally at ~1 req/s.
Running diagnostic and recommendation in parallel against the same
session would just generate back-to-back 429s.

The synthetic adapter could handle parallel calls trivially, but
running the same agents differently per mode would be its own
maintenance burden. Sequential is the right call across the board.

The one exception: monitoring scans **could** run categories in
parallel if AptKit supported it. Today AptKit's monitoring agent runs
sequentially internally; if it gained a parallel mode, the live
Bloomreach path still wouldn't benefit, but the synthetic path would.

### Move 3 — the principle

**Orchestration shape ≠ agent shape.** Treat them as independent
decisions. The agent shape (model + tool loop) is reusable across
products; the orchestration shape (pipeline / router / fan-out) is
product-specific.

The general principle: when composing intelligent components (agents,
services, plugins), separate the WIRING from the INNER LOOPS. The
wiring is what your product knows; the inner loops are what the
library or vendor knows. This codebase shows it clearly — the
`runAgentLoop` body is now in `@aptkit/core` while the
diagnostic → recommendation order is in `/api/agent/route.ts`.
Either could change without touching the other.

You'll see the same pattern in workflow engines (Airflow DAGs define
wiring, operators define inner loops), in build systems (Make/Bazel
rules define wiring, commands define inner loops), in data pipelines
(Spark plans define wiring, UDFs define inner loops). The reusable
primitive is "let one team own the inner loop, let another team own
the composition."

## Primary diagram

```
  Multi-agent orchestration — all three shapes in one frame

  ┌─ /api/briefing ──────────────────────────────────────────────────────────┐
  │  schema bootstrap → coverage gate → listTools                             │
  │                                                                            │
  │  ┌─ MonitoringAgent.scan(runnable) ──────────────────────────────────┐    │
  │  │  AptKit internal loop:                                            │    │
  │  │   for each category:                                              │    │
  │  │     model → tool_use → tool_result → ... → emit Anomaly           │    │
  │  └───────────────────────────────────────────────────────────────────┘    │
  │  anomalies → insights → putInsights(sid, ...) → stream                    │
  └──────────────────────────────────────────────────────────────────────────┘

  ┌─ /api/agent (insightId, step) ───────────────────────────────────────────┐
  │  schema bootstrap → listTools                                             │
  │                                                                            │
  │  branch by step:                                                          │
  │                                                                            │
  │  ┌─ step='diagnose' or null ────┐    ┌─ step='recommend' ──────────────┐  │
  │  │ DiagnosticAgent.investigate(   │   │ parseDiagnosis(?diagnosis=...)  │  │
  │  │   anomaly, hooks                │   │ RecommendationAgent.propose(   │  │
  │  │ ) → Diagnosis                   │   │   anomaly, diagnosis, hooks    │  │
  │  │ send 'diagnosis'                │   │ ) → Recommendation[]           │  │
  │  └────────────┬───────────────────┘   │ send 'recommendation' × N      │  │
  │               │                       └──────────────────┬──────────────┘  │
  │               │ if step==null,                           │                  │
  │               │ fall through to recommend                │                  │
  │               ▼                                          │                  │
  │  ┌────────────────────────────────────────────────────┐  │                  │
  │  │ RecommendationAgent.propose(anomaly, diagnosis)    │  │                  │
  │  │ → Recommendation[]                                  │  │                  │
  │  └────────────────────────────────────────────────────┘  │                  │
  │                                                                            │
  │  if step == null: saveInvestigation(insightId, collected)                 │
  └──────────────────────────────────────────────────────────────────────────┘

  ┌─ /api/agent (q only) ────────────────────────────────────────────────────┐
  │  schema bootstrap → listTools                                             │
  │                                                                            │
  │  ┌─ classifyIntent(q) [haiku] ───┐  ┌─ QueryAgent.answer(q, intent) ──┐   │
  │  │ → 'diagnostic' | 'rec' |       │  │ AptKit internal loop runs       │   │
  │  │   'query' | 'forecast'         │  │ tools tuned to intent           │   │
  │  └────────────────────────────────┘  │ → natural language answer       │   │
  │            │                          └─────────────────────────────────┘   │
  │            └─────► passed into QueryAgent ► → answer                       │
  └──────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Where this pattern comes from.** Two parents:

  → **Workflow engines** (Airflow, Temporal, Step Functions) gave us
    the "fixed-DAG orchestration" frame — the route handler is just
    a tiny static DAG, hand-coded in TypeScript.
  → **Mixture-of-experts / routing** (Switch Transformer, LangChain
    routers, OpenAI Assistants' routing) gave us the
    intent-classifier-then-specialist shape. The cheaper-model-for-
    routing pattern is specifically the modern AI-engineer move:
    don't burn Sonnet tokens on a routing decision when Haiku
    classifies in 100ms for a fraction of the cost.

The combination — sequential pipeline as the default flow, router as
the entry-point for free-form input — is the pragmatic working
AI-engineer shape for product agent systems. Pure router flows
(LangChain AgentExecutor with auto-selection) are flexible but hard
to reason about; pure pipelines are easy to reason about but inflexible
for free-form input. The hybrid you see here is the working middle.

**The deeper principle.** Separation of competence. Each agent has a
narrow competence (monitor, diagnose, recommend, answer-free-form);
the orchestration decides which competence applies. Agents don't call
each other directly — they don't even know about each other. The
route handler is the only place that knows the diagnostic-recommendation
relationship.

This separation makes each agent independently testable
(`test/agents/diagnostic.test.ts`, `test/agents/recommendation.test.ts`),
and lets the migration to AptKit replace each agent independently
without touching the orchestration.

**Where it breaks.**

- **No cross-agent retry.** If diagnostic returns a malformed
  diagnosis, recommendation gets garbage in and produces garbage out.
  We don't validate the diagnosis between the two agents; AptKit's
  parser does basic structural checks, but there's no "if the
  diagnosis is poor quality, re-run diagnostic with a different
  prompt."
- **Sequential makes the per-investigation latency a sum.** Today's
  ~100-115s combined run is diagnostic (~50s) + recommendation
  (~50s) + bootstrap + listTools. If the alpha provider ever
  supports parallelism we could halve this — but we'd lose the
  step-by-step UI navigation.
- **Intent classifier is the single point of routing failure.** If
  haiku misclassifies a query, the wrong specialist runs. There's no
  re-route based on the specialist's output. Today this is
  acceptable because the query flow is the smaller surface; for a
  production routing setup you'd want a fallback path.
- **The route handler is the orchestration source-of-truth.** If we
  ever want runtime-configurable orchestration (admin chooses which
  agents run in which order), that knowledge is hard-coded in the
  route. A declarative pipeline definition would make it
  data-driven; today it's code-driven.

**What to explore next.**

- `04-aptkit-primitive-boundary.md` — what's INSIDE each agent run
- `08-client-stream-handoff.md` — how the diagnostic → recommendation
  hand-off works across HTTP requests
- `01-request-flow.md` — the pipeline wrapper around the orchestration
- `study-ai-engineering` — agent design patterns: router, ReAct,
  tool-use loops, evals

## Interview defense

#### Q: "Why split diagnostic and recommendation into two HTTP requests?"

Three reasons. **One**: Vercel's 300s per-request ceiling. A combined
run is ~100-115s; splitting buys double the budget so a slow
recommendation doesn't kill a successful diagnosis. **Two**: the UI
navigates between the two as separate pages (`/investigate/X` and
`/investigate/X/recommend`), so the HTTP boundary aligns naturally
with the navigation boundary. **Three**: it forces the diagnosis
hand-off into the open. The client must stash the diagnosis in
sessionStorage and pass it back via `?diagnosis=...`; we can't rely on
server-side memory because Vercel may route step 3 to a different warm
instance than step 2.

```
  Two requests, one logical pipeline

  GET /api/agent?...&step=diagnose
       → runs DiagnosticAgent
       → emits 'diagnosis' on the wire
       → client stashes it

  GET /api/agent?...&step=recommend&diagnosis=<from sessionStorage>
       → runs RecommendationAgent with the handed-over diagnosis
       → emits 'recommendation' × N
```

**Surface:** "budget + navigation + cross-instance hand-off."
**Probe:** if pressed — name `useInvestigation.ts:74-85` (the diag
handoff stash) and `app/api/agent/route.ts:269` (the parse on the
server side).

#### Q: "Walk me through your free-form query flow."

`classifyIntent` runs first with a cheap model (haiku) — no tools,
just a classification. The intent value (`diagnostic` | `recommendation`
| `query` | etc.) drives which specialist agent runs next; today only
`QueryAgent` is wired through the `?q=` path, but the intent is passed
into it so the QueryAgent can tune its prompt and tool selection per
intent.

The router-then-specialist pattern is standard mixture-of-experts:
spend cheap tokens on the routing decision, expensive tokens on the
actual reasoning. Haiku at ~$0.25 per million input tokens versus
Sonnet at ~$3 — the routing call is essentially free at our volumes.

```
  Router pattern with model-size selection

  query string ──► haiku (classifier) ──► intent label
                                              │
                                              ▼
                                         sonnet (specialist)
                                         with tools
                                         ──► natural-language answer
```

**Surface:** "cheap router, smart specialist."
**Probe:** if pressed — name `lib/agents/intent.ts:16` (CLASSIFIER_MODEL)
and `lib/agents/base.ts:7` (AGENT_MODEL) as the proof that the
classifier and specialist use different models deliberately.

#### Q: "What's the load-bearing part of the orchestration — what breaks if you remove it?"

The diagnosis hand-off (`/api/agent` `?step=recommend&diagnosis=...`
path, plus `parseDiagnosis` at line 84-95 and the client-side stash in
`useInvestigation.ts:74-85`). It's the kernel: the recommendation
agent's prompt is built around `(anomaly, diagnosis)` — without the
diagnosis, the agent has no chance to produce a quality recommendation
(it'd be reasoning about an anomaly with no investigated cause).

Other load-bearing parts:

  → `MonitoringAgent.scan(runnable)` taking the runnable list — without
    the gate, monitoring scans all 10 categories regardless of coverage,
    burning ~2x the EQL budget on categories the workspace can't answer
  → the `hooks` object per agent — without it, the UI sees no progress
    during a 50-second agent run
  → `req.signal.throwIfAborted()` between agents — without it,
    cancelling step 2 mid-run still proceeds into step 3

Optional hardening:

  → the per-phase `recordPhase()` calls — observability, not
    correctness
  → the `step` parameter branching — the combined run is the legacy
    capture path; production uses the split

#### Q: "Could you parallelize diagnostic and recommendation?"

Not against the live Bloomreach data source — it rate-limits per user
globally, so parallel agents would just generate back-to-back 429s.
Against the synthetic adapter (in-process), yes — and AptKit's API
would support it via `Promise.all`. The reason we don't bother: the
maintenance burden of two execution shapes (parallel for synthetic,
sequential for live) exceeds the latency win on a dev backend. The
live path is the canonical product surface; the synthetic adapter is
for demos and CI, where the latency difference doesn't matter.

A real production scenario would be: a non-rate-limited provider, a
real desire to ship a "we run two agents in parallel and merge their
outputs" feature. We don't have that. The Bloomreach constraint is the
binding one, and the rest of the architecture is shaped around it.

## See also

- `00-overview.md` — where this sits in the whole system
- `04-aptkit-primitive-boundary.md` — what runs INSIDE each agent
- `08-client-stream-handoff.md` — the cross-request diagnosis hand-off
- `09-schema-gated-coverage.md` — the gate that monitoring obeys
- `01-request-flow.md` — the route handler that owns this orchestration
- `study-ai-engineering` — agent patterns (ReAct, router, mixture of experts)

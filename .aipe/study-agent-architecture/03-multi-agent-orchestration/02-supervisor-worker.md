# Supervisor-worker (deterministic supervisor variant)

_Industry standard._

## Zoom out, then zoom in

The most common and most useful multi-agent topology. In this repo the supervisor is *deterministic* — written in TypeScript in `app/api/agent/route.ts` — not an LLM. That variant is Anthropic's recommended production shape.

```
  Zoom out — the deterministic supervisor in this repo

  ┌─ UI ────────────────────────────────────────────────────┐
  │  three product phases (feed / investigate / recommend)  │
  └───────────────────────────┬─────────────────────────────┘
                              │
  ┌─ ★ SUPERVISOR (route.ts) ★ ────────────────────────────┐
  │  code decomposes: which agent, in which order          │
  │  monitors: NDJSON stream to UI (stepFor per phase)     │
  │  synthesizes: passes diagnosis from step 2 to step 3   │
  └───────┬──────────────┬──────────────┬──────────────────┘
          ▼              ▼              ▼
     ┌────────┐     ┌────────┐    ┌────────┐
     │Monitor │     │Diagnose│    │Recomm. │
     └────────┘     └────────┘    └────────┘
       10-cat        evidence      actions
       scan          gathering
```

Zoom in: this is a manager component delegating to child components. The supervisor's job is routing + orchestration + synthesis, all of which are written by hand for predictability.

## Structure pass

**Layers:** supervisor (decompose + route + synthesize) · workers (specialists) · shared state (workspace schema) · message passing (diagnosis handed to recommend).
**Axis:** *who decides which worker runs when?*
**Seam:** the supervisor→worker boundary. In this repo it's the `new DiagnosticAgent(...)` construction — deterministic supervisor, autonomous worker.

```
  Deterministic supervisor vs LLM supervisor

  Deterministic (this repo):        LLM supervisor (alternative):
  supervisor = TypeScript in         supervisor = another Sonnet loop
  route.ts. Code picks the           that reads the task and calls
  next worker in a chain.            worker agents as tools.

  cost: 0 model calls per hop        cost: 1 model call per routing
  latency: 0                         latency: 500-2000ms per hop
  predictability: 100%               predictability: 90-95%
  debugging: trivial                 debugging: log the LLM decisions
```

## How it works

### Move 1 — the mental model

You've built a React `PageLayout` that composes header + main + sidebar components — each child owns its region, the parent decides the composition. Supervisor-worker is that shape at the agent layer: the parent chooses which children run, in which order; each child owns its specialization.

```
  Pattern: supervisor-worker

  ┌──────────────────────────────────┐
  │       Supervisor                  │
  │  1. decompose the task            │
  │  2. delegate to workers            │
  │  3. synthesize worker outputs      │
  └──┬───────────┬───────────┬────────┘
     ▼           ▼           ▼
  ┌─────┐    ┌─────┐    ┌─────┐
  │work1│    │work2│    │work3│    ← each specialist
  └──┬──┘    └──┬──┘    └──┬──┘
     └──────────┼──────────┘
                ▼
       supervisor synthesizes
```

### Move 2 — the walkthrough

**The supervisor — `app/api/agent/route.ts:229-297`.** All in TypeScript. No LLM decides the flow.

```ts
// route.ts:229-232 — the routing decision
const leadAgent: AgentName =
  q && !insightId ? 'coordinator' : step === 'recommend' ? 'recommendation' : 'diagnostic';
stepFor(leadAgent, 'thought', 'reading the workspace schema…');

// route.ts:266-297 — the sequential worker dispatch
if (step === 'recommend') {
  diagnosis = parseDiagnosis(diagnosisParam);
} else {
  const diagAgent = new DiagnosticAgent(anthropic, dataSource, schema, allTools, sid);
  diagnosis = await diagAgent.investigate(inv, { ...hooksFor('diagnostic'), signal: req.signal });
  send({ type: 'diagnosis', diagnosis });
}
if (step !== 'diagnose') {
  const recAgent = new RecommendationAgent(anthropic, dataSource, schema, allTools, sid);
  const recommendations = await recAgent.propose(inv, diagnosis!, { ...hooksFor('recommendation'), signal: req.signal });
  for (const r of recommendations) send({ type: 'recommendation', recommendation: r });
}
```

Line-by-line:

- **Routing** — one TypeScript ternary picks `leadAgent`. The URL param `step` is the routing input. Cost: zero. Reliability: 100%.
- **Decomposition** — the whole flow "diagnose then recommend" is written as `if / else`. No LLM decomposes anything; the product decided the decomposition upfront (three product phases → three workers).
- **Delegation** — `new DiagnosticAgent(...)` + `await agent.investigate(...)`. The `await` hides ~50s of inner ReAct loop. The supervisor doesn't watch the loop; it just waits for the return.
- **Synthesis** — the supervisor's synthesis is *state handoff*. The `diagnosis` result from step 2 is passed via URL param (`diagnosisParam` in `parseDiagnosis`) or via the returned value to step 3. No aggregation logic — the workers produce structured artifacts, the supervisor just plumbs them.

**The trace channel — how the supervisor "watches" the workers.** `route.ts:196-210`:

```ts
const hooksFor = (agent: AgentName) => ({
  onText: (t: string) => { if (t.trim()) stepFor(agent, 'thought', t); },
  onToolCall: (tc: ToolCall) => send({ type: 'tool_call_start', toolName: tc.toolName, agent }),
  onToolResult: (tc: ToolCall) => send({...}),
});
```

Line-by-line: each worker gets a hooks object that forwards its trace events (text steps, tool calls) to the shared NDJSON channel. That's how the supervisor surfaces worker progress to the UI without polling — the workers emit events, the stream forwards them, the browser reads them.

**Tools-style vs handoff-style delegation.** This is a *tools-style* topology: the supervisor stays in control across the whole request. It could be *handoff-style* — the diagnostic worker could invoke recommendation directly at the end of its loop — but that would move control transfer inside the worker, making the sequence harder to trace. Tools-style keeps the topology debuggable.

```
  Layers-and-hops — one investigation, supervisor's view

  ┌─ UI (browser) ──────┐  GET /api/agent?step=diagnose      ┌─ route.ts ──────┐
  │                     │ ───────────────────────────────►   │  supervisor     │
  │  StatusLog reads    │  NDJSON stream of events ◄─────── │                 │
  │  NDJSON             │                                    └────┬────────────┘
  └─────────────────────┘                                         │ new DiagnosticAgent
                                                                   ▼
                                                          ┌─ Diagnostic worker ┐
                                                          │  runAgentLoop      │
                                                          │  ~5 turns          │
                                                          └─────────┬──────────┘
                                                                    │ returns Diagnosis
                                                                    ▼
                                                          ┌─ route.ts sends    ┐
                                                          │  diagnosis event   │
                                                          │  onto NDJSON       │
                                                          └────────────────────┘
```

### Move 3 — the principle

Supervisor-worker with a deterministic supervisor is the recommended production shape when the workflow is knowable. Push the supervisor into code (predictable, cheap, debuggable). Push autonomy into the workers where it's genuinely needed (analytical exploration, etc.). LLM supervisors buy flexibility at the cost of predictability — reserve them for cases where the sequence of workers really can't be enumerated.

## Primary diagram

```
  Recap — the deterministic supervisor topology

  ┌─ /api/agent (SUPERVISOR: TypeScript) ────────────────────────┐
  │  const leadAgent = <route based on URL params>               │
  │                                                              │
  │  step === 'diagnose':                                        │
  │     new DiagnosticAgent(...).investigate(anomaly)            │
  │            │                                                 │
  │            ▼ (returns Diagnosis)                             │
  │     send({ type: 'diagnosis', diagnosis })                   │
  │                                                              │
  │  step === 'recommend':                                       │
  │     new RecommendationAgent(...).propose(anomaly, diagnosis) │
  │            │                                                 │
  │            ▼ (returns Recommendation[])                      │
  │     send({ type: 'recommendation', recommendation: r })      │
  │                                                              │
  │  Trace channel: hooksFor(agent) forwards worker events        │
  │  to the NDJSON stream for the UI                             │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

Supervisor-worker was named cleanly in Anthropic's "Building Effective Agents" (2024) as the primary orchestration workflow. The two flavors — deterministic supervisor (code) vs LLM supervisor — were the article's key contribution. The recommendation: default to deterministic; escalate to LLM supervisor only when the sequence of workers genuinely can't be enumerated (research-agent shape from Section F).

Blooming's version is the deterministic variant with a small LLM router at one point (`classifyIntent` for query-flow). That's Anthropic's "cascade" pattern: code where predictable, LLM at the specific sub-decision where flexibility matters. It's a lot cheaper than a full LLM supervisor (one Haiku call vs a Sonnet loop per hop) and 95% as flexible.

## Interview defense

**Q: Is this a supervisor-worker system? Who's the supervisor?**
A: Yes — and the supervisor is TypeScript, not an LLM. `app/api/agent/route.ts` decides which worker runs based on URL params, awaits each worker's structured output, plumbs artifacts between them, and streams the combined trace to the UI. Only one LLM-driven routing decision exists — `classifyIntent` for the query flow — and it's Haiku, not Sonnet. Deterministic supervisor is Anthropic's recommended production shape and it saves ~20% cost + ~30% latency vs an LLM supervisor for a workflow this predictable.

Diagram: the supervisor-worker topology with the "TypeScript" callout on the supervisor.
Anchor: `app/api/agent/route.ts:229-297`.

**Q: Tools-style or handoff-style delegation?**
A: Tools-style. The supervisor stays in control across the entire request — each worker returns its result to the supervisor, which then decides what to do next. Handoff would let the diagnostic worker invoke recommendation directly at the end of its loop, but that would hide the transition inside the worker and make debugging harder. Tools-style keeps the topology inspectable: every worker transition is a top-level `await` in route.ts.

Diagram: the two flavors side-by-side, with arrows showing where control lives at each step.
Anchor: same `route.ts:266-297`.

## See also

- `01-when-not-to-go-multi-agent.md` — the gate this topology passes.
- `03-sequential-pipeline.md` — the chain shape between diagnose and recommend.
- `06-swarm-handoff.md` — the alternative (rejected here).
- `08-shared-state-and-message-passing.md` — how the supervisor plumbs data between workers.
- `06-orchestration-system-design-templates/01-multi-agent-research-assistant.md` — where LLM supervisor DOES earn its keep.

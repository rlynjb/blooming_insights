# Refactor: Phase-timing observability on /api/briefing and /api/agent

## What to refactor

- `app/api/briefing/route.ts:187-246` — the streaming `start(controller)` handler. Major phases: `bootstrapSchema` (`:189`), coverage gate (`:202-213`), `listTools` (`:214-217`), `MonitoringAgent.scan` (`:223-240`), `putInsights` (`:243`).
- `app/api/agent/route.ts:170-264` — the streaming `start(controller)` handler. Major phases: `bootstrapSchema` (`:202`), `listTools` (`:203-206`), `classifyIntent` + `QueryAgent.answer` (`:211-217`) for the query flow, or `DiagnosticAgent.investigate` (`:237-239`) and `RecommendationAgent.propose` (`:246-248`) for the investigation flow.

## Why

The 300s Vercel Pro budget is a hard ceiling that hides which phase is responsible when the request approaches it (cleanup-2026-06-02 fix-now #6, `study-system-design/audit.md` Top-3 #2). The day a request hits 300s in production, the only signals are: NDJSON events that say "tool A took 12s, tool B took 18s, …" (the *per-call* layer) and the wall-clock total (the *aggregate* layer). The *per-phase* layer in between — schema bootstrap vs coverage gate vs monitoring loop vs synthesis — is missing, and it's the layer that tells you *which subsystem* ate the budget.

Severity: high (it's the only signal that survives an incident; without it the first 300s timeout in production is a blind investigation). Effort: ~20 LOC across two routes. No NDJSON wire change — phase timings are server-side `console.log` only.

## Target structure

Inside each `try` block, sandwich each phase with a `performance.now()` pair:

```
const t0 = performance.now();
const phases: Array<{ phase: string; durationMs: number }> = [];
function recordPhase(phase: string, started: number) {
  phases.push({ phase, durationMs: Math.round(performance.now() - started) });
}

// per phase:
const t_schema = performance.now();
const schema = await bootstrapSchema(mcp);
recordPhase('schema_bootstrap', t_schema);

// …other phases…

// on done (right before send({ type: 'done' })):
console.log(JSON.stringify({
  route: '/api/briefing',
  sessionId,
  totalMs: Math.round(performance.now() - t0),
  phases,
}));
```

Phase names that matter most to record:
- `schema_bootstrap`, `coverage_gate`, `list_tools`, `monitoring_scan` for `/api/briefing`
- `schema_bootstrap`, `list_tools`, `intent_classify`+`query_answer` (query flow) OR `diagnostic_investigate`, `recommendation_propose` (investigation flow) for `/api/agent`

Match the `console.log` shape across routes so a single Vercel log filter (e.g. `phases.phase = "schema_bootstrap"`) reads across both routes — the schema bootstrap is the same MCP-call hot path on both, and seeing one number per route is the signal.

Behaviour-preserving claim: `performance.now()` is a synchronous read; phase timings live in a local array; the final `console.log` runs once per request before `send({ type: 'done' })`. Zero effect on the NDJSON stream the UI consumes, zero effect on the response shape.

## Must not change

<!-- LEAVE BLANK — the user fills via /aipe:refactor in a separate session -->

## Must not introduce

<!-- LEAVE BLANK — the user fills via /aipe:refactor in a separate session -->

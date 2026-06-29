# LLM observability

*Industry standard — traces · spans · replay*

## Zoom out — where this concept lives

Observability is what evals are NOT. Evals tell you "does the agent produce useful outputs?" Observability tells you "what actually happened on this specific call?" This codebase has three observability surfaces shipped today: per-call `response.usage` logs from the adapter, per-phase wall-clock timings from the route, and the NDJSON trace events streamed to the UI's `StatusLog`. No vendor (Langfuse, LangSmith, Phoenix, Helicone) — just `console.log` + Vercel log queries.

```
  Zoom out — three observability surfaces

  ┌─ Per-call (Anthropic SDK calls) ────────────────────────┐
  │  console.log { site, sessionId, usage }                 │
  │  emitted from AnthropicModelProviderAdapter.complete()  │
  │  filter: site = 'agents/monitoring:aptkit-model'        │
  └─────────────────────────────────────────────────────────┘
  ┌─ Per-phase (route wall-clock) ──────────────────────────┐
  │  console.log { route, sessionId, mode, totalMs, phases, │
  │                aborted }                                │
  │  emitted in finally{} of each NDJSON route              │
  │  filter: phases.phase = 'diagnostic_investigate'        │
  └─────────────────────────────────────────────────────────┘
  ┌─ ★ Live trace (NDJSON to UI) ★ ─────────────────────────┐ ← we are here
  │  AgentEvent stream — reasoning_step, tool_call_*,       │
  │  insight, diagnosis, recommendation, done, error        │
  │  rendered in StatusLog / ReasoningTrace                 │
  └─────────────────────────────────────────────────────────┘
```

**Zoom in.** Three altitudes: token-level (usage), phase-level (timings), event-level (trace). All shipped today. No vendor — log filters are the dashboard.

## Structure pass — layers · axes · seams

**Layers:** Anthropic call → adapter → agent loop → route → UI.

**Axis: at what altitude does each surface measure?**
  → Per-call usage: per `messages.create()` call (token-level).
  → Per-phase timings: per agent invocation + per route phase (phase-level).
  → Live trace: per loop iteration (event-level).

**Seam:** each `console.log` site. Three sites, three filter prefixes (`site = ...`, `route = ...`, NDJSON content directly).

## How it works

### Move 1 — the mental model

You know how `console.time/timeEnd` lets you measure a code path's wall-clock without instrumenting fancy telemetry? This codebase scales that up: structured `console.log` with consistent shapes, filtered through Vercel's log query.

```
  Three surfaces, three altitudes

  ┌─ token altitude ─ per LLM call ─────────────────────────┐
  │  emitter: aptkit-adapters.ts:55-60                      │
  │  shape:   { site, sessionId, usage }                    │
  │  use:     per-agent token volume, per-day cost           │
  └─────────────────────────────────────────────────────────┘
  ┌─ phase altitude ─ per route ─────────────────────────────┐
  │  emitter: route.ts finally{} block                       │
  │  shape:   { route, sessionId, mode, totalMs, phases[] } │
  │  use:     where did the 300s budget go? which phase     │
  │           is slow? did the route complete?              │
  └─────────────────────────────────────────────────────────┘
  ┌─ event altitude ─ per loop iteration ───────────────────┐
  │  emitter: NDJSON wire (AgentEvent encoder)              │
  │  shape:   per-event variant types                       │
  │  use:     live UI trace; debug agent reasoning step by  │
  │           step                                          │
  └─────────────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Part 1 — per-call usage log.**

From `lib/agents/aptkit-adapters.ts:55-60`:

```typescript
console.log(JSON.stringify({
  site: this.logSite,                  // "agents/monitoring:aptkit-model"
  sessionId: this.sessionId,
  usage: response.usage,                // { input_tokens, output_tokens, cache_read_input_tokens? }
}));
```

Emitted on every `complete()` call. Per-agent `site` field comes from the adapter constructor (`agents/${agent}:aptkit-model`). The intent classifier has its own `site` (`'agents/intent:classifyIntent'`).

Vercel log filter examples:
  → `site = "agents/monitoring:aptkit-model"` — all monitoring agent calls
  → `site CONTAINS ":aptkit-model"` — all agent calls (any agent)
  → `site = "agents/intent:classifyIntent"` — all intent classifications

Per-day cost = sum `input_tokens` × $3/1M + sum `output_tokens` × $15/1M.

**Part 2 — per-phase timings log.**

From `app/api/briefing/route.ts:307-316`:

```typescript
console.log(JSON.stringify({
  route: '/api/briefing',
  sessionId: sid,
  mode,
  totalMs: Math.round(performance.now() - t0),
  phases,
  aborted: req.signal.aborted,
}));
```

Where `phases` is an array of `{ phase, durationMs }` built up during the route:

```typescript
const phases: Array<{ phase: string; durationMs: number }> = [];
const recordPhase = (phase: string, started: number) => {
  phases.push({ phase, durationMs: Math.round(performance.now() - started) });
};
```

Phase names are stable across briefing + agent routes (`'schema_bootstrap'`, `'list_tools'`, `'coverage_gate'`, `'monitoring_scan'`, `'diagnostic_investigate'`, `'recommendation_propose'`, `'intent_classify'`, `'query_answer'`).

Emitted in the `finally` block so the summary fires even on errors. Critical for the 300s-budget incident path: when a route times out at 300s, the phase log tells you where the time went.

**Part 3 — live trace via NDJSON.**

The NDJSON event stream (`05-streaming.md` in `01-llm-foundations/`) IS observability. Every loop iteration produces `reasoning_step` + `tool_call_start` + `tool_call_end` events. The UI's `StatusLog` renders them live; the user sees the agent's reasoning happen.

This is unusual product polish for an LLM app: most apps hide the agent's reasoning; this one surfaces it as a first-class feature. From the observability perspective, the trace IS the dashboard for "what did the agent do during this investigation?"

The trace lives only in the stream (it's not persisted to logs separately). For post-hoc analysis, you'd need to capture the stream — which the demo snapshot path does (`lib/state/demo-investigations.json`).

**Part 4 — what's NOT shipped.**

  → **No vendor observability.** No Langfuse, LangSmith, Phoenix, or Helicone. The decision is honest: those vendors are valuable when you have many engineers debugging across many agent runs; today this codebase has one engineer and tractable volume.
  → **No replay surface.** You can't re-run a saved trace with a different prompt or model. The closest thing is the demo replay, which is a pre-captured stream replayed verbatim — not a re-execution.
  → **No per-tool latency dashboard.** Per-tool durationMs is in the trace events, but not aggregated. To answer "which MCP tools are slowest on average?", you'd query Vercel logs and aggregate manually.

These are all real gaps. The vendor decision is reasonable; the replay surface is the one most worth building first (it's the path to debugging conclusion instability findings like Phase 3's).

### Move 3 — the principle

**Observability has altitudes. Pick the right one for the question.** "How much did we spend?" → token altitude (per-call usage logs). "Why is this route slow?" → phase altitude (per-phase timings). "What was the agent thinking?" → event altitude (the trace). One altitude can't answer the others — the surface needs to match the question.

## Primary diagram — the full recap

```
  Three observability surfaces, three altitudes, three Vercel filters

  ┌─ Per-call (token altitude) ──────────────────────────────────┐
  │  Emitter: AnthropicModelProviderAdapter.complete() line 55-60│
  │  Filter:  site = "agents/{agent}:aptkit-model"               │
  │  Shape:   { site, sessionId, usage:{input_tokens, output_tokens}}│
  │  Use:     per-agent token volume, per-day cost calculation   │
  │  Gap:     no aggregation/dashboard; manual log query        │
  └──────────────────────────────────────────────────────────────┘

  ┌─ Per-phase (phase altitude) ─────────────────────────────────┐
  │  Emitter: route.ts finally{} (briefing line 307, agent 331) │
  │  Filter:  route = "/api/briefing" OR "/api/agent"           │
  │  Shape:   { route, sessionId, mode, totalMs, phases[],       │
  │             aborted }                                        │
  │  Use:     where did the 300s budget go? which phase slow?    │
  │  Critical:fires in finally so timeout incidents still log    │
  └──────────────────────────────────────────────────────────────┘

  ┌─ Live trace (event altitude) ────────────────────────────────┐
  │  Emitter: NDJSON wire via encodeEvent() (mcp/events.ts:14)   │
  │  Consumer:UI StatusLog → ReasoningTrace                      │
  │  Shape:   AgentEvent variants (reasoning_step, tool_call_*, │
  │            insight, diagnosis, recommendation, done, error)  │
  │  Use:     debug WHAT the agent reasoned/did this run          │
  │  Persisted: only via demo capture path; otherwise stream-only│
  └──────────────────────────────────────────────────────────────┘

  No vendor (Langfuse, LangSmith, Phoenix). The dashboards are
   Vercel log queries.
```

## Elaborate

**Why no vendor.** Three reasons:

  1. **Tractable volume.** One engineer, ~hundreds of agent runs per day (in development) at most. Vercel logs + manual queries cover the questions that come up.
  2. **Vendor lock-in cost.** Langfuse, LangSmith, etc. are great products but they're SaaS dependencies with their own SDK, data export costs, and pricing tiers. Adding one is a real engineering cost — the code that wraps every LLM call needs to know about the vendor.
  3. **Adapter is the natural funnel.** Every LLM call funnels through `AnthropicModelProviderAdapter.complete()`. Adding a vendor would mean adding one method call there — actually small, but it changes the dependency surface of the adapter.

When the codebase has many engineers debugging across many runs, the vendor's UI dashboards become genuinely valuable (a query against Vercel logs that returns 10k rows is unmanageable). Today, the gap is fine.

**Why the per-phase log fires in finally.** The 300s Vercel maxDuration is the canonical budget concern. When a route times out at 300s, the route doesn't get to emit a normal "done" log line — it just gets terminated. The `finally` block runs whether the try{} succeeded or threw, so the phase log emits regardless. This is the incident signal: "the route hit 300s, here's where the time went." Without it, timeout incidents would be debug-blind.

**Why the trace IS observability for this product.** Most LLM apps treat the trace as internal debug info and hide it from the user. This product surfaces the trace as a feature ("an analyst that shows its work"). The two consumers — the user and the engineer debugging — share the same data. That's unusual but coherent: if the engineer needs to see *what the agent did*, the same data the user sees in `StatusLog` is the data the engineer needs.

## Project exercises

### Exercise — Persist the trace per invocation for post-hoc replay

  → **Exercise ID:** B5.4
  → **What to build:** Add a trace persistence layer that writes the full `AgentEvent[]` for each completed agent invocation to a per-session file (dev) or Vercel KV (prod). Expose a `/debug/trace?invocationId=…` route that re-streams a stored trace. Optional: a `/debug/replay?invocationId=…&promptVersion=v2` route that takes the original `Anomaly` from the stored trace and re-runs the diagnostic agent with a different prompt version — true replay.
  → **Why it earns its place:** replay is the missing observability surface for debugging conclusion instability. Phase 3 found 30% conclusion instability via running the same input K=10 times; replay would let you debug a *specific* unstable conclusion by replaying it. Also valuable for prompt iteration — "would v2 of the diagnostic prompt have produced the same conclusion as v1 did on this run?"
  → **Files to touch:** new `lib/state/traces.ts` (persistence layer), new `app/debug/trace/route.ts` (read endpoint), new `app/debug/replay/route.ts` (replay endpoint), `app/api/agent/route.ts` (write the trace at end of run), `test/state/traces.test.ts` (cover persistence + retrieval).
  → **Done when:** every completed agent invocation has its trace stored, the read endpoint streams it back in the same NDJSON format as the live stream, and the optional replay path runs the agent fresh with the original input.
  → **Estimated effort:** ≥1 week.

## Interview defense

**Q: "How do you know what your agents are doing in production?"**

Three surfaces. (1) Per-call: every Anthropic call emits `{ site, sessionId, usage }` from inside the adapter at `lib/agents/aptkit-adapters.ts:55-60`. Vercel log filter on `site` gives per-agent token volume and per-day cost. (2) Per-phase: each route emits a summary `{ route, sessionId, mode, totalMs, phases[], aborted }` in `finally{}` — fires even on errors, including the 300s budget timeout. (3) Live trace: the NDJSON event stream IS the product surface — users see `reasoning_step`, `tool_call_start/end`, `insight`, etc. in `StatusLog`, and that same data is what an engineer sees when debugging.

No vendor (Langfuse, LangSmith). Tractable volume + Vercel log queries cover the questions today.

*Anchor: "Three altitudes: per-call usage, per-phase timings, live trace. No vendor today; vendor when volume grows."*

**Q: "What's the missing piece in your observability?"**

Replay. The trace is great for debugging "what did the agent do on THIS run" but I can't take a saved trace and re-run it with a different prompt to ask "would v2 have done better?" That's the missing surface for prompt iteration — you'd want to replay every problematic trace from yesterday against the new prompt. Persistence + replay is the `B5.4` exercise; it's the most-bang-for-the-buck observability addition for this codebase.

The Phase 3 finding of 30% conclusion instability was caught by running the same input K=10 times — replay would let me debug a specific unstable conclusion rather than just measuring instability.

*Anchor: "Replay is the next surface. Persist trace + replay endpoint = `B5.4`."*

## See also

  → `01-eval-set-types.md` — eval is the complementary discipline
  → `04-agents-and-tool-use/03-react-pattern.md` — the trace events ARE the ReAct loop's externalized state
  → `01-llm-foundations/05-streaming.md` — the NDJSON wire protocol the trace rides on
  → `01-llm-foundations/06-token-economics.md` — the usage logs feed the cost story

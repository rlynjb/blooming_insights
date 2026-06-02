# Traces and request lifecycles

**Industry name(s):** distributed tracing, spans, trace replay, request lifecycle, NDJSON event stream, agent telemetry
**Type:** Industry standard · Language-agnostic

> The NDJSON `AgentEvent` stream IS a trace — and unlike most early-stage codebases, it's a real one. Each `tool_call_start`/`tool_call_end` pair brackets a span with a measured `durationMs`. Each `reasoning_step` annotates the span timeline with what the agent was thinking. The replay path (`getCachedInvestigation`) re-emits the captured trace at 180ms ticks so the UI animates identically to a live run. The honest gap: the trace exists only in two places — the UI and the cache — never an external observability backend (no OTel exporter, no Langfuse, no Datadog). For the deep LLM-telemetry angle on this same stream, cross-link to `.aipe/study-ai-engineering/05-evals-and-observability/04-llm-observability.md`; this file owns the *generic* tracing angle (request lifecycle, span shape, replay), and cross-links rather than duplicating.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Tracing is the third pillar (with logs and metrics). It answers "what happened during this one request, and in what order?" In blooming insights, the trace is unusually visible — it's not a backend artifact you query, it's the live UI the user watches. Every layer either emits the trace, frames it for transport, or renders it.

```
  Zoom out — the trace runs alongside every layer

  ┌─ UI ────────────────────────────────────────────┐
  │  ReasoningTrace renders TraceItem[]              │
  │  ProcessStepper shows monitoring/diagnostic/     │
  │    recommendation state                          │
  └─────────────────────────▲───────────────────────┘
                            │  NDJSON line per AgentEvent
  ┌─ Route handler ─────────┴───────────────────────┐
  │  send(e) → push to collected[] + enqueue        │
  └─────────────────────────▲───────────────────────┘
                            │
  ┌─ Agent loop ────────────┴───────────────────────┐  ← we are here
  │  ★ hooks emit AgentEvent on every step ★         │
  │  reasoning_step · tool_call_start · _end         │
  │  durationMs measured at the MCP boundary         │
  └─────────────────────────▲───────────────────────┘
                            │
  ┌─ MCP client ────────────┴───────────────────────┐
  │  callTool returns { result, durationMs }         │
  └─────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** A trace is an ordered sequence of *spans* — start/end pairs bracketing one unit of work, each carrying timing and outcome. `lib/mcp/events.ts:4–12` defines the entire vocabulary: `tool_call_start` opens a span, `tool_call_end` closes it with `durationMs`, and `reasoning_step` interleaves agent thinking *between* spans. The whole request lifecycle — from "user clicked investigate" to "diagnosis emitted" — replays event-for-event from `lib/state/demo-investigations.json`. That replay capability is what makes this a *trace*, not just a log: ordered, bracketed, deterministic.

---

## Structure pass

**Layers.** Three: span boundary (the start/end pair), the lifecycle (the ordered sequence of spans + reasoning steps for one investigation), and the carrier (NDJSON over HTTP from route to UI, plus the cache for replay).

**Axis: lifecycle (when does this happen, and what bounds it?).** Trace it: span = one MCP call (bounded by `tool_call_start`/`tool_call_end`); reasoning_step = one agent text emission (bounded by the agent loop's text-extract pass); investigation lifecycle = `runAgentLoop` start → `done` event (bounded by the route's `ReadableStream.start` invocation). At each altitude the lifecycle answer is different — that contrast is what lets you reason about *where* a trace event is allowed to appear in the order.

**Seams.** Three load-bearing:

- **Agent loop ↔ hook callback.** `runAgentLoop` calls `onToolCall(tc)` before MCP execution and `onToolResult(tc)` after. The hook is *inside* the loop; this is where the span boundary materializes. Drop the hook = the span disappears even though the MCP call still happens.
- **Hook ↔ NDJSON wire.** `send(e)` in the route's stream closes the seam: hook fires → typed event constructed → encoded as one NDJSON line → enqueued on the stream. This is where in-process callbacks become a transport-able trace.
- **Wire ↔ cache snapshot.** `collected.push(e)` runs alongside the enqueue, and `saveInvestigation(insightId, collected)` runs after `done`. This is where ephemeral live becomes persistent replayable — and the replay path emits the same NDJSON, so the UI can't tell.

```
  Structure pass — traces and request lifecycles

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  span boundary · lifecycle · carrier           │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  lifecycle: when does this happen,             │
  │  what bounds it?                               │
  └────────────────────────┬───────────────────────┘
                           │  trace, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  loop↔hook:    LOAD (span materializes)        │
  │  hook↔NDJSON:  LOAD (in-process → wire)        │
  │  wire↔cache:   LOAD (ephemeral → replayable)   │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

Skeleton mapped. Now walk a request lifecycle from click to done.

---

## How it works

**Mental model.** A trace is a *bracketed timeline*. Each span is bracketed by a start event and an end event; both carry the same identifier so they pair up; the end carries the duration. Between spans, free-form annotations (the agent's reasoning text) tell you what was happening when no span was open. The whole thing is ordered — event N happened before event N+1 — and the carrier preserves order. NDJSON is the perfect carrier because it's line-delimited (one event per line, no partial parses).

```
  Pattern — the bracketed timeline

  time →

  ┌──┐                                          ┌──┐
  │t0│ reasoning_step {thought: "I should…"}    │tN│ reasoning_step
  └──┘                                          └──┘   {conclusion: "…"}
   │                                              ▲
   │  ┌────────── span: execute_analytics_eql ──┐ │
   │  │ tool_call_start {toolName:eql, agent:d}  │ │
   │  │ ────────────── 340ms ─────────────────── │ │
   │  │ tool_call_end {toolName:eql, durationMs:340, result} │
   │  └──────────────────────────────────────────┘ │
   │     ▲                                          │
   │     │  ┌─ span: aggregate_anomalies ─┐         │
   │     │  │ tool_call_start              │         │
   │     │  │ ───── 220ms ──────────────── │         │
   │     │  │ tool_call_end {durationMs:220}│        │
   │     │  └──────────────────────────────┘         │
   │     │                                           │
   ▼     ▼                                           ▼
  reasoning  spans bracket tool work        diagnosis event
                                            (the agent's output)
```

The diagram is the trace shape. Real implementations differ only in field names and transport.

### Move 2 — walk the lifecycle

#### Span boundary — `tool_call_start` opens, `tool_call_end` closes

The reader anchor: you've used `console.time('foo'); … console.timeEnd('foo')`. Same idea, but instead of printing the elapsed time to the console, you emit two typed events on a stream — one for "started", one for "finished with `durationMs: X`". The pair brackets one logical unit of work.

What happens: `runAgentLoop` calls `onToolCall(tc)` *before* dispatching the tool, and `onToolResult(tc)` *after* the result returns (or after a catch sets `tc.error`). The route's `hooksFor(agent)` translates each callback into `send({type:'tool_call_start', ...})` or `send({type:'tool_call_end', durationMs, result, error?})`. The MCP client already measured `durationMs` around the live transport call, so by the time `onToolResult` fires, the number is in `tc.durationMs` ready to ride on the event.

Boundary: pairing is positional, not via an ID. The two events have the same `toolName` and `agent`, but no shared span ID. The UI's `replaceRunningTool` finds the matching span by scanning back through `items[]` for the most recent `kind:'tool'` with the same `toolName` and `status:'running'`. This works because tools are dispatched sequentially in the loop — but if you ever ran them in parallel, the pairing would ambiguate. Worth flagging.

```
  Span boundary — open/close pair on the same agent + tool

  hooks fire in runAgentLoop:                   events on the stream:
  ─────────────────────────────────             ──────────────────────────────
  onToolCall(tc)                                tool_call_start {
    where tc = {agent, toolName, args}            toolName: 'execute_analytics_eql',
                                                   agent: 'diagnostic'
                                                 }

  (mcp.callTool happens; durationMs measured)

  onToolResult(tc)                              tool_call_end {
    where tc.durationMs = 340                     toolName: 'execute_analytics_eql',
        tc.result      = {...}                    agent: 'diagnostic',
        tc.error?      = undefined                durationMs: 340,
                                                   result: trunc({...})
                                                 }
```

#### Lifecycle — the ordered request

The reader anchor: you've watched a Chrome network tab populate request-by-request as a page loads. The investigation lifecycle is the same — but instead of HTTP requests, it's agent steps and tool calls. The lifecycle has fixed phases: bootstrap (read schema, list tools) → agent run (diagnose, then recommend) → done. Each phase emits its own events; the order is enforced by the route handler's sequential `await` calls.

What happens: the route's `start(controller)` runs in three phases. Bootstrap emits a single `reasoning_step{thought:'reading the workspace schema…'}` and awaits `bootstrapSchema`. Then the diagnostic agent runs (emitting many `reasoning_step` + tool spans) and `send({type:'diagnosis', diagnosis})` closes the phase. Then the recommendation agent runs and emits each `Recommendation` as its own event. Finally `send({type:'done'})`. The whole lifecycle is one sequential pass — no parallel agents, no out-of-order emits.

Boundary: the `done` event is contractual. Clients (`useInvestigation`) flip `complete = true` only on `done`. If the stream closes without `done`, the UI sits in a "running" state forever (or until the user refreshes). The catch path emits `error` instead of `done`, which the client treats as a different terminal state.

```
  Investigation lifecycle — phases, in order

  phase                events emitted
  ─────────────────    ─────────────────────────────────────────
  bootstrap            reasoning_step {thought: "reading schema…"}
                       (NO tool spans — bootstrapSchema is
                        unmonitored direct mcp.listTools)

  diagnose             reasoning_step (intro)
                       reasoning_step / tool_call_start /
                         tool_call_end / … (the agent loop)
                       diagnosis (closes the phase)

  recommend            reasoning_step (intro)
                       reasoning_step / tool_call_start /
                         tool_call_end / …
                       recommendation × N (one event per rec)

  termination          done           ← clean
                       or
                       error          ← caught throw
```

#### Carrier — NDJSON over HTTP, replayable from cache

The reader anchor: you've used Server-Sent Events for a streaming response. NDJSON is similar but simpler: one JSON object per line, terminated by `\n`. The route returns an `application/x-ndjson` response; the client reads it with a streaming `TextDecoder` + `split('\n')`, parsing each line.

What happens on live: every `send(e)` runs `controller.enqueue(encoder.encode(encodeEvent(e)))`. `encodeEvent` = `JSON.stringify(e) + '\n'`. The client reads, splits on '\n', parses each line, dispatches into `useInvestigation`'s `handle()` switch. The stream closes when `controller.close()` is called (in the route's `finally`).

What happens on replay: `getCachedInvestigation(insightId)` returns the captured `AgentEvent[]`. The route opens a `ReadableStream`, iterates the array, enqueues each event encoded as NDJSON, and waits 180ms between events. The UI consumes it identically — no replay-aware code in the client. Same headers, same line shape, same parse path.

Boundary: NDJSON requires every event to fit on one line. The route's `trunc` function (`route.ts:99–103`) caps result payloads at 4000 chars to prevent absurdly large lines from breaking the wire. If a tool returned a 50KB JSON blob, you'd lose the tail but not the framing.

```
  Carrier — wire bytes, live and replayed

  live:                                          replay (from cache):
  ─────────────────────────────────              ─────────────────────────────────
  send(e) → push + enqueue                       for (e of cachedEvents)
                                                   enqueue(encodeEvent(e))
                                                   await sleep(180)
                                                 close()

  ↓ wire                                         ↓ wire (same shape)
  {"type":"reasoning_step",...}\n                {"type":"reasoning_step",...}\n
  {"type":"tool_call_start",...}\n               {"type":"tool_call_start",...}\n
  {"type":"tool_call_end","durationMs":340,...}\n {"type":"tool_call_end",...}\n
  {"type":"diagnosis",...}\n                     {"type":"diagnosis",...}\n
  {"type":"done"}\n                              {"type":"done"}\n

  client cannot tell live from replay (this is the point of the design)
```

#### Move 3 — the principle

A trace earns the name *trace* (rather than *log*) when (a) events are ordered, (b) work units are bracketed by start/end pairs with timing, and (c) the whole sequence can be replayed deterministically. blooming insights satisfies all three at the agent layer because the discriminated event union forced the discipline up front — there's no escape hatch where someone could emit an untyped event. The lesson generalises: type your trace events as a closed union before the first one ships. Once the union is locked, every layer (emit, transport, render, replay) follows the same shape and the trace becomes a real artifact, not just an instrumented log.

---

## Primary diagram

A full investigation lifecycle laid out as a span chart, with every event labelled and the two terminal paths shown.

```
  Investigation lifecycle — full span chart

  request: GET /api/agent?insightId=ins-7&step=diagnose
  ─────────────────────────────────────────────────────────────────────────

   time →
   ┌──┐
   │t0│ reasoning_step {agent:diagnostic, thought: "reading schema…"}
   └──┘
        ──── bootstrapSchema (unmonitored, no span emitted) ────
   ┌──┐
   │t1│ reasoning_step {agent:diagnostic, thought: "investigating mobile…"}
   └──┘
   ┌─────────── span: get_event_breakdown ──────────┐
   │ tool_call_start {agent:diagnostic, toolName}    │
   │ ……………………………… 420ms ……………………………………………………………… │
   │ tool_call_end   {agent:diagnostic, durationMs:420, result}
   └─────────────────────────────────────────────────┘
   ┌──┐
   │t2│ reasoning_step {agent:diagnostic, kind:'hypothesis', content: "checkout step 3…"}
   └──┘
   ┌─────────── span: execute_analytics_eql ───────────┐
   │ tool_call_start                                    │
   │ ……………………………… 880ms ……………………………………………………………… │
   │ tool_call_end {durationMs:880}                     │
   └────────────────────────────────────────────────────┘
   ┌──┐
   │tN│ diagnosis {conclusion, evidence[], hypothesesConsidered[]}
   └──┘
   ┌──┐
   │tT│ done                                  ← clean termination
   └──┘                       │
                              │ if step==null:
                              ▼
                          saveInvestigation(insightId, collected)
                          → mem + dev file


  terminal alternatives:
  ──────────────────────
  done         ──► client: complete=true · cache: snapshot saved
  error        ──► client: error set     · cache: NOT saved
                                            (incomplete runs aren't replayable)
```

---

## Implementation in codebase

### Use cases

Three real moments the trace is the load-bearing thing:

- **The user watches the investigation in real time.** The trace is the user-facing surface — not a backend log they can't see. `components/shared/StatusLog.tsx` mounts `ReasoningTrace` as a sticky sidebar; every `reasoning_step` becomes a labeled line, every `tool_call_end` becomes a `ToolCallBlock` with the `durationMs` rendered. The user sees the agent's work *while it happens*. This is the design payoff of typed events: the same shape that traces the run also renders it.

- **A captured run replays for a demo.** The route's `getCachedInvestigation` path streams the captured `AgentEvent[]` back at 180ms ticks. The `ReasoningTrace` UI consumes it identically — same hook (`useInvestigation`), same render. Off-network, no creds. The trace is replayable because every event is typed and ordered.

- **`/api/briefing` reuses the trace vocabulary for the monitoring phase.** Different agent, same shape. The briefing route emits `reasoning_step` + `tool_call_start` + `tool_call_end` for the monitoring scan, plus `coverage_item` + `insight` + `workspace` events specific to its phase. `BriefingEvent` is `AgentEvent` plus three extras, defined locally in `app/api/briefing/route.ts:54–58` so the shared union stays clean.

### Code side by side, with a line-by-line read

The event vocabulary — the 8-line contract that everything else honors:

```
  lib/mcp/events.ts  (lines 4–17)

  export type AgentEvent =
    | { type: 'reasoning_step'; step: ReasoningStep }                          ← annotation between spans
    | { type: 'tool_call_start'; toolName: string; agent: AgentName }          ← span open
    | { type: 'tool_call_end'; toolName: string; agent: AgentName;             ← span close + timing
        durationMs: number; result?: unknown; error?: string }
    | { type: 'insight'; insight: Insight }                                    ← briefing output
    | { type: 'diagnosis'; diagnosis: Diagnosis }                              ← diagnostic agent output
    | { type: 'recommendation'; recommendation: Recommendation }               ← recommendation agent output
    | { type: 'done' }                                                         ← clean termination
    | { type: 'error'; message: string };                                      ← typed error variant

  export function encodeEvent(e: AgentEvent): string {
    return JSON.stringify(e) + '\n';                                           ← NDJSON: one line per event
  }
        │
        └─ closed discriminated union: TypeScript flags any code that
           tries to emit an unknown type. This is what makes the trace
           a real contract, not a freeform log.
```

The hooks — where the span boundary materializes inside the agent loop:

```
  app/api/agent/route.ts  (lines 181–195)

  const hooksFor = (agent: AgentName) => ({
    onText: (t: string) => {
      if (t.trim()) stepFor(agent, 'thought', t);                              ← text → reasoning_step
    },
    onToolCall: (tc: ToolCall) =>
      send({ type: 'tool_call_start', toolName: tc.toolName, agent }),         ← ★ span OPEN ★
    onToolResult: (tc: ToolCall) =>
      send({                                                                    ← ★ span CLOSE ★
        type: 'tool_call_end',
        toolName: tc.toolName,
        agent,
        durationMs: tc.durationMs ?? 0,                                        ← timing from McpClient
        result: trunc(tc.result),                                              ← capped to 4000 chars
        error: tc.error,
      }),
  });
        │
        └─ hooksFor curries the agent label so every event the loop
           emits is correctly attributed. The pair onToolCall/onToolResult
           is what brackets each tool's work as one span.
```

The route's stream-time loop — how the lifecycle phases unfold:

```
  app/api/agent/route.ts  (lines 222–254, abbreviated)

  // STEP 2 (diagnose) — runs the diagnostic agent
  stepFor('diagnostic', 'thought', `investigating "${inv.metric}"…`);          ← phase intro event
  const diagAgent = new DiagnosticAgent(anthropic, conn.mcp, schema, allTools);
  diagnosis = await diagAgent.investigate(inv, hooksFor('diagnostic'));        ← hooks → trace events
  send({ type: 'diagnosis', diagnosis });                                      ← phase output event

  // STEP 3 (recommend) — runs the recommendation agent
  if (step !== 'diagnose') {
    stepFor('recommendation', 'thought', 'proposing actions…');
    const recAgent = new RecommendationAgent(anthropic, conn.mcp, schema, allTools);
    const recommendations = await recAgent.propose(inv, diagnosis!,
                                                    hooksFor('recommendation'));
    for (const r of recommendations) send({ type: 'recommendation', recommendation: r });
  }

  send({ type: 'done' });                                                      ← terminal event
  if (step == null) saveInvestigation(insightId!, collected);                  ← snapshot for replay
        │
        └─ phase order is enforced by sequential awaits.
           The split-step flow (step='diagnose' alone) skips the recommend
           phase entirely; the cache saves only the combined run.
```

The client-side replay pair — `tool_call_end` finds its matching open span:

```
  lib/hooks/useInvestigation.ts  (lines 86–95)

  const replaceRunningTool = (arr: TraceItem[],
                              e: Extract<AgentEvent, { type: 'tool_call_end' }>) => {
    for (let i = arr.length - 1; i >= 0; i--) {                                ← scan backwards
      const it = arr[i];
      if (it.kind === 'tool' && it.toolName === e.toolName
          && it.status === 'running') {                                         ← match: same toolName + 'running'
        arr[i] = { ...it, status: 'done', durationMs: e.durationMs,            ← close the span
                   result: e.result, error: e.error };
        break;
      }
    }
    return arr;
  };
        │
        └─ positional pairing: the most recent 'running' tool with the
           same toolName is the partner. Works because tools run
           sequentially in the loop. Would ambiguate if you ever
           parallelized tools — a span ID would be required then.
```

---

## Elaborate

The trace shape blooming insights uses is structurally identical to OpenTelemetry's `Span` (start/end pair, name, duration, attributes) — just without the standard envelope (trace ID, span ID, parent span ID, kind, status). The missing envelope is what would let you export the trace to a backend like Jaeger or Tempo. The work to add it is mechanical: extend `AgentEvent` with `traceId`/`spanId`, generate them in `runAgentLoop`, write an exporter that batches events to OTLP. The reason it's not built is the reason most early-stage repos defer OTel — there's no upstream consumer yet that would *query* the trace. The UI doesn't query it (it consumes it as a stream); the cache doesn't query it (it just replays).

What this trace gets right that OTel sometimes misses: the annotations *between* spans. OpenTelemetry's "span events" are an afterthought; `reasoning_step` here is a first-class variant on the union. The agent's reasoning between tool calls is *load-bearing* evidence — without it, a captured tool call sequence is meaningless. ("Why did the agent call that tool?" "Read the reasoning_step right before it.") The union puts annotation on equal footing with span boundaries.

What this trace gets wrong (vs OTel): no parent-child relationship. There's no `parentSpanId`, so you can't nest spans. If the agent ever did "call MCP to plan, then call MCP again with the plan's output as input," there's no way to express "this second call is a child of the first." Today every span is a top-level sibling. For the current agent shape this is fine; for a more nested agent it would lose causal information.

Cross-link: `.aipe/study-ai-engineering/05-evals-and-observability/04-llm-observability.md` covers the same event stream from the LLM telemetry angle (the trace as the product surface, the `durationMs` as the per-span latency, the cache as replay). This file owns the *generic* tracing concept (span shape, lifecycle phases, NDJSON carrier); that file owns the *LLM-specific* angle (model versions, token usage, prompt drift). They're complementary, not duplicate. If you only read one, the LLM-observability file goes deeper into the AI-engineering nuance.

---

## Interview defense

**Q1. What makes the AgentEvent stream a "trace" and not a "log"?**

Three things. (1) Order is preserved — NDJSON is line-delimited, and the route's `send(e)` enqueues synchronously, so event N always precedes event N+1 on the wire. (2) Work units are bracketed — `tool_call_start` and `tool_call_end` come in pairs, with `durationMs` on the close. (3) The whole sequence is replayable — `saveInvestigation` snapshots `collected[]`, and the cache-first path re-emits it at 180ms ticks so the UI consumes it identically. A log has none of those properties; it's just a stream of strings ordered by wall-clock. The discriminated union (`AgentEvent` in `lib/mcp/events.ts`) is what forced the discipline up front.

```
  log:    stream of strings, no pairing, no replay
  trace:  stream of typed events, paired spans with timing, replayable
                              ▲
                              └─ blooming insights' AgentEvent union
```

**Anchor:** the discriminated union forces every emitter into the trace contract — there's no escape hatch.

**Q2. The trace pairs spans by toolName + 'running' status. What breaks if the agent runs tools in parallel?**

The pairing ambiguates. Two `tool_call_start` events with the same `toolName` would be in flight at the same time; when the first `tool_call_end` arrives, `replaceRunningTool` scans backwards and finds the *most recent* `'running'` one — which is the *second* invocation, not the first. The timing and result get attached to the wrong span. The fix is a span ID: add `id: string` to `tool_call_start`, echo it on `tool_call_end`, match on ID. Until the agent runs tools in parallel (it currently doesn't — `runAgentLoop` awaits each tool sequentially in `base.ts`), the gap is latent, not active.

```
  today: positional pair (works because sequential)
  ──────────────────────────────────────────────────
  tool_call_start {toolName:eql}
  tool_call_end   {toolName:eql, durationMs}   ← unambiguous

  parallel (would break):
  ──────────────────────────────────────────────────
  tool_call_start {toolName:eql}  ← span A
  tool_call_start {toolName:eql}  ← span B
  tool_call_end   {toolName:eql, durationMs}
                              ▲
                              └─ which span? scan-backwards picks B,
                                 even if A finished first
```

**Anchor:** name the latent assumption and the smallest fix (one extra field).

---

## Validate

1. **Reconstruct.** Without looking, draw the `AgentEvent` union (eight variants) and label which two are the span boundary. Test: name the file and line range.
2. **Explain.** Why is `done` a separate event variant instead of just "stream closes"? What does the client do with `done` vs an unexpected close?
3. **Apply to a scenario.** A captured trace ends with `error` instead of `done`. What does the cache do? What does the UI do? What's the recovery path?
4. **Defend the decision.** Argue for adding a `spanId: string` field to `tool_call_start`/`tool_call_end` today. Argue against. Name the leading indicator that flips the decision.

---

## See also

- `01-observability-map.md` — the agent layer in the bigger map; the trace is its evidence.
- `02-reproduction-and-evidence.md` — the cache replay flow that makes the trace deterministic.
- `06-state-snapshots-and-debugging-boundaries.md` — `saveInvestigation` as the persistence boundary for the trace.
- `.aipe/study-ai-engineering/05-evals-and-observability/04-llm-observability.md` — the same trace from the LLM-telemetry angle (token usage, model versions, prompt drift). Cross-link, don't duplicate.
- `.aipe/study-agent-architecture/` — the agent loop that emits the trace; the hooks contract belongs there structurally.

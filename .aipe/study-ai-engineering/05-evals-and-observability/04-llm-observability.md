# LLM observability (traces, spans, and replay)

**Industry name(s):** LLM observability, tracing / distributed tracing, spans, trace replay, agent telemetry
**Type:** Industry standard · Language-agnostic

> Every blooming insights investigation already emits a live trace — an NDJSON stream of `reasoning_step` / `tool_call_start` / `tool_call_end{durationMs}` events that the UI renders as the agent's visible work, the briefing route summarizes per tool call, the `/debug` page exercises one call at a time, and the investigation cache replays event-for-event. The trace is not an add-on; it is the product surface.

**See also:** → 01-eval-set-types.md · → 02-eval-methods.md · → ../04-agents-and-tool-use/03-react-pattern.md · → ../01-llm-foundations/05-streaming.md · → ../06-production-serving/01-caching.md

---

## Why care

You debug a slow page by opening the browser Network tab: a waterfall of requests, each a bar whose length is its duration, nested under the document that triggered them, with timings and status codes you can click into. That waterfall is a trace — a tree of timed operations (spans) you read to answer "what ran, in what order, how long did each take, and which one failed?" You already think in traces; you just call it the Network tab.

An agent run has exactly this shape. `DiagnosticAgent.investigate` is the root request; each `mcp.callTool` it makes is a child span with a duration; each reasoning step is an annotation on the timeline. The question this file answers is: **how do you make an LLM agent's hidden multi-step execution visible — what it decided, which tools it called, how long each took, and what it concluded — so you can debug a bad run and show a user the work?**

**Why answering it matters: an agent without a trace is a black box that you cannot debug and the user cannot trust.** When a diagnosis comes back wrong or slow, "the model did something" is not a debuggable statement. You need the ordered record: this reasoning step, then this EQL call (340ms), then this one (1.1s, the slow one), then this conclusion. blooming insights treats that record as a first-class output — it streams the trace to the UI *as the agent runs*, so observability is not a backend log you grep, it is the thing the user watches. That is the load-bearing design choice: the trace is both the debug instrument and the product.

Before a trace:
- A wrong diagnosis is "the model messed up" — no record of which tool returned bad data
- A slow run is "it felt slow" — no per-step timing to find the bottleneck
- The user sees a spinner, then an answer, with no evidence of the work behind it

After:
- Every run is an ordered stream of typed events — reasoning, tool start, tool end with `durationMs`, conclusion
- The slow span is identified by its `durationMs`; the bad tool result is in the `tool_call_end` payload
- The user watches the agent reason and query in real time — the trace *is* the UI

It is the Network-tab waterfall, modeled as a typed event union and streamed over `fetch` instead of rendered in devtools.

---

## How it works

**Mental model.** A trace is a sequence of typed events emitted in execution order; each tool call is a span bracketed by a `start` and an `end` that carries its `durationMs`. blooming insights defines this as a discriminated union (`AgentEvent`), encodes each event as one NDJSON line, and streams the lines to the client as the agent runs. The client reads the stream and the cache stores the captured events — so the same event list is a *live* trace while running and a *replayable* trace afterward.

```
agent execution                 →  trace (ordered AgentEvent stream)
─────────────────────────────      ──────────────────────────────────
diagnostic agent starts            reasoning_step {kind:'thought'}
  decides to call EQL              tool_call_start {toolName}
  EQL returns (340ms)             tool_call_end   {durationMs:340, result}
  reasons about result            reasoning_step {kind:'hypothesis'}
  calls another tool              tool_call_start / tool_call_end
  concludes                       diagnosis / reasoning_step {conclusion}
done                              done
```

Each event is one line of NDJSON; the ordered list is the trace; a `tool_call_start`/`tool_call_end` pair is one span with a measured duration.

---

### The event union is the trace schema (`lib/mcp/events.ts`)

`AgentEvent` (`lib/mcp/events.ts` L4–L12) is a discriminated union — the typed schema of everything that can appear in a trace. The trace-relevant members are:

```
AgentEvent (events.ts L4–L12)
─────────────────────────────────────────────────────────────
| { type:'reasoning_step'; step: ReasoningStep }              ← annotation
| { type:'tool_call_start'; toolName; agent }                 ← span OPEN
| { type:'tool_call_end'; toolName; agent; durationMs;        ← span CLOSE
                          result?; error? }                     + timing
| { type:'insight' | 'diagnosis' | 'recommendation' }         ← outputs
| { type:'done' } | { type:'error'; message }                 ← terminal
```

`tool_call_start` opens a span; `tool_call_end` closes it and carries `durationMs`, the optional `result`, and an optional `error` (L6–L7). This is the OpenTelemetry span shape — a start, an end, a duration, attributes, and a status — expressed as two events in a stream instead of one span object. `encodeEvent` (L15–L17) serializes each as `JSON.stringify(e) + '\n'`; `decodeEvent` (L20–L22) parses one line back. NDJSON-per-event is what makes the trace *streamable*: each event is independently emittable and parseable the instant it occurs.

### The span data carriers (`lib/mcp/types.ts`)

Two types carry the span and annotation payloads. `ToolCall` (`lib/mcp/types.ts` L19–L27) is the span record:

```
ToolCall (types.ts L19–L27)            ReasoningStep (types.ts L29–L35)
─────────────────────────────────     ─────────────────────────────────
id: string                            id: string
agent: AgentName                      agent: AgentName
toolName: string                      kind: 'thought' | 'tool_call'
args: Record<string, unknown>               | 'hypothesis' | 'conclusion'
result?: unknown                      content: string
durationMs?: number   ← the timing    toolCall?: ToolCall
error?: string
```

`ToolCall` is the span: identity (`id`), the operation (`toolName`, `args`), the outcome (`result` or `error`), and the duration (`durationMs`). `ReasoningStep` is the annotation: a typed `kind` (`thought`/`hypothesis`/`conclusion`) plus `content`. Together they are the trace's vocabulary — spans and the reasoning between them.

### Where duration is measured (`lib/agents/base.ts`)

The `durationMs` is captured at the single choke-point where every tool call runs, inside `runAgentLoop` (`lib/agents/base.ts` L144–L149):

```
base.ts L144–L149  (inside runAgentLoop's per-tool block)
─────────────────────────────────────────────────────────────
const { result, durationMs } = await mcp.callTool(   ← L144
  tu.name,
  tu.input as Record<string, unknown>,
);
tc.result = result;                                  ← L148
tc.durationMs = durationMs;                           ← L149  the span's duration
```

`mcp.callTool` returns `{ result, durationMs, fromCache }` (the `McpCaller` contract, `lib/agents/base.ts` L16–L22), and the loop copies `durationMs` onto the `ToolCall` span record. Because every agent's tool calls flow through this one loop, *every* span is timed by construction — there is no instrumentation to forget. The loop then notifies the caller via `onToolResult?.(tc)` (L159), which is how the route turns the span into a streamed `tool_call_end` event (next section).

### Trace as live product surface (the route + UI)

`app/api/agent/route.ts` is where the span records become a streamed trace. `hooksFor(agent)` (L117–L132) wires the loop's callbacks to `send()` calls that enqueue NDJSON events:

```
route.ts L117–L132  (hooksFor)
─────────────────────────────────────────────────────────────
onText       → reasoning_step {kind:'thought'}      (L118–120)
onToolCall   → tool_call_start {toolName, agent}    (L121–122)  span OPEN
onToolResult → tool_call_end {toolName, agent,      (L123–131)  span CLOSE
                 durationMs: tc.durationMs ?? 0,
                 result: trunc(tc.result), error}
```

`send` (L108–L111) does two things on every event: pushes it into a `collected` array *and* enqueues it onto the `ReadableStream`. So the trace streams to the client live (the user watches the agent work — this is the ReAct-rendered-as-UI pattern, `../04-agents-and-tool-use/03-react-pattern.md`) and is simultaneously captured for storage. The client reads the NDJSON over a `fetch` body reader and renders each event as it arrives. Observability here is not a sidecar dashboard — it is the primary UI.

### Trace summarization (`app/api/briefing/route.ts`)

The briefing route adds a second observability view: a compact per-call summary of the trace. `summarizeTrace(trace)` (`app/api/briefing/route.ts` L13–L21) maps each `ToolCall` span to a flat diagnostic record:

```
summarizeTrace (briefing route.ts L13–L21)
─────────────────────────────────────────────────────────────
trace.map(t => ({
  tool: t.toolName,
  args: t.args,
  ok: !t.error,                                  ← status from error presence
  error: t.error,
  resultPreview: t.result ? JSON...slice(0,300) : undefined,
}))
```

The monitoring scan accumulates spans into a `trace` array via `agent.scan((tc) => trace.push(tc))` (L58), and the summary is returned on both the success path (L66) and the error path (L72) — so even a failed briefing returns "here is which tools the agent called and which one failed." This is span-list-to-table reduction: the raw spans become a readable diagnostic of the run, attached to the response.

### Trace replay from the cache (`lib/state/investigations.ts`)

The captured event list is also the unit of replay. `saveInvestigation(insightId, collected)` (`lib/state/investigations.ts` L30–L41, called at `route.ts` L162) stores the full `AgentEvent[]` for an investigation; `getCachedInvestigation(insightId)` (L22–L28) retrieves it. On a cache hit, the route *re-streams the stored events* (`route.ts` L63–L81) with a small delay between them:

```
trace replay (route.ts L63–L81)
─────────────────────────────────────────────────────────────
cached = getCachedInvestigation(insightId)        ← stored AgentEvent[]
for (const e of cached) {
  controller.enqueue(encodeEvent(e))              ← re-emit each event
  await sleep(REPLAY_DELAY_MS)                     ← 180ms (L50), paced
}
```

This is trace replay in the literal sense: the exact event sequence a live run produced is played back event-for-event, so a cached investigation reproduces the original agent's visible work without re-calling the model or MCP. The trace is stored as the trace, retrieved as the trace, and replayed as the trace.

### Current state vs. future state

```
PRESENT (Case A — implemented)            ABSENT (honest gaps)
──────────────────────────────────        ──────────────────────────────────
typed event union (events.ts L4–12)        no Langfuse/LangSmith/Phoenix
span start/end + durationMs (base L144)     no third-party trace platform
live NDJSON stream to UI (route L117)       no span aggregation (p50/p95)
per-call summary (briefing L13–21)          no queryable trace store
manual /debug harness (debug page)          traces not persisted to a DB
event-for-event replay (investig. L22–41)   replay re-emits SAME events only —
                                             no replay-with-a-different-prompt
```

blooming insights has the *shape* of observability — typed spans, durations, a live trace, replay — built by hand. What it lacks is the *infrastructure* around it: a platform, persistence to a queryable store, and aggregate metrics across runs.

### The principle

An agent's execution is a tree of timed operations, and the way to make it debuggable and trustworthy is to emit that tree as a typed, ordered stream of span and annotation events — the same trace abstraction the browser Network tab gives you for HTTP. Capture the stream once and it serves three jobs: live UI (the user watches), debugging (the per-call summary and durations), and replay (re-emit the stored events). The discipline that makes this work is timing at a single choke-point so no span is ever un-instrumented.

---

## LLM observability — diagram

This diagram spans the Service layer (where spans are created and timed), the State layer (where the trace is captured and replayed), and the UI layer (where the live trace renders). A reader who sees only this should grasp that one captured event stream serves live rendering, summarization, and replay.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER  (lib/agents/base.ts — runAgentLoop)                 │
│                                                                       │
│   for each tool_use:                                                   │
│     { result, durationMs } = await mcp.callTool(...)   ← L144         │
│     tc.durationMs = durationMs                          ← L149  SPAN   │
│     onToolCall(tc)   / onToolResult(tc)                ← L138 / L159  │
└────────────────────────────────┬──────────────────────────────────────┘
                                 │ hooks → events (route.ts L117–132)
┌────────────────────────────────▼──────────────────────────────────────┐
│  EVENT SCHEMA  (lib/mcp/events.ts L4–22)                            │
│   AgentEvent union: reasoning_step | tool_call_start |                 │
│                     tool_call_end{durationMs} | diagnosis | done       │
│   encodeEvent = JSON + '\n'  (NDJSON, one event per line)             │
└──────────┬───────────────────────────────────┬───────────────────────┘
           │ send() pushes BOTH ways (route L108–111)                    │
   ┌───────▼────────────────────┐     ┌────────▼───────────────────────┐
   │  STATE LAYER (capture)     │     │  UI LAYER (live)               │
   │  collected: AgentEvent[]   │     │  fetch body reader →           │
   │  saveInvestigation L30–41  │     │  render each event as it        │
   │    (route.ts L162)         │     │  arrives (the visible "work")   │
   └───────┬────────────────────┘     └────────────────────────────────┘
           │ getCachedInvestigation L22–28
   ┌───────▼─────────────────────────────────────────────────────────┐
   │  REPLAY  (route.ts L63–81)                                        │
   │  re-emit stored events, paced REPLAY_DELAY_MS=180 (L50)           │
   └──────────────────────────────────────────────────────────────────┘

   SECONDARY VIEWS:
   summarizeTrace (briefing route.ts L13–21) → per-call {tool,ok,error}
   /debug (app/debug/page.tsx) → one manual tool call, shows durationMs L218–227
```

One captured `AgentEvent[]` stream feeds three consumers — the live UI, the cache/replay, and (in the briefing route) a per-call summary table. Every span is timed at the single `mcp.callTool` choke-point, so the trace is complete by construction.

---

## In this codebase

### Files, functions, and line ranges

**File:** `lib/mcp/events.ts`
**Function / class:** `AgentEvent` union; `encodeEvent` / `decodeEvent`
**Line range:** union L4–L12 (`tool_call_start` L6, `tool_call_end{durationMs,result?,error?}` L7); `encodeEvent` L15–L17 (`JSON.stringify(e)+'\n'`); `decodeEvent` L20–L22 — the trace schema and NDJSON codec.

**File:** `lib/mcp/types.ts`
**Function / class:** `ToolCall` (the span record); `ReasoningStep` (the annotation)
**Line range:** `ToolCall` L19–L27 (`durationMs?` at L25, `result?` L24, `error?` L26); `ReasoningStep` L29–L35 (`kind` union L32) — the span and annotation payloads.

**File:** `lib/agents/base.ts`
**Function / class:** `runAgentLoop` — per-tool timing capture
**Line range:** L144–L149 — `const { result, durationMs } = await mcp.callTool(...)` then `tc.durationMs = durationMs`; `onToolCall` at L138, `onToolResult` at L159; the `McpCaller` contract returning `durationMs` at L16–L22.

**File:** `app/api/agent/route.ts`
**Function / class:** `hooksFor` + `send` — span records → streamed trace + capture
**Line range:** `hooksFor` L117–L132 (`tool_call_start` L121–122, `tool_call_end` with `durationMs: tc.durationMs ?? 0` L123–131); `send` L108–L111 (enqueue + `collected.push`); replay branch L63–L81 (`REPLAY_DELAY_MS = 180` at L50); capture at `saveInvestigation(insightId!, collected)` L162.

**File:** `app/api/briefing/route.ts`
**Function / class:** `summarizeTrace`
**Line range:** L13–L21 (maps each span to `{tool, args, ok: !t.error, error, resultPreview}`); span accumulation `agent.scan((tc) => trace.push(tc))` L58; returned on success L66 and on error L72.

**File:** `app/debug/page.tsx`
**Function / class:** `DebugPage` — manual single-call harness
**Line range:** L25–L244 (the page); `durationMs` capture+display L72 and L218–L227; tool listing via `/api/mcp/tools` L80–L108 — exercises one tool call in isolation and shows its duration.

**File:** `lib/state/investigations.ts`
**Function / class:** `getCachedInvestigation` / `saveInvestigation` — trace store + replay source
**Line range:** `getCachedInvestigation` L22–L28 (memory → dev file → demo seed); `saveInvestigation` L30–L41 (stores the full `AgentEvent[]`) — the trace is stored and retrieved as the event list itself.

### What this implements

The codebase has a hand-built, end-to-end trace system: a typed event schema (`events.ts`), span records with durations (`types.ts` + `base.ts`), live streaming of the trace to the UI (`route.ts`), a per-call summary view (`briefing route.ts`), a manual single-call harness (`/debug`), and event-for-event replay from a cache (`investigations.ts`). The trace is captured once (`collected`) and serves live rendering, persistence, and replay.

---

## Elaborate

### Where this pattern comes from

Distributed tracing came from Google's Dapper (2010) and is now codified in **OpenTelemetry**: a trace is a tree of **spans**, each with a start time, duration, attributes, and status, propagated by a trace/span ID. The browser's Performance/Network waterfall is the same model for a page load. **LLM observability** (Langfuse, LangSmith, Arize Phoenix, Helicone) applies tracing to agent runs, where the spans are LLM calls and tool calls and the attributes are tokens, latency, and cost. blooming insights' `tool_call_start`/`tool_call_end{durationMs}` pair is a hand-rolled span; its `AgentEvent` stream is a hand-rolled trace; it just emits the trace as a product-facing NDJSON stream rather than shipping it to a backend collector.

### The deeper principle

```
domain                span = ?              trace = ?              tooling
─────────────────     ──────────────────    ──────────────────    ───────────────
HTTP page load        one request           the waterfall          Network tab
distributed system    one service hop       request across svcs    Dapper / OTel
LLM agent (here)      one tool call          one investigation      AgentEvent stream
                      start+end+durationMs   ordered event list     NDJSON over fetch
```

The abstraction is identical across domains: a timed operation is a span, an ordered set of related spans is a trace, and you read the trace to answer "what ran, how long, what failed." blooming insights instantiates it for agents and makes the unusual choice of rendering the trace *to the user* rather than only to an operator.

### Where this breaks down

1. **No aggregation across runs.** Each trace is captured per investigation, but nothing computes p50/p95 tool latency or error rates across many runs. You can read one trace; you cannot ask "which tool is slowest on average" without a store and a query layer.

2. **Traces are not persisted to a queryable store.** Capture goes to in-memory (`mem` Map) and, in development only, a JSON file (`lib/state/investigations.ts` L7–L9, L30–L41). There is no database, no index, no retention policy — a serverless cold start loses in-memory traces, and you cannot query them by tool, error, or time range.

3. **Replay re-emits the *same* events only.** The replay branch (`route.ts` L63–L81) plays back the stored `AgentEvent[]` verbatim. There is no replay-with-a-different-prompt — you cannot take a captured trace, swap the diagnostic prompt, and re-run the *same inputs* to compare. That capability (counterfactual replay) is exactly what an eval harness needs and is the bridge to `02-eval-methods.md`.

### What to explore next

- **Langfuse / LangSmith integration:** ship the existing `AgentEvent` spans to a platform that gives queryable storage, span aggregation, and cost/token tracking for free.
- **Span aggregation:** persist traces and compute per-tool p50/p95 latency and error rate, so "investigations got slower this week" is answerable.
- **Counterfactual replay:** store the *inputs* (not just the output events) so a trace can be re-run with a different prompt or model — the join point between observability and evals.

---

## Tradeoffs

### Hand-built NDJSON trace (product-facing) vs. a tracing platform vs. plain logs

| Dimension | This codebase (NDJSON AgentEvent stream) | Langfuse/LangSmith platform | Plain `console.log` |
|---|---|---|---|
| Setup cost | Already built — typed union + hooks | SDK + account + instrumentation | Zero |
| User-facing | Yes — the trace IS the UI | No — operator dashboard only | No |
| Span timing | Yes — `durationMs` per call | Yes — automatic | Manual, error-prone |
| Cross-run aggregation | No — one trace at a time | Yes — p50/p95, error rates | No |
| Queryable store | No — in-memory + dev file | Yes — indexed, retained | No |
| Replay | Yes — same events, verbatim | Yes — and counterfactual | No |
| Cost/token tracking | No | Yes — built in | No |

**What we gave up.** Cross-run aggregation and a queryable store. blooming insights can show you one investigation's trace in perfect detail — every step, every duration — but cannot answer "what is the p95 latency of `execute_analytics_eql` across the last 200 runs" because traces are not persisted to anything queryable (`lib/state/investigations.ts` is an in-memory Map plus a dev-only JSON file). It also gave up cost/token visibility — no event carries token counts, so you cannot trace spend per investigation.

**What the alternative would have cost.** A platform (Langfuse) gives aggregation, storage, and cost tracking out of the box — but it is an operator-facing dashboard, not a product surface, and the codebase's central design bet is that the trace *is* the product (the user watches the agent reason and query in real time). Adopting a platform would not replace the NDJSON stream to the UI; it would sit alongside it. Plain logs are free and useless for this — unstructured text cannot be replayed, rendered, or summarized into the per-call table `summarizeTrace` produces.

**The breakpoint.** The hand-built trace is exactly right while the goal is *show the user the work* and *debug one run at a time*. It stops being sufficient the moment you need to answer questions *across* runs — "which tool regressed," "what is our error rate," "where is the latency budget going on average." At that point you must persist traces to a queryable store (or adopt a platform) and add span aggregation; the existing `AgentEvent` schema is already the right shape to ship to one.

**What wasn't actually a tradeoff.** Building the trace by hand did not cost reliability — because timing happens at the single `mcp.callTool` choke-point (`lib/agents/base.ts` L144–L149), every span is instrumented by construction, with no per-call instrumentation to forget. A platform's auto-instrumentation buys the same completeness; the hand-built version achieves it through the funnel.

---

## Tech reference (industry pairing)

### typed trace event schema (`AgentEvent` / NDJSON)

- **Codebase uses:** `AgentEvent` discriminated union (`lib/mcp/events.ts` L4–L12) encoded as NDJSON (`encodeEvent` L15–L17); `ToolCall` span record (`lib/mcp/types.ts` L19–L27).
- **Why it's here:** a typed, streamable schema lets one event list serve live UI, capture, and replay.
- **Leading today:** OpenTelemetry is the adoption-leading trace schema/standard (2026); for LLM specifically, OTel GenAI semantic conventions are emerging.
- **Why it leads:** vendor-neutral span model with broad backend support; instrument once, export anywhere.
- **Runner-up:** proprietary SDK event schemas (LangSmith run trees) — richer LLM-specific fields, vendor-locked.

### span + duration instrumentation

- **Codebase uses:** `durationMs` captured at `lib/agents/base.ts` L144–L149 from `mcp.callTool`'s `{ result, durationMs }` return; surfaced as `tool_call_end{durationMs}` (`events.ts` L7).
- **Why it's here:** per-call latency is the primary debugging signal for a slow run; timing at the choke-point guarantees coverage.
- **Leading today:** OpenTelemetry spans with auto-instrumentation lead for adoption (2026).
- **Why it leads:** automatic start/stop/duration capture with context propagation; no manual timing code.
- **Runner-up:** manual `performance.now()` bracketing — what this codebase effectively does, simpler but per-call.

### LLM observability platform

- **Codebase uses:** none — observability is hand-built and product-facing; no Langfuse/LangSmith/Phoenix.
- **Why it's here (the gap):** there is no queryable trace store, no cross-run aggregation, no token/cost tracking.
- **Leading today:** Langfuse and LangSmith are innovation- and adoption-leading LLM observability platforms (2026); Arize Phoenix leads open-source.
- **Why it leads:** queryable trace storage, span aggregation (p50/p95), cost/token tracking, and eval integration in one place.
- **Runner-up:** Helicone (proxy-based, lowest-friction) and OpenLLMetry (OTel-native LLM tracing).

### trace replay

- **Codebase uses:** event-for-event replay from the investigation cache (`app/api/agent/route.ts` L63–L81, `REPLAY_DELAY_MS=180` L50; store at `lib/state/investigations.ts` L22–L41).
- **Why it's here:** a cached investigation reproduces the agent's visible work without re-calling the model/MCP — fast, free, deterministic demo and debug.
- **Leading today:** platform-backed replay (LangSmith run replay) leads (2026), including counterfactual re-runs with a changed prompt.
- **Why it leads:** stores inputs as well as outputs, enabling re-execution with modified prompts/models, not just verbatim playback.
- **Runner-up:** recorded-fixture replay (VCR-style) — deterministic, but verbatim only, like this codebase.

---

## Project exercises

### Persist traces to an `ai_trace` table

- **Exercise ID:** B3.11 (adapted) — persistent, queryable trace storage, the next hardening step.
- **What to build:** replace (or back) the in-memory + dev-file investigation store with a persisted `ai_trace` table — one row per investigation holding `insightId`, `createdAt`, the full `AgentEvent[]` (or one row per span with `toolName`, `durationMs`, `ok`, `error`), so traces survive cold starts and become queryable. Wire `saveInvestigation` to write rows and `getCachedInvestigation` to read them.
- **Why it earns its place:** demonstrates you turned a per-run product trace into durable, queryable telemetry — the step from "show one run" to "analyze all runs."
- **Files to touch:** `lib/state/investigations.ts` (write/read the table instead of the Map/JSON file), a new `lib/state/db.ts` (connection + schema), `app/api/agent/route.ts` L162 (capture path unchanged in shape).
- **Done when:** completing an investigation writes an `ai_trace` row that survives a process restart, and a query returns all spans for an `insightId` with their `durationMs`.
- **Estimated effort:** 1–2 days

### Add span aggregation (p50/p95 per tool)

- **Exercise ID:** B3.11 (adapted) — cross-run aggregation.
- **What to build:** on top of the persisted `ai_trace` rows, a query/endpoint that computes per-`toolName` p50/p95 `durationMs` and error rate across all stored traces, so "which tool is slowest" and "investigations got slower this week" become answerable.
- **Why it earns its place:** shows you closed the named gap — moving from one-trace-at-a-time to fleet-level latency/error analysis.
- **Files to touch:** `lib/state/db.ts` (aggregation query), a new `app/api/trace-stats/route.ts` (returns the aggregates), optionally a small page that renders them.
- **Done when:** the endpoint returns p50/p95 latency and error rate per tool over the persisted traces, recomputed as new investigations land.
- **Estimated effort:** 1–2 days

### Counterfactual replay (re-run a trace with a different prompt)

- **Exercise ID:** C3.10 (provenance) — the bridge to evals.
- **What to build:** extend the store to capture the *inputs* (the resolved anomaly and MCP context), then add a replay mode that re-runs a stored investigation's inputs through `DiagnosticAgent` with a swapped prompt or model, so a captured trace can be A/B'd against a change — the join point with `02-eval-methods.md`'s pairwise A/B.
- **Why it earns its place:** demonstrates you understand the limit of verbatim replay and built the capability evals actually need (same inputs, changed prompt).
- **Files to touch:** `lib/state/investigations.ts` (store inputs alongside events), `app/api/agent/route.ts` (a `replayWith` mode), reads `lib/agents/prompts/diagnostic.md`.
- **Done when:** a stored investigation can be re-run with an alternate `diagnostic.md` against its original inputs and the two traces compared.
- **Estimated effort:** 1–2 days

---

## Summary

blooming insights already implements LLM observability end to end, by hand. A typed `AgentEvent` union (`lib/mcp/events.ts` L4–L12) is the trace schema; `tool_call_start`/`tool_call_end{durationMs}` is a span; `ToolCall` (`lib/mcp/types.ts` L19–L27) carries the span data; `durationMs` is captured at the single `mcp.callTool` choke-point (`lib/agents/base.ts` L144–L149); `hooksFor`/`send` (`app/api/agent/route.ts` L108–L132) stream the trace live to the UI and capture it; `summarizeTrace` (`app/api/briefing/route.ts` L13–L21) reduces spans to a per-call table; `/debug` exercises one call; and `getCachedInvestigation`/`saveInvestigation` (`lib/state/investigations.ts` L22–L41) make the trace replayable event-for-event. The trace is the product surface — the user watches the work. Absent: a platform (Langfuse), span aggregation, a queryable store, and counterfactual replay.

**Key points:**
- A `tool_call_start`/`tool_call_end{durationMs}` pair is one span; the ordered `AgentEvent` list is the trace — the Network-tab waterfall for an agent.
- Timing at the single `mcp.callTool` choke-point (`base.ts` L144–L149) makes every span instrumented by construction.
- One captured `collected: AgentEvent[]` serves live UI, persistence, and replay.
- Observability here is product-facing — the trace *is* the UI (`route.ts` L117–L132), not an operator dashboard.
- Honest gaps: no platform, no cross-run aggregation, no queryable store, replay is verbatim-only.

---

## Interview defense

### What an interviewer is really asking

"How do you debug an agent run?" tests whether you have made the agent's hidden execution observable. The junior answer is "I add logs." The senior answer is the trace abstraction: typed spans with durations, emitted in order, captured once, serving live UI, debugging, and replay — and an honest account of what is missing (aggregation, a queryable store). The strongest signal is recognizing that this codebase made observability the *product*.

### Likely questions

**[mid] What is a "span" in this codebase and how is it timed?**

A span is one tool call, represented by a `ToolCall` record (`lib/mcp/types.ts` L19–L27) and the `tool_call_start`/`tool_call_end` event pair (`lib/mcp/events.ts` L6–L7). It is timed inside `runAgentLoop` (`lib/agents/base.ts` L144–L149): `mcp.callTool` returns `durationMs` and the loop copies it onto the span. Because every tool call goes through this one loop, every span is timed.

```
tool_call_start → mcp.callTool (durationMs) → tool_call_end{durationMs}
```

**[senior] The same event stream is used three ways. Which three, and how is that possible?**

Live UI, capture/replay, and summarization — from one `collected: AgentEvent[]`. `send` (`route.ts` L108–L111) both enqueues each event to the client stream and pushes it into `collected`; `saveInvestigation` (L162) stores `collected`; the replay branch (L63–L81) re-emits it; and the briefing route's `summarizeTrace` (L13–L21) reduces spans to a per-call table. One capture, three consumers.

```
event → send() ┬→ stream to UI (live)
               └→ collected[] → save → replay  /  summarizeTrace → table
```

**[arch] What can't this observability answer, and what would you add?**

It cannot answer cross-run questions — p95 latency per tool, error rate over time — because traces go to an in-memory Map plus a dev-only JSON file (`lib/state/investigations.ts` L7–L9), not a queryable store, and nothing aggregates across runs. I would persist to an `ai_trace` table and add per-tool p50/p95 aggregation. Replay is also verbatim-only; counterfactual replay (same inputs, swapped prompt) is the bridge to evals.

```
have: one trace, in detail        need: persist → aggregate p50/p95
have: verbatim replay             need: counterfactual replay (eval bridge)
```

### The question candidates always dodge

**"Your trace is shown to the user — isn't that leaking internals?"** The honest answer is that it is a deliberate product bet, not an accident, and it has a real cost: the streamed `tool_call_end` carries `result` (truncated via `trunc`, `route.ts` L44–L48, L129) and tool names, so the user sees which Bloomreach tools ran and a preview of what they returned. That is fine for an internal analyst tool where transparency builds trust, but it would be a data-exposure decision to revisit if the product served untrusted users — you would render reasoning steps but redact tool results and names. Recognizing the trace-as-UI choice as a *security-relevant product decision*, not a free win, is the senior signal.

### One-line anchors

- `tool_call_start`/`tool_call_end{durationMs}` (`events.ts` L6–L7) = one span with timing.
- `durationMs` captured at the choke-point `base.ts` L144–L149 → every span timed by construction.
- `send` (`route.ts` L108–L111) streams *and* captures; one `collected[]` serves UI, replay, summary.
- `summarizeTrace` (`briefing route.ts` L13–L21) reduces spans to a per-call diagnostic table.
- Gaps: no platform, no cross-run aggregation, no queryable store, replay is verbatim-only.

---

## Validate

### Level 1 — Reconstruct

From memory, draw the agent trace as a span timeline: a root (the investigation), child spans (tool calls) each with a `durationMs`, and annotations (reasoning steps) between them. Name the two event types that bracket a span and the field that carries its duration.

### Level 2 — Explain

Out loud: how does one captured `AgentEvent[]` serve three jobs — live UI, replay, and summarization? Walk through what `send` (`app/api/agent/route.ts` L108–L111) does on every event.

### Level 3 — Apply

Scenario: an investigation feels slow and you need to find which tool call is the bottleneck. Open `lib/agents/base.ts` L144–L149 and `lib/mcp/events.ts` L7 — explain where the per-call duration is captured and which event carries it to where you would read it. Then explain why you *cannot* currently answer "is this tool usually this slow" (cite `lib/state/investigations.ts` L7–L9).

### Level 4 — Defend

A colleague says "drop the custom NDJSON trace and just add Langfuse." Argue what Langfuse gives you (aggregation, queryable storage, cost tracking) and what it does *not* replace (the trace-as-UI product surface streamed to the user). State the condition under which you would add Langfuse *alongside* — not instead of — the NDJSON stream.

### Quick check — code reference test

Where is a tool call's `durationMs` captured, and why does capturing it there guarantee every span in the trace is timed? (Answer: at `lib/agents/base.ts` L144–L149, inside `runAgentLoop`'s per-tool block, from `mcp.callTool`'s `{ result, durationMs }` return — and because every agent's tool calls flow through this single loop, every span is timed by construction, with no per-call instrumentation to forget.)

# LLM observability (traces, spans, and replay)

**Industry name(s):** LLM observability, tracing / distributed tracing, spans, trace replay, agent telemetry
**Type:** Industry standard · Language-agnostic

> Every blooming insights investigation already emits a live trace — an NDJSON stream of `reasoning_step` / `tool_call_start` / `tool_call_end{durationMs}` events that the UI renders as the agent's visible work (a sticky `StatusLog` sidebar on both investigate steps, an inline panel on the feed, each row timestamped and the reasoning text pretty-printed by `TraceContent`), the briefing route narrates per tool call with `describeToolCall`, the `/debug` page exercises one call at a time, and the investigation cache replays event-for-event. The trace is not an add-on; it is the product surface.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Observability is cross-cutting *and* it spans every band of the live request flow. Each agent's `runAgentLoop` emits typed events (`reasoning_step`, `tool_call_start`, `tool_call_end` with `durationMs`) via hooks; the Route's `send` choke-point in `ReadableStream.start` (`app/api/agent/route.ts` L172–L175) records them and enqueues NDJSON; the UI renders them as they arrive. The trace is not a backend log you grep — it is the thing the user watches.

```
  Zoom out — the trace runs alongside every layer

  ┌─ UI (renders the trace live) ────────────────────┐
  │  useInvestigation hook: per-event React state     │
  └─────────────────────────▲────────────────────────┘
                            │  NDJSON
  ┌─ Route handler (frames events) ──────────────────┐
  │  send(e) → collected.push + controller.enqueue    │
  │  route.ts L172–175                                │
  └─────────────────────────▲────────────────────────┘
                            │
  ┌─ Per-agent + Agent loop (emits events) ──────────┐  ← we are here
  │  ★ hooksFor: onText/onToolCall/onToolResult ★     │
  │  reasoning_step + tool_call_start +               │
  │  tool_call_end{durationMs}                        │
  │  lib/mcp/events.ts (the event vocabulary)         │
  └─────────────────────────▲────────────────────────┘
                            │
  ┌─ Provider + Tools ──────┴────────────────────────┐
  │  per-tool timing measured here                    │
  └──────────────────────────────────────────────────┘

  blooming insights does NOT export to OpenTelemetry,
  Langfuse, or Datadog. The trace is the UI; persistence
  is the cache snapshot (saveInvestigation). Backend-grade
  observability is the gap.
```

**Zoom in — narrow to the concept.** The question is: how do you make an agent's hidden multi-step execution visible — what it decided, which tools it called, how long each took, what it concluded — so you can debug a bad run and show a user the work? An agent without a trace is a black box you cannot debug and the user cannot trust. blooming insights treats the trace as a first-class output, streaming it as the agent runs, which is the same network-tab instinct applied to a typed event union over NDJSON. How it works walks the event vocabulary, the `durationMs` on each tool span, and what would change to export the trace to a real observability backend.

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

Two types carry the span and annotation payloads. `ToolCall` (`lib/mcp/types.ts` L34–L42) is the span record:

```
ToolCall (types.ts L34–L42)            ReasoningStep (types.ts L44–L50)
─────────────────────────────────     ─────────────────────────────────
id: string                            id: string
agent: AgentName                      agent: AgentName
toolName: string                      kind: 'thought' | 'tool_call'
args: Record<string, unknown>               | 'hypothesis' | 'conclusion'
result?: unknown                      content: string
durationMs?: number   ← the timing    toolCall?: ToolCall
error?: string
```

`ToolCall` is the span: identity (`id`), the operation (`toolName`, `args`), the outcome (`result` or `error`), and the duration (`durationMs`). `ReasoningStep` is the annotation: a typed `kind` (`thought`/`tool_call`/`hypothesis`/`conclusion`, L47) plus `content`. Together they are the trace's vocabulary — spans and the reasoning between them.

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

`app/api/agent/route.ts` is where the span records become a streamed trace. `hooksFor(agent)` (L181–L195) wires the loop's callbacks to `send()` calls that enqueue NDJSON events:

```
route.ts L181–L195  (hooksFor)
─────────────────────────────────────────────────────────────
onText       → reasoning_step {kind:'thought'}      (L182–184)
onToolCall   → tool_call_start {toolName, agent}    (L185)      span OPEN
onToolResult → tool_call_end {toolName, agent,      (L186–194)  span CLOSE
                 durationMs: tc.durationMs ?? 0,
                 result: trunc(tc.result), error}
```

`send` (L172–L175) does two things on every event: pushes it into a `collected` array (L173) *and* enqueues it onto the `ReadableStream` (L174). So the trace streams to the client live (the user watches the agent work — this is the ReAct-rendered-as-UI pattern, `../04-agents-and-tool-use/03-react-pattern.md`) and is simultaneously captured for storage. The client reads the NDJSON over a `fetch` body reader (the `useInvestigation` hook, next section) and renders each event as it arrives. Observability here is not a sidecar dashboard — it is the primary UI.

### Trace narration in the briefing route (`describeToolCall`)

The briefing route streams the *same* span events as `/api/agent` but adds one observability touch: it labels each tool call with the real query the agent ran rather than the bare tool name. `describeToolCall(tc)` (`app/api/briefing/route.ts` L28–L33) pulls the EQL/query text out of the call's args:

```
describeToolCall (briefing route.ts L28–L33)
─────────────────────────────────────────────────────────────
a = tc.args
q = a.eql ?? a.query ?? a.analysis ?? a.expression
text = (typeof q === 'string' && q.trim()) ? q.trim() : tc.toolName
return text.length > 120 ? text.slice(0,117)+'…' : text
```

It is wired into the monitoring scan's `onToolCall` hook (L110–L113): each tool call emits a `tool_call_start` span event *and* a `reasoning_step` whose content is the human-readable query (`step(describeToolCall(tc))`). The `onToolResult` hook (L114–L122) closes the span with `tool_call_end{durationMs, result: trunc(tc.result), error}`. So the briefing trace is the same span stream as `/api/agent`, with the live status line showing the real EQL the agent issued — the "how this briefing was gathered" view on the feed. (There is no longer a separate `summarizeTrace` reduction; the trace is the per-event stream, narrated in place.)

### The trace's rendering surface (the UI components + the hook)

The client side of the trace is four pieces that turn the NDJSON span stream into the visible "work."

**`useInvestigation` (`lib/hooks/useInvestigation.ts`)** is the stream reader. It opens `GET /api/agent?insightId=…&step=…`, reads the NDJSON body line by line (L184–L201), and on each `AgentEvent` mutates a `TraceItem[]`: a `reasoning_step` pushes a `step` item, a `tool_call_start` pushes a `tool` item with `status:'running'`, and a `tool_call_end` flips the matching running tool to `done` with its `durationMs`/`result`/`error` (`replaceRunningTool`, L86–L95). It stamps each item with `ts: Date.now()` as it arrives (L106, L113) and stashes the finished trace in `sessionStorage` (L132–L143) so a re-visit hydrates instantly. The hook is **StrictMode-safe by design**: a `startedRef` guard runs the fetch once per mount, and it deliberately does *not* cancel the fetch on effect cleanup — the comment at L31–L36 records why (StrictMode's mount → cleanup → re-mount, combined with the started-guard, otherwise aborts the stream and leaves the logs empty; setState-after-unmount is a safe no-op).

**`StatusLog` (`components/shared/StatusLog.tsx`)** is the sticky-sidebar wrapper shown on **both investigate steps** (`app/investigate/[id]/page.tsx` L214, `…/recommend/page.tsx` L181), titled "how this was figured out." It renders the `TraceItem[]` through `ReasoningTrace`, with a `scanning` progress bar and an `emptyMessage` while the stream is still connecting. The **feed** (`app/page.tsx` L744) renders the same `ReasoningTrace` directly in an inline "how this briefing was gathered" panel rather than the `StatusLog` chrome — so the *trace component* is shared across feed and investigate, while `StatusLog` itself is the investigate-step sidebar.

**`ReasoningTrace` (`components/investigation/ReasoningTrace.tsx`)** renders the timeline and owns the `TraceItem` type (exported at L6–L24 — there is no separate `TraceItem.ts`; `StatusLog`, `useInvestigation`, the feed, and the markdown exporter all import the type from here). Each item now carries an optional `ts?` (epoch ms, L13/L23); `fmtTs` (L39–L46) renders it as a `HH:MM:SS` log timestamp beside each step (L87–L89) and each tool block (L95) — so the trace reads like a timestamped log, not an undated list.

**`TraceContent` (`components/investigation/TraceContent.tsx`)** pretty-prints each reasoning step's `content`. It splits on ` ```lang … ``` ` fences (L104), pretty-prints fenced JSON in a scrollable code box (`prettyIfJson`, L93–L100), and renders the prose between fences as light markdown — `**bold**` and `` `inline code` `` via `renderInline` (L34–L53) and `- ` bullets grouped into a `<ul>` via `Prose` (L56–L91). This is a deliberately tiny renderer (no markdown dependency). Note for the threat model: this renders **model-authored** reasoning text — it is an output-rendering surface, but a safe one (React text nodes / `<strong>` / `<code>` / `<li>`; **no `dangerouslySetInnerHTML`**), so the agent's text cannot inject markup. See `../06-production-serving/03-prompt-injection.md`.

### Trace replay from the cache (`lib/state/investigations.ts`)

The captured event list is also the unit of replay. `saveInvestigation(insightId, collected)` (`lib/state/investigations.ts` L30–L41, called at `route.ts` L254) stores the full `AgentEvent[]` for an investigation; `getCachedInvestigation(insightId)` (L22–L28) retrieves it. On a cache hit, the route *re-streams the stored events* (`route.ts` L127–L141) with a small delay between them:

```
trace replay (route.ts L127–L141)
─────────────────────────────────────────────────────────────
cached = getCachedInvestigation(insightId)        ← stored AgentEvent[]
for (const e of cached) {
  controller.enqueue(encodeEvent(e))              ← re-emit each event
  await sleep(REPLAY_DELAY_MS)                     ← 180ms (L105), paced
}
```

This is trace replay in the literal sense: the exact event sequence a live run produced is played back event-for-event, so a cached investigation reproduces the original agent's visible work without re-calling the model or MCP. The trace is stored as the trace, retrieved as the trace, and replayed as the trace.

### Current state vs. future state

```
PRESENT (Case A — implemented)            ABSENT (honest gaps)
──────────────────────────────────        ──────────────────────────────────
typed event union (events.ts L4–12)        no Langfuse/LangSmith/Phoenix
span start/end + durationMs (base L144)     no third-party trace platform
live NDJSON stream to UI (route L181)       no span aggregation (p50/p95)
timestamped StatusLog + TraceContent        no queryable trace store
manual /debug harness (debug page)          traces not persisted to a DB
event-for-event replay (investig. L22–41)   replay re-emits SAME events only —
                                             no replay-with-a-different-prompt
```

blooming insights has the *shape* of observability — typed spans, durations, a live trace, replay — built by hand. What it lacks is the *infrastructure* around it: a platform, persistence to a queryable store, and aggregate metrics across runs.

### The principle

An agent's execution is a tree of timed operations, and the way to make it debuggable and trustworthy is to emit that tree as a typed, ordered stream of span and annotation events — the same trace abstraction the browser Network tab gives you for HTTP. Capture the stream once and it serves three jobs: live UI (the user watches, each line timestamped and the reasoning pretty-printed), debugging (the per-call durations and the briefing's `describeToolCall` status line), and replay (re-emit the stored events). The discipline that makes this work is timing at a single choke-point so no span is ever un-instrumented.

---

## LLM observability — diagram

This diagram spans the Service layer (where spans are created and timed), the State layer (where the trace is captured and replayed), and the UI layer (where the live trace renders). A reader who sees only this should grasp that one captured event stream serves live rendering, per-call narration, and replay.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER  (lib/agents/base.ts — runAgentLoop)                 │
│                                                                       │
│   for each tool_use:                                                   │
│     { result, durationMs } = await mcp.callTool(...)   ← L144         │
│     tc.durationMs = durationMs                          ← L149  SPAN   │
│     onToolCall(tc)   / onToolResult(tc)                ← L138 / L159  │
└────────────────────────────────┬──────────────────────────────────────┘
                                 │ hooks → events (route.ts L181–195)
┌────────────────────────────────▼──────────────────────────────────────┐
│  EVENT SCHEMA  (lib/mcp/events.ts L4–22)                            │
│   AgentEvent union: reasoning_step | tool_call_start |                 │
│                     tool_call_end{durationMs} | diagnosis | done       │
│   encodeEvent = JSON + '\n'  (NDJSON, one event per line)             │
└──────────┬───────────────────────────────────┬───────────────────────┘
           │ send() pushes BOTH ways (route L172–175)                    │
   ┌───────▼────────────────────┐     ┌────────▼───────────────────────┐
   │  STATE LAYER (capture)     │     │  UI LAYER (live)               │
   │  collected: AgentEvent[]   │     │  useInvestigation reads NDJSON │
   │  saveInvestigation L30–41  │     │  → TraceItem[] (timestamped) → │
   │    (route.ts L254)         │     │  StatusLog/ReasoningTrace/      │
   │                            │     │  TraceContent (the visible work)│
   └───────┬────────────────────┘     └────────────────────────────────┘
           │ getCachedInvestigation L22–28
   ┌───────▼─────────────────────────────────────────────────────────┐
   │  REPLAY  (route.ts L127–141)                                      │
   │  re-emit stored events, paced REPLAY_DELAY_MS=180 (L105)          │
   └──────────────────────────────────────────────────────────────────┘

   SECONDARY VIEWS:
   describeToolCall (briefing route.ts L28–33) → live status = real EQL
   /debug (app/debug/page.tsx) → one manual tool call, shows durationMs L253–261
```

One captured `AgentEvent[]` stream feeds three consumers — the live UI (read by `useInvestigation` into a timestamped `TraceItem[]`, rendered by `StatusLog`/`ReasoningTrace`/`TraceContent`), the cache/replay, and (in the briefing route) the per-call `describeToolCall` status line. Every span is timed at the single `mcp.callTool` choke-point, so the trace is complete by construction.

---

## Implementation in codebase

### Files, functions, and line ranges

**File:** `lib/mcp/events.ts`
**Function / class:** `AgentEvent` union; `encodeEvent` / `decodeEvent`
**Line range:** union L4–L12 (`tool_call_start` L6, `tool_call_end{durationMs,result?,error?}` L7); `encodeEvent` L15–L17 (`JSON.stringify(e)+'\n'`); `decodeEvent` L20–L22 — the trace schema and NDJSON codec.

**File:** `lib/mcp/types.ts`
**Function / class:** `ToolCall` (the span record); `ReasoningStep` (the annotation)
**Line range:** `ToolCall` L34–L42 (`durationMs?` at L40, `result?` L39, `error?` L41); `ReasoningStep` L44–L50 (`kind` union L47) — the span and annotation payloads.

**File:** `lib/agents/base.ts`
**Function / class:** `runAgentLoop` — per-tool timing capture
**Line range:** L144–L149 — `const { result, durationMs } = await mcp.callTool(...)` then `tc.durationMs = durationMs`; `onToolCall` at L138, `onToolResult` at L159; the `McpCaller` contract returning `durationMs` at L16–L22. (Unchanged.)

**File:** `app/api/agent/route.ts`
**Function / class:** `hooksFor` + `send` — span records → streamed trace + capture
**Line range:** `hooksFor` L181–L195 (`tool_call_start` L185, `tool_call_end` with `durationMs: tc.durationMs ?? 0` L186–194); `send` L172–L175 (enqueue L174 + `collected.push` L173); replay branch L127–L141 (`REPLAY_DELAY_MS = 180` at L105); capture at `saveInvestigation(insightId!, collected)` L254.

**File:** `app/api/briefing/route.ts`
**Function / class:** `describeToolCall` — labels each span with the real EQL/query text
**Line range:** L28–L33 (prefers `args.eql/query/analysis/expression`, else `toolName`, truncated to 120 chars); wired into the scan's `onToolCall` at L110–L113 (emits `tool_call_start` + a `reasoning_step` of the query) and `onToolResult` at L114–L122 (closes `tool_call_end`). There is no `summarizeTrace` reduction — the trace is the per-event stream.

**File:** the trace's UI surface
**Function / class:** `useInvestigation` hook + `StatusLog` / `ReasoningTrace` / `TraceContent`
**Line range:** `lib/hooks/useInvestigation.ts` reads NDJSON into a `TraceItem[]` (L97–L151), stamps each item `ts: Date.now()` (L106, L113), StrictMode-safe single-run with no cancel-on-cleanup (`startedRef` L43/L47, comment L31–L36); `TraceItem` is exported from `components/investigation/ReasoningTrace.tsx` L6–L24 (`ts?` at L13/L23, `fmtTs` L39–L46 renders `HH:MM:SS`); `StatusLog` (`components/shared/StatusLog.tsx`) is the sticky sidebar on both investigate steps (`app/investigate/[id]/page.tsx` L214, `…/recommend/page.tsx` L181), the feed (`app/page.tsx` L744) renders `ReasoningTrace` inline; `TraceContent` (`components/investigation/TraceContent.tsx`) pretty-prints fenced JSON (L93–L100, L104) and renders `**bold**`/`` `code` ``/bullets (L34–L91) — React text nodes only, no `dangerouslySetInnerHTML`.

**File:** `app/debug/page.tsx`
**Function / class:** `DebugPage` — manual single-call harness
**Line range:** L25–L279 (the page); `durationMs` capture L72, display L253–L261; tool listing via `/api/mcp/tools` L86 — exercises one tool call in isolation and shows its duration.

**File:** `lib/state/investigations.ts`
**Function / class:** `getCachedInvestigation` / `saveInvestigation` — trace store + replay source
**Line range:** `getCachedInvestigation` L22–L28 (memory → dev file → demo seed); `saveInvestigation` L30–L41 (stores the full `AgentEvent[]`) — the trace is stored and retrieved as the event list itself.

### What this implements

The codebase has a hand-built, end-to-end trace system: a typed event schema (`events.ts`), span records with durations (`types.ts` + `base.ts`), live streaming of the trace to the UI (`route.ts`) rendered by the `useInvestigation` hook into a timestamped `StatusLog`/`ReasoningTrace`/`TraceContent` view, a per-call query-narration line in the briefing route (`describeToolCall`), a manual single-call harness (`/debug`), and event-for-event replay from a cache (`investigations.ts`). The trace is captured once (`collected`) and serves live rendering, persistence, and replay.

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

3. **Replay re-emits the *same* events only.** The replay branch (`route.ts` L127–L141) plays back the stored `AgentEvent[]` verbatim. There is no replay-with-a-different-prompt — you cannot take a captured trace, swap the diagnostic prompt, and re-run the *same inputs* to compare. That capability (counterfactual replay) is exactly what an eval harness needs and is the bridge to `02-eval-methods.md`.

### What to explore next

- **Langfuse / LangSmith integration:** ship the existing `AgentEvent` spans to a platform that gives queryable storage, span aggregation, and cost/token tracking for free.
- **Span aggregation:** persist traces and compute per-tool p50/p95 latency and error rate, so "investigations got slower this week" is answerable.
- **Counterfactual replay:** store the *inputs* (not just the output events) so a trace can be re-run with a different prompt or model — the join point between observability and evals.

---

## Project exercises

### Persist traces to an `ai_trace` table

- **Exercise ID:** B3.11 (adapted) — persistent, queryable trace storage, the next hardening step.
- **What to build:** replace (or back) the in-memory + dev-file investigation store with a persisted `ai_trace` table — one row per investigation holding `insightId`, `createdAt`, the full `AgentEvent[]` (or one row per span with `toolName`, `durationMs`, `ok`, `error`), so traces survive cold starts and become queryable. Wire `saveInvestigation` to write rows and `getCachedInvestigation` to read them.
- **Why it earns its place:** demonstrates you turned a per-run product trace into durable, queryable telemetry — the step from "show one run" to "analyze all runs."
- **Files to touch:** `lib/state/investigations.ts` (write/read the table instead of the Map/JSON file), a new `lib/state/db.ts` (connection + schema), `app/api/agent/route.ts` L254 (capture path unchanged in shape).
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

## Interview defense

### What an interviewer is really asking

"How do you debug an agent run?" tests whether you have made the agent's hidden execution observable. The junior answer is "I add logs." The senior answer is the trace abstraction: typed spans with durations, emitted in order, captured once, serving live UI, debugging, and replay — and an honest account of what is missing (aggregation, a queryable store). The strongest signal is recognizing that this codebase made observability the *product*.

### Likely questions

**[mid] What is a "span" in this codebase and how is it timed?**

A span is one tool call, represented by a `ToolCall` record (`lib/mcp/types.ts` L34–L42) and the `tool_call_start`/`tool_call_end` event pair (`lib/mcp/events.ts` L6–L7). It is timed inside `runAgentLoop` (`lib/agents/base.ts` L144–L149): `mcp.callTool` returns `durationMs` and the loop copies it onto the span. Because every tool call goes through this one loop, every span is timed.

```
tool_call_start → mcp.callTool (durationMs) → tool_call_end{durationMs}
```

**[senior] The same event stream is used three ways. Which three, and how is that possible?**

Live UI, capture/replay, and per-call narration — from one `collected: AgentEvent[]`. `send` (`route.ts` L172–L175) both enqueues each event to the client stream and pushes it into `collected`; `saveInvestigation` (L254) stores `collected`; the replay branch (L127–L141) re-emits it; and the briefing route's `describeToolCall` (L28–L33) labels each tool-call event with the real query. One capture, three consumers.

```
event → send() ┬→ stream to UI (live)
               └→ collected[] → save → replay  /  describeToolCall → status line
```

**[arch] What can't this observability answer, and what would you add?**

It cannot answer cross-run questions — p95 latency per tool, error rate over time — because traces go to an in-memory Map plus a dev-only JSON file (`lib/state/investigations.ts` L7–L9), not a queryable store, and nothing aggregates across runs. I would persist to an `ai_trace` table and add per-tool p50/p95 aggregation. Replay is also verbatim-only; counterfactual replay (same inputs, swapped prompt) is the bridge to evals.

```
have: one trace, in detail        need: persist → aggregate p50/p95
have: verbatim replay             need: counterfactual replay (eval bridge)
```

### The question candidates always dodge

**"Your trace is shown to the user — isn't that leaking internals?"** The honest answer is that it is a deliberate product bet, not an accident, and it has a real cost: the streamed `tool_call_end` carries `result` (truncated via `trunc`, `route.ts` L99–L103, applied in `hooksFor` at L192) and tool names, so the user sees which Bloomreach tools ran and a preview of what they returned. The reasoning text the agent emits is additionally re-rendered as light markdown/JSON by `TraceContent` — a model-authored output surface, but a safe one (React text nodes, no `dangerouslySetInnerHTML`). That is fine for an internal analyst tool where transparency builds trust, but it would be a data-exposure decision to revisit if the product served untrusted users — you would render reasoning steps but redact tool results and names. Recognizing the trace-as-UI choice as a *security-relevant product decision*, not a free win, is the senior signal.

### One-line anchors

- `tool_call_start`/`tool_call_end{durationMs}` (`events.ts` L6–L7) = one span with timing.
- `durationMs` captured at the choke-point `base.ts` L144–L149 → every span timed by construction.
- `send` (`route.ts` L172–L175) streams *and* captures; one `collected[]` serves UI, replay, narration.
- `describeToolCall` (`briefing route.ts` L28–L33) labels each tool-call span with the real EQL/query text.
- `useInvestigation` reads the NDJSON into a timestamped `TraceItem[]`; `StatusLog`/`ReasoningTrace`/`TraceContent` render it.
- Gaps: no platform, no cross-run aggregation, no queryable store, replay is verbatim-only.

---

## Validate

### Level 1 — Reconstruct

From memory, draw the agent trace as a span timeline: a root (the investigation), child spans (tool calls) each with a `durationMs`, and annotations (reasoning steps) between them. Name the two event types that bracket a span and the field that carries its duration.

### Level 2 — Explain

Out loud: how does one captured `AgentEvent[]` serve three jobs — live UI, replay, and per-call narration? Walk through what `send` (`app/api/agent/route.ts` L172–L175) does on every event.

### Level 3 — Apply

Scenario: an investigation feels slow and you need to find which tool call is the bottleneck. Open `lib/agents/base.ts` L144–L149 and `lib/mcp/events.ts` L7 — explain where the per-call duration is captured and which event carries it to where you would read it. Then explain why you *cannot* currently answer "is this tool usually this slow" (cite `lib/state/investigations.ts` L7–L9).

### Level 4 — Defend

A colleague says "drop the custom NDJSON trace and just add Langfuse." Argue what Langfuse gives you (aggregation, queryable storage, cost tracking) and what it does *not* replace (the trace-as-UI product surface streamed to the user). State the condition under which you would add Langfuse *alongside* — not instead of — the NDJSON stream.

### Quick check — code reference test

Where is a tool call's `durationMs` captured, and why does capturing it there guarantee every span in the trace is timed? (Answer: at `lib/agents/base.ts` L144–L149, inside `runAgentLoop`'s per-tool block, from `mcp.callTool`'s `{ result, durationMs }` return — and because every agent's tool calls flow through this single loop, every span is timed by construction, with no per-call instrumentation to forget.)

## See also

→ 01-eval-set-types.md · → 02-eval-methods.md · → ../04-agents-and-tool-use/03-react-pattern.md · → ../01-llm-foundations/05-streaming.md · → ../06-production-serving/01-caching.md

---
Updated: 2026-05-28 — Replaced the dead `summarizeTrace` view with the real briefing narration (`describeToolCall`, route L28–L33); documented the grown UI surface (StatusLog sticky sidebar on both investigate steps, ReasoningTrace per-line timestamps via the `TraceItem` type in ReasoningTrace.tsx, TraceContent markdown/JSON renderer with no `dangerouslySetInnerHTML`, the StrictMode-safe `useInvestigation` hook); re-derived all route.ts/types.ts/investigations.ts refs. NDJSON + AgentEvent contract unchanged.
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.

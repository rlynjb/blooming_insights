# Observability map

**Industry name(s):** observability map, evidence map, signal inventory
**Type:** Language-agnostic

> The map answers one question per layer: when something goes wrong here, what evidence do I have? blooming insights' answer is uneven — strong at the agent layer (full NDJSON trace), thin at the network edge (4× `console.error`), nonexistent at the metrics aggregator (no aggregator). Name them all in one picture, then read each section against this map.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** The map is the whole system, banded by layer, with one annotation per band: what can you actually observe here? You're going to read every other concept file against this picture, so the map gets one whole file to itself.

```
  Zoom out — the bigger picture

  ┌─ UI layer ───────────────────────────────────────┐
  │  ReactDOM · ReasoningTrace · StatusLog            │
  │  evidence: rendered trace items + browser devtools│
  └─────────────────────────▲────────────────────────┘
                            │ NDJSON over HTTP
  ┌─ Route handler layer ───┴────────────────────────┐
  │  /api/agent · /api/briefing                       │
  │  evidence: console.error in catch, NDJSON trace   │
  └─────────────────────────▲────────────────────────┘
                            │ in-process calls
  ┌─ Agent loop layer ──────┴────────────────────────┐
  │  runAgentLoop · hooks: onText/onToolCall/         │
  │    onToolResult                                   │
  │  ★ evidence: AgentEvent stream (the spine) ★      │ ← we are here
  └─────────────────────────▲────────────────────────┘
                            │ awaited calls
  ┌─ MCP client layer ──────┴────────────────────────┐
  │  McpClient.callTool · rate-limit + retry          │
  │  evidence: durationMs, fromCache, McpToolError    │
  └─────────────────────────▲────────────────────────┘
                            │ network
  ┌─ Provider layer ────────┴────────────────────────┐
  │  Anthropic SDK · Bloomreach MCP server            │
  │  evidence: nothing the repo owns (their logs)     │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The map is not just a stack diagram. It's a *promise* about each layer: what's observable, what isn't, what the dominant evidence shape is. Read it left-to-right (live, transient) and top-to-bottom (UI down to provider). The strength of any debugging session you ever run on this repo will be set by how many bands have evidence — not by how clever you are.

---

## Structure pass

**Layers.** Five: UI, route handler, agent loop, MCP client, provider. They stack — each layer calls the one below and bubbles results up. The trace flows up; errors propagate up; cache snapshots fan sideways out of the route handler.

**Axis: state ownership (of the evidence).** *Where does the evidence live, and how long does it survive?* This is the axis that makes the map's strengths and gaps pop. Trace items live in the browser process (React state) and the server process (the `collected[]` array inside the stream's `start`). The cache snapshot lives in mem and `.investigation-cache.json` (dev) or `lib/state/demo-investigations.json` (committed). Logs live in Vercel's stdout retention (configurable, default short). Metrics… don't live anywhere — `durationMs` is in the event payload, then nowhere.

**Seams.** Two are load-bearing:

- **Agent loop ↔ route handler.** Hooks (`onText`/`onToolCall`/`onToolResult`) flip from "in-process callback" to "framed NDJSON line." This is where the trace becomes a transport-able artifact.
- **Route handler ↔ cache snapshot.** `collected[]` flips from "ephemeral, in-memory" to "persistent, replayable" via `saveInvestigation`. Without this flip, the trace would die with the request.

A cosmetic seam: UI ↔ route handler. Same NDJSON on both sides; React just calls `JSON.parse` per line.

A *missing* seam, named for honesty: agent loop ↔ external sink. There's nothing here. No OTel exporter, no Sentry shim, no Langfuse client. This is the gap `08-debugging-observability-red-flags-audit.md` ranks first.

```
  Structure pass — observability map

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  UI · Route · Agent loop · MCP client ·        │
  │  Provider                                      │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  state ownership of the evidence: where does   │
  │  it live and how long does it survive?         │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  agent↔route:  in-process → NDJSON (load)     │
  │  route↔cache: ephemeral → persistent (load)   │
  │  UI↔route:    cosmetic (same shape)           │
  │  agent↔sink:  MISSING (the gap)               │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

Skeleton mapped. Now walk the layers in order.

---

## How it works

**Mental model.** You know how a browser's network tab lays out every request as a row with a status, a timing, and a payload you can expand? An observability map is that — but for the whole system, not just the network. Each layer is a row, each row names its evidence shape, and the rows where there's no row are the gaps. Sketch it once, then read every bug, every alert, every "is this working?" question against it.

```
  Pattern — the observability map

   layer        │  evidence shape       │  lifetime
   ─────────────┼──────────────────────┼────────────
   UI           │  rendered DOM         │  page open
   route        │  NDJSON stream + log  │  request
   agent        │  AgentEvent[]         │  request
   mcp client   │  durationMs, error    │  per call
   provider     │  ─                    │  ─
```

The diagram is the concept. The rest of this section reads each row.

### Move 2 — walk the layers

#### UI layer — evidence: rendered trace + devtools

The reader anchor: you've debugged a React app. You open devtools, you look at React state, you see what props are flowing. Same here, with one bonus: the trace is rendered as visible UI (not a hidden log), so you don't need devtools to read it — you read the page.

What happens: `useInvestigation` accumulates `TraceItem[]` in React state as NDJSON lines arrive; `<ReasoningTrace items={items} />` renders them with timestamps and agent badges; `<ToolCallBlock>` shows each tool span with its `durationMs` and result. The user-visible "statuses & logs" sidebar IS the trace.

Boundary: if React state corrupts (e.g. the hook bails on a bad line), the trace silently truncates. The `JSON.parse` try/catch ignores malformed lines. There's no UI surface for "1 trace line was dropped."

```
  UI layer — what you can see, from where

  ┌─ browser process ────────────────────────────────┐
  │  React state (TraceItem[])  ← live, per-mount     │
  │  rendered DOM (ReasoningTrace)                    │
  │  network tab (the NDJSON wire bytes)              │
  │  devtools console (React errors)                  │
  └───────────────────────────────────────────────────┘
  lifetime: while the page is mounted
```

#### Route handler layer — evidence: NDJSON + 2 catch logs

The reader anchor: you've written an Express handler that catches an error and `console.log`s it. Same shape — there are exactly two of these per route.

What happens: the route opens a `ReadableStream`, defines `send(e)`, and emits typed `AgentEvent`s as the agents work. Two error paths exist: a setup throw before the stream opens (returns JSON), and a stream-time throw caught inside `start()` (logs to `console.error`, emits an `error` event to the client). That's the entire backend log surface for the agent and briefing routes.

Boundary: a throw *outside* the `try` (e.g. inside `controller.close()` itself) is uncaught — Vercel's runtime swallows it. No structured logger means no log level, no correlation ID across requests, no redaction of PII or tokens.

```
  Route handler layer — what survives the request

  ┌─ Vercel function instance ──────────────────────┐
  │  console.error('[agent] error:', e)              │  ← stdout, retention = Vercel default
  │  send({type:'error', message})                   │  ← line on the wire
  │  collected: AgentEvent[]                         │  ← captured for saveInvestigation
  └──────────────────────────────────────────────────┘
  lifetime: log = retention window; collected = until saveInvestigation
```

#### Agent loop layer — evidence: AgentEvent[] (the spine)

The reader anchor: you've used React's `useState` setter callbacks — `onChange={...}` is a hook called on each interaction. `runAgentLoop` takes three of them — `onText` / `onToolCall` / `onToolResult` — and calls them on each step of the model + tool loop. The agent doesn't "log"; it emits events through hooks.

What happens: every text block from Claude becomes a `reasoning_step`; every tool_use block becomes `tool_call_start` + `tool_call_end` with `durationMs` from the McpClient's wall-clock measurement. The hooks are agent-agnostic — `hooksFor(agent)` in the route just labels each event with `agent: 'diagnostic'` / `'recommendation'` / etc. so the UI can render an agent badge per line.

Boundary: the hooks fire synchronously inside the loop. A slow hook = a slow agent. There's no buffering, no backpressure, no async dispatch. In practice the hooks are append-to-array, so this is fine; if you ever shoved them into a network call, you'd block the loop.

```
  Agent loop layer — the trace spine

  agent step                hook called          event emitted
  ──────────────────        ─────────────        ──────────────────────────
  Claude returns text       onText               reasoning_step {thought}
  Claude wants a tool       onToolCall           tool_call_start {toolName}
  MCP call returns          onToolResult         tool_call_end {durationMs}
  loop exits (no tools)     —                    diagnosis / recommendation / done
```

#### MCP client layer — evidence: durationMs, fromCache, McpToolError

The reader anchor: you've wrapped a `fetch()` to measure how long it took. `lib/mcp/client.ts:112,134` does exactly that around the underlying transport call: `const start = Date.now(); … const durationMs = Date.now() - start`. That number is the only per-call metric the codebase emits.

What happens: each `callTool` returns `{ result, durationMs, fromCache }`. `fromCache: true` returns immediately with `durationMs: 0`. Errors are re-thrown as `McpToolError` with the tool name tagged on. Rate-limit errors trigger an internal retry loop with parsed wait hints.

Boundary: `durationMs` is per-call, not aggregated. There's no place that asks "what's the p95 of `execute_analytics_eql` over the last hour?" because there's no time-series store. Honest naming: this is the *primitive* the metrics section would aggregate, if it existed.

```
  MCP client layer — what the client measures, per call

  callTool(name, args)
    │  start = Date.now()
    │  liveCall → transport.callTool(name, args)
    │             │  may hit rate limit → retry
    │             │  may throw → McpToolError
    │             ▼
    │  durationMs = Date.now() - start    ← the metric primitive
    │  fromCache: true  → durationMs = 0
    ▼
  { result, durationMs, fromCache }
```

#### Provider layer — evidence: nothing the repo owns

The reader anchor: you've called the OpenAI API and wondered what Stripe-style request ID you could send back. None here. The Anthropic SDK and the Bloomreach MCP server have their own logs; the repo doesn't store or correlate to them.

What happens: nothing observable on this side. A 500 from Anthropic surfaces as a thrown error caught by the route handler's `console.error`. A Bloomreach MCP rate limit surfaces in the retry loop. The vendor's request ID is not captured.

Boundary: if the bug is upstream, the only evidence is "Anthropic threw" or "MCP returned an error result." You can't open a support ticket with a Bloomreach request ID because the repo doesn't store one.

#### Move 3 — the principle

An observability map is a *promise* about each layer. Drawing it forces you to say out loud what evidence you have and what you don't — and it makes the gaps impossible to hide. blooming insights' map is honest: rich at the agent layer (because the agent IS the product), thin everywhere else. That's a *consequence* of being early-stage, not a defect. The principle: when you put the map up on a whiteboard, the empty rows are the ones that bite you. Fill the rows the user-visible product depends on first.

---

## Primary diagram

The same map, fully labelled — every box has its evidence shape and its lifetime under the axis "state ownership of the evidence."

```
  Observability map — every layer, every evidence shape

  ┌─ UI layer ────────────────────────────────────────────────┐
  │  React state (TraceItem[])  → ReasoningTrace renders it    │
  │  evidence:  rendered DOM · devtools · network tab          │
  │  lifetime:  while the page is mounted                      │
  └─────────────────────────▲─────────────────────────────────┘
                            │ NDJSON line per AgentEvent
  ┌─ Route handler ─────────┴─────────────────────────────────┐
  │  ReadableStream.start · send(e) · collected[]              │
  │  evidence:  NDJSON wire bytes · 2× console.error in catch  │
  │  lifetime:  request scope (collected = request scope)      │
  └─────────────────────────▲─────────────────────────────────┘
                            │ hook invocations (in-process)
  ┌─ Agent loop ────────────┴─────────────────────────────────┐
  │  runAgentLoop · onText/onToolCall/onToolResult             │
  │  evidence:  AgentEvent[] (THE SPINE)                       │
  │  lifetime:  request scope (until collected is dropped)     │
  └─────────────────────────▲─────────────────────────────────┘
                            │ awaited callTool
  ┌─ MCP client ────────────┴─────────────────────────────────┐
  │  callTool · liveCall · retry loop                          │
  │  evidence:  durationMs · fromCache · McpToolError          │
  │  lifetime:  per-call result (no aggregation)               │
  └─────────────────────────▲─────────────────────────────────┘
                            │ network
  ┌─ Provider ──────────────┴─────────────────────────────────┐
  │  Anthropic · Bloomreach MCP                                │
  │  evidence:  ─ (their logs, not ours)                       │
  │  lifetime:  not owned by this repo                         │
  └───────────────────────────────────────────────────────────┘

       ── persisted out-of-band ──
       saveInvestigation(insightId, collected)
       → mem (process) → .investigation-cache.json (dev)
       → committed seed (lib/state/demo-investigations.json)
```

---

## Implementation in codebase

### Use cases

Three real moments the map gets used:

- **Triaging a bug report from the user.** They say "the recommendation panel is empty." You open the map: the UI band renders `Recommendation[]` from React state, which came from `recommendation` events on the NDJSON stream. Walk down the bands: did the recommendation events arrive on the wire? (network tab) Did the route emit them? (console.error / the trace's `done` event) Did the recommendation agent throw? (the trace's `error` event). The map *is* the triage order.

- **Adding a new agent.** When you add `lib/agents/coordinator.ts` or extend the categories, you wire it into the agent loop layer. The map tells you the only places you need to touch: the hooks (`hooksFor(agent)`), the `AgentName` union in `types.ts`, and the UI badge color. Everything else (NDJSON framing, replay, cache snapshot) you get for free because the map's bands already speak `AgentEvent`.

- **Asking "should we add Sentry?"** Look at the map's "evidence" column. The route layer has 2× `console.error`. The provider layer has nothing. Sentry would fill both — the route's catch blocks would `Sentry.captureException(e)`, and the Anthropic/MCP errors would attach upstream request IDs. The map makes the value of Sentry concrete: it fills exactly the two rows that are currently the weakest.

### Code side by side, with a line-by-line read

The two files that *generate* the agent-layer evidence — the union and the encoder. Everything downstream is just transport, render, or replay of these.

```
  lib/mcp/events.ts  (lines 4–17)

  export type AgentEvent =
    | { type: 'reasoning_step'; step: ReasoningStep }                          ← every agent text → one event
    | { type: 'tool_call_start'; toolName: string; agent: AgentName }          ← span open
    | { type: 'tool_call_end'; toolName: string; agent: AgentName;             ← span close + duration
        durationMs: number; result?: unknown; error?: string }
    | { type: 'insight'; insight: Insight }                                    ← briefing output
    | { type: 'diagnosis'; diagnosis: Diagnosis }                              ← diagnostic agent output
    | { type: 'recommendation'; recommendation: Recommendation }               ← recommendation agent output
    | { type: 'done' }                                                         ← clean termination signal
    | { type: 'error'; message: string };                                      ← error → client (not console)

  export function encodeEvent(e: AgentEvent): string {
    return JSON.stringify(e) + '\n';                                           ← NDJSON: one JSON object, '\n' terminator
  }
        │
        └─ this 8-line file IS the contract. Every layer above and below
           speaks AgentEvent. Drop any variant and you drop a row from
           the observability map — there's nowhere else it's recorded.
```

The route handler's `send` is the choke point — one function call per event, captured for replay AND streamed to the client:

```
  app/api/agent/route.ts  (lines 171–195, abbreviated)

  const collected: AgentEvent[] = [];                                          ← in-process buffer for the snapshot
  const send = (e: AgentEvent) => {
    collected.push(e);                                                         ← capture (will be saveInvestigation'd)
    controller.enqueue(encoder.encode(encodeEvent(e)));                        ← emit (NDJSON line on the wire)
  };

  const hooksFor = (agent: AgentName) => ({
    onText: (t: string) => { if (t.trim()) stepFor(agent, 'thought', t); },    ← text block → reasoning_step
    onToolCall: (tc) => send({type:'tool_call_start', toolName:tc.toolName, agent}),
    onToolResult: (tc) => send({type:'tool_call_end', toolName:tc.toolName,
                                 agent, durationMs: tc.durationMs ?? 0,
                                 result: trunc(tc.result), error: tc.error }),
  });
        │
        └─ the dual-write (collected.push + controller.enqueue) is what makes
           the same trace serve both the live UI and the replay cache.
           Drop the push and you lose replay; drop the enqueue and you lose
           the live render. Both load-bearing.
```

---

## Elaborate

The observability map is a Charity Majors / Brendan Gregg primitive — the bird's-eye view that lets you reason about *what evidence exists* before you write the new log line, the new metric, the new alert. The temptation in a young codebase is to jump straight to "let's add Sentry" / "let's add OTel"; drawing the map first tells you which one will actually move the needle.

For blooming insights specifically: the map's strength sits at exactly the right layer. The agent IS the product (the user watches the trace render live), so the layer with the most evidence is also the layer the user touches. The weakest layers (route catches, provider) are also the layers that fire least often — they wake up on rare crashes, not on every request. That's not luck; it's the natural result of the trace being the product surface.

Where this maps to the wider observability lineage: the three pillars — logs, metrics, traces — split blooming insights cleanly. Traces are *strong* (the AgentEvent stream IS a trace). Logs are *weak but rare* (the 2× `console.error` per route). Metrics are *primitive-only* (`durationMs` per call, nothing aggregated). Three different verdicts, all honest, all anchored to file:line.

---

## Interview defense

**Q1. Walk me through how you'd debug "the recommendation panel showed nothing for one user."**

The first move is the observability map. The user saw an empty panel — that's a UI symptom. Walk down the bands: did the UI receive `recommendation` events? Network tab on `/api/agent` shows the NDJSON stream. If the recommendations were emitted on the wire, it's a UI rendering bug. If they weren't, walk down: did the route emit them? The `console.error` in the catch block in `app/api/agent/route.ts:256` would have fired if the recommendation agent threw. If the route is clean, the agent loop ran but emitted nothing. Walk down: was the MCP call failing silently? `lib/mcp/client.ts` would have set `isError: true` on the result. The map *is* the triage script.

```
  symptom: empty panel
       │
       ▼  walk the bands top-down
  UI       → React state empty?      → check network tab
  Route    → console.error fired?    → check Vercel logs
  Agent    → tool_call_end results?  → read the trace
  MCP      → isError on result?      → read durationMs/error
  Provider → ─ (no evidence)
```

**Anchor:** the map turns "where do I look?" into a deterministic walk down the layers.

**Q2. What evidence layer is weakest in this repo, and what would you add first?**

The route handler's structured-log layer. The entire backend logging surface is 4× `console.error`. No log levels, no correlation IDs across requests, no redaction. The first thing I'd add is a thin logger module — pino or just a typed `log(level, event, fields)` function — and route the 4 catch sites through it. That gives me a real evidence layer at the band where errors actually surface (the catches), without touching anything that already works (the trace).

```
  before: console.error('[agent] error:', e)
  after:  log.error({ event: 'agent.crash', insightId, error: e })
                                ▲
                                └─ structured: searchable, correlatable, redactable
```

**Anchor:** the rank by consequence — the routes' catch blocks fire on every real outage, and they're the cheapest layer to upgrade.

---

## Validate

1. **Reconstruct.** Without looking, draw the five layers of the map and name one evidence shape per layer. Test: did you remember the missing-seam (no backend sink)?
2. **Explain.** Why is `durationMs` called a "metric primitive" but not a "metric"? Anchor: `lib/mcp/client.ts:134`.
3. **Apply to a scenario.** A user reports "the briefing started but the coverage tiles never resolved." Which band do you check first, and what's the specific file:line that owns that band's evidence?
4. **Defend the decision.** Why isn't there a `lib/log.ts` module yet? Make the case both for adding one and for leaving the trace as the single observability surface.

---

## See also

- `05-traces-and-request-lifecycles.md` — the agent layer in full (the trace IS a distributed trace).
- `06-state-snapshots-and-debugging-boundaries.md` — what `saveInvestigation` does to lift the trace out of request scope.
- `03-structured-logs-and-correlation.md` — the route layer's evidence in full, including what's missing.
- `04-metrics-slis-slos-and-alerts.md` — the MCP client layer's evidence (`durationMs`) and why nothing aggregates it yet.
- `08-debugging-observability-red-flags-audit.md` — the map's empty rows, ranked by consequence.

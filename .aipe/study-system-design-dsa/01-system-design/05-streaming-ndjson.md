# Streaming reasoning over NDJSON

**Industry name(s):** server-streamed responses (chunked transfer), newline-delimited JSON (NDJSON / JSON Lines), producer/consumer over a ReadableStream
**Type:** Industry standard · Language-agnostic

> The server writes one JSON object per line into an HTTP response body as events are produced, and the browser reads those lines incrementally with `fetch` + `response.body.getReader()`, updating React state with each parsed event so the UI renders before the full response is complete.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Streaming NDJSON is a producer/consumer pipe that spans three bands — the Route handler (where `ReadableStream` enqueues bytes), the network boundary (HTTP chunked transfer with `Content-Type: application/x-ndjson`), and the UI (where `useInvestigation` or the feed reads chunks with `getReader()`). The wire contract is the `AgentEvent` discriminated union in `lib/mcp/events.ts`; `encodeEvent(e)` is literally `JSON.stringify(e) + '\n'`. Both `/api/agent` and `/api/briefing` emit NDJSON; both consumers use the same `buf.split('\n')` + `lines.pop()` line-buffering loop. The framing details live in the DSA companion (`../02-dsa/03-ndjson-line-buffering.md`); this file is about the architecture that uses them.

```
Zoom out — where NDJSON streaming lives

┌─ Route handler ────────────────────────────────┐  ← producer
│  app/api/agent/route.ts (★ ReadableStream ★)   │
│  app/api/briefing/route.ts (★ ReadableStream ★)│
│  send(e) = controller.enqueue(encodeEvent(e))  │
└─────────────────────┬──────────────────────────┘
                      │  HTTP chunked transfer
                      │  Content-Type: application/x-ndjson
                      │  one JSON object per line
                      ▼
┌─ Network boundary ─────────────────────────────┐  ← we are here (spans)
│  TCP chunks may split a line mid-byte          │
└─────────────────────┬──────────────────────────┘
                      │
┌─ UI ────────────────▼──────────────────────────┐  ← consumer
│  lib/hooks/useInvestigation.ts (reader loop)   │
│  app/page.tsx (feed reader loop)               │
│  buf.split('\n') · lines.pop() · JSON.parse    │
│  → setState per event → React re-render        │
└────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how does the server push incremental events and the browser render them as they arrive, over one HTTP request, with no `EventSource` auto-reconnect to re-trigger a ~115s agent run? The answer is `fetch` + `ReadableStream` on both ends, with NDJSON (one JSON object per line) as the wire format and a tiny `AgentEvent` discriminated union as the contract. The producer enqueues encoded bytes the moment events exist; the consumer drains chunks, reassembles lines across chunk boundaries, parses each, and `switch`es on `e.type` into the right `setState`. The next sections walk both sides of the pipe, the cache-replay path that uses the same wire format, and the briefing route's local-superset `BriefingEvent` extension.

---

## How it works

### Mental model

A producer writes complete JSON objects, one per line, into a stream. The network carries those bytes in chunks. The consumer reads chunks, reassembles lines, parses each one, and calls a handler. The handler updates UI state. Each side operates at its own cadence.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Producer (route handler)                                               │
│                                                                         │
│  reasoning_step → JSON.stringify(e) + '\n'  ─┐                         │
│  tool_call_start → JSON.stringify(e) + '\n' ─┤→ ReadableStream.enqueue │
│  tool_call_end  → JSON.stringify(e) + '\n'  ─┤                         │
│  diagnosis      → JSON.stringify(e) + '\n'  ─┤                         │
│  recommendation → JSON.stringify(e) + '\n'  ─┘                         │
└────────────────────────────┬────────────────────────────────────────────┘
                             │  HTTP chunked transfer
                             │  Content-Type: application/x-ndjson
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Consumer (UI hook)                                                     │
│                                                                         │
│  res.body.getReader()                                                   │
│       │                                                                 │
│       └→ read() → Uint8Array → TextDecoder.decode() → append to buf    │
│                                                                         │
│  buf.split('\n') → keep trailing partial → parse each complete line    │
│       │                                                                 │
│       └→ handle(e) → switch(e.type) → setState(...)                    │
│                                       → React re-renders               │
└─────────────────────────────────────────────────────────────────────────┘
```

One `read()` call returns one Uint8Array chunk. A chunk may contain multiple complete lines, one partial line, or any combination. The buffer reassembly step is the core mechanical detail.

---

### The AgentEvent contract

A shared events module defines the wire format as a discriminated union. Every event that crosses the network is one of these shapes:

```
AgentEvent =
  | { type: 'reasoning_step';   step: ReasoningStep }
  | { type: 'tool_call_start';  toolName: string; agent: AgentName }
  | { type: 'tool_call_end';    toolName: string; agent: AgentName; durationMs: number; result?; error? }
  | { type: 'insight';          insight: Insight }
  | { type: 'diagnosis';        diagnosis: Diagnosis }
  | { type: 'recommendation';   recommendation: Recommendation }
  | { type: 'done' }
  | { type: 'error';            message: string }
```

`encodeEvent(e)` is exactly `JSON.stringify(e) + '\n'`. `decodeEvent(line)` is `JSON.parse(line)`. The newline is the delimiter — no length prefix, no framing, just newlines between JSON objects. One event per line.

```
┌──────────────────────────────────────────────────────────────┐
│  Wire format: one line per event                             │
│                                                              │
│  {"type":"reasoning_step","step":{...}}\n                    │
│  {"type":"tool_call_start","toolName":"get_metrics",...}\n   │
│  {"type":"tool_call_end","toolName":"get_metrics",...}\n     │
│  {"type":"diagnosis","diagnosis":{...}}\n                    │
│  {"type":"recommendation","recommendation":{...}}\n          │
│  {"type":"done"}\n                                           │
└──────────────────────────────────────────────────────────────┘
```

The discriminated union means the consumer can `switch(e.type)` without type narrowing gymnastics — TypeScript knows the full shape once the `type` field is matched.

---

### encodeEvent / the producer

The investigation route handler constructs a `ReadableStream<Uint8Array>` and passes it directly to the `Response` constructor. The producer lives entirely in the `start(controller)` callback.

```
ReadableStream<Uint8Array>({
  start(controller):
    send(e):
      collected.push(e)                           # accumulate for cache
      controller.enqueue(encode(encodeEvent(e)))  # push to wire

    try:
      stepFor(leadAgent, 'thought', 'reading the workspace schema…')
      schema = await bootstrapSchema(mcp)         # bootstrap INSIDE the stream
      ...run agents, send events...
    catch e:
      send({ type: 'error', message: 'agent route · ' + ... })
    finally:
      controller.close()   # signals EOF to the consumer (always)
})
```

`send` does two things: it enqueues the encoded event bytes so the network layer flushes them immediately, and it pushes to a `collected` array so the full sequence can be saved for cache replay. The entire investigation body runs inside a try/catch/finally: a throw becomes an `error` NDJSON event, and `controller.close()` always fires.

The live investigation flow produces events in this order:

```
┌──────────────────────────────────────────────────────────────────┐
│  Live investigation event sequence (step=diagnose)               │
│                                                                  │
│  reasoning_step ('reading the workspace schema…')  ← FIRST line  │
│       │  (emitted before bootstrapSchema runs)                   │
│       │                                                          │
│  reasoning_step (diagnostic · thought)      ← investigation start│
│       │                                                          │
│       ├─ tool_call_start  ┐                                      │
│       ├─ reasoning_step   ├─ repeated per tool call              │
│       └─ tool_call_end    ┘                                      │
│       │                                                          │
│  diagnosis                                  ← diagnostic agent done│
│       │                                                          │
│  done                                       ← stream close       │
│                                                                  │
│  (step=recommend is a separate request: bootstrap line →         │
│   recommendation reasoning/tools → recommendation (×N) → done)   │
└──────────────────────────────────────────────────────────────────┘
```

A `hooksFor(agent)` helper bridges the agent callbacks (`onText`, `onToolCall`, `onToolResult`) to `send`, so each agent's internal events flow out as NDJSON lines automatically. Note the schema-bootstrap `reasoning_step` is the very first line on the wire — see the bootstrap-inside-the-stream sub-section below.

---

### The consumer loop

The reader loop lives in an investigation hook — the step-2 and step-3 page components call `useInvestigation(id, 'diagnose' | 'recommend')` and render the returned state. The feed page keeps its own copy of the same loop for the briefing stream. The hook's loop is a plain async IIFE inside an effect:

```
res = await fetch(url)               # url = agent endpoint with id + step query

# 401 → redirect to OAuth
# !res.ok → read { error } JSON, setError

reader = res.body.getReader()
dec    = TextDecoder()
buf    = ""

loop forever:
    { done, value } = await reader.read()
    if done: break
    buf += dec.decode(value, { stream: true })
    lines = buf.split("\n")
    buf   = lines.pop() ?? ""        # keep trailing partial
    for line in lines:
        if not line.trim(): continue
        try: handle(parse_json(line) as AgentEvent)
        catch: pass                   # ignore malformed line

# flush trailing buffer after stream closes
if buf.trim():
    try: handle(parse_json(buf) as AgentEvent)
    catch: pass
```

The key mechanic: `split('\n')` produces N+1 parts for N newlines. The last part is the incomplete line that hasn't been terminated yet. `lines.pop()` pulls it out and puts it back in `buf` for the next iteration. Every element remaining in `lines` is a complete, parseable JSON object. The wire format (the `AgentEvent` NDJSON) does not depend on where this loop lives.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Buffer reassembly: chunk boundary lands mid-line                    │
│                                                                       │
│  Chunk 1: {"type":"reasoning_step","step":{         ← incomplete     │
│  buf = '{"type":"reasoning_step","step":{'                           │
│  split('\n') → [ '{"type":"reasoning_step","step":{' ]               │
│  pop() → buf = '{"type":"reasoning_step","step":{'                   │
│  lines = []  → nothing parsed yet                                    │
│                                                                       │
│  Chunk 2: "id":"abc",...}}\n{"type":"tool_call_start",...}\n         │
│  buf += chunk2                                                        │
│  split('\n') → [ complete-line-1, complete-line-2, '' ]              │
│  pop() → buf = ''                                                     │
│  lines = [ complete-line-1, complete-line-2 ] → both parsed          │
└──────────────────────────────────────────────────────────────────────┘
```

`TextDecoder` is constructed with no arguments, defaulting to UTF-8. The `{ stream: true }` option tells it not to flush multi-byte character sequences at chunk boundaries — without it, a UTF-8 character split across two chunks would produce the Unicode replacement character.

The `handle` function is a `switch(e.type)` that calls the appropriate `setState` updater for each event type. On `done` it stashes this step's result in `sessionStorage` (`bi:inv:<step>:<id>`) and — on the diagnose step — hands the diagnosis to step 3 under `bi:diag:<id>`.

---

### Why fetch-stream, not EventSource

`EventSource` is the browser standard for server-sent events (SSE). It is simpler to use: you subscribe to events by type, it handles reconnection automatically, and the protocol is well-specified. For most server-push use cases it is the right choice.

This codebase does not use it. Here is why:

```
┌─────────────────────────────────────────────┬──────────────────────────────────────────────┐
│  EventSource                                │  fetch + ReadableStream                      │
├─────────────────────────────────────────────┼──────────────────────────────────────────────┤
│  Auto-reconnects on close                   │  No auto-reconnect                           │
│  Server sends `retry:` field to set delay   │  Consumer controls reconnect (or doesn't)    │
│  Requires SSE framing (data:, event:, id:)  │  Plain NDJSON — one line = one event         │
│  GET only; no custom headers by default     │  Full fetch API; custom headers, POST, etc.  │
│  Browser manages the connection lifecycle   │  Application code manages the lifecycle      │
└─────────────────────────────────────────────┴──────────────────────────────────────────────┘
```

The auto-reconnect is the disqualifier. When `EventSource` loses the connection it re-issues the GET request. In this app that GET request triggers a new ~115 s agent run against the provider API. Auto-reconnect becomes auto-re-bill and a phantom duplicate investigation. `fetch`-stream closes on disconnect and stays closed. The application decides what to do next.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  EventSource reconnect behaviour (why it's wrong here)                  │
│                                                                          │
│  Browser ──GET agent endpoint──► Server: starts 115s agent run → stream │
│           ←── stream ────────────────────────────────────              │
│  connection drops                                                        │
│  Browser waits retry-ms                                                  │
│  Browser ──GET agent endpoint──► Server: starts ANOTHER 115s run ──►   │
│                              (previous run still in-flight or wasted)   │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│  fetch-stream behaviour (what actually happens)                          │
│                                                                          │
│  Browser ──GET agent endpoint──► Server: starts 115s agent run → stream │
│           ←── stream ────────────────────────────────────              │
│  connection drops                                                        │
│  reader.read() rejects with a network error                              │
│  catch block sets error state in the hook                                │
│  No retry. User sees the error. User decides.                            │
└──────────────────────────────────────────────────────────────────────────┘
```

A `startedRef` guard in the hook handles the other source of duplicate runs: React StrictMode in development double-invokes effect callbacks. `startedRef.current` flips to `true` on first invocation; the second invocation returns immediately. The hook deliberately does NOT cancel the fetch on cleanup: cancelling on StrictMode's first cleanup, while the guard blocks the re-mount, aborted the stream and left the logs empty — so the in-flight run is allowed to complete and the late `setState` is a safe no-op.

---

### The cache replay path

When a cache lookup returns a stored event sequence for the requested insight, the handler skips the live agent run and replays the stored events with a `REPLAY_DELAY_MS` of around 180 ms between each. No provider API key is needed. The cached snapshot is the *combined* diagnose+recommend stream (written only by the dev demo-capture path), so the replay first runs it through a `filterByStep(cached, step)` helper to show only the events belonging to the requested step.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Cache replay                                                       │
│                                                                      │
│  cached = [ diag events…, diagnosis, recommendation×N, done ]       │
│       │                                                             │
│       ▼  events = step ? filterByStep(cached, step) : cached        │
│       │  ('diagnose' → drop recommendation activity;                │
│       │   'recommend' → drop diagnosis + diagnostic-agent activity) │
│       └─ for e in events:                                           │
│               controller.enqueue(encode(encodeEvent(e)))            │
│               await sleep(REPLAY_DELAY_MS)        # ~180 ms         │
│          controller.close()                                         │
│                                                                      │
│  Same wire format → same consumer loop → trace animates             │
│  No API key · No MCP connection · Same UX as live run               │
└─────────────────────────────────────────────────────────────────────┘
```

The consumer loop is unaware of the difference. It reads NDJSON lines the same way regardless of whether they were produced by a live agent or replayed from cache. The ~180 ms delay is what produces the visible animation — without it all events would arrive in one or two chunks and the trace would appear to pop in rather than animate.

---

### Bootstrap inside the stream + the step-filtered replay

Two structural changes shape what reaches the wire. First, schema bootstrap moved *inside* the `ReadableStream`. The route still connects MCP before constructing the stream (so a connect failure returns a real error JSON, not a stream), but the schema read now happens in `start(controller)` — *after* the producer has already emitted a `reasoning_step` saying "reading the workspace schema…". The user sees that first log line immediately instead of staring at a silent ~1–2 s gap while the schema loads.

Second, the route takes a `step` query param: `'diagnose' | 'recommend' | null`. The two non-null values run only that phase's agent (live), and select that phase's events from the cached snapshot (replay). `null` is the combined run, used only by the dev demo-capture path — it runs both agents and persists the combined trace.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Old: bootstrap BEFORE the stream            New: bootstrap INSIDE        │
│  ─────────────────────────────────────       ──────────────────────────  │
│  connect MCP                                  connect MCP                 │
│  bootstrapSchema()      ← silent ~1–2s        new ReadableStream(...)      │
│  new ReadableStream()                           start(controller):        │
│    enqueue first event                            send('reading schema…') │← first line
│                                                   bootstrapSchema()        │  appears NOW
│                                                   …run agent…             │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│  step query param                                                          │
│                                                                            │
│  step=diagnose  → live: run diagnostic agent only                          │
│                   replay: filterByStep(cached, 'diagnose')                 │
│  step=recommend → live: run recommendation agent only                      │
│                   replay: filterByStep(cached, 'recommend')                │
│  step=null      → combined run + save the trace                            │
│                   (dev demo-capture only)                                  │
└──────────────────────────────────────────────────────────────────────────┘
```

`filterByStep` reads each event's owning agent (`reasoning_step.step.agent`, or the `agent` field on `tool_call_start`/`tool_call_end`) and keeps or drops it: the `diagnose` step drops `recommendation` events and any recommendation-agent activity; the `recommend` step drops the `diagnosis` event and any non-recommendation-agent activity. `done` survives both. The replay consumer never knows it received a slice — it is the same NDJSON, just fewer lines.

---

### Live-run vs cache-replay side-by-side

```
┌─────────────────────────────────────────┬─────────────────────────────────────────┐
│  Live run                               │  Cache replay                           │
├─────────────────────────────────────────┼─────────────────────────────────────────┤
│  needs provider API key                 │  no API key needed                      │
│  needs MCP connection + auth            │  no MCP connection                      │
│  ~115s wall-clock time                  │  events.length × ~180 ms                │
│  events are non-deterministic           │  events are identical each replay       │
│  events are written to collected[]      │  events are read from cached[]          │
│  saved on the combined run only         │  served from cache on hit               │
│  one agent per request (step-split)     │  filterByStep(cached, step) on read     │
│  same wire format                       │  same wire format                       │
│  same consumer loop                     │  same consumer loop                     │
└─────────────────────────────────────────┴─────────────────────────────────────────┘
```

---

### Briefing coverage events

The investigation route is not the only NDJSON surface. The morning-briefing route streams the monitoring scan plus the 10-category coverage grid over the same wire format, with the same `JSON.stringify(e) + '\n'` encoding and the same consumer-side `buf.split('\n')` loop (the feed page has its own copy of the loop). What differs is the event vocabulary: the briefing needs to stream a workspace summary and per-category coverage tiles, neither of which the investigation view ever sees.

Rather than widen the shared `AgentEvent` union (which would force the agent route and the investigation view to handle event types they never receive), the briefing route defines a **local superset** type:

```
BriefingEvent =
  | AgentEvent                                          # reuse every investigation variant
  | { type: 'workspace';     workspace: BriefingWorkspace }
  | { type: 'coverage_item'; item: CoverageItem }       # one tile, streamed per-category
  | { type: 'coverage';      coverage: CoverageReport } # bulk form, plain-JSON fallback
```

`BriefingEvent` is `AgentEvent | …three briefing-only variants`. The rule, stated out loud: kept local so the shared `AgentEvent` contract used by the investigation route + view is untouched. The consumer's `switch(e.type)` on the feed side simply has extra cases that the investigation hook does not.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Two NDJSON surfaces, one wire format, two event vocabularies            │
│                                                                          │
│  shared events module                                                    │
│    AgentEvent  ◄───────────────┐                                         │
│        │                       │ (extended locally, NOT widened)         │
│        │                       │                                         │
│  ┌─────┴──────────┐     ┌───────┴───────────────────────────────┐        │
│  │ investigation  │     │ briefing route                          │        │
│  │ route          │     │ BriefingEvent = AgentEvent             │        │
│  │ emits          │     │   | {type:'workspace'}                 │        │
│  │ AgentEvent     │     │   | {type:'coverage_item'; item}       │        │
│  │ only           │     │   | {type:'coverage'; coverage}        │        │
│  └─────┬──────────┘     └───────┬───────────────────────────────┘        │
│        │                        │                                        │
│        ▼                        ▼                                        │
│  investigation hook        feed-page loop                                │
│  switch(e.type):           switch(e.type): + workspace                   │
│    reasoning_step…             + coverage_item (append-and-dedup)        │
│    diagnosis, done             + coverage     (bulk fallback)            │
└──────────────────────────────────────────────────────────────────────────┘
```

#### Demo mode: the paced replay

Like the investigation route, the briefing route serves a creds-free demo replay of a captured snapshot (toggled by `?demo=cached`). The replay is **paced**: a `REPLAY_DELAY_MS` constant of around 140 ms sleeps between events so the snapshot reveals at a readable cadence rather than arriving in one chunk. An `emit` helper enqueues the encoded event then `await`s a `setTimeout(r, REPLAY_DELAY_MS)`.

This ~140 ms is **independent** of the investigation route's ~180 ms replay delay. Two routes, two constants, two cadences — the briefing reveals slightly faster than an investigation replay. Neither imports the other's value.

The demo replay mirrors the **live** event order exactly, so the consumer cannot tell live from replay:

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Briefing event sequence (live AND demo replay — identical order)        │
│                                                                          │
│  workspace                          ← project name + customer/event count│
│       │                                                                  │
│  reasoning_step ('matching schema…')← checklist header                   │
│       │                                                                  │
│       ├─ reasoning_step  ┐                                               │
│       └─ coverage_item   ┘─ one PAIR per category                        │
│       │                    log line + its tile resolve together          │
│       │                                                                  │
│       ├─ tool_call_start  ┐                                              │
│       └─ tool_call_end    ┘─ recorded EQL trace (the real queries)       │
│       │                                                                  │
│  insight (×N)                       ← the anomaly cards                  │
│       │                                                                  │
│  done                               ← stream close                       │
│       │                                                                  │
│  finally: controller.close()                                             │
└──────────────────────────────────────────────────────────────────────────┘
```

#### Why `coverage_item` is emitted one-per-category

The coverage grid is a 10-tile checklist component. Emitting a single bulk `coverage` event would pop all ten tiles in at once. Instead the route emits one `coverage_item` per category, each paired with the matching checklist `reasoning_step` log line, so the **grid fills tile-by-tile in step with the status log** — the user watches each category resolve as its line is written.

The client accumulates them: the `coverage_item` case appends the tile to a coverage state array, de-duplicating by `category`, so the grid grows one tile per event:

```
┌──────────────────────────────────────────────────────────────────────────┐
│  coverage_item accumulation (feed page)                                  │
│                                                                          │
│  case 'coverage_item':                                                   │
│    setCoverage(prev =>                                                    │
│      prev.some(c => c.category === evt.item.category)                    │
│        ? prev                          ← already have it → no-op          │
│        : [...prev, evt.item])          ← append one tile                  │
│                                                                          │
│  grid:  [▢▢▢▢▢▢▢▢▢▢] → [■▢▢▢…] → [■■▢…] → … → [■■■■■■■■■■]              │
│         tick by tick, in step with each checklist log line               │
└──────────────────────────────────────────────────────────────────────────┘
```

The bulk `{type:'coverage'}` variant still exists for the plain-JSON fallback path the feed uses when a response is not NDJSON — but the streaming path never emits it.

---

### The principle

Decouple producer cadence from consumer render via a stream and a shared event contract. The producer writes when it has something to write. The consumer reads when chunks arrive. Neither side waits for the other to finish. The contract (the `AgentEvent` union) is the only coupling.

---

## Streaming reasoning over NDJSON — diagram

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER  (app/api/agent/route.ts · ?step=diagnose | recommend)            │
│                                                                                  │
│  ReadableStream<Uint8Array>                                                      │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │  start(controller)  — try/catch/finally                                  │    │
│  │                                                                          │    │
│  │  send(reasoning_step 'reading the workspace schema…')  ← FIRST   │    │
│  │  schema = await bootstrapSchema(conn.mcp)              ← inside stream  │    │
│  │                                                                          │    │
│  │  step=diagnose → DiagnosticAgent ─→ send(reasoning_step/tool_*)         │    │
│  │                                  ─→ send(diagnosis)   ──→ enqueue(bytes)│    │
│  │  step=recommend→ RecommendationAgent ─→ send(reasoning_step/tool_*)     │    │
│  │   (diagnosis handed in via &diagnosis=) ─→ send(recommendation ×N)     │    │
│  │                                                                          │    │
│  │  send(done)  →  finally: controller.close()                             │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
│  Response({ body: stream, headers: { 'Content-Type': 'application/x-ndjson' }}) │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
                             NETWORK BOUNDARY
                             HTTP chunked transfer
                             one NDJSON line per event
                                         │
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│  UI LAYER  (lib/hooks/useInvestigation.ts ← page.tsx + recommend/page.tsx)       │
│                                                                                  │
│  fetch('/api/agent?insightId=...&step=...')                                      │
│       │                                                                          │
│       ▼                                                                          │
│  res.body.getReader()                                                            │
│       │                                                                          │
│       └─ read() loop ──→ TextDecoder.decode(chunk, { stream:true })              │
│                               │                                                  │
│                               ▼                                                  │
│                       buf += decoded                                             │
│                       lines = buf.split('\n')                                    │
│                       buf  = lines.pop()        ← keep trailing partial          │
│                               │                                                  │
│                               ▼                                                  │
│                       for line of lines: JSON.parse(line) as AgentEvent         │
│                               │                                                  │
│                               ▼                                                  │
│                       handle(e) ──→ switch(e.type)                               │
│                               │                                                  │
│              ┌────────────────┼────────────────┬──────────────────┐             │
│              ▼                ▼                ▼                  ▼             │
│        setItems(...)    setDiagnosis(...)  setRecommendations(...)  setComplete  │
│              │                │                │                  │             │
│              └────────────────┴────────────────┴──────────────────┘             │
│                                       │                                          │
│                       on 'done': stash bi:inv:<step>:<id>                        │
│                       + (diagnose) hand off bi:diag:<id>                         │
│                                       │                                          │
│                               React re-renders                                   │
│                               ReasoningTrace · EvidencePanel · RecommendationCard│
└──────────────────────────────────────────────────────────────────────────────────┘
```

The service layer produces. The network carries. The UI layer consumes. Nothing is shared across the boundary except bytes.

---

## Implementation in codebase

| File | Function / symbol | Lines |
|---|---|---|
| `lib/mcp/events.ts` | `AgentEvent` union (wire format) | L4–L12 |
| `lib/mcp/events.ts` | `encodeEvent` | L15–L17 |
| `lib/mcp/events.ts` | `decodeEvent` | L20–L22 |
| `app/api/agent/route.ts` | `maxDuration = 300` | L20 |
| `app/api/agent/route.ts` | `REPLAY_DELAY_MS` constant | L105 |
| `app/api/agent/route.ts` | `step` query param parse | L117–L118 |
| `app/api/agent/route.ts` | `filterByStep` (step-sliced replay) | L66–L84 |
| `app/api/agent/route.ts` | Cache-first replay block | L127–L141 |
| `app/api/agent/route.ts` | MCP connect (pre-stream, try/catch → error JSON) | L156–L166 |
| `app/api/agent/route.ts` | Live `ReadableStream` + `send` | L168–L267 |
| `app/api/agent/route.ts` | Bootstrap-inside-stream (`reasoning_step` then schema read) | L196–L202 |
| `app/api/agent/route.ts` | `hooksFor` bridge | L181–L195 |
| `app/api/agent/route.ts` | Step-split run (diagnose / recommend / combined) | L220–L254 |
| `app/api/agent/route.ts` | `saveInvestigation` (combined run only) | L254 |
| `lib/hooks/useInvestigation.ts` | `startedRef` StrictMode guard + no-cancel note | L32–L36, L43, L47–L48 |
| `lib/hooks/useInvestigation.ts` | hydrate-from-stash / diagnosis handoff load | L50–L84 |
| `lib/hooks/useInvestigation.ts` | `handle` switch | L97–L151 |
| `lib/hooks/useInvestigation.ts` | `fetch` + reader loop | L153–L212 |
| `lib/hooks/useInvestigation.ts` | `buf.split('\n')` + `lines.pop()` | L191–L192 |
| `lib/hooks/useInvestigation.ts` | 401 → authUrl redirect | L171–L177 |
| `lib/hooks/useInvestigation.ts` | `done` → stash + `bi:diag:<id>` handoff | L130–L144 |
| `app/investigate/[id]/page.tsx` | step-2 consumer: `useInvestigation(id,'diagnose')` | L38 |
| `app/investigate/[id]/recommend/page.tsx` | step-3 consumer: `useInvestigation(id,'recommend')` | L36 |
| `app/page.tsx` | feed's own reader loop (briefing stream) | L268–L419 |

**Consumer loop (trimmed pseudocode):**

```typescript
// lib/hooks/useInvestigation.ts L184–L208
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';           // trailing partial stays in buf
  for (const line of lines) {
    if (!line.trim()) continue;
    try { handle(JSON.parse(line) as AgentEvent); } catch { /* ignore malformed line */ }
  }
}
if (buf.trim()) { try { handle(JSON.parse(buf) as AgentEvent); } catch {} }
```

**Producer send sequence (trimmed pseudocode):**

```typescript
// app/api/agent/route.ts L170–L254
const send = (e: AgentEvent) => {
  collected.push(e);
  controller.enqueue(encoder.encode(encodeEvent(e)));
};
try {
  stepFor(leadAgent, 'thought', 'reading the workspace schema…');  // FIRST line on the wire
  const schema = await bootstrapSchema(conn.mcp);                  // bootstrap INSIDE the stream
  // step=diagnose (or combined): run the diagnostic agent
  if (step !== 'recommend') {
    const diagnosis = await diagAgent.investigate(inv, hooksFor('diagnostic'));
    send({ type: 'diagnosis', diagnosis });
  }
  // step=recommend (or combined): run the recommendation agent (diagnosis handed in via ?diagnosis=)
  if (step !== 'diagnose') {
    const recommendations = await recAgent.propose(inv, diagnosis!, hooksFor('recommendation'));
    for (const r of recommendations) send({ type: 'recommendation', recommendation: r });
  }
  send({ type: 'done' });
  if (step == null) saveInvestigation(insightId!, collected);     // combined (demo-capture) run only
} catch (e) {
  send({ type: 'error', message: `/api/agent · ${...}` });
} finally {
  controller.close();
}
```

GitHub:
- [`lib/mcp/events.ts`](https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/events.ts)
- [`app/api/agent/route.ts`](https://github.com/rlynjb/blooming_insights/blob/main/app/api/agent/route.ts)
- [`lib/hooks/useInvestigation.ts`](https://github.com/rlynjb/blooming_insights/blob/main/lib/hooks/useInvestigation.ts)
- [`app/investigate/[id]/page.tsx`](https://github.com/rlynjb/blooming_insights/blob/main/app/investigate/%5Bid%5D/page.tsx)
- [`app/investigate/[id]/recommend/page.tsx`](https://github.com/rlynjb/blooming_insights/blob/main/app/investigate/%5Bid%5D/recommend/page.tsx)

---

## Elaborate

### Where it comes from

HTTP/1.1 chunked transfer encoding (RFC 7230) let servers send response bodies in pieces without knowing the total length upfront. That primitive is what makes streaming possible at all. Server-Sent Events (SSE, WHATWG spec) built a higher-level protocol on top: `data:`, `event:`, `id:`, and `retry:` fields, a MIME type of `text/event-stream`, and the `EventSource` browser API with built-in reconnection. NDJSON over `fetch`-stream is a lower-level choice: it uses the same chunked-transfer primitive but skips the SSE framing. You get raw JSON objects, not SSE envelopes. You also skip `EventSource`'s reconnect logic, which is the point.

JSON Lines (`.jsonl`, sometimes called NDJSON) is the file-format analogue: one JSON object per line, newline as delimiter. It is used in log shipping, ML training datasets, and streaming ETL for the same reason it is used here — it is appendable, parseable line-by-line, and requires no closing bracket.

### The deeper principle

Producer and consumer are decoupled in time and space. The producer does not know how many consumers there are. The consumer does not know how fast the producer will write. They share only the byte stream and the event contract.

```
┌───────────────────────────────────────────────────────────────────┐
│  Decoupled producer/consumer                                      │
│                                                                   │
│  Producer cadence:  fast or slow, depends on AI/tool latency     │
│  Network cadence:   TCP segments, HTTP chunks — outside your control│
│  Consumer cadence:  read() resolves whenever a chunk arrives      │
│                                                                   │
│  Producer ──writes when ready──► Stream ──chunks when full──►    │
│                                               Consumer reads      │
│                                               when chunk arrives  │
│                                               renders immediately │
└───────────────────────────────────────────────────────────────────┘
```

The stream is the buffer between them. `ReadableStream` in the browser and Node has built-in backpressure signalling (the `desiredSize` of the queue), but this codebase does not use it — the producer writes as fast as it can and the consumer reads as fast as it can.

### Where it breaks down

**No built-in reconnect or resume.** If the TCP connection drops mid-stream — a mobile device going under a tunnel, a serverless function timing out — the consumer's `reader.read()` rejects and the stream is gone. There is no cursor, no event ID, no way to resume from where it stopped. The investigation must be re-run (or served from cache if one was saved before the disconnect).

**The serverless duration cap.** `route.ts` L20 sets `export const maxDuration = 300` (Vercel Pro's max). The combined diagnose+recommend run is ~100–115s under the ~1 req/s MCP limit; the Hobby tier's 60s cannot fit it, which is part of why the investigation is split into two requests (`step=diagnose`, `step=recommend`) — each step runs only one agent and stays well under any cap. If the environment enforces a lower limit and a step exceeds it, the stream is cut off before `done`. The cache replay path is unaffected (it replays fast).

**Line-buffering complexity.** The consumer must implement `buf.split('\n')` + `lines.pop()` correctly. Getting this wrong (e.g., not keeping the trailing partial) produces sporadic JSON parse errors that are hard to reproduce because they depend on TCP chunk boundaries.

### What to explore next

- **SSE / EventSource in depth:** study how `data:`, `id:`, and `retry:` fields work; understand exactly when auto-reconnect fires and what `Last-Event-ID` lets you do; good for cases where reconnect is desirable.
- **Resumable streams with event IDs:** pattern for giving each event an ID so a reconnecting client can ask for events after the last ID it received; requires server-side event log.
- **ReadableStream backpressure:** study `controller.desiredSize`, the `pull` callback, and the WHATWG Streams spec; relevant when the producer is faster than the consumer and you need flow control.

---

## Interview defense

### What they are really asking

When an interviewer asks about streaming in this codebase they want to know: do you understand why `fetch`-stream was used instead of `EventSource`? Can you explain the line-buffering mechanic? Do you know what goes wrong if a chunk boundary falls mid-JSON? Can you trace the full path from server event to DOM update?

---

### [mid] "Walk me through how the browser reads the NDJSON stream."

`res.body.getReader()` locks the stream to one reader. Each `reader.read()` call resolves when the next chunk of bytes arrives — or with `done: true` when the server closes the stream. The bytes are decoded to a string with `TextDecoder` (with `{ stream: true }` to handle multi-byte chars at boundaries), appended to a buffer, split on `'\n'`, and the trailing incomplete fragment is popped off and held for the next chunk. Every complete line is `JSON.parse`d and dispatched to `handle`. This is the loop at `lib/hooks/useInvestigation.ts` L184–L201.

```
┌───────────────────────────────────────────────────────────────┐
│  reader.read() → Uint8Array                                   │
│       │                                                       │
│       └─ decode → string → append to buf                     │
│                                                               │
│  buf.split('\n') → [ line1, line2, ..., partial ]            │
│  buf = partial                                                │
│                                                               │
│  for line1, line2, ...: JSON.parse → handle → setState       │
└───────────────────────────────────────────────────────────────┘
```

---

### [senior] "Why not use EventSource? It's designed for server push."

`EventSource` is designed for server push and auto-reconnects when the connection drops. In this app, a GET to `/api/agent` triggers a ~115s AI agent run. Auto-reconnect means auto-re-run — a second Anthropic API call, a second investigation, a duplicate result. `fetch`-stream closes on disconnect and stays closed. The application sets an error state and the user decides what to do. The feature is a bug here.

Additionally, `EventSource` requires SSE framing (`data:`, `event:`, `id:` fields). NDJSON is simpler: one JSON object per line, no envelope.

```
┌─────────────────────────────────────────────────────────────────────┐
│  EventSource reconnect re-runs the agent                            │
│                                                                     │
│  connection drop at t=60s                                           │
│  EventSource retries after retry-ms (default 3s)                   │
│  GET /api/agent → NEW 115s run → duplicate investigation            │
│                                                                     │
│  fetch-stream on drop:                                              │
│  reader.read() rejects → catch → setError → user sees error        │
│  No retry. No duplicate run.                                        │
└─────────────────────────────────────────────────────────────────────┘
```

---

### [arch] "`maxDuration` is 300s and the full investigation takes ~100–115s. Why split it into two requests anyway?"

`route.ts` L20 sets `maxDuration = 300` (Vercel Pro's max), and a combined diagnose+recommend run is ~100–115s — so duration alone is not the forcing function on Pro. The split exists for two reasons: it keeps each individual request comfortably under any cap (Hobby's 60s could not fit the combined run), and it matches the product's two-page flow — step 2 (`/investigate/[id]`) runs only the diagnostic agent, step 3 (`/investigate/[id]/recommend`) runs only the recommendation agent with the diagnosis handed over via `sessionStorage`. If a single step ever exceeds the cap, the stream closes without emitting `done`: the consumer's `reader.read()` returns `{ done: true }` (clean platform close) or rejects, `complete` stays `false`, and the UI shows "analyzing…" forever.

The cache replay path is unaffected — it replays a step-filtered stored sequence in `events.length × 180ms` total time, well under any cap.

The mitigation if a step grows too long is to lower per-agent budgets, or move the agent run to a background queue (e.g., a Vercel Cron + database polling) and have the consumer poll for the cached result rather than stream from the live run.

---

### The dodge — "why not SSE/EventSource, isn't that the standard for server push?"

Honest answer: SSE/`EventSource` is the standard for server push when you want reconnect and don't care about re-running the handler. Here you care — a reconnect re-runs a ~115s, non-free AI agent call. The decision to use `fetch`-stream is not a rejection of SSE; it is a recognition that reconnect is wrong for this use case. If the investigations were cheap or idempotent at no cost, `EventSource` would be simpler.

```
┌────────────────────────────────┬──────────────────────────────────────┐
│  SSE/EventSource               │  fetch-stream (this codebase)        │
├────────────────────────────────┼──────────────────────────────────────┤
│  auto-reconnect on drop        │  no reconnect                        │
│  correct for cheap/idempotent  │  correct for expensive/non-idempotent│
│  `text/event-stream` framing   │  plain NDJSON                        │
│  EventSource browser API       │  fetch + getReader() loop            │
│  simpler consumer code         │  manual buf+split consumer           │
└────────────────────────────────┴──────────────────────────────────────┘
```

---

### Anchors

- `lib/mcp/events.ts` L4–L12 — the `AgentEvent` union is the complete wire contract
- `app/api/agent/route.ts` L20 — `maxDuration = 300`
- `app/api/agent/route.ts` L105 — `REPLAY_DELAY_MS = 180`
- `app/api/agent/route.ts` L66–L84 — `filterByStep` (step-sliced replay)
- `app/api/agent/route.ts` L168–L267 — the `ReadableStream` producer (live run); bootstrap inside at L196–L202
- `lib/hooks/useInvestigation.ts` L184–L201 — the `fetch` consumer loop
- `lib/hooks/useInvestigation.ts` L43, L47–L48 — StrictMode `startedRef` guard

---

## Validate your understanding

### Level 1 — Reconstruct

Without looking at the code, write the producer side: a Next.js route handler that creates a `ReadableStream`, encodes events as NDJSON lines, and returns them with `Content-Type: application/x-ndjson`. Then write the consumer side: a `useEffect` that reads the stream, buffers chunks, splits on newline, and calls a handler per line. Compare to `route.ts` L168–L267 and `lib/hooks/useInvestigation.ts` L153–L212.

### Level 2 — Explain

Open `lib/hooks/useInvestigation.ts`. At L190, `dec.decode(value, { stream: true })` is called. What does the `{ stream: true }` option do? What would go wrong if you omitted it and the server sent a string containing a multi-byte UTF-8 character (e.g., "—") that was split across two TCP chunks? Then explain why L192 (`buf = lines.pop() ?? ''`) is the critical line in the consumer loop. What invariant does it maintain?

### Level 3 — Apply

**Scenario:** A user reports that the trace shows 3 tool calls but the diagnosis panel never renders. The stream eventually closes. Where in the consumer loop do you look?

Start at `handle` in `useInvestigation.ts` L97–L151. Check the `case 'diagnosis':` branch (L122–L125) — it sets `diagnosis` state. If `diagnosis` is never set, either: (a) the `diagnosis` event was never emitted by the producer (check `route.ts` L239 — note the diagnose step is the only one that emits it), (b) the line containing the `diagnosis` event was malformed and fell into the per-line `catch` block at L195–L199 (silently ignored), or (c) the line containing the `diagnosis` event was split across two chunks and the partial was lost.

For case (c) — a line split across two chunks: the `buf.split('\n')` + `lines.pop()` pattern handles this correctly. `buf` accumulates the partial line until the next chunk completes it. If `{ stream: true }` was missing from `TextDecoder` (L190), a multi-byte character in the diagnosis JSON could produce the replacement character `�`, making `JSON.parse` throw and landing in the silent catch at L195–L199. Check `lib/mcp/events.ts` L4–L12 for the `diagnosis` event shape — the `diagnosis` field must be present or the switch falls through to `default` (L148–L149) silently.

### Level 4 — Defend

An interviewer asks: "you're manually line-buffering in the browser — isn't that fragile? `EventSource` handles all that for you." Defend the choice. Name one specific failure mode EventSource would cause in this app and one specific failure mode the manual buffer approach could have if implemented incorrectly.

### Quick check

- What is the exact return value of `encodeEvent({ type: 'done' })`?
- What does `lines.pop()` return when `buf` ends with `\n` (i.e., the last event is complete)?
- What is `REPLAY_DELAY_MS` and where is it defined?
- Why does the `startedRef` guard exist in development but matter less in production?
- What HTTP header signals to CDN proxies that this response should not be buffered?

## See also

→ 06-multi-agent-orchestration.md · → ../02-dsa/03-ndjson-line-buffering.md · → 01-request-flow.md

---
Updated: 2026-05-28 — maxDuration 300; reader loop moved to useInvestigation.ts; schema bootstrap now emitted inside the stream; documented the `step`-filtered cached replay + pre-stream try/catch.

---
Updated: 2026-05-29 — documented the briefing route as a second NDJSON surface (local `BriefingEvent` superset L54–58, paced demo replay REPLAY_DELAY_MS=140 L23, per-category `coverage_item` tile-by-tile fill L209–212 / client accumulate app/page.tsx L333–339).
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".

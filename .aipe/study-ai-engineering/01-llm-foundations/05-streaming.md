# Streaming (NDJSON over ReadableStream, not EventSource)

**Industry name(s):** streaming responses, server-sent incremental output, NDJSON / line-delimited JSON over a `ReadableStream`
**Type:** Industry standard · Language-agnostic

> The agent route emits one JSON event per line over a `ReadableStream`; the browser consumes it with `fetch` + `getReader()` + `TextDecoder` and a manual line-buffer loop — a deliberate "show its work" product surface, built on raw NDJSON rather than `EventSource` so a reconnect can never re-fire the agent run.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Streaming is the *only* concept in this guide that spans three bands at once: the agent loop emits events in the Per-agent layer (`hooksFor` wiring), the Route handler frames them as NDJSON inside `ReadableStream.start` (`app/api/agent/route.ts` L169–L265), and the UI reads them line-by-line in `lib/hooks/useInvestigation.ts`. The Provider sits below, producing reasoning increments; the consumer sits above, rendering each event as it arrives.

```
  Zoom out — where streaming lives (spans three bands)

  ┌─ UI ─────────────────────────────────────────────┐  ← we are here (one end)
  │  useInvestigation hook: getReader + line buffer  │
  │  ★ buf = lines.pop() — partial-line guard ★      │
  └─────────────────────────▲────────────────────────┘
                            │  NDJSON "{...}\n{...}\n..."
  ┌─ Route handler ─────────┴────────────────────────┐  ← we are here (other end)
  │  ★ ReadableStream.start ★  route.ts L169–265     │
  │  send(e) → encode → controller.enqueue           │
  │  NDJSON_HEADERS  (NOT text/event-stream)         │
  └─────────────────────────▲────────────────────────┘
                            │  per-event callbacks
  ┌─ Pipeline + Per-agent ──┴────────────────────────┐
  │  hooksFor wires onText/onToolCall → send         │
  └─────────────────────────▲────────────────────────┘
                            │
  ┌─ Provider ──────────────┴────────────────────────┐
  │  runAgentLoop produces reasoning increments      │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: do you make the user stare at a spinner for 30+ seconds while the agent runs, or do you stream each reasoning step, tool call, and partial result as it happens? For this product the trace *is* the value — and the transport choice (NDJSON over `fetch`/`getReader()`, not `EventSource`) is decisive because each `GET` *starts* an expensive non-idempotent run that auto-reconnect would double. How it works walks the event vocabulary, the server stream, and the client's line-buffer loop.

---

## How it works

**Mental model.** This is the exact shape of consuming any chunked HTTP body in the browser: `fetch` gives you a `res.body` `ReadableStream`, you `getReader()` it, and you pull `Uint8Array` chunks in a loop, decoding each. The only domain-specific part is the framing: each *line* is one complete JSON event (NDJSON), so the client splits on `\n` and parses each line. The server's job is the mirror — write one `JSON.stringify(event) + '\n'` per increment.

```
SERVER                                   CLIENT
──────────────────────────────          ──────────────────────────────
event → encodeEvent → "{...}\n"          chunk (Uint8Array)
controller.enqueue(bytes)        ══▶     buf += decode(chunk)
event → encodeEvent → "{...}\n"          lines = buf.split('\n')
controller.enqueue(bytes)        ══▶     buf = lines.pop()  ← keep partial
...                                       for line: JSON.parse → handleEvent
controller.close()               ══▶     reader.read() → done
```

NDJSON is the framing because it is trivial to produce (`+ '\n'`), trivial to split (`split('\n')`), and self-delimiting — a half-received line stays in the buffer until its `\n` arrives.

---

### The event vocabulary

Every increment is one variant of a discriminated union:

```
  AgentEvent =
    | { type: "reasoning_step",   step }
    | { type: "tool_call_start",  toolName, agent }
    | { type: "tool_call_end",    toolName, agent, durationMs, result?, error? }
    | { type: "insight",          insight }
    | { type: "diagnosis",        diagnosis }
    | { type: "recommendation",   recommendation }
    | { type: "done" }
    | { type: "error",            message }
```

The `type` field is the discriminant; the client's `switch (e.type)` renders each variant differently. `done` and `error` are the terminal events. This is the same pattern as a Redux action union or a WebSocket message protocol — a closed set of typed messages, each self-describing.

```
reasoning_step  → append a thought/hypothesis/conclusion to the trace
tool_call_start → add a "running" tool row
tool_call_end   → flip that row to "done" + duration + result
diagnosis       → fill the evidence panel
recommendation  → append a recommendation card
done            → mark complete
error           → show the error state
```

---

### Encode / decode: one line per event

The framing is two one-line functions:

```
  function encode_event(e):
      return JSON.stringify(e) + "\n"      # NDJSON: JSON + newline

  function decode_event(line):
      return JSON.parse(line)
```

`encode_event` is the entire wire format. The `+ "\n"` is the frame delimiter; everything else is standard JSON.

---

### The server: a ReadableStream that enqueues NDJSON

The route handler builds a `ReadableStream<Uint8Array>` whose `start(controller)` runs the agents and enqueues each event. Crucially, the **schema bootstrap now happens *inside* the stream**, not before it, so the client sees a progress event immediately instead of waiting silently while the route connects and reads the schema:

```
  encoder = new TextEncoder()
  stream  = new ReadableStream({
    async start(controller):
      collected = []
      function send(e):
          collected.push(e)
          controller.enqueue(encoder.encode(encode_event(e)))
      try:
          stepFor(leadAgent, "thought", "reading the workspace schema…")
          schema = await bootstrap_schema(conn.mcp)            # INSIDE the stream
          ... run agents (by `step`), calling send() per increment ...
          send({ type: "done" })
          if step is null:
              save_investigation(insightId, collected)         # combined run only
      catch e:
          send({ type: "error", message: "/api/agent · " + str(e) })
      finally:
          controller.close()
  })
  return new Response(stream, { headers: NDJSON_HEADERS })
```

`send` is the single choke-point: it records the event (for caching the full trace) *and* enqueues its NDJSON bytes. The agent hooks wire each agent's `onText` / `onToolCall` / `onToolResult` to `send` calls, so the model's reasoning streams out the moment the loop surfaces it. The entire body is wrapped in `try/catch/finally` so any error inside the run becomes an `error` event and the stream still closes cleanly. (Pre-stream setup — connecting to MCP — is *also* wrapped in its own try/catch so a setup throw returns the real error message, not a bare 500.)

```
agent loop hook fires
   onText      → send({ type:'reasoning_step', ... })
   onToolCall  → send({ type:'tool_call_start', ... })
   onToolResult→ send({ type:'tool_call_end', ..., result: trunc(...) })
        │
        ▼  send() → encode → enqueue → over the wire immediately
```

Note `result: trunc(tc.result)` — the UI-stream truncation budget (`TRUNC = 4000`, → 02-tokenization.md) keeps each event's payload small on the wire. The briefing route mirrors this exact shape: it bootstraps the schema inside its own `ReadableStream.start` after wrapping the MCP connect in a pre-stream try/catch.

---

### The client: getReader() + TextDecoder + line buffer (in the investigation hook)

The investigation consumer lives in a hook — the investigate page just calls the hook and renders the returned state. The hook consumes the stream with the raw Streams API — no library:

```
  reader = res.body.getReader()
  dec    = new TextDecoder()
  buf    = ""
  loop forever:
      { done, value } = await reader.read()
      if done: break
      buf += dec.decode(value, { stream: true })   # accumulate bytes → text
      lines = buf.split("\n")
      buf   = lines.pop() ?? ""                    # keep the trailing partial line
      for line in lines:
          if line.trim() is empty: continue
          try:
              handle(JSON.parse(line))
          catch:
              # ignore malformed line
```

The critical detail is `buf = lines.pop()` — a chunk boundary can land mid-line, so the last (possibly incomplete) segment is held back until the next chunk completes it. `dec.decode(value, { stream: true })` similarly handles multi-byte UTF-8 characters split across chunks. After the loop, a trailing buffered line is flushed. `handle` is the `switch (e.type)` that updates React state per variant.

The hook runs the reader **exactly once per mount** even under React StrictMode (dev mount → cleanup → re-mount): a started-once ref guard blocks the second run, and the effect deliberately does *not* abort the fetch on cleanup — cancelling on the first StrictMode cleanup would kill the only stream and leave the log empty. Because each request *starts* an expensive run, "run once" is the same non-idempotency concern that rules out `EventSource` below — here enforced at the hook level. The feed page has its *own* separate reader loop for the briefing stream — see "Briefing route — a second streaming surface" below.

```
chunk 1: '{"type":"reasoning_step"...}\n{"type":"tool_'
  split('\n') → ['{...complete...}', '{"type":"tool_']
  parse the complete one; buf = '{"type":"tool_'
chunk 2: 'call_start"...}\n'
  buf + chunk → '{"type":"tool_call_start"...}\n'
  now complete → parse
```

---

### Briefing route — a second streaming surface

The investigation stream is not the only NDJSON surface. The morning briefing is a *second* `ReadableStream` that the feed page consumes with the same `getReader()` + line-buffer loop. It reuses the agent route's NDJSON shape but differs in three deliberate ways worth studying side by side.

**1. A local superset event type — the shared union is left untouched.** The briefing needs two event variants the investigation does not — a `workspace` header (project name + totals) and coverage events for the anomaly grid. Rather than widen the shared `AgentEvent` union (which the agent route and the investigation view depend on), the briefing defines a *local* `BriefingEvent` superset:

```
  BriefingEvent =
    | AgentEvent                                            # reuse the live-activity variants
    | { type: "workspace",       workspace }
    | { type: "coverage_item",   item }                     # one category's tile
    | { type: "coverage",        coverage }                 # bulk form (plain-JSON fallback)
```

`BriefingEvent` *includes* `AgentEvent` (so `reasoning_step` / `tool_call_*` / `insight` / `done` / `error` still stream exactly as before) and adds the briefing-only variants on top. The shared `AgentEvent` contract is unchanged — the comment alongside states this explicitly — so the investigation consumer never has to handle variants it will never receive. The feed page mirrors the same local type for its reader.

**2. Demo-mode paced replay — a slower delay than the agent route.** When `?demo=cached` is set and a snapshot file exists, the briefing replays the captured snapshot as a *paced* NDJSON stream instead of running the live agent: each emit enqueues one event then awaits a `REPLAY_DELAY_MS` of 140. This is the same replay idea as the agent route's cache branch, but with a *different* tempo — the agent route replays at 180ms. The briefing reveals slightly faster (140ms vs 180ms) because it is narrating a longer monitoring sweep into the feed, and the snapshot replay deliberately mirrors the *live* event order (workspace → coverage checklist → trace → insights) so the demo and the real run look identical to the consumer.

**3. Per-category `coverage_item` events fill the grid tile-by-tile.** The most distinctive part: the live briefing does *not* send the coverage report as one bulk event. After gating the 10-category checklist against the schema, it emits one `coverage_item` per category, each paired with a status line, so the coverage grid resolves one tile at a time in step with the checklist log:

```
  for each (item, i) in coverage:
      step(coverageLines[i])                  # a 'reasoning_step' status line
      send({ type: "coverage_item", item })   # one tile of the grid
```

The feed's `handle` accumulates each tile into the grid state (`setCoverage(prev => [...prev, evt.item])`), so the grid *fills progressively* rather than appearing all at once. The bulk `coverage` variant exists only for the plain-JSON fallback path (when the response is not NDJSON). This is the same "the trace is the product" principle applied to coverage: the user watches the schema-gate decision resolve category by category.

```
LIVE BRIEFING                                         FEED
──────────────────────────────────────────            ──────────────────────────────
send({type:'workspace', ...})                  ══▶     setWorkspace(...)
for each category:                                      reader.read() loop
  step(coverageLines[i])  ─ reasoning_step ──▶          → setStepStatus / trace log
  send({type:'coverage_item', item})          ══▶       setCoverage(p => [...p, item])
                                                          → grid fills ONE TILE at a time
...trace + insight events (AgentEvent shape)   ══▶       same switch as investigation
send({type:'done'})                            ══▶       setInsights(collected)
```

Demo mode replays this exact sequence from the snapshot, paced at 140ms/event, so the only difference the consumer sees is the source — live agent vs recorded file — not the shape or the order.

---

### Why NDJSON over a ReadableStream, not EventSource

`EventSource` (the Server-Sent Events client) is the obvious browser primitive for server-push, and the system deliberately does **not** use it. The decisive reason: **`EventSource` auto-reconnects, and a reconnect would re-fire the agent run.**

```
EventSource:                          fetch + getReader (this codebase):
  GET /stream                           GET /api/agent?insightId=...
  ── connection drops ──                ── connection drops ──
  AUTO-reconnect → GET /stream again    NO auto-reconnect
  → server START() runs AGAIN           → run stops; client shows what it has
  → second investigation, double cost   → one run, ever
```

Each `GET` on the agent route *starts an investigation* inside `start(controller)` — it runs the model and tool calls that cost tokens and hit a rate-limited provider. `EventSource`'s built-in reconnect would silently launch a *second* run on any network blip, doubling cost and producing a confusing double-trace. `fetch` + `getReader()` has no reconnect: a dropped connection simply ends the read loop, and the client keeps whatever it received. The route also returns plain `Cache-Control: no-cache, no-transform` NDJSON, not the `text/event-stream` format `EventSource` requires.

There is also a divergence worth naming against the curriculum: streaming is listed as *learn-only*, but this system treats it as a **first-class product surface** — the reasoning trace is the UI, so streaming is implemented fully, not skipped.

---

### The principle

Stream when the increments have value, and pick the transport by what reconnect does to your work. NDJSON over a `fetch` `ReadableStream` is the right transport when each `GET` *triggers* expensive, non-idempotent work, because it has no silent reconnect to re-fire that work. `EventSource` is right for cheap, idempotent, resumable feeds. You chose the former precisely because starting the stream *is* starting the investigation.

---

## Streaming — diagram

This diagram spans Service (the route's stream) and UI (the browser consumer). The wire is NDJSON; the frame delimiter is `\n`. A reader who sees only this should grasp that the server enqueues one JSON line per increment and the client line-buffers and dispatches them.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER   app/api/agent/route.ts   │
│                                                                       │
│  new ReadableStream({ async start(controller) {                      │
│    try {                                                             │
│      send(e) = controller.enqueue(encoder.encode(encodeEvent(e)))    │
│      stepFor(lead,'thought','reading the workspace schema…')         │
│      schema = await bootstrapSchema(conn.mcp)  ← INSIDE the stream   │
│      agent hooks → send(reasoning_step / tool_call_start / _end)     │
│      send({type:'diagnosis'}) ... send({type:'recommendation'})      │
│      send({type:'done'}); if(step==null) saveInvestigation(...)      │
│    } catch(e) { send({type:'error', message}) }                      │
│    finally { controller.close() }                                    │
│  }})                                                                 │
│  Response: NDJSON_HEADERS (application/x-ndjson, no-cache)           │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  "{...}\n{...}\n{...}\n"   (NDJSON, chunked)
                            │  NO EventSource — no auto-reconnect
┌───────────────────────────▼───────────────────────────────────────────┐
│  UI LAYER   lib/hooks/useInvestigation.ts   (page just calls it)     │
│                                                                       │
│  startedRef guard → run reader ONCE per mount (StrictMode-safe)      │
│  fetch(`/api/agent?insightId=${id}&step=${step}`)                    │
│  reader = res.body.getReader(); dec = new TextDecoder()              │
│  loop: buf += dec.decode(value,{stream:true})                        │
│        lines = buf.split('\n'); buf = lines.pop()  ← keep partial     │
│        for line: handle(JSON.parse(line))                            │
│           switch(e.type): reasoning_step|tool_call_*|diagnosis|...    │
│              → setItems / setDiagnosis / setRecommendations           │
└────────────────────────────────────────────────────────────────────────┘
```

The server emits one JSON line per increment; the client buffers bytes, splits on `\n`, parses each complete line, and dispatches by `type`. Holding back the trailing partial line is what makes a mid-line chunk boundary safe.

---

## Implementation in codebase

### Files, functions, and line ranges

- **Event union + framing:** `AgentEvent` — `lib/mcp/events.ts` L4–L12; `encodeEvent` (JSON + `\n`) and `decodeEvent` — L15–L22.
- **Server stream:** `ReadableStream` with `start(controller)` — `app/api/agent/route.ts` L169–L265; `send` choke-point at L172–L175; `hooksFor` wiring agent callbacks to `send` at L181–L195; schema bootstrap *inside* the stream at L201–L202; `done`/`saveInvestigation` at L251/L254; `try/catch/finally` body at L196–L263; NDJSON `Response` (`NDJSON_HEADERS`) at L107–L110 / L267. `maxDuration = 300` at L20 (was 60; 300 = Vercel Pro's max — a live diagnostic→recommendation run is ~100–115s under the ~1 req/s MCP limit). Pre-stream `connectMcp` try/catch at L155–L165.
- **Briefing stream (same shape, local `BriefingEvent` superset):** `app/api/briefing/route.ts` — `maxDuration = 300` at L17, bootstrap inside the live `start` at L188–L189, pre-stream try/catch at L161–L171, `BriefingEvent` superset at L54–L58 (deliberately does NOT widen the shared `AgentEvent`), demo-mode paced replay (`REPLAY_DELAY_MS = 140` at L23) at L97–L143, per-category `coverage_item` emit at L209–L212.
- **Cache-replay stream (same NDJSON shape):** precomputed events replayed with `REPLAY_DELAY_MS = 180`, filtered to the requested `step` via `filterByStep` — `app/api/agent/route.ts` L127–L141 (the `getCachedInvestigation` branch; `REPLAY_DELAY_MS` L105, `filterByStep` L66–L84).
- **UI-stream payload truncation:** `TRUNC = 4000` / `trunc` — `app/api/agent/route.ts` L99–L103; applied to `result` at L192.
- **Client consumer (now a hook):** `fetch` at `lib/hooks/useInvestigation.ts` L170; `getReader()` + `TextDecoder` + line-buffer loop at L184–L201; trailing flush at L202–L208; `handle` switch at L97–L151; StrictMode-safe single-run `startedRef` guard at L43, L47–L48. The investigate page (`app/investigate/[id]/page.tsx`) no longer reads the stream itself — it calls `useInvestigation(id, 'diagnose')` (L38). The feed page keeps its own briefing reader loop at `app/page.tsx` (`getReader()` L323, `handle` switch L328–L437, read loop L439–L457; `BriefingEvent` type L28–L32).
- **Not EventSource:** confirmed — the consumer uses `fetch`/`getReader()` (hook L184), and the route returns `application/x-ndjson` (`NDJSON_HEADERS`, route L108), not `text/event-stream`.

### Why this is a codebase strength

The framing is two trivial functions, the server has one `send` choke-point that both records and emits (so the full trace is cacheable *and* live), and the consumer correctly handles the two real-world hazards of chunked reads: mid-line chunk boundaries (`buf = lines.pop()`) and multi-byte UTF-8 split across chunks (`decode(..., { stream: true })`). Pulling the reader into `useInvestigation` adds a StrictMode-safe single-run guard so the dev double-mount cannot fire the expensive run twice. The cache-replay path reuses the *identical* NDJSON shape (filtered per step), so a precomputed investigation streams through the same hook as a live one.

---

## Elaborate

### Where this pattern comes from

NDJSON (newline-delimited JSON, sometimes JSON Lines) is the streaming format used by log pipelines, the Docker daemon API, Elasticsearch bulk operations, and most LLM provider streaming endpoints (which actually wrap it in SSE framing). It wins for streaming because it is append-only and self-delimiting: a writer concatenates `JSON + '\n'`; a reader splits on `\n`. The browser `ReadableStream` + `getReader()` API is the WHATWG Streams standard, the same primitive that backs `fetch` body consumption everywhere.

`EventSource` / Server-Sent Events (the W3C SSE spec) is the *other* server-push primitive. It is purpose-built for resumable, idempotent event feeds: it auto-reconnects, supports `Last-Event-ID` for resumption, and reconnects with backoff. Those features are virtues for a notifications feed and a liability for a one-shot, expensive, non-idempotent agent run.

### The deeper principle

```
GET is idempotent?              transport
──────────────────────────────  ──────────────────────────────
yes — cheap, resumable feed      EventSource (auto-reconnect is free)
no  — each GET does costly work  fetch + getReader (no silent re-fire)
```

The whole choice hinges on one property: does re-issuing the `GET` re-do work? For blooming insights, `GET /api/agent` runs Claude and MCP tool calls — emphatically non-idempotent and expensive. So the transport must *not* reconnect on its own. `fetch` + `getReader()` satisfies that; `EventSource` violates it.

### Where this breaks down

1. **No resumption.** If the connection drops mid-investigation, the client cannot resume from where it left off — it has the partial trace and nothing more. For a 30-second run this is acceptable (re-trigger manually); for a 10-minute job it would need `Last-Event-ID`-style checkpointing, which NDJSON-over-fetch does not provide for free.

2. **`maxDuration = 300` is a hard ceiling.** The route streams within a 300-second budget (`route.ts` L20 — Vercel Pro's max; a live diagnostic→recommendation run is ~100–115s, which Hobby's 60s could not fit). A run that exceeds it is killed mid-stream; the consumer receives events up to the cutoff but no `done`, leaving the UI in `diagnosing…` forever. The budget controls in the agents (→ 06-token-economics.md) exist partly to stay under this.

3. **Backpressure is implicit.** `controller.enqueue` does not block on a slow consumer here; the events are small and the trace is short, so it is fine. A high-volume token-level stream would need to respect the stream's backpressure signals.

### What to explore next

- **SSE for a *different* surface:** a notifications/feed endpoint that *is* idempotent and resumable is the right home for `EventSource` — contrast it with the agent route to make the transport choice concrete.
- **Token-level streaming:** Anthropic's streaming API emits per-token deltas; this codebase streams per-*event* (whole reasoning steps), a coarser granularity that matches the "show its work" product goal.
- **Resumable streams with `Last-Event-ID`:** the checkpointing the current design omits, for longer-running jobs.

---

## Project exercises

### Render a clean "stream killed by `maxDuration`" state

- **Exercise ID:** C1.5 (adapted) — stream-termination UX hardening.
- **What to build:** detect in the hook when the reader ends *without* a `done` event (the `maxDuration = 300` cutoff or a dropped connection) and expose a distinct `interrupted` flag on `InvestigationState`, so the page can render an "investigation interrupted — retry" state instead of leaving the UI in `diagnosing…` forever.
- **Why it earns its place:** shows you understand that `fetch`/`getReader` has no reconnect, so the consumer must handle a truncated stream explicitly.
- **Files to touch:** `lib/hooks/useInvestigation.ts` (after the read loop at L201, branch on whether `complete` was ever set), `app/investigate/[id]/page.tsx` (render the interrupted state, near the status rendering at L40–L50).
- **Done when:** killing the stream before `done` shows a retry-able interrupted state, while a normal run still ends in `complete`.
- **Estimated effort:** 1–4hr

### Add a parallel SSE notifications endpoint to contrast the transport choice

- **Exercise ID:** C1.5 (adapted) — transport-selection by idempotency.
- **What to build:** add an idempotent `GET /api/notifications` that streams new insights via `EventSource` (where auto-reconnect is *desired*), and document in code comments why the agent route does *not* use SSE.
- **Why it earns its place:** demonstrates you can pick the transport by what reconnect does to the work — the exact judgment the agent route encodes.
- **Files to touch:** new `app/api/notifications/route.ts` (`text/event-stream`), a small client using `new EventSource(...)`, referencing `app/api/agent/route.ts` L20 / L107–L110 / L267 for the contrast.
- **Done when:** the notifications client auto-reconnects on a dropped connection without duplicating work, and a comment explains why the agent route cannot.
- **Estimated effort:** 1–4hr

---

## Interview defense

### What an interviewer is really asking

"How do you stream the agent's output?" tests whether you can produce and consume a chunked body correctly *and* whether you chose the transport for the right reason. The senior signal is the `EventSource` rejection: naming auto-reconnect re-firing a non-idempotent run, not just "we used fetch."

### Likely questions

**[mid] How does one agent event get from the route to the screen?**

The route's `send` calls `encodeEvent` (`JSON + '\n'`) and `controller.enqueue`s the bytes (`route.ts` L172–L175). The hook's loop reads chunks, accumulates into `buf`, splits on `\n`, parses each complete line, and dispatches via `handle`'s `switch (e.type)` (`lib/hooks/useInvestigation.ts` L184–L201).

```
send(e) → encode → enqueue ══▶ buf += decode → split('\n') → JSON.parse → handle
```

**[senior] Why not `EventSource`? It's the obvious SSE primitive.**

Because `EventSource` auto-reconnects, and each `GET /api/agent` *starts an investigation* — Claude calls and MCP tool calls that cost tokens and hit a rate-limited provider. A reconnect on any network blip would silently launch a *second* run, doubling cost and producing a confused double-trace. `fetch` + `getReader()` has no reconnect; a dropped connection just ends the loop with whatever was received.

```
EventSource: drop → reconnect → start() runs AGAIN → 2× cost
fetch/reader: drop → loop ends → client keeps partial trace, no re-run
```

**[arch] How does the client survive a chunk boundary that lands mid-line, or mid-UTF-8-character?**

Two mechanisms (`lib/hooks/useInvestigation.ts` L190–L192). For lines: `buf = lines.pop()` holds back the last segment after `split('\n')`, so an incomplete line waits for its `\n` in the next chunk. For bytes: `dec.decode(value, { stream: true })` keeps a multi-byte character split across chunks intact until its remaining bytes arrive.

```
chunk1: '...}\n{"type":"to'   → parse complete; buf='{"type":"to'
chunk2: 'ol_call_start"...}\n'→ buf+chunk completes the line → parse
```

### The question candidates always dodge

**"What happens if the network drops at second 20 of a 30-second run?"** The honest answer: the read loop ends, the client keeps the partial trace, and nothing re-runs — by design, because re-running is expensive. There is *no* resumption; the user re-triggers manually. Candidates who claim it "reconnects and continues" are describing `EventSource`, which is exactly what this codebase rejected.

### One-line anchors

- `lib/mcp/events.ts` L15 — `encodeEvent` = `JSON.stringify(e) + '\n'`, the entire wire format.
- `app/api/agent/route.ts` L172–L175 — the `send` choke-point: record + enqueue (bootstrap-in-stream at L201–L202).
- `app/api/agent/route.ts` L107–L110 — `NDJSON_HEADERS` (`application/x-ndjson`), not `text/event-stream`; `maxDuration = 300` at L20.
- `lib/hooks/useInvestigation.ts` L191–L192 — `buf = lines.pop()`, the partial-line guard; `startedRef` single-run guard at L43/L47–L48.
- `EventSource` rejected: auto-reconnect would re-fire the non-idempotent run.

---

## Validate

### Level 1 — Reconstruct

From memory, draw the server-to-client path: what `encodeEvent` produces, what the client does with each chunk, and the one line that prevents a mid-line chunk boundary from corrupting a parse.

### Level 2 — Explain

Out loud: why does the server's `send` both `collected.push(e)` *and* `controller.enqueue(...)` (`route.ts` L172–L175)? What feature does the `collected` array enable (hint: the cache-replay branch at L127–L141, where `saveInvestigation` at L254 is the write side)?

### Level 3 — Apply

Scenario: a teammate wants to "simplify" by switching the consumer to `new EventSource('/api/agent?insightId=...')`. Open `app/api/agent/route.ts` L169–L262 and explain exactly what breaks: what does `start(controller)` do (including the in-stream `bootstrapSchema` at L202 and the agent runs), and what happens to cost and the trace when `EventSource` reconnects after a blip?

### Level 4 — Defend

A reviewer says: "Streaming is just a fancy spinner — buffer the whole investigation and return one JSON response." Argue why the reasoning trace is the product, not loading noise, citing the `reasoning_step` / `tool_call_*` events (`lib/mcp/events.ts` L4–L12) and what the investigate UI renders from them.

### Quick check — code reference test

What `Content-Type` does the agent route return, and why does that choice rule out `EventSource` on the client? (Answer: `application/x-ndjson; charset=utf-8` — `NDJSON_HEADERS`, `app/api/agent/route.ts` L107–L110; `EventSource` requires `text/event-stream`, and more importantly its auto-reconnect would re-fire the non-idempotent run.)

## See also

→ 04-structured-outputs.md · → 01-what-an-llm-is.md · → 06-token-economics.md

---
Updated: 2026-05-28 — `maxDuration` 60→300; documented schema bootstrap moved inside the `ReadableStream` (+ try/catch error events, briefing route mirror); NDJSON consumer relocated from the investigate page to the StrictMode-safe `useInvestigation` hook; re-derived all route.ts/hook line refs.
Updated: 2026-05-29 — Added "Briefing route — a second streaming surface" (local `BriefingEvent` superset L54–L58 that does NOT widen the shared `AgentEvent`; demo paced replay `REPLAY_DELAY_MS = 140` vs the agent route's 180; per-category `coverage_item` streaming L209–L212 that fills the grid tile-by-tile); refreshed drifted refs — briefing `maxDuration` L16→L17, and the feed's briefing reader from the stale `app/page.tsx` L311–L312 to the live reader (`getReader()` L323, loop L439–L457, `BriefingEvent` L28–L32).
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".

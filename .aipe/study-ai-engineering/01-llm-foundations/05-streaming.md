# Streaming (NDJSON over ReadableStream, not EventSource)

**Industry name(s):** streaming responses, server-sent incremental output, NDJSON / line-delimited JSON over a `ReadableStream`
**Type:** Industry standard · Language-agnostic

> The agent route emits one JSON event per line over a `ReadableStream`; the browser consumes it with `fetch` + `getReader()` + `TextDecoder` and a manual line-buffer loop — a deliberate "show its work" product surface, built on raw NDJSON rather than `EventSource` so a reconnect can never re-fire the agent run.

**See also:** → 04-structured-outputs.md · → 01-what-an-llm-is.md · → 06-token-economics.md

---

## Why care

A long upload shows a progress bar; a chat UI shows a typing indicator; a build log streams lines as they happen. None of these make you wait for the whole operation before showing *something* — they turn a slow, opaque request into a sequence of visible increments. The mechanism is always the same: the server writes chunks as work completes, and the client renders each chunk as it arrives instead of buffering to the end.

An agent investigation is a slow, opaque operation: six tool calls, two model passes, tens of seconds. The question is: do you make the user stare at a spinner until the final `Diagnosis` lands, or do you stream each reasoning step, tool call, and partial result as it happens?

**The pivot: for an agent, the intermediate steps are not loading noise — they are the product.** A briefing tool whose value is "explain why a metric moved" earns trust by *showing* the investigation: the hypotheses considered, the queries run, the evidence gathered. Streaming is not a latency mask here; it is the feature. Hiding the trace behind a spinner would discard the thing users came for.

Before streaming:
- The investigate page shows a spinner for 30+ seconds
- The user has no signal the agent is making progress or stuck
- The whole run is invisible; only the final verdict appears

After streaming:
- Each reasoning step, tool call, and result renders the instant it is produced
- The pipeline pill advances through diagnostic → recommendation live
- The investigation *is* the UI — the trace is the product, not a side effect

It is a build log for an LLM agent: every line of work, visible as it happens.

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

### The event vocabulary (`AgentEvent`)

Every increment is one variant of a discriminated union, `AgentEvent` (`lib/mcp/events.ts` L4–L12):

```typescript
export type AgentEvent =
  | { type: 'reasoning_step'; step: ReasoningStep }
  | { type: 'tool_call_start'; toolName: string; agent: AgentName }
  | { type: 'tool_call_end'; toolName: string; agent: AgentName; durationMs: number; result?: unknown; error?: string }
  | { type: 'insight'; insight: Insight }
  | { type: 'diagnosis'; diagnosis: Diagnosis }
  | { type: 'recommendation'; recommendation: Recommendation }
  | { type: 'done' }
  | { type: 'error'; message: string };
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

The framing is two one-line functions (`lib/mcp/events.ts` L15–L22):

```typescript
export function encodeEvent(e: AgentEvent): string {
  return JSON.stringify(e) + '\n';     // NDJSON: JSON + newline
}
export function decodeEvent(line: string): AgentEvent {
  return JSON.parse(line) as AgentEvent;
}
```

`encodeEvent` is the entire wire format. The `+ '\n'` is the frame delimiter; everything else is standard JSON.

---

### The server: a `ReadableStream` that enqueues NDJSON

`app/api/agent/route.ts` builds a `ReadableStream<Uint8Array>` whose `start(controller)` runs the agents and enqueues each event (L104–L169):

```typescript
const encoder = new TextEncoder();
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const send = (e: AgentEvent) => {
      collected.push(e);
      controller.enqueue(encoder.encode(encodeEvent(e)));   // L110
    };
    // ... run agents, calling send() per increment ...
    send({ type: 'done' });                                  // L161
    saveInvestigation(insightId!, collected);                // L162
  },
});
return new Response(stream, {
  headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform' },
});
```

`send` is the single choke-point: it records the event (for caching the full trace) *and* enqueues its NDJSON bytes. The agent hooks (`hooksFor`, L117–L132) wire each agent's `onText` / `onToolCall` / `onToolResult` to `send` calls, so the model's reasoning streams out the moment the loop surfaces it.

```
agent loop hook fires
   onText      → send({ type:'reasoning_step', ... })
   onToolCall  → send({ type:'tool_call_start', ... })
   onToolResult→ send({ type:'tool_call_end', ..., result: trunc(...) })
        │
        ▼  send() → encode → enqueue → over the wire immediately
```

Note `result: trunc(tc.result)` (L129) — the UI-stream truncation budget (`TRUNC = 4000`, → 02-tokenization.md) keeps each event's payload small on the wire.

---

### The client: `getReader()` + `TextDecoder` + line buffer

The investigate page consumes the stream with the raw Streams API — no library (`app/investigate/[id]/page.tsx` L143–L160):

```typescript
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });   // accumulate bytes → text
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';                        // keep the trailing partial line
  for (const line of lines) {
    if (!line.trim()) continue;
    try { handleEvent(JSON.parse(line) as AgentEvent); }
    catch { /* ignore malformed line */ }
  }
}
```

The critical detail is `buf = lines.pop()` — a chunk boundary can land mid-line, so the last (possibly incomplete) segment is held back until the next chunk completes it. `dec.decode(value, { stream: true })` similarly handles multi-byte UTF-8 characters split across chunks. After the loop, a trailing buffered line is flushed (L162–L168). `handleEvent` (L60–L123) is the `switch (e.type)` that updates React state per variant.

```
chunk 1: '{"type":"reasoning_step"...}\n{"type":"tool_'
  split('\n') → ['{...complete...}', '{"type":"tool_']
  parse the complete one; buf = '{"type":"tool_'
chunk 2: 'call_start"...}\n'
  buf + chunk → '{"type":"tool_call_start"...}\n'
  now complete → parse
```

---

### Why NDJSON over `ReadableStream`, not `EventSource`

`EventSource` (the Server-Sent Events client) is the obvious browser primitive for server-push, and the codebase deliberately does **not** use it. The decisive reason: **`EventSource` auto-reconnects, and a reconnect would re-fire the agent run.**

```
EventSource:                          fetch + getReader (this codebase):
  GET /stream                           GET /api/agent?insightId=...
  ── connection drops ──                ── connection drops ──
  AUTO-reconnect → GET /stream again    NO auto-reconnect
  → server START() runs AGAIN           → run stops; client shows what it has
  → second investigation, double cost   → one run, ever
```

Each `GET /api/agent` *starts an investigation* in `start(controller)` — it runs Claude and MCP tool calls that cost tokens and hit a rate-limited provider. `EventSource`'s built-in reconnect would silently launch a *second* run on any network blip, doubling cost and producing a confusing double-trace. `fetch` + `getReader()` has no reconnect: a dropped connection simply ends the read loop, and the client keeps whatever it received. The route also returns plain `Cache-Control: no-cache, no-transform` NDJSON, not the `text/event-stream` format `EventSource` requires.

There is also a divergence worth naming against the curriculum: streaming is listed as *learn-only*, but blooming insights treats it as a **first-class product surface** — the reasoning trace is the UI, so streaming is implemented fully, not skipped.

---

### The principle

Stream when the increments have value, and pick the transport by what reconnect does to your work. NDJSON over a `fetch` `ReadableStream` is the right transport when each `GET` *triggers* expensive, non-idempotent work, because it has no silent reconnect to re-fire that work. `EventSource` is right for cheap, idempotent, resumable feeds. blooming insights chose the former precisely because starting the stream *is* starting the investigation.

---

## Streaming — diagram

This diagram spans Service (the route's stream) and UI (the browser consumer). The wire is NDJSON; the frame delimiter is `\n`. A reader who sees only this should grasp that the server enqueues one JSON line per increment and the client line-buffers and dispatches them.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER   app/api/agent/route.ts                              │
│                                                                       │
│  new ReadableStream({ async start(controller) {                      │
│      send(e) = controller.enqueue(encoder.encode(encodeEvent(e)))    │ L110
│      agent hooks → send(reasoning_step / tool_call_start / _end)     │ L117–132
│      send({type:'diagnosis'}) ... send({type:'recommendation'})      │ L154,159
│      send({type:'done'}); saveInvestigation(collected)               │ L161–162
│      controller.close()                                              │
│  }})                                                                 │
│  Response: Content-Type application/x-ndjson, no-cache               │ L171–176
└───────────────────────────┬───────────────────────────────────────────┘
                            │  "{...}\n{...}\n{...}\n"   (NDJSON, chunked)
                            │  NO EventSource — no auto-reconnect
┌───────────────────────────▼───────────────────────────────────────────┐
│  UI LAYER   app/investigate/[id]/page.tsx                            │
│                                                                       │
│  fetch(`/api/agent?insightId=${id}`)                                 │ L127
│  reader = res.body.getReader(); dec = new TextDecoder()              │ L143–144
│  loop: buf += dec.decode(value,{stream:true})                        │ L149
│        lines = buf.split('\n'); buf = lines.pop()  ← keep partial     │ L150–151
│        for line: handleEvent(JSON.parse(line))                       │ L152–158
│           switch(e.type): reasoning_step|tool_call_*|diagnosis|...    │ L60–123
│              → setItems / setDiagnosis / setRecommendations           │
└────────────────────────────────────────────────────────────────────────┘
```

The server emits one JSON line per increment; the client buffers bytes, splits on `\n`, parses each complete line, and dispatches by `type`. Holding back the trailing partial line is what makes a mid-line chunk boundary safe.

---

## In this codebase

### Files, functions, and line ranges

- **Event union + framing:** `AgentEvent` — `lib/mcp/events.ts` L4–L12; `encodeEvent` (JSON + `\n`) and `decodeEvent` — L15–L22.
- **Server stream:** `ReadableStream` with `start(controller)` — `app/api/agent/route.ts` L104–L169; `send` choke-point at L108–L111; `hooksFor` wiring agent callbacks to `send` at L117–L132; `done`/`saveInvestigation` at L161–L162; NDJSON `Response` headers at L171–L176. `maxDuration = 60` at L18.
- **Cache-replay stream (same NDJSON shape):** precomputed events replayed with `REPLAY_DELAY_MS = 180` — `app/api/agent/route.ts` L63–L81 (the `getCachedInvestigation` branch).
- **UI-stream payload truncation:** `TRUNC = 4000` / `trunc` — `app/api/agent/route.ts` L44–L48; applied to `result` at L129.
- **Client consumer:** `fetch` at `app/investigate/[id]/page.tsx` L127; `getReader()` + `TextDecoder` + line-buffer loop at L143–L160; trailing flush at L162–L168; `handleEvent` switch at L60–L123.
- **Not EventSource:** confirmed — the client uses `fetch`/`getReader()` (page L143), and the route returns `application/x-ndjson` (route L173), not `text/event-stream`.

### Why this is a codebase strength

The framing is two trivial functions, the server has one `send` choke-point that both records and emits (so the full trace is cacheable *and* live), and the client correctly handles the two real-world hazards of chunked reads: mid-line chunk boundaries (`buf = lines.pop()`) and multi-byte UTF-8 split across chunks (`decode(..., { stream: true })`). The cache-replay path reuses the *identical* NDJSON shape, so a precomputed investigation streams through the same UI code as a live one.

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

2. **`maxDuration = 60` is a hard ceiling.** The route streams within a 60-second budget (`route.ts` L18). A run that exceeds it is killed mid-stream; the client receives events up to the cutoff but no `done`, leaving the UI in `analyzing…` forever. The budget controls in the agents (→ 06-token-economics.md) exist partly to stay under this.

3. **Backpressure is implicit.** `controller.enqueue` does not block on a slow consumer here; the events are small and the trace is short, so it is fine. A high-volume token-level stream would need to respect the stream's backpressure signals.

### What to explore next

- **SSE for a *different* surface:** a notifications/feed endpoint that *is* idempotent and resumable is the right home for `EventSource` — contrast it with the agent route to make the transport choice concrete.
- **Token-level streaming:** Anthropic's streaming API emits per-token deltas; this codebase streams per-*event* (whole reasoning steps), a coarser granularity that matches the "show its work" product goal.
- **Resumable streams with `Last-Event-ID`:** the checkpointing the current design omits, for longer-running jobs.

---

## Tradeoffs

### NDJSON over fetch/getReader vs. EventSource vs. buffered JSON

| Dimension | This codebase (NDJSON + getReader) | EventSource (SSE) | Buffered single JSON response |
|---|---|---|---|
| Time to first byte rendered | Immediate (per event) | Immediate (per event) | After the whole run (30s+) |
| Reconnect behavior | None — manual re-trigger only | Auto-reconnect → re-fires the run | N/A |
| Re-fires expensive work on blip | No | Yes (the dealbreaker) | No |
| Resumption | None | `Last-Event-ID` supported | N/A |
| Client complexity | Manual line buffer + decoder | Built-in `onmessage` | Trivial (`await res.json()`) |
| Trace is the product | Yes | Yes | No — only the verdict shows |

**What we gave up.** Two things `EventSource` gives for free: automatic reconnection and resumption via `Last-Event-ID`. For a 30-second one-shot investigation neither is worth the cost — and the reconnect is actively harmful. We also took on a few lines of manual buffering the SSE client would have handled.

**What the alternative would have cost.** `EventSource` would silently launch a second investigation on any network hiccup — double token cost, a second rate-limited MCP burst, and a doubled/confused trace. A buffered single JSON response would discard the entire product premise: the user would stare at a spinner for 30 seconds and then see only the final verdict, never the reasoning that justifies trusting it.

**The breakpoint.** NDJSON-over-fetch is right while runs are short (under the 60-second `maxDuration`) and re-triggering on failure is acceptable. It stops being sufficient when runs get long enough that a dropped connection mid-stream is costly to redo — at which point resumable streaming (`Last-Event-ID`, checkpointed event offsets) becomes necessary, and the no-reconnect property has to be rebuilt deliberately rather than inherited.

---

## Tech reference (industry pairing)

### NDJSON / line-delimited JSON

- **Codebase uses:** `encodeEvent` = `JSON.stringify(e) + '\n'` (`lib/mcp/events.ts` L15–L17); `Content-Type: application/x-ndjson` (`app/api/agent/route.ts` L173).
- **Why it's here:** append-only, self-delimiting framing that is trivial to produce server-side and split client-side.
- **Leading today:** NDJSON leads for log/event streaming and is the de-facto LLM-streaming payload (2026), usually wrapped in SSE framing by providers.
- **Why it leads:** one line per record makes partial reads recoverable with a single `split('\n')`.
- **Runner-up:** SSE's `data:`-prefixed framing — same idea, more envelope.

### WHATWG `ReadableStream` + `getReader()` + `TextDecoder`

- **Codebase uses:** server `new ReadableStream({ start })` (`route.ts` L105); client `res.body.getReader()` + `new TextDecoder()` (`page.tsx` L143–L144).
- **Why it's here:** the standard, library-free way to produce and consume a chunked body in Next.js and the browser, with no auto-reconnect.
- **Leading today:** the WHATWG Streams API is the universal standard (2026) for chunked I/O in browsers, Node, and edge runtimes.
- **Why it leads:** one API across all JS runtimes; full control over framing, decoding, and termination.
- **Runner-up:** the Vercel AI SDK (`streamText`, `useChat`) — wraps this exact pattern with React hooks; higher-level, less control.

### EventSource / Server-Sent Events (the rejected option)

- **Codebase uses:** nothing — deliberately avoided.
- **Why it's here (absent):** its auto-reconnect would re-fire the non-idempotent, expensive `GET /api/agent` run.
- **Leading today:** SSE leads for idempotent, resumable server-push feeds (notifications, live dashboards) in 2026.
- **Why it leads:** built-in reconnect, `Last-Event-ID` resumption, and a one-line `onmessage` client — virtues for *resumable* feeds.
- **Runner-up:** WebSockets — bidirectional, heavier; overkill for one-way push.

---

## Project exercises

### Render a clean "stream killed by `maxDuration`" state

- **Exercise ID:** C1.5 (adapted) — stream-termination UX hardening.
- **What to build:** detect on the client when the reader ends *without* a `done` event (the `maxDuration = 60` cutoff or a dropped connection) and render a distinct "investigation interrupted — retry" state instead of leaving the UI in `analyzing…` forever.
- **Why it earns its place:** shows you understand that `fetch`/`getReader` has no reconnect, so the client must handle a truncated stream explicitly.
- **Files to touch:** `app/investigate/[id]/page.tsx` (after the read loop, branch on whether `complete` was ever set), and the status rendering near L179–L185.
- **Done when:** killing the stream before `done` shows a retry-able interrupted state, while a normal run still ends in `complete`.
- **Estimated effort:** 1–4hr

### Add a parallel SSE notifications endpoint to contrast the transport choice

- **Exercise ID:** C1.5 (adapted) — transport-selection by idempotency.
- **What to build:** add an idempotent `GET /api/notifications` that streams new insights via `EventSource` (where auto-reconnect is *desired*), and document in code comments why the agent route does *not* use SSE.
- **Why it earns its place:** demonstrates you can pick the transport by what reconnect does to the work — the exact judgment the agent route encodes.
- **Files to touch:** new `app/api/notifications/route.ts` (`text/event-stream`), a small client using `new EventSource(...)`, referencing `app/api/agent/route.ts` L18 / L171–L176 for the contrast.
- **Done when:** the notifications client auto-reconnects on a dropped connection without duplicating work, and a comment explains why the agent route cannot.
- **Estimated effort:** 1–4hr

---

## Summary

The agent route streams its work as NDJSON over a `ReadableStream`: `encodeEvent` writes one `JSON + '\n'` per increment (`lib/mcp/events.ts`), a single `send` choke-point both records and enqueues each event, and agent hooks turn the model's reasoning into a live event stream. The browser consumes it with `fetch` + `getReader()` + `TextDecoder` and a line-buffer loop that holds back partial lines (`app/investigate/[id]/page.tsx`). The codebase deliberately avoids `EventSource` because its auto-reconnect would re-fire the expensive, non-idempotent investigation. Streaming here is not a latency mask — the reasoning trace is the product.

**Key points:**
- NDJSON framing is one line per event (`JSON.stringify(e) + '\n'`); the client splits on `\n` and keeps the trailing partial line.
- `AgentEvent` is a discriminated union; the client renders each variant via `switch (e.type)`.
- The server's `send` records the event (for caching the full trace) and enqueues its bytes in one place.
- `EventSource` is rejected because reconnect would re-start the investigation, doubling cost — `fetch`/`getReader` has no silent reconnect.
- The transport choice follows from idempotency: each `GET /api/agent` *does* expensive work, so it must not auto-reconnect.

---

## Interview defense

### What an interviewer is really asking

"How do you stream the agent's output?" tests whether you can produce and consume a chunked body correctly *and* whether you chose the transport for the right reason. The senior signal is the `EventSource` rejection: naming auto-reconnect re-firing a non-idempotent run, not just "we used fetch."

### Likely questions

**[mid] How does one agent event get from the route to the screen?**

The route's `send` calls `encodeEvent` (`JSON + '\n'`) and `controller.enqueue`s the bytes (`route.ts` L110). The client's loop reads chunks, accumulates into `buf`, splits on `\n`, parses each complete line, and dispatches via `handleEvent`'s `switch (e.type)` (`page.tsx` L143–L160).

```
send(e) → encode → enqueue ══▶ buf += decode → split('\n') → JSON.parse → handleEvent
```

**[senior] Why not `EventSource`? It's the obvious SSE primitive.**

Because `EventSource` auto-reconnects, and each `GET /api/agent` *starts an investigation* — Claude calls and MCP tool calls that cost tokens and hit a rate-limited provider. A reconnect on any network blip would silently launch a *second* run, doubling cost and producing a confused double-trace. `fetch` + `getReader()` has no reconnect; a dropped connection just ends the loop with whatever was received.

```
EventSource: drop → reconnect → start() runs AGAIN → 2× cost
fetch/reader: drop → loop ends → client keeps partial trace, no re-run
```

**[arch] How does the client survive a chunk boundary that lands mid-line, or mid-UTF-8-character?**

Two mechanisms (`page.tsx` L149–L151). For lines: `buf = lines.pop()` holds back the last segment after `split('\n')`, so an incomplete line waits for its `\n` in the next chunk. For bytes: `dec.decode(value, { stream: true })` keeps a multi-byte character split across chunks intact until its remaining bytes arrive.

```
chunk1: '...}\n{"type":"to'   → parse complete; buf='{"type":"to'
chunk2: 'ol_call_start"...}\n'→ buf+chunk completes the line → parse
```

### The question candidates always dodge

**"What happens if the network drops at second 20 of a 30-second run?"** The honest answer: the read loop ends, the client keeps the partial trace, and nothing re-runs — by design, because re-running is expensive. There is *no* resumption; the user re-triggers manually. Candidates who claim it "reconnects and continues" are describing `EventSource`, which is exactly what this codebase rejected.

### One-line anchors

- `lib/mcp/events.ts` L15 — `encodeEvent` = `JSON.stringify(e) + '\n'`, the entire wire format.
- `app/api/agent/route.ts` L110 — the `send` choke-point: record + enqueue.
- `app/api/agent/route.ts` L173 — `application/x-ndjson`, not `text/event-stream`.
- `app/investigate/[id]/page.tsx` L150–L151 — `buf = lines.pop()`, the partial-line guard.
- `EventSource` rejected: auto-reconnect would re-fire the non-idempotent run.

---

## Validate

### Level 1 — Reconstruct

From memory, draw the server-to-client path: what `encodeEvent` produces, what the client does with each chunk, and the one line that prevents a mid-line chunk boundary from corrupting a parse.

### Level 2 — Explain

Out loud: why does the server's `send` both `collected.push(e)` *and* `controller.enqueue(...)` (`route.ts` L108–L111)? What feature does the `collected` array enable (hint: the cache-replay branch at L63–L81)?

### Level 3 — Apply

Scenario: a teammate wants to "simplify" by switching the client to `new EventSource('/api/agent?insightId=...')`. Open `app/api/agent/route.ts` L104–L162 and explain exactly what breaks: what does `start(controller)` do, and what happens to cost and the trace when `EventSource` reconnects after a blip?

### Level 4 — Defend

A reviewer says: "Streaming is just a fancy spinner — buffer the whole investigation and return one JSON response." Argue why the reasoning trace is the product, not loading noise, citing the `reasoning_step` / `tool_call_*` events (`lib/mcp/events.ts` L4–L12) and what the investigate UI renders from them.

### Quick check — code reference test

What `Content-Type` does the agent route return, and why does that choice rule out `EventSource` on the client? (Answer: `application/x-ndjson; charset=utf-8` — `app/api/agent/route.ts` L173; `EventSource` requires `text/event-stream`, and more importantly its auto-reconnect would re-fire the non-idempotent run.)

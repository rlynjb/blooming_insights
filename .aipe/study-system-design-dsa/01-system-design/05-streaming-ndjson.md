# Streaming reasoning over NDJSON

**Industry name(s):** server-streamed responses (chunked transfer), newline-delimited JSON (NDJSON / JSON Lines), producer/consumer over a ReadableStream
**Type:** Industry standard · Language-agnostic

> The server writes one JSON object per line into an HTTP response body as events are produced, and the browser reads those lines incrementally with `fetch` + `response.body.getReader()`, updating React state with each parsed event so the UI renders before the full response is complete.

**See also:** → 06-multi-agent-orchestration.md · → ../02-dsa/03-ndjson-line-buffering.md · → 01-request-flow.md

---

## Why care

You fire `fetch('/api/heavy-task')` and it takes two minutes to return. You could `await res.json()` — the browser waits, the spinner spins, the user stares. Or you could stream: the server writes partial results the moment they exist and the browser appends them to the list in state as each chunk arrives. You already know this pattern from virtual scroll and pagination — data arrives in pieces and you render pieces.

The question is: how does the server push incremental events and the browser render them as they arrive, over a single HTTP request?

**This matters in practice.** A live investigation in this codebase runs for ~115 seconds. A blank spinner for that long reads as a hang. Streaming the reasoning trace — each thought, each tool call, each hypothesis — is the product's "show your work" differentiator: the user watches the agent think in real time rather than waiting for a completed report. The choice of transport is also load-bearing: `EventSource` (the browser API purpose-built for server-push) auto-reconnects on close, which would silently re-fire the entire ~115s agent run every time the connection dropped. `fetch`-stream does not auto-reconnect, which is exactly what this case needs.

Before streaming:
- Server runs the full agent pipeline (~115s)
- Browser waits behind a spinner
- User has no signal the request is alive
- A dropped connection means the entire run restarts

After streaming:
- Server writes one NDJSON line per event as it produces it
- Browser appends each event to React state as it arrives
- User watches the reasoning trace animate in real time
- A dropped connection closes the stream; it does not restart

It is `fetch` you read chunk-by-chunk instead of `await res.json()`.

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
│  Consumer (React page)                                                  │
│                                                                         │
│  res.body.getReader()                                                   │
│       │                                                                 │
│       └→ read() → Uint8Array → TextDecoder.decode() → append to buf    │
│                                                                         │
│  buf.split('\n') → keep trailing partial → parse each complete line    │
│       │                                                                 │
│       └→ handleEvent(e) → switch(e.type) → setState(...)               │
│                                           → React re-renders           │
└─────────────────────────────────────────────────────────────────────────┘
```

One `read()` call returns one Uint8Array chunk. A chunk may contain multiple complete lines, one partial line, or any combination. The buffer reassembly step is the core mechanical detail.

---

### The AgentEvent contract

`lib/mcp/events.ts` defines the wire format as a discriminated union. Every event that crosses the network is one of these shapes:

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

`encodeEvent(e)` is exactly `JSON.stringify(e) + '\n'` (L15–L17). `decodeEvent(line)` is `JSON.parse(line)` (L20–L22). The newline is the delimiter — no length prefix, no framing, just newlines between JSON objects. One event per line.

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

`app/api/agent/route.ts` L105–L169 constructs a `ReadableStream<Uint8Array>` and passes it directly to the `Response` constructor. The producer lives entirely in the `start(controller)` callback.

```
ReadableStream<Uint8Array>({
  async start(controller) {
    const send = (e: AgentEvent) => {
      collected.push(e);                           // accumulate for cache
      controller.enqueue(encoder.encode(encodeEvent(e)));  // push to wire
    };
    // ...investigation logic...
    controller.close();   // signals EOF to the consumer
  }
})
```

`send` does two things: it enqueues the encoded event bytes so the network layer flushes them immediately, and it pushes to `collected` so the full sequence can be saved for cache replay (L107–L110).

The live investigation flow (L145–L162) produces events in this order:

```
┌──────────────────────────────────────────────────────────────────┐
│  Live investigation event sequence                               │
│                                                                  │
│  reasoning_step (diagnostic · thought)      ← investigation start│
│       │                                                          │
│       ├─ tool_call_start  ┐                                      │
│       ├─ reasoning_step   ├─ repeated per tool call              │
│       └─ tool_call_end    ┘                                      │
│       │                                                          │
│  diagnosis                                  ← DiagnosticAgent done│
│       │                                                          │
│  reasoning_step (recommendation · thought)                       │
│       │                                                          │
│       ├─ tool_call_start  ┐                                      │
│       ├─ reasoning_step   ├─ repeated per tool call              │
│       └─ tool_call_end    ┘                                      │
│       │                                                          │
│  recommendation (×N)                        ← one per proposal   │
│       │                                                          │
│  done                                       ← stream close       │
└──────────────────────────────────────────────────────────────────┘
```

The `hooksFor(agent)` helper (L117–L131) bridges the agent callbacks (`onText`, `onToolCall`, `onToolResult`) to `send`, so each agent's internal events flow out as NDJSON lines automatically.

---

### The consumer loop

`app/investigate/[id]/page.tsx` L125–L172 is the entire consumer. It is a plain async IIFE inside `useEffect`:

```
const res = await fetch(`/api/agent?insightId=${id}`);   // L127

// 401 → redirect to OAuth (L129–135)

const reader = res.body.getReader();   // L143
const dec = new TextDecoder();         // L144
let buf = '';                          // L145

for (;;) {
  const { done, value } = await reader.read();   // L147
  if (done) break;                               // L148
  buf += dec.decode(value, { stream: true });    // L149
  const lines = buf.split('\n');                 // L150
  buf = lines.pop() ?? '';                       // L151 — keep trailing partial
  for (const line of lines) {
    if (!line.trim()) continue;                  // L153
    handleEvent(JSON.parse(line) as AgentEvent); // L155
  }
}
// flush trailing buffer after stream closes (L162–168)
if (buf.trim()) handleEvent(JSON.parse(buf) as AgentEvent);
```

The key mechanic at L150–L151: `split('\n')` produces N+1 parts for N newlines. The last part is the incomplete line that hasn't been terminated yet. `lines.pop()` pulls it out and puts it back in `buf` for the next iteration. Every element remaining in `lines` is a complete, parseable JSON object.

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

`TextDecoder` is constructed with no arguments, defaulting to UTF-8. The `{ stream: true }` option (L149) tells it not to flush multi-byte character sequences at chunk boundaries — without it, a UTF-8 character split across two chunks would produce the Unicode replacement character.

`handleEvent` (L60–L123) is a `switch(e.type)` that calls the appropriate `setState` updater for each event type.

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

The auto-reconnect is the disqualifier. When `EventSource` loses the connection it re-issues the GET request. In this app that GET request triggers a new ~115s agent run against Anthropic's API. Auto-reconnect becomes auto-re-bill and a phantom duplicate investigation. `fetch`-stream closes on disconnect and stays closed. The application decides what to do next.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  EventSource reconnect behaviour (why it's wrong here)                  │
│                                                                          │
│  Browser ──GET /api/agent──► Server: starts 115s agent run ─► stream    │
│           ←── stream ────────────────────────────────────              │
│  connection drops                                                        │
│  Browser waits retry-ms                                                  │
│  Browser ──GET /api/agent──► Server: starts ANOTHER 115s agent run ──► │
│                              (previous run still in-flight or wasted)   │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│  fetch-stream behaviour (what actually happens)                          │
│                                                                          │
│  Browser ──GET /api/agent──► Server: starts 115s agent run ─► stream    │
│           ←── stream ────────────────────────────────────              │
│  connection drops                                                        │
│  reader.read() rejects with a network error                              │
│  catch block sets error state (L169–171)                                 │
│  No retry. User sees the error. User decides.                            │
└──────────────────────────────────────────────────────────────────────────┘
```

The `startedRef` guard (L42–L48) handles the other source of duplicate runs: React StrictMode in development double-invokes `useEffect` callbacks. `startedRef.current` flips to `true` on first invocation; the second invocation returns immediately.

---

### The cache replay path

When `getCachedInvestigation(insightId)` returns a stored event sequence (L63), the handler skips the live agent run and replays the stored events with `REPLAY_DELAY_MS = 180` ms between each (L50, L64–81). No Anthropic API key is needed.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Cache replay (route.ts L64–81)                                     │
│                                                                      │
│  cached = [ event1, event2, ..., done ]                             │
│       │                                                             │
│       └─ for (const e of cached) {                                  │
│               controller.enqueue(encoder.encode(encodeEvent(e)));   │
│               await sleep(REPLAY_DELAY_MS);   // 180 ms             │
│          }                                                          │
│          controller.close();                                        │
│                                                                      │
│  Same wire format → same consumer loop → trace animates             │
│  No API key · No MCP connection · Same UX as live run               │
└─────────────────────────────────────────────────────────────────────┘
```

The consumer loop is unaware of the difference. It reads NDJSON lines the same way regardless of whether they were produced by a live agent or replayed from cache. The 180ms delay is what produces the visible animation — without it all events would arrive in one or two chunks and the trace would appear to pop in rather than animate.

---

### Live-run vs cache-replay side-by-side

```
┌─────────────────────────────────────────┬─────────────────────────────────────────┐
│  Live run                               │  Cache replay                           │
├─────────────────────────────────────────┼─────────────────────────────────────────┤
│  needs ANTHROPIC_API_KEY                │  no API key needed                      │
│  needs MCP connection + auth            │  no MCP connection                      │
│  ~115s wall-clock time                  │  events.length × 180ms                  │
│  events are non-deterministic           │  events are identical each replay       │
│  events are written to collected[]      │  events are read from cached[]          │
│  saved to cache on done (L162)          │  served from cache on hit (L63–81)      │
│  same wire format                       │  same wire format                       │
│  same consumer loop                     │  same consumer loop                     │
└─────────────────────────────────────────┴─────────────────────────────────────────┘
```

### The principle

Decouple producer cadence from consumer render via a stream and a shared event contract. The producer writes when it has something to write. The consumer reads when chunks arrive. Neither side waits for the other to finish. The contract (the `AgentEvent` union) is the only coupling.

---

## Streaming reasoning over NDJSON — diagram

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER  (app/api/agent/route.ts)                                         │
│                                                                                  │
│  ReadableStream<Uint8Array>                                                      │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │  start(controller)                                                       │    │
│  │                                                                          │    │
│  │  DiagnosticAgent ──→ send(reasoning_step) ──→ controller.enqueue(bytes) │    │
│  │                  ──→ send(tool_call_start) ─→ controller.enqueue(bytes) │    │
│  │                  ──→ send(tool_call_end)  ──→ controller.enqueue(bytes) │    │
│  │                  ──→ send(diagnosis)      ──→ controller.enqueue(bytes) │    │
│  │                                                                          │    │
│  │  RecommendationAgent ─→ send(recommendation) → controller.enqueue(...) │    │
│  │                                                                          │    │
│  │  send(done) → controller.close()                                        │    │
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
│  UI LAYER  (app/investigate/[id]/page.tsx)                                       │
│                                                                                  │
│  fetch('/api/agent?insightId=...')                                               │
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
│                       handleEvent(e) ──→ switch(e.type)                          │
│                               │                                                  │
│              ┌────────────────┼────────────────┬──────────────────┐             │
│              ▼                ▼                ▼                  ▼             │
│        setItems(...)    setDiagnosis(...)  setRecommendations(...)  setComplete  │
│              │                │                │                  │             │
│              └────────────────┴────────────────┴──────────────────┘             │
│                                       │                                          │
│                               React re-renders                                   │
│                               ReasoningTrace · EvidencePanel · RecommendationCard│
└──────────────────────────────────────────────────────────────────────────────────┘
```

The service layer produces. The network carries. The UI layer consumes. Nothing is shared across the boundary except bytes.

---

## In this codebase

| File | Function / symbol | Lines |
|---|---|---|
| `lib/mcp/events.ts` | `AgentEvent` union (wire format) | L4–L12 |
| `lib/mcp/events.ts` | `encodeEvent` | L15–L17 |
| `lib/mcp/events.ts` | `decodeEvent` | L20–L22 |
| `app/api/agent/route.ts` | `REPLAY_DELAY_MS` constant | L50 |
| `app/api/agent/route.ts` | Cache-first replay block | L61–L81 |
| `app/api/agent/route.ts` | Live `ReadableStream` + `send` | L104–L169 |
| `app/api/agent/route.ts` | `hooksFor` bridge | L117–L131 |
| `app/api/agent/route.ts` | Investigation sequence (diagnosis→recommendation→done) | L145–L162 |
| `app/api/agent/route.ts` | `saveInvestigation` call | L162 |
| `app/investigate/[id]/page.tsx` | `startedRef` StrictMode guard | L42–L48 |
| `app/investigate/[id]/page.tsx` | `handleEvent` switch | L60–L123 |
| `app/investigate/[id]/page.tsx` | `fetch` + reader loop | L125–L172 |
| `app/investigate/[id]/page.tsx` | `buf.split('\n')` + `lines.pop()` | L150–L151 |
| `app/investigate/[id]/page.tsx` | 401 → authUrl redirect | L129–L135 |

**Consumer loop (trimmed pseudocode):**

```typescript
// app/investigate/[id]/page.tsx L143–L168
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
    handleEvent(JSON.parse(line) as AgentEvent);
  }
}
if (buf.trim()) handleEvent(JSON.parse(buf) as AgentEvent);
```

**Producer send sequence (trimmed pseudocode):**

```typescript
// app/api/agent/route.ts L107–L162
const send = (e: AgentEvent) => {
  collected.push(e);
  controller.enqueue(encoder.encode(encodeEvent(e)));
};
// investigation flow:
stepFor('diagnostic', 'thought', '...');
const diagnosis = await diagAgent.investigate(inv, hooksFor('diagnostic'));
send({ type: 'diagnosis', diagnosis });
stepFor('recommendation', 'thought', '...');
const recommendations = await recAgent.propose(inv, diagnosis, hooksFor('recommendation'));
for (const r of recommendations) send({ type: 'recommendation', recommendation: r });
send({ type: 'done' });
saveInvestigation(insightId!, collected);
```

GitHub:
- [`lib/mcp/events.ts`](https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/events.ts)
- [`app/api/agent/route.ts`](https://github.com/rlynjb/blooming_insights/blob/main/app/api/agent/route.ts)
- [`app/investigate/[id]/page.tsx`](https://github.com/rlynjb/blooming_insights/blob/main/app/investigate/%5Bid%5D/page.tsx)

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

**The 60s serverless cap.** `route.ts` L18 sets `export const maxDuration = 60`. Vercel's free tier allows up to 60s for function execution. A live investigation runs ~115s. If the environment enforces this limit, the stream will be cut off before `done` is emitted. The cache replay path is unaffected (it replays fast).

**Line-buffering complexity.** The consumer must implement `buf.split('\n')` + `lines.pop()` correctly. Getting this wrong (e.g., not keeping the trailing partial) produces sporadic JSON parse errors that are hard to reproduce because they depend on TCP chunk boundaries.

### What to explore next

- **SSE / EventSource in depth:** study how `data:`, `id:`, and `retry:` fields work; understand exactly when auto-reconnect fires and what `Last-Event-ID` lets you do; good for cases where reconnect is desirable.
- **Resumable streams with event IDs:** pattern for giving each event an ID so a reconnecting client can ask for events after the last ID it received; requires server-side event log.
- **ReadableStream backpressure:** study `controller.desiredSize`, the `pull` callback, and the WHATWG Streams spec; relevant when the producer is faster than the consumer and you need flow control.

---

## Tradeoffs

| Dimension | NDJSON over fetch-stream | EventSource / SSE | WebSocket | Await whole response |
|---|---|---|---|---|
| Reconnect on drop | None — application decides | Automatic (can re-fire run) | Application decides | N/A |
| Wire format | Plain JSON + newline | SSE framing (data:/id:/retry:) | Any binary or text | JSON |
| Browser API complexity | Medium (manual loop + buffer) | Low (addEventListener) | Medium (onmessage) | Low (await res.json()) |
| One-way vs bidirectional | One-way | One-way | Bidirectional | Request/response |
| Partial renders | Yes | Yes | Yes | No |
| Auth / custom headers | Full fetch API | Limited (GET, no custom headers) | Upgrade handshake | Full fetch API |

**What this approach gave up:**
- Auto-reconnect — there is no `retry:` field, no `Last-Event-ID`, no built-in recovery.
- Standard protocol framing — `EventSource` clients, SSE proxies, and monitoring tools won't understand `application/x-ndjson`.
- Manual line-buffering — you own `buf.split('\n')` and `lines.pop()`; bugs here produce silent parse errors.

**What the alternatives cost:**
- `EventSource` auto-reconnect re-fires the entire ~115s agent run. For a one-shot expensive computation, reconnect is a bug not a feature.
- WebSocket requires a bidirectional upgrade handshake and persistent connection management — overkill for a one-way server→client stream.
- `await res.json()` blocks for the full ~115s run and renders nothing until complete — the spinner-for-2-minutes problem from "Why care."

**The breakpoint:**
This approach is correct when the stream is one-way, short-lived (one investigation), and reconnect-on-drop must not re-trigger the computation. It needs replacement (SSE with `Last-Event-ID`, or a WebSocket with a resumption protocol) when streams must survive reconnects and partial-replay from cursor is required.

---

## Tech reference (industry pairing)

### Web Streams (ReadableStream + TextDecoder)

The WHATWG Streams standard defines `ReadableStream`, `WritableStream`, and `TransformStream`. Used here: `new ReadableStream({ start(controller) { ... } })` on the server (Node/Edge runtime) and `res.body.getReader()` + `reader.read()` in the browser.

- **ReadableStream / getReader:** Browser and Node API. `getReader()` locks the stream to one consumer. `read()` returns `{ done, value }` — `done: true` when the stream is closed.
- **TextDecoder:** Converts `Uint8Array` byte chunks to strings. The `{ stream: true }` option buffers incomplete multi-byte sequences across calls — required for correct UTF-8 decoding of chunked data.
- **controller.enqueue:** Pushes a chunk (here: `Uint8Array`) into the stream's internal queue. Downstream readers receive it via `read()`.
- **controller.close:** Signals end-of-stream. The next `read()` call returns `{ done: true }`.
- **Runner-up — EventSource:** The browser's built-in SSE API. Simpler to consume but carries auto-reconnect and SSE framing requirements. Good when reconnect is desirable and the server can emit `id:` fields.
- **Runner-up — WebSocket:** Full-duplex socket. Correct for bidirectional real-time communication (chat, collaborative editing). Overhead and complexity exceed what a one-way stream needs.

### NDJSON / JSON Lines

NDJSON (Newline Delimited JSON) is a convention: one valid JSON value per line, `\n` as line separator, no surrounding array brackets. Files use `.ndjson` or `.jsonl` extension. Used in log shipping (Logstash, Fluentd), ML training datasets, streaming ETL.

- **encodeEvent:** `JSON.stringify(e) + '\n'` — the complete encoding. No length prefix, no envelope.
- **decodeEvent:** `JSON.parse(line)` — the complete decoding. Safe only after line is extracted.
- **`Content-Type: application/x-ndjson`:** The MIME type used in this codebase (L77). `application/x-ndjson` is informal; `application/jsonl` and `application/x-jsonlines` are also used in the wild.
- **Line-buffering invariant:** You must never call `JSON.parse` on a partial line. The `buf.split('\n')` + `pop()` pattern maintains this invariant across chunk boundaries.
- **Runner-up — SSE:** `text/event-stream` with `data:` field wrapping JSON. More overhead but gives `id:` and `retry:` fields for free. Common in LLM streaming APIs (OpenAI, Anthropic).

### Next.js route handler streaming

Next.js App Router route handlers (files named `route.ts`) can return a `Response` with a `ReadableStream` body. The Edge and Node runtimes both support this.

- **`export const maxDuration = 60`** (L18): Vercel-specific export that sets the maximum function execution time in seconds. Does not extend beyond the platform limit.
- **`new Response(stream, { headers })`:** Standard `Response` constructor with a `ReadableStream` body. Next.js passes this through to the underlying runtime's HTTP layer.
- **`Cache-Control: no-cache, no-transform`** (L78): Tells CDN layers not to buffer the response before forwarding — essential for streaming. Without it, a proxy might wait for the full body before sending.
- **`Content-Type: application/x-ndjson; charset=utf-8`** (L77): Signals to the client that the body is NDJSON. Not strictly required for `fetch` (the consumer reads bytes regardless) but useful for debugging and for intermediaries.
- **Runner-up — `NextResponse.json`:** For non-streaming responses. Buffers the complete body before sending. Not usable here.

---

## Summary

`app/api/agent/route.ts` wraps an AI investigation pipeline in a `ReadableStream` producer that encodes each `AgentEvent` as a single NDJSON line (`JSON.stringify(e) + '\n'`) and enqueues it immediately as it is produced. `app/investigate/[id]/page.tsx` consumes that stream with `fetch` + `getReader()` + a `TextDecoder`, accumulates bytes into a string buffer, splits on `'\n'`, keeps the trailing partial for the next chunk, and dispatches each complete line to `handleEvent` which updates React state. A cache-hit path replays stored events with 180ms inter-event delay so the UI animates without a live run.

Key points:
- `AgentEvent` is a discriminated union (`lib/mcp/events.ts` L4–L12); the `type` field determines the shape; `switch(e.type)` in `handleEvent` is type-safe without narrowing boilerplate. `[checklist: 2. Request-response flow]`
- `fetch`-stream was chosen over `EventSource` specifically because `EventSource` auto-reconnects, which would re-fire the ~115s agent run. `[checklist: 5. Failure handling]`
- `buf.split('\n')` + `lines.pop()` is the canonical line-buffering pattern for NDJSON over streaming `fetch`; getting this wrong causes silent parse errors that depend on TCP chunk boundaries.
- `{ stream: true }` on `TextDecoder.decode` is required for correct UTF-8 across chunk boundaries.
- The `startedRef` guard prevents React StrictMode's double-invocation from firing two agent runs in development.
- The cache replay path (`REPLAY_DELAY_MS = 180`, `route.ts` L50, L64–81) uses the same wire format and same consumer loop as a live run — the consumer cannot distinguish them.

---

## Interview defense

### What they are really asking

When an interviewer asks about streaming in this codebase they want to know: do you understand why `fetch`-stream was used instead of `EventSource`? Can you explain the line-buffering mechanic? Do you know what goes wrong if a chunk boundary falls mid-JSON? Can you trace the full path from server event to DOM update?

---

### [mid] "Walk me through how the browser reads the NDJSON stream."

`res.body.getReader()` locks the stream to one reader. Each `reader.read()` call resolves when the next chunk of bytes arrives — or with `done: true` when the server closes the stream. The bytes are decoded to a string with `TextDecoder` (with `{ stream: true }` to handle multi-byte chars at boundaries), appended to a buffer, split on `'\n'`, and the trailing incomplete fragment is popped off and held for the next chunk. Every complete line is `JSON.parse`d and dispatched to `handleEvent`. This is the loop at `app/investigate/[id]/page.tsx` L146–L160.

```
┌───────────────────────────────────────────────────────────────┐
│  reader.read() → Uint8Array                                   │
│       │                                                       │
│       └─ decode → string → append to buf                     │
│                                                               │
│  buf.split('\n') → [ line1, line2, ..., partial ]            │
│  buf = partial                                                │
│                                                               │
│  for line1, line2, ...: JSON.parse → handleEvent → setState  │
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

### [arch] "The maxDuration is 60 seconds but the live run takes ~115 seconds. What breaks and what doesn't?"

The serverless function is killed at 60s. The stream closes without emitting `done`. The consumer's `reader.read()` will return `{ done: true }` (clean close from the platform) or reject (connection reset). Either way `complete` stays `false`. The UI shows "analyzing…" and never transitions to "complete." The diagnosis may or may not have been emitted before the cutoff, depending on when in the run the function was killed.

The cache replay path is unaffected — it replays a stored sequence in `events.length × 180ms` total time, well under 60s for any realistic investigation.

The fix is to increase `maxDuration` on a paid Vercel plan (up to 300s) or to move the agent run to a background queue (e.g., a Vercel Cron + database polling) and have the consumer poll for the cached result rather than stream from the live run.

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
- `app/api/agent/route.ts` L50 — `REPLAY_DELAY_MS = 180`
- `app/api/agent/route.ts` L105–L169 — the `ReadableStream` producer (live run)
- `app/investigate/[id]/page.tsx` L143–L168 — the `fetch` consumer loop
- `app/investigate/[id]/page.tsx` L42–L48 — StrictMode `startedRef` guard

---

## Validate your understanding

### Level 1 — Reconstruct

Without looking at the code, write the producer side: a Next.js route handler that creates a `ReadableStream`, encodes events as NDJSON lines, and returns them with `Content-Type: application/x-ndjson`. Then write the consumer side: a `useEffect` that reads the stream, buffers chunks, splits on newline, and calls a handler per line. Compare to `route.ts` L104–L177 and `page.tsx` L125–L172.

### Level 2 — Explain

Open `app/investigate/[id]/page.tsx`. At L149, `dec.decode(value, { stream: true })` is called. What does the `{ stream: true }` option do? What would go wrong if you omitted it and the server sent a string containing a multi-byte UTF-8 character (e.g., "—") that was split across two TCP chunks? Then explain why L151 (`buf = lines.pop() ?? ''`) is the critical line in the consumer loop. What invariant does it maintain?

### Level 3 — Apply

**Scenario:** A user reports that the trace shows 3 tool calls but the diagnosis panel never renders. The stream eventually closes. Where in the consumer loop do you look?

Start at `handleEvent` in `page.tsx` L60–L123. Check the `case 'diagnosis':` branch (L108–L110) — it sets `diagnosis` state. If `diagnosis` is never set, either: (a) the `diagnosis` event was never emitted by the producer (check `route.ts` L154), (b) the line containing the `diagnosis` event was malformed and fell into the `catch` block at L156–L158 (silently ignored), or (c) the line containing the `diagnosis` event was split across two chunks and the partial was lost.

For case (c) — a line split across two chunks: the `buf.split('\n')` + `lines.pop()` pattern handles this correctly. `buf` accumulates the partial line until the next chunk completes it. If `{ stream: true }` was missing from `TextDecoder` (L149), a multi-byte character in the diagnosis JSON could produce the replacement character `�`, making `JSON.parse` throw and landing in the silent catch at L156–L158. Check `lib/mcp/events.ts` L4–L12 for the `diagnosis` event shape — the `diagnosis` field must be present or the switch falls through to `default` (L120–L122) silently.

### Level 4 — Defend

An interviewer asks: "you're manually line-buffering in the browser — isn't that fragile? `EventSource` handles all that for you." Defend the choice. Name one specific failure mode EventSource would cause in this app and one specific failure mode the manual buffer approach could have if implemented incorrectly.

### Quick check

- What is the exact return value of `encodeEvent({ type: 'done' })`?
- What does `lines.pop()` return when `buf` ends with `\n` (i.e., the last event is complete)?
- What is `REPLAY_DELAY_MS` and where is it defined?
- Why does the `startedRef` guard exist in development but matter less in production?
- What HTTP header signals to CDN proxies that this response should not be buffered?

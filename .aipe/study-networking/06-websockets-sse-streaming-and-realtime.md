# WebSockets, SSE, streaming, and realtime

**Long-lived connections and server-push patterns** · The choice this codebase made, and why

## Zoom out — where this concept lives

The wire #1 story. Browser to `/api/briefing` and `/api/agent`. The realtime transport that carries the agent's reasoning trace live to the UI.

```
  Zoom out — the realtime layer of wire #1

  ┌─ UI band ──────────────────────────────────────────┐
  │  React useBriefingStream · useInvestigation        │
  │  useDemoCapture · StreamingResponse                │
  │     ★ all four ride the same NDJSON kernel ★       │ ← we are here
  │     (lib/streaming/ndjson.ts:17 readNdjson)        │
  └────────────────────┬───────────────────────────────┘
                       │
                       │  GET /api/briefing
                       │  Content-Type: application/x-ndjson
                       │  Transfer-Encoding: chunked
                       ▼
  ┌─ Service band ─────────────────────────────────────┐
  │  app/api/briefing/route.ts   app/api/agent/route.ts│
  │  encodes events as one JSON object per line, '\n'  │
  └────────────────────────────────────────────────────┘
```

## Zoom in — the concept

**NDJSON over HTTP chunked transfer encoding.** Not WebSockets. Not SSE. The route writes `JSON.stringify(event) + '\n'` to a `ReadableStream`; the client splits on `\n`, calls `JSON.parse` on each line, and dispatches the event. One kernel for the parse loop; four consumers ride it.

The other two realtime transports (WebSockets, SSE) are roads not taken. This file walks both — because the partition rule says: teach the alternative the codebase rejected, so a reader knows when *they* would reach for it.

## Structure pass

### Layers

- **Wire format** — how bytes are framed: one JSON object per `\n`-terminated line.
- **HTTP transport** — what carries the bytes: `Transfer-Encoding: chunked` under HTTP/1.1, or `DATA` frames under HTTP/2.
- **Application semantics** — what the JSON objects mean: `AgentEvent` discriminated union (`reasoning_step`, `tool_call_start`, …).

### One axis held constant — `which side decides when to send?`

```
  axis = "who initiates each message?"

  ┌─ classic GET → JSON ─────┐  server replies once
  │                           │  → request/response, no push
  └───────────────────────────┘

  ┌─ NDJSON over chunked ────┐  server pushes many times
  │  (this app)               │  → one request, N events streamed back
  │                           │    over time before the connection closes
  └───────────────────────────┘

  ┌─ SSE (EventSource) ──────┐  same as NDJSON, but:
  │                           │  → built-in reconnect with Last-Event-ID
  │                           │  → GET only, text only
  │                           │  → no AbortSignal hook from EventSource
  └───────────────────────────┘

  ┌─ WebSocket ──────────────┐  EITHER side can send at any time
  │                           │  → full bidirectional after upgrade
  │                           │  → frame-based, binary or text
  └───────────────────────────┘
```

Our axis answer: server pushes many times, client never pushes mid-stream. That rules out WebSocket's bidirectional benefit. The choice between NDJSON and SSE is more subtle and lives in Move 2.

### Seams

- **`ReadableStream` ↔ chunked HTTP** — Next.js wraps the stream as HTTP/1.1 chunks (or H2 DATA). The boundary is invisible to our code; the stream interface is what we work with.
- **`fetch` ↔ NDJSON kernel** — the `res.body` byte stream feeds `readNdjson`, which does the line splitting and JSON parsing.
- **`AbortSignal` ↔ both sides** — the same signal that cancels the fetch (client) cancels the in-flight tool calls (server), via the chain in `app/api/briefing/route.ts:215-279`.

## How it works

### Move 1 — the mental model

You know how a normal `fetch` returns one response body? The browser reads it all and you get a Promise. NDJSON-over-fetch is the same `fetch`, except instead of reading the body to completion, you read it as a stream — one chunk at a time, splitting on newline, JSON-parsing each line, dispatching as it arrives.

```
  the pattern — one stream, many events

  Server                            Client (readNdjson)
     │   Response.start              │
     │ ────────────────────────────► │
     │                                │
     │   chunk: '{"type":"a"}\n      │
     │           {"type":"b"}\n      │
     │           {"type":'           │   buffer = '{"type":'
     │ ────────────────────────────► │   lines = ['', '{"type":"a"}', '{"type":"b"}']
     │                                │   onEvent(a); onEvent(b)
     │   chunk: '"c"}\n              │
     │           {"type"'            │   buffer = '{"type"'
     │ ────────────────────────────► │   lines = ['', '"c"}']
     │                                │   onEvent(c)
     │                                │
     │   …                            │
     │                                │
     │   chunk: ':"done"}\n          │   onEvent(done)
     │ ────────────────────────────► │
     │   Response.end                 │
     │ ────────────────────────────► │   while-loop exits
```

The key insight: chunk boundaries from the network don't align with line boundaries in the data. A single chunk might end mid-line. So the parser keeps a buffer, splits on `\n`, processes complete lines, and saves the trailing partial for the next chunk.

### Move 2 — the load-bearing skeleton

This pattern has a kernel. Strip these parts and it stops being NDJSON streaming:

```
  the irreducible parts (drop one and it breaks)

  1. reader = body.getReader()      ← the byte stream
  2. decoder = new TextDecoder()    ← bytes → UTF-8 string
  3. buf = ''                       ← THE BUFFER. drop this and a line
                                       split across chunks corrupts.
  4. while (true) { read }          ← the chunked pull loop
  5. buf += decoder.decode(...)
  6. lines = buf.split('\n')        ← THE FRAMING. drop this and you can't
  7. buf = lines.pop()              ←   tell where one event ends.
                                       saving the trailing element as the
                                       next-iteration buffer is the load-
                                       bearing part everyone forgets.
  8. for line: JSON.parse(line)     ← the per-event handler
```

**The load-bearing part everyone forgets:** `buf = lines.pop()`. After `split('\n')`, the last element is whatever came after the final newline — which is the start of an incomplete next event. If you don't save it back to `buf`, you'll either (a) try to `JSON.parse` an incomplete object and drop it, or (b) lose the prefix when the next chunk arrives. `split` + `pop` is the framing.

The real code:

```ts
// lib/streaming/ndjson.ts:31-50
const reader = body.getReader();
const decoder = new TextDecoder();
let buf = '';
try {
  while (true) {
    if (opts?.cancelOn?.()) {
      await reader.cancel();
      return;
    }
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';     // ← THE LOAD-BEARING LINE
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      try {
        onEvent(JSON.parse(line) as E);
      } catch (err) {
        opts?.onMalformed?.(line, err);
      }
    }
  }
  // flush trailing buffer — a no-op when the producer always terminates with '\n'
  const tail = buf.trim();
  if (tail) {
    try { onEvent(JSON.parse(tail) as E); }
    catch (err) { opts?.onMalformed?.(tail, err); }
  }
} finally {
  reader.releaseLock();
}
```

Three things worth pausing on:

- **`decoder.decode(value, { stream: true })`** — the `stream: true` option tells the decoder to keep partial UTF-8 sequences at the chunk boundary. Drop it and a multi-byte character split across chunks corrupts. Not load-bearing for ASCII JSON, load-bearing for any non-ASCII content (Bloomreach project names, error messages, EQL strings with unicode).
- **`opts?.cancelOn?.()`** — polled before every read. Lets the consumer flip a flag and bail without waiting for the next event. This is how `useBriefingStream` cleans up on unmount (`useBriefingStream.ts:288, 297-299`).
- **silent-skip on `JSON.parse` throw** — a malformed line doesn't break the stream. By default it's silently dropped (`onMalformed` is optional).

### Move 2 — the producer side

The route encodes one event per chunk. Each chunk is exactly `JSON.stringify(event) + '\n'`. The shared helper:

```ts
// lib/mcp/events.ts:15-17
export function encodeEvent(e: AgentEvent): string {
  return JSON.stringify(e) + '\n';
}
```

Used by the agent route:

```ts
// app/api/agent/route.ts:187-190
const send = (e: AgentEvent) => {
  collected.push(e);
  controller.enqueue(encoder.encode(encodeEvent(e)));
};
```

The briefing route inlines the same shape:

```ts
// app/api/briefing/route.ts:193-194
const send = (e: BriefingEvent) =>
  controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
```

The `controller.enqueue` puts one `Uint8Array` on the underlying `ReadableStream`. Next.js's response layer pulls from that stream and writes HTTP chunks. The 16-event AgentEvent contract (`reasoning_step`, `tool_call_start`, `tool_call_end`, `insight`, `diagnosis`, `recommendation`, `done`, `error`) is the *meaning* layer above the wire format.

### Move 2 — the four consumers, one kernel

```
  Pattern — one kernel, four consumers

                       ┌─────────────────────────────┐
                       │  readNdjson<E>(body, onEvent│
                       │     lib/streaming/          │
                       │       ndjson.ts:17          │
                       └──┬──────────┬──────────┬────┘
                          │          │          │   │
              ┌───────────┘          │          │   └───────────────┐
              │                      │          │                   │
              ▼                      ▼          ▼                   ▼
  ┌──────────────────┐  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
  │ useBriefingStream│  │  useInvestigation│ │  useDemoCapture  │ │StreamingResponse │
  │  feed: insights, │  │  step 2: diag    │ │  dev one-click   │ │  chat: answer +  │
  │  coverage, trace │  │  step 3: rec     │ │  capture-as-demo │ │  reasoning trace │
  └──────────────────┘  └──────────────────┘ └──────────────────┘ └──────────────────┘
```

Each consumer narrows the generic `E` to its own event union (`BriefingEvent`, `AgentEvent`). The kernel doesn't care; it just parses lines.

### Move 2.5 — why NOT SSE, why NOT WebSocket

The most useful part of this file for an interview. Both alternatives are real; both were rejected for specific reasons.

```
  Comparison — NDJSON vs SSE vs WebSocket

  ─────────────────┬─────────────────────────┬─────────────────────────────
                   │ NDJSON over chunked HTTP│ SSE              │ WebSocket
                   │ (this app)               │ (EventSource)    │
  ─────────────────┼─────────────────────────┼──────────────────┼─────────
  transport         │ HTTP/1.1 chunked or H2  │ HTTP/1.1 chunked │ WS over TCP
                   │ DATA, plain GET/POST    │ GET only         │ after HTTP upgrade
  ─────────────────┼─────────────────────────┼──────────────────┼─────────
  body              │ any (we use UTF-8 JSON) │ text/event-stream│ binary or text
                   │                         │ text only         │ frames
  ─────────────────┼─────────────────────────┼──────────────────┼─────────
  reconnect         │ none built-in           │ auto + Last-     │ manual
                   │ → on close, fetch again │   Event-ID hint  │
  ─────────────────┼─────────────────────────┼──────────────────┼─────────
  AbortSignal       │ yes — fetch carries it │ no — must call   │ no — must call
  integration       │ end-to-end              │ EventSource.close│ ws.close()
                   │                         │ (no fetch hook)  │
  ─────────────────┼─────────────────────────┼──────────────────┼─────────
  direction         │ server → client only   │ server → client  │ bidirectional
                   │                         │ only             │
  ─────────────────┼─────────────────────────┼──────────────────┼─────────
  POST + body       │ yes (we use GET, but   │ NO — GET only    │ yes
                   │  we could carry a body) │                  │
  ─────────────────┼─────────────────────────┼──────────────────┼─────────
  serverless        │ works on any HTTP      │ works on any HTTP│ tricky —
  fit               │ runtime that returns   │ runtime          │ many serverless
                   │ a ReadableStream        │                  │ runtimes won't
                   │                         │                  │ upgrade
```

**Why not SSE.** Three reasons, ranked:

1. **`AbortSignal` integration is broken on `EventSource`.** Our route's whole cancellation story (`req.signal` threaded through `bootstrap`, `listTools`, `agent.scan`) depends on the *client's* fetch dying when the user closes the tab — that's how the upstream MCP and Anthropic calls get cancelled too. `EventSource` doesn't expose its underlying fetch; calling `.close()` on it doesn't propagate to in-flight server-side work in the same way. With `fetch + AbortController`, the chain is direct.
2. **SSE is GET-only and text-only.** We currently happen to use GET, but if we wanted to POST a longer query body (we don't, but consider a future shape), SSE would lose. The agent route's `?q=` works in a URL today because queries are short; if they grew to multi-KB JSON, we'd need POST + body. NDJSON over fetch already supports that.
3. **The built-in reconnect protocol (`Last-Event-ID`) is dead weight for us.** Our event stream is not idempotent — replaying from event N+1 would require the server to maintain per-client state about where each client left off. The agent runs are one-shot; on disconnect, the right behavior is to either replay the cached snapshot (demo) or kick a fresh run (the reconnect button in the error UI). SSE's reconnect machinery doesn't help with either.

**Why not WebSocket.** Two reasons:

1. **The traffic is one-directional.** Server → client only, post-request. There's no scenario in this app where the client needs to push mid-stream. WebSocket's bidirectional power is unused; we'd pay the upgrade-handshake complexity for no gain.
2. **Serverless runtimes are unreliable for WebSocket.** Vercel functions don't support persistent WebSocket connections in the standard runtime (you'd need Vercel's edge functions with specific configuration, or move off Vercel entirely). The chunked HTTP path "just works" on every serverless platform that supports `ReadableStream` responses, which is universal.

**The NDJSON verdict.** The smallest primitive that does what we need. Plain HTTP body, plain JSON, plain newlines. The kernel is 45 lines (`lib/streaming/ndjson.ts:17-64`). The producer side is one helper (`encodeEvent`). The four consumers reuse the same code path with different event types. Reading the code, you understand the wire format in under a minute.

### Move 3 — the principle

**For server-push to a browser, the smallest primitive that works is usually the right one.** WebSocket gives you bidirectional and binary; you don't always need either. SSE gives you reconnect and event framing; you don't always need either. NDJSON over fetch gives you JSON-per-line and inherits the entire `AbortSignal` story for free, which the others don't. When the application needs bidirectional or reconnect-recovery, escalate. Until then, the boring choice is the right one.

## Primary diagram

```
  the recap — wire #1 end-to-end

  ┌─ Service (Next.js route) ──────────────────────────────┐
  │                                                         │
  │  events: AgentEvent (16-case discriminated union)       │
  │     ├─ reasoning_step                                   │
  │     ├─ tool_call_start                                  │
  │     ├─ tool_call_end                                    │
  │     ├─ insight / diagnosis / recommendation             │
  │     ├─ done                                             │
  │     └─ error                                            │
  │                                                         │
  │  encode: JSON.stringify(event) + '\n'                   │
  │     → lib/mcp/events.ts:15-17 (encodeEvent)             │
  │                                                         │
  │  controller.enqueue(encoder.encode(...))                │
  │     → ReadableStream → Next.js Response                 │
  │                                                         │
  │  headers:                                               │
  │    content-type: application/x-ndjson; charset=utf-8    │
  │    cache-control: no-store, no-transform                │
  │                                                         │
  └─────────────────────────┬───────────────────────────────┘
                            │
                            │  HTTP/1.1 chunked
                            │  Transfer-Encoding: chunked
                            │  (or HTTP/2 DATA frames)
                            ▼
  ┌─ Browser (React hook) ─────────────────────────────────┐
  │                                                         │
  │  fetch(url, { signal })                                 │
  │     → res.body : ReadableStream<Uint8Array>             │
  │                                                         │
  │  readNdjson(body, onEvent, { cancelOn })                │
  │     → lib/streaming/ndjson.ts:17-64                     │
  │                                                         │
  │  loop:                                                  │
  │    1. read chunk                                        │
  │    2. decode UTF-8 (with stream: true)                  │
  │    3. buf += text                                       │
  │    4. lines = buf.split('\n')                           │
  │    5. buf = lines.pop()    ← THE FRAMING                │
  │    6. for line: JSON.parse → onEvent                    │
  │    7. poll cancelOn() between reads                     │
  │                                                         │
  │  4 consumers ride this kernel:                          │
  │    useBriefingStream · useInvestigation                 │
  │    useDemoCapture · StreamingResponse                   │
  │                                                         │
  └─────────────────────────────────────────────────────────┘
```

## Elaborate

The NDJSON-vs-SSE debate isn't new. Slack, Linear, Anthropic's own console all use NDJSON-style streams for similar reasons: better `fetch` integration, no need for SSE's reconnect protocol when the application has its own recovery story, and the freedom to POST a body when the request payload grows. SSE survives in places where reconnect-with-Last-Event-ID actually carries weight — push notification feeds, server-state subscriptions that need at-least-once delivery — but for "stream an LLM's reasoning trace in real time," NDJSON has become the de facto choice.

The reconnect story in this app lives entirely outside the wire format. The reconnect policy (`useReconnectPolicy`, `lib/hooks/useReconnectPolicy.ts`) detects auth-shaped errors and fires a reset+reload — not a stream-resume. The demo path replays a committed snapshot deterministically. Neither uses `Last-Event-ID`. SSE's reconnect would be unused.

One real gap in the NDJSON kernel: no heartbeat. If Bloomreach's rate-limit retry ladder costs 30+ seconds with no events fired to the client, intermediate proxies could close the idle connection. The briefing route currently emits status updates often enough (per coverage tile, per tool call) that this hasn't bitten in practice. A `{type:"heartbeat"}` event every 10s would close the exposure — a one-line addition that we haven't needed yet.

## Interview defense

**Q: Walk me through the NDJSON kernel.**

> 45 lines, lives at `lib/streaming/ndjson.ts:17-64`. Six load-bearing parts: get a reader from `res.body`, create a `TextDecoder`, hold a buffer string. Loop: read a chunk, decode UTF-8 with `stream: true` so partial sequences carry over, append to buf, split on `\n`, pop the last element back into buf — that's the framing — for each complete line `JSON.parse` it and call `onEvent`. The load-bearing part everyone forgets is `buf = lines.pop()`. After split, the last element is the start of the next event; if you don't save it, you either drop incomplete objects or lose the prefix on the next chunk.

```
  on the whiteboard:

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';            ← THIS LINE is the framing
    for (const line of lines) onEvent(JSON.parse(line));
  }
```

Anchor: split + pop is the entire NDJSON framing.

**Q: Why NDJSON and not SSE?**

> Three reasons. One, `AbortSignal` integration — `fetch` carries the signal end-to-end into the route handler, where we use it to cancel upstream tool calls. `EventSource` has no `signal` hook; calling `.close()` on it doesn't propagate the same way. Two, NDJSON works with POST and any binary; SSE is GET-only and text-only. Three, SSE's reconnect-with-Last-Event-ID protocol is dead weight for us — our streams aren't replayable from a partial offset, our reconnect story is reset-and-reload via `useReconnectPolicy`. We'd pay SSE's framing complexity for features we don't use.

```
  on the whiteboard:

  NDJSON      |  SSE
  ─────────── |  ───────────
  fetch+signal|  EventSource no signal
  any method  |  GET only
  any body    |  text only
  manual      |  Last-Event-ID built-in
  reconnect   |    (we don't use it)
```

Anchor: NDJSON wins on AbortSignal alone.

**Q: Why not WebSocket?**

> The traffic is one-directional. Server pushes events; the client never pushes mid-stream. WebSocket's bidirectional capability would be unused, and we'd pay the upgrade-handshake complexity and the serverless-platform fragility for nothing. Vercel functions in the standard runtime don't even reliably support persistent WebSockets. Chunked HTTP works on every platform that supports `ReadableStream` responses, which is universal.

Anchor: WebSocket's superpower (bidirectional) is one we don't need.

**Q: What happens if the user closes the tab mid-stream?**

> The browser closes its socket to `/api/briefing`. The route's `req.signal` flips to aborted. That signal was threaded into every async layer below — `bootstrap(req.signal)`, `dataSource.listTools({ signal })`, `agent.scan({ signal })`. Each of those passes it to the MCP transport, which composes it with the per-call 30s timeout. When the signal fires, undici closes the upstream socket to Bloomreach. The in-flight tool call rejects with `AbortError`. The route's catch block sees `DOMException AbortError` and bails silently — no error event is emitted because there's no consumer to read it.

```
  on the whiteboard:

  close tab → browser FIN → req.signal.aborted
              → composeSignals fires inside transport.ts:131
              → undici closes Bloomreach socket
              → tool-call promise rejects with AbortError
              → if (e instanceof DOMException && e.name === 'AbortError') return;
```

Anchor: the entire cancellation story rides on `AbortSignal` plus `composeSignals`.

## See also

- `01-network-map.md` — wire #1 on the larger map
- `03-tcp-udp-connections-and-sockets.md` — the long-lived TCP profile this transport produces
- `05-http-semantics-caching-and-cors.md` — the HTTP envelope NDJSON rides inside
- `07-timeouts-retries-pooling-and-backpressure.md` — the AbortSignal composition in detail

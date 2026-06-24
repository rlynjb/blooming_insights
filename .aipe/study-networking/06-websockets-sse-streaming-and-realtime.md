# WebSockets, SSE, streaming, and realtime

**Industry name(s):** WebSocket (RFC 6455), Server-Sent Events (HTML5 EventSource), chunked HTTP streaming, NDJSON / JSON Lines
**Type:** Industry standard · Language-agnostic

> One realtime transport in this app: NDJSON over chunked HTTP, read on the client via `fetch` + `response.body.getReader()`. No WebSocket, no SSE, no gRPC streaming, no WebTransport — and naming *why* (auto-reconnect would re-bill a 115s LLM run) is more important than naming what isn't there.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** When the page needs "the agent is reasoning *right now*," there's exactly one mechanism: the server returns an HTTP response whose body is a `ReadableStream`, and the browser reads it incrementally. The wire format is NDJSON — one JSON object per line. No upgraded connection, no separate transport, no second port. The whole "realtime" picture is *one HTTP request whose body happens to take 60–115 seconds to finish writing*.

```
Zoom out — the only realtime path

┌─ Browser ──────────────────────────────────────────────────────────┐
│  fetch('/api/agent?…')                                              │
│  response.body.getReader()  ← incremental read loop                 │
│  buf.split('\n'); buf = lines.pop()  ← line reassembly              │
│  JSON.parse(line); setState(event)   ← per event, per render        │
└────────────────────────┬───────────────────────────────────────────┘
                         │
                         │  HTTP chunked transfer over HTTPS
                         │  Content-Type: application/x-ndjson
                         │  Cache-Control: no-cache, no-transform
                         │  Transfer-Encoding: chunked (HTTP/1.1) OR
                         │  HTTP/2 DATA frames (negotiated by edge)
                         │
┌─ Serverless function ──▼───────────────────────────────────────────┐
│  Response = new ReadableStream({                                    │
│    start(controller) {                                              │
│      send(event) → controller.enqueue(JSON.stringify(event) + '\n')│
│    }                                                                │
│  })                                                                 │
│  maxDuration = 300 (Vercel Pro hard ceiling)                        │
└────────────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this file answers: *why this transport*, and what would change if we picked one of the alternatives? The detail of how the line buffering works lives in `../study-system-design/05-streaming-ndjson.md` (and the DSA companion). Here we name the choice, the alternatives, and the cost of switching.

---

## Structure pass

**Layers.** Three layers of realtime in play. **Wire** (HTTP chunked transfer — TCP packets with HTTP framing on top). **Encoding** (NDJSON — `JSON.stringify(event) + '\n'` per line). **Application contract** (the `AgentEvent` / `BriefingEvent` discriminated union — the client `switch`es on `type` and `setState`s).

**Axis: control.** Trace "who initiates the next message?" The producer (server) always pushes; the consumer (client) pulls bytes off the socket but never sends a follow-up message. The connection is half-duplex from the application's perspective — the client opened it with the request, then it's read-only. This is the key contrast with WebSocket (full-duplex, either side can push) and the key alignment with SSE (server push only).

**Seams.** Three seams matter; one is the choice of transport itself.

  → **Seam 1 (THE choice): chunked HTTP + NDJSON vs SSE vs WebSocket.** What flips: auto-reconnect, full-duplex, framing. We chose chunked HTTP + NDJSON; the rest of this file is the case for that choice.
  → **Seam 2 (covered in `05-http-semantics-…`): `no-transform` directive.** Without it, the edge can buffer chunks and the realtime guarantee dies.
  → **Seam 3 (covered in `../study-system-design/…/05-streaming-ndjson.md`): line reassembly across TCP chunks.** Without `buf = lines.pop()`, a line split across two TCP packets corrupts two parses.

```
The three realtime transports compared

  transport          framing          duplex    auto-reconnect    used here?
  ─────────          ───────          ──────    ──────────────    ──────────
  Chunked HTTP +     newline          half      no                ✓ YES
   NDJSON                              (server→client)
  SSE                "data:"/blank    half      YES               no
                      lines           (server→client)
  WebSocket          binary frames    full      manual            no
  gRPC streaming     protobuf         varies    manual            no
```

The skeleton is mapped — what follows is the case for each "no."

---

## How it works

### Mental model

A streaming HTTP response is a regular HTTP response that takes a long time to finish writing the body. The server flushes bytes whenever it has new events; the browser's `fetch` API surfaces those bytes incrementally via `response.body.getReader()`. NDJSON makes the framing trivial: one JSON object per line. That's the whole transport.

```
The shape — push without negotiating a new protocol

  client                                       server
  ──────                                        ──────
  fetch('/api/agent?…')   ─────────────────►   open Response
                                                start the producer
        ◄── chunk(line1\nline2\n) ─────────    enqueue 2 events
        ◄── chunk(line3\n) ────────────────    enqueue 1 event
        ◄── (idle 5s while LLM runs)             busy upstream
        ◄── chunk(line4\nline5\n) ─────────    enqueue 2 events
        ◄── chunk(done\n) ─────────────────    enqueue final
                                                controller.close()
```

The browser's reader doesn't care about line boundaries; it gets `Uint8Array` chunks of arbitrary length. The line-buffering loop (`buf += decode(chunk); split('\n'); pop()`) reassembles complete lines.

### Move 2 walkthrough

**Why not SSE? Auto-reconnect would re-bill a 115 s LLM run.** SSE's `EventSource` API is *built* to auto-reconnect on disconnect, replaying from a `Last-Event-ID`. That's beautiful for a chat feed (re-pull missed messages). It's a disaster for an agent: a transient network blip mid-investigation triggers `EventSource` to open a new connection, our server has no idea the previous one was a "continuation," it runs the *whole* diagnostic agent again — re-billing Anthropic, re-burning Bloomreach rate-limit budget, doubling the cost. We get the same streaming shape from chunked HTTP without that footgun.

```
Why SSE auto-reconnect is wrong here

  with SSE:                                  with NDJSON over fetch:
  ─────────                                  ───────────────────────
  EventSource opens, agent runs               fetch opens, agent runs
  socket drops at 60s mark                    socket drops at 60s mark
  ★ EventSource auto-reconnects ★             reader.read() returns done
  server has no Last-Event-ID handler         OR throws on the body
  server runs the WHOLE agent again           client sees stream end
  Anthropic + Bloomreach: re-billed           user clicks retry → fresh call
  Wall time: 2× original                      Wall time: same as original
  Cost: 2× original                           Cost: 1× (explicit user retry)
```

The cost of *NOT* having auto-reconnect: a transient drop kills the session and the user has to click again. We accept that trade because the agent is expensive to run.

**Why not WebSocket? No back-channel needed, and the platform doesn't trivially support it.** WebSocket gives full-duplex — the client can push back to the server on the same socket. Our consumer never has anything to say back; the agent's reasoning is purely server-push. Adding WebSocket would mean a separate WS server (Vercel's serverless functions don't host long-lived WebSocket connections natively — they need a separate runtime like Edge Functions or an external service), separate framing (binary or text frames vs HTTP chunked), separate auth (the cookies-on-connect dance is more awkward in WS). Three sources of complexity for zero gain.

```
Why WebSocket is wrong here

  WebSocket needs:                             we have:
  ────────────────                              ────────
  full-duplex back-channel                     server-push only
  separate WS server runtime                   one Next.js function
  ws://… or wss://… URL                        same-origin /api/agent
  manual reconnect logic                       fetch + reader handles "done"
  binary/text frame parser                     plain UTF-8 + newline
```

**Why not gRPC streaming? Wrong tool for a browser-first app.** gRPC streaming gives you server-streaming, client-streaming, or bidirectional over HTTP/2. Two problems for this app: (1) gRPC's binary protobuf wire format is invisible to anyone debugging in DevTools (NDJSON shows up as plain text you can read), and (2) gRPC-Web (the browser-compatible variant) requires a server proxy and adds framing complexity. For a one-direction server-push of JSON-shaped events, chunked HTTP + NDJSON is the small tool.

**The producer side — `ReadableStream` + `controller.enqueue`.** Inside the route, we build a `ReadableStream` whose `start(controller)` is async. We hand the controller to the agent (via `send(event)` closure); every time the agent emits an event, we encode it as `JSON.stringify(event) + '\n'`, convert to `Uint8Array` via `TextEncoder`, and call `controller.enqueue`. The runtime flushes the chunk to the underlying HTTP body buffer. The browser sees a new chunk arrive.

```
Pseudocode — producer side

  function GET(req):
    encoder = new TextEncoder()
    stream = new ReadableStream:
      start(controller):
        send(event) = controller.enqueue(encoder.encode(json(event) + '\n'))
        try:
          for each agent event:
            send(event)                     // ← one line, one flush
        catch e:
          send({type:'error', message:e.message})
        finally:
          controller.close()                // ← required to release socket
    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
      }
    })
```

**The consumer side — `getReader()` + line-buffered loop.** The client `fetch`es the URL, checks the status (handle 401/500 first), grabs `res.body.getReader()`, and loops: `await reader.read()` returns `{done, value}`; `value` is a `Uint8Array` chunk; `TextDecoder({stream:true}).decode(value)` turns it into a partial string; `buf.split('\n')` slices into complete lines; `buf = lines.pop()` saves the trailing partial; each complete line is `JSON.parse`'d and handed to the event switch.

```
Pseudocode — consumer side

  reader = res.body.getReader()
  decoder = new TextDecoder()
  buf = ''
  loop:
    {done, value} = await reader.read()
    if done: break
    buf += decoder.decode(value, {stream:true})
                                  │
                                  └─ stream:true keeps partial UTF-8 bytes
                                     buffered across reads (a multi-byte char
                                     split across two chunks doesn't corrupt)
    lines = buf.split('\n')
    buf = lines.pop()           // ← either '' (clean break) or partial line
    for line in lines:
      if line is empty: continue
      try:
        event = JSON.parse(line)
        handle(event)            // switch (event.type) → setState
      catch:
        skip                    // malformed line, log-and-skip
```

The boundary that catches people: `lines.pop()` is load-bearing. Drop it (or use `lines.slice(0,-1)` without re-stashing the trailing partial in `buf`) and the partial line becomes the start of the next read's parse — which corrupts two events instead of one.

**What about the cache-replay path?** The same NDJSON shape is used by the demo replay (`?demo=cached`) — the route reads a JSON snapshot from disk and re-emits the same events into a `ReadableStream` with `REPLAY_DELAY_MS` between them. The consumer code is unchanged: same reader, same handler. The wire format being identical between live and replay is what makes "demo mode" useful — the UI sees no difference.

### Move 2.5 — current vs future state (when applicable)

NDJSON over chunked HTTP is fully shipped; SSE / WebSocket / gRPC-streaming are `not yet exercised` and there is no migration in motion. If we ever needed *server-initiated push outside a request context* (e.g. "tell the user when a new anomaly fires, without them asking"), the right next step is SSE — not WebSocket — because the data flow is still server-push only, and SSE's auto-reconnect is now an asset (no expensive backend recomputation, just re-fetch the latest events).

```
Hypothetical evolution — when SSE/WS would be the right call

  trigger                          right next step
  ───────                           ───────────────
  push without request context     SSE (server-initiated, browser-pulled)
  bidirectional collab (multi-user)WebSocket (full-duplex)
  binary payloads at high freq     WebSocket binary frames or WebTransport
  large structured snapshots       chunked HTTP + NDJSON ★ (we are here)
```

### Principle

Pick the smallest transport that carries your event shape. Streaming JSON over a regular HTTP request gives you 90% of what SSE/WebSocket give you, with 10% of the complexity (no server runtime, no auto-reconnect logic, no separate auth dance). Reach for SSE only when auto-reconnect is what you actually want; reach for WebSocket only when you have a real back-channel.

---

## Primary diagram

The recap — the realtime transport, end to end.

```
Realtime over NDJSON — full recap

UI band ──────────────────────────────────────────────────────────
┌────────────────────────────────────────────────────────────────┐
│  fetch(url)                                                     │
│  res.status check (200/401/500)                                 │
│  res.headers['content-type'] check (ndjson vs json)             │
│  res.body.getReader()                                           │
│  loop:                                                          │
│    {done, value} = read()                                       │
│    buf += decode(value, {stream:true})                          │
│    lines = buf.split('\n')                                      │
│    buf = lines.pop()                                            │
│    for line: handle(JSON.parse(line))                           │
│  done → cleanup, final state                                    │
└─────────────────────────┬──────────────────────────────────────┘
                          │ HTTP chunked / HTTP/2 DATA frames
                          │ Content-Type: application/x-ndjson; …
                          │ Cache-Control: no-cache, no-transform
                          ▼
Service band ──────────────────────────────────────────────────────
┌────────────────────────────────────────────────────────────────┐
│  ReadableStream({                                               │
│    start(controller) {                                          │
│      send(e) = controller.enqueue(encode(json(e)+'\n'))         │
│      try {                                                      │
│        for each agent event: send(event)                        │
│      } catch (e) {                                              │
│        send({type:'error', message:e})                          │
│      } finally {                                                │
│        controller.close()                                       │
│      }                                                          │
│    }                                                            │
│  })                                                             │
│  maxDuration=300                                                │
└────────────────────────────────────────────────────────────────┘

ALTERNATIVES NOT USED:
  SSE       — auto-reconnect would re-bill a 115s LLM run
  WebSocket — no back-channel, no native serverless support
  gRPC      — wrong tool for browser-first; binary opaque in DevTools
```

---

## Implementation in codebase

### Use cases

  → **Live briefing scan.** `/api/briefing` emits `workspace`, `coverage_item` × N, `reasoning_step` × many, `tool_call_start/end` × ~10, `insight` × ~3, `done`. ~60 s.
  → **Live investigation.** `/api/agent?insightId=…&step=diagnose` emits `reasoning_step` (agent thoughts), `tool_call_start/end` (EQL queries), `diagnosis`, `done`. ~30–60 s for diagnose, ~20–40 s for recommend.
  → **Demo replay.** Same wire format; route reads a snapshot from disk and paces events with `REPLAY_DELAY_MS = 140` (briefing) or `180` (agent). The consumer doesn't know it's a replay.
  → **Free-form query.** `/api/agent?q=…` runs a one-shot query agent, emits one `reasoning_step` per chunk, then a final conclusion + `done`.

### Producer — `app/api/agent/route.ts`

```
app/api/agent/route.ts  (lines 168-264)

const encoder = new TextEncoder();
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const collected: AgentEvent[] = [];
    const send = (e: AgentEvent) => {
      collected.push(e);                       // for the disk cache
      controller.enqueue(encoder.encode(encodeEvent(e)));
                                          │
                                          └─ encodeEvent is literally
                                             JSON.stringify(e) + '\n'.
                                             One line per event, no
                                             batching. Flushed the
                                             moment the agent emits.
    };
    …
    try {
      // bootstrap INSIDE the stream so the client sees progress
      // immediately — otherwise a 1-2s schema fetch looks like
      // a stalled connection.
      stepFor(leadAgent, 'thought', 'reading the workspace schema…');
      const schema = await bootstrapSchema(conn.mcp);
      …
      send({ type: 'done' });
      if (step == null) saveInvestigation(insightId!, collected);
                                          │
                                          └─ only the combined run is
                                             cached. The split steps
                                             are handed off via the
                                             client's sessionStorage.
    } catch (e) {
      send({
        type: 'error',
        message: `/api/agent · ${e instanceof Error ? e.message : String(e)}`,
                                          │
                                          └─ in-band error: the headers
                                             already went, we can't
                                             change the status code, so
                                             the error rides as a final
                                             NDJSON line.
      });
    } finally {
      controller.close();
                                          │
                                          └─ load-bearing for socket
                                             release. See file 03.
    }
  },
});
return new Response(stream, { headers: NDJSON_HEADERS });
```

### Consumer — `lib/hooks/useInvestigation.ts`

```
lib/hooks/useInvestigation.ts  (lines 153-208)

const res = await fetch(url);
if (res.status === 401) {
  const b = await res.json().catch(() => ({}));
  if (b?.needsAuth && b?.authUrl) {
    window.location.href = b.authUrl as string;
                                          │
                                          └─ 401 short-circuits the
                                             whole reader path; we
                                             never start streaming.
    return;
  }
}
if (!res.ok || !res.body) { … setError(…); return; }

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
                                          │
                                          └─ {stream:true} keeps a partial
                                             UTF-8 byte sequence buffered
                                             across reads. Without it, a
                                             multi-byte character split
                                             across two chunks would
                                             decode to a replacement char.
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
                                          │
                                          └─ ★ load-bearing ★ — the trailing
                                             element is either '' (clean
                                             break) or a partial line; it
                                             becomes the start of the next
                                             read's buffer. Drop this and
                                             you corrupt two events per
                                             chunk-boundary split.
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line) as AgentEvent);
                                          │
                                          └─ the `switch (e.type)` inside
                                             handle() routes to the right
                                             setState. The wire contract
                                             (AgentEvent discriminated
                                             union) lives in lib/mcp/events.ts.
    } catch {
      /* malformed line — skip */
    }
  }
}
if (buf.trim()) {
  try { handle(JSON.parse(buf) as AgentEvent); }
                                          │
                                          └─ tail handling — if the producer
                                             closed without a final newline,
                                             the last event sits in buf.
                                             Parse it on done; skip if it's
                                             a partial we never got the
                                             rest of.
  catch { /* ignore */ }
}
```

### What's absent (and the verdict)

  → **No `EventSource`** anywhere in the codebase. A grep for `EventSource`, `text/event-stream`, `data:` returns no hits. Verdict: `not yet exercised`; SSE is the right move *if and only if* we ever need server-push outside a request context.
  → **No WebSocket.** A grep for `WebSocket`, `ws://`, `wss://` returns no hits. Verdict: `not yet exercised`; would only be right with a full-duplex requirement.
  → **No gRPC, no WebTransport.** Same.

---

## Elaborate

The "streaming JSON over HTTP" pattern is sometimes called "newline-delimited JSON" (NDJSON) or "JSON Lines" (JSONL). Same wire format, different name. The pattern predates SSE and is widely used by tools that need a programmatic stream rather than a browser-targeted one (Elasticsearch's bulk API, `jq -c`, Anthropic's own SDK uses a variant). Picking it for a browser app is slightly unusual — most browser tutorials reach for SSE first — but it works because `fetch` + `ReadableStream` is now a first-class API in every modern browser.

SSE's auto-reconnect with `Last-Event-ID` is genuinely useful for *cheap* idempotent feeds (a notification stream, a chat). It's actively harmful for *expensive non-idempotent* server-side work (an LLM run, a paid API call). The correctness question is "is restarting cheap?" — if yes, SSE; if no, fetch+stream.

WebSocket is *not* a generic upgrade from HTTP; it's a different protocol with different framing, different auth, different proxying behaviour. Picking it should be a deliberate choice driven by needing full-duplex, not a default.

---

## Interview defense

**Q1: Why didn't you use SSE for the agent stream?**

Two reasons. One, SSE's `EventSource` auto-reconnects on any drop — which would restart a 115-second LLM investigation, re-billing Anthropic and re-burning the Bloomreach rate-limit budget. Two, the data flow is server-push only; SSE doesn't give us anything chunked HTTP + NDJSON doesn't, but it imposes that reconnect behaviour. So we pick the smaller tool.

```
Diagram-while-you-speak

  SSE:           connection drops → auto-retry → server re-runs → 2× cost
  Chunked+NDJSON: connection drops → reader gets done → user retries explicitly
```

Anchor: "auto-reconnect is an asset for cheap feeds, a liability for expensive ones."

**Q2: Why not WebSocket?**

No back-channel. The client never sends a message after the initial request; the agent's reasoning is purely server-push. WebSocket gives full-duplex, costs a separate server runtime (serverless functions don't host long-lived WS natively), separate framing, and separate auth dance. Three new things for zero gain.

**Q3: What's the most load-bearing piece of the producer side?**

`controller.close()` in the `finally` block. Without it, an uncaught throw leaves the socket half-open until Vercel's `maxDuration=300` fires. With it, the socket releases the moment the agent finishes or errors. The `try / catch / send error / finally close` shape is the kernel.

```
Skeleton — what breaks if removed

  try { … } catch { send(error) } finally { close }
                       │                      │
                       │                      └─ socket release; without:
                       │                         hung until maxDuration
                       │
                       └─ in-band error; without:
                          silent close, client sees no error message
```

---

---

## See also

  → `01-network-map.md` — where this stream sits in the bigger picture.
  → `03-tcp-udp-connections-and-sockets.md` — why the inbound TCP must stay open for the full agent run.
  → `05-http-semantics-caching-and-cors.md` — the `Cache-Control: no-transform` directive that keeps the stream live.
  → `../study-system-design/05-streaming-ndjson.md` — the bytes-on-the-wire detail.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).

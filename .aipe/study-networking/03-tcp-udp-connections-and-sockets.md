# TCP, UDP, connections, and sockets

**Industry name(s):** transport layer, connection lifecycle, keep-alive pooling, the socket API
**Type:** Industry standard · Language-agnostic

> Every byte in this repo travels over TCP (via HTTPS); UDP is `not yet exercised`. We never touch a raw socket; the connection lifecycle is owned by undici (server-side) and the browser stack (client-side), with one exception: the inbound NDJSON response holds a TCP connection open for ~115 s while the agent runs.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** All three transport-layer connections in this app are TCP-over-TLS (HTTPS). No raw sockets, no UDP, no HTTP/3 / QUIC explicitly configured (whatever the platform negotiates). The interesting connection is the *inbound* one — the browser → serverless TCP socket that has to stay open for the full investigation while the outbound sockets to Bloomreach and Anthropic come and go.

```
Zoom out — where TCP connections live

┌─ Browser ────────────────────────────────────────────────────────────┐
│  fetch() → opens (or reuses) TCP+TLS to <app>.vercel.app             │
└────────────────────────┬─────────────────────────────────────────────┘
                         │  ★ long-lived: held open 60-115 s ★
                         │     HTTP body streamed in chunks
                         │     keep-alive default; HTTP/2 if negotiated
                         ▼
┌─ Serverless function ────────────────────────────────────────────────┐
│  Response = ReadableStream — controller.enqueue per event            │
│  while open, makes 6-10 outbound TCP+TLS connections:                │
└────┬────────────────────────────────────────────────┬────────────────┘
     │                                                  │
     ▼                                                  ▼
┌───────────────────────────┐                ┌──────────────────────────┐
│  Bloomreach MCP           │                │  Anthropic API           │
│  via undici default agent │                │  via @anthropic-ai/sdk   │
│  short-lived per request, │                │  short-lived per request,│
│  keep-alive within instance│                │  keep-alive within sdk  │
└───────────────────────────┘                └──────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this file answers: what does the connection lifecycle actually look like — when does a TCP socket open, when does it close, when is it reused, when is it abandoned? The honest answer is that the *inbound* connection is the one we control (we own when to close it via the `ReadableStream` lifecycle); the *outbound* connections are entirely the platform's problem, and we have not configured pooling.

---

## Structure pass

**Layers.** Three layers of transport in play. **App protocol** (HTTP/1.1 or HTTP/2 — we don't pin either, we let the platform negotiate; chunked transfer for streams). **Transport** (TCP, always, with TLS on top). **Network** (IP, opaque to us). We never address layers below TCP and we never use anything beside it (no UDP-based protocol, no QUIC explicitly enabled).

**Axis: lifecycle.** Trace "when does this connection open, exist, close?" across the inbound and outbound directions and the seams pop. **Inbound** lives for the full duration of the response (which is the full duration of the agent run — 60 to 115 s). **Outbound to Bloomreach** lives for the duration of a single `POST /mcp/` (~1–3 s; one per tool call, ~6 per investigation). **Outbound to Anthropic** lives for the duration of one streamed `POST /v1/messages` (~5–30 s per turn; one per LLM step, ~4 per investigation). The inbound connection wraps a tree of outbound connections.

**Seams.** Three seams matter.

  → **Seam 1 (load-bearing for liveness): inbound TCP duration vs platform kill.** The connection must stay open long enough for the agent to finish; Vercel kills the function at `maxDuration=300`. The 300 s ceiling is the load-bearing constraint — every retry budget and per-call timeout is measured against it.
  → **Seam 2: outbound connection reuse vs cold-start cost.** Whether undici reuses a connection to Bloomreach or opens a fresh one depends on the function instance's age and the platform's keep-alive defaults. We have not measured this.
  → **Seam 3: HTTP/1.1 vs HTTP/2 multiplexing.** Vercel terminates TLS at the edge and is HTTP/2-capable; the function-to-edge hop and the browser-to-edge hop may differ. We don't pin either; the impact is "one connection serves many parallel requests if HTTP/2 negotiated, separate connections if HTTP/1.1."

```
Three seams — lifecycle vs control

  seam                              what flips                load-bearing?
  ────                              ──────────                 ─────────────
  inbound TCP vs maxDuration        live → killed              yes
  outbound reuse vs cold start      cheap → expensive          no (unmeasured)
  HTTP/1.1 vs HTTP/2                serial → multiplexed       no (not pinned)
```

The skeleton is mapped — the rest walks the mechanics.

---

## How it works

### Mental model

Think of a TCP connection as a phone line: it costs something to dial (three-way handshake + TLS), it costs nothing to keep open once dialed, it costs something to hang up. The pattern here is "dial inbound once, hold the line, dial outbound several times, possibly reusing one outbound line for multiple short calls."

```
The shape — one long-lived inbound, many short outbounds

  Time ──►
  
  inbound:    [─────────────── open, streaming chunks ─────────────────]
                ▲                                                       ▼
  outbound 1:   [── dial → Bloomreach ── close ──]
  outbound 2:           [── dial → Anthropic ──── close ──]
  outbound 3:                                   [── reuse? Bloomreach ── close ──]
  outbound 4:                                                [── dial Anthropic ──]
              0s                  30s                 60s              115s
```

The outbounds happen inside the inbound. If undici reuses a connection (warm pool, keep-alive window), outbound 3 might skip the dial — saving 50–200 ms per call. We don't measure this; the default behaviour is what we get.

### Move 2 walkthrough

**The inbound connection: opened by the browser, held by the ReadableStream.** The browser's `fetch()` opens a TCP connection to `<app>.vercel.app` (or reuses one from its keep-alive pool). TLS handshake. HTTP request. The server returns a `Response` whose body is a `ReadableStream`. As long as the stream is not closed, the socket stays open. Bytes flow whenever the producer calls `controller.enqueue(...)`. The browser's reader loop wakes up per chunk.

```
Inbound lifecycle — held open by the stream

  Browser                          Server (route handler)
  ────────                         ──────────────────────
  fetch('/api/agent?…')   ─►       handler enters
                                   const stream = new ReadableStream({
                                     async start(controller) {
       ◄── 200 + headers ──        await client.connect(transport)
                                   // ↑ stream is now "open" but
                                   //   we haven't enqueued anything
       ◄── chunk 1 ──             controller.enqueue(event1)
       ◄── chunk 2 ──             controller.enqueue(event2)
       …                          (loop runs the agent)
       ◄── chunk N ──             controller.enqueue(eventN)
                                   controller.close()
                                   ↑ socket flushes, then closes
       (stream done)
```

The boundary that catches people: if the producer throws and the `finally` doesn't close the controller, the socket can hang until Vercel's `maxDuration` fires and kills the function. That's why every stream in this repo has a `try { … } finally { controller.close() }` pattern.

**Why the inbound socket has to stay open: NDJSON has no checkpoint.** Unlike SSE (which the browser auto-reconnects on disconnect, replaying from a `Last-Event-ID`), NDJSON over `fetch` has no resumption. If the inbound TCP drops mid-investigation, the client cannot ask "resume from event 42" — it has to restart the whole agent run. So the inbound socket lives or dies with the request; there is no in-between.

```
Pseudocode — the producer holds the connection alive

  function GET(req):
    stream = new ReadableStream:
      start(controller):
        try:
          while agent has more events:
            event = await agent.next_step()    // ← waits on outbound I/O,
                                                //   socket idle but open
            controller.enqueue(encode(event))   // ← bytes flushed
                                                //   browser receives chunk
        catch e:
          controller.enqueue(encode(error_event(e)))
        finally:
          controller.close()                    // ← without this, the socket
                                                //   hangs until maxDuration
    return new Response(stream, {…headers})
```

**The outbound to Bloomreach: one POST per tool call, pool reuse opaque.** Inside the producer, every `mcp.callTool(name, args)` ends up at undici's `fetch`. Undici keeps a pool of warm connections per origin (default ~10 per host, default ~5 s keep-alive window). The function instance lives across requests if Vercel keeps it warm, so a second briefing on the same instance can reuse the pool. After ~5 s idle, the connection ages out.

We do not configure any of this. There is no `Dispatcher`, no `Agent({ keepAliveMsecs })`, no `pool` constant anywhere in the repo. The defaults are what we get.

```
Outbound to Bloomreach — undici default pool

  Pseudocode of what undici does (we don't touch this):
  
    on fetch(url):
      conn = pool[origin].acquire()             // ← keep-alive socket if warm
      if conn is null:
        conn = new TCP+TLS to origin            // ← handshake cost (~50-200ms)
      send request on conn
      receive response
      if response.headers['connection'] != 'close':
        pool[origin].release(conn)              // ← back to pool, idle timer
      else:
        conn.close()
```

The cost of NOT pooling: a fresh handshake per call is 50–200 ms; 6 calls per investigation is up to 1.2 s of extra latency in the worst case. Against a 60 s budget that's noise; against a future tight budget it would matter.

**The outbound to Anthropic: same shape, hidden inside the SDK.** `@anthropic-ai/sdk` does its own fetch with its own (or undici's) pooling. We instantiate one `Anthropic` client per request — at request scope — which means we don't share a long-lived SDK instance across requests. The SDK's own internal pooling kicks in within a single request (multiple turns can reuse the connection), but not across requests on the same warm function instance.

```
Outbound to Anthropic — per-request client, per-turn connection reuse

  Pseudocode at the route handler:
  
    GET handler:
      anthropic = new Anthropic({apiKey: env.KEY})   // ← per-request
      agent = new DiagnosticAgent(anthropic, …)
      while agent has more turns:
        response = await anthropic.messages.create(…) // ← turn N
        // ↑ N=2,3,4… may reuse the same underlying TCP socket
        //   (SDK pool); N=1 always pays handshake
      // anthropic object goes out of scope; pool dies with it
```

The pattern that catches people: each route invocation builds a fresh `Anthropic` client; the warm pool is bounded by the lifetime of that client. A pooled-across-requests client would save handshakes on warm functions but would add cold-start memory cost. We accept the per-call handshake.

**No app-layer per-call timeout.** Neither outbound fetch sets `AbortController`+`signal`. The only timeout is Vercel's `maxDuration=300` which kills the entire function — not the specific stuck call. If a Bloomreach socket hangs at minute 2, the user gets no events for minutes 2–5, then a hard kill, then nothing. This is `red flag #1` in `08-networking-red-flags-audit.md`.

### Principle

Connection lifecycle decisions are usually about latency vs cost: longer-lived connections amortise handshake, but they cost memory and resource on both ends. The default platform behaviour is right for this app's scale (one user at a time, single-digit calls per request); the absence of explicit configuration is a deliberate choice, not an oversight, and the cost of revisiting it is "instrument before you tune." Pool, timeout, and reuse are *measurable*; pick the budget first, measure, then configure.

---

## Primary diagram

The recap — every connection's lifecycle, in one frame.

```
Connection lifecycle — full recap

UI band ──────────────────────────────────────────────────────────────
┌────────────────────────────────────────────────────────────────────┐
│  Browser TCP+TLS to <app>.vercel.app                               │
│  • opened by fetch(), keep-alive default                           │
│  • holds for 60-115s while NDJSON streams                          │
│  • no app-layer reconnect on drop                                  │
└─────────────────────────┬──────────────────────────────────────────┘
                          │ HTTP/1.1 or HTTP/2 (platform-negotiated)
                          │ Transfer-Encoding: chunked
                          ▼
Service band ─────────────────────────────────────────────────────────
┌────────────────────────────────────────────────────────────────────┐
│  Serverless function (Node runtime, maxDuration=300)               │
│  • Response body = ReadableStream                                  │
│  • controller.enqueue per event → flush                            │
│  • try/finally controller.close() guarantees socket release        │
└──────┬─────────────────────────────────────────────────┬───────────┘
       │                                                  │
       │  undici default agent                            │  Anthropic SDK
       │  • keep-alive ~5s, ~10 conns/origin              │  default pool
       │  • no app-layer override                         │  • per-request client
       │  • no per-call AbortController                   │  • per-turn reuse
       ▼                                                  ▼
┌─────────────────────────────┐                ┌──────────────────────────┐
│  TCP+TLS → Bloomreach       │                │  TCP+TLS → Anthropic     │
│  • short-lived, ~1-3s each  │                │  • short-lived, ~5-30s   │
│  • ~6 per investigation     │                │  • ~4 per investigation  │
│  • pool reuse opportunistic │                │  • streamed bodies       │
└─────────────────────────────┘                └──────────────────────────┘
```

---

## Implementation in codebase

### Use cases

  → **Inbound stream lifecycle.** Every long route (`/api/briefing`, `/api/agent`) constructs `new Response(stream, …)` and relies on `controller.close()` in a `finally` block to release the socket.
  → **Outbound to Bloomreach.** Every `mcp.callTool(...)` from `lib/agents/*` ends in `lib/mcp/transport.ts`'s `client.callTool`, which is undici default agent under the SDK.
  → **Outbound to Anthropic.** Every `new Anthropic({ apiKey })` at the top of an agent run; the client's internal pool dies with the function call.

### The `try / finally` that guards inbound socket release

```
app/api/agent/route.ts  (lines 169-264)

const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    …
    try {
      …agent runs, controller.enqueue per event…
    } catch (e) {
      send({ type: 'error', message: `/api/agent · …` });
                          │
                          └─ producer-side error: caught, surfaced as
                             a final NDJSON line so the client renders
                             "error" instead of seeing a silent close.
    } finally {
      controller.close();
                          │
                          └─ load-bearing: without this, an uncaught
                             throw leaves the underlying socket
                             half-open until Vercel kills the function
                             at maxDuration=300. With it, the socket
                             releases immediately on completion or
                             failure.
    }
  },
});
```

### The fetch-wrapper insertion point (no per-call timeout today)

```
lib/mcp/transport.ts  (lines 24-36)

export function makeCapturingFetch(holder: HttpErrorHolder): FetchLike {
  return async (url, init) => {
    const res = await fetch(url, init);
                          │
                          └─ no AbortController, no signal, no timeout.
                             undici's defaults are what we get. The
                             insertion point for a future per-call
                             timeout is HERE — wrap init.signal with
                             AbortSignal.timeout(N).
    if (!res.ok) {
      try {
        holder.last = { status: res.status, body: (await res.clone().text()).slice(0, MAX_BODY) };
      } catch {
        /* body unreadable / already consumed — leave the holder as-is */
      }
    }
    return res;
  };
}
```

### Proactive spacing — the only "rate" we control at the socket layer

```
lib/mcp/client.ts  (lines 148-163)

private async liveCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
                          │
                          └─ not a socket-level rate-limit; this is an
                             in-process sleep BEFORE we issue the
                             outbound fetch. The socket itself sees no
                             special pacing. Default minIntervalMs=1100
                             matches the observed 1-req/s upstream
                             rule.
  }
  try {
    const result = await this.transport.callTool(name, args);
    this.lastCallAt = Date.now();
    return result;
  } catch (err) { … }
}
```

---

## Elaborate

The phrase "connection pool" is overloaded. There are at least three pools in play here, none of which we configure: (1) the browser's per-origin pool (browser policy), (2) undici's per-origin pool inside the function (Node default), (3) the Anthropic SDK's internal pool (SDK default). For this app's scale, the defaults are fine. The decision to *measure* them is what would unlock a smarter configuration.

UDP shows up in two places in modern web stacks: HTTP/3 (QUIC) at the edge, and DNS over UDP at the resolver. We don't use either explicitly. If the platform negotiates HTTP/3 to the browser, we benefit silently. We do not pin it.

The contrast with realtime apps is sharp. A WebSocket-based chat would have *exactly one* inbound TCP per user that stays open for hours; outbound calls would be N×fetch on top. The lifecycle picture would be inverted. We have neither requirement nor mechanism here — see `06-websockets-sse-streaming-and-realtime.md`.

---

## Interview defense

**Q1: Tell me about connection management in your app.**

We delegate. The browser opens one TCP+TLS to the app and holds it open for the full NDJSON stream — typically 60–115 s for an investigation. Inside the serverless function, every outbound to Bloomreach and Anthropic goes through default platform pooling (undici's defaults, Anthropic SDK's defaults). We do not configure pool size, keep-alive window, or per-call timeouts. The reason: at our scale, the defaults are correct, and the cost of configuring without measurement is worse than the cost of accepting them.

```
Diagram-while-you-speak

  ── one long inbound TCP ─────────────────────────
        ├── short outbound TCP ─ Bloomreach
        ├── short outbound TCP ─ Anthropic
        ├── (maybe pool reuse)  ─ Bloomreach
        └── (maybe pool reuse)  ─ Anthropic
```

Anchor: "the inbound is long-lived because NDJSON has no resumption; the outbounds are short-lived because we have nothing pushing back."

**Q2: What happens if an outbound socket hangs?**

It eats the route budget. We have no `AbortController`+`signal` on outbound fetches, no per-call timeout, no circuit breaker. Vercel's `maxDuration=300` is the only ceiling, and it's whole-function — the user sees the events that *did* arrive before the hang, then silence. The fix is wiring `signal: AbortSignal.timeout(15_000)` into `makeCapturingFetch` for the Bloomreach side and the equivalent for the Anthropic SDK. It's a known gap; see `08-networking-red-flags-audit.md`.

**Q3: Why is the inbound socket lifecycle different from the outbound ones?**

Asymmetric resumption. The browser cannot tell us "resume from event 42" — NDJSON has no `Last-Event-ID`. So the inbound socket must live for the full agent run or the user gets nothing. The outbound calls are short and idempotent-ish (a fresh Bloomreach POST gives the same answer); we can absorb their churn. If we adopted SSE with `Last-Event-ID` semantics, the inbound could become short-lived and resume-able too.

---

---

## See also

  → `01-network-map.md` — where these sockets sit in the bigger picture.
  → `04-tls-and-trust-establishment.md` — what rides on top of every TCP here.
  → `06-websockets-sse-streaming-and-realtime.md` — the alternative connection-lifecycle shapes we do NOT use.
  → `07-timeouts-retries-pooling-and-backpressure.md` — the rate-limit logic at the application layer.

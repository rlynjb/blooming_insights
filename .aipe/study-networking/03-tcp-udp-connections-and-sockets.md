# TCP/UDP, connections, and sockets

**Transport-layer behavior** · Language-agnostic

## Zoom out — where this concept lives

The layer below TLS, above DNS. Once DNS has handed us an IP, TCP opens the socket; everything HTTP-shaped rides on top.

```
  Zoom out — TCP sits between DNS and TLS

  ┌─ Application (HTTP/2 or HTTP/1.1) ────────────┐
  │  fetch(), Anthropic SDK, MCP SDK              │
  └─────────────────┬─────────────────────────────┘
                    │
  ┌─ TLS ───────────▼─────────────────────────────┐
  │  encrypted record layer                       │
  └─────────────────┬─────────────────────────────┘
                    │
  ┌─ TCP ───────────▼─────────────────────────────┐ ← we are here
  │  reliable, ordered byte stream                 │
  │  3-way handshake · keepalive · FIN/RST         │
  └─────────────────┬─────────────────────────────┘
                    │
  ┌─ IP ────────────▼─────────────────────────────┐
  │  packets to <IP>:443                           │
  └────────────────────────────────────────────────┘
```

## Zoom in — the concept

Every wire in this app is **TCP under HTTPS**. There is no UDP socket opened by our application code. There is no raw socket. There is no custom transport. The interesting questions are about *connection lifecycle* — how long each TCP connection stays open, which calls share which connection, and what happens when the client tries to cancel a request mid-flight.

## Structure pass

### Layers

- **Caller** — our code (`fetch`, MCP SDK, Anthropic SDK).
- **HTTP client** — Node's `undici` global agent (or the browser's network stack) — owns connection pooling, keepalive, HTTP/2 multiplexing.
- **TCP socket** — kernel-level, opaque to us.

### One axis held constant — `who manages the connection lifecycle?`

```
  axis = "who decides when the TCP socket opens and closes?"

  ┌─ Browser → /api/briefing ─────┐  the browser does
  │ long-lived chunked response   │  → connection stays open for the whole
  │                               │    300s NDJSON stream, then closes naturally
  └───────────────────────────────┘

  ┌─ Service → Bloomreach ─────────┐  undici does (keepalive pool)
  │ short JSON-RPC calls            │  → connection reused across tool calls in
  │                                 │    the same warm function instance
  └────────────────────────────────┘

  ┌─ Service → Anthropic ──────────┐  undici does (keepalive pool, HTTP/2)
  │ ~10-50s LLM calls              │  → same pool, but every call is its own
  │                                 │    HTTP/2 stream multiplexed on the socket
  └────────────────────────────────┘
```

Three different lifetimes, three different reasons.

### Seams

- **`fetch` ↔ undici** — we hand it a URL; undici picks an existing connection or opens a new one. We never see the socket.
- **`AbortSignal` ↔ socket close** — when our `AbortController.abort()` fires, undici closes (or RST-resets) the socket. The other side sees the disconnect.
- **300s `maxDuration` ↔ TCP teardown** — when Vercel kills the function, the TCP socket dies with it. Both upstream providers see a half-open connection or RST.

## How it works

### Move 1 — the mental model

A TCP socket is a phone line between two ports. Setup is expensive (3-way handshake + TLS = 2-3 RTTs); use is cheap. So everything we build on top is designed around *reusing* the line, not opening one per request.

```
  the pattern — open once, reuse many

  Service                                  Bloomreach
     │   SYN                                    │
     │ ────────────────────────────────────────►│   ┐
     │   SYN+ACK                                │   │  TCP 3-way handshake
     │ ◄────────────────────────────────────────│   │  (1 RTT)
     │   ACK                                    │   ┘
     │ ────────────────────────────────────────►│
     │                                          │
     │   ClientHello (TLS)                      │   ┐
     │ ────────────────────────────────────────►│   │  TLS handshake
     │   ServerHello + cert + Finished          │   │  (1-2 RTTs depending
     │ ◄────────────────────────────────────────│   │   on TLS 1.3 vs 1.2)
     │   ClientFinished                         │   ┘
     │ ────────────────────────────────────────►│
     │                                          │
     │   HTTP request 1 (tools/call)            │
     │ ────────────────────────────────────────►│   ┐
     │   HTTP response 1 (result)               │   │  the cheap part —
     │ ◄────────────────────────────────────────│   │  reuse the socket
     │   HTTP request 2 (tools/call)            │   │  as many times as
     │ ────────────────────────────────────────►│   │  you can
     │   HTTP response 2 (result)               │   │
     │ ◄────────────────────────────────────────│   ┘
     │                                          │
```

### Move 2 — walk each wire's socket story

#### Wire #1 — Browser to `/api/briefing` (the long-lived one)

This is the connection that defines this app's TCP profile. One `fetch('/api/briefing')` opens one TCP connection that stays open for up to 300 seconds while the route streams NDJSON events one chunk at a time.

```
  Wire #1 — one TCP connection, many chunks

  Browser                                       Vercel fn
     │   SYN/ACK/TLS handshake (once)             │
     │ ════════════════════════════════════════►  │
     │                                            │
     │   GET /api/briefing                        │
     │ ────────────────────────────────────────►  │
     │                                            │
     │   HTTP/1.1 200                             │
     │   Transfer-Encoding: chunked               │
     │   Content-Type: application/x-ndjson       │
     │ ◄────────────────────────────────────────  │
     │                                            │
     │   chunk: {"type":"workspace",…}\n          │
     │ ◄────────────────────────────────────────  │  ← agent thinking…
     │                                            │
     │   chunk: {"type":"reasoning_step",…}\n     │
     │ ◄────────────────────────────────────────  │
     │                                            │  (many chunks, seconds apart)
     │   chunk: {"type":"done"}\n                 │
     │ ◄────────────────────────────────────────  │
     │                                            │
     │   final 0-length chunk (HTTP/1.1 end)      │
     │ ◄────────────────────────────────────────  │
     │                                            │
     │   FIN  (or socket reused for next req)     │
```

The route code on the server side:

```ts
// app/api/briefing/route.ts:330-335
return new Response(stream, {
  headers: {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store, no-transform',
  },
});
```

The `ReadableStream` enqueues bytes; Next.js wraps it in HTTP/1.1 chunked transfer encoding (or HTTP/2 DATA frames, depending on what the client negotiates). Either way, the socket stays warm until the stream completes or someone aborts.

What this changes about reasoning: **the route holds one TCP socket per active user for the duration of a briefing.** Vercel functions can serve concurrent requests on one instance, so it's not "one user = one instance," but the socket-level fan-out is real.

#### Wire #2 — Service to Bloomreach (the pooled short calls)

The MCP SDK uses Node's global undici agent for its `fetch`. Undici keeps an HTTP keepalive pool per origin. So the *second* tool call in a single briefing reuses the socket from the first.

The cold-start cost is one handshake. Subsequent calls in the same warm function pay zero TCP/TLS setup.

```ts
// lib/mcp/transport.ts:103-118
export function makeCapturingFetch(holder: HttpErrorHolder): FetchLike {
  return async (url, init) => {
    const res = await fetch(url, init);   // ← global undici fetch, keepalive pool included
    if (!res.ok) {
      try {
        holder.last = {
          status: res.status,
          body: redactSecrets((await res.clone().text()).slice(0, MAX_BODY)),
        };
      } catch { /* … */ }
    }
    return res;
  };
}
```

We don't construct an `Agent` ourselves; the SDK's `StreamableHTTPClientTransport` uses whatever `fetch` we hand it (our capturing wrapper), and the wrapper falls through to the Node-global `fetch`. That's where the pool lives.

#### Wire #3 — Service to Anthropic (HTTP/2 multiplexed)

The Anthropic SDK is HTTP/2-capable. Multiple in-flight `messages.create` calls on the same SDK instance are likely to share one TCP socket via HTTP/2 streams. We don't measure this, but the SDK's behavior is to reuse the connection.

```ts
// app/api/agent/route.ts:244
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
```

One instance per request, but the underlying HTTP client is shared across the process.

#### Cancellation — the AbortSignal chain

This is the place where the application's TCP behavior is most observable. When the user navigates away mid-briefing, the browser closes the socket. Vercel signals this via `req.signal.aborted`. The route propagates that signal into every async layer below — the MCP transport, the Anthropic SDK, the bootstrap helpers.

```ts
// app/api/briefing/route.ts:215, 220, 250, 259, 279, 283
req.signal.throwIfAborted();
// …
const schema = await bootstrap(req.signal);
// …
const raw = await dataSource.listTools({ signal: req.signal });
// …
const anomalies = await agent.scan({ /* … */ signal: req.signal }, runnable);
```

Inside the transport, the route-cancel signal gets composed with a per-call timeout via the signal combinator (`composeSignals`):

```ts
// lib/mcp/transport.ts:131
const signal = composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS));
//                                          ↑ 30_000 ms — see TOOL_TIMEOUT_MS at line 38
try {
  return await this.client.callTool({ name, arguments: args }, undefined, { signal });
} catch (err) {
  // …
}
```

When either signal fires, undici closes the upstream socket to Bloomreach. The Bloomreach side sees a FIN (or RST, depending on timing). That's the only way the alpha server learns we gave up.

```
  Cancellation — the signal chain

  Browser closes tab
       │
       ▼  TCP FIN
  Vercel function: req.signal.aborted = true
       │
       ▼  passed as { signal } into every await
  BloomreachDataSource.callTool({ signal })
       │
       ▼  composed with AbortSignal.timeout(30_000)
  SdkTransport.callTool → MCP SDK client → undici
       │
       ▼  on abort, undici closes
  TCP FIN to loomi-mcp-alpha.bloomreach.com
       │
       ▼
  Bloomreach sees us drop
```

#### UDP — `not yet exercised`

The application code opens no UDP socket. The platforms beneath it use UDP for:

- DNS queries (typically UDP/53 unless the response is large enough to require TCP fallback).
- QUIC/HTTP/3 — possibly, between Vercel's edge and the browser. We don't control this; we don't observe it. Behaviorally indistinguishable from HTTP/2 from our perspective.

Nothing in this codebase reads, writes, or reasons about a UDP datagram.

### Move 3 — the principle

**Long-lived chunked HTTP and pooled short-call HTTP are two completely different connection profiles riding the same protocol.** Wire #1 holds a socket for 300 seconds and reasons about the lifetime of one stream. Wire #2 opens, pools, and reuses sockets across many small tool calls and reasons about latency-per-call. The application code doesn't see TCP; it sees `fetch` and `ReadableStream`. But the TCP profile is what makes each wire feel the way it does.

## Primary diagram

```
  the recap — three wires, three socket profiles

  ┌─ Wire #1 ───────────────────────────────────────────────┐
  │ Browser ◄══════════════════════════════════════════════ │
  │   one socket per active stream                          │
  │   ~300s lifetime, chunked HTTP                          │
  │   FIN on natural end or AbortSignal                     │
  └─────────────────────────────────────────────────────────┘

  ┌─ Wire #2 ───────────────────────────────────────────────┐
  │ Service ──► Bloomreach                                  │
  │   undici keepalive pool                                 │
  │   cold start: 1 handshake; warm: socket reuse           │
  │   ~1 req/s/user limit means the socket is mostly idle   │
  └─────────────────────────────────────────────────────────┘

  ┌─ Wire #3 ───────────────────────────────────────────────┐
  │ Service ──► Anthropic                                   │
  │   undici keepalive pool, HTTP/2 multiplexed             │
  │   each messages.create = one HTTP/2 stream              │
  │   socket reused across concurrent calls                 │
  └─────────────────────────────────────────────────────────┘

  ┌─ UDP ───────────────────────────────────────────────────┐
  │  not yet exercised at the application layer              │
  └─────────────────────────────────────────────────────────┘
```

## Elaborate

The choice of "stream over chunked HTTP" rather than "open a WebSocket" has a TCP-level cost: the chunked HTTP connection has no built-in heartbeat. If the route stalls for 60 seconds while waiting on Bloomreach's rate limit, the TCP socket sits idle. Intermediate proxies (Vercel edge, corporate firewalls, browser network stacks) all have idle-connection timeouts. We don't currently send a keepalive ping. In practice the briefing makes progress often enough — coverage steps, query traces, partial results — that the socket never goes more than a few seconds without bytes. But it's a real exposure: if Bloomreach's retry ladder cost grows (the maximum is 3 × 20s = 60s on one tool call), we approach the idle range where proxies start cutting.

The 300s `maxDuration` is the absolute TCP ceiling. Vercel kills the function at 300s, the socket dies, the browser sees a FIN. The hook treats stream end as completion — which is correct if the route completed normally, but indistinguishable from a forced timeout if the route didn't. We don't currently tag "natural end" vs "deadline kill" in the wire format. A `{type:"done", deadline_hit: true}` would close that ambiguity.

## Interview defense

**Q: How long does a single TCP socket live in this app?**

> Depends on the wire. Wire #1 — browser to `/api/briefing` — holds one socket for the entire NDJSON stream, up to 300 seconds. Wire #2 to Bloomreach uses undici's keepalive pool: cold-start pays one handshake, then sockets get reused across tool calls in the same warm function. Wire #3 to Anthropic is the same pool but HTTP/2, so concurrent calls multiplex on one socket.

```
  on the whiteboard:

  Wire #1: ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬ (300s, one stream)
  Wire #2: ▬▬| ▬| ▬|  (pooled, idle in between)
  Wire #3: ▬▬|▬|▬|     (pooled + multiplexed)
```

Anchor: three wires, three lifetime profiles.

**Q: What happens to the upstream TCP sockets when the user closes the tab?**

> Browser closes its socket to `/api/briefing`. Vercel signals `req.signal.aborted`. The route has wired `req.signal` into every `await` — `bootstrap(req.signal)`, `dataSource.listTools({ signal })`, `agent.scan({ signal })`. Each layer's underlying `fetch` is wrapped to use that signal. Composed in the transport with `AbortSignal.timeout(30_000)` via `composeSignals` (`transport.ts:131`). When the signal fires, undici closes the upstream socket. Bloomreach sees FIN/RST. The in-flight tool call resolves to an abort error, which the route catches as `DOMException AbortError` and bails without emitting an error event.

```
  on the whiteboard:

  tab close → req.signal.aborted
            → composed signal fires inside transport
            → undici closes socket to Bloomreach (FIN)
            → tool-call promise rejects with AbortError
            → route's catch handler returns silently
```

Anchor: the AbortSignal chain is what makes the TCP teardown propagate end-to-end.

**Q: Does this app open any UDP sockets?**

> No, not at the application layer. Every wire is TCP under HTTPS. DNS uses UDP under the hood; HTTP/3 over Vercel's edge might use QUIC (UDP-based) to the browser. We don't observe or control either. There's no `dgram.createSocket`, no WebRTC, no custom protocol — every outbound call goes through `fetch`.

Anchor: TCP-only application code; UDP is platform-layer.

## See also

- `01-network-map.md` — the three wires this file profiles
- `04-tls-and-trust-establishment.md` — what rides on top of each TCP socket
- `06-websockets-sse-streaming-and-realtime.md` — why the long-lived TCP profile is chunked HTTP, not WebSocket
- `07-timeouts-retries-pooling-and-backpressure.md` — the signal chain that closes sockets cleanly

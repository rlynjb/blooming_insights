# 03 · TCP/UDP, connections, and sockets

## Subtitle

Transport-layer choices and connection lifecycle — Industry standard.

## Zoom out, then zoom in

The repo speaks one transport protocol everywhere: TCP, via HTTPS. No UDP, no raw sockets, no QUIC the app code negotiates, no Unix domain sockets (the retired Olist subprocess used stdio IPC, but it's gone). The interesting thing isn't the choice (TCP was the only option for HTTPS) — it's how the connection *lifecycle* differs per wire, because TCP gives you a stream that lives as long as you let it.

```
  Zoom out — where connection lifetimes diverge

  ┌─ UI layer ──────────────────────────────────────────────────┐
  │  browser HTTPS → /api/briefing                              │
  │  ★ long-lived ★ — open for the whole agent run (~30s)        │
  └────────────────────────────────────────────────────────────┘
                            │
                            ▼
  ┌─ Service layer ─────────────────────────────────────────────┐
  │  Node.js route handlers                                      │
  │  outbound HTTPS to two upstreams ↓                           │
  └──────────────┬─────────────────────────────────┬────────────┘
                 │ wire 2                          │ wire 3
                 │ MCP — keep-alive across calls   │ Anthropic — keep-alive
                 │ persistent transport per session│ inside SDK; one stream
                 │ many short JSON-RPC calls over  │ per messages.create call
                 │ ONE TCP connection              │
                 ▼                                 ▼
  ┌─ Bloomreach ────────────┐  ┌─ Anthropic ────────────────────┐
  │  one long TCP/TLS to     │  │  HTTPS pool (undici default)   │
  │  loomi-mcp-alpha         │  │                                │
  └─────────────────────────┘  └────────────────────────────────┘
```

Three boxes, three different connection rhythms. The browser-to-route socket lives as long as the agent does. The route-to-Bloomreach socket lives as long as the MCP session does (rides across many tool calls). The route-to-Anthropic sockets are pooled by undici's keep-alive default and recycled.

## Structure pass

  - **Layers** — application HTTPS over TCP, on three boundaries (one inbound from the browser, two outbound to providers).
  - **Axis traced — "how long does one TCP connection live?"** Hold that across the wires:
      - wire 1 (browser → route): **30s-ish** — for the lifetime of one streaming response, then closed.
      - wire 2 (route → Bloomreach MCP): **multi-call** — `StreamableHTTPClientTransport` keeps one connection per `Client` instance, reused across `callTool` invocations. Lives as long as the route's `connectMcp` result lives (per-request today; would be longer if pooled).
      - wire 3 (route → Anthropic): **pooled** — undici's keep-alive pool reuses TCP/TLS connections across calls; each `messages.create` may or may not reuse a prior one.
  - **Seams** — the load-bearing one is the long-lived response on wire 1. It's the only place the app deliberately keeps a TCP stream open under its control (via `ReadableStream<Uint8Array>`). Everything else is delegated to a runtime/SDK.

## How it works

### Move 1 — the mental model

A TCP connection is a stream of bytes either side can keep writing into until somebody closes it. HTTP/1.1 adds keep-alive (one connection, many request/response pairs). HTTP/2 adds multiplexing (one connection, many concurrent streams). Both reduce the cost of opening fresh connections — and the cost matters: a TLS handshake is ~2 round trips before any data flows.

```
  Pattern — connection lifecycle and reuse

   ┌──────────────────────────────────────────────┐
   │ open: TCP SYN/SYN-ACK/ACK + TLS handshake    │   ~2-3 RTTs of latency
   └──────────────────┬───────────────────────────┘   you only want to pay
                      │                                this ONCE per host
   ┌──────────────────▼───────────────────────────┐
   │ use: request → response  (HTTP/1.1)          │
   │      OR stream chunks    (long-lived response)│
   │      OR concurrent streams (HTTP/2)          │
   └──────────────────┬───────────────────────────┘
                      │  keep-alive: leave it open
   ┌──────────────────▼───────────────────────────┐
   │ reuse: next request rides the same socket    │
   └──────────────────┬───────────────────────────┘
                      │  eventually
   ┌──────────────────▼───────────────────────────┐
   │ close: idle timeout / explicit close / error │
   └──────────────────────────────────────────────┘
```

The whole reason browser fetches feel fast for second-and-later requests is that the connection from the first one is still warm. Same idea applies to the server-side fetches to Bloomreach and Anthropic.

### Move 2 — the moving parts

#### Wire 1 — the long-lived response (the streaming socket)

The browser opens one TCP/TLS connection to the page's origin and sends a GET to `/api/briefing`. The route returns a `ReadableStream<Uint8Array>` and starts enqueuing NDJSON lines. The connection stays open — held by the response body — until the route closes its controller.

```ts
// app/api/briefing/route.ts:191-326
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {                                  // ← runtime keeps the
    const send = (e: BriefingEvent) =>                        //   socket open as
      controller.enqueue(encoder.encode(JSON.stringify(e) + '\n')); // long as this
    // … (many enqueue calls over ~30s) …
    send({ type: 'done' });
    controller.close();                                       // ← only now does the
  },                                                          //   response complete
});
```

```
  Wire 1 connection timeline

  t=0     client SYN; server SYN-ACK; ACK            ── 1 RTT
  t=~50ms TLS ClientHello / ServerHello / Finished   ── 1-2 RTTs
  t=~100ms HTTP GET /api/briefing                    ── application-layer
          ◄── response headers (Transfer-Encoding: chunked, NDJSON)
          ◄── 'workspace' line (chunk)
          ◄── 'reasoning_step' line (chunk)
          ◄── 'tool_call_start' line (chunk)
          ◄── … (many chunks) …
  t=~30s  ◄── 'done' line (chunk)
          ◄── 0-length terminator chunk                ── server closes
          server FIN; client ACK; client FIN; ACK      ── 1 RTT
```

The runtime (Node + Next + Vercel's edge layer in front of it) handles the actual TCP frames, the chunked transfer encoding, and the FIN exchange. The app just keeps the controller open. Closing it (`controller.close()`) is what ends the response.

Cancellation: when the user closes the tab, the browser closes its side of the TCP connection. Vercel's edge propagates that to Node as `req.signal` aborting. The route hits `req.signal.throwIfAborted()` at the next coarse phase boundary and bails out of the agent loop. See `07-timeouts-retries-pooling-and-backpressure.md` for that flow in detail.

#### Wire 2 — one MCP connection across many tool calls

`StreamableHTTPClientTransport` opens an HTTPS connection to the Bloomreach MCP server when `client.connect(transport)` runs (`lib/mcp/connect.ts:85`). That connection is then reused for every `client.callTool(...)` and `client.listTools()` invocation against the same `Client` instance.

```
  Wire 2 — many JSON-RPC calls on one TCP/TLS connection

  connectMcp(sid):
    open TCP/TLS to loomi-mcp-alpha.bloomreach.com:443   ── once
    HTTP/1.1 or 2 keep-alive

  per agent run:
    dataSource.callTool('execute_analytics_eql', ...)
      → POST /mcp with JSON-RPC body                      ── same socket
      ← 200 + JSON-RPC response

    dataSource.callTool('execute_analytics_eql', ...)
      → POST /mcp with JSON-RPC body                      ── same socket
      ← 200 + JSON-RPC response

    … 6-10 calls per investigation, ~1.1s apart …

  end of request:
    dispose() — no-op for Bloomreach (see lib/data-source/index.ts:98)
    socket eventually closed by undici's idle timeout
```

The connection is *not* pooled across requests today. Each route invocation calls `makeDataSource(...) → connectMcp(sid) → client.connect(transport)`, which means a fresh TCP/TLS handshake per route invocation. The OAuth tokens persist via the cookie store, but the socket doesn't. That's a real cost — ~1-2 round trips per request for TLS — and it's called out in the audit (`08-networking-red-flags-audit.md`).

Inside one request, though, the saving is real: an investigation that makes 6 Bloomreach calls only pays the handshake once.

#### Wire 3 — Anthropic, fully pooled by undici

The `@anthropic-ai/sdk` Client doesn't own its connection — it calls `fetch`. On Node, `fetch` is undici's, which keeps an HTTP keep-alive pool per origin. So when the route calls `anthropic.messages.stream({ ... })` twice in a row (once for the diagnostic agent, once for the recommendation agent), undici reuses the same TCP/TLS connection.

```
  Wire 3 — undici's pool, transparent

  first messages.create:
    fetch('https://api.anthropic.com/v1/messages')
      → undici checks pool → no idle connection
      → open TCP/TLS                                  ── pay handshake
      → POST /v1/messages
      ← stream chunks (Anthropic's internal SSE)
      → on completion: return socket to pool

  second messages.create:
    fetch('https://api.anthropic.com/v1/messages')
      → undici checks pool → IDLE socket found
      → reuse                                          ── no handshake
      → POST /v1/messages
```

The app doesn't tune this. The defaults are reasonable for this volume.

#### What happens at the OS / runtime layer the app code can't see

  - **Connection pool size:** undici's default is ~256 sockets per origin, per pool. The app maintains exactly two upstream origins. Nowhere close to a limit.
  - **TCP keep-alive vs HTTP keep-alive:** HTTP keep-alive (the `Connection: keep-alive` header in HTTP/1.1, implicit in HTTP/2) keeps the TCP connection open between requests. TCP keep-alive (the kernel-level probe that detects half-open connections) is separate and not configured here.
  - **TCP NoDelay (Nagle):** undici sets `noDelay: true` by default. Means small writes (like a single NDJSON line) don't wait to be batched into a larger TCP segment. Good for the streaming use case — each `controller.enqueue` flushes promptly.

#### Why not UDP, QUIC, raw sockets

  - **UDP** would buy datagram delivery without ordering or retransmission — the wrong shape for "deliver this JSON-RPC payload reliably."
  - **QUIC / HTTP/3** runs on UDP and gets you faster handshakes + multiplexing. Whatever Vercel's edge negotiates with modern browsers may already be HTTP/3 on wire 1; the app doesn't see or configure it.
  - **Raw sockets** would mean re-implementing TLS, HTTP, redirects, retries — a non-starter for an app whose value is the AI logic on top.
  - **Unix domain sockets** would matter for in-process IPC, which this app doesn't do (the retired Olist subprocess used stdio, not even sockets).

### Move 3 — the principle

The connection-lifecycle question is downstream of the *interaction pattern*. A streaming UX wants one long-lived socket (wire 1). An RPC-style integration wants short calls on a persistent socket (wire 2). A request-response API wants a pool (wire 3). Each wire here picked its lifetime by picking its pattern, and the TCP behavior fell out. The mistake to avoid is the inverse: choosing a transport because it's "modern" and then bolting on a pattern that doesn't fit.

## Primary diagram

```
  All three wires' connection lifetimes

  ┌─ Browser ────────────────────────────────────────────────────┐
  │   one TCP/TLS connection to the page origin                  │
  │   ────────────────────────────────────────────►  ~30s        │
  │   GET /api/briefing  →  many NDJSON lines  →  FIN            │
  └──────────────────────────────────────────────────────────────┘
                            │
                            ▼
  ┌─ Route handler (per request) ───────────────────────────────┐
  │                                                              │
  │   wire 2 — Bloomreach MCP                                    │
  │   open ──► call ──► call ──► call ──► (request ends) close  │
  │            ~1.1s    ~1.1s    ~1.1s    (no pool across reqs) │
  │                                                              │
  │   wire 3 — Anthropic                                         │
  │   pool ──► msgs.create ──► pool ──► msgs.create  (reused)    │
  │   (undici keep-alive across requests)                        │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

The thing this guide deliberately doesn't dramatize: the Bloomreach connection NOT being pooled across requests is a real cost, but a small one in absolute terms — one extra handshake per route invocation, maybe ~150ms total. At the volumes this app sees (one user, occasional briefings), it's far below the noise floor of the 300s budget. The real reason it matters is that the *architecture* (per-request `connectMcp`) means every request runs the OAuth-state-load + handshake, which is also why the cookie-backed auth store matters so much — the alternative would mean redoing the whole OAuth flow per request, not just the TCP handshake.

If this app ever needs to handle real concurrency (many users, many simultaneous briefings), pooling MCP connections per session would be the second optimization, after pooling the OAuth state into a shared store (Redis/KV). The shape of the change is already half-anticipated by the comments at the top of `connect.ts`: "In-memory persistence (auth.ts authStore) works ONLY within a single Node process. Vercel's ephemeral functions may lose the PKCE verifier / client info between the connect request and the callback request; a shared store (KV/Redis) is the likely production fix."

## Interview defense

**Q: Why does the streaming response stay open so long?**

```
   open
   │
   ├── Anthropic call #1 (~1-3s)
   ├── Bloomreach call #1 (~500ms + 1.1s spacing)
   ├── Anthropic call #2
   ├── Bloomreach call #2
   ├── … (loop) …
   ├── enqueue NDJSON line for each event in real time
   │
   ▼
   close  (~30s total)
```

Because the socket IS the streaming surface. Closing it earlier would mean the trace stops mid-stream. The route's `controller.close()` at the end of the `try/finally` is the only place that fires.

**Q: What's the load-bearing connection-lifecycle decision in the repo?**

Keeping wire 1's response open for the whole agent run. Everything else (Bloomreach pool, Anthropic pool) is delegated to a runtime/SDK and is fine on defaults. The streaming response is the one place the app code is consciously holding a socket open.

**Q: What would change if you needed 1000 concurrent users?**

Two things. First: pool the Bloomreach connections per session in a shared cache (Redis or Vercel KV) so a request doesn't redo TCP/TLS every time. Second: move the OAuth cookie store into a shared cache too (it's already designed for swap-out — the `AsyncLocalStorage` store is the seam). Neither requires changing the wire shape; both raise the throughput ceiling for the same shape.

## See also

  - `04-tls-and-trust-establishment.md` — for what the handshake on each connection actually does.
  - `06-websockets-sse-streaming-and-realtime.md` — for the long-lived response in detail (what gets enqueued, how it's parsed).
  - `07-timeouts-retries-pooling-and-backpressure.md` — for how the route bounds a single Bloomreach call against the open connection's budget.

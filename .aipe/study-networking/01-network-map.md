# 01 · Network map

## Subtitle

The wire topology (the three boundaries) — Project-specific.

## Zoom out, then zoom in

The whole product is three boxes talking over HTTPS. That's it. No internal services, no peer-to-peer, no broker. Once you see the three boxes, every networking decision in the rest of this guide is a property of one of them.

```
  Zoom out — the entire wire surface

  ┌─ UI layer ─────────────────────────────────────────────────────┐
  │   Browser:  React 19 + Next 16 client                           │
  │   pages: /, /investigate/[id], /investigate/[id]/recommend      │
  │   hooks: useBriefingStream, useInvestigation, useDemoCapture    │
  └────────────────────────────┬───────────────────────────────────┘
                               │   ★ wire 1 ★
                               │   HTTPS · same-origin · NDJSON
                               ▼
  ┌─ Service layer (this is where the wire surface lives) ─────────┐
  │   Next.js route handlers (Node runtime, Vercel)                 │
  │   /api/briefing  /api/agent  /api/mcp/{call,tools,reset,...}    │
  │   maxDuration = 300 (Pro)                                       │
  └──────────────┬─────────────────────────────────┬───────────────┘
                 │ ★ wire 2 ★                     │ ★ wire 3 ★
                 │ HTTPS · OAuth Bearer            │ HTTPS · x-api-key
                 │ MCP over StreamableHTTPClient   │ Anthropic SDK
                 ▼                                 ▼
  ┌─ Provider layer ──────────────┐  ┌─ Provider layer ─────────────┐
  │  loomi-mcp-alpha.bloomreach   │  │  api.anthropic.com           │
  │  .com/mcp  (Bloomreach)       │  │                              │
  └───────────────────────────────┘  └──────────────────────────────┘
```

What we're talking about: the three wires labelled ★. Each one has its own transport choice, its own auth model, its own failure mode. The rest of this guide walks them one at a time; this file just names them and gets the picture into your head.

## Structure pass

  - **Layers** — UI (browser), Service (Next route handlers), Provider (Bloomreach MCP, Anthropic API). Storage is **not** a wire — there's no database; state lives in in-memory maps + cookies + sessionStorage + committed JSON snapshots.
  - **Axis traced — "what kind of HTTP exchange is this?"** Hold that one question across all three wires and the answer flips at each boundary:
      - wire 1 (browser → route): **long-lived response streaming** (one request, many JSON lines back over chunked transfer until the agent finishes).
      - wire 2 (route → Bloomreach MCP): **short-lived RPC** (one tool call, one JSON-RPC response, bounded by a 30s per-call timeout).
      - wire 3 (route → Anthropic): **short-lived RPC** plus an internal SDK-managed stream the route consumes synchronously before emitting its own NDJSON events.
  - **Seams** — three of them, one per wire. Each one carries a contract:
      1. **The NDJSON contract** (`AgentEvent` in `lib/mcp/events.ts:4-12`) — the union type both `/api/briefing` and `/api/agent` write and both `useBriefingStream` + `useInvestigation` read. The most load-bearing seam in the repo.
      2. **The MCP protocol** (JSON-RPC 2.0 over HTTP, via `@modelcontextprotocol/sdk`) — the route doesn't speak HTTP directly to Bloomreach; the SDK does.
      3. **The Anthropic SDK** — same shape: the route doesn't speak HTTP directly to api.anthropic.com; `@anthropic-ai/sdk` does.

The interesting thing about this axis-trace: only ONE of the three wires is the long-lived stream the user actually experiences as "the AI is thinking." The other two are short, synchronous round-trips inside the route handler. The streaming feeling is entirely on wire 1.

## How it works

### Move 1 — the mental model

Think of it like a `fetch()` on the client and a `fetch()` on the server, with the server's `fetch()` calling another server's `fetch()`. The browser makes ONE long request to the route; the route makes MANY short requests to Bloomreach and Anthropic; the route streams a transformed result back over the already-open response.

```
  Pattern — one long stream out, many short calls in

  browser ──────long request────────►  route
            ▲                            │
            │                            ├──► Anthropic (short)
            │                            │
            │  many NDJSON lines back    ├──► Bloomreach MCP (short)
            └────────────────────────────┤    Bloomreach MCP (short)
                       over the          │    Bloomreach MCP (short)
                       single open       │    … 1.1s spacing between
                       response          │
                                         ▼
                                       send 'done' line, close stream
```

The browser's HTTP request never closes until the agent loop is done. The route writes one JSON line into the response body every time the agent emits a reasoning step, starts a tool call, finishes a tool call, or produces an insight. The browser parses one line at a time and updates state. That's the entire interaction model.

### Move 2 — the step-by-step walkthrough

#### Wire 1 — browser to Next.js route (the streaming wire)

Same-origin HTTPS. Always a GET. The route returns a `ReadableStream<Uint8Array>` with `Content-Type: application/x-ndjson; charset=utf-8` and `Cache-Control: no-store, no-transform` so Vercel's edge doesn't try to buffer or recompress the stream.

```
  Layers-and-hops — wire 1

  ┌─ Browser ─────────────────┐                 ┌─ Vercel edge ────┐
  │  fetch('/api/briefing')   │ ──── HTTPS ──► │  TLS termination  │
  │  res.body.getReader()     │      GET        │  routes /api/*    │
  │  TextDecoder + split('\n')│                 │  to handler       │
  └───────────────────────────┘                 └─────────┬─────────┘
                                                          │ HTTP
                                                          │ (internal)
                                                          ▼
                                                ┌─ Node runtime ───┐
                                                │  briefing/route  │
                                                │  ReadableStream  │
                                                │  controller.enqueue
                                                │  ('insight\n')   │
                                                └──────────────────┘
```

The actual code that owns the read side is the briefing-stream hook (`useBriefingStream`):

```ts
// lib/hooks/useBriefingStream.ts:158, 288
const res = await fetch(url);                                      // ← opens the long-lived stream
// …
await readNdjson<BriefingEvent>(res.body, handle,                  // ← parses line-by-line
  { cancelOn: () => cancelledRef.current });                       // ← polled between reads
```

And the write side is the route's `ReadableStream`:

```ts
// app/api/briefing/route.ts:191-194
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const send = (e: BriefingEvent) =>
      controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));  // ← one event = one line
```

The fact that this is HTTPS — not WebSocket, not SSE — is a deliberate choice. See `06-websockets-sse-streaming-and-realtime.md` for why.

#### Wire 2 — Next.js route to Bloomreach MCP

HTTPS to `https://loomi-mcp-alpha.bloomreach.com/mcp` (`lib/mcp/connect.ts:30-34`). The MCP SDK's `StreamableHTTPClientTransport` wraps this. From the route's perspective, you call `client.callTool(...)` and a Promise resolves with the result — under the hood it's a POST with an OAuth Bearer header and a JSON-RPC 2.0 body.

```
  Layers-and-hops — wire 2

  ┌─ Node runtime ──────────────┐               ┌─ Bloomreach ─────┐
  │ dataSource.callTool('...')  │  HTTPS POST   │ loomi-mcp-alpha  │
  │ ↓                           │ ─────────────►│ .bloomreach.com  │
  │ BloomreachDataSource        │ Bearer token  │ /mcp             │
  │ ↓ ~1.1s spacing             │ JSON-RPC body │                  │
  │ SdkTransport                │ ◄─────────────│ JSON-RPC reply   │
  │ ↓ 30s AbortSignal.timeout   │ 200 / 401 /   │                  │
  │ MCP SDK Client              │ 429           │                  │
  │ ↓ capturing fetch wrapper   │               │                  │
  │ global fetch (undici)       │               │                  │
  └─────────────────────────────┘               └──────────────────┘
```

Two things worth noting on this wire:

  - **The fetch wrapper is custom.** `makeCapturingFetch` (`lib/mcp/transport.ts:103`) is passed as the SDK's `fetch` option so the route can record the raw body of any non-OK response into a holder, redact bearer tokens, and attach the real server error to the thrown `McpToolError`. The SDK otherwise surfaces only a generic "Unauthorized."
  - **There's no connection pool the app tunes.** The MCP SDK opens its own persistent HTTPS connection per session; the Node `fetch` global delegates to undici's default keep-alive pool. Both are good defaults for this volume.

#### Wire 3 — Next.js route to Anthropic

HTTPS to `api.anthropic.com` via the `@anthropic-ai/sdk` Client. The SDK handles auth (the `ANTHROPIC_API_KEY` env var becomes an `x-api-key` header), retries, and streaming. The route uses the SDK's streaming response API internally inside `runAgentLoop` (`lib/agents/base.ts`) to get model output token-by-token, but the route transforms that into its own NDJSON events before writing them onto wire 1.

```
  Layers-and-hops — wire 3

  ┌─ Node runtime ──────────────┐               ┌─ Anthropic ──────┐
  │ runAgentLoop in base.ts     │  HTTPS POST   │ api.anthropic    │
  │ ↓                           │ ─────────────►│ .com             │
  │ anthropic.messages.stream() │ x-api-key     │ /v1/messages     │
  │ ↓                           │ JSON body     │                  │
  │ SDK reads its own SSE       │ ◄─────────────│ event-stream     │
  │ stream from Anthropic       │ chunked       │ (Anthropic's     │
  │ (internal — not on our wire)│               │  internal SSE)   │
  └─────────────────────────────┘               └──────────────────┘
```

Note: Anthropic's own response IS Server-Sent Events; the SDK consumes it on the route's behalf. That SSE never reaches the browser — by the time bytes hit wire 1, the route has re-shaped them into the `AgentEvent` NDJSON contract.

#### The three wires together

```
  All three wires, one timeline

  t=0     browser fetch('/api/briefing')
          ↓
  t=0.1s  route accepted; starts the stream
          ├──► wire 3: Anthropic message #1 (with tool definitions)
          │    ◄── tool_use response: "call execute_analytics_eql(...)"
          ├──► wire 1: enqueue 'tool_call_start' line
          ├──► wire 2: Bloomreach callTool(execute_analytics_eql, ...)
          │    ◄── result
          ├──► wire 1: enqueue 'tool_call_end' line
          ├──► wire 3: Anthropic message #2 (with tool result)
          │    ◄── more tool_use OR a final text block
          ├──► wire 1: enqueue 'reasoning_step' line(s)
          │    (loop until the agent stops calling tools)
          ├──► wire 1: enqueue 'insight' line for each anomaly
          └──► wire 1: enqueue 'done' line; close stream
  t=~30s  browser sees 'done'; renders the feed
```

One open browser request, many short server-to-server calls, one stream of NDJSON events out.

### Move 3 — the principle

A streaming product is not "the network is open both ways the whole time." It's "one HTTP response is open one way for a long time, and we never broke it." Everything the user perceives as real-time is happening because a single fetch stays open while the server does the slow work and writes intermediate results into the response body. The choice of NDJSON over SSE or WebSocket is downstream of that.

## Primary diagram

```
  The full network surface — one frame

  ┌────────────────────────────────────────────────────────────────────┐
  │                          UI LAYER                                  │
  │  ┌─ browser ──────────────────────────────────────────────────┐    │
  │  │  useBriefingStream  →  fetch('/api/briefing')              │    │
  │  │  useInvestigation   →  fetch('/api/agent?...')             │    │
  │  │  StreamingResponse  →  fetch('/api/agent?q=...')           │    │
  │  │                     all consume NDJSON via readNdjson()    │    │
  │  └────────────────────────────────────────────────────────────┘    │
  └──────────────────────────────┬─────────────────────────────────────┘
                                 │  wire 1: HTTPS same-origin
                                 │          fetch + ReadableStream
                                 │          NDJSON down, GET up
                                 │          bi_session cookie
                                 ▼
  ┌────────────────────────────────────────────────────────────────────┐
  │                       SERVICE LAYER                                │
  │  ┌─ Next.js route handlers (Vercel, Node runtime) ────────────┐    │
  │  │  /api/briefing      maxDuration = 300                      │    │
  │  │  /api/agent         maxDuration = 300                      │    │
  │  │  /api/mcp/callback  /api/mcp/reset  /api/mcp/call          │    │
  │  │                                                            │    │
  │  │  ReadableStream<Uint8Array> writers · Content-Type: ndjson │    │
  │  │  Cache-Control: no-store/no-cache, no-transform            │    │
  │  └─────────────┬─────────────────────────────────┬────────────┘    │
  └────────────────┼─────────────────────────────────┼─────────────────┘
                   │ wire 2                          │ wire 3
                   │ HTTPS · OAuth Bearer            │ HTTPS · x-api-key
                   │ MCP over JSON-RPC 2.0           │ Anthropic SDK
                   │ via @modelcontextprotocol/sdk   │ via @anthropic-ai/sdk
                   │ 30s AbortSignal.timeout         │ SDK-managed
                   │ 1.1s proactive spacing          │
                   ▼                                 ▼
  ┌──────────────────────────────────┐  ┌──────────────────────────────┐
  │           PROVIDER LAYER          │  │       PROVIDER LAYER         │
  │  loomi-mcp-alpha.bloomreach.com   │  │  api.anthropic.com           │
  │  /mcp                             │  │  /v1/messages (SSE in)       │
  └──────────────────────────────────┘  └──────────────────────────────┘
```

## Elaborate

The three-wire topology is a direct consequence of the product's pitch — "an analyst that shows its work." The streaming on wire 1 is not a performance optimization; it's the surface. Users see the agent thinking because the response body is the trace. Take wire 1 out and the product collapses to "wait 30 seconds, see a list of insights" — same data, no story.

The two server-to-server wires (2 and 3) are the data layer. Bloomreach owns the workspace data; Anthropic owns the reasoning. The route is the choreographer that asks Anthropic what to ask Bloomreach, runs the calls, feeds the results back to Anthropic, and writes the running narrative out to the browser.

What this map deliberately does NOT show: any internal services, any queues, any caches besides the in-process `Map` in `BloomreachDataSource` (`lib/data-source/bloomreach-data-source.ts:122`), any background workers, any databases. The architecture is intentionally three boxes. When you read the rest of the guide, the question is always "which of the three wires does this property belong to?"

## Interview defense

**Q: Walk me through what happens when a user opens the feed and clicks 'live.'**

```
  user clicks 'live'
      ↓
  useBriefingStream.useEffect fires (mode = 'live-bloomreach')
      ↓
  fetch('/api/briefing?mode=live-bloomreach')  — wire 1 opens
      ↓
  route: getOrCreateSessionId() → sets bi_session cookie if absent
      ↓
  route: makeDataSource('live-bloomreach', sid)
      → connectMcp(sid) → withAuthCookies → reads bi_auth cookie
      → if no tokens: returns {ok:false, authUrl} → 401 JSON to browser
      → browser redirects to authUrl (Bloomreach IdP), eventually
        returns to /api/mcp/callback (cross-site, SameSite=None cookie
        survives the redirect)
      ↓
  route: opens ReadableStream, enqueues NDJSON line per event
      → many short wire-2 calls (Bloomreach) and wire-3 calls (Anthropic)
      → each maps to a 'tool_call_start' / 'reasoning_step' / 'insight' line
      ↓
  route: enqueue 'done', close stream
      ↓
  browser: readNdjson resolves, status flips to 'loaded'
```

**Anchor:** three wires; wire 1 stays open the whole time, wires 2 and 3 are short bursts inside.

**Q: Why not WebSockets?**

The traffic is one-directional (agent → browser). WebSocket buys you bidirectional + framing on top of TCP; you'd pay for both without using either. Fetch streaming gives you the unidirectional half for free, riding the existing HTTP/2 connection the page already established. Plus: every middleware you have works (auth cookies, gzip, edge caching opt-outs); WebSockets force you to re-solve those.

**Q: What's the load-bearing piece of this map?**

The NDJSON contract on wire 1 (`AgentEvent` in `lib/mcp/events.ts`). It's the only place the browser and the route agree on what they're saying to each other. Both `/api/briefing` and `/api/agent` write it; both `useBriefingStream` and `useInvestigation` read it. Drop or break it and the whole streaming surface goes dark.

## See also

  - `05-http-semantics-caching-and-cors.md` — for the HTTP details (status codes, cookies, cache directives) on each wire.
  - `06-websockets-sse-streaming-and-realtime.md` — for the deep walk on wire 1's NDJSON streaming.
  - `07-timeouts-retries-pooling-and-backpressure.md` — for the timeout + retry behavior on wire 2.
  - `04-tls-and-trust-establishment.md` — for the OAuth handshake on wire 2.

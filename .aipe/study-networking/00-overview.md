# Networking — overview

Three wire surfaces, one protocol family (HTTPS), one streaming kernel (NDJSON over fetch). That's it. No WebSockets, no SSE, no Server-Sent Events, no stdio IPC, no peer-to-peer. If something runs in this repo, it rides one of these three pipes.

## The repo, on the wire

```
  Three wire surfaces — the entire network surface area

  ┌─ Browser (the feed + the investigate pages) ──────────────────┐
  │   useBriefingStream  /  useInvestigation  /  useDemoCapture   │
  └─────────────────┬─────────────────────────────────────────────┘
                    │  HTTPS · same-origin · fetch + ReadableStream
                    │  bi_session cookie · NDJSON response
                    ▼
  ┌─ Next.js route handlers (/api/briefing · /api/agent · /api/mcp/*) ┐
  │   maxDuration = 300s on the long-running ones                    │
  └──────┬─────────────────────────────────────────┬──────────────────┘
         │ HTTPS · Bearer token                    │ HTTPS · x-api-key
         │ StreamableHTTPClientTransport           │ Anthropic SDK
         │ OAuth 2.1 + PKCE + DCR                  │
         ▼                                         ▼
  ┌─ Bloomreach loomi connect MCP ─────────┐  ┌─ Anthropic API ──────┐
  │  loomi-mcp-alpha.bloomreach.com/mcp     │  │  api.anthropic.com   │
  └─────────────────────────────────────────┘  └──────────────────────┘
```

Three boundaries: browser-to-Next, Next-to-Bloomreach, Next-to-Anthropic. The first one is the surface the user touches; the other two are server-to-server. All three are TLS-protected, all three use HTTP semantics (methods, status codes, headers), and exactly one of them speaks a long-lived stream — the first one, where the route streams NDJSON back to the page.

## What carries the weight

The single most consequential mechanism on the wire is the **NDJSON-over-fetch stream** from `/api/briefing` and `/api/agent` to the browser. It is what makes the product feel real-time — the agent's thinking trace, tool calls, and insights ship over a long-lived HTTP response, one JSON object per line, parsed in the browser by `readNdjson` (`lib/streaming/ndjson.ts:17`). Not WebSocket, not SSE — just chunked-transfer-encoded HTTP that never ends until the agent does.

The second is the **transport-level timeout** (`lib/mcp/transport.ts:38`). A 30s per-call `AbortSignal.timeout`, composed with the route's client-cancel signal via `composeSignals` (`lib/mcp/transport.ts:173`), so one stuck Bloomreach call can't burn the whole 300s Vercel budget. This is the load-bearing piece of the timeout story; everything else (the 1.1s rate-limit spacing, the 10s parsed-window retry, the 60s response cache) hangs off it.

The third is the **encrypted token cookie** (`bi_auth`) at `lib/mcp/auth.ts:48`. AES-256-GCM-encrypted, httpOnly, SameSite=None, Secure — it carries the OAuth/PKCE state across the Bloomreach IdP round-trip because Vercel's ephemeral functions can't share in-memory state across the connect and callback requests. Cross-site cookies that need to survive a redirect from an external IdP are a pinch-point in modern browser policy; this repo handles it correctly and is worth reading as a reference.

## Ranked findings — read these first

  1. **NDJSON, not SSE.** The repo deliberately uses NDJSON over a fetch `ReadableStream` rather than EventSource/SSE. EventSource is one-shot, auto-reconnects, can't send POST headers, and forces UTF-8 text framing — all wrong for this app. Fetch streaming gives you a single bidirectional handshake, full header control, abortability via `AbortSignal`, and a binary-safe transport. See `06-websockets-sse-streaming-and-realtime.md`.

  2. **Per-call AbortSignal composition is the budget governor.** The 30s `TOOL_TIMEOUT_MS` at `lib/mcp/transport.ts:38` is what stops one hung Bloomreach call from eating the whole 300s `maxDuration`. Composed via `composeSignals` at line 173 with the route's `req.signal`. Without this, the user-visible failure mode would be a 300s-blank-screen-then-500. See `07-timeouts-retries-pooling-and-backpressure.md`.

  3. **AES-256-GCM cookie that survives a cross-site IdP round-trip.** `bi_auth` at `lib/mcp/auth.ts:48-103` is SameSite=None + Secure, encrypted with a key derived from `AUTH_SECRET`, and seeded into an `AsyncLocalStorage` once per request to dodge Next's request-vs-response cookie split. This is the canonical correct shape for stateless-edge OAuth state. See `05-http-semantics-caching-and-cors.md`.

  4. **Same-origin only — no CORS surface in app code.** All browser-side fetches target `/api/*` on the same origin. No `Access-Control-Allow-Origin` headers anywhere in `app/` or `lib/` (only in `node_modules`). The CORS rule that fires is the implicit "same-origin requests skip preflight." See `05-http-semantics-caching-and-cors.md`.

  5. **The Bloomreach rate-limit retry ladder is parsed, not guessed.** `parseRetryAfterMs` (`lib/data-source/bloomreach-data-source.ts:64`) reads the server's stated penalty window out of the error envelope ("rate limit reached (1 per 10 second)"), waits that exact duration + 500ms cushion, and retries. Falls back to exponential backoff if the message is unparseable. See `07-timeouts-retries-pooling-and-backpressure.md`.

  6. **OAuth 2.1 + Dynamic Client Registration + PKCE** — three pieces working together (`lib/mcp/connect.ts:76-127`, `lib/mcp/auth.ts:160-218`). No pre-registered `client_id`; the SDK registers a public client on first connect per host. Each preview deploy gets its own registration because the redirect URI is derived from the actual request host (`x-forwarded-host`), so any Vercel preview alias can complete OAuth. See `04-tls-and-trust-establishment.md`.

## Reading order

```
  01 → 02 → 03 → 04 → 05 → 06 → 07 → 08
  map   names  conns  TLS    HTTP   stream timeout audit
```

Start at `01-network-map.md` for the wire-level skeleton. Each subsequent file zooms into one layer of the stack. The audit file (`08`) ranks the protocol/network-failure risks in order of consequence — read it last with the rest as context.

## Not yet exercised

These are the parts of "networking" the repo does not currently touch. They're listed not as a TODO but so you don't go looking for them in the codebase:

  - **WebSockets.** No `WebSocket` constructor in app code; no `ws://` or `wss://` URLs. The streaming need is one-directional (agent → browser), so a unidirectional NDJSON response covers it.
  - **Server-Sent Events / EventSource.** Same reason — the repo chose fetch-streaming over SSE for header control, abortability, and binary safety.
  - **HTTP/2 push, HTTP/3, QUIC.** Whatever Vercel's edge negotiates; not configured or exercised by app code.
  - **Connection pooling for outbound HTTPS.** The Node `fetch` global on the server uses undici's keep-alive pool by default; the app doesn't tune it. The MCP SDK transport opens one persistent HTTPS connection per session via `StreamableHTTPClientTransport`.
  - **DNS caching, custom resolvers, DoH/DoT.** Default Node resolver, default Vercel edge resolver. Not exercised in app code.
  - **Backpressure between the route writer and the browser reader.** The `ReadableStream` controller used in `/api/briefing` and `/api/agent` does not check `controller.desiredSize` before enqueuing; the runtime buffers. Acceptable for this app's volumes (one investigation produces tens of events) but called out in the audit.
  - **Proxies, custom edge layers, CDN cache rules.** Whatever Vercel terminates; the app does not configure them. The two streaming routes do set `Cache-Control: no-store/no-cache, no-transform` (`app/api/briefing/route.ts:149,333`, `app/api/agent/route.ts:107`) to prevent intermediaries from buffering or recompressing the stream.
  - **Retries from the browser to the route.** No automatic retry on a 5xx; the page surfaces the error and waits for the user (or the reconnect policy at `lib/hooks/useReconnectPolicy.ts` for the auth-shaped subset).

## See also

  - `.aipe/study-security/` — for the trust-boundary version of these same surfaces (what each side can see/tamper with).
  - `.aipe/study-system-design/` — for where the boundaries belong in the overall architecture.
  - `.aipe/study-distributed-systems/` — for the partial-failure version of the timeout/retry story.

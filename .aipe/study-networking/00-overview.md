# Study — Networking (applied)

## The wire, in this repo

Three things actually move over the network in blooming insights, and only three. Naming them up front so the rest of the guide isn't a tour of imagined infrastructure:

1. **Browser ↔ this app's API routes** (`/api/briefing`, `/api/agent`, `/api/mcp/*`) over HTTPS. The response body is either plain JSON (auth + small endpoints) or **NDJSON over HTTP chunked transfer** for the long-running agent runs.
2. **This app's serverless functions ↔ Bloomreach MCP** (`https://loomi-mcp-alpha.bloomreach.com/mcp/`) over HTTPS via `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk@1.29.0`. Auth is OAuth 2.1 + PKCE + Dynamic Client Registration (RFC 7591).
3. **This app's serverless functions ↔ Anthropic API** (`api.anthropic.com`) over HTTPS via the official `@anthropic-ai/sdk@0.99.0`. Used by every agent run inside `/api/briefing` and `/api/agent`.

That's the entire wire surface. No realtime transport (no WebSocket, no SSE, no gRPC), no service mesh, no internal RPC, no message queue, no second backend. The "system" is one Next.js 16 app talking to two upstreams.

```
System map — every network boundary that actually exists

┌─ Browser ───────────────────────────────────────────────────────────────┐
│  app/page.tsx · lib/hooks/useInvestigation.ts                            │
│  fetch() + response.body.getReader()  (HTTP/1.1 or HTTP/2 over TLS)      │
└─────────────────────────┬───────────────────────────────────────────────┘
                          │  hop 1: HTTPS · GET /api/briefing,
                          │         /api/agent?…  (NDJSON streamed back)
                          │         POST /api/mcp/call, /api/mcp/reset
                          ▼
┌─ Next.js route handlers (serverless on Vercel) ─────────────────────────┐
│  app/api/briefing/route.ts · app/api/agent/route.ts                      │
│  ReadableStream → controller.enqueue(NDJSON line) per event              │
│  Auth state: encrypted bi_auth cookie (AES-256-GCM, httpOnly, Secure)    │
└────────────┬─────────────────────────────────────────┬──────────────────┘
             │                                          │
   hop 2a: HTTPS · POST /mcp/                hop 2b: HTTPS · POST /v1/messages
   Streamable HTTP (MCP SDK)                  (Anthropic SDK)
   OAuth 2.1 Bearer (DCR + PKCE)              Bearer ANTHROPIC_API_KEY
             │                                          │
             ▼                                          ▼
┌─ Bloomreach Loomi MCP (alpha) ──┐    ┌─ Anthropic API ──────────────────┐
│  loomi-mcp-alpha.bloomreach.com │    │  api.anthropic.com               │
│  rate limit: 1 req per 10s      │    │  (model: claude-*; tool use)     │
│  per-user, GLOBAL window        │    │                                  │
└──────────────────────────────────┘    └──────────────────────────────────┘
```

## Verdict-first ranking

What's load-bearing here, ordered by consequence:

  1. **The Bloomreach rate-limit dance is the entire shape of the upstream contract.** Bloomreach's loomi MCP alpha enforces a per-user GLOBAL window (`1 per 10 second` observed). The whole client (`lib/mcp/client.ts`) is built around it: 1.1 s proactive spacing, parse the retry hint out of the 429 body text, exponential fallback to 10 s, ceiling at 20 s, max 3 retries, plus a 60 s in-process response cache. Every other networking choice in this repo is downstream of "we have ~1 req/s to spend per investigation."

  2. **NDJSON over a `ReadableStream` is the only realtime transport.** Both long routes (`/api/briefing`, `/api/agent`) write `JSON.stringify(e) + '\n'` per event into a Next.js `ReadableStream`. No SSE, no WebSocket. The browser uses `fetch` + `response.body.getReader()` + a `buf.split('\n'); buf = lines.pop()` line-buffering reassembly. The HTTP semantics that matter: `Content-Type: application/x-ndjson; charset=utf-8`, `Cache-Control: no-cache, no-transform` (the `no-transform` keeps Vercel's edge from buffering or gzip-rechunking), `maxDuration = 300` to fit the run inside Vercel Pro's window.

  3. **OAuth 2.1 + PKCE + Dynamic Client Registration** is the entire auth handshake to Bloomreach. No pre-registered client; `token_endpoint_auth_method: 'none'` (public client). The redirect URI is derived from `x-forwarded-host` on each request so preview deployments and the production alias both work without re-registering. PKCE verifier + DCR client info must survive the cross-site OAuth round-trip — in production, the encrypted `bi_auth` cookie (AES-256-GCM under `AUTH_SECRET`) is the only state both the `connect` request and the `callback` request can see, because Vercel's serverless instances are ephemeral.

  4. **TLS everywhere by default, no termination in our code.** Both upstreams are HTTPS-only; the Next.js app is served over HTTPS in production (Vercel). The auth + session cookies are `Secure`, `httpOnly`, `SameSite=None` in production (lax + non-secure on localhost). The app does not run its own TLS terminator, does not pin certs, does not load custom CAs — it trusts the platform's TLS stack and the system trust store.

  5. **Connections are short-lived and unpooled.** Every `fetch` from the route handler to Bloomreach or Anthropic uses Node's global undici agent with default keep-alive and default pool size. There is no per-upstream pool configuration, no `Agent({ keepAliveMsecs })`, no explicit connection reuse. With ~1 req/s to Bloomreach and bursty calls to Anthropic, this works — but it is *unmeasured* and `not yet exercised` at higher load.

## Reading order

Read in order; each file leans on what came before.

  1. **`01-network-map.md`** — the full on-the-wire path: browser, serverless boundary, both upstreams, every hop named and labelled.
  2. **`02-dns-routing-and-addressing.md`** — name resolution and origin selection (Vercel's edge, `BLOOMREACH_MCP_URL`, `api.anthropic.com`). Short, because we delegate most of this.
  3. **`03-tcp-udp-connections-and-sockets.md`** — transport layer: HTTP over TCP, what `fetch` does at the socket level, no explicit pooling.
  4. **`04-tls-and-trust-establishment.md`** — encryption in transit, where it terminates, what's encrypted at rest in the cookie.
  5. **`05-http-semantics-caching-and-cors.md`** — methods, status codes, cookie semantics (the `bi_session` + `bi_auth` pair, `SameSite=None`), `Cache-Control: no-cache, no-transform`, no CORS surface.
  6. **`06-websockets-sse-streaming-and-realtime.md`** — what realtime actually means here: NDJSON over chunked HTTP, why not SSE/WebSocket, where the boundary is.
  7. **`07-timeouts-retries-pooling-and-backpressure.md`** — the rate-limit playbook (the load-bearing pattern in this repo) plus the absence of an explicit timeout / pool / backpressure layer.
  8. **`08-networking-red-flags-audit.md`** — ranked risks, with the evidence for each.

## What this repo does NOT exercise (and the file's verdict)

Honest about absence — if you reach for it from training data, it's not here.

  → **Realtime transports** beyond NDJSON over chunked HTTP. No SSE (`EventSource`), no WebSocket, no WebTransport, no gRPC/HTTP-2 streaming primitives, no Server Push. `06-websockets-sse-streaming-and-realtime.md` covers this and says when each would be the right move.
  → **DNS caching** at the application layer. Whatever Node's resolver / the platform does is what we get. `02-dns-routing-and-addressing.md` calls this out.
  → **Connection pool configuration.** No `undici.Agent({ connections, keepAliveMsecs })`, no per-upstream pool. We use the global default. `03-tcp-udp-connections-and-sockets.md` and `07-timeouts-retries-pooling-and-backpressure.md` both name this as `not yet exercised`.
  → **Explicit per-request timeouts.** No `AbortController`+`signal` on the upstream `fetch` calls. The only timeout in play is Vercel's `maxDuration = 300` on the route, which kills the whole function — there is no per-call escape hatch.
  → **CORS surface.** Every browser → API call is same-origin. No `Access-Control-Allow-Origin` headers are set anywhere in the app.
  → **Cert pinning, custom CAs, mTLS, or proxy support.** Plain TLS via the platform trust store.
  → **Multi-region routing, load balancing, sticky sessions, request collapsing/de-duplication, or circuit breakers.** The in-process Map cache in `McpClient` is the closest thing to request collapsing — and it's per-instance, not shared across Vercel cold starts.

## Cross-links — what lives elsewhere

  → **NDJSON framing details** (how `buf.split('\n')` reassembles lines across TCP chunks, why `lines.pop()` is load-bearing) live in `../study-system-design-dsa/01-system-design/05-streaming-ndjson.md`. This guide covers the HTTP semantics that carry that framing — `Content-Type`, `Cache-Control`, the streamed `ReadableStream` lifecycle, the `maxDuration` window — not the line reassembly itself.
  → **Trust boundaries** (what each side can see/tamper with) are the `study-security` guide's territory; this guide names which bytes cross which boundary, not whether crossing it is safe.
  → **Where the seams *belong*** in the architecture (would you put rate-limit logic in a gateway? in a queue?) is the `study-system-design` guide's territory.

## Top 3 networking risks (full evidence in `08-networking-red-flags-audit.md`)

  1. **No per-upstream timeout.** A hung Bloomreach or Anthropic socket consumes the route's full 300 s window. The only safety net is `maxDuration`, which kills the entire investigation — the user sees nothing.
  2. **Rate-limit ceiling can starve the route.** `maxRetries: 3` × `retryCeilingMs: 20_000` = ~60 s of retry budget per single tool call. A single contested call can eat 20% of the route budget; a sequence of two can take 40%.
  3. **DCR + PKCE state in an httpOnly cookie is single-point-of-failure for OAuth.** If the cookie is dropped (browser policy, third-party-cookie restrictions, `SameSite=None` quirks), the OAuth callback cannot find its PKCE verifier and the flow fails with no recovery path other than re-initiating.

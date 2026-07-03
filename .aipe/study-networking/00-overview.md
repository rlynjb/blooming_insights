# study-networking — overview

The question this guide answers: **what actually happens on the wire in this repo, where can it fail, and which protocol semantics does the code rely on?**

You're building a Next.js app that fans out to two upstream HTTPS surfaces per user turn — an MCP server (Bloomreach by default) and the Anthropic API — and streams NDJSON back to the browser over a long-lived response body. That's three wire surfaces, all HTTPS, no WebSockets, no gRPC. This guide walks each of them the way you'd walk a stack: shape first, then mechanics, then failure.

## The wire in one picture

Three hops, three protocols, three failure characters. Every user turn touches all three.

```
  The wire — three surfaces, all HTTPS

  ┌─ Browser (React) ────────────────────────────────────────────┐
  │  useBriefingStream / useInvestigation                        │
  │    fetch(url, { headers: { x-bi-mcp-config } })              │
  │    → readNdjson(res.body, handle)                            │
  └─────────────────────────┬────────────────────────────────────┘
                            │  hop 1: HTTPS · NDJSON stream ·
                            │  cookies (bi_session, bi_auth) ·
                            │  optional x-bi-mcp-config header
                            ▼
  ┌─ Next.js route handler (Vercel Node runtime) ────────────────┐
  │  app/api/{briefing,agent}/route.ts                           │
  │    - decodes config header (fail-safe → env fallback)        │
  │    - opens ReadableStream, writes NDJSON as agent progresses │
  │    - fans out to two upstream HTTPS clients                  │
  └────────────┬────────────────────────────────┬────────────────┘
               │ hop 2                          │ hop 3
               │ HTTPS · MCP JSON-RPC           │ HTTPS · Anthropic
               │ Streamable HTTP transport      │ Messages API
               │ Authorization: Bearer <tok>    │ x-api-key +
               │ per-call AbortSignal(30s)      │ cache_control:
               │                                │ ephemeral
               ▼                                ▼
  ┌─ MCP server (Bloomreach loomi) ─┐  ┌─ Anthropic API ─────────┐
  │  loomi-mcp-alpha.bloomreach.com │  │  api.anthropic.com      │
  │  (or MCP_URL override)          │  │                         │
  └─────────────────────────────────┘  └─────────────────────────┘
```

The route handler is the seam. Every network concern in this repo sits at that middle band: authentication, timeout, retry, cancellation, cache. The browser only sees HTTPS + NDJSON. The upstreams only see one bearer/API-key request at a time.

## What earns a concept file

The spec fixes eight concepts, in this order. Each file uses the full `format.md` template — zoom-out, structure pass, how-it-works with real repo code, primary diagram, elaborate, interview defense, see also.

  1. `01-network-map.md`
     the full on-the-wire path and every network boundary — the browser → route → (MCP, Anthropic) fan-out with header/cookie/token flow named at each hop
  2. `02-dns-routing-and-addressing.md`
     names, addresses, routing, proxies, edge layers, and origin resolution — MCP URL precedence chain, redirect URI derivation from `x-forwarded-host`, Vercel edge in front of the route
  3. `03-tcp-udp-connections-and-sockets.md`
     connections, sockets, transport choices, ordering, lifecycle — Node runtime fetch pooling, Streamable HTTP, per-request lifetime
  4. `04-tls-and-trust-establishment.md`
     encryption in transit, certificates, trust establishment, and termination points — Vercel edge TLS, upstream TLS, no client-side termination
  5. `05-http-semantics-caching-and-cors.md`
     methods, status codes, headers, caching, cookies, CORS, and browser policy — cookie flags (`SameSite=None`, `Secure`, `HttpOnly`), `Cache-Control: no-cache`, no CORS (same-origin), `cache_control: ephemeral` for Anthropic prompt caching, `x-bi-mcp-config` header
  6. `06-websockets-sse-streaming-and-realtime.md`
     long-lived connections, streams, realtime behavior, reconnect logic — NDJSON over `fetch` streaming response (not SSE, not WS), `readNdjson` kernel, `useReconnectPolicy` for revoked-token recovery
  7. `07-timeouts-retries-pooling-and-backpressure.md`
     timeouts, retries, jitter, connection pools, request collapse, and overload — 30s per-call MCP timeout via `AbortSignal.timeout`, 300s route budget, rate-limit retry ladder with parsed retry-after, 60s response cache
  8. `08-networking-red-flags-audit.md`
     ranked protocol and network-failure risks grounded in the repo

## Top-of-mind findings (verdict-first)

Read these before opening the concept files. The full walk lives in `08-networking-red-flags-audit.md`.

  → **The 30s per-call MCP timeout is the strongest single defense you have.**
     `lib/mcp/transport.ts:38, :131` composes `AbortSignal.timeout(30_000)` with the route's own cancel signal via `composeSignals` — whichever fires first cancels the in-flight MCP call. Without this, one stuck Bloomreach call would burn the entire 300s route budget on a single tool call. Naming this timeout — and saying "the retry ladder deliberately does NOT retry it because a retry would just risk another 30s wait inside the same route budget" (transport.ts:34-37) — is the load-bearing part of the timeouts story.

  → **The MCP URL is a preset, not an identity.** The precedence chain in `lib/mcp/connect.ts:38-48` is `override.url` (UI settings modal, per-request header) → `MCP_URL` env → `BLOOMREACH_MCP_URL` env (legacy) → hardcoded `loomi-mcp-alpha.bloomreach.com` default. Bloomreach is what's baked in as a working example; any HTTPS MCP endpoint plugs in via the header or env. Same story for auth: `oauth-bloomreach`, `bearer`, or `anonymous` are three swappable providers behind one `OAuthClientProvider` interface (`lib/mcp/auth-providers/index.ts:56`).

  → **NDJSON over fetch is the streaming choice — not SSE, not WebSockets.** The route opens a `ReadableStream<Uint8Array>` and writes one JSON object per newline; the browser reads `res.body` with `getReader()` and parses each line (`lib/streaming/ndjson.ts:17-64`). One kernel, four consumers (briefing, investigation, capture, chat). The consequence: reconnection is a full `fetch` retry, not a resumable stream. This is why `useReconnectPolicy` exists — a revoked Bloomreach token surfaces as an `error` NDJSON event, the hook matches the shape (`invalid_token|unauthor|forbidden|401|session expired|reconnect`), fires `POST /api/mcp/reset`, and reloads the page.

  → **The custom header transport for per-request MCP config is fail-safe by design.** `lib/mcp/config.ts:87-100` decodes `x-bi-mcp-config` with a try/catch that returns `null` on any failure. A malformed base64 payload, a JSON parse error, an unknown auth type — all fall through to env-driven behavior instead of crashing the request. The route site (`app/api/agent/route.ts:165`) reads the header and passes the decoded override to `makeDataSource`. If nothing decodes, env wins — exactly what you want in production where the header is optional.

  → **Cookies carry two different trust levels across the same cross-site boundary.** `bi_session` (in `lib/mcp/session.ts`) is a random UUID that identifies the user's browser to the route. `bi_auth` (in `lib/mcp/auth.ts:48-104`) is an AES-256-GCM-encrypted store of OAuth tokens + PKCE state + DCR client info, keyed by `bi_session`. Both use `SameSite=None; Secure` in production so they survive the cross-site OAuth redirect. The encryption is what lets `bi_auth` sit in a browser cookie at all — Vercel's ephemeral functions can't share memory across the `/api/mcp/connect` → Bloomreach IdP → `/api/mcp/callback` round-trip, so the browser cookie is the only state both sides can see.

  → **Prompt caching rides an Anthropic-specific header cache marker.** `lib/agents/aptkit-adapters.ts:87` wraps the system prompt in `cache_control: { type: 'ephemeral' }`. First call is a cache_creation (~1.25× normal input cost); subsequent calls within ~5 min are cache_reads (~0.1×). Verified live: `cache_creation_input_tokens 3168` → `cache_read_input_tokens 3168` on the next call. This is a network optimization living inside the Anthropic protocol, not something Anthropic caches transparently — it's a first-class HTTP-level knob on the request payload.

  → **`x-forwarded-host` drives the OAuth redirect URI on Vercel.** `lib/mcp/connect.ts:57-70` derives the redirect from the actual request host in production (falls back to `APP_ORIGIN` locally). Without this, a preview-deployment URL would trigger an OAuth flow whose callback lands on the production alias — different origin, different cookie jar, the `bi_session` cookie doesn't come along and the callback sees "no session". This is a network-layer detail (the edge inserts `x-forwarded-host`) that fixes an identity-layer bug (cookie scope).

## What is `not yet exercised`

Named for honesty and for the shape it would take when it becomes relevant:

  → **WebSockets / SSE.** Neither is used. The streaming surface is NDJSON over `fetch` response bodies. If a future feature needs server-push after the initial response finishes, SSE (`text/event-stream`) fits the same Vercel route shape. WebSockets would require moving off the standard Vercel Node runtime (they don't survive an ephemeral function's per-request lifecycle).

  → **HTTP connection pooling / keep-alive control.** No explicit `httpAgent` config, no `keepalive: true` on `fetch`. Node 20's `undici` fetch pools connections per host automatically. On Vercel's ephemeral functions this pool is per-instance-lifetime, which is short — so pooling is a best-effort optimization, not a load-bearing mechanism here. Would become relevant on a long-running Node server hitting Bloomreach/Anthropic under sustained load.

  → **DNS caching / SRV records / service discovery.** Origins are hardcoded HTTPS URLs; DNS is Vercel's / Node's default resolver. No SRV, no consul, no discovery layer.

  → **Multi-region / edge routing.** Vercel's edge fronts the route but the route is a Node function, not an edge function. No `runtime: 'edge'` declared. No per-region routing logic. `x-forwarded-host` shows up because Vercel's edge terminates TLS and forwards to the function, not because there's regional logic in this code.

  → **CORS.** All browser-to-route requests are same-origin. No `Access-Control-*` headers configured. Would become relevant if the API layer were split out of the Next.js app.

  → **UDP / QUIC / HTTP/3.** Not exercised at the application layer. Whatever the Vercel edge negotiates with browsers is opaque to this code.

## Reading order

Start with `01-network-map.md` — the picture the rest of the guide hangs off. Then `05-http-semantics-caching-and-cors.md` (the layer most of the interesting mechanisms sit in for this repo) and `07-timeouts-retries-pooling-and-backpressure.md` (where the load-bearing 30s timeout lives). `06-websockets-sse-streaming-and-realtime.md` explains why NDJSON was the right call. End with `08-networking-red-flags-audit.md` — the ranked risks with evidence.

## See also

  → `study-security` — same trust boundaries, different question ("is each hop safe?" rather than "what's on the wire?")
  → `study-system-design` — same network fan-out, different question ("where should these boundaries live?" rather than "what protocol carries them?")
  → `study-distributed-systems` — the coordination story that hangs off the wire

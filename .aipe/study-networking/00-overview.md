# Networking overview — blooming_insights

The through-line: **what actually happens on the wire, where can it fail,
and which protocol semantics does the code rely on?** This repo answers that
across three HTTPS surfaces — browser to Next routes, routes to Bloomreach,
routes to Anthropic — with everything else (DNS, TLS handshakes, connection
pooling) delegated to Node's default `fetch` and to the CDN/edge layer.

The whole system, one picture. Every horizontal line here is a boundary the
code crosses; each one is where the interesting failure modes live.

```
  blooming_insights — the on-the-wire map

  ┌─ Client (browser) ──────────────────────────────────────────────┐
  │  React 19 pages · useBriefingStream / useInvestigation           │
  │  fetch() → ReadableStream → readNdjson (lib/streaming/ndjson.ts) │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │  hop 1: HTTPS (Vercel edge → route)
                                  │  GET /api/briefing / /api/agent
                                  │  Cookie: bi_session; bi_auth
                                  │  → NDJSON stream (chunked)
  ┌─ Next routes (Node runtime) ──▼─────────────────────────────────┐
  │  app/api/{briefing,agent,mcp/*}/route.ts                         │
  │  maxDuration = 300 (Vercel Pro)                                  │
  │  Content-Type: application/x-ndjson; Cache-Control: no-store     │
  └────────────┬─────────────────────────────────────┬──────────────┘
               │  hop 2: HTTPS                        │  hop 3: HTTPS
               │  MCP over StreamableHTTP             │  api.anthropic.com
               │  Bearer <OAuth token>                │  Bearer + cache_control
               │  30s AbortSignal.timeout per call    │  system prefix
               ▼                                      ▼
  ┌─ Bloomreach loomi-mcp ──────┐      ┌─ Anthropic messages API ────┐
  │ loomi-mcp-alpha.bloomreach   │      │ claude-sonnet-4-6 / haiku    │
  │ .com/mcp (no trailing slash) │      │ ephemeral prompt cache       │
  │ rate limit: 1 per 10 seconds │      │ cache_creation → cache_read  │
  │ tokens revoked after ~min    │      │ (~90% discount on repeats)   │
  └──────────────────────────────┘      └──────────────────────────────┘
```

Three horizontal boundaries — each with a distinct failure surface, timeout
budget, and retry policy. The rest of this guide walks each in turn.

---

## What's load-bearing (read these first)

The three mechanisms that carry the whole networking story:

  1. **The 300s / 30s / retry-ceiling composition** — `AbortSignal.timeout(30_000)`
     at `lib/mcp/transport.ts:38` composed with the route-level `req.signal`
     via `composeSignals` (`lib/mcp/transport.ts:173`), inside the 300s
     Vercel Pro budget (`maxDuration = 300` at `app/api/agent/route.ts:22`
     and `app/api/briefing/route.ts:19`). Whichever signal fires first cancels
     the in-flight call. This is the load-bearing invariant — everything
     else hangs on it. See **07-timeouts-retries-pooling-and-backpressure.md**.

  2. **NDJSON over `fetch` streams** (not SSE, not WebSocket) — one kernel
     at `lib/streaming/ndjson.ts:17` consumed by every client hook
     (`useBriefingStream`, `useInvestigation`, chat), produced by every
     streaming route via `encodeEvent` at `lib/mcp/events.ts:15`. The choice
     of NDJSON-over-fetch (over EventSource) is deliberate — it lets the
     client cancel via the request signal instead of an EventSource-close
     dance, and it works over the same authenticated `Cookie:` header path.
     See **06-websockets-sse-streaming-and-realtime.md**.

  3. **OAuth 2.1 + PKCE + Dynamic Client Registration inside an encrypted
     cookie** — the `bi_auth` cookie holds the OAuth state (client info,
     PKCE verifier, tokens) AES-256-GCM-encrypted under `AUTH_SECRET`
     (`lib/mcp/auth.ts:62-79`), scoped per session, seeded once and flushed
     once per request via `AsyncLocalStorage`. `SameSite=None` + `Secure` is
     required so the cross-site OAuth return from Bloomreach's IdP hits the
     `/api/mcp/callback` route with the cookie still attached. See
     **04-tls-and-trust-establishment.md** and **05-http-semantics-caching-and-cors.md**.

## Ranked findings

The wire behavior in priority order. Full walks in
**08-networking-red-flags-audit.md**.

  1. **Retry ladder budget arithmetic under a per-call 30s cap** — the
     transport's 30s `TOOL_TIMEOUT_MS` bounds a single HTTP round-trip; the
     `BloomreachDataSource` retry ladder can add up to `retryCeilingMs = 20_000`
     wait × `maxRetries = 3` = 60s of *wall clock* on a single tool call
     that keeps getting rate-limited. Under the 300s Pro budget this is
     fine; on Hobby (60s) it would consume the entire budget on one
     stuck tool. This is why `maxDuration = 300` at both routes.
     Evidence: `lib/mcp/transport.ts:38`, `lib/data-source/bloomreach-data-source.ts:135-136,164-174`.

  2. **Timeouts fail fast; only rate-limit results retry** — a `TimeoutError`
     from `AbortSignal.timeout` throws `HTTP 0: timeout after 30000ms`
     (`transport.ts:137`) and rides the transport failure path; the
     retry ladder only fires on tool *results* whose `isError === true`
     text matches `/rate limit|too many requests/i`
     (`bloomreach-data-source.ts:51-55`). A hung origin (network partition)
     fails once at 30s rather than four times at 30s. Deliberate — a retry
     would just wait 30s more inside the same route budget.

  3. **Ephemeral prompt caching on the Anthropic hop** — a single
     `cache_control: { type: 'ephemeral' }` block on the system prompt
     (`lib/agents/aptkit-adapters.ts:87`) turns every subsequent ReAct-loop
     iteration within 5 minutes into a `cache_read` at ~10% of normal
     input cost. Baseline eval shows this live: `cache_creation_input_tokens: 3168`
     on the first turn matched by `cache_read_input_tokens: 3168` on the
     next.

  4. **Cross-site OAuth cookie survival** — `bi_session` and `bi_auth`
     both use `SameSite=None; Secure` in production
     (`lib/mcp/session.ts:12`, `lib/mcp/auth.ts:98`). `SameSite=Lax` would
     drop the cookie on the IdP-driven return to `/api/mcp/callback`, and
     the callback would land with `no session` (there's a defensive
     `!sid` check at `app/api/mcp/callback/route.ts:20`).

  5. **Origin per-request redirect_uri** — production reads
     `x-forwarded-host` from Next's request headers to derive
     `${proto}://${host}/api/mcp/callback` (`lib/mcp/connect.ts:36-57`).
     Without this, a preview-deploy URL's cookie would be dropped when the
     callback lands on the production alias.

  6. **The trailing slash 307 problem** — `mcpUrl()` strips trailing
     slashes off `BLOOMREACH_MCP_URL` explicitly (`lib/mcp/connect.ts:33`)
     because the SDK's URL construction would otherwise produce
     `.../mcp/` and eat a 307 redirect on every call. Small but
     load-bearing.

  7. **Fetch-body redaction before logging** — `makeCapturingFetch` at
     `transport.ts:103` records the body of any non-OK response so tool
     errors surface the real server text, and `redactSecrets` at
     `transport.ts:66` strips `Bearer …`, `access_token`,
     `refresh_token`, `id_token`, `code_verifier` before storage — so a
     token nested in an error envelope never reaches Vercel logs.

  8. **No connection-pool or DNS controls in the app** — the app uses
     the platform default `fetch` (Undici under Node, browser fetch on
     the client). No `Agent`, no keepalive tuning, no DNS pinning, no
     HTTP/2 push. This is fine for the current traffic shape (one user,
     one MCP origin, one LLM origin) and would be the first thing to
     revisit if the app ever fanned out to per-user workspaces at scale.

## Reading order

  1. `01-network-map.md` — the full wire path across the three surfaces
  2. `02-dns-routing-and-addressing.md` — origins, per-host redirect_uri, 307
  3. `03-tcp-udp-connections-and-sockets.md` — where sockets are (Undici) and aren't
  4. `04-tls-and-trust-establishment.md` — HTTPS termination + the encrypted cookie
  5. `05-http-semantics-caching-and-cors.md` — methods, headers, cookies, prompt cache
  6. `06-websockets-sse-streaming-and-realtime.md` — NDJSON over fetch, reconnect
  7. `07-timeouts-retries-pooling-and-backpressure.md` — the composed budget
  8. `08-networking-red-flags-audit.md` — ranked risks with evidence

## Not yet exercised

Deliberately absent from this repo — flagged so a reader doesn't hunt for
them:

  - **CDN, load balancer, geo-DNS** — Vercel's edge is present but not
    configured; no route runs `edge` runtime, no CDN caching headers set
    beyond `no-store` on streams.
  - **DNS pinning, custom resolvers, IPv6 tuning** — platform default.
  - **mTLS, certificate pinning, custom trust roots** — public HTTPS only.
  - **WebSockets** — not exercised anywhere. The streaming surface is
    NDJSON-over-fetch by design (see 06).
  - **Server-Sent Events (`EventSource`)** — considered and rejected; a
    line in `lib/mcp/types.ts` documents that streaming uses fetch +
    ReadableStream, not EventSource.
  - **UDP, HTTP/3, HTTP/2 push** — no code path uses them.
  - **CORS** — the whole app is same-origin (Next app + its own routes),
    so no `Access-Control-*` header is emitted anywhere. Adding a
    third-party client would need CORS wired in.
  - **Request coalescing / collapsing** — the 60s response cache at
    `bloomreach-data-source.ts:186` collapses *cache hits* but there's no
    in-flight singleflight/dedupe of concurrent identical requests.
  - **Jitter on retries** — the retry ladder is deterministic
    (parsed hint OR `retryDelayMs * 2**(retries-1)`, capped at
    `retryCeilingMs`). Adding jitter is a one-line change if the app
    ever fans out to multiple concurrent users hitting the same
    `1 per 10 second` window.
  - **Circuit breaker / half-open probes** — no state kept across
    failures; the retry ladder is per-call.

## Cross-links to adjacent guides

  - **Trust boundaries at each hop** (whether encryption/auth is *safe*) —
    see `.aipe/study-security/`.
  - **Where each network boundary belongs in the architecture** (why
    NDJSON here and not there) — see `.aipe/study-system-design/`,
    especially the streaming pattern file.
  - **What the wire behavior costs in wall-clock and cost** —
    see `.aipe/study-performance-engineering/`.
  - **How runtime signals cancel in-flight work** —
    see `.aipe/study-runtime-systems/` for the AbortSignal composition
    at the process level.

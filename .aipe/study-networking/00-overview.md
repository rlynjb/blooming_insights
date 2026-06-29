# Networking — overview

The map. Open this first; every other file in this folder is a zoom-in on one box on this picture.

## The whole thing in one diagram

Three wires. All HTTPS. Nothing else.

```
  blooming insights — the three wire surfaces

  ┌─ Browser ────────────────────────────────────────────┐
  │  React 19 (Next.js 16 App Router)                    │
  │  useBriefingStream · useInvestigation · StreamingResponse
  └──────────────────────────┬───────────────────────────┘
                             │
                  WIRE #1    │  HTTPS · same-origin
                  ─────────  │  GET  /api/briefing      → NDJSON (chunked)
                  Browser ↔  │  GET  /api/agent         → NDJSON (chunked)
                  this app   │  POST /api/mcp/{call,reset,tools,…} → JSON
                             │  cookies: bi_session (UUID) · bi_auth (AES-256-GCM)
                             ▼
  ┌─ Next.js route handlers (Vercel Pro, maxDuration=300s) ─┐
  │  app/api/briefing/route.ts   · app/api/agent/route.ts   │
  │  app/api/mcp/{call,callback,reset,tools,…}/route.ts     │
  └─────────────┬──────────────────────────┬────────────────┘
                │                          │
       WIRE #2  │  HTTPS                   │  HTTPS    WIRE #3
       ──────── │  StreamableHTTPClient    │  fetch    ────────
       App ↔    │  Transport               │  inside   App ↔
       loomi-   │  OAuth 2.1 + PKCE + DCR  │  SDK      Anthropic
       MCP      │  Bearer + ~1 req/s/user  │           Bearer (ANTHROPIC_API_KEY)
                ▼                          ▼
  ┌─ loomi-mcp-alpha.bloomreach.com ─┐  ┌─ api.anthropic.com ──────────────┐
  │  MCP server (alpha; tokens       │  │  claude-sonnet-4-6                │
  │  revoke after minutes)           │  │  claude-haiku-4-5-20251001        │
  └──────────────────────────────────┘  └───────────────────────────────────┘
```

The story this file owns: what happens on each of those three wires, where the protocol semantics actually bind on real code, and where they can hurt you.

## What's not here

Three things you might expect on a "networking" map that are absent on purpose:

- **No IPC, no subprocess transport.** Every external hop is HTTPS. No `fetch`-replacement adapters, no local sockets, no child processes. The MCP SDK exposes other transports; we use only its HTTP transport (`StreamableHTTPClientTransport`).
- **No database wire.** There is no Postgres / Redis / SQLite / S3 in production. State lives in in-memory maps and (in dev) gitignored JSON files. The closest thing to a "storage hop" is the encrypted token cookie (`bi_auth`), which is a client-side state envelope, not a network round-trip.
- **No SyntheticDataSource hop.** When the user picks `mode=live-synthetic`, the briefing route runs the same agents and the same Claude calls, but the MCP wire is replaced by an in-process fake. Wire #2 disappears; wire #3 still fires.

## The verdict-first finding

The single most useful thing to internalize from this audit:

> **NDJSON over chunked HTTP is the load-bearing realtime transport, not SSE and not WebSockets.** One kernel parses every stream (`lib/streaming/ndjson.ts:17`), four consumers ride it (`useBriefingStream`, `useInvestigation`, `useDemoCapture`, `StreamingResponse`). The choice is deliberate: NDJSON is just `Content-Type: application/x-ndjson` + `\n`-terminated JSON objects over an ordinary `fetch()` response body. No `EventSource`, no upgrade handshake, no Last-Event-ID dance. It carries the agent's reasoning trace, tool calls, and partial results live to the UI.

If you take one diagram from this folder into a whiteboard interview, take the NDJSON one in `06-websockets-sse-streaming-and-realtime.md`.

## The ranked red flags

The full ranked list lives in `08-networking-red-flags-audit.md`. The top three:

1. **Bloomreach per-call timeout — present.** `transport.ts:38` sets `TOOL_TIMEOUT_MS = 30_000` and composes it with the route-level cancel signal at `transport.ts:131`. A hung Bloomreach call now fails fast as `HTTP 0: timeout after 30000ms` instead of burning the 300s route budget on one stuck request.
2. **Two divergent auth-error regexes.** `useReconnectPolicy.ts:33-34` keeps `AUTH_ERROR_RE_AUTO` (matches `invalid_token|unauthor|forbidden|401|session expired|reconnect`) separate from `AUTH_ERROR_RE_BUTTON` (missing `invalid_token` and `reconnect`). The hook's own comment flags it. A latent bug where the explicit "reconnect" button doesn't match `invalid_token` errors.
3. **CORS not configured, and that's correct.** Every `/api/*` route is same-origin; the browser never makes a cross-origin request from `app/page.tsx` to anything but `/api/*`. The cross-origin hop is server-to-Bloomreach, where CORS doesn't apply. Not a bug, but worth knowing why the absence is right.

## Reading order

Three orientations. Take them in order the first time; jump in later.

```
  reading order — wide → narrow → audit

  ┌─ 01 network-map ────────────────────┐  the three wires, every hop
  └──────────────────┬──────────────────┘
                     │
  ┌─ 02 dns-routing-and-addressing ─────┐  who resolves what, where
  │  03 tcp-udp-connections-and-sockets │  connection lifecycle
  │  04 tls-and-trust-establishment     │  encryption + cert chain
  │  05 http-semantics-caching-and-cors │  methods, status, headers, CORS
  │  06 websockets-sse-streaming-…      │  NDJSON over chunked HTTP — and why
  │  07 timeouts-retries-pooling-…      │  the rate-limit playbook + timeout gap
  └──────────────────┬──────────────────┘
                     │
  ┌─ 08 networking-red-flags-audit ─────┐  ranked risks, evidence + verdict
  └─────────────────────────────────────┘
```

## What's `not yet exercised`

Honest gaps — concepts whose mechanism isn't anchored to real code in this repo:

- **UDP.** Everything is TCP under HTTPS. DNS uses UDP under the hood but the app never opens a UDP socket. Concept gets a placeholder in file 03.
- **WebSockets.** No `new WebSocket()`. The realtime story uses chunked HTTP. File 06 still teaches WebSockets at the protocol level because the partition rule says: teach the alternative the codebase rejected.
- **SSE (`EventSource`).** Same as WebSockets — taught in file 06 as the road not taken, with reasons.
- **HTTP caching headers on `/api/*`.** Every streaming route sets `cache-control: no-store, no-transform`. There is no `ETag` / `If-None-Match` / `Cache-Control: max-age` story. Browser HTTP cache is a no-op on this app's API.
- **Connection pooling at the app layer.** Node's `undici` global agent does HTTP keepalive automatically; the app never configures or measures it. Mentioned in file 07; not anchored to repo code.
- **Service workers / push.** None.
- **CDN.** Vercel terminates TLS and proxies; we don't own that layer. Treated as the edge in file 04.

## See also

- `study-security/audit.md` — the trust side of every wire (what each side can see, tamper with).
- `study-system-design/` — where the boundaries belong architecturally (this folder owns what travels on them).
- `study-runtime-systems/` — `AbortSignal`, the event loop, the 300s budget that constrains the wire behavior here.

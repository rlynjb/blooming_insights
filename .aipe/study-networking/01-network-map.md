# Network map

**The on-the-wire path, every hop labelled** · Project-specific

## Zoom out — where this concept lives

This file IS the bigger picture. Every later file in the folder zooms into one box drawn here.

```
  Zoom out — the whole system as labelled bands

  ┌─ UI band ──────────────────────────────────────────────────┐
  │  React 19 in the browser                                    │
  │  app/page.tsx · app/investigate/[id]/page.tsx               │
  │  ★ useBriefingStream · useInvestigation · StreamingResponse│ ← we are here
  └───────────────────────┬─────────────────────────────────────┘
                          │  hop 1: HTTPS, same-origin
                          │  GET /api/briefing , GET /api/agent → NDJSON
                          │  POST /api/mcp/*                    → JSON
                          ▼
  ┌─ Service band (Next.js route handlers on Vercel Pro) ──────┐
  │  app/api/briefing/route.ts · app/api/agent/route.ts        │
  │  app/api/mcp/{call,callback,reset,tools,…}/route.ts        │
  │  per-route maxDuration = 300                                │
  └─────────────┬─────────────────────────┬─────────────────────┘
                │                         │
        hop 2   │  HTTPS                  │  HTTPS    hop 3
        ──────  │  StreamableHTTP         │  POST     ──────
                │  Client Transport       │  /v1/messages
                ▼                         ▼
  ┌─ Provider band ──────────────────┐  ┌─ Provider band ──────────────────┐
  │  loomi-mcp-alpha.bloomreach.com  │  │  api.anthropic.com                │
  │  Bloomreach MCP server (alpha)   │  │  claude-sonnet-4-6 · haiku-4-5    │
  └──────────────────────────────────┘  └───────────────────────────────────┘
```

Three wires. Every line that leaves the Service band is HTTPS over TCP+TLS. Nothing leaves the Service band that isn't HTTPS.

## Zoom in — the concept

The thing being named here: **the network map** — every wire surface this app exposes or consumes, with every hop between bands labelled. If a finding in this folder doesn't anchor to one of the hops above, the finding is off-map.

## Structure pass — skeleton before mechanics

### Layers

- **UI band** — the browser. Owns: cookies, `fetch()` calls, `ReadableStream` consumers, sessionStorage handoff.
- **Service band** — Next.js route handlers on Vercel. Owns: NDJSON producers, MCP/Anthropic clients, the encrypted cookie store.
- **Provider band** — Bloomreach loomi-MCP and Anthropic. We don't own them; we obey their contracts (rate limits, token expiry, response shapes).

### One axis held constant — `who originates the request?`

```
  axis = "who originates the request?"

  ┌─ UI ──────────┐   the browser originates
  │ user clicks    │   ───────────────────────────────►  hop 1
  └────────────────┘   "GET /api/briefing"

  ┌─ Service ─────┐   the route handler originates
  │ NDJSON loop   │   ───────────────────────────────►  hop 2
  │ MonitoringAgent│   "tools/call execute_analytics_eql"
  └────────────────┘
                      ───────────────────────────────►  hop 3
                      "POST /v1/messages"

  ┌─ Provider ────┐   never originates inbound to us.
  │ Bloomreach     │   the alpha server CAN revoke tokens at
  │ Anthropic      │   any time, but it does so by responding
  └────────────────┘   401 to OUR next call, not by ringing us.
```

The codebase has no inbound provider webhook. No push. No long-poll FROM Bloomreach. Every conversation is `we ask → they answer`. The OAuth callback is the only inbound HTTPS request that isn't kicked off by our client code — and it's still kicked off by *our* `redirectToAuthorization` URL, just routed back through the user's browser.

### Seams — where the axis flips

- **Browser ↔ Service** (`fetch('/api/briefing')` → `app/api/briefing/route.ts`). The axis flips from "client originates" to "server originates the next two hops." Same-origin, so cookies ride free; no CORS preflight.
- **Service ↔ Bloomreach** — the MCP HTTP transport (`StreamableHTTPClientTransport`) → `https://loomi-mcp-alpha.bloomreach.com/mcp`. Trust flips: from the browser's session cookies (`bi_session`/`bi_auth`) to an OAuth Bearer token in an `Authorization` header. Cookies don't leave the Service band.
- **Service ↔ Anthropic** (`anthropic.messages.create`). Trust flips again: from session cookie to `ANTHROPIC_API_KEY` Bearer. Different secret per provider, never reused.
- **Browser ↔ OAuth IdP ↔ /api/mcp/callback**. The one cross-origin hop the *browser* makes — Bloomreach redirects the user back to us with `?code=…`. This is why the session cookie (`bi_session`) is `SameSite=None; Secure` in production (`lib/mcp/session.ts:12`): a Lax cookie would drop on the cross-site return.

## How it works

### Move 1 — the mental model

Picture the app as a hub with three spokes. The hub is the Next.js route handler running on Vercel. Each spoke is one wire surface. Every spoke carries HTTPS, but each one carries it under a different protocol contract.

```
  the hub-and-spoke pattern

                          ┌─ Browser ─┐
                          │   React    │  spoke 1: NDJSON or JSON
                          └─────┬──────┘  over chunked HTTP
                                │  ▲
                  cookies +     │  │
                  user-clicks   ▼  │
                          ┌─ Service ─┐
                ┌─────────┤  Next.js   ├─────────┐
                │         │  route     │         │
                ▼         └────────────┘         ▼
       ┌─ Bloomreach ─┐                 ┌─ Anthropic ─┐
       │  spoke 2:    │                 │  spoke 3:    │
       │  MCP / JSON-RPC               │  /v1/messages │
       │  OAuth 2.1   │                 │  API key      │
       └──────────────┘                 └───────────────┘

  one hub. three spokes. each spoke has its own auth, its own
  rate limit, its own failure mode.
```

The hub matters because most of the protocol semantics in this codebase live there — the NDJSON encoding, the OAuth dance, the rate-limit retry ladder, the AbortSignal composition. The spokes are just transport.

### Move 2 — walk each hop

#### Hop 1 — Browser to /api/briefing

The canonical example. The user lands on `app/page.tsx`, the briefing-stream hook (`useBriefingStream`) fires `fetch('/api/briefing?mode=live-bloomreach')`, and the response body is an NDJSON stream the hook reads with the NDJSON parser (`readNdjson`).

```
  Layers-and-hops — Browser to /api/briefing (live mode)

  ┌─ Browser ────────────┐                                     ┌─ Service ────────────┐
  │  useBriefingStream   │   hop 1a: GET /api/briefing         │ app/api/briefing/    │
  │  (fetch + reader)    │ ──────────────────────────────────► │   route.ts           │
  │                      │   • cookies: bi_session, bi_auth    │ • maxDuration = 300  │
  │                      │   • content negotiation: implicit   │ • content-type:      │
  │                      │     (server picks NDJSON for live)  │   application/       │
  │                      │                                     │   x-ndjson           │
  │                      │   hop 1b: chunked response body     │                      │
  │                      │ ◄────────────────────────────────── │ ReadableStream of    │
  │                      │   {"type":"workspace",…}\n          │ Uint8Array chunks    │
  │                      │   {"type":"reasoning_step",…}\n     │                      │
  │                      │   {"type":"tool_call_start",…}\n    │                      │
  │                      │   …                                 │                      │
  │                      │   {"type":"done"}\n                 │                      │
  └──────────────────────┘                                     └──────────────────────┘
```

The code that does this:

```ts
// lib/hooks/useBriefingStream.ts:158-159, 188-199, 288
const res = await fetch(url);           // ← hop 1a — plain GET, no special headers
// …
const ct = res.headers.get('content-type') ?? '';
if (!ct.includes('ndjson') || !res.body) {
  // demo path: plain JSON, no stream
}
// …
await readNdjson<BriefingEvent>(res.body, handle, { cancelOn: () => cancelledRef.current });
// ↑ the shared NDJSON kernel — see lib/streaming/ndjson.ts:17
```

Cookies travel because the request is same-origin. The route reads them in `lib/mcp/session.ts:17` (`bi_session`) and `lib/mcp/auth.ts:88` (`bi_auth`) without any explicit `credentials: 'include'` on the client. That's the same-origin payoff.

#### Hop 2 — Service to Bloomreach MCP

The MCP SDK opens this hop on first tool call. It's an HTTPS POST to `https://loomi-mcp-alpha.bloomreach.com/mcp/` carrying a JSON-RPC envelope and a Bearer token.

```
  Layers-and-hops — Service to Bloomreach (one tool call)

  ┌─ Service ──────────────┐                                  ┌─ Provider ──────────┐
  │ BloomreachDataSource   │  hop 2a: POST /mcp/              │ loomi-mcp-alpha     │
  │   .callTool(…)         │ ────────────────────────────────►│ .bloomreach.com     │
  │                        │  • Authorization: Bearer eyJ…    │                     │
  │ SdkTransport           │  • Content-Type: application/json│ rate-limit:         │
  │   ↳ MCP SDK Client     │  • body: {jsonrpc:"2.0",         │   ~1 req/s/user     │
  │   ↳ StreamableHTTP-    │           method:"tools/call",   │   (alpha)           │
  │     ClientTransport    │           params:{name,arguments}}│                     │
  │   ↳ capturing fetch    │                                  │ token TTL:          │
  │     (transport.ts:103) │  hop 2b: response                │   minutes (revoked) │
  │                        │ ◄────────────────────────────────│                     │
  │                        │  200 OK · application/json       │                     │
  │                        │  or 401 invalid_token            │                     │
  │                        │  or 429 "1 per 10 second"        │                     │
  └────────────────────────┘                                  └─────────────────────┘
```

The code:

```ts
// lib/mcp/connect.ts:76-79
const transport = new StreamableHTTPClientTransport(mcpUrl(), {
  authProvider: provider,                            // ← OAuth/PKCE/DCR (auth.ts)
  fetch: makeCapturingFetch(httpErrors),             // ← captures real error bodies
});
```

The SDK does the actual `fetch` for hop 2a internally; we inject a capturing fetch wrapper (`makeCapturingFetch`) (`lib/mcp/transport.ts:103`) so we can keep the body of any non-2xx response and reattach it to the thrown error — without that, the SDK collapses every 401 into a generic "Unauthorized" and we lose the real `invalid_token` text.

#### Hop 3 — Service to Anthropic

```
  Layers-and-hops — Service to Anthropic

  ┌─ Service ────────────────┐                                  ┌─ Provider ──────────┐
  │ new Anthropic({          │  hop 3a: POST /v1/messages       │ api.anthropic.com   │
  │   apiKey: process.env    │ ────────────────────────────────►│                     │
  │     .ANTHROPIC_API_KEY }) │  • x-api-key: sk-ant-…            │ model:              │
  │                          │  • anthropic-version: 2023-06-01  │   claude-sonnet-4-6 │
  │ anthropic.messages       │  • body: {model, messages, tools} │   claude-haiku-4-5  │
  │   .create({ signal })    │                                  │                     │
  │   (aptkit-adapters.ts:52)│  hop 3b: response                 │ (intent classifier  │
  │                          │ ◄────────────────────────────────│  uses haiku for $$)│
  │                          │  200 OK · application/json       │                     │
  └──────────────────────────┘                                  └─────────────────────┘
```

The SDK handles the actual fetch; we hand it a `signal` so the route's cancel/timeout chain propagates here too (`app/api/agent/route.ts:255` weaves `req.signal` into every Claude call).

### Move 3 — the principle

**A network map is worth drawing because each wire carries a different contract.** Same-origin browser HTTP gives you cookies for free and no CORS friction; cross-origin server HTTP needs an OAuth provider plus a rate-limit playbook plus a token-expiry recovery dance. Same-origin and cross-origin look identical in `fetch()` syntax; the operational reality is completely different. Drawing the map exposes the contracts.

## Primary diagram — the recap

```
  the recap — three wires, every hop, every protocol contract

  ┌─ Browser ──────────────────────────────────────────────────┐
  │  React · useBriefingStream · useInvestigation              │
  │  cookies: bi_session (UUID, SameSite=None) · bi_auth (AES-256-GCM)
  └─────────────────┬──────────────────────────────────────────┘
                    │
   ━━━━━━━━━━━━━━━━━│━━━━━━━━━━━━━━━ same-origin · HTTPS · TCP+TLS ━━━
                    │
                    │  WIRE #1
                    │  GET  /api/briefing  → 200 application/x-ndjson  (chunked, 300s budget)
                    │  GET  /api/agent     → 200 application/x-ndjson  (chunked, 300s budget)
                    │  POST /api/mcp/call  → 200 application/json
                    │  GET  /api/mcp/callback?code=…  ← OAuth redirect
                    ▼
  ┌─ Service ──────────────────────────────────────────────────┐
  │  Next.js 16 route handlers · Vercel Pro · maxDuration=300  │
  │  BloomreachDataSource  ·  Anthropic SDK                    │
  └──┬──────────────────────────────────────────┬──────────────┘
     │                                          │
   cross-origin · HTTPS                         │  cross-origin · HTTPS
     │                                          │
     │  WIRE #2                                 │  WIRE #3
     │  POST https://loomi-mcp-alpha            │  POST https://api.anthropic.com
     │       .bloomreach.com/mcp/               │       /v1/messages
     │  Authorization: Bearer (OAuth 2.1)       │  x-api-key: sk-ant-…
     │  ~1 req/s/user · tokens expire mins      │  per-account rate limit
     │  29-tool MCP server                      │  claude-sonnet-4-6 · haiku-4-5
     ▼                                          ▼
  ┌─ Bloomreach loomi-MCP ─┐         ┌─ Anthropic API ─────────────┐
  │  alpha server          │         │  model providers             │
  └────────────────────────┘         └──────────────────────────────┘
```

## Elaborate

Where the map comes from: blooming insights is structurally a **classic three-tier serverless web app with two external providers**. The novelty isn't the topology — it's the protocol stack on wire #2 (MCP-over-HTTPS with OAuth 2.1 + PKCE + Dynamic Client Registration) and the choice on wire #1 (NDJSON over chunked HTTP instead of SSE/WebSocket).

Today every external hop is HTTPS. The Service band has one outbound transport shape — `fetch` (via undici on the server, via the platform on the client) — wrapped by the SDKs that ride on top of it.

Adjacent reading:

- File 02 — what name resolution actually happens (DNS for three hostnames; nothing more interesting than that).
- File 03 — the TCP connection lifecycle on each wire, especially for chunked HTTP.
- File 04 — the certificate chain on each provider hop.
- File 05 — what HTTP methods, status codes, and headers each hop actually uses.
- File 06 — the deep walk on NDJSON over chunked HTTP, with the case against SSE.
- File 07 — the rate-limit playbook, retry ladder, and AbortSignal composition.

## Interview defense

**Q: How many network transports does this app use?**

> Three, all HTTPS. Browser to my own `/api/*`, server to Bloomreach loomi-MCP, server to Anthropic. No IPC, no subprocess, no custom transport — every external hop goes through `fetch`. The MCP SDK ships other transports; we use only `StreamableHTTPClientTransport`.

```
  on the whiteboard:

  Browser ──HTTPS──► /api/*  ──HTTPS──► Bloomreach (MCP)
                          └──HTTPS──► Anthropic (LLM)
```

Anchor: three wires, all HTTPS, no IPC.

**Q: Why is the OAuth callback hop interesting?**

> It's the only inbound HTTPS request that's NOT initiated by my own client code. Bloomreach's IdP redirects the user's browser back to `https://<app-host>/api/mcp/callback?code=…`. That makes it a cross-site request from the browser's perspective. If the session cookie (`bi_session`) were `SameSite=Lax`, some browsers drop it on that return and we lose the binding between the OAuth code and our session. So `bi_session` is `SameSite=None; Secure` in production — `lib/mcp/session.ts:12`.

```
  on the whiteboard:

  Browser ──redirect──► Bloomreach IdP ──redirect──► /api/mcp/callback?code=…
                                                     ↑
                                          cross-site return — Lax cookie
                                          would drop here, so we use None
```

Anchor: SameSite=None + Secure exists for one specific moment in the OAuth dance.

**Q: What if Bloomreach revokes a token mid-stream?**

> They do, within minutes — the alpha server doesn't keep long-lived tokens. The 401 surfaces as an `invalid_token` body on whichever MCP call hits the wire next. `BloomreachDataSource.liveCall` wraps it as an `McpToolError`; the NDJSON `error` event reaches the browser; `useReconnectPolicy.handle` matches the message against `AUTH_ERROR_RE_AUTO` (`useReconnectPolicy.ts:33`), fires `POST /api/mcp/reset` to drop the encrypted cookie, then reloads. One-shot guard in sessionStorage prevents a loop if the second auth also fails.

```
  on the whiteboard:

  call → 401 invalid_token → NDJSON {type:"error",message:"… invalid_token …"}
        → useReconnectPolicy.handle(msg) matches LONG regex
        → POST /api/mcp/reset (drops bi_auth cookie)
        → window.location.href = '/' → re-auth on next request
```

Anchor: the alpha server is the reason the reconnect policy (`useReconnectPolicy`) exists.

## See also

- `02-dns-routing-and-addressing.md` — name resolution on each hop
- `05-http-semantics-caching-and-cors.md` — what each method/status means here
- `06-websockets-sse-streaming-and-realtime.md` — wire #1 in depth
- `07-timeouts-retries-pooling-and-backpressure.md` — wire #2 under pressure
- `study-security/audit.md` — trust boundaries per wire

# 05 · HTTP semantics, caching, and CORS

## Subtitle

Methods, status codes, headers, cookies, cache directives, browser policy — Industry standard.

## Zoom out, then zoom in

HTTP is the application-layer protocol on every wire in this repo. The interesting bits aren't the methods (mostly GET, some POST) — they're the *header policy* the routes set (`Cache-Control: no-store`, `Content-Type: application/x-ndjson`, the cookie attributes), the *status code mapping* the browser logic reads (401 → redirect to OAuth, 5xx → show error), and the *non-existence of CORS* in the surface area (everything browser-side is same-origin).

```
  Zoom out — HTTP semantics in this stack

  ┌─ UI layer ──────────────────────────────────────────────────┐
  │  browser fetches → same-origin → no CORS preflight           │
  │  reads response status, content-type, and the body            │
  │  cookies: bi_session + bi_auth (server-set, httpOnly)         │
  └────────────────────────────────────────────────────────────┘
                          │  HTTP/1.1 or 2 (whatever edge negotiates)
                          ▼
  ┌─ Service layer ─────────────────────────────────────────────┐
  │  Next.js routes set:                                         │
  │  - Content-Type: application/x-ndjson; charset=utf-8 (stream)│
  │  - Cache-Control: no-store/no-cache, no-transform (stream)   │
  │  - Set-Cookie: bi_session, bi_auth (with attributes)         │
  │                                                              │
  │  outbound:                                                   │
  │  - Authorization: Bearer <token> → Bloomreach                │
  │  - x-api-key: <key>              → Anthropic                 │
  └────────────────────────────────────────────────────────────┘
```

This is the lens for "what HTTP rules govern this app." The non-events matter as much as the events: no CORS, no custom cache layer, no HTTP-cache reads in the app.

## Structure pass

  - **Layers** — request line (method + path), headers (request and response), body (request body for POSTs, response body for everything).
  - **Axis traced — "what does each HTTP feature do *for this app*?"** Hold across the feature list:
      - **Methods**: every browser-side fetch is GET except `/api/mcp/reset` and `/api/mcp/call` (POST). No PUT, DELETE, PATCH, OPTIONS (the lattermost because there's no CORS).
      - **Status codes**: 200 (stream succeeded), 401 (`{needsAuth: true, authUrl}` JSON — triggers the OAuth redirect), 403 (`/api/mcp/call` tool-not-allowed), 404 (insight not found), 500 (server error).
      - **Headers**: the streaming routes set `Cache-Control: no-store/no-cache, no-transform` (the `no-transform` is the load-bearing one — it stops Vercel's edge from gzipping/buffering and breaking the stream).
      - **Cookies**: two of them, both httpOnly, both Secure in prod, both SameSite=None (so they survive the IdP redirect).
  - **Seams** — the load-bearing one is the **`Cache-Control: no-transform` + `Content-Type: application/x-ndjson`** pair on the streaming routes. Either alone is incomplete; together they tell every intermediary "do not buffer or recompress this; deliver bytes as I write them."

## How it works

### Move 1 — the mental model

HTTP is "client sends a request line + headers + (optional) body; server sends a status line + headers + (optional) body." Every wire in this repo is that, with one twist: the streaming routes send a status + headers up-front, then keep writing into the body for ~30 seconds. The browser reads the headers immediately (status: 200, content-type: ndjson), then loops over body chunks as they arrive.

```
  Pattern — streaming HTTP response from the app

   client                                          server
   ──────                                          ──────
   GET /api/briefing HTTP/1.1                  →
   Host: blooming-insights.vercel.app
   Cookie: bi_session=…; bi_auth=…
                                                   200 OK
                                                ←  Content-Type: application/x-ndjson; charset=utf-8
                                                   Cache-Control: no-store, no-transform
                                                   Transfer-Encoding: chunked
                                                   (no Content-Length)
                                                ←  {"type":"workspace",...}\n
                                                ←  {"type":"reasoning_step",...}\n
                                                ←  {"type":"tool_call_start",...}\n
                                                   … many lines, ~30s …
                                                ←  {"type":"done"}\n
                                                ←  (0-length chunk = end)
```

That `Transfer-Encoding: chunked` line (implicit; the runtime sets it because there's no `Content-Length`) is what makes streaming work over HTTP/1.1. On HTTP/2, the equivalent is a DATA frame per chunk on the request's stream. Both are transparent to the route code.

### Move 2 — the moving parts

#### Methods

Browser-side fetches in this repo:

  - `GET /api/briefing?…` — start a briefing stream (`lib/hooks/useBriefingStream.ts:158`).
  - `GET /api/agent?…` — start an investigation or query stream (`lib/hooks/useInvestigation.ts:180`, `components/chat/StreamingResponse.tsx:92`).
  - `POST /api/mcp/reset` — clear auth (the reconnect button + the auto-reconnect; `lib/hooks/useReconnectPolicy.ts:73`).
  - `POST /api/mcp/call` — debug page free-form tool call (`app/debug/page.tsx:47`).
  - `GET /api/mcp/tools` — debug page tool list (`app/debug/page.tsx:85`).
  - `POST /api/mcp/capture-demo` — dev-only snapshot capture (`lib/hooks/useDemoCapture.ts:59`).

No PUT, DELETE, PATCH. The repo treats GETs as cheap (start a stream, list tools) and POSTs as side-effect-ful (reset, capture, call). This is REST-ish without being doctrinaire.

One thing to know: a GET that starts a long-running stream is technically not idempotent in the strict HTTP sense — calling it twice triggers two agent runs. The app doesn't rely on idempotency here; the client-side guard (`startedRef` in `useInvestigation.ts:44`) prevents double-runs in React StrictMode dev.

#### Status codes — the auth-redirect pattern

The 401 path is where the streaming routes are intentionally NOT a stream:

```ts
// app/api/briefing/route.ts:180-182
if (!dsResult.ok) {
  return NextResponse.json({ needsAuth: true, authUrl: dsResult.authUrl }, { status: 401 });
}
```

The route checks auth *before* committing to the stream. If auth is missing, it returns a plain JSON 401 with the OAuth URL the browser should redirect to. The hook handles it:

```ts
// lib/hooks/useBriefingStream.ts:162-171
if (res.status === 401) {
  const body = await readBody(res);
  if (body?.needsAuth && body?.authUrl) {
    window.location.href = body.authUrl as string;       // ← full-page nav to IdP
    return;
  }
  setErrorMessage('authentication required');
  setStatus('error');
  return;
}
```

```
  Status code → client action

  200 + ndjson  →  start reading the stream
  200 + json    →  treat as cached/demo snapshot, render directly
  401 + needsAuth → redirect window.location to authUrl
  401 (other)    → "authentication required" error UI
  403            → "tool not allowed" (only /api/mcp/call exposes this)
  404            → insight not found (only investigate flow)
  5xx + body     → show the real error message from the body
  5xx + empty    → "http 500" fallback
```

The 5xx error envelope is also worth a line: routes wrap errors with `redactSecrets(formatError(e))` before logging and put the bare `e.message` in the response body. The client's `readBody` (`useBriefingStream.ts:64`) is defensive — it parses JSON if it can, returns `{ __raw: text }` if not, so a 500 with an HTML body never throws on `res.json()`.

#### Headers — what the streaming routes set

```ts
// app/api/briefing/route.ts:331-335
return new Response(stream, {
  headers: {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store, no-transform',
  },
});
```

Three things this is doing:

  - **`application/x-ndjson`** — newline-delimited JSON. Tells anyone in the middle (browser, edge, proxy) that the body is text but structured per-line. Not officially standardized (the `x-` prefix gives it away), but widely understood. The client uses this content type to pick the streaming path vs the JSON-fallback path (`useBriefingStream.ts:188`).
  - **`no-store`** — don't cache anywhere. Critical because the content is per-user and per-request (the agent's reasoning trace is different every time).
  - **`no-transform`** — don't recompress, don't reformat, don't buffer until you have a "complete" response. This is the line that stops a misconfigured edge gzip layer from sitting on bytes until the response ends. Vercel doesn't gzip ndjson by default, but `no-transform` is the belt that says "I really mean it."

The agent route uses `no-cache, no-transform` instead of `no-store, no-cache`:

```ts
// app/api/agent/route.ts:105-108
const NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
};
```

`no-cache` allows storage but requires revalidation; `no-store` forbids storage. For an authenticated per-user stream both are functionally equivalent (no one with a different identity can use the cached version). Different routes, slightly different choice — not load-bearing.

#### Cookies — the full set

Two cookies, set by the routes:

```ts
// lib/mcp/session.ts:10-14
function sessionCookieOpts() {
  return process.env.NODE_ENV === 'production'
    ? { httpOnly: true, secure: true, sameSite: 'none' as const, path: '/' }
    : { httpOnly: true, sameSite: 'lax' as const, path: '/' };
}
```

  - **`bi_session`** — a UUID per browser, lives 1 year (default cookie expiry until explicitly cleared). Keys the auth-store lookup. SameSite=None in prod so it rides the OAuth return.
  - **`bi_auth`** — the encrypted OAuth state. AES-256-GCM. Same SameSite=None + Secure attributes. 10-day expiry (matches the token lifetime).

Both are `httpOnly` — no JavaScript on the page can read them. The browser sends them automatically on every same-origin request.

Local dev uses SameSite=Lax (and drops Secure) because http://localhost can't satisfy Secure cookies, and there's no cross-site IdP return in dev (the OAuth flow goes to the same localhost origin).

#### CORS — the non-event

There is no `Access-Control-Allow-Origin` header anywhere in `app/` or `lib/`. Every browser-side fetch is same-origin (`/api/*` on the page's host). The browser's CORS check is skipped entirely for same-origin requests.

```
  Same-origin vs cross-origin — what the browser does

  same-origin:  fetch('/api/briefing')   from page.tsx on app.example.com
                ──► no preflight, send cookies automatically, no CORS check.

  cross-origin: fetch('https://other.example/...')
                ──► browser sends OPTIONS preflight (for non-simple methods/headers)
                    server must respond with Access-Control-Allow-Origin
                    and Access-Control-Allow-Credentials: true (if cookies)
                    only THEN does the real request go out.
```

If someone added a `fetch('https://api.bloomreach.com/...')` directly from the page (instead of through the route), CORS would fire and the call would need Bloomreach to set the right headers. The architectural choice — route everything through `/api/*` — sidesteps that entirely. The server is a gateway; it can call any host because it's not a browser.

#### The server-side outbound headers

Set by the SDKs, not by app code:

  - **`Authorization: Bearer <token>`** — set by the MCP SDK on every call to Bloomreach (the OAuth provider's tokens get injected).
  - **`x-api-key: <key>`** — set by the Anthropic SDK on every call (`process.env.ANTHROPIC_API_KEY`).
  - **`Accept: application/json`** + **`Content-Type: application/json`** — standard JSON-RPC and Anthropic Messages API conventions.

The app's only outbound-header concern is making sure none of these leak into logs — see `redactSecrets` (`lib/mcp/transport.ts:66`).

#### Browser caching behavior — what the app DOESN'T do

  - No `ETag` / `If-None-Match` on any route.
  - No `Last-Modified` / `If-Modified-Since`.
  - No `Cache-Control: max-age=N` on any route except the implicit defaults Next sets on static assets.
  - No service worker. No Cache API.
  - No client-side caching of the briefing/insights — the only client-side persistence is `sessionStorage` for the insight handoff between feed and investigate (`stashInsights` in `useBriefingStream.ts:53`).

The lack of HTTP-cache integration is appropriate: the per-user, per-request streaming output is not cacheable in any meaningful way. The 60s response cache for Bloomreach tool calls is *application-level* (a `Map` in `BloomreachDataSource`) and doesn't surface as HTTP cache headers — see `07-timeouts-retries-pooling-and-backpressure.md`.

### Move 3 — the principle

HTTP semantics matter less in modern apps than people who learned them earlier think. Most apps you'll write today are "same-origin GET/POST with JSON bodies and a few cookies for auth." The interesting policy work — what status code means what, what cache directives are honored, what cookie attributes survive a redirect — lives at the *boundaries* (the OAuth callback, the streaming route, the IdP return). The rest is "do what the framework defaults to." When you're stuck debugging an HTTP problem, the answer is almost always in a header you didn't set or a cookie attribute you didn't think through.

## Primary diagram

```
  All HTTP policy in the repo, in one frame

  ┌─ Inbound from browser ─────────────────────────────────────────┐
  │                                                                 │
  │  GET /api/briefing?mode=…           cookies: bi_session+bi_auth │
  │   → 200 ndjson stream                                           │
  │   → 401 { needsAuth, authUrl } JSON  (handler hands back URL)   │
  │   → 500 { error: <msg> } JSON                                   │
  │                                                                 │
  │  GET /api/agent?insightId=…&step=…   same shape                 │
  │  POST /api/mcp/reset                 → 200 { ok }               │
  │  POST /api/mcp/call (debug)          → 200 { result } / 403     │
  │  GET /api/mcp/callback?code=…        → 302 / (cookie set)       │
  │                                                                 │
  │  response headers on streams:                                   │
  │    Content-Type: application/x-ndjson; charset=utf-8            │
  │    Cache-Control: no-store/no-cache, no-transform               │
  │    Set-Cookie: bi_session / bi_auth                              │
  │      httpOnly, Secure, SameSite=None, Path=/                    │
  │                                                                 │
  │  no CORS headers anywhere — all browser fetches are same-origin │
  │                                                                 │
  └─────────────────────────────────────────────────────────────────┘

  ┌─ Outbound from route ──────────────────────────────────────────┐
  │                                                                 │
  │  POST /mcp        (Bloomreach)    Authorization: Bearer <tok>   │
  │                                   Content-Type: application/json│
  │                                                                 │
  │  POST /v1/messages (Anthropic)    x-api-key: <key>              │
  │                                   anthropic-version: <yyyy-mm>  │
  │                                                                 │
  │  outbound bodies/headers redacted before logging                │
  │  (lib/mcp/transport.ts redactSecrets)                           │
  │                                                                 │
  └─────────────────────────────────────────────────────────────────┘
```

## Elaborate

The reason `no-transform` matters more than most engineers realize: Vercel's edge layer (and CDNs in general) will sometimes try to be helpful — content-negotiation, gzip-on-the-fly, even response rewriting for analytics. Any of those that buffer the response before forwarding can delay or break NDJSON streaming, because the user sees a blank screen until the whole response is "ready." `no-transform` is the IETF-blessed way to say "I am responsible for the bytes; don't second-guess them." (RFC 9111 §5.2.2.6, if you're curious.)

The cookie attributes story is one of those areas where browser policy keeps shifting under engineers' feet. SameSite=Lax became the default in Chrome 80 (2020) and broke a lot of OAuth flows that relied on the cookie surviving cross-site returns. The fix in this repo (SameSite=None + Secure) is the modern-correct answer for OAuth flows specifically. The price is that you must be on HTTPS in production, which Vercel is by default.

The "no CORS in the surface area" is itself an architecture decision worth naming: the app could have called Bloomreach directly from the browser (Bloomreach would need to support CORS for that, but most public APIs do). Routing everything through `/api/*` instead gets you: bearer tokens never reach the browser; a single same-origin auth model; the ability to add per-route rate-limiting, auth, observability without changing the client. It costs you one extra hop (browser → route → Bloomreach instead of browser → Bloomreach), but the latency cost is negligible and the security/operational wins are large.

## Interview defense

**Q: Walk me through what headers the streaming routes set, and why.**

```
  Content-Type: application/x-ndjson; charset=utf-8
    → tells the client this is line-delimited JSON, not a normal JSON document
    → useBriefingStream branches on this to pick the stream path

  Cache-Control: no-store, no-transform
    → no-store: never cache (per-user content)
    → no-transform: don't gzip/buffer (would break the stream)

  Transfer-Encoding: chunked  (implicit; runtime sets it)
    → no Content-Length, so the response is open until the server closes it
```

**Anchor:** without `no-transform`, an edge layer that "helpfully" buffers gzip output would defer the first byte until the whole response is in — defeating streaming.

**Q: How does the 401 redirect-to-OAuth flow work end to end?**

```
  fetch('/api/briefing?mode=live-bloomreach')
      ↓
  route: connectMcp(sid) → no tokens → returns {ok:false, authUrl}
      ↓
  route returns 401 with JSON { needsAuth: true, authUrl }
      ↓
  hook reads res.status === 401, parses body, sees needsAuth
      ↓
  window.location.href = authUrl  ← full-page navigation
      ↓
  user authenticates at IdP, returns to /api/mcp/callback
      ↓
  callback completes auth, 302 to /
      ↓
  page loads, briefing call now succeeds with the bi_auth cookie set
```

**Anchor:** the 401 is a *coordination contract*, not just a status code. The hook + the route agreed on the `{needsAuth, authUrl}` shape so the redirect can be triggered from the data layer.

**Q: Why no CORS anywhere?**

Because every browser-side fetch targets `/api/*` on the same origin. Browser only fires CORS for cross-origin. The architecture routes all third-party calls through the server, so the browser never sees `api.bloomreach.com` or `api.anthropic.com`.

## See also

  - `04-tls-and-trust-establishment.md` — for the cookie encryption and the OAuth flow that produces the 401 redirect.
  - `06-websockets-sse-streaming-and-realtime.md` — for what's inside the NDJSON body the headers describe.
  - `.aipe/study-security/` — for the threat model on each header and cookie.

# HTTP semantics, caching, and CORS

**Methods, status codes, headers, cookies, browser policy** · Industry standard

## Zoom out — where this concept lives

HTTP is the protocol the application *thinks* in. Every wire carries HTTP semantics on top of TLS+TCP: methods, status codes, headers, content types. This is the layer where most of the application's wire-format decisions are observable.

```
  Zoom out — HTTP rides every wire

  ┌─ UI band ────────────────────────────────────────────┐
  │  fetch('/api/briefing'), fetch('/api/agent?q=…')     │
  └─────────────────────┬────────────────────────────────┘
                        │  HTTP/1.1 or HTTP/2 over TLS
                        ▼
  ┌─ Service band ───────────────────────────────────────┐ ← we are here
  │  Next.js route handlers                               │
  │  ★ HTTP method · status · headers · body ★            │
  └─────────────────────┬────────────────────────────────┘
                        │  HTTP POST + JSON-RPC envelope
                        ▼
  ┌─ Provider band ──────────────────────────────────────┐
  │  Bloomreach (MCP JSON-RPC) · Anthropic (REST-ish)    │
  └──────────────────────────────────────────────────────┘
```

## Zoom in — the concept

The HTTP contract this app uses, route by route. What methods are exposed, what status codes mean, what headers are load-bearing, what cookies travel, and why **CORS is not configured** — which turns out to be the right answer, but not for the reason people usually assume.

## Structure pass

### Layers

- **Method + URL** — what action is being requested.
- **Headers** — content type, authorization, cookies, cache control.
- **Body** — JSON for short calls; NDJSON byte stream for long-running ones.
- **Status code** — what happened.

### One axis held constant — `is the request safe (cacheable, idempotent)?`

```
  axis = "could the browser or a CDN cache this response?"

  ┌─ GET /api/briefing ──┐  NO  (cache-control: no-store, no-transform)
  │  even though GET     │  → it streams live agent state, caching would
  │                      │    pin the user to a stale briefing
  └──────────────────────┘

  ┌─ GET /api/agent ─────┐  NO  (cache-control: no-cache, no-transform)
  │  same shape           │  → live investigation, no caching
  └──────────────────────┘

  ┌─ POST /api/mcp/call ─┐  NO  (POST never cached by default)
  │                      │  → we explicitly skipCache: true at the data
  │                      │    source layer too
  └──────────────────────┘

  ┌─ GET /api/mcp/callback─┐  one-shot redirect, no caching anywhere
  │  ?code=…                │
  └────────────────────────┘
```

The axis answer is the same across every route: **nothing in this app benefits from HTTP-layer caching**. The cache that matters lives in the application layer (`BloomreachDataSource.cache`, 60s TTL per `tool:args` key — `bloomreach-data-source.ts:122,144-152`), not the HTTP layer.

### Seams

- **Browser ↔ /api/*** — same-origin, so CORS doesn't apply and cookies ride free.
- **Service ↔ Bloomreach MCP** — JSON-RPC envelopes inside HTTP POST. The MCP SDK speaks this.
- **Service ↔ Anthropic** — REST-shaped POST with JSON body and JSON response.

## How it works

### Move 1 — the mental model

HTTP is a request-response protocol where the request is `method + URL + headers + body` and the response is `status + headers + body`. Everything else — chunked transfer, content negotiation, CORS, caching — is convention layered on top of that core. This app uses three patterns:

```
  the three HTTP patterns this app uses

  Pattern A — long-lived NDJSON stream
  ┌──────────────────┐                   ┌────────────────────┐
  │ GET /api/briefing│ ────────────────► │ 200 OK              │
  │ Cookie: bi_auth  │                   │ Content-Type:       │
  │                  │ ◄════════════════ │   application/      │
  │                  │   chunked body    │   x-ndjson          │
  │                  │   over time       │ Cache-Control:      │
  │                  │                   │   no-store,no-trans │
  └──────────────────┘                   └────────────────────┘

  Pattern B — short JSON call (auth-gated)
  ┌──────────────────┐                   ┌────────────────────┐
  │ POST /api/mcp/   │                   │ 200 OK              │
  │     call         │ ────────────────► │ application/json    │
  │ {name, args}     │                   │ {result, durationMs}│
  │                  │ ◄──────────────── │                     │
  │                  │  OR  401 {needsAuth, authUrl}            │
  └──────────────────┘                   └────────────────────┘

  Pattern C — OAuth redirect
  ┌──────────────────┐                   ┌────────────────────┐
  │ GET /api/mcp/    │                   │ 302 Found           │
  │  callback?code=… │ ────────────────► │ Location: /         │
  │                  │ ◄──────────────── │ Set-Cookie: bi_auth │
  └──────────────────┘                   └────────────────────┘
```

### Move 2 — walk the routes

#### Route — `GET /api/briefing`

The largest surface. Two branches inside one handler: demo (replay) and live (real agents). Both return NDJSON. The contract:

```ts
// app/api/briefing/route.ts:330-335
return new Response(stream, {
  headers: {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store, no-transform',
  },
});
```

- `content-type: application/x-ndjson; charset=utf-8` — tells the client this is line-delimited JSON. The client switches behavior based on this header (`useBriefingStream.ts:185-199`).
- `cache-control: no-store, no-transform` — `no-store` keeps any cache (browser, CDN, proxy) from holding it; `no-transform` tells any intermediary not to gzip/recompress mid-stream, which would break the chunk boundaries.

The auth check happens *before* `new Response(stream, …)`. If the user has no MCP session, we return JSON, not a stream:

```ts
// app/api/briefing/route.ts:180-182
if (!dsResult.ok) {
  return NextResponse.json({ needsAuth: true, authUrl: dsResult.authUrl }, { status: 401 });
}
```

That's why the client checks `res.status === 401` *before* it reads the body as a stream (`useBriefingStream.ts:162-171`). The status code is the wire signal for "switch to auth-redirect mode."

#### Route — `GET /api/agent`

Same NDJSON contract. Different content (investigation events instead of briefing events). Different cache header — `no-cache` instead of `no-store`:

```ts
// app/api/agent/route.ts:105-108
const NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
};
```

The split (`no-store` for briefing, `no-cache` for agent) appears unintentional — both routes have the same caching semantics in practice (no caching at all). `no-store` is stricter (never store anywhere); `no-cache` (store but revalidate every time) is operationally equivalent here because no upstream cache is in play. A future cleanup would unify them; today they differ in name only.

#### Route — `POST /api/mcp/call`

The short JSON call pattern. Used by the `/debug` page (when present) for ad-hoc tool calls.

```ts
// app/api/mcp/call/route.ts:22-43
export async function POST(req: NextRequest) {
  try {
    const { name, args } = await req.json();
    if (typeof name !== 'string' || !ALL_KNOWN.has(name)) {
      return NextResponse.json({ error: 'tool not allowed' }, { status: 403 });
    }
    const sid = await getOrCreateSessionId();
    const conn = await connectMcp(sid);
    if (!conn.ok) {
      return NextResponse.json({ needsAuth: true, authUrl: conn.authUrl }, { status: 401 });
    }
    const r = await conn.mcp.callTool(name, args ?? {}, { skipCache: true });
    return NextResponse.json({ result: r.result, durationMs: r.durationMs });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
```

Status code semantics in this route:
- `403` — tool name not in the allowlist (`ALL_KNOWN` is built from `monitoringTools`, `diagnosticTools`, etc.).
- `401` — need to (re)auth; the body carries `authUrl` for the client to redirect.
- `500` — anything else; the body carries the real error message.
- `200` — success.

Note `skipCache: true` — the debug route bypasses the BloomreachDataSource's response cache so it always hits the live server. Cache-bypass is a Bloomreach-specific option (`bloomreach-data-source.ts:23,147-152`); the agent routes don't touch it.

#### Route — `GET /api/mcp/callback`

The OAuth code-exchange endpoint. The IdP redirects the user's browser here with `?code=…`. We exchange the code for tokens and redirect to `/`:

```ts
// app/api/mcp/callback/route.ts:28-34
try {
  await completeAuth(sid, code);
  return NextResponse.redirect(new URL('/', req.url));
} catch (e) {
  return NextResponse.json({ error: String(e) }, { status: 401 });
}
```

The `NextResponse.redirect` returns a `302 Found` with `Location: /`. The `Set-Cookie` for the encrypted token cookie (`bi_auth`) is added by the auth-completion helper (`completeAuth → withAuthCookies`) inside the flow (`lib/mcp/auth.ts:92-102`).

#### Route — `POST /api/mcp/reset`

The other side of the OAuth dance. Drops the stored auth so the next request re-authenticates:

```ts
// app/api/mcp/reset/route.ts:10-15
export async function POST() {
  const sid = await getOrCreateSessionId();
  clearAuth(sid);
  await deleteAuthCookie();
  return NextResponse.json({ ok: true, cleared: true });
}
```

POST is correct here (the operation has a side effect on server state — clearing auth). GET would be wrong (idempotent, no side effects).

#### Cookies — what travels, when, why

Two cookies. Both `httpOnly` (no JS access), both ride every `/api/*` request automatically because everything is same-origin.

```
  Cookie inventory

  bi_session                                bi_auth
  ─────────                                 ───────
  UUID (random)                             encrypted blob (AES-256-GCM)
  httpOnly                                  httpOnly
  prod: Secure + SameSite=None              prod: Secure + SameSite=None
  dev:  no Secure + SameSite=Lax            (no dev variant — dev uses file)
  → lib/mcp/session.ts:10-14                → lib/mcp/auth.ts:92-102

  purpose:                                  purpose:
  identify the session                      hold OAuth tokens + PKCE verifier
  one cookie per browser, stable            + client info across the OAuth
  across the OAuth round-trip               redirect round-trip
```

Why `SameSite=None` on `bi_session` in production: the OAuth callback is a cross-site return from the Bloomreach IdP. A `SameSite=Lax` cookie can drop on that return in some browser/flow combinations. None+Secure keeps it. The same logic applies to `bi_auth` — it has to survive the same return.

In dev (`http://localhost`), `Secure` cookies don't ride non-HTTPS, so we fall back to `SameSite=Lax` without Secure. Same correctness, different fallback.

#### CORS — why nothing is configured

Look at the route handlers. No `Access-Control-Allow-Origin`. No `OPTIONS` handlers. No `next.config` CORS plugin. Nothing.

This is *correct*, and the reason is mechanical:

```
  Why CORS is a no-op for this app

  Browser at:  https://bloominginsights.vercel.app
  Browser to:  https://bloominginsights.vercel.app/api/briefing
                       ┌──────────────────────────────────────────┐
                       │  SAME ORIGIN                             │
                       │  → no preflight, no Origin header check, │
                       │    cookies ride automatically            │
                       └──────────────────────────────────────────┘

  Service to:  https://loomi-mcp-alpha.bloomreach.com/mcp
  Service to:  https://api.anthropic.com/v1/messages
                       ┌──────────────────────────────────────────┐
                       │  SERVER-TO-SERVER                        │
                       │  → CORS doesn't apply, it's a            │
                       │    browser-only policy                   │
                       └──────────────────────────────────────────┘
```

CORS is a *browser* security policy that fires when in-page JavaScript tries to make a cross-origin request. Both conditions absent here:
1. The browser never calls anything outside same-origin.
2. The cross-origin calls happen in Node, where the browser's same-origin policy doesn't exist.

A future deployment that exposes `/api/*` to an embedded iframe on a partner site, or to a different-origin SPA, would change this. Today there's nothing to configure.

### Move 2.5 — the content-negotiation dance

There's no formal content negotiation (`Accept: */*` is whatever the browser defaults to). The server picks the content type and the client switches behavior off it:

```ts
// lib/hooks/useBriefingStream.ts:185-198
const ct = res.headers.get('content-type') ?? '';

// Demo / snapshot path: plain JSON, no live stream.
if (!ct.includes('ndjson') || !res.body) {
  const body = await readBody(res);
  // … render the snapshot statically
  return;
}

// Live path: NDJSON stream — surface monitoring's real status as it runs.
// …
await readNdjson<BriefingEvent>(res.body, handle, { cancelOn: () => cancelledRef.current });
```

The route can return either JSON or NDJSON from the same URL. The client sniffs `Content-Type: application/x-ndjson` to decide which reader to use. That's the entire content-negotiation surface in this app — server-driven, single-header, no `Accept` semantics.

### Move 3 — the principle

**Status codes are the protocol's primary control flow.** A well-designed wire format makes `200` mean "success, parse the body" and reserves `4xx`/`5xx` for branches the client takes *before* it touches the body. This codebase does that consistently: 401 means "redirect to OAuth," 403 means "tool not allowed, give up," 500 means "show me the message." The client never has to read a 200 body to decide what kind of response it got. That's what makes the streaming branch in `useBriefingStream` clean — by the time we get to `readNdjson`, we already know the response is a stream.

## Primary diagram

```
  the recap — every HTTP surface, every contract

  ┌─ /api/briefing ──────────────────────────────────────────────┐
  │  GET                                                         │
  │  →  200 application/x-ndjson · no-store · streaming          │
  │  →  401 application/json · {needsAuth,authUrl}               │
  │  →  500 application/json · {error}                           │
  └──────────────────────────────────────────────────────────────┘

  ┌─ /api/agent ─────────────────────────────────────────────────┐
  │  GET ?insightId / ?q / &step=                                │
  │  →  200 application/x-ndjson · no-cache · streaming          │
  │  →  400 if neither insightId nor q                           │
  │  →  401 application/json · {needsAuth,authUrl}               │
  │  →  404 if insight not found                                 │
  │  →  500 application/json · {error}                           │
  └──────────────────────────────────────────────────────────────┘

  ┌─ /api/mcp/call ──────────────────────────────────────────────┐
  │  POST {name, args}                                           │
  │  →  200 application/json · {result, durationMs}              │
  │  →  401 application/json · {needsAuth, authUrl}              │
  │  →  403 application/json · {error: "tool not allowed"}       │
  │  →  500 application/json · {error}                           │
  └──────────────────────────────────────────────────────────────┘

  ┌─ /api/mcp/callback ──────────────────────────────────────────┐
  │  GET ?code=…                                                 │
  │  →  302 Found · Location: / · Set-Cookie: bi_auth            │
  │  →  401 if code exchange failed                              │
  │  →  400 if no session or code missing                        │
  └──────────────────────────────────────────────────────────────┘

  ┌─ /api/mcp/reset ─────────────────────────────────────────────┐
  │  POST                                                        │
  │  →  200 {ok, cleared} · drops bi_auth cookie                 │
  └──────────────────────────────────────────────────────────────┘

  Cookies (all httpOnly):
    bi_session  — UUID; identifies the session
    bi_auth     — AES-256-GCM blob; OAuth tokens + PKCE verifier (prod only;
                  dev uses .auth-cache.json file)

  CORS: not configured. Correct — every browser request is same-origin;
        every cross-origin call is server-side.

  Caching: no HTTP-layer caching on any route. App-layer cache is
           BloomreachDataSource.cache (60s TTL per tool:args).
```

## Elaborate

What's `not yet exercised`:

- **`ETag` / `If-None-Match`** — conditional GET. None of our responses make sense to cache, so this never gets used.
- **`Vary` header** — would matter if we cached based on cookies/Accept; we don't cache, so it's moot.
- **HTTP/2 server push** — not used. NDJSON is unidirectional; the server pushes via the response body, not via separate H2 push.
- **WebSockets upgrade handshake** — not used (see file 06).
- **OPTIONS preflight** — never triggered because every browser-originated request is same-origin or a simple GET/POST with safe headers.

The `Cache-Control` split (`no-store` on briefing, `no-cache` on agent) is the kind of thing that survives because it's harmless. Unifying it isn't urgent. If we ever put a CDN in front of `/api/*`, we'd want to be deliberate about which one.

## Interview defense

**Q: Why is `/api/briefing` `application/x-ndjson` and not `text/event-stream`?**

> Two reasons, both real. First, NDJSON works with `fetch` + a `ReadableStream` reader, which gives us first-class `AbortSignal` integration — closing the tab cancels the upstream tool call. `EventSource` doesn't take an `AbortSignal`; you have to call `.close()` on the event source object, which doesn't propagate to in-flight `fetch` calls inside the same handler. Second, NDJSON is just JSON-per-line. No reconnect protocol, no Last-Event-ID semantics to fake. We don't need either — when a stream dies, the next page load starts fresh from the cached snapshot in demo mode, or the user clicks reconnect in live mode.

```
  on the whiteboard:

  NDJSON                              SSE (EventSource)
  ───────                             ─────────────────
  fetch(url) → ReadableStream         new EventSource(url)
  AbortSignal cancels upstream        no AbortSignal hook
  parse: split('\n') + JSON.parse     parse: built-in event framing
  POST or GET                         GET only
  any binary up to chunk boundary     text-only
```

Anchor: NDJSON is the simpler primitive when we control both ends.

**Q: Why isn't CORS configured?**

> Because no in-browser code makes a cross-origin request. Every `fetch('/api/…')` from `app/page.tsx` is same-origin. The cross-origin calls (Bloomreach, Anthropic) happen on the server side, where CORS is meaningless — same-origin policy is a browser thing. If we exposed `/api/*` to an embedded SPA on a partner domain, we'd need CORS. We don't, so we don't.

```
  on the whiteboard:

  Browser ─same-origin─► /api/*        (no CORS needed)
  Service ─cross-origin─► Bloomreach   (CORS doesn't apply, server-side)
  Service ─cross-origin─► Anthropic    (same)
```

Anchor: CORS protects browser tabs; our cross-origin code doesn't run in a tab.

**Q: How does the client tell a 401 redirect from a 500 error from a streaming response?**

> Status code first, content-type second. The route checks auth *before* committing to the stream, so 401 always arrives as `application/json` with `{needsAuth, authUrl}` — the client redirects. 500 also arrives as JSON with `{error}`. Only 200 with `Content-Type: application/x-ndjson` triggers the stream reader. That's the entire dispatch in `useBriefingStream` lines 162-199.

```
  on the whiteboard:

  res.status === 401 → window.location = body.authUrl
  res.status !== 200 → setError(body.error)
  ct.includes('ndjson') → readNdjson(res.body, handle)
  else → JSON snapshot path
```

Anchor: status codes drive control flow before the body is touched.

## See also

- `01-network-map.md` — where each route sits on the map
- `06-websockets-sse-streaming-and-realtime.md` — the NDJSON-vs-SSE choice in depth
- `07-timeouts-retries-pooling-and-backpressure.md` — why 401 vs 429 vs timeout trigger different paths
- `study-security/audit.md` — cookie + Authorization flows

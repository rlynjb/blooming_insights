# 05 — HTTP semantics, caching, cookies, and CORS

## Subtitle

HTTP-layer conventions (Industry standard — the headers, cookies, methods, status codes, and cache semantics that carry the app's contracts).

## Zoom out, then zoom in

Most of the interesting decisions in this repo's network layer live in HTTP-level conventions — not TCP, not TLS, not application logic. Cookie flags decide whether the OAuth handshake even completes. `Cache-Control: no-cache` decides whether an intermediary buffers your NDJSON stream (which would kill the whole streaming experience). A custom `x-bi-mcp-config` header decides whether the user's own MCP server plugs in per-request or the deploy-time env wins. Prompt caching rides an inline `cache_control` field in the Anthropic API payload. Every one of these is a header or a cookie doing load-bearing work.

```
  Zoom out — where HTTP semantics live

  ┌─ UI layer ─────────────────────────────────────────────────┐
  │  fetch() sets: x-bi-mcp-config (optional)                  │
  │  browser auto-sends: bi_session + bi_auth cookies          │
  └────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
  ┌─ Service layer (routes) ───────────────────────────────────┐
  │  ★ THIS FILE ★                                             │  ← we are here
  │   response headers:                                        │
  │     Content-Type: application/x-ndjson                     │
  │     Cache-Control: no-cache, no-transform                  │
  │   cookies set:                                             │
  │     bi_session (SameSite=None; Secure; HttpOnly)           │
  │     bi_auth    (SameSite=None; Secure; HttpOnly; encrypted)│
  │   custom headers read:                                     │
  │     x-bi-mcp-config (base64-encoded JSON)                  │
  └──────────┬──────────────────────────────┬──────────────────┘
             │ hop 2                        │ hop 3
             ▼                              ▼
  ┌─ MCP server ──────────────────┐  ┌─ Anthropic ────────────┐
  │  Authorization: Bearer <tok>  │  │  x-api-key + cache_    │
  │  Content-Type: application/json│  │  control: ephemeral   │
  └───────────────────────────────┘  └────────────────────────┘
```

Zoom in — this file walks the HTTP layer: cookies (three of them, each with a different flag story), the custom header transport for MCP config, the streaming Content-Type, the prompt-caching field, and why there's no CORS anywhere.

## Structure pass

**Layers:**
- Client (browser reads cookies, sends fetch)
- Route (sets response headers, reads request headers, sets cookies)
- Upstream MCP (reads bearer, returns JSON)
- Upstream Anthropic (reads API key, respects cache_control marker)

**Axis — TRUST + LIFECYCLE (which cookie flag does what work?):**

```
  "who reads this cookie/header, and how long?" — traced

  bi_session      HttpOnly=true    → server-only, not JS
                  SameSite=None    → survives cross-site OAuth return
                  Secure=true      → HTTPS-only
                  no maxAge        → session cookie
                                     (lives until browser closes)

  bi_auth         same three flags → server-only, cross-site, HTTPS
                  maxAge=10 days   → matches OAuth token lifetime
                  AES-256-GCM      → encrypted content

  x-bi-mcp-config request-only     → not persisted server-side
                  base64(JSON)     → travels ASCII-safe
                  optional         → omitted when localStorage empty

  each has a different lifecycle + trust story
```

**Seams:**
- Seam #1 — the `SameSite=None` boundary: without it the cookies don't survive the OAuth cross-site return.
- Seam #2 — the `x-bi-mcp-config` header vs env config: header wins per-request, env is the fallback.
- Seam #3 — `Cache-Control: no-cache` on the response body: prevents intermediary buffering that would kill streaming.

## How it works

### Move 1 — the mental model

Think of HTTP semantics as **the conventions this codebase leans on to do work that would otherwise need custom protocol machinery.** Cookies for session state. Custom headers for per-request overrides. Content-Type for stream vs JSON dispatching. Cache-Control for keeping the streaming pipe unbuffered. Every one is a standard HTTP-layer knob repurposed for a specific concrete need.

```
  HTTP knobs used by this repo

  request from browser:
    Method:          GET                 (read-only routes)
                     POST                (mutations: /reset, /callback code exchange)
    Cookies:         bi_session, bi_auth
    Custom header:   x-bi-mcp-config     (base64-encoded JSON, optional)
    Body:            none on GET

  response from route:
    Status:          200 (stream / snapshot)
                     401 (auth needed — { needsAuth, authUrl })
                     500 (env misconfig, transport error)
                     404 (anomaly not found)
    Content-Type:    application/x-ndjson (streaming)
                     application/json     (snapshot / errors)
    Cache-Control:   no-cache, no-transform (streaming)
                     no-store, no-transform (demo snapshot)
    Set-Cookie:      bi_session (on first visit)
                     bi_auth    (after OAuth completes)
```

### Move 2 — the walkthrough

#### Cookies — three flags doing three different jobs

The two cookies in this codebase carry cross-site auth state. Both share three flags: `HttpOnly`, `Secure`, `SameSite=None` (in production). Each flag does different work:

- **`HttpOnly=true`** — JavaScript can't read the cookie. XSS can't exfiltrate the OAuth tokens by reading `document.cookie`. Load-bearing for the token-storage story.
- **`Secure=true`** — cookie only transmitted over HTTPS. Matches the TLS story from file 04.
- **`SameSite=None`** — cookie DOES cross site boundaries. Load-bearing for OAuth: the flow leaves for Bloomreach's IdP and comes back; without `SameSite=None`, the browser drops the cookie on the return leg. With it, cookie survives the round-trip.

From `lib/mcp/session.ts:10-14`:

```ts
function sessionCookieOpts() {
  return process.env.NODE_ENV === 'production'
    ? { httpOnly: true, secure: true, sameSite: 'none' as const, path: '/' }
    : { httpOnly: true, sameSite: 'lax' as const, path: '/' };
}
```

And `lib/mcp/auth.ts:93-102`:

```ts
(await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {
  httpOnly: true,
  secure: true,
  // SameSite=None so the PKCE verifier + client info survive the cross-site
  // OAuth return from the IdP to /api/mcp/callback (matches bi_session).
  sameSite: 'none',
  path: '/',
  maxAge: AUTH_COOKIE_MAX_AGE,
});
```

The comment names the exact reason for `SameSite=None`: the PKCE verifier saved during `/api/mcp/connect` has to survive the cross-site round-trip through Bloomreach's IdP so `/api/mcp/callback` can read it and exchange the auth code.

**Dev vs prod flag divergence.** In development, `Secure` is dropped (localhost HTTP wouldn't send `Secure` cookies) and `SameSite` falls back to `Lax` (no cross-site OAuth flow to survive locally). Two flag sets, one call site — the environment picks.

**The `maxAge` story.** `bi_session` has no `maxAge` — it's a session cookie, lives until the browser closes. `bi_auth` has `maxAge: 60 * 60 * 24 * 10` (10 days) to match the OAuth token lifetime. Longer would mean holding stale tokens; shorter would mean re-authenticating more often.

```
  Cookie flag comparison

                   bi_session          bi_auth
                   ──────────          ───────
  HttpOnly         yes                 yes
  Secure           prod: yes           prod: yes
                   dev:  no            dev:  no
  SameSite         prod: none          prod: none
                   dev:  lax           dev:  lax
  maxAge           unset (session)     10 days
  content          UUID (plaintext)    AES-256-GCM ciphertext
                   = user session id   = { clientInformation,
                                         tokens, codeVerifier, state }
```

#### The custom `x-bi-mcp-config` header transport

This is the swappable-MCP surface's client → server transport. The user picks an MCP server URL and auth in the settings modal; that JSON gets base64-encoded and rides a custom header on every subsequent fetch.

Client side, `lib/mcp/config.ts:77-82`:

```ts
export function encodeConfigHeader(config: McpConfigOverride): string {
  const json = JSON.stringify(normalizeConfig(config));
  // btoa is available in browsers; Node has Buffer. Runtime detection.
  if (typeof btoa === 'function') return btoa(json);
  return Buffer.from(json, 'utf8').toString('base64');
}
```

Server side, `lib/mcp/config.ts:87-100`:

```ts
export function decodeConfigHeader(header: string | null | undefined): McpConfigOverride | null {
  if (!header) return null;
  try {
    const json =
      typeof atob === 'function'
        ? atob(header)
        : Buffer.from(header, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    if (!isMcpConfigOverride(parsed)) return null;
    return normalizeConfig(parsed);
  } catch {
    return null;
  }
}
```

Two load-bearing details:

**Base64 encoding.** HTTP header values are ASCII-only by protocol. Base64 lets a future non-ASCII field (unicode URLs, non-Latin bearer tokens) travel safely. Overhead is ~33%, which for a small config object (<200 bytes) is negligible.

**Fail-safe decode.** The whole function is inside a try/catch that returns `null` on any failure — malformed base64, JSON parse error, unknown auth type, wrong field types. The call site (`app/api/agent/route.ts:165`) simply passes the result to `makeDataSource`, which treats `null` as "use env config." A broken header does NOT crash the request; it degrades to env defaults.

The header is only attached when the user has persisted a config. From `lib/hooks/useBriefingStream.ts:164-169`:

```ts
// UI settings modal (Session D) persists MCP config in localStorage;
// send it as a header so the route can override env-driven defaults.
// Unset → header omitted → env-driven behavior preserved.
const mcpHeader = persistedConfigHeader();
const res = await fetch(url, {
  headers: mcpHeader ? { [BI_MCP_CONFIG_HEADER]: mcpHeader } : undefined,
});
```

`persistedConfigHeader()` returns `null` when localStorage is empty — the ternary omits the header entirely. This keeps the default request shape identical to pre-Session-D behavior.

```
  x-bi-mcp-config — client to server transport

  ┌─ browser ──────────────────────────────────────────┐
  │  localStorage['bi:mcp_config']                     │
  │    = '{"url":"https://my/mcp","authType":"bearer"}'│
  │                                                    │
  │  persistedConfigHeader() {                         │
  │    read localStorage → parse → validate            │
  │    → JSON.stringify → btoa(...)                    │
  │    → 'eyJ1cmwiOiJodHRwczovL215L21jcCIsIm...'       │
  │  }                                                 │
  └───────────────────┬────────────────────────────────┘
                      │  fetch(url, {
                      │    headers: {
                      │      'x-bi-mcp-config': '<base64>'
                      │    }
                      │  })
                      ▼
  ┌─ route ────────────────────────────────────────────┐
  │  decodeConfigHeader(req.headers.get(...)) {        │
  │    try {                                           │
  │      atob → JSON.parse → validate                  │
  │      return normalized config                      │
  │    } catch {                                       │
  │      return null  ← FAIL-SAFE                       │
  │    }                                               │
  │  }                                                 │
  │                                                    │
  │  makeDataSource(mode, sid, override_or_null);      │
  │  // null → env-driven behavior; not-null → override│
  └────────────────────────────────────────────────────┘
```

#### Response Content-Type dispatching

The route can return either NDJSON (live stream) or JSON (snapshot / error). The client dispatches on the response's `Content-Type` header. From `lib/hooks/useBriefingStream.ts:196-210`:

```ts
const ct = res.headers.get('content-type') ?? '';

// Demo / snapshot path: plain JSON, no live stream.
if (!ct.includes('ndjson') || !res.body) {
  const body = await readBody(res);
  const data = body as unknown as BriefingResponse;
  // ...
  return;
}

// Live path: NDJSON stream — surface monitoring's real status as it runs.
```

The dispatch is `ct.includes('ndjson')` — matches `application/x-ndjson; charset=utf-8`. Anything else (including a truncated response with no `Content-Type`) falls through to the JSON path, which reads the body defensively via `readBody(res)`:

```ts
async function readBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { __raw: text };
  }
}
```

Empty body → `{}`. Non-JSON body → `{ __raw: text }`. Never throws. This is defensive HTTP handling: a 500 with an HTML body from Vercel's edge doesn't crash the client — it surfaces the raw HTML as the error message.

#### `Cache-Control: no-cache, no-transform` — keeping the stream unbuffered

The NDJSON response uses this pair of directives. `no-cache` tells any intermediary that a cached response should not be reused without revalidation. `no-transform` tells any intermediary NOT to gzip-encode or otherwise modify the response body mid-flight. From `app/api/agent/route.ts:106-109`:

```ts
const NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
};
```

**Why `no-transform` is load-bearing.** If a proxy gzip-encoded the response body, it might buffer bytes until it had enough to compress a full block — potentially seconds or KBs at a time. The stream would land in the browser in bursts instead of a smooth flow. `no-transform` forbids that. For NDJSON specifically, where the JSON-per-line boundary is meaningful and buffering to a block boundary could split lines mid-parse, this is critical.

**Why `no-cache` matters.** An intermediary caching this response could serve a stale run to another user or reuse it after the events are irrelevant. Streams shouldn't be cached.

Demo mode uses stricter directives — `no-store, no-transform` — because a cached demo snapshot has no purpose (the file is on disk; caching is pointless).

#### Prompt caching — `cache_control: { type: 'ephemeral' }`

This isn't an HTTP header, it's a field inside the Anthropic API's JSON request body. But it's a network-layer caching decision — telling the server "please cache this prefix so subsequent requests can skip re-processing it." From `lib/agents/aptkit-adapters.ts:85-89`:

```ts
if (request.system) {
  params.system = [
    { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
  ];
}
```

The system prompt (which is stable across ~5-15 iterations of the ReAct loop within one investigation) gets wrapped in an ephemeral cache breakpoint. First call is a cache_creation (~1.25× normal input cost). Subsequent calls within ~5 min are cache_reads (~0.1× normal input cost). Verified live: `cache_creation_input_tokens 3168` → `cache_read_input_tokens 3168` on the next call.

This is a first-class HTTP-layer optimization living in the request payload. Not something Anthropic caches transparently — the client has to opt in per request.

#### No CORS anywhere

All browser → route calls are same-origin. The React app is served by the same Next.js deployment that hosts the API routes. So the browser never sends an `Origin` header the server needs to check against, never issues an OPTIONS preflight, never sees `Access-Control-*` response headers.

Grep confirms: no `Access-Control-*` strings anywhere in `lib/` or `app/`. This is `not yet exercised` — it becomes relevant if the API layer splits out of the Next.js app.

#### Status codes — the four the app returns

- `200` — success. Either a JSON body (snapshot / query result) or a streaming NDJSON body.
- `401` — auth needed. Response body is `{ needsAuth: true, authUrl: '<bloomreach-idp>' }`. Client redirects to `authUrl`.
- `404` — anomaly not found (only for `/api/agent?insightId=...`).
- `500` — setup error. Response body is `{ error: '...' }`.

From `app/api/agent/route.ts:180`:

```ts
if (!dsResult.ok) return NextResponse.json({ needsAuth: true, authUrl: dsResult.authUrl }, { status: 401 });
```

The 401 pattern is worth naming: it's a normal HTTP status code carrying a redirect URL in the body, NOT a `Location` header. This is because the browser doesn't automatically follow redirects on `fetch()` responses in this flow — the client (`useBriefingStream`) reads the JSON body and calls `window.location.href = body.authUrl` as a top-level navigation. That's the only way the OAuth flow's browser context (cookies, referer) gets propagated correctly.

### Move 3 — the principle

**HTTP is the substrate everyone speaks; use its conventions instead of inventing new ones.** Every load-bearing decision in this layer — the `SameSite=None` for OAuth survival, the `no-cache, no-transform` for stream integrity, the base64 for header safety, the `Content-Type` dispatch — is a standard HTTP concept applied to a specific concrete need. The custom `x-bi-mcp-config` header is the one place the app steps outside standard headers, and even there the payload is base64-encoded JSON, not a bespoke wire format. Building on HTTP's conventions is cheaper than inventing parallel machinery.

## Primary diagram

```
  HTTP-layer semantics — every header/cookie/status doing work

  ┌─ Request from browser ─────────────────────────────────────┐
  │                                                            │
  │  Method:  GET (read routes) / POST (mutations)             │
  │  URL:     /api/briefing?mode=live-mcp                      │
  │                                                            │
  │  Headers (browser auto):                                   │
  │    Cookie: bi_session=<uuid>;                              │
  │            bi_auth=<AES-GCM-ciphertext>                    │
  │                                                            │
  │  Headers (app):                                            │
  │    x-bi-mcp-config: <base64(JSON)> (optional)              │
  │                                                            │
  └────────────────────────┬───────────────────────────────────┘
                           ▼
  ┌─ Route processing ─────────────────────────────────────────┐
  │                                                            │
  │  decodeConfigHeader(req.headers.get(...))                  │
  │    → override or null (fail-safe)                          │
  │                                                            │
  │  withAuthCookies() — decrypt bi_auth, run inside ALS       │
  │                                                            │
  │  makeDataSource(mode, sid, override) → open MCP + Anthropic│
  │                                                            │
  │  Response is one of two shapes:                            │
  │    stream: new ReadableStream + NDJSON_HEADERS             │
  │    error:  NextResponse.json(body, { status })             │
  │                                                            │
  └────────────────────────┬───────────────────────────────────┘
                           ▼
  ┌─ Response to browser ──────────────────────────────────────┐
  │                                                            │
  │  Status: 200 / 401 / 404 / 500                             │
  │                                                            │
  │  Headers:                                                  │
  │    Content-Type: application/x-ndjson; charset=utf-8       │
  │                  application/json (fallback)               │
  │    Cache-Control: no-cache, no-transform (stream)          │
  │                   no-store, no-transform (demo)            │
  │    Set-Cookie: bi_session=<uuid>; HttpOnly; Secure;        │
  │                 SameSite=None; Path=/                      │
  │    Set-Cookie: bi_auth=<AES-GCM>; HttpOnly; Secure;         │
  │                 SameSite=None; Path=/; Max-Age=864000      │
  │                                                            │
  │  Body:                                                     │
  │    stream: {event}\n{event}\n... (writer keeps writing)    │
  │    error:  { needsAuth, authUrl } for 401                  │
  │            { error } for 500                               │
  │                                                            │
  └────────────────────────────────────────────────────────────┘

  Upstream calls (from route, on separate hops):
    hop 2 (MCP):
      Authorization: Bearer <token>
      Content-Type:  application/json (JSON-RPC body)
    hop 3 (Anthropic):
      x-api-key:            <ANTHROPIC_API_KEY>
      anthropic-version:    2023-06-01
      Content-Type:         application/json
      body includes:        system: [{ ..., cache_control: { type: 'ephemeral' } }]
```

## Elaborate

**Why not `SameSite=Lax` for the session cookie?** `Lax` blocks cross-site cookie transmission on all methods except top-level GET navigations. The OAuth return IS a top-level GET navigation (Bloomreach's IdP does a browser-level redirect back to `/api/mcp/callback`), so `Lax` *would* work for that case. The rationale for `None` is broader: any future cross-site scenario (embedding, popup OAuth, etc.) would need `None` anyway, and there's no downside on a cookie that's already `Secure` + `HttpOnly` + carries only a random UUID. Consistency with `bi_auth` (which absolutely needs `None`) is the tiebreaker.

**Why the 401 body pattern instead of a redirect header.** Browsers auto-follow `Location` redirects on `fetch()` by default, but the redirect target (Bloomreach's IdP) would then be fetched *from* the fetch context — CORS would block it, cookies would drop. Returning the URL in the body and letting client code do `window.location.href = authUrl` triggers a top-level navigation, which is what OAuth flows need.

**What prompt caching is doing to the network story.** The `cache_control: ephemeral` marker changes the request payload but not the transport. The upstream server ingests the request, checks its cache for the marked prefix, either counts it as a creation or reads it from cache, and includes the counts in the response's `usage` field. From the client's perspective, only the token counts differ — the wire shape is unchanged. This is the load-bearing detail: prompt caching is a semantic marker on the wire, not a new protocol.

**What's not exercised.** CORS (same-origin app). Preflight OPTIONS handling. `Access-Control-Allow-Credentials`. `Vary` header for cache correctness. `ETag` / `If-None-Match` conditional requests. `Content-Encoding: gzip` on responses (Vercel handles this transparently at the edge for non-streaming responses; streaming responses opt out via `no-transform`).

**Two cookies where one might do.** The split between `bi_session` (identity) and `bi_auth` (auth material) is intentional. If they were one cookie, rotating auth would require re-issuing the identity. Splitting them lets the app treat identity as durable and auth material as ephemeral — refresh tokens, re-auth on expiry, all without a new session id.

## Interview defense

**Q: Walk me through the cookie flags on `bi_auth` and why each one is set.**

Four flags:

```
  HttpOnly: true          → JS can't read; XSS can't steal tokens
  Secure:   true          → HTTPS-only in transit
  SameSite: none          → cookie SURVIVES cross-site OAuth return
                            (without this, dropped by browser on return)
  maxAge:   10 days       → matches OAuth token lifetime
```

Plus AES-256-GCM encryption of the value itself (key derived from `SHA-256(process.env.AUTH_SECRET)`) — because the cookie is stored at rest on the browser's disk, and TLS-in-transit doesn't cover at-rest.

The load-bearing one is `SameSite: none`. Without it, the flow leaves for Bloomreach's IdP, comes back to `/api/mcp/callback`, and the browser drops the cookie on the return leg — the callback route sees "no session" and 400s. `SameSite=Lax` might work for the return leg specifically (top-level GET), but consistency with the broader cross-site story tipped it to `None`.

Anchor: `lib/mcp/auth.ts:93-102`.

**Q: A user's `x-bi-mcp-config` header is malformed — how does the app respond?**

Fail-safe fallthrough. `decodeConfigHeader` catches any error (base64 decode failure, JSON parse error, unknown auth type, wrong field types) and returns `null`. The route site passes `null` to `makeDataSource`, which treats it as "use env config" — the same code path as a request that never sent the header.

The malformed header does NOT crash the request. It degrades to env-driven behavior transparently. This is intentional: a portfolio visitor who breaks their localStorage config still gets a working experience against the deploy's default MCP.

```ts
// lib/mcp/config.ts:87-100
export function decodeConfigHeader(header: string | null | undefined): McpConfigOverride | null {
  if (!header) return null;
  try {
    // ... decode + parse + validate ...
    return normalizeConfig(parsed);
  } catch {
    return null;  // fail-safe: any error → env-driven
  }
}
```

Anchor: `lib/mcp/config.ts:87-100`.

**Q: Why `no-cache, no-transform` on the streaming response?**

Both directives protect the streaming semantics from intermediary interference. `no-cache` prevents any proxy or CDN from caching the response and serving a stale run to another user. `no-transform` prevents any intermediary from re-encoding the body — critically, gzip-encoding it, which would buffer bytes to compressible block boundaries and destroy the smooth event-by-event flow.

For NDJSON specifically, where the `\n` boundary is meaningful and the client parses one line at a time, an intermediary buffering bytes to a block boundary could split lines mid-parse. `no-transform` forbids that.

Anchor: `app/api/agent/route.ts:106-109`.

## See also

- `06-websockets-sse-streaming-and-realtime.md` — the streaming semantics that `no-cache, no-transform` protects
- `04-tls-and-trust-establishment.md` — the `Secure` cookie flag and its TLS story
- `02-dns-routing-and-addressing.md` — how `x-forwarded-*` headers relate to the origin/cookie story
- `study-security` — the same cookie flags seen from "is this safe?" rather than "what does each flag do?"

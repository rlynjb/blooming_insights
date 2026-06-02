# HTTP semantics, caching, and CORS

**Industry name(s):** HTTP/1.1 + HTTP/2 semantics, response caching, browser cookie policy, CORS / SOP
**Type:** Industry standard · Language-agnostic

> Methods are plain (GET reads, POST mutates), status codes follow the conventions that drive client logic (401 → re-auth, 307 → would silently strip auth, hence avoided), and the only places HTTP semantics are *load-bearing* are: the streaming `Cache-Control` headers, the two cookies that hold the system together, and the deliberate absence of any CORS surface.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** HTTP semantics in this app boil down to four things you actually read or write: the **methods** on each route (mostly GET for streams, POST for mutations + the debug call), the **status codes** the client switches on (200 with a stream, 401 with `needsAuth`, 500 with a stack), the **headers** that make streaming work (`Content-Type: application/x-ndjson`, `Cache-Control: no-cache, no-transform`), and the **cookies** that carry session and encrypted auth state across requests.

```
Zoom out — HTTP semantics by route

┌─ UI band ──────────────────────────────────────────────────────────┐
│  fetch('/api/...')  — same-origin, no CORS preflight, cookies auto │
└────────────────┬───────────────────────────────────────────────────┘
                 │
┌─ Service band ─▼──────────────────────────────────────────────────┐
│  GET  /api/briefing               → 200 + NDJSON stream            │
│  GET  /api/briefing?demo=cached   → 200 + NDJSON stream (replay)   │
│  GET  /api/agent?insightId=…      → 200 + NDJSON stream            │
│  GET  /api/mcp/tools               → 200 + JSON                    │
│  GET  /api/mcp/callback?code=…    → 302 redirect to /              │
│  POST /api/mcp/call                → 200 + JSON                    │
│  POST /api/mcp/reset               → 200 + JSON                    │
│  POST /api/mcp/capture-demo        → 200 + JSON                    │
│                                                                    │
│  every route may return 401 { needsAuth, authUrl }                 │
│  every route may return 500 { error: "..." }                       │
└────────────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this file answers: which HTTP semantics is the client code actually relying on, which are absent on purpose, and which carry load-bearing behaviour the rest of the system depends on? The CORS section is short because every browser call is same-origin; the caching section is short because we set `no-cache, no-transform` and that's the whole policy.

---

## Structure pass

**Layers.** Four layers where HTTP semantics live. **Method** (HTTP verb on the route). **Status** (the code the route returns; the client `switch`es on it). **Headers** (`Content-Type`, `Cache-Control`, cookies, `X-Forwarded-Host`). **Body** (JSON for one-shot routes, NDJSON for streams).

**Axis: control.** Trace "who decides what happens next?" across the four layers. **Method:** the client decides (GET vs POST). **Status:** the server decides; the client routes on it (401 → navigate to `authUrl`, 200 → start reading body, 500 → show error). **Headers:** mostly the server (sets `Content-Type`, `Cache-Control`, `Set-Cookie`); a few the platform sets for us (`X-Forwarded-Host`). **Body:** the server formats; the client parses. The interesting flip is at status code: a 401 is the *only* code that turns a regular request into a navigation (`window.location.href = authUrl`); every other code stays inside the fetch handler.

**Seams.** Three seams matter.

  → **Seam 1 (load-bearing for streaming): `Cache-Control` directive.** Without `no-transform`, Vercel's edge may gzip-rechunk or buffer the stream, and the UI sees nothing until the whole run finishes. The directive is the contract that keeps the producer/consumer pipe live.
  → **Seam 2 (load-bearing for auth liveness): cookie attributes.** `httpOnly + Secure + SameSite=None` on `bi_session` and `bi_auth` is what makes the cross-site OAuth round-trip work in production without exposing tokens to JS. Get any one of those wrong and the OAuth flow silently drops the cookie.
  → **Seam 3: status code → client behaviour.** 401 means "navigate to `authUrl`"; 500 means "render error in the existing view." The client trusts the server to use these correctly; the routes deliberately don't return 401 for tool errors (they go in the NDJSON `error` event instead, see seam-1 in the streaming file).

```
Three HTTP-semantics seams

  seam                              what flips                load-bearing?
  ────                              ──────────                 ─────────────
  Cache-Control directive           buffered → live            yes (streaming)
  cookie attributes                 dropped → carried          yes (auth)
  status code → client routing      stay in fetch → navigate   yes (401 only)
```

The skeleton is mapped — the rest walks each.

---

## How it works

### Mental model

HTTP semantics here is "use the conventions everyone knows, and don't fight the platform." GETs for things you can replay safely (a stream, an introspection, a callback), POSTs for things that mutate state. Status codes that the browser's fetch API + your client's `switch` already know how to handle (200/401/500). Headers that opt out of two specific platform behaviours (edge buffering, gzip transformation) without inventing new contracts. Cookies that survive a cross-site round-trip in production without being readable from JS.

```
The shape — what each piece of HTTP carries

  ┌────────────────────────────────────────────────────────────────┐
  │  method:  intent (GET=read, POST=mutate)                       │
  │  status:  what the client should do next                       │
  │  headers: how to read the body + auth state                    │
  │  body:    the actual content (JSON or NDJSON)                  │
  └────────────────────────────────────────────────────────────────┘
```

### Move 2 walkthrough

**Methods — GET for streams, POST for mutations, no PUT/DELETE/PATCH.** Long-running streams are GETs because they're idempotent reads (running an agent over an anomaly should be cacheable / replayable; we even cache one). Debug tool calls, OAuth reset, demo capture are POSTs because they mutate (or have side effects we want POST's "non-idempotent by convention" semantics for — POST doesn't get cached, prefetched, or replayed by the browser). We don't use PUT or PATCH because we have no resources to update in a REST-ful sense; the only "state" is cookies (which `Set-Cookie` handles) and the in-process Map cache (which has no HTTP surface).

```
Pseudocode — method → semantics

  GET /api/briefing              → safe to refresh, browser may
                                    prefetch, fine to cache (we set
                                    no-cache anyway because demo replays
                                    are different bytes per call)
  GET /api/agent?…                → same as above, with a `live=1`
                                    query param when bypassing the cache
  POST /api/mcp/reset             → side effect (delete cookie); browser
                                    will NOT prefetch or replay
  POST /api/mcp/capture-demo      → side effect (write to disk in dev)
```

**Status codes — three load-bearing values: 200, 302, 401.** Every successful request returns 200, even when the response body carries an in-band error (like a stream's final `{type:"error",…}` line — the headers already went, we can't change the status). The OAuth callback returns 302 to `/` after exchanging the code, because the browser was navigated to the callback URL and needs to be sent back to the app. The 401 is the only "negotiate-with-the-user" status code — the client redirects on it.

```
Status-code → client decision tree

  fetch(/api/...)
    ├── 200 + ndjson body → start reader loop
    ├── 200 + json body   → setState(body)
    ├── 302 (OAuth cb)    → browser auto-follows, lands on /
    ├── 401 + needsAuth   → window.location.href = body.authUrl
    ├── 500 + error       → setError(body.error)
    └── network error     → setError('http n/a')
```

The boundary that catches people: 401 is *only* returned on auth failure to the user (no tokens, expired tokens). Tool-level failures (Bloomreach returned `isError: true`) go into the NDJSON `error` event with a 200 status, because we already started streaming. Mixing those would force a different client path.

**Headers — the streaming contract.** Two headers make NDJSON streaming work:

```
Streaming response headers — load-bearing

  Content-Type: application/x-ndjson; charset=utf-8
              │
              └─ the consumer uses this (in app/page.tsx) to choose
                 between the NDJSON reader loop and a plain-JSON parse:
                 `if (!ct.includes('ndjson') || !res.body) { …json
                  fallback… }`. Without it the fallback runs and the
                 stream is buffered to completion before parsing.

  Cache-Control: no-cache, no-transform
              │  └─ no-cache: don't serve a stale response from any
              │     intermediate cache (browser, edge); always revalidate.
              │  
              └────── no-transform: ★ load-bearing ★. Tells edges and
                      proxies NOT to rewrite the body. Without this,
                      Vercel's edge may gzip-rechunk the stream, which
                      breaks the producer/consumer pipe — the UI sees
                      nothing until the whole 60s run finishes.
```

**Cookies — two cookies, two purposes, four attributes that matter.** `bi_session` is a UUID (server-generated, never re-used) that identifies "which session is this browser?" — keyed into the auth store. `bi_auth` is the encrypted store itself (in production). Both cookies use the same attribute set: `httpOnly` (JS cannot read them), `Secure` (production only; only ride on TLS), `SameSite=None` (production only; survive cross-site OAuth bounce) or `SameSite=Lax` (development; localhost is HTTP so `Secure` would drop the cookie entirely).

```
Cookie matrix — what each attribute prevents

  attribute       prevents                              if missing
  ─────────       ────────                              ──────────
  httpOnly        document.cookie read in page          XSS can steal token
  Secure          send over HTTP                        MITM can read token
  SameSite=None   drop on cross-site request            OAuth callback breaks
  SameSite=Lax    send on top-level GET only            (dev fallback only)
  
  why dev uses Lax + no Secure: localhost is HTTP, so
  Secure=true cookies would never be sent at all.
```

The cross-site OAuth round-trip is the single reason for `SameSite=None` in production. The user navigates to Bloomreach (different origin), authenticates, gets 302'd back to `/api/mcp/callback?code=…`. That return navigation is *cross-site* (initiated by Bloomreach's IdP, not our app). With `SameSite=Lax` the browser would refuse to send `bi_session`/`bi_auth` on the cross-site return in some browsers, and our callback would see "no session" / no PKCE verifier.

**CORS — absent on purpose.** Every browser → API call is same-origin (`/api/*` on the same host as the page). No CORS preflight, no `Access-Control-Allow-Origin` headers anywhere. We don't need them. If a future feature needed a different origin (a third-party widget calling our API), we'd add an explicit allowlist; today the absence is correct.

```
Same-origin policy in this app

  Page origin:    https://<app>.vercel.app
  API origin:     https://<app>.vercel.app
                  ─────── same ───────
  Cookies auto-included. No preflight. No CORS headers needed.
  
  We deliberately do NOT expose any cross-origin endpoint.
  Adding one later requires: 1) Access-Control-Allow-Origin + Credentials,
  2) the preflight OPTIONS handler, 3) SameSite=None on relevant cookies
  (already true here).
```

### Principle

HTTP is a contract between you and the platform. Use the verbs the way browsers expect (GET safe, POST mutating, no body on GET); use the status codes the client library already routes on (200/302/401/500 are first-class); set the headers that opt out of platform behaviours you don't want (`no-transform` for streams, `Secure+HttpOnly+SameSite` for cookies). Don't invent new conventions when the existing ones land for free.

---

## Primary diagram

The recap — every HTTP-semantics decision in one frame.

```
HTTP semantics — full recap

UI band ──────────────────────────────────────────────────────────
┌────────────────────────────────────────────────────────────────┐
│  fetch(...) → routes on response.status + Content-Type         │
│  cookies auto-included on same-origin                          │
│  401 → window.location.href = body.authUrl                     │
│  500 → setError(body.error)                                    │
│  200 + ndjson → reader loop                                    │
│  200 + json → setState                                         │
└─────────────────────────┬──────────────────────────────────────┘
                          │
Service band ─────────────▼──────────────────────────────────────
┌────────────────────────────────────────────────────────────────┐
│  Routes:                                                        │
│   GET  /api/briefing (?demo=cached)  → NDJSON stream OR JSON   │
│   GET  /api/agent (live or cached)    → NDJSON stream           │
│   GET  /api/mcp/callback              → 302 to /                │
│   GET  /api/mcp/tools                  → JSON                    │
│   POST /api/mcp/call                   → JSON                    │
│   POST /api/mcp/reset                  → JSON {ok:true}          │
│   POST /api/mcp/capture-demo           → JSON                    │
│                                                                 │
│  Streaming headers (load-bearing):                              │
│    Content-Type: application/x-ndjson; charset=utf-8            │
│    Cache-Control: no-cache, no-transform                        │
│                                                                 │
│  Cookies set / read:                                            │
│    bi_session = uuid (httpOnly, Secure*, SameSite=None*)        │
│    bi_auth    = AES-256-GCM blob (same attributes)              │
│      *prod only; dev uses Lax + no Secure (HTTP localhost)      │
│                                                                 │
│  No CORS surface (same-origin only).                            │
└────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases

  → **Demo / live toggle.** The same `GET /api/briefing` route returns plain JSON for the demo replay (when the snapshot has no NDJSON format) or NDJSON for live. The client checks `Content-Type` and picks a path: stream reader vs `setState(body)`.
  → **Auth challenge.** Any route call that finds no tokens returns `401 + { needsAuth, authUrl }` BEFORE committing to a stream. The client redirects the browser.
  → **Token revocation mid-stream.** If Bloomreach revokes the token mid-investigation, the route emits `{type:"error", message:"invalid_token …"}` into the NDJSON (it can't change a 200 to a 401 after headers went). The client detects the message pattern and self-reconnects.

### The two `NDJSON_HEADERS` blocks (load-bearing for streaming liveness)

```
app/api/agent/route.ts  (lines 107-110)

const NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson; charset=utf-8',
       │
       └─ tells the consumer "treat me as line-delimited JSON, not
          a single JSON document." The hook checks this exact string
          to decide between the reader loop and a json fallback.
  'Cache-Control': 'no-cache, no-transform',
       │           │
       │           └─ ★ load-bearing ★ — without no-transform, Vercel's
       │              edge may buffer or gzip-rechunk the stream and
       │              the UI sees no events until the full 60s run
       │              finishes. The producer/consumer pipe breaks.
       │
       └─ no-cache: forbid caching the response (relevant for the
          rare case where an intermediate proxy might try). The replay
          path emits the same NDJSON shape but different bytes per call
          (timestamps in the IDs), so caching would be wrong anyway.
};
```

```
app/api/briefing/route.ts  (lines 144-149 and 259-264)

return new Response(stream, {
  headers: {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store, no-transform',
                     │
                     └─ briefing uses no-store (stronger than no-cache:
                        also forbids caching in any form). Same intent:
                        every briefing call returns the freshest live
                        scan (or freshest replay).
  },
});
```

### The auth challenge — 401 + `needsAuth` + `authUrl`

```
app/api/agent/route.ts  (line 166)

if (!conn.ok) return NextResponse.json({ needsAuth: true, authUrl: conn.authUrl }, { status: 401 });
                                       │
                                       └─ the structured 401 body is the
                                          contract with the client: it
                                          looks for needsAuth=true and
                                          authUrl, then does a full-page
                                          redirect. The status alone
                                          isn't enough; the body carries
                                          the IdP target.
```

```
lib/hooks/useInvestigation.ts  (lines 171-177)

if (res.status === 401) {
  const b = await res.json().catch(() => ({}));
  if (b?.needsAuth && b?.authUrl) {
    window.location.href = b.authUrl as string;
                       │
                       └─ status code + body shape together drive a
                          NAVIGATION, not a state update. This is the
                          only place in the client where a non-200
                          response triggers a side effect outside the
                          fetch handler.
    return;
  }
}
```

### The cookie attribute matrix in one place

```
lib/mcp/session.ts  (lines 10-14)
lib/mcp/auth.ts     (lines 91-101)

production:                       development:
  httpOnly: true                    httpOnly: true
  secure: true                      sameSite: 'lax'
  sameSite: 'none'                  path: '/'
  path: '/'                         (no secure, no maxAge for session)
  maxAge: 10 days (for bi_auth)
       │
       └─ matches the Bloomreach refresh-token lifetime; longer than
          the session cookie because we want OAuth tokens to survive
          a browser restart without re-auth. The session cookie has
          no maxAge — it's a session cookie in the literal HTTP sense.
```

### No CORS headers anywhere

A grep for `Access-Control-` across `app/api/` returns no hits. The verdict is `not yet exercised`; if we needed a cross-origin client (a third-party widget, a separate frontend on a different domain), we'd add an allowlist + preflight handler. Today the same-origin assumption is correct and the absence is intentional.

---

## Elaborate

HTTP/2 multiplexing and the `no-transform` directive interact in a specific way: when Vercel's edge terminates TLS and re-emits HTTP/2 to the browser, it controls framing. `no-transform` tells it "don't decompose my body into different chunks than I wrote." We never proved this empirically — the directive is defensive based on documented Vercel behaviour.

The choice of `no-store` (briefing) vs `no-cache` (agent) is a minor inconsistency. `no-store` is stricter (never cache anywhere), `no-cache` requires revalidation. For these streaming responses, both achieve the goal of "never serve a stale stream." `no-store` is slightly safer; we should probably unify on it. Not worth a refactor on its own.

The 302 on the OAuth callback is the one place in this app where we use a "browser-driven" status code (one that the browser action-on-receive: follow the Location header). Everything else is JSON-bodied for the client to parse.

---

## Interview defense

**Q1: Why GET for the agent route — isn't that mutating?**

The agent route reads from upstreams and renders. It doesn't mutate user-visible state (no DB writes; the in-process Map cache is purely a perf optimization, not a state change observable to the next request). GET is correct semantically: idempotent (mostly — modulo cache effects), safe to retry, replayable from cache. POST would be wrong because it would suggest "create something."

**Q2: What's the contract that keeps streaming live across the edge?**

`Cache-Control: no-cache, no-transform`. The `no-transform` part is load-bearing — without it, Vercel's edge may buffer or recompress the chunked body, and the UI sees nothing until the producer closes. With it, every `controller.enqueue` flushes a chunk to the browser in real time.

```
Diagram-while-you-speak

  producer.enqueue ── (no-transform) ──► edge passes through ── browser receives
                       │
                       └─ without it: edge may buffer until close
```

Anchor: "the directive tells edges not to rewrite your body — and streams break if edges rewrite."

**Q3: Why SameSite=None in production?**

The OAuth callback is a cross-site return: Bloomreach's IdP 302s the browser to `/api/mcp/callback`. That return navigation is initiated by a different origin, so with SameSite=Lax the browser may drop our `bi_session` and `bi_auth` cookies. SameSite=None lets them ride. The cost is: we *must* pair SameSite=None with Secure (modern browsers require it), and that's fine because production is HTTPS-only.

---

## Validate

  1. **Reconstruct.** List every route, its method, and its possible response status codes from memory. Compare to the recap diagram.
  2. **Explain.** Why does the agent route return `200 + {type:"error"}` in the stream for a Bloomreach tool failure, instead of a 5xx? Trace the consequence on the client side.
  3. **Apply.** A teammate proposes adding a `DELETE /api/insights/:id` endpoint. Argue for or against — what would the client need to do, and what would change about our cookies / status semantics?
  4. **Defend.** Why is `no-transform` load-bearing? Construct the failure: without it, what does the user see, and at what timestamp?

---

## See also

  → `01-network-map.md` — every route's hop diagram.
  → `04-tls-and-trust-establishment.md` — the cookie crypto these attributes wrap.
  → `06-websockets-sse-streaming-and-realtime.md` — why NDJSON over GET and not SSE.
  → `../study-system-design/05-streaming-ndjson.md` — the bytes-on-the-wire framing.

# HTTP semantics, caching, and CORS

*HTTP protocol behavior (Industry standard)* — methods, status codes,
headers, cookies, caching, browser same-origin policy, and the
provider-side prompt caching that rides on the Anthropic hop.

## Zoom out — where this concept lives

The routes touch every HTTP concern that matters here: method choice
(GET streams, POST mutations), status codes (401 with a `needsAuth`
JSON envelope before committing to a stream), cache control
(`no-store, no-transform` on NDJSON so no intermediate buffers), cookies
(three kinds with different `SameSite`), and the one provider-side
caching optimization — Anthropic's ephemeral prompt cache — that turns
a 90% saving from a single `cache_control` block.

```
  Zoom out — HTTP-layer concerns and where they live

  ┌─ Browser ─────────────────────────────────────────────────────┐
  │  fetch() with implicit Cookie: bi_session; bi_auth              │
  │  reads Content-Type to pick NDJSON vs JSON branch                │
  └───────────────────────┬───────────────────────────────────────┘
                          │  hop 1: GET /api/{briefing,agent}?…
                          │         POST /api/mcp/{reset,call,capture}
                          ▼
  ┌─ Next routes (Node) ──────────────────────────────────────────┐
  │  ★ HTTP SEMANTICS LIVE HERE ★                                  │
  │  method routing (route.ts GET/POST exports)                    │
  │  401 needsAuth JSON envelope before stream commit               │
  │  Content-Type: application/x-ndjson                             │
  │  Cache-Control: no-store, no-transform                          │
  │  Set-Cookie: bi_session, bi_auth with SameSite=None + Secure    │
  └───┬───────────────────────────────────────────┬───────────────┘
      │  hop 2: JSON-RPC over HTTPS                │  hop 3: HTTPS + prompt cache
      ▼                                            ▼
  ┌─ Bloomreach ──────┐                     ┌─ Anthropic ────────┐
  │ Authorization:    │                     │ Authorization:      │
  │ Bearer <token>    │                     │ Bearer <key>        │
  │                   │                     │ system prefix       │
  │                   │                     │ cache_control:      │
  │                   │                     │   ephemeral         │
  └───────────────────┘                     └─────────────────────┘
```

Same-origin app; no CORS in play. Cookies do the heavy lifting for
identity and cross-site OAuth return. NDJSON is the streaming payload.

## The structure pass

The axis: **who caches what**. HTTP has many caching layers; this repo
uses exactly two.

```
  Axis: "at each hop, does anything cache the response?"

  ┌─────────────────────────────────────────┐
  │ browser → route                          │  → NO CACHE
  │ Cache-Control: no-store, no-transform    │    (streaming: caching
  │                                          │    would break reveal)
  └─────────────────────────────────────────┘
      ┌──────────────────────────────────────┐
      │ route → Bloomreach                   │  → APP CACHE
      │ 60s in-memory response cache          │    (BloomreachDataSource
      │ per (name+args)                        │    cache Map)
      └──────────────────────────────────────┘
          ┌──────────────────────────────────┐
          │ route → Anthropic                │  → PROVIDER CACHE
          │ ephemeral prompt cache            │    (Anthropic's server-side,
          │ 5-min TTL on system prefix        │    5-min TTL, driven by
          │                                   │    cache_control header)
          └──────────────────────────────────┘
              ┌──────────────────────────────┐
              │ Vercel edge / CDN            │  → BYPASSED
              │ (would cache if allowed)     │    (no-store, no-transform
              │                              │    passes through)
              └──────────────────────────────┘
```

Two effective caching layers, each at a different altitude, each with a
different TTL and eviction policy. That's the whole caching story.

## How it works

### Move 1 — the mental model

You've set `Cache-Control` headers on API responses before. This repo
uses two extremes: aggressive `no-store, no-transform` on the streaming
routes (you *don't* want an intermediate proxy to buffer a stream),
and app-level in-memory caching everywhere the response is small and
stable enough to reuse. And there's one third caching layer that lives
entirely on the LLM provider — Anthropic's server caches the system
prompt prefix if you tag it with a `cache_control` breakpoint.

```
  The pattern — three caches at three altitudes

  no-store on the stream ─┐
                          │
  60s app cache on tools ─┼──►  each layer has its own TTL and scope
                          │
  5-min provider cache ───┘
  on Anthropic prefix
```

### Move 2 — the HTTP surface, one concern at a time

#### Methods — GET for streams, POST for mutations

The routes divide by method:

  - `GET /api/briefing` — the streaming monitoring scan (`app/api/briefing/route.ts:77`)
  - `GET /api/agent` — the streaming investigation / query (`app/api/agent/route.ts:110`)
  - `GET /api/mcp/callback` — OAuth callback (`app/api/mcp/callback/route.ts:5`)
  - `POST /api/mcp/reset` — auth teardown

`GET` for the streams matters — the browser (and any intermediate) can
cache GET responses under the right headers, but never POST. The
`no-store` header opts out of caching. GET also lets the URL carry all
state, which is why `?mode=live-bloomreach&insight=…&step=diagnose`
works as a full state carrier.

#### Status codes — 401 with a JSON envelope

The interesting decision: return `401` *before* committing to a stream,
with a JSON body the client can parse (`briefing/route.ts:180-182`):

```ts
  if (!dsResult.ok) {
    return NextResponse.json({ needsAuth: true, authUrl: dsResult.authUrl }, { status: 401 });
  }
```

Then commit to the stream only after auth is confirmed. This matters
because you can't cleanly signal "please redirect for auth" *inside* an
NDJSON stream — the client can't do a full-page navigation while
consuming a stream, and if the client tries, the browser may not
attach the fresh cookies. Returning 401 before the stream lets the
client redirect fully.

Client picks it up (`useBriefingStream.ts:162-171`):

```ts
  if (res.status === 401) {
    const body = await readBody(res);
    if (body?.needsAuth && body?.authUrl) {
      window.location.href = body.authUrl as string;
      return;
    }
    setErrorMessage('authentication required');
    setStatus('error');
    return;
  }
```

The client checks *before* it starts reading the body stream, so no
partial NDJSON is consumed.

#### Content-Type — the branch discriminator

`application/x-ndjson; charset=utf-8` on the live path
(`briefing/route.ts:148`), `application/json` on the demo snapshot path
(implicit via `NextResponse.json`). The client sniffs and branches
(`useBriefingStream.ts:185-199`):

```ts
  const ct = res.headers.get('content-type') ?? '';
  // Demo / snapshot path: plain JSON, no live stream.
  if (!ct.includes('ndjson') || !res.body) {
    const body = await readBody(res);
    // …consume as one JSON object…
    return;
  }
  // Live path: NDJSON stream…
  await readNdjson<BriefingEvent>(res.body, handle, ...);
```

One field, two response shapes, one client that gracefully handles
either. If the route ever falls back to plain JSON (e.g. the demo
snapshot file is malformed and the route serves a JSON error), the
client still functions.

#### Cache-Control — deliberate no-caching on streams

Both streaming routes emit `Cache-Control: no-store, no-transform`
(`briefing/route.ts:149, 333`; `agent/route.ts:107`). Why both directives?

  - `no-store` — the response must not be cached. Full stop.
  - `no-transform` — the response must not be transformed. Critically,
    this stops intermediaries from *buffering* the stream and
    re-delivering it as one payload. A proxy that decompresses, buffers,
    and re-emits chunks kills the progressive reveal.

Without `no-transform`, a helpful intermediary could turn a
streaming NDJSON response into a single 30s wait followed by 15 events
delivered at once. `no-transform` is the tell that this is a stream.

#### Cookies — three cookies, three roles

The full cookie inventory:

```
  cookie inventory in this repo

  ┌──────────────┬──────────────────────────────────────────────────┐
  │ name         │ role, options                                     │
  ├──────────────┼──────────────────────────────────────────────────┤
  │ bi_session   │ session id (UUID)                                 │
  │              │ httpOnly, SameSite=none, Secure (prod)            │
  │              │ SameSite=lax (dev, no Secure)                     │
  │              │ set on first request; long-lived                  │
  ├──────────────┼──────────────────────────────────────────────────┤
  │ bi_auth      │ AES-256-GCM ciphertext of OAuth state per session │
  │              │ httpOnly, SameSite=none, Secure                    │
  │              │ maxAge = 10 days                                   │
  │              │ prod only (dev uses .auth-cache.json file)         │
  ├──────────────┼──────────────────────────────────────────────────┤
  │ bi:reconnecting │ localStorage flag (not a cookie),               │
  │  bi:mode        │ but shape-adjacent — the client-side one-shot   │
  │                 │ guards and mode persistence                      │
  └──────────────┴──────────────────────────────────────────────────┘
```

The `SameSite=none` decision is documented in
`session.ts:6-9`:

> SameSite=Lax can drop the cookie on that return in some browsers/flows,
> so use SameSite=None + Secure on HTTPS. Locally (http://localhost)
> Secure cookies aren't sent, so fall back to Lax without Secure.

The dev fallback to Lax is a *dev-only concession*, because `Secure`
requires HTTPS and localhost is HTTP. The tradeoff is that in dev, the
cookie may drop on cross-site returns — but you'd rarely test the OAuth
flow that way in dev anyway.

#### CORS — deliberately absent

Grep for `Access-Control` across the repo: zero hits. The whole app is
same-origin (Next app + its own routes), so CORS never fires. The
`no-store` and `Content-Type` headers do the heavy lifting for the
browser's behavior; CORS wouldn't add anything.

**When it becomes relevant**: if a third-party app ever consumed
`/api/briefing` directly, CORS headers would need to be emitted, and
the cookie-based auth would need to be reworked (`SameSite=None`
cookies from a third-party origin have their own rules).

### The provider cache — Anthropic's ephemeral prefix

The one provider-side caching mechanism this repo actively uses.
Full walk at `lib/agents/aptkit-adapters.ts:74-89`:

```ts
    // Phase-3 prompt caching. The system prompt is stable across every call
    // within an investigation (all ~5-15 ReAct-loop iterations reuse it) and
    // is the largest fixed prefix in the payload. Wrapping it in an ephemeral
    // cache breakpoint makes the first call a cache_creation (~1.25× normal
    // input cost) and every subsequent call within 5 min a cache_read
    // (~0.1× normal). For a diagnostic run's ~10 model turns this is roughly
    // an 80% reduction on the system-prompt token cost.
    //
    // Tools are also stable across the loop but the Anthropic API caches
    // tools transparently when the SAME breakpoint is set on the system
    // prompt — so this one addition covers both prefixes.
    if (request.system) {
      params.system = [
        { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
      ];
    }
```

Layers and hops for the caching cycle:

```
  Ephemeral prompt cache — first call vs subsequent

  Call #1 (cache miss)
  ┌─ Route ────────────────────────────────┐
  │  anthropic.messages.create({           │
  │    system: [{ text, cache_control:     │
  │              { type: 'ephemeral' } }]  │
  │    …                                    │
  │  })                                     │
  └────────────┬───────────────────────────┘
               │  HTTPS
               ▼
  ┌─ Anthropic API ────────────────────────┐
  │  reads breakpoint → hashes prefix       │
  │  stores prefix in ephemeral cache       │
  │  response.usage.cache_creation_input   │
  │    _tokens: 3168                        │
  │  charges ~1.25× normal for the prefix   │
  └────────────────────────────────────────┘

  Call #2 within 5 minutes (cache hit)
  ┌─ Route ────────────────────────────────┐
  │  anthropic.messages.create({           │
  │    system: [{ text: SAME, cache_control:│
  │              { type: 'ephemeral' } }]  │
  │    …                                    │
  │  })                                     │
  └────────────┬───────────────────────────┘
               │  HTTPS
               ▼
  ┌─ Anthropic API ────────────────────────┐
  │  matches hash → skip prefix processing  │
  │  response.usage.cache_read_input        │
  │    _tokens: 3168                        │
  │  charges ~0.1× normal for the prefix    │
  └────────────────────────────────────────┘
```

Baseline verification live: `cache_creation_input_tokens: 3168` on the
first call, matched by `cache_read_input_tokens: 3168` on the next.
The prefix hash matches exactly. Every call to `complete()` inside a
ReAct loop that runs within 5 minutes hits the cache. For a diagnostic
investigation (~10 model turns), that's a ~90% reduction on the system
prompt's token cost.

**The gotcha**: cache lookup is by prefix hash. If any byte of the
system prompt changes, the cache misses. This is why the system
prompt is loaded from a static `.md` file (`lib/agents/prompts/`) and
never templated with dynamic values — stability of the prefix bytes is
what makes the cache hit.

### The app-level tool cache

The middle caching layer. `BloomreachDataSource.callTool` maintains a
60s in-memory Map keyed by `${name}:${JSON.stringify(args)}`
(`bloomreach-data-source.ts:139-151, 179-187`):

```ts
  const cacheKey = `${name}:${JSON.stringify(args)}`;
  const ttl = options.cacheTtlMs ?? 60_000;

  if (!options.skipCache) {
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { result: cached.result as T, durationMs: 0, fromCache: true };
    }
  }
  // …
  // Don't cache error results — they should not poison the cache.
  if ((result as any)?.isError === true) {
    return { result: result as T, durationMs, fromCache: false };
  }
  this.cache.set(cacheKey, { result, expiresAt: now + ttl });
```

Three deliberate choices:
  1. **Errors never cache** — an `isError: true` result skips the
     `this.cache.set(...)` line. Without this, a transient 429 would
     poison the cache for 60s.
  2. **Per-process, in-memory** — Vercel spins up new instances at
     will; a cache hit only works within one instance's lifetime. This
     is fine — the cache exists to absorb repeat calls *within one
     briefing*, not across users or requests.
  3. **`skipCache` still refreshes** — even if you set `skipCache: true`,
     the fresh result *is* written back to the cache (write-through).
     Used by the `/debug` "force fresh" path.

### Move 3 — the principle

Each cache lives at the altitude that owns its TTL and eviction. The
browser cache is opted out because streams can't be cached. The
provider cache is opted in via one header because the provider is best
positioned to hash the prefix. The app cache lives in the app because
it needs to know when a result is an error and skip caching.

## Primary diagram

```
  Primary — HTTP semantics across the wire

  ┌─ Browser ────────────────────────────────────────────────────┐
  │  GET /api/briefing                                             │
  │  Cookie: bi_session; bi_auth                                   │
  └───────────────────────┬──────────────────────────────────────┘
                          │
  ┌─ Route ──────────────▼───────────────────────────────────────┐
  │  auth check → return 401 needsAuth JSON if unauth              │
  │  ELSE stream:                                                  │
  │    Content-Type: application/x-ndjson                          │
  │    Cache-Control: no-store, no-transform                       │
  │    Set-Cookie: bi_auth (refreshed if dirty)                    │
  │                                                                │
  │    ┌─ 60s in-memory app cache (BloomreachDataSource) ─────┐   │
  │    │  key: name:JSON.stringify(args)                       │   │
  │    │  no cache on isError                                  │   │
  │    └───────────────────────────────────────────────────────┘   │
  └───┬───────────────────────────────────────┬───────────────────┘
      │                                       │
      ▼                                       ▼
  ┌─ Bloomreach ──────────────┐    ┌─ Anthropic ──────────────────┐
  │  Authorization: Bearer     │    │  Authorization: Bearer        │
  │  … MCP JSON-RPC payload    │    │  system: [{ …, cache_control: │
  │                            │    │    { type: 'ephemeral' } }]   │
  │                            │    │  → 5-min prefix cache          │
  │                            │    │    cache_creation_input_tokens │
  │                            │    │    cache_read_input_tokens     │
  └────────────────────────────┘    └───────────────────────────────┘
```

## Elaborate

**Why NDJSON over `text/event-stream` (SSE)?** SSE requires
`Content-Type: text/event-stream` and follows an `event: X\ndata: Y\n\n`
framing. NDJSON is simpler: one JSON per line, no framing rules, no
`retry:` field, no auto-reconnect built into the client (which we
actively don't want here — the reconnect policy is app-owned via
`useReconnectPolicy`). NDJSON also composes with `AbortController`
naturally; SSE via `EventSource` has less clean cancellation semantics.

**Why not `Cache-Control: private, max-age=0` instead of `no-store`?**
`private, max-age=0` still allows caching (browser MAY cache with
revalidation). `no-store` says *don't even hold this*. For a stream,
that's the right choice.

**Why not use HTTP/2 push for the LLM responses?** Not exercised — the
Anthropic SDK handles transport, and there's no push semantics in
Claude's messages API anyway. LLMs don't push; they respond.

## Interview defense

**Q: How does the client know whether to render a live stream or a
static snapshot?**

  Direct: the route returns `Content-Type: application/x-ndjson` for
  the live path and `application/json` for the demo path. The client
  reads the header on the first response and branches. No route flag,
  no query param check — just the standard HTTP semantic.

```
  answer sketch — one field discriminates the branch

  if (ct.includes('ndjson') && res.body) {
    await readNdjson(res.body, handle);  // stream
  } else {
    const body = await readBody(res);
    setInsights(body.insights);           // snapshot
  }
```

  Anchor: `lib/hooks/useBriefingStream.ts:185-199`.

**Q: Why 401 before the stream and not an `error` event inside the
stream?**

  Direct: because the auth-error path needs to trigger a *full-page
  navigation* to the IdP for the OAuth dance. You can't cleanly do
  that from inside a consuming stream — the browser may not attach
  fresh cookies to the navigation, and any partial NDJSON parsed
  before the error is wasted work. Returning 401 with `needsAuth:
  true` before committing to the stream lets the client `window.location.href
  = authUrl` and start the OAuth flow with a clean slate.

  Anchor: `app/api/briefing/route.ts:180-182`,
  `lib/hooks/useBriefingStream.ts:162-171`.

**Q: What's the effective cost of one investigation with prompt
caching on?**

  Direct: baseline (Runid `2026-07-03T04-08-28-644Z`) shows
  `cache_creation_input_tokens: 3168` on the first call, matched by
  `cache_read_input_tokens: 3168` on the next. Cache-read tokens are
  billed at ~10% of normal input. Across a ~10-turn ReAct loop, that's
  ~90% savings on the system-prompt prefix. First call absorbs the
  ~1.25× "creation" premium; every subsequent call within 5 minutes
  wins. Net: roughly halves the LLM cost per investigation.

  Anchor: `lib/agents/aptkit-adapters.ts:85-89`.

## See also

  - `06-websockets-sse-streaming-and-realtime.md` — the NDJSON choice
    against SSE and WebSocket
  - `07-timeouts-retries-pooling-and-backpressure.md` — how retries
    interact with the 60s app cache
  - `.aipe/study-security/` — SameSite=None as a threat-model tradeoff

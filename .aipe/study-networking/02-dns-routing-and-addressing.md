# DNS, routing, and addressing

*Origin resolution (Industry standard)* — names, addresses, routing,
proxies, edge layers, and how the code resolves *where to talk to*.

## Zoom out — where this concept lives

Before a byte hits the wire the code has to answer three questions:
which origin, which path, which redirect URI. This repo answers them
with three env vars and one clever `x-forwarded-host` read. The rest
is defaults.

```
  Zoom out — origin resolution across the three hops

  ┌─ Browser ────────────────────────────────────────────────────┐
  │  window.location.origin (implicit — same-origin fetch)        │
  └──────────────────────┬───────────────────────────────────────┘
                         │
  ┌─ Next route ─────────▼───────────────────────────────────────┐
  │  ★ ORIGIN RESOLUTION LIVES HERE ★                             │
  │  mcpUrl()          — BLOOMREACH_MCP_URL env, trailing / stripped │
  │  redirectUri()     — x-forwarded-host (prod) / APP_ORIGIN (dev)  │
  │  Anthropic SDK     — default api.anthropic.com                   │
  └──────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
                    upstream origins
                (loomi-mcp-alpha.bloomreach.com,
                 api.anthropic.com)
```

Three env vars pin the origins. One `x-forwarded-host` read makes
preview-deploys work. That's the whole story.

## The structure pass

The axis is **who decides which origin to hit at each layer**. Held
constant across altitudes:

```
  Axis: "who decides the origin?"

  ┌─────────────────────────────────────────┐
  │ browser fetch                            │  → CODE decides
  │ /api/briefing                             │    (same-origin implicit)
  └─────────────────────────────────────────┘
      ┌─────────────────────────────────────┐
      │ Next route                          │  → ENV decides
      │ BLOOMREACH_MCP_URL, APP_ORIGIN      │    (config)
      └─────────────────────────────────────┘
          ┌─────────────────────────────────┐
          │ OAuth callback redirect_uri     │  → REQUEST decides
          │ derived from x-forwarded-host   │    (per-request)
          └─────────────────────────────────┘
              ┌──────────────────────────────┐
              │ Anthropic hop                │  → SDK decides
              │ default api.anthropic.com    │    (library default)
              └──────────────────────────────┘
```

Four altitudes, four different owners. The seam that matters most is
between "ENV decides" and "REQUEST decides" — the OAuth flow *can't*
use a static config because the redirect URI has to match whichever
Vercel host the user actually hit.

**Seams**:

  - **browser ↔ route** — same-origin, cookie flows naturally.
  - **route ↔ Bloomreach** — cross-origin; the route is configured with
    one origin per environment.
  - **IdP ↔ callback route** — cross-site *return*; the redirect_uri
    must be one that DCR pre-registered *and* the browser can reach with
    its `bi_session` cookie attached.
  - **route ↔ Anthropic** — cross-origin; SDK-owned, no local config.

## How it works

### Move 1 — the mental model

You've configured API base URLs before (`NEXT_PUBLIC_API_URL` in a
CRA/Vite app). This is the server-side version of that, plus a wrinkle:
one of the URLs has to be *derived per request* because Vercel gives
each deploy a different hostname and the OAuth redirect must land on
the same one that set the cookie.

```
  The pattern — static config + one dynamic derivation

  ┌─ static env ──────────────────────────┐
  │  BLOOMREACH_MCP_URL                    │
  │  APP_ORIGIN                            │
  │  ANTHROPIC_API_KEY                     │
  └───────────────────────────────────────┘

  ┌─ per-request derivation ──────────────┐
  │  x-forwarded-host                     │  ← the wrinkle
  │  →  proto + host + '/api/mcp/callback' │
  └───────────────────────────────────────┘
```

### Move 2 — the origin decisions

#### The MCP origin

The Bloomreach MCP URL is env-configured with one non-obvious cleanup
step. `lib/mcp/connect.ts:30-34`:

```ts
  function mcpUrl(): URL {
    const raw =
      process.env.BLOOMREACH_MCP_URL ?? 'https://loomi-mcp-alpha.bloomreach.com/mcp/';
    return new URL(raw.replace(/\/+$/, ''));   // strip trailing slash(es) — avoids a 307
  }
```

The trailing-slash strip is load-bearing. Without it, the SDK
constructs `https://loomi-mcp-alpha.bloomreach.com/mcp/` and the
Bloomreach edge answers with a `307 Temporary Redirect` to
`.../mcp` (no trailing slash) — one extra round-trip added to every
single MCP call, plus a redirect that the SDK may not preserve the
`Authorization` header across. Strip it once at construction, and
every subsequent call skips the redirect.

This is the kind of detail that only shows up when you're staring at a
network waterfall and every span has a mysterious ~200ms 307 in front
of it. The comment on that line is worth its weight in gold.

#### The OAuth callback redirect URI

The interesting one. `lib/mcp/connect.ts:36-57`:

```ts
  async function redirectUri(): Promise<string> {
    // In production, derive the redirect from the ACTUAL request host so the OAuth
    // callback returns to the same origin that set the session cookie…
    if (process.env.NODE_ENV === 'production') {
      try {
        const { headers } = await import('next/headers');
        const h = await headers();
        const host = h.get('x-forwarded-host') ?? h.get('host');
        if (host) {
          const proto = h.get('x-forwarded-proto') ?? 'https';
          return `${proto}://${host}/api/mcp/callback`;
        }
      } catch { /* not in a request scope — fall through to APP_ORIGIN */ }
    }
    return `${process.env.APP_ORIGIN ?? 'http://localhost:3000'}/api/mcp/callback`;
  }
```

Trace what happens without this. Suppose `APP_ORIGIN=https://blooming.app`
but the user opened a preview deploy at
`https://blooming-git-feature-xyz.vercel.app`:

```
  Without x-forwarded-host — the cookie drops

  1. user hits blooming-git-feature-xyz.vercel.app/           ← sets bi_session cookie for THIS host
  2. clicks "connect Bloomreach"
  3. server generates authorize URL with redirect_uri = https://blooming.app/api/mcp/callback
  4. browser redirects to Bloomreach IdP
  5. IdP redirects to https://blooming.app/api/mcp/callback   ← different host!
  6. bi_session cookie was set for blooming-git-feature-xyz.vercel.app, NOT sent
  7. callback lands with no session → 400 "no session"
```

With the header-based derivation, step 3 uses the preview host, step 5
lands on the same preview host, step 6 sends the cookie, step 7 succeeds.
DCR handles the fact that each host registers its own redirect_uri
on the fly (each preview deploy runs its own Dynamic Client Registration
with its own redirect_uri — the Bloomreach IdP accepts it).

Layers and hops for the OAuth roundtrip:

```
  OAuth callback — the cookie has to survive a cross-site round trip

  ┌─ Browser ─────────┐  hop 1: /api/briefing                    ┌─ Route ────────┐
  │  bi_session=abc   │ ────────────────────────────────────────► │  connectMcp()  │
  │                    │  hop 2: 401 needsAuth + authorize URL     │  no tokens →   │
  │                    │ ◄──────────────────────────────────────── │  return authUrl│
  └───┬──────────────┘                                            └────────────────┘
      │  hop 3: 302 to authorize URL
      ▼
  ┌─ Bloomreach IdP ──────────────────────────────────────────────┐
  │  user authenticates                                             │
  └───┬────────────────────────────────────────────────────────────┘
      │  hop 4: 302 to redirect_uri (SAME HOST as hop 1!)
      │        Cookie: bi_session=abc   ← SameSite=None + Secure lets it ride
      ▼
  ┌─ Same Route — /api/mcp/callback ────────────────────────────────┐
  │  readSessionId() → 'abc'                                         │
  │  completeAuth('abc', code) → tokens saved to bi_auth cookie      │
  │  302 to /                                                        │
  └──────────────────────────────────────────────────────────────────┘
```

Two things had to be right for this to work:
  - **redirect_uri = same host as the initial visit** (the
    `x-forwarded-host` derivation)
  - **cookies allow cross-site return** (`SameSite=None; Secure`;
    see 05)

Either wrong, the callback lands with no session.

#### The Anthropic origin

The SDK owns this. `new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })`
at `briefing/route.ts:256` and `agent/route.ts:244` — no `baseURL`
override anywhere in the repo. Default is `api.anthropic.com`. The SDK
handles connection pooling, HTTP/2 (if the platform supports it), and
retry — all opaque to the app.

#### Vercel edge as an implicit hop

There's an unnamed hop before the route in production: Vercel's edge
network terminates TLS, adds `x-forwarded-*` headers, and forwards to
the Node runtime. The code sees `x-forwarded-host` because Vercel puts
it there. On a self-hosted deployment (bare Node), you'd read `host`
directly (the fallback at `connect.ts:47`).

### Move 3 — the principle

Static config for stable origins, per-request derivation for the one
URL that has to match the browser's current host. This pattern shows
up any time OAuth meets multi-environment deploys — the redirect URI
is the single per-request value in an otherwise env-driven set.

## Primary diagram

The full origin-resolution recap:

```
  Primary — how each origin is resolved

  ┌─ Browser ────────────────────────────────────────────────────┐
  │  same-origin: /api/briefing, /api/agent, /api/mcp/*           │
  └───────────────────────────┬──────────────────────────────────┘
                              │
  ┌─ Next route ──────────────▼──────────────────────────────────┐
  │                                                                │
  │  hop 2 origin  ──► mcpUrl()                                    │
  │                    reads BLOOMREACH_MCP_URL                     │
  │                    strips trailing slash → avoids 307           │
  │                                                                │
  │  callback URI  ──► redirectUri()                               │
  │                    prod: x-forwarded-host + x-forwarded-proto   │
  │                    dev:  APP_ORIGIN                             │
  │                                                                │
  │  hop 3 origin  ──► Anthropic SDK default                       │
  │                    api.anthropic.com                            │
  │                                                                │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

Why is redirect_uri derivation not just `NEXT_PUBLIC_APP_URL`? Because
Vercel gives every push a fresh preview hostname. You'd have to redeploy
the env var for every preview, and even then the *production alias* and
the *production deploy URL* are two different hostnames. `x-forwarded-host`
is the only value that always names the host the browser is currently
looking at.

Where DNS *would* matter but doesn't yet:

  - **DNS pinning** — if the app cached the resolved IP for an origin,
    it'd survive DNS-level outages of one CDN pop. Not exercised.
  - **Custom resolver** — you'd use `dns.resolve` in Node with a
    specific resolver for privacy. Not exercised.
  - **Geo-DNS** — Bloomreach and Anthropic handle this at their edge;
    the app never sees the resolution decision.

Where routing *would* matter but doesn't yet:

  - **Per-region routing** — Vercel edge steers requests to nearest
    region; no route runs `export const runtime = 'edge'`, so all
    routes hit Node in a single region.
  - **Load balancer** — no self-managed LB; Vercel handles it.

## Interview defense

**Q: How does the OAuth callback know which URL to redirect to when
the same code runs on production, preview, and localhost?**

  Verdict first: it derives the redirect URI from `x-forwarded-host`
  per request, not from a static env var. That's the only way the
  preview deploys and the production alias can both work with the same
  code path.

```
  answer sketch — three environments, one derivation

  localhost         → APP_ORIGIN env  (no forwarded headers)
  vercel preview    → x-forwarded-host = blooming-git-xyz.vercel.app
  production        → x-forwarded-host = blooming.app

  redirect_uri = ${proto}://${host}/api/mcp/callback
  DCR registers whichever the current request presents
```

  Anchor: `lib/mcp/connect.ts:36-57`, `redirectUri()`.

**Q: Why strip the trailing slash off the MCP URL?**

  Direct: the server answers `.../mcp/` with a `307 Temporary Redirect`
  to `.../mcp`. If we left the slash in, every single MCP call would
  cost one extra round-trip, and the SDK doesn't guarantee the `Authorization`
  header survives redirects. One `.replace(/\/+$/, '')` at construction
  time removes the whole class of problem.

  Anchor: `lib/mcp/connect.ts:33`, `mcpUrl()`.

## See also

  - `01-network-map.md` — where these origins fit in the three-hop map
  - `04-tls-and-trust-establishment.md` — the cookie that survives the callback
  - `05-http-semantics-caching-and-cors.md` — SameSite=None; Secure details

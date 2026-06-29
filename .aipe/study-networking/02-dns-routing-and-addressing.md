# 02 · DNS, routing, and addressing

## Subtitle

Names, addresses, and the path from a URL to a TCP connection — Industry standard.

## Zoom out, then zoom in

DNS is the layer most engineers never see until it bites them — a wrong host, a stale cache, a misconfigured preview domain. This repo touches DNS in exactly three places, all of them implicit (no custom resolver, no DNS-over-HTTPS, no per-request override). So this file is short and largely about *which names exist* and *what resolves them* rather than mechanics the app implements.

```
  Zoom out — where DNS lives in this stack

  ┌─ UI layer ──────────────────────────────────────────────────┐
  │  browser → resolves the page origin once on navigation       │
  │            (e.g. blooming-insights.vercel.app)              │
  └────────────────────────────────────────────────────────────┘
                            │ same-origin fetch
                            ▼
  ┌─ Service layer ─────────────────────────────────────────────┐
  │  Vercel edge → routes /api/* to the Node runtime             │
  │  (no DNS hop — the edge fronts both the page and the routes)│
  └────────────────────────────────────────────────────────────┘
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
  ┌─ Provider ───────────────┐ ┌─ Provider ─────────────────────┐
  │ loomi-mcp-alpha           │ │ api.anthropic.com              │
  │ .bloomreach.com           │ │                                │
  │ ← Node fetch resolves     │ │ ← @anthropic-ai/sdk resolves   │
  │   each connection         │ │   via the same Node fetch      │
  └───────────────────────────┘ └────────────────────────────────┘
```

The repo doesn't *do* DNS — it depends on it. What it *does* is decide which hostname to talk to, and that one decision (deriving the OAuth redirect from the actual request host) is the only piece of name-handling the app code owns.

## Structure pass

  - **Layers** — the page origin (browser sees one), Vercel's edge (routes paths under one origin), and the two upstream provider origins.
  - **Axis traced — "who picks the hostname?"** It flips:
      - the page origin: chosen by the user (typing/clicking the URL).
      - the API route paths: not a separate hostname — same origin as the page.
      - the upstream hosts: hardcoded with env-override (`BLOOMREACH_MCP_URL`) or the SDK's default.
      - the OAuth redirect URI: **derived at request time** from `x-forwarded-host` (`lib/mcp/connect.ts:43-56`) so each preview deploy uses its own hostname.
  - **Seams** — the request-time host derivation is the load-bearing seam: it's the only place app code reads inbound network identity and writes it into an outbound address. Get that wrong and OAuth callbacks land at the wrong origin and the cookie doesn't match.

## How it works

### Move 1 — the mental model

DNS is "you have a name, you need an IP, somebody resolves it." For this app, somebody is always the runtime — the browser, Node's `fetch`, or the MCP SDK underneath. The app's job is only to hand the right name to the right caller.

```
  Pattern — name → address handoff

  app code says:      "talk to loomi-mcp-alpha.bloomreach.com"
                                  │
                                  ▼
  fetch / SDK says:   "I need an IP" → libc / undici → OS resolver
                                  │
                                  ▼
  resolver says:      "1.2.3.4"  (or fails — ENOTFOUND, ETIMEDOUT)
                                  │
                                  ▼
  TCP layer:          opens connection to 1.2.3.4:443
```

There's no DNS cache the app maintains. There's no `dns.lookup()` call anywhere in the app code. The resolution happens inside the runtime each time a connection opens; everything above it just sees "the call succeeded" or "the call failed with a network-shaped error."

### Move 2 — the moving parts

#### The page origin (browser-side)

The browser resolves the page origin when the user navigates to it. After that, every fetch in the app is same-origin (`/api/briefing`, `/api/agent`, `/api/mcp/...`) — same hostname, same protocol, same port. No additional DNS lookups, no CORS preflight, no cross-origin policy to navigate. The same-origin model is the implicit choice the entire frontend rides on.

```
  Same-origin requests — one DNS lookup, many fetches

  navigate → resolve blooming-insights.vercel.app → 1.2.3.4
       │
       ├─ fetch('/api/briefing')          ─→ 1.2.3.4:443  (same conn)
       ├─ fetch('/api/agent?step=...')    ─→ 1.2.3.4:443  (same conn)
       └─ fetch('/api/mcp/reset', POST)   ─→ 1.2.3.4:443  (same conn)
```

No `Access-Control-Allow-Origin` headers anywhere in `app/` or `lib/` because none of the browser fetches are cross-origin. The CORS rule that fires is "same-origin requests skip the entire CORS layer."

#### The Bloomreach MCP origin (server-side)

Hardcoded with env override at `lib/mcp/connect.ts:30-34`:

```ts
// lib/mcp/connect.ts:30-34
function mcpUrl(): URL {
  const raw =
    process.env.BLOOMREACH_MCP_URL ?? 'https://loomi-mcp-alpha.bloomreach.com/mcp/';
  return new URL(raw.replace(/\/+$/, '')); // ← strip trailing slash; avoids a 307
}
```

Two things to notice. First, the default uses the *alpha* environment — there is no production Bloomreach loomi connect MCP yet; the env var is the swap point. Second, the trailing-slash strip is a real bug-class avoided in advance: many HTTP servers respond to `/mcp/` with a 307 redirect to `/mcp`, which the MCP SDK doesn't always follow cleanly. Stripping it removes the redirect hop entirely.

The actual DNS lookup happens inside `StreamableHTTPClientTransport` → Node's global `fetch` → undici → libc. The app never touches it.

#### The Anthropic origin (server-side)

Even more implicit: the `@anthropic-ai/sdk` Client knows its own base URL (`https://api.anthropic.com`). The app constructs `new Anthropic({ apiKey: ... })` and never passes a URL. DNS happens inside the SDK's HTTP layer.

#### The redirect URI — the only piece the app derives at runtime

The OAuth callback URL has to be on the *same origin* as the page that started the flow. On Vercel, that origin can be:

  - The production alias: `blooming-insights.vercel.app`
  - A preview alias: `blooming-insights-git-some-branch-rein.vercel.app`
  - The per-deploy URL: `blooming-insights-abc123-rein.vercel.app`
  - Locally: `http://localhost:3000`

If the redirect URI is hardcoded to one of these, opening a preview deploy and clicking 'live' starts the OAuth flow on the preview hostname, hands the IdP a callback pointing at the production hostname, and the IdP sends the user there — losing the session cookie that was set on the preview hostname. The fix is to derive the redirect from the actual request:

```ts
// lib/mcp/connect.ts:43-57
if (process.env.NODE_ENV === 'production') {
  try {
    const { headers } = await import('next/headers');
    const h = await headers();
    const host = h.get('x-forwarded-host') ?? h.get('host');  // ← Vercel sets this
    if (host) {
      const proto = h.get('x-forwarded-proto') ?? 'https';
      return `${proto}://${host}/api/mcp/callback`;
    }
  } catch {
    /* not in a request scope — fall through */
  }
}
return `${process.env.APP_ORIGIN ?? 'http://localhost:3000'}/api/mcp/callback`;
```

```
  Layers-and-hops — request-host-derived redirect

  ┌─ Browser ───────────────┐                    ┌─ Vercel edge ───────┐
  │ navigates to            │                    │ adds                │
  │ preview-x.vercel.app    │ ──── HTTPS ─────►  │ x-forwarded-host:   │
  │                         │                    │   preview-x.vercel  │
  └─────────────────────────┘                    └──────────┬──────────┘
                                                            │ proxies to
                                                            ▼
                                                ┌─ Node runtime ───────┐
                                                │ connect.ts reads     │
                                                │ x-forwarded-host     │
                                                │ → redirect_uri =     │
                                                │   preview-x.vercel/  │
                                                │   api/mcp/callback   │
                                                └──────────┬───────────┘
                                                           │ uses in DCR
                                                           ▼
                                                ┌─ Bloomreach IdP ─────┐
                                                │ registers the URL    │
                                                │ for THIS deploy      │
                                                └──────────────────────┘
```

Two side-effects worth knowing:

  - Each new Vercel preview alias triggers a **fresh Dynamic Client Registration** with Bloomreach the first time a user authenticates there (different redirect URI → different DCR record).
  - The IdP must support that — Bloomreach loomi connect does, because RFC 7591 (Dynamic Client Registration) is what makes this whole shape work without a pre-registered client.

#### What's NOT exercised

  - **No custom DNS resolver.** No `dns.lookup`, no `dns.promises`, no `lookup:` option passed to `fetch`. Whatever Node + the underlying OS + Vercel's network do.
  - **No DNS-over-HTTPS or DNS-over-TLS.** Standard system resolver.
  - **No DNS cache the app maintains.** Each new HTTPS connection pulls a fresh resolution (which undici may keep alive — but that's transport, not DNS).
  - **No SRV records, no service discovery.** The product is three boxes; there's nothing to discover.
  - **No reverse proxy or custom edge layer.** Vercel terminates TLS and routes paths; the app does not configure that.

### Move 3 — the principle

When you don't own DNS, the only DNS work your app code does is *deciding which hostname to hand to the runtime*. The interesting code is always at the boundary where you read a name in (from the request, from env, from a token) and write it out (into an HTTPS URL, into an OAuth redirect, into a token audience). The Bloomreach redirect URI derivation is the canonical version of that move in this repo.

## Primary diagram

```
  All DNS / address decisions in the repo

  ┌─ UI layer ───────────────────────────────────────────────────┐
  │  page origin     ← user types/clicks; browser resolves once  │
  │  /api/* fetches  ← same origin; no additional DNS            │
  └──────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
  ┌─ Service layer (Vercel) ─────────────────────────────────────┐
  │  reads x-forwarded-host      ← derive OAuth redirect from    │
  │   (lib/mcp/connect.ts:48)      the actual hostname           │
  │                                                              │
  │  outbound name handoffs:                                     │
  │   • BLOOMREACH_MCP_URL or                                    │
  │     loomi-mcp-alpha.bloomreach.com/mcp                       │
  │     (lib/mcp/connect.ts:32)                                  │
  │   • api.anthropic.com (SDK default)                          │
  └──────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
  ┌─ Resolver (Node / OS / Vercel) ──────────────────────────────┐
  │  hostname → IP → TCP connect (transparent to app code)       │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

The reason DNS is *quiet* in this codebase is that the architecture is quiet about distribution. There are three named services (the app, Bloomreach MCP, Anthropic). There is no internal mesh, no broker, no per-tenant subdomain, no edge-computed routing. When DNS becomes a thing you have to manage, it's usually because one of those was true.

The one place to watch in the future: if blooming insights ever gets a real backend (a database, a queue, a worker pool), each of those becomes a hostname someone has to configure, secure (TLS), and surface a failure mode for (timeout, retry, circuit-break). The seam to extend is the same one already in `connect.ts` — read identity at the boundary, write it into an URL, prefer env override for swap-ability.

A note on the alpha environment: `loomi-mcp-alpha.bloomreach.com` is a deliberate signal. It's an alpha-band hostname that may get retired or moved; the env var makes that a 1-line config change rather than a code change. The same shape will likely apply when Bloomreach ships GA.

## Interview defense

**Q: How does the OAuth redirect URI get computed, and why does it matter?**

```
  request                          response
  ───────                          ────────
  X-Forwarded-Host: preview-x...   redirect_uri = preview-x.../api/mcp/callback
  X-Forwarded-Proto: https
              │
              ▼
  derived once per connect()
              │
              ▼
  passed to DCR → registered with IdP
              │
              ▼
  IdP sends user back to the SAME hostname → cookie matches
```

**Anchor:** if the redirect URI doesn't match the page origin that set the cookie, the cookie isn't sent on the return and "no session" happens. Deriving from `x-forwarded-host` is the fix.

**Q: Does the app cache DNS?**

No. Every outbound connection lets Node's `fetch` (and through it, undici's connection pool + the OS resolver) decide. Inbound DNS happens once at the browser when the user navigates. No app-level cache to invalidate.

**Q: What's the load-bearing piece of the addressing story?**

The `x-forwarded-host` derivation in `connect.ts`. Drop it and only one deploy hostname can complete OAuth — every preview alias fails silently because the cookie set on the preview origin doesn't ride back through a callback on the production alias.

## See also

  - `04-tls-and-trust-establishment.md` — for what happens once DNS resolves: the TLS handshake on each origin.
  - `05-http-semantics-caching-and-cors.md` — for why same-origin requests skip CORS, and what cache-control directives the routes set.
  - `.aipe/study-security/` — for the trust-boundary version: who can tamper with `x-forwarded-host` and how Vercel guarantees it.

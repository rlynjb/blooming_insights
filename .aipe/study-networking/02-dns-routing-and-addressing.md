# DNS, routing, and addressing

**Name resolution and request routing** · Language-agnostic

## Zoom out — where this concept lives

DNS happens at the bottom of every outbound `fetch`. It's the layer below TLS, below TCP — the layer that turns `loomi-mcp-alpha.bloomreach.com` into an IP address before any of the rest of the stack can start.

```
  Zoom out — DNS sits below every wire

  ┌─ UI band ──────────────────────────────────────────┐
  │  fetch('/api/briefing')   ← same-origin, no DNS    │
  └────────────────────┬───────────────────────────────┘
                       │
  ┌─ Service band ─────▼───────────────────────────────┐
  │  fetch('https://loomi-mcp-alpha.bloomreach.com/…') │ ← we are here
  │  fetch('https://api.anthropic.com/v1/messages')    │ ← we are here
  └────────────────────┬───────────────────────────────┘
                       │
  ┌─ Transport stack ──▼───────────────────────────────┐
  │  DNS → TCP connect → TLS handshake → HTTP request   │
  │  ★ DNS ★                                            │
  └─────────────────────────────────────────────────────┘
```

## Zoom in — the concept

Three hostnames matter to this app. Two are owned by external providers (`loomi-mcp-alpha.bloomreach.com`, `api.anthropic.com`). One is owned by us, set on Vercel (`<app-host>` — typically `bloominginsights.vercel.app` or a custom alias). Everything else is same-origin or doesn't make network calls.

## Structure pass

### Layers

- **Application** — where the hostname appears as a string in code (`lib/mcp/connect.ts:32`, `Anthropic` SDK constant, browser-side `/api/*`).
- **Resolver** — Node's `dns` module on the server; the browser's resolver on the client. We don't configure either.
- **Transport** — the IP+port pair the connection actually opens against.

### One axis held constant — `who owns the name?`

```
  axis = "who owns the hostname and controls the IP it resolves to?"

  ┌─ /api/* ──────────────────────┐  WE own it (via Vercel DNS)
  │  same-origin                   │  → no DNS query at all in the browser:
  │                                │    relative URL resolves to current origin
  └────────────────────────────────┘

  ┌─ loomi-mcp-alpha.bloomreach.com ┐  BLOOMREACH owns it
  │  resolved server-side by Node    │  → we cannot pin the IP, control TLS SNI,
  │                                  │    or fall over to a backup
  └─────────────────────────────────┘

  ┌─ api.anthropic.com ─────────────┐  ANTHROPIC owns it
  │  resolved server-side by Node    │  → same constraint
  │                                  │
  └─────────────────────────────────┘
```

Trace the axis and the asymmetry becomes obvious: our own routes carry zero DNS cost on wire #1, and we eat full DNS round-trips on wires #2 and #3 every time the resolver cache misses.

### Seams

- **App-string ↔ resolver** — the URL is a string until `fetch()` hands it to the platform; from there, resolution is opaque.
- **Cold-start ↔ warm-start** — the first call out of a fresh Vercel function pays full DNS; subsequent calls on the same warm instance hit the OS resolver cache (typically TTL-bound).

## How it works

### Move 1 — the mental model

A hostname is a label for an IP. DNS is the phonebook. You hand it `api.anthropic.com`, it hands you back something like `160.79.104.10` plus a TTL. After that, TCP doesn't know what a hostname is — it talks to the IP.

```
  the lookup — one query per cold hostname

  "https://api.anthropic.com/v1/messages"
                │
                │  app calls fetch(URL)
                ▼
       ┌──────────────────┐
       │  parse URL       │  → host = "api.anthropic.com"
       └────────┬─────────┘    port = 443 (default for https)
                ▼
       ┌──────────────────┐
       │  resolver cache  │  → hit? skip the query
       │  (OS / process)  │
       └────────┬─────────┘
                │  miss
                ▼
       ┌──────────────────┐
       │  recursive DNS   │  → returns "160.x.x.x" + TTL
       │  (usually UDP)   │
       └────────┬─────────┘
                ▼
       ┌──────────────────┐
       │  TCP connect     │  → opens to 160.x.x.x:443
       └──────────────────┘
```

### Move 2 — walk the cases

#### Case 1 — `fetch('/api/briefing')` from the browser

No DNS query. The URL is relative; the browser resolves it against `window.location.origin`. If the user is on `https://bloominginsights.vercel.app`, the request goes to that same origin over an already-warm TCP/TLS connection (or one that needs to be opened to the origin the user just navigated to — at which point the browser has DNS for that origin from the page load itself).

The cost: zero per-request DNS overhead on wire #1.

```ts
// lib/hooks/useBriefingStream.ts:154
const url = `/api/briefing${search}`;
// ↑ relative URL — browser resolves to current origin, no DNS query needed
```

The benefit isn't just latency. Same-origin means the browser also sends cookies (`bi_session`, `bi_auth`) automatically and skips the CORS preflight machinery. Three things you get for free by keeping wire #1 same-origin.

#### Case 2 — Server-side `fetch` to `loomi-mcp-alpha.bloomreach.com`

DNS happens in Node, using the platform resolver. The hostname is hardcoded into the URL we construct:

```ts
// lib/mcp/connect.ts:30-34
function mcpUrl(): URL {
  const raw =
    process.env.BLOOMREACH_MCP_URL ?? 'https://loomi-mcp-alpha.bloomreach.com/mcp/';
  return new URL(raw.replace(/\/+$/, '')); // strip trailing slash(es) — avoids a 307
}
```

The trailing-slash dance is worth pausing on: it's not about DNS at all, it's about path routing on the server. With a trailing slash on the URL, the Bloomreach server responds `307 Temporary Redirect` to the no-slash version, costing a round-trip. Stripping the slash up-front avoids the redirect. **A "DNS and addressing" file is the right place to land this — the line between hostname and path is the line between DNS routing and HTTP routing, and we exercise both.**

```
  Layers-and-hops — what the trailing slash actually changes

  ┌─ Service ────┐  POST /mcp/      ┌─ Bloomreach ──┐
  │ (with /)     │ ───────────────► │                │
  │              │   307 Location:  │                │
  │              │ ◄─────────────── │                │
  │              │   /mcp           │                │
  │              │                  │                │
  │              │  POST /mcp       │                │
  │              │ ───────────────► │  200           │
  └──────────────┘                  └────────────────┘
       costs one extra HTTPS round-trip per cold connection
```

Stripping the slash at the URL-construction layer eliminates that. No DNS query saved (same hostname), but the wire round-trip pattern improves.

#### Case 3 — Server-side `fetch` to `api.anthropic.com`

We never construct this URL ourselves. The `@anthropic-ai/sdk` does it. The hostname is baked into the SDK's default `baseURL`. We pass `new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })` and the SDK takes care of `https://api.anthropic.com/v1/messages`.

```ts
// app/api/agent/route.ts:244
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// ↑ no baseURL override; default is api.anthropic.com
```

DNS treatment is identical to case 2. The difference is that we don't have a knob to point this at a different host without subclassing the SDK or setting `ANTHROPIC_BASE_URL` (which we don't).

#### Case 4 — The OAuth callback's `redirect_uri`

The one place DNS-style routing logic lives in our application code is the callback URL builder (`redirectUri()`) in `lib/mcp/connect.ts:36-57`. It picks the host for the OAuth callback dynamically:

```ts
// lib/mcp/connect.ts:42-56
if (process.env.NODE_ENV === 'production') {
  try {
    const { headers } = await import('next/headers');
    const h = await headers();
    const host = h.get('x-forwarded-host') ?? h.get('host');
    if (host) {
      const proto = h.get('x-forwarded-proto') ?? 'https';
      return `${proto}://${host}/api/mcp/callback`;
    }
  } catch {
    /* not in a request scope — fall through to APP_ORIGIN */
  }
}
return `${process.env.APP_ORIGIN ?? 'http://localhost:3000'}/api/mcp/callback`;
```

Why: Vercel ships every deploy at a unique host (`<branch>-<sha>-<team>.vercel.app`) PLUS the production alias. If we hardcoded `APP_ORIGIN`, opening a per-deploy URL while the OAuth callback came back to the production host would drop the session cookie — the cookie is bound to the host that *set* it. So we look at the actual `x-forwarded-host` header Vercel injects and use *that* host for the callback. Dynamic Client Registration on the Bloomreach side accepts a new redirect URI per host as we register, so this works.

This is "routing" in the application sense, not the IP sense — picking the right hostname for an in-band redirect.

#### Case 5 — Local dev

`http://localhost:3000`. No real DNS — the OS resolves `localhost` from `/etc/hosts` to `127.0.0.1`. The session cookie drops the `Secure` flag (`lib/mcp/session.ts:12-13`) because the loopback isn't HTTPS.

### Move 3 — the principle

**Same-origin is the cheapest network primitive in the browser.** It buys you free cookies, no CORS preflight, no DNS query, and often an already-warm TLS session. Every API route at `/api/*` in this app pays that zero cost. The two cross-origin hops (Bloomreach, Anthropic) live on the server side, where the cost is amortized over warm-instance DNS cache, but you still pay it at cold start.

## Primary diagram

```
  the recap — three hostnames, three resolution paths

  ┌─ Browser ─────────────────────────────────────────────────┐
  │  fetch('/api/briefing')                                   │
  │     └─ relative → no DNS                                  │
  │                                                            │
  │  fetch('https://api.anthropic.com/…')  ← never happens     │
  │     (Anthropic SDK runs server-side only)                  │
  └──────────────────────────┬────────────────────────────────┘
                             │
  ┌─ Service (Vercel fn) ────▼────────────────────────────────┐
  │                                                            │
  │  process.env.BLOOMREACH_MCP_URL                            │
  │     │                                                       │
  │     ▼                                                       │
  │  "https://loomi-mcp-alpha.bloomreach.com/mcp"               │
  │     │                                                       │
  │     ▼                                                       │
  │  Node resolver (OS cache + recursive DNS, TTL-bound)        │
  │     │                                                       │
  │     ▼  IP                                                   │
  │  TCP+TLS to <IP>:443                                        │
  │                                                            │
  │  Anthropic SDK default baseURL → api.anthropic.com          │
  │  same Node resolver path                                    │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

**What `not yet exercised`:**

- No custom DNS configuration. We don't override `/etc/resolv.conf`, don't use DNS-over-HTTPS, don't have a service mesh sidecar.
- No IP pinning, no certificate pinning. If Bloomreach changes their IP or rotates their CA, we follow them transparently.
- No multi-region failover at our layer. Vercel handles edge routing for `<app-host>`; the upstream providers handle their own.
- No internal hostnames. No service discovery. Nothing like Consul / Eureka / Kubernetes DNS — because the architecture is "two outbound providers and a serverless function."

**Where this would matter at scale:** if Bloomreach moved off `loomi-mcp-alpha.*` to a regional set of endpoints (`loomi-mcp-us-east.*`, `loomi-mcp-eu-west.*`), we'd need to choose. Right now there's nothing to choose. The `BLOOMREACH_MCP_URL` env var is the entire surface for that future decision.

## Interview defense

**Q: What DNS resolution does the browser do for this app?**

> None for `/api/*` calls — they're same-origin relative URLs. The browser resolved the app's hostname when it loaded the page; every API call rides that same origin. The two cross-origin hops (Bloomreach, Anthropic) are server-to-server, so the browser never sees them.

```
  on the whiteboard:

  Browser ─/api/*─► same-origin (no DNS)
              └────► server side does the cross-origin DNS
```

Anchor: relative URLs cost zero DNS in the browser.

**Q: Why strip the trailing slash from `BLOOMREACH_MCP_URL`?**

> The Bloomreach server responds `307` to the trailing-slash form, redirecting to the no-slash version. Each redirect is one extra HTTPS round-trip on a connection that's already paying full TCP+TLS cost. `lib/mcp/connect.ts:32` does `.replace(/\/+$/, '')` so we never trigger that.

```
  on the whiteboard:

  POST /mcp/   →  307  →  POST /mcp   →  200
       ────────────  redirect costs one RTT
  vs
  POST /mcp    →  200
```

Anchor: addressing is HTTP-routing semantics, not just DNS.

**Q: How does the OAuth callback URL get computed?**

> `redirectUri()` in `lib/mcp/connect.ts:36`. In production it reads `x-forwarded-host` off the request — the Vercel-injected header naming the actual host the user is on, which can be a preview deploy or the production alias. Then it builds `${proto}://${host}/api/mcp/callback`. The Dynamic Client Registration step registers that exact URI per host. Without this, opening a per-deploy URL while the callback returns to a different host drops the session cookie.

```
  on the whiteboard:

  user on preview-abc.vercel.app
       │
       ▼
  connectMcp() → reads x-forwarded-host = "preview-abc.vercel.app"
       │
       ▼
  redirect_uri = https://preview-abc.vercel.app/api/mcp/callback
       │
       ▼
  Bloomreach IdP redirects browser back to THAT host
       → bi_session cookie matches → auth completes
```

Anchor: dynamic host = per-deploy correctness.

## See also

- `01-network-map.md` — where each hostname sits on the map
- `03-tcp-udp-connections-and-sockets.md` — what happens after DNS returns an IP
- `05-http-semantics-caching-and-cors.md` — same-origin's other free gifts

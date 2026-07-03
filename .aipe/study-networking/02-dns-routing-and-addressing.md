# 02 — DNS, routing, and addressing

## Subtitle

Origin resolution and request routing (Language-agnostic — how a URL becomes a socket, and how the app decides which URL to open).

## Zoom out, then zoom in

Before any packet leaves, three questions get answered: which host do we open a connection to, whose DNS answers that name, and — for our own inbound requests — which origin was the browser actually talking to? For most Next.js apps this whole layer is invisible. In this repo it isn't, because the MCP URL is configurable per-request and the OAuth callback URL is derived from the actual inbound host (not a hardcoded env var). Two small pieces of routing logic; both load-bearing.

```
  Zoom out — where addressing sits

  ┌─ UI layer ─────────────────────────────────────────────────┐
  │  fetch('/api/briefing?mode=live-mcp')                      │
  │  (same-origin — no DNS lookup involved)                    │
  └────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
  ┌─ Edge band (Vercel) ───────────────────────────────────────┐
  │  routes browser → route function                           │
  │  inserts x-forwarded-host, x-forwarded-proto               │
  └────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
  ┌─ Service band (route) ─────────────────────────────────────┐
  │  ★ THIS FILE ★                                             │  ← we are here
  │   · mcpUrl(override) — pick which host to call             │
  │   · redirectUri()    — figure out which host called us     │
  └──────────┬──────────────────────────────┬──────────────────┘
             │                              │
             │ DNS lookup + TCP+TLS         │
             ▼                              ▼
  ┌─ Provider ─────────────────────┐  ┌─ Anthropic ────────────┐
  │  MCP origin (Bloomreach preset)│  │  api.anthropic.com     │
  └────────────────────────────────┘  └────────────────────────┘
```

Zoom in — this file answers two questions. First, when the route decides to open an outbound HTTPS call, how does it pick the URL? Second, when the browser lands on the OAuth callback, how does the route figure out which origin it needs to redirect back to?

## Structure pass

**Layers:**
- Client (browser)
- Edge (Vercel — inserts routing headers)
- Route (picks outbound URL, derives inbound origin)
- Upstream (the URL we picked)

**Axis — CONTROL (who decides which address to hit):**

```
  "who decides the URL?" — traced down the stack

  Client       → hardcoded relative paths ('/api/briefing')
                 → CODE decides
       seam #1: browser doesn't need DNS — same-origin
  Edge         → routes to Vercel function by hostname
                 → VERCEL config decides
       seam #2: route sees x-forwarded-* headers
  Route        → mcpUrl() precedence chain
                 → OVERRIDE > ENV > DEFAULT decides
  Route (OAuth)→ redirectUri() reads x-forwarded-host
                 → REQUEST-HEADERS decide
       seam #3: outbound TLS to picked origin
  Upstream     → whichever URL won the precedence chain

  control flips at every seam
```

**Seams:**
- Seam #1 — same-origin means no client-side DNS (browser reuses the connection to `<deployed-host>`).
- Seam #2 — Vercel edge → route: the edge inserts `x-forwarded-host` so the route knows the real inbound origin.
- Seam #3 — the outbound origin selection: the precedence chain decides which upstream to open.

## How it works

### Move 1 — the mental model

Two lookup tables — one for outbound (route → MCP), one for inbound (route → OAuth callback):

```
  Two lookup tables sitting inside the route

  outbound (which URL do we call?)
  ─────────────────────────────────
   override.url          ─┐
   MCP_URL env            │
   BLOOMREACH_MCP_URL env │  ← first match wins
   'https://loomi-mcp-   │
    alpha.bloomreach.com/mcp/' ┘

  inbound (what origin called us?)
  ─────────────────────────────────
   x-forwarded-host      ─┐
   host header            │  ← first match wins
   APP_ORIGIN env         │
   'http://localhost:3000' ┘
```

The pattern in both is the same: a precedence chain, first match wins, sane default at the bottom so a fresh clone works out of the box. That's the whole shape.

### Move 2 — the walkthrough

#### The outbound URL precedence chain

The MCP URL is picked once per request, inside `mcpUrl(override)`. The override comes from the per-request `x-bi-mcp-config` header (which came from the user's localStorage settings modal). If no override, fall through to `MCP_URL` env, then to the legacy `BLOOMREACH_MCP_URL` env, then to a hardcoded Bloomreach alpha URL as the sensible default.

From `lib/mcp/connect.ts:38-48`:

```ts
function mcpUrl(override?: McpConfigOverride): URL {
  // Precedence: override.url (from UI settings modal, per-request header) →
  // MCP_URL env → BLOOMREACH_MCP_URL env (legacy) → Bloomreach alpha default.
  // Unset env still yields a working example config out of the box.
  const raw =
    override?.url ??
    process.env.MCP_URL ??
    process.env.BLOOMREACH_MCP_URL ??
    'https://loomi-mcp-alpha.bloomreach.com/mcp/';
  return new URL(raw.replace(/\/+$/, '')); // strip trailing slash(es) — avoids a 307
}
```

Two details worth naming:

**The trailing-slash strip.** `URL.toString()` on `new URL('https://x/mcp/')` and `new URL('https://x/mcp')` are different strings; Bloomreach's Streamable HTTP transport 307-redirects the trailing-slash form to the non-trailing form. A 307 on every MCP call would double the round-trip count on this hop. Stripping it in advance avoids that.

**Bloomreach as a preset, not the identity.** The default at the bottom of the chain is a Bloomreach URL because a fresh clone needs to reach *something* HTTPS-shaped to demonstrate the flow. It's not baked-in — every other layer of the code (auth providers, tool schemas, retry ladder shapes) also works against arbitrary MCP servers. Set `MCP_URL=...` and you're pointing at a different server; the code doesn't notice.

```
  Outbound URL — precedence chain

  request → decodeConfigHeader(x-bi-mcp-config) → override|null
                                                       │
                                                       ▼
                            ┌──────────────────────────────────┐
                            │  mcpUrl(override) {              │
                            │    return                        │
                            │      override.url                │
                            │      ?? process.env.MCP_URL      │
                            │      ?? process.env.BLOOMREACH_  │
                            │           MCP_URL                │
                            │      ?? 'https://loomi-mcp-alpha │
                            │          .bloomreach.com/mcp/';  │
                            │  }                               │
                            └──────────────────────────────────┘
                                           │
                                           ▼
                    new URL(raw).replace(/\/+$/, '')
                                           │
                                           ▼
                          transport opens connection here
```

#### The inbound origin — deriving the OAuth redirect URI

This is the subtler routing decision, and the one that fails silently if you get it wrong. The OAuth flow needs a callback URL to hand to Bloomreach. If you hardcode it to `APP_ORIGIN`, then any request that lands on a preview deployment (`blooming-insights-git-branch-user.vercel.app`) initiates an OAuth flow whose callback lands on production (`APP_ORIGIN`). Different origin, different cookie jar, `bi_session` cookie doesn't come along — the callback route sees "no session" and 400s.

The fix — derive the callback origin from the actual inbound request. Vercel's edge inserts `x-forwarded-host` and `x-forwarded-proto` when it hands the request to the route. From `lib/mcp/connect.ts:50-71`:

```ts
async function redirectUri(): Promise<string> {
  // In production, derive the redirect from the ACTUAL request host so the OAuth
  // callback returns to the same origin that set the session cookie — preview
  // deployments and the production alias both work (DCR registers each host's
  // redirect URI on the fly). Without this, opening a per-deploy URL while the
  // callback goes to APP_ORIGIN drops the cookie → "no session". Locally we use
  // APP_ORIGIN (http://localhost), since there's no forwarded host.
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
}
```

Read it as another precedence chain: `x-forwarded-host` → `host` → `APP_ORIGIN` → localhost default. Same pattern as `mcpUrl` — first match wins, sensible default at the bottom.

The load-bearing detail: **DCR (Dynamic Client Registration) registers each host's redirect URI on the fly.** Bloomreach's OAuth server sees a request from a new preview deployment, registers that host's redirect URI in the client info, and issues tokens tied to that redirect URI. If the redirect URI in the callback doesn't match what was registered during connect, the token exchange fails. That's why deriving from the actual inbound host matters — the OAuth flow's two legs (`/connect` and `/callback`) have to agree on the redirect URI, and if you hardcode it, you're forcing every deployment onto the same origin.

```
  Inbound origin — deriving the callback URL

  browser ──HTTPS──► Vercel edge ──HTTP──► route function
                          │                       │
                          │ inserts:              │
                          │   x-forwarded-host    │
                          │   x-forwarded-proto   │
                          ▼                       ▼
                   ┌──────────────────────────────────┐
                   │  redirectUri() {                 │
                   │    const host =                  │
                   │      h.get('x-forwarded-host')   │
                   │      ?? h.get('host');           │
                   │    return `${proto}://${host}    │
                   │            /api/mcp/callback`;   │
                   │  }                               │
                   └──────────────────────────────────┘
                          │
                          ▼
                   hand to Bloomreach OAuth server as
                   the `redirect_uri` parameter
```

#### Client-side DNS — none

The browser-side of this repo doesn't do explicit DNS lookups. All `fetch()` calls in the client hooks are relative paths (`/api/briefing`, `/api/mcp/reset`, etc.), so the browser reuses the connection to whatever origin loaded the page. The one exception is the OAuth authorize-URL redirect — when the route returns `{ needsAuth: true, authUrl: '<bloomreach-idp-url>' }`, the browser does `window.location.href = authUrl`, which is a top-level navigation. That's where the browser resolves Bloomreach's IdP hostname.

From `lib/hooks/useBriefingStream.ts:173-181`:

```ts
if (res.status === 401) {
  const body = await readBody(res);
  if (body?.needsAuth && body?.authUrl) {
    window.location.href = body.authUrl as string;
    return;
  }
  // ...
}
```

That's the entire client-side DNS story: implicit, browser-managed, one lookup for the IdP origin during the OAuth handoff.

#### Node-side DNS — implicit through `fetch`

The route uses Node's `undici`-backed global `fetch`. DNS resolution is delegated to `dns.lookup` (the OS resolver), cached briefly by Node's default resolver (usually seconds, not minutes). No explicit `dns.setServers`, no `dnscache`, no `/etc/hosts` munging. If Bloomreach's DNS goes down, the fetch would fail with `ENOTFOUND` and the `SdkTransport.callTool` catch would surface it as an HTTP error via the captured body path (`lib/mcp/transport.ts:105-118`).

No SRV records, no service discovery, no consul. Origins are hardcoded HTTPS URLs; that's the whole address book.

### Move 3 — the principle

**When the address is a decision, put the decision in a precedence chain with a sane default at the bottom.** Both routing decisions in this repo use the same shape: user override wins, then env, then a hardcoded default that keeps the app runnable out of the box. The default isn't the identity — it's the sensible starting point. Making it a preset means shipping a fresh clone that works, while keeping every layer of the code (data source, auth provider, retry ladder) generic over the actual origin.

## Primary diagram

```
  DNS & routing — the full picture

  ┌─ Client band ──────────────────────────────────────────────┐
  │  fetch('/api/briefing?…')          ← relative path,        │
  │                                      no DNS involved       │
  │                                                            │
  │  window.location.href = authUrl    ← top-level nav,        │
  │                                      browser DNS lookup    │
  │                                      for Bloomreach IdP    │
  └──────────────────────────────┬─────────────────────────────┘
                                 │
                                 ▼
  ┌─ Edge band (Vercel) ───────────────────────────────────────┐
  │  routes to Node function by deploy hostname                │
  │  inserts:                                                  │
  │    x-forwarded-host  = <actual inbound host>               │
  │    x-forwarded-proto = 'https'                             │
  │  TLS terminated here                                       │
  └──────────────────────────────┬─────────────────────────────┘
                                 │
                                 ▼
  ┌─ Service band (route function) ────────────────────────────┐
  │                                                            │
  │  OUTBOUND URL SELECTION                                    │
  │  ────────────────────                                      │
  │  mcpUrl(override):                                         │
  │    override.url                                            │
  │      ?? MCP_URL                                            │
  │      ?? BLOOMREACH_MCP_URL                                 │
  │      ?? 'https://loomi-mcp-alpha.bloomreach.com/mcp/'      │
  │    → strip trailing slash                                  │
  │    → new URL()                                             │
  │                                                            │
  │  INBOUND ORIGIN DERIVATION                                 │
  │  ─────────────────────────                                 │
  │  redirectUri() (prod only):                                │
  │    h.get('x-forwarded-host') ?? h.get('host')              │
  │      → build `${proto}://${host}/api/mcp/callback`         │
  │    fallback: APP_ORIGIN                                    │
  │                                                            │
  │  Node's global fetch → OS dns.lookup                       │
  │                          (cached briefly, no explicit      │
  │                           override)                        │
  └──────────┬─────────────────────────────┬───────────────────┘
             │                             │
             │ hop 2: HTTPS to picked MCP  │ hop 3: HTTPS to
             │ origin (dynamic per request)│ api.anthropic.com
             ▼                             │ (hardcoded in SDK)
   ┌─ MCP server ──────────┐               ▼
   │  Bloomreach loomi     │       ┌─ Anthropic API ───┐
   │  (preset default) or  │       │  api.anthropic.com│
   │  arbitrary HTTPS MCP  │       │  (SDK-managed URL)│
   └───────────────────────┘       └───────────────────┘
```

## Elaborate

**Why precedence chains at all.** Any config value that might legitimately want to be overridden at three different layers (deploy-time env, request-time header, code default) needs a chain. The alternative — a single source of truth — either forces every user to fork the code (if the default is hardcoded) or breaks the "works out of the box" property (if the default is unset). Chains are the smallest thing that composes all three.

**What DCR (Dynamic Client Registration) buys you.** RFC 7591 lets an OAuth client register itself with the authorization server at runtime, sending its metadata (including `redirect_uris`) and receiving back a `client_id`. Without DCR, every deployment would need to be pre-registered with Bloomreach — which means every preview URL needs a config change on Bloomreach's side. With DCR, the code registers on the fly and Bloomreach accepts the redirect URI it just registered. That's what makes the `x-forwarded-host` trick work — the code can register a preview deployment's callback URI right before requesting an auth code, and the exchange works because the URIs match.

**On the client side, why relative paths matter.** Every browser `fetch('/api/…')` reuses the origin the page was loaded from, so if a user opens a preview deployment, the fetch calls stay on the preview deployment. The alternative — hardcoding `APP_ORIGIN` on the client — would send preview-deploy traffic to production, mixing cookies across origins. Relative paths are how you keep the browser and the callback on the same origin without any explicit routing logic.

**What's not exercised.** No SRV records, no service discovery, no CNAMEs pointing at internal LB names, no `dns.setServers`, no custom resolver. Origins are named hosts in code or config. Would become interesting if this app grew a per-region MCP tier, at which point service discovery (or a CNAME dance with region-affinity) would show up.

## Interview defense

**Q: The OAuth callback works on your production alias but not on a preview deployment — walk me through what's happening.**

The callback URI has to match between the `/connect` leg (where you register with the IdP) and the `/callback` leg (where you exchange the code). If you hardcode `APP_ORIGIN` in the redirect, both legs use the production origin, but the browser landed on a preview deployment — so the `bi_session` cookie set on the preview host doesn't come along when the browser redirects to the production origin. Callback route sees "no session" and 400s.

Fix: derive the redirect URI from `x-forwarded-host` in production (Vercel's edge inserts it). Then both legs agree on which origin they're using, DCR registers the preview host's URI on the fly, and the cookie stays scoped to the preview deployment.

```
  Without x-forwarded-host                With x-forwarded-host
  ────────────────────────                ─────────────────────
  browser on preview ─► /connect          browser on preview ─► /connect
    redirect_uri = APP_ORIGIN               redirect_uri = preview host
                                                     │
  IdP redirects to APP_ORIGIN             IdP redirects to preview host
    /callback ← different origin!           /callback ← same origin ✓
    bi_session cookie missing               bi_session cookie present
    → "no session"                          → completeAuth succeeds
```

Anchor: `lib/mcp/connect.ts:57-70`.

**Q: If I set `MCP_URL=https://my-server/mcp` at deploy time, but the user has a persisted config with `url: 'https://other/mcp'` — which wins?**

The user's persisted config, because it's per-request (rides the `x-bi-mcp-config` header) and the precedence chain in `mcpUrl` puts `override.url` first. If the user clears their persisted config (or never set one), the header is omitted, `decodeConfigHeader` returns `null`, `override.url` is undefined, and `MCP_URL` env wins.

The chain is: `override.url` → `MCP_URL` → `BLOOMREACH_MCP_URL` (legacy) → hardcoded default. First match wins.

Anchor: `lib/mcp/connect.ts:38-48`.

**Q: Where does DNS actually happen in this stack?**

Three places, all implicit. The browser resolves the deploy hostname when the user first loads the page (and again for a top-level nav to the OAuth IdP). The route's outbound `fetch` calls resolve Bloomreach and `api.anthropic.com` through Node's `undici`, which uses the OS resolver (`dns.lookup`). Vercel's edge resolves internally when routing to the function.

No explicit DNS caching, no service discovery, no CNAMEs pointing at internal LB names. All origins are hardcoded HTTPS URLs (or, for MCP, resolved by the precedence chain then handed to `new URL()` and to `fetch`).

## See also

- `01-network-map.md` — the full topology; this file zooms into the addressing layer of that map
- `05-http-semantics-caching-and-cors.md` — how the `x-forwarded-*` headers relate to cookie scoping
- `04-tls-and-trust-establishment.md` — where TLS terminates on the inbound side (right at the edge, which is why `x-forwarded-proto` exists)

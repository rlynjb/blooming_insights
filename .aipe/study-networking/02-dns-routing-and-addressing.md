# DNS, routing, and addressing

**Industry name(s):** name resolution, host routing, edge ingress, origin selection
**Type:** Industry standard · Language-agnostic

> How the three hostnames in this repo turn into IP addresses, who routes the request to whom, and which parts of that chain are deliberately delegated to the platform.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** There are exactly three hostnames in production traffic, and the app does not configure resolution for any of them. We hand a `URL` to `fetch` (or to the MCP SDK's `StreamableHTTPClientTransport`) and the platform — Node's resolver in the function, the browser's resolver in the tab, Vercel's edge in front of our function — does the rest.

```
Zoom out — where DNS lives in this app

┌─ Browser ────────────────────────────────────────────────────────┐
│  hostname: <project>.vercel.app  (or custom domain)              │
│  resolver: OS-level DNS via the browser                          │
│  ★ THIS APP DOES NOT CONFIGURE DNS HERE ★                         │
└─────────────────────────┬────────────────────────────────────────┘
                          │
┌─ Vercel edge / origin ──▼────────────────────────────────────────┐
│  inbound routing: hostname → function instance                   │
│  outbound resolver (inside the function): Node default           │
└─────────────────────────┬────────────────────────────────────────┘
                          │
   resolves: loomi-mcp-alpha.bloomreach.com   →  Bloomreach
            api.anthropic.com                 →  Anthropic
            (whatever AUTH_ORIGIN points at)  →  the same vercel host
```

**Zoom in — narrow to the concept.** The question this file answers: when the route handler calls `fetch(mcpUrl())`, what actually happens between "I have a URL string" and "bytes go on the wire"? The honest answer for this repo is *very little we own* — and naming that delegation, plus the one spot where we *do* care about hostname resolution (the OAuth redirect URI derivation), is the entire content of this file.

---

## Structure pass

**Layers.** Three layers of addressing in play. **Application** (the URL string we hand to `fetch` — `mcpUrl()`, `api.anthropic.com` baked into the Anthropic SDK, `/api/agent` for same-origin). **Transport** (Node's `undici` global agent / the browser's network stack — does the DNS lookup, decides keep-alive, connects the socket). **Edge / origin** (Vercel's CDN in front of our function decides which serverless instance receives the request; this is where multi-region behaviour would live if we configured any).

**Axis: control.** Trace "who decides where the bytes go?" across the three layers and the seams pop. **Application:** we own the URL string (and that's where `BLOOMREACH_MCP_URL` and the `x-forwarded-host`-derived redirect URI live). **Transport:** the platform owns it — Node decides keep-alive, the resolver picks an IP from the DNS answer, no `lookup` callback overrides anywhere in the code. **Edge / origin:** Vercel owns it — region selection, function-instance routing, no `vercel.json` override in the repo.

**Seams.** Two seams matter.

  → **Seam 1 (load-bearing for liveness): URL construction → resolver.** Failure flips from "wrong host string, immediately visible" to "right string, opaque DNS failure." The repo guards the *string* side carefully (strip trailing slash to avoid a 307, derive redirect from forwarded host) but cannot guard the resolver side from inside the function.
  → **Seam 2: edge ingress → function origin.** Failure flips from "browser sees a 5xx from Vercel" to "function sees a request." This is where the `x-forwarded-host` header is set (and why `connect.ts` reads it).

```
Two addressing seams — the answer to "who decides?"

  hop                         control sits with         flip across seam
  ───                         ─────────────────          ────────────────
  URL string → resolver       us → Node/undici          string → IP
  edge ingress → function     Vercel → us               public hostname →
                                                         x-forwarded-host
```

The skeleton is mapped — what follows is the mechanism that hangs on these two seams.

---

## How it works

### Mental model

DNS in this app is "give the platform a name, get back a connected socket." We never see the IP, we never set the resolver, we never cache lookups ourselves. The one place the *name itself* matters to the application is the OAuth redirect URI — that has to come back to the exact host the user is on, so we read `x-forwarded-host` per request instead of hardcoding `APP_ORIGIN`.

```
The shape — name → socket, two delegations + one read

  app code              platform                       provider
  ────────              ────────                       ──────────
  mcpUrl() ─────────►   undici resolver ─────────►    Bloomreach IP
  (URL string)          (DNS lookup, no cache         (TLS handshake)
                         we configured)               
                                                     
  x-forwarded-host ◄─── Vercel edge sets header                
  (we READ this to                                    
   build the OAuth                                    
   redirect URI)                                      
```

### Move 2 walkthrough

**The URL string is constructed once per call.** For Bloomreach, `mcpUrl()` reads `BLOOMREACH_MCP_URL` from env, defaults to `https://loomi-mcp-alpha.bloomreach.com/mcp/`, strips trailing slashes, and returns a `URL` object. The trailing-slash strip is a real bug-fix — leaving it on caused a 307 redirect from the alpha server, which the SDK doesn't carry the auth header through cleanly. For Anthropic, the URL is baked into `@anthropic-ai/sdk` — we never write `api.anthropic.com` anywhere; the SDK does. For same-origin browser fetches, the URL is a path string (`/api/briefing?demo=cached`), no host at all.

```
URL construction — three call sites, three patterns

  pseudocode for the three patterns:

  // Bloomreach — env-overridable, sanitized
  function mcpUrl():
    raw = env.BLOOMREACH_MCP_URL or default_url
    sanitized = strip_trailing_slashes(raw)        // ← avoids 307
    return new URL(sanitized)

  // Anthropic — opaque, SDK owns it
  function callAnthropic(prompt):
    client = new Anthropic({ apiKey: env.KEY })
    return client.messages.create({ … })           // ← hostname hidden inside SDK

  // Same-origin — no host, path only
  fetch('/api/briefing?demo=cached')                // ← browser fills in host
```

**The DNS lookup happens inside undici.** When the route handler in Node calls `fetch(mcpUrl())`, control passes to undici (Node's default fetch engine). Undici uses the system resolver via libuv — that's `getaddrinfo` on most platforms — which in turn consults `/etc/resolv.conf`, `/etc/hosts`, and any platform DNS cache. We do not configure any of this. We do not provide a custom `lookup`, do not set a `Dispatcher` with a DNS-aware connector, do not pre-resolve. This is `not yet exercised` from our side.

```
DNS lookup — what we do vs what undici does

  We do:                                undici does:
  ──────                                ───────────
  hand it a URL string                  parse host out of URL
                                        check connection pool for keep-alive
                                          → if hit, skip DNS entirely
                                        else: getaddrinfo(host)
                                          → OS resolver
                                          → /etc/resolv.conf
                                          → upstream DNS server
                                          → (whatever caches)
                                        TCP connect to one of the returned IPs
                                        TLS handshake
                                        send request
```

The boundary that catches people: there is no application-layer DNS caching here. If the system resolver is flaky or slow, every fresh connection pays the cost. We do not measure this.

**Inbound routing: hostname to function instance.** When a browser hits the production URL, Vercel's edge picks a serverless function region (defaults; we have no `vercel.json` overriding region), routes the request to a function instance (cold or warm), and forwards it. The function sees `x-forwarded-host` (the public hostname the user typed) and `x-forwarded-proto` (`https` in production). This is the one inbound DNS-related thing the app actually *reads*.

```
Inbound routing — what the function sees

  Browser sends:   GET / HTTP/1.1
                   Host: my-app.vercel.app

  Vercel edge:     selects region, picks function instance
                   adds:  X-Forwarded-Host: my-app.vercel.app
                          X-Forwarded-Proto: https

  Function reads:  headers.get('x-forwarded-host')   // ← used to build
                   headers.get('x-forwarded-proto')      // OAuth redirect URI
```

**The redirect-URI derivation — why we read the host.** OAuth requires the redirect URI registered with the IdP to exactly match the one used in the authorization request. If we hardcoded `APP_ORIGIN` and the user opened a preview deployment (different hostname), the IdP would 302 back to `APP_ORIGIN`, the cookies would be on `<preview>.vercel.app`, the callback would land at the wrong origin with no cookies, and the flow would die. So `redirectUri()` reads `x-forwarded-host` per request and rebuilds the URI on the fly. DCR (Dynamic Client Registration) registers each hostname's redirect URI lazily — every new preview deployment gets a fresh DCR client on first use.

```
Pseudocode — redirect URI per request

  function redirectUri():
    if env.NODE_ENV is 'production':
      try:
        host = headers().get('x-forwarded-host')         // ← from edge
              or headers().get('host')                    // ← fallback
        if host is set:
          proto = headers().get('x-forwarded-proto') or 'https'
          return `${proto}://${host}/api/mcp/callback`
      catch:
        // not in request scope — fall through
    return `${env.APP_ORIGIN or 'http://localhost:3000'}/api/mcp/callback`
```

### Principle

Delegate addressing as far down the stack as you can; the *one* exception is the case where the *name itself* leaks into a contract you depend on. In this app, that case is exactly one: the OAuth redirect URI has to match the user's actual host, so we read `x-forwarded-host` instead of trusting `APP_ORIGIN`. Everything else — DNS, region selection, IP pinning, resolver caching — is the platform's problem until measurement says otherwise.

---

## Primary diagram

The recap — name to socket, all three hostnames.

```
DNS + routing — full recap

UI band ─────────────────────────────────────────────────────────────
┌──────────────────────────────────────────────────────────────────┐
│  Browser tab                                                      │
│  URL bar: https://<app>.vercel.app                               │
│   ↓ OS-level resolver, browser-managed                            │
└──────────────────┬───────────────────────────────────────────────┘
                   │
Edge band ─────────▼───────────────────────────────────────────────
┌──────────────────────────────────────────────────────────────────┐
│  Vercel edge                                                      │
│  • routes hostname → function instance (region default)          │
│  • sets X-Forwarded-Host / X-Forwarded-Proto                     │
│  • adds TLS termination at edge for *.vercel.app                 │
└──────────────────┬───────────────────────────────────────────────┘
                   │
Service band ──────▼───────────────────────────────────────────────
┌──────────────────────────────────────────────────────────────────┐
│  Serverless function (Node runtime)                               │
│  • READS x-forwarded-host → redirect URI                         │
│  • CONSTRUCTS mcpUrl() once per connectMcp                       │
│  • DELEGATES DNS to undici → getaddrinfo → OS resolver           │
│  • NO custom resolver, NO app-layer cache, NO pinning            │
└──────┬────────────────────────────────────────────────┬──────────┘
       │                                                  │
Outbound resolves ▼                              Outbound resolves ▼
┌─────────────────────────────┐         ┌──────────────────────────┐
│  loomi-mcp-alpha            │         │  api.anthropic.com       │
│  .bloomreach.com            │         │  (hidden inside Anthropic │
│                              │         │   SDK; we never write     │
│                              │         │   the hostname)           │
└─────────────────────────────┘         └──────────────────────────┘
```

---

## Implementation in codebase

### Use cases

  → **Every cold function start.** First Bloomreach hop pays a fresh DNS lookup (no in-process cache pre-warmed by a build step). Warm starts hit undici's pool and skip the lookup until the keep-alive ages out.
  → **Preview deployment OAuth.** A new Vercel preview gets a unique hostname; the function reads `x-forwarded-host` and registers a fresh DCR client with that exact redirect URI. No env var to edit per preview.
  → **Local dev.** `x-forwarded-host` isn't set (Next.js dev server), so `redirectUri()` falls through to `APP_ORIGIN ?? 'http://localhost:3000'`.

### `mcpUrl()` and the trailing-slash strip

```
lib/mcp/connect.ts  (lines 25-29)

function mcpUrl(): URL {
  const raw =
    process.env.BLOOMREACH_MCP_URL ?? 'https://loomi-mcp-alpha.bloomreach.com/mcp/';
                          │
                          └─ env-overridable so tests and prod-staging
                             can point at different hosts; default is
                             the alpha endpoint Bloomreach published.
  return new URL(raw.replace(/\/+$/, ''));
                       │
                       └─ load-bearing: leaving the trailing slash on
                          caused a 307 redirect from the alpha server,
                          and the SDK doesn't carry the Authorization
                          header through redirects cleanly. Stripping
                          it sidesteps the whole class of bugs.
}
```

### `redirectUri()` — the one place hostname leaks into application logic

```
lib/mcp/connect.ts  (lines 31-52)

async function redirectUri(): Promise<string> {
  if (process.env.NODE_ENV === 'production') {
    try {
      const { headers } = await import('next/headers');
      const h = await headers();
      const host = h.get('x-forwarded-host') ?? h.get('host');
                          │
                          └─ x-forwarded-host is set by the edge with
                             the public hostname the user typed. host
                             is the fallback for runtimes that don't
                             set x-forwarded-host (rare on Vercel).
      if (host) {
        const proto = h.get('x-forwarded-proto') ?? 'https';
        return `${proto}://${host}/api/mcp/callback`;
                          │
                          └─ this URI must match what DCR registered
                             for THIS host. If it doesn't, the IdP
                             rejects the authorize request.
      }
    } catch {
      /* not in a request scope — fall through to APP_ORIGIN */
                          │
                          └─ headers() throws when called outside a
                             request (e.g. during a build); the
                             fallback is the static env var.
    }
  }
  return `${process.env.APP_ORIGIN ?? 'http://localhost:3000'}/api/mcp/callback`;
}
```

### No custom resolver, no DNS cache

There is nothing to point at — that's the finding. Grep for `dns`, `lookup`, `Agent({`, `Dispatcher` across `lib/` and `app/` returns no app-layer hits. The repo delegates DNS to undici and the OS without any override. If we later need it (e.g. to pre-warm Bloomreach's hostname on cold start, or to fail fast on resolver hangs), the insertion point would be `lib/mcp/transport.ts`'s `makeCapturingFetch` — but it doesn't do this today.

---

## Elaborate

DNS used to be the silent killer of cold-start latency in serverless. Modern platforms have largely fixed it (Vercel's runtime keeps warm pools, undici reuses connections within a function instance), but the cost is invisible until measured. If you ever see "fine when warm, 800 ms slow when cold," the resolver is the first thing to instrument.

The `x-forwarded-host` pattern is specific to platforms that put a reverse proxy in front of your code (Vercel, Cloudflare Workers, Fly.io). On a single-host deployment (a VPS running Next.js standalone), there's only one hostname, and `APP_ORIGIN` is enough. The DCR-per-hostname trick is what makes preview deployments work without env-var edits.

---

## Interview defense

**Q1: How does this app handle DNS?**

It doesn't. We delegate to undici (which delegates to libuv → OS resolver) for outbound, and to the browser/edge for inbound. No app-layer caching, no custom resolver, no pinning. The one place hostname matters to the application is the OAuth redirect URI, where we read `x-forwarded-host` per request so preview deployments and the production alias both work.

```
DNS responsibility diagram

  us:        URL string + redirect URI per request
  undici:    DNS lookup, TCP, keep-alive
  edge:      hostname → function region routing
```

Anchor: "we delegate addressing as far down as we can; the one exception is the redirect URI, because OAuth requires exact match."

**Q2: What's the consequence of having no app-layer DNS cache?**

Every cold start that needs a fresh connection pays the resolver cost. For two hostnames called a handful of times per request (~6 Bloomreach calls + ~4 Anthropic calls), this is single-digit ms in steady state. The risk is when the resolver is slow or flaky — there's no timeout, no retry, no fallback. A misbehaving resolver becomes a silent latency tax.

**Q3: Why is the trailing-slash strip in `mcpUrl()` load-bearing?**

The alpha endpoint 307s when you POST to `/mcp/` and the SDK doesn't carry the `Authorization` header through redirects cleanly. The strip avoids the redirect class of bugs entirely. It's one line, but it's a real production issue we hit.

---

## Validate

  1. **Reconstruct.** Without looking, name the three hostnames in production traffic and which side configures resolution for each.
  2. **Explain.** Why does `redirectUri()` read `x-forwarded-host` instead of using `APP_ORIGIN`? What breaks if it doesn't?
  3. **Apply.** A teammate reports OAuth works in production but not on the preview deployment. Without running the code, write the four most likely causes ordered by probability, citing the file you'd open first for each.
  4. **Defend.** Why is "no app-layer DNS cache" the right call today? What's the trigger (in concrete terms — load, latency, region) that would change the answer?

---

## See also

  → `01-network-map.md` — the four-band picture this file sits inside.
  → `04-tls-and-trust-establishment.md` — what happens once DNS hands us a socket.
  → `05-http-semantics-caching-and-cors.md` — the cookies that ride the same connection.

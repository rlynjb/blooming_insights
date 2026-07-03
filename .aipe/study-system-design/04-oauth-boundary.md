# oauth-boundary — PKCE + DCR across an encrypted-cookie trust seam

*Industry standard.* OAuth 2.1 with PKCE (Proof Key for Code Exchange) and Dynamic Client Registration (RFC 7591), backed by an app-owned session store split between production (encrypted cookie) and dev (gitignored JSON file).

## Zoom out, then zoom in

Every live-Bloomreach request needs a valid OAuth token. The token lives in an encrypted cookie in prod and a gitignored file in dev. The `OAuthClientProvider` interface is the contract the MCP SDK depends on; `BloomreachAuthProvider` is Blooming's implementation of it.

```
  Zoom out — where OAuth sits

  ┌─ Browser ────────────────────────────────────────────────────────┐
  │  bi:mode = 'live-bloomreach'  →  useBriefingStream                │
  │  session cookie: bi_session (httpOnly, secure)                    │
  │  auth cookie:    bi_auth     (httpOnly, secure, encrypted)        │
  └───────────────────────────┬──────────────────────────────────────┘
                              │  GET /api/briefing?mode=live-bloomreach
                              │  (cookies attached)
  ┌─ Route + session layer ───▼──────────────────────────────────────┐
  │  getOrCreateSessionId() → sid                                     │
  │  makeDataSource('live-bloomreach', sid)                           │
  │      → connectMcp(sid)  ← withAuthCookies wraps here              │
  └───────────────────────────┬──────────────────────────────────────┘
                              │
  ┌─ OAuth boundary ──────────▼──────────────────────────────────────┐
  │              ★ THIS FILE ★                                        │
  │  BloomreachAuthProvider (implements OAuthClientProvider)          │
  │      · redirect URI derived from x-forwarded-host                 │
  │      · PKCE verifier + state persisted per-session                │
  │      · Dynamic Client Registration (no pre-registered client_id)  │
  │  Storage: AsyncLocalStorage-scoped Store; flushed to               │
  │    · production → AES-256-GCM cookie (bi_auth)                    │
  │    · dev        → .auth-cache.json (gitignored)                    │
  │    · test       → in-memory Map                                    │
  └───────────────────────────┬──────────────────────────────────────┘
                              │  bearer token
  ┌─ Bloomreach ──────────────▼──────────────────────────────────────┐
  │  loomi-mcp-alpha.bloomreach.com/mcp                               │
  │      · alpha: revokes tokens after minutes                        │
  │      · rate-limits per user globally                              │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. The `OAuthClientProvider` port (from `@modelcontextprotocol/sdk`) is what the MCP SDK depends on. `BloomreachAuthProvider` (`lib/mcp/auth.ts:160-259`) is the adapter that implements that port with Blooming's session-keyed store.

## Structure pass

**Layers:** the *SDK layer* (MCP client + transport), the *provider layer* (`BloomreachAuthProvider`), the *storage layer* (three backends: cookie / file / in-memory).

**Axis:** *trust*. Above the boundary, the browser is the source of authentication proof (the encrypted cookie). Below, Bloomreach is the source of authorization proof (the bearer token). Blooming's server is the *bridge* — it never persists auth long-term, it just holds it for the duration of a request.

**Seam:** the `OAuthClientProvider` interface. The SDK depends on it; `BloomreachAuthProvider` implements it.

```
  Structure pass — one axis (trust) across the boundary

  browser side                            server side
  ────────────                            ───────────
  I have the encrypted cookie.            I have no long-term auth state.
  I forward it on every request.          I decrypt the cookie into an
                                          ALS-scoped Store for THIS request.
                                          I use it. I re-encrypt if dirty.
                                          I flush it back into the cookie.
                                          I forget it.

  the axis flips at the cookie boundary:
    browser: holds state across requests
    server:  holds state only within one request (ALS scope)
```

That "server holds no long-term state" is the load-bearing detail. It's what lets multi-instance Vercel deploys work — every instance is stateless-with-respect-to-auth. The cookie carries what the server needs to know.

## How it works

### Move 1 — the mental model

You've written `useState` and passed the setter into a child. The child doesn't own the state; it just reads and writes. That's what `BloomreachAuthProvider` does — it doesn't own the tokens, it reads from `readState(sessionId)` and writes via `patchState(sessionId, patch)`. The *store* owns them.

The store is the interesting piece: three backends, one interface (`readAll`, `writeAll`), chosen by `process.env.NODE_ENV`:

```
  Three storage backends — same interface, three shapes

     ┌── production ──────────────┐
     │  encrypted cookie (bi_auth) │  ← seeded from cookie at request start,
     │  AES-256-GCM under          │    flushed back at request end,
     │  AUTH_SECRET                │    ALS-scoped in between
     └──────────────┬─────────────┘
                    │
                    │           process.env.NODE_ENV chooses:
     ┌── dev ───────┴─────────────┐
     │  .auth-cache.json           │  ← survives Next's hot-reload
     │  gitignored                 │    (in-memory would be wiped)
     └──────────────┬─────────────┘
                    │
     ┌── test ──────┴─────────────┐
     │  in-memory Map              │  ← isolated per test run;
     │  no cookies, no files       │    _clearAuthStore() resets it
     └────────────────────────────┘
```

### Move 2 — the walkthrough

**The OAuth flow itself** — three server-side calls, one browser-side redirect:

```
  OAuth 2.1 + PKCE + DCR — the flow

  1. connectMcp(sid)
        · BloomreachAuthProvider(sid, redirectUri) constructed
        · SDK calls provider.clientInformation() → undefined (first time)
        · SDK runs Dynamic Client Registration → gets client_id
        · SDK calls provider.saveClientInformation(info)      [writes to store]
        · SDK generates PKCE verifier + state
        · SDK calls provider.saveCodeVerifier(v)             [writes to store]
        · SDK calls provider.redirectToAuthorization(url)
              → provider CAPTURES the URL (doesn't open browser)
              → provider.lastAuthorizeUrl = url
        · SDK throws UnauthorizedError
        · connectMcp catches, returns { ok: false, authUrl }
  
  2. Route returns 401 { needsAuth: true, authUrl } to the browser
  
  3. Browser does full-page redirect to authUrl (Bloomreach IdP)
  
  4. User authenticates at Bloomreach
  
  5. Bloomreach redirects back → GET /api/mcp/callback?code=...
  
  6. completeAuth(sid, code)
        · BloomreachAuthProvider(sid, redirectUri) reconstructed
        · SDK reads provider.codeVerifier() → the one saved in step 1
        · SDK exchanges code for tokens
        · SDK calls provider.saveTokens(tokens)              [writes to store]
        · Callback redirects browser back to the app
  
  7. Next /api/briefing call: connectMcp(sid) again
        · provider.tokens() → the saved tokens
        · SDK builds a valid transport with bearer token
        · returns { ok: true, mcp: BloomreachDataSource(...) }
```

The load-bearing detail in step 1: `redirectToAuthorization` **captures** the URL instead of navigating. The provider's `lastAuthorizeUrl` field (`lib/mcp/auth.ts:161`) is what makes the server-side "hand back the auth URL" pattern possible. Without it, the SDK would try to open a browser tab from a server-side function, which is nonsensical in an API route.

**The AsyncLocalStorage-scoped store** — `lib/mcp/auth.ts:41-46`, `86-104`:

The problem it solves: `OAuthClientProvider`'s methods are called MANY times per request by the SDK — `clientInformation()`, `tokens()`, `codeVerifier()`, etc., each firing on some internal SDK step. Reading the cookie fresh on every call would be wrong: **Next's cookie API returns the *request* cookie on read even after a `set` in the same request** — you'd read stale values. Writing to the cookie on every call would be wasteful and racy.

The fix: `withAuthCookies` seeds an ALS-scoped Store from the cookie *once* at the start of the request, lets the provider read/write it in memory, and flushes it back into the cookie *once* at the end if it was mutated.

```
  withAuthCookies — the AsyncLocalStorage wrap

  request in
     │
     │ cookies.get(bi_auth) → decryptStore → ctx.store
     │
     ▼
  ┌─ ALS.run(ctx, async () => { ... }) ────────────────────────────┐
  │                                                                 │
  │   provider.clientInformation()  → readAll() → ctx.store         │
  │   provider.tokens()             → readAll() → ctx.store         │
  │   provider.saveTokens(t)        → writeAll(...) → ctx.dirty=true│
  │   provider.state()              → patchState(...) → dirty=true  │
  │   ... N more calls, all hit ctx ...                              │
  │                                                                 │
  └────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
                   if ctx.dirty:
                     cookies.set(bi_auth, encryptStore(ctx.store), opts)

  result:
    one cookie read at request start
    one cookie write at request end (only if mutated)
    all provider calls run against in-memory state in between
```

Concurrent requests on the same warm Vercel instance each get their own ALS context, so they never see each other's Store. That's the concurrency-safety receipt.

**Dynamic Client Registration** — the reason a Blooming deployment needs no pre-registered client_id/client_secret. The provider's `clientMetadata` (`lib/mcp/auth.ts:172-181`) declares the app to Bloomreach the first time a session connects; Bloomreach returns a `client_id` which the SDK persists via `saveClientInformation`. From then on, that session's stored `client_id` is reused.

The load-bearing tradeoff: every session registers its own client, which means Bloomreach's client registry grows one entry per session. For an alpha this is fine; at production scale you'd want a shared pre-registered client. The current pattern is a demo-friendly shortcut, deliberately.

**The redirect URI trick** — `lib/mcp/connect.ts:36-57`. In prod, the redirect URI is derived from `x-forwarded-host` on the incoming request, not from a static `APP_ORIGIN` env var. Why: Vercel preview deploys and the production alias have different hosts, but the OAuth callback needs to return to the *same* host that set the session cookie. Without this derivation, opening a preview URL while the callback goes to the alias drops the cookie and the callback sees "no session."

**Move 2 variant — the skeleton.** Four load-bearing parts:

- **The `OAuthClientProvider` port.** Remove it and every route has to wire OAuth manually. The MCP SDK depends on this interface, so respecting it is not optional.
- **The AsyncLocalStorage wrap.** Remove it and the many-provider-calls problem returns — either stale cookie reads (if you re-read on every call) or racy writes (if you re-write on every call).
- **The dirty flag.** Remove it and every request writes a fresh cookie, even read-only ones. Not a correctness bug, but a wasted response header + `Set-Cookie` on 90% of requests.
- **The per-session key.** Remove it and one user can see another user's tokens. Every store access is `[sessionId]`-scoped for a reason.

Optional hardening: three backends chosen by NODE_ENV (dev-file for hot-reload survival; in-memory for test isolation); the `decryptStore` catch that returns `{}` on tampered cookies (rotates gracefully when AUTH_SECRET changes); the redirect-URI derivation for multi-host Vercel deploys.

### Move 3 — the principle

**The server holds no long-term auth state.** Every token, every PKCE verifier, every client_id lives in one of three per-request stores: the encrypted cookie (prod), the dev file (dev), the in-memory Map (test). The Blooming server code is stateless-with-respect-to-auth, which is why multi-instance Vercel deploys work — no coordination, no shared session store, no Redis.

The corollary that costs you: **the client bears the state weight.** The cookie payload grows with every session-scoped field the provider needs. Today that's `tokens` + `clientInformation` + `codeVerifier` + `state`. Each is small; the whole cookie is well under the 4KB limit. But every additional field is a shape you're locked into supporting via cookie migration, or your users get logged out on deploy.

## Primary diagram

```
  OAuth boundary — one frame

  ┌─ browser ───────────────────────────────────────────────────┐
  │  cookies:                                                    │
  │    bi_session  (identifies the user)                        │
  │    bi_auth     (AES-256-GCM: { sessionId → { tokens,        │
  │                                clientInfo, codeVerifier,    │
  │                                state } })                    │
  └──────────────────────────────┬──────────────────────────────┘
                                 │ every /api/* request
                                 ▼
  ┌─ Next server (Vercel, ephemeral instance) ──────────────────┐
  │                                                              │
  │  withAuthCookies(fn):                                         │
  │    ctx = { store: decrypt(bi_auth), dirty: false }           │
  │    ALS.run(ctx, async () => {                                 │
  │       BloomreachAuthProvider(sid, redirectUri)               │
  │          ↓  (reads/writes via readState/patchState)          │
  │       BloomreachAuthProvider.clientInformation()             │
  │       BloomreachAuthProvider.tokens()                        │
  │       BloomreachAuthProvider.saveTokens(...)                 │
  │       ... N provider calls, all hit ctx.store ...            │
  │    })                                                         │
  │    if ctx.dirty: cookies.set('bi_auth', encrypt(ctx.store))  │
  │                                                              │
  │  MCP SDK: StreamableHTTPClientTransport w/ authProvider      │
  │           ↓                                                   │
  │      HTTPS w/ bearer token                                   │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
                    Bloomreach loomi connect MCP
                    · Dynamic Client Registration
                    · Authorization Code + PKCE
                    · Refresh Token
                    · alpha: revokes tokens after minutes

  three backends behind readAll/writeAll:
    production → cookie (via ALS ctx)
    dev        → .auth-cache.json (hot-reload survival)
    test       → in-memory Map
```

## Elaborate

The OAuth 2.1 + PKCE + DCR combination is what a modern "no pre-registered client_id" flow looks like. PKCE (RFC 7636) closes the auth-code interception attack that plain OAuth 2.0 authorization-code flow has when the client is a public one (no client_secret). DCR (RFC 7591) lets the server sidestep having to hand every deploy a pre-provisioned client_id.

For Blooming specifically, DCR is what makes preview deploys work without operations overhead — every deploy URL gets its own client_id automatically. In a mature product you'd trade DCR for a pre-registered client at some point (per-tenant isolation, easier revocation, cleaner audit trail); for an alpha-facing tool it's the right pick.

The AsyncLocalStorage-based per-request store is *not* an OAuth pattern — it's a Next-specific workaround for the request-vs-response cookie split. Next's cookie API returns the incoming request's cookies on read, even after you've called `set` on the response. Without ALS, either you'd re-read the cookie on every provider call (getting stale data) or you'd cache the store in a module-level variable (which cross-contaminates concurrent requests). ALS gives you request-scoped state without cross-contamination.

What the code comments in `lib/mcp/connect.ts:1-14` acknowledge that this file doesn't try to hide: the OAuth flow is written against the documented SDK behavior but hasn't been fully verified against live Bloomreach auth end-to-end. Points to verify are enumerated. That's honest and rare.

What to read next:
- `study-security` — the trust-boundary analysis of encrypted cookies, CSRF, PKCE, and DCR at the mechanism altitude.
- `study-networking` — the HTTPS + `Set-Cookie` semantics and `SameSite=None` requirement for the cross-site OAuth return.
- `study-runtime-systems` — `AsyncLocalStorage` in Node/Vercel edge, how ALS interacts with `async/await`.

## Interview defense

**Q: "You've split auth storage three ways by NODE_ENV. Why not one backend everywhere?"**

A: Each environment has a different failure mode that would break the others:

- **Production wants stateless-per-instance.** Vercel's serverless instances are ephemeral; a cross-instance store would need Redis/KV. The encrypted cookie moves state to the client instead.
- **Dev wants survival across hot-reload.** Next's dev server re-evaluates modules on file changes, which would wipe an in-memory Map. The OAuth flow spans two requests (connect → callback), and mid-flow state (PKCE verifier + DCR client info saved in `connect` must survive to `callback`). A gitignored file survives.
- **Test wants isolation.** Cookies and files leak between test runs. An in-memory Map that `_clearAuthStore()` can reset is what enables parallel test execution without cross-contamination.

The three backends share one interface (`readAll` / `writeAll`), so `BloomreachAuthProvider` is written against that interface only. The environment picks which backend fires.

```
   NODE_ENV               backend                     survives
   ─────────              ───────                     ────────
   production             AES-256-GCM cookie          instance rotation ✓
   development            .auth-cache.json            hot-reload        ✓
   test                   in-memory Map               ...nothing        ✗
```

*Load-bearing part people forget:* the `withAuthCookies` wrap is a no-op in dev and test. It only fires in production. That way the ALS complexity doesn't get in dev's way — dev just reads and writes the file.

**Q: "AsyncLocalStorage sounds like a workaround for something. What?"**

A: Next's cookie API returns the *request* cookies on read, not any values you've `set` in the same response. So if you `set('bi_auth', v1)` and immediately `get('bi_auth')`, you get the OLD value back until the next request.

The `OAuthClientProvider` interface has a bunch of read+write methods that the MCP SDK calls many times per request — `clientInformation()`, `saveClientInformation()`, `tokens()`, `saveTokens()`, etc. If each one hit the cookie directly, either the reads would be stale or the writes would be racy.

ALS lets me seed the store from the cookie *once* at the top of the request, run all the provider's read/write calls against that in-memory copy, and flush back into the cookie *once* at the end. Each concurrent request on the same instance gets its own ALS context, so they never see each other's tokens.

```
   without ALS: N cookie reads + N cookie writes per request
                → stale reads OR racy writes

   with ALS:    1 cookie read + 1 cookie write per request
                → all N provider calls hit the in-memory ctx.store
```

*Load-bearing part people forget:* the `dirty` flag. Without it, every request writes a fresh cookie even if the provider only read from the store. That's a wasted `Set-Cookie` on every read-only path.

**Q: "Dynamic Client Registration means each session registers a new client_id with Bloomreach. What's that costing you?"**

A: Bloomreach's client registry grows one entry per user session. For an alpha, that's fine — the goal is zero-config integration for demos. In production you'd want a pre-registered client for four reasons: per-tenant isolation (all sessions share the same client_id, which lets Bloomreach report per-tenant instead of per-user), easier revocation (one client to revoke instead of hundreds), cleaner audit trail (one entity in the audit log), and slightly less overhead (skip the registration round-trip on first connect).

The reason DCR is the current pick anyway: the alpha Bloomreach server doesn't have per-tenant onboarding wired up. Nobody's minting client_ids for Blooming yet. DCR bypasses that operational blocker. When Bloomreach ships GA with an onboarding portal, Blooming replaces `BloomreachAuthProvider.clientMetadata` with a static `client_id` and skips the registration call.

*Load-bearing part people forget:* the SDK persists the client_id after DCR via `provider.saveClientInformation(info)`. Same session hitting connect again reads the stored `clientInformation` and skips DCR. So the "registers once per session" cost is *actually* "registers once per session that survives the auth-cookie lifetime." At 10-day cookie TTL, one DCR call per user per 10 days. That's cheap.

## See also

- `01-datasource-seam.md` — `BloomreachDataSource` sits below this boundary and consumes the bearer token via `SdkTransport`.
- `05-demo-vs-live-mode.md` — the demo mode entirely bypasses this boundary (creds-free); the toggle is what decides.
- `study-security` — the encrypted-cookie mechanism and PKCE security properties at the mechanism altitude.

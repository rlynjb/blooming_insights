# OAuth boundary

**Industry name(s):** OAuth 2.0 Authorization Code + PKCE, Dynamic Client Registration (RFC 7591), provider/strategy interface
**Type:** Industry standard · Language-agnostic

> The app authenticates to the Bloomreach MCP server by implementing the MCP SDK's `OAuthClientProvider` interface — which drives PKCE + Dynamic Client Registration automatically — capturing the authorize URL server-side instead of opening a browser, then completing the token exchange when the IdP redirects back to `/api/mcp/callback`.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** OAuth lives at the boundary between the Route handler and the Provider wrappers — it's the gate that turns a `bi_session` cookie into a `McpClient` that's allowed to call Bloomreach. `connectMcp` in `lib/mcp/connect.ts` either returns a ready client (existing tokens) or captures an `authUrl` for the page to redirect to (no tokens yet). The auth state itself rides between requests in two places: an encrypted `bi_auth` cookie in prod (carried by the browser) and a JSON file in dev. Everything in `lib/mcp/auth.ts` exists to solve the durability problem this band introduces — the connect request and the callback request are two separate hits, often on two separate Vercel instances.

```
Zoom out — where the OAuth boundary lives

┌─ UI ───────────────────────────────────────────┐
│  app/page.tsx (401 → window.location = authUrl)│
└─────────────────────┬──────────────────────────┘
                      │
┌─ Route handler ─────▼──────────────────────────┐
│  app/api/briefing/route.ts                     │
│  app/api/mcp/callback/route.ts (finishAuth)    │
└─────────────────────┬──────────────────────────┘
                      │  await connectMcp(sid)
┌─ Session + OAuth gate ─────────────────────────┐  ← we are here
│  lib/mcp/session.ts (bi_session cookie)        │
│  ★ lib/mcp/connect.ts (connectMcp) ★          │
│  ★ lib/mcp/auth.ts (BloomreachAuthProvider) ★ │
│  ★ bi_auth encrypted cookie (prod state) ★    │
└─────────────────────┬──────────────────────────┘
                      │  StreamableHTTPClientTransport
┌─ Provider wrappers + MCP ──────────────────────┐
│  lib/mcp/client.ts → Bloomreach MCP            │
└────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how does a server-side app run Authorization Code + PKCE + Dynamic Client Registration when it can't open a browser, has no pre-issued `client_id`, and runs in a process that may not even be the same one when the callback returns? The answer is the `OAuthClientProvider` interface — the SDK drives the protocol, our provider answers two questions ("where do you want to persist this?" and "what should happen on redirect?"). The next sections walk the four sub-mechanisms: PKCE+DCR, the provider's persistence shape, capture-don't-open `redirectToAuthorization`, and the `bi_auth` cookie that carries state across serverless instances.

---

## How it works

### Move 1 — Mental model

The MCP SDK owns the OAuth state machine. `StreamableHTTPClientTransport` + the auth module inside the SDK know when to register a client, when to build the PKCE challenge, when to redirect, and when to exchange the code. Our code implements one interface — `OAuthClientProvider` — which answers two questions the SDK asks: "where do you want to persist this?" and "what should happen when we need to redirect the user?"

```
┌─────────────────────────────────────────────────────────────────┐
│  MCP SDK auth state machine                                     │
│                                                                 │
│  1. Has client_id?  ──No──▶  POST /register (DCR RFC 7591)     │
│         │Yes                 └──▶ saveClientInformation()       │
│         ▼                                                       │
│  2. Has tokens?     ──No──▶  build PKCE, redirect URL          │
│         │Yes                 └──▶ saveCodeVerifier()            │
│         ▼                         redirectToAuthorization()     │
│  3. connect() returns / throws UnauthorizedError               │
└─────────────────────────────────────────────────────────────────┘
              │ calls                   │ calls
              ▼                         ▼
   BloomreachAuthProvider         BloomreachAuthProvider
   (our code: persist state)      (our code: capture URL)
```

The SDK calls into our provider at each step. Our provider stores values and, critically, captures the authorize URL instead of following it.

---

### Sub-section A — PKCE + DCR (no client secret)

PKCE (Proof Key for Code Exchange, RFC 7636) is the mechanism that replaces a `client_secret` for public clients. The SDK:

1. Generates a random `code_verifier` string.
2. Hashes it to produce `code_challenge`.
3. Sends `code_challenge` in the authorize URL.
4. Sends the raw `code_verifier` in the token exchange.

The IdP verifies `hash(code_verifier) === code_challenge`. No secret leaves the client.

Dynamic Client Registration (RFC 7591) lets the app POST its own metadata to the IdP's registration endpoint and receive a `client_id` on the fly. The provider exposes a `clientMetadata` getter that returns exactly this shape:

```
clientMetadata = {
  client_name:                "<app name>",
  redirect_uris:              [redirect_uri],
  grant_types:                ["authorization_code", "refresh_token"],
  response_types:             ["code"],
  scope:                      "openid profile email",
  token_endpoint_auth_method: "none",          # ← public client, no secret
}
```

`token_endpoint_auth_method: "none"` is the DCR declaration that this is a public client. The IdP accepts the code exchange without a `client_secret`.

```
Browser / Server-side app
         │
         │  1. POST /register  { client_name, redirect_uris, ... }
         ├──────────────────────────────────────────────────────▶ Bloomreach IdP
         │                                                            │
         │  ◀──────────────────  { client_id: "abc123", ... }  ──────┘
         │
         │  2. GET /authorize?client_id=abc123
         │       &code_challenge=<hash>
         │       &code_challenge_method=S256
         ├──────────────────────────────────────────────────────▶ Bloomreach IdP
         │
         │  3. Redirect to /api/mcp/callback?code=XYZ
         │  ◀────────────────────────────────────────────────────────┤
         │
         │  4. POST /token  { code: XYZ, code_verifier: <raw> }
         ├──────────────────────────────────────────────────────▶ Bloomreach IdP
         │
         │  ◀──────────────────  { access_token, refresh_token }  ───┘
```

---

### Sub-section B — The provider as a persistence seam

The auth provider is keyed by `sessionId`. Every SDK callback that carries data the app must remember calls a `patchState(sessionId, …)` helper — a partial-update write into the per-session auth state.

The per-session state shape:

| Field               | Type                          | Set by                        | Read by                        |
|---------------------|-------------------------------|-------------------------------|-------------------------------|
| `clientInformation` | `OAuthClientInformationMixed` | `saveClientInformation()`     | `clientInformation()`         |
| `tokens`            | `OAuthTokens`                 | `saveTokens()`                | `tokens()`                    |
| `codeVerifier`      | `string`                      | `saveCodeVerifier()`          | `codeVerifier()`              |
| `state`             | `string`                      | `state()` (generates + saves) | `consumeState()` (one-time)   |

The full per-session shape:

```
SessionAuthState = {
  clientInformation?:  OAuthClientInformationMixed,
  tokens?:             OAuthTokens,
  codeVerifier?:       string,
  state?:              string,
}
```

All four fields are optional. `patchState` merges into whatever already exists for that `sessionId` — it never overwrites unrelated fields.

```
sessionId = "uuid-a1b2c3"
                │
                ▼
┌───────────────────────────────────────────────┐
│  Store (file in dev, encrypted cookie in prod,│
│         in-memory Map in test)                │
│                                               │
│  "uuid-a1b2c3": {                             │
│    clientInformation: { client_id: "..." },   │  ← saved at DCR time
│    codeVerifier: "dBjftJeZ...",               │  ← saved before redirect
│    tokens: undefined,                         │  ← written at finishAuth
│    state: undefined                           │                          │
│  }                                            │
└───────────────────────────────────────────────┘
```

---

### Sub-section C — Capture-don't-open: `redirectToAuthorization`

When the SDK's `connect(transport)` runs and no token exists, the SDK calls `redirectToAuthorization(url)` on the provider, then throws `UnauthorizedError`. In a browser OAuth client this method would call `window.location.assign(url)`. In a server context there is no browser to navigate. The provider captures the URL instead:

```
provider.redirectToAuthorization(url):
    self.lastAuthorizeUrl = url       # stash, don't navigate
```

Back in the inner connect path, the `catch` block reads that captured URL and returns it as `{ ok: false, authUrl }`:

```
try:
    client.connect(transport)         # SDK drives DCR + PKCE
catch UnauthorizedError:
    if provider.lastAuthorizeUrl:
        return { ok: false, authUrl: str(provider.lastAuthorizeUrl) }
    raise
```

The route that called the connect helper receives `{ ok: false, authUrl }` and sends the URL back to the browser. The browser does the redirect. The server never opens a tab.

```
Route handler
     │
     │  await connectMcp(sessionId)
     ▼
 connectMcp
     │  client.connect(transport)  ──▶  SDK detects no token
     │                                        │
     │                                        │  provider.saveCodeVerifier(v)
     │                                        │  provider.redirectToAuthorization(url)
     │                                        │  throw UnauthorizedError
     │
     │  catch(err)
     │  provider.lastAuthorizeUrl ──▶ exists
     │
     │  return { ok: false, authUrl: "https://idp/authorize?..." }
     ▼
Route handler ──▶  Response: { authUrl }
     │
     ▼
Browser  ──▶  window.location = authUrl  ──▶  Bloomreach IdP login page
```

---

### Sub-section D — The callback exchange: `finishAuth`

After the user logs in, the IdP redirects to the callback route with a `?code=XYZ` query parameter. The callback route:

1. Reads the session cookie to recover `sessionId`.
2. Calls the auth-completion helper with that session id and the code.

The completion helper wraps its work in the auth-cookie context, reconstructs an auth provider for the *same* `sessionId`, and calls `transport.finishAuth(code)`. The SDK's `finishAuth` calls back into the provider:

- `provider.codeVerifier()` — reads the verifier saved during the connect phase from the store.
- `provider.clientInformation()` — reads the DCR `client_id` from the store.

It builds the token exchange POST and calls `provider.saveTokens(tokens)` when the IdP responds. The session is now authenticated.

```
/api/mcp/callback?code=XYZ
         │
         │  readSessionId()  ──▶  "uuid-a1b2c3"
         │
         │  completeAuth("uuid-a1b2c3", "XYZ")
         ▼
  BloomreachAuthProvider("uuid-a1b2c3")
         │
         │  transport.finishAuth("XYZ")
         ▼
  SDK reads from provider:
    codeVerifier()        ──▶  "dBjftJeZ..."  (from store)
    clientInformation()   ──▶  { client_id: "abc123" }  (from store)
         │
         │  POST /token { code: "XYZ", code_verifier: "dBjftJeZ..." }
         ▼
  Bloomreach IdP  ──▶  { access_token: "...", refresh_token: "..." }
         │
         │  provider.saveTokens(tokens)  ──▶  written to store
         ▼
  NextResponse.redirect("/")
```

---

### Sub-section E — Why dev persists to a file

The framework's dev server hot-reloads route modules when source files change and compiles routes on demand. When a module is re-evaluated, its module-level state resets. The in-memory fallback store is a module-level `Map`:

```
memStore: Map<sessionId, SessionAuthState>   # module-level, resets on reload
```

In test, if the module re-evaluates between the connect call (which writes `codeVerifier` and `clientInformation`) and the `finishAuth` call (which reads them), the `Map` is empty. `codeVerifier()` throws `"no PKCE code_verifier stored for this session"`. The flow is dead. Dev avoids this by writing to disk instead.

The file-backed store survives module re-evaluation because it writes to a gitignored JSON cache file on disk:

```
PERSIST     = env.NODE_ENV == "development"
CACHE_FILE  = cwd() + "/.auth-cache.json"   # gitignored
```

The `readAll`/`writeAll` helpers hit disk in dev. The state survives hot-reloads.

---

### Sub-section F — Why prod persists to an encrypted cookie

A serverless platform runs the connect request and the callback request on different ephemeral instances, so a module-level `Map` is empty by the time the callback reads it — and a disk file is read-only at runtime. The only state both requests can see is the browser. So in production the auth store is an **AES-256-GCM encrypted httpOnly cookie** named `bi_auth`, keyed by the session cookie, holding the same per-session shape the dev file holds (`clientInformation` + `codeVerifier` + `tokens`).

The `readAll`/`writeAll` helpers pick the backend by `NODE_ENV`: the request-scoped cookie store in prod, the file in dev, an in-memory `Map` in test. The crypto is three primitives: a key-derivation function turns the cookie-encryption secret into a 32-byte AES-256 key via SHA-256; an encode/decode pair GCM-encrypts/decrypts the JSON store to/from a base64url token. A tampered, rotated-secret, or corrupt cookie decrypts to `{}` (treated as no auth).

The problem the cookie creates is the framework's request-vs-response cookie split: a `cookies.get()` *after* a `cookies.set()` in the same request still returns the OLD value, so the provider's many synchronous read/write calls cannot touch the cookie directly. An auth-cookie context (`withAuthCookies(fn)`) solves this with an async-local-storage-scoped request store: it decrypts the cookie into an in-memory store ONCE at the start, runs `fn` (which reads/writes that store via the ALS context), and flushes it back to the cookie ONCE at the end — only if the store was mutated. Each request gets its own ALS context, so concurrent requests on one instance never share state. The connect and the auth-completion helpers both wrap their work in this context.

```
PROD request (connect or callback)
   │
   │  withAuthCookies(fn):
   │    decrypt bi_auth cookie ──▶ store  ──┐  ONCE, at start
   │                                        ▼
   │    requestStore.run(ctx, fn) ──▶  ┌──────────────────────────┐
   │                                   │ ALS-scoped store (ctx)   │
   │      provider.saveCodeVerifier ──▶│  readAll()/writeAll() hit│
   │      provider.codeVerifier()   ◀──│  ctx, set ctx.dirty=true │
   │      provider.saveTokens()     ──▶│                          │
   │                                   └──────────────────────────┘
   │    if ctx.dirty:                       │
   │      encrypt(ctx.store) ──▶ set bi_auth ┘  ONCE, at end
   │      (httpOnly, Secure, SameSite=None, 10-day maxAge)
   ▼
```

A test seam (`_authCookieCrypto`) exposes the encrypt/decrypt pair so the cookie crypto can be exercised without a request context. A `deleteAuthCookie` helper clears the cookie for the reset route.

The failure mode is explicit: the key-derivation step throws if the cookie-encryption secret is unset. Because the connect helper runs inside the auth-cookie context, that throw surfaces from the live route — and the briefing route now wraps its setup in a try/catch that returns the real message instead of a bare 500 (see 01-request-flow.md).

The `redirect_uri` is host-based: a `redirectUri()` helper is async and, in prod, derives the callback origin from the request's forwarded host (falling back to the bare host), so a preview deployment and the production alias both register their own redirect URI via DCR and the callback returns to the same origin that set the session cookie. Locally it uses an `APP_ORIGIN` env var.

The session and auth cookies are both `SameSite=None; Secure` in prod so they survive the cross-site OAuth round trip (the IdP redirect back to the callback route), and `Lax` in dev — set by the session helper's cookie-options factory and inline in the auth-cookie context.

---

### Move 2.5 — Phase A (dev) vs Phase B (serverless/prod)

```
Phase A — dev (single Node process)              Phase B — prod/serverless
                                                 (ephemeral, multi-instance)
┌──────────────────────────────────┐             ┌──────────────────────────────────┐
│  process: next dev               │             │  fn instance A (connect req)     │
│                                  │             │  withAuthCookies seeds ctx from  │
│  .auth-cache.json (gitignored)   │             │  bi_auth, flushes it back ──┐    │
│  ┌──────────────────────────┐    │             │  ┌──────────────────────────▼─┐ │
│  │  "uuid": {               │    │             │  │ set bi_auth (encrypted)    │ │
│  │    codeVerifier: "...",  │    │             │  └────────────┬───────────────┘ │
│  │    clientInformation: {} │    │             │   browser carries cookie        │
│  │  }                       │    │             │  ┌────────────▼───────────────┐ │
│  └──────────────────────────┘    │             │  │ fn instance B (callback)   │ │
│                                  │             │  │ decrypt bi_auth ──▶ verifier│ │
│  hot-reload safe: file on disk   │             │  └────────────────────────────┘ │
│  NODE_ENV === 'development'      │             │  finishAuth reads verifier ✓     │
│                                  │             │  NODE_ENV === 'production'       │
└──────────────────────────────────┘             └──────────────────────────────────┘
                                                 The cross-instance state lives in the
                                                 encrypted bi_auth cookie — the only
                                                 thing both requests can see.
```

The `NODE_ENV` checks select the backend. In production the read/write helpers hit the ALS-scoped cookie store seeded by the auth-cookie context; in dev the persist flag is `true` and the file is used; in test the in-memory `memStore` Map is used. The encrypted cookie — not a KV/Redis store — is what makes the connect→callback bridge work across ephemeral instances, because the browser is the only state both requests share.

---

### Move 3 — The principle

The SDK implements a complex, multi-step protocol (register → authorize → exchange → refresh). Our code implements a **provider interface** — a set of callbacks the SDK invokes at defined points. This is the Strategy pattern: the framework drives the algorithm; the implementor supplies the storage and redirect behavior. The provider interface is the seam between protocol execution and application-specific concerns.

---

## OAuth boundary — diagram

This diagram stands alone. It shows the complete connect → capture → redirect → callback → finishAuth → tokens loop across all four layers.

```
Browser layer
┌──────────────────────────────────────────────────────────────────────────┐
│  User visits / (the feed) or any MCP-gated page                          │
│       │                                                                  │
│       │  GET /api/mcp/connect (or inline connectMcp call)               │
│       ├─────────────────────────────────────────────────────────────────▶│
│       │                                                ▼                 │
│       │  ◀─── { authUrl: "https://idp/authorize?..." }                  │
│       │                                                                  │
│       │  window.location = authUrl                                       │
│       │─────────────────────────────────────────────────────────────────▶ IdP login
│       │                                                                  │
│       │  ◀─── redirect: /api/mcp/callback?code=XYZ                      │
│       │────────────────────────────────────────────────────────────────▶ │
└──────────────────────────────────────────────────────────────────────────┘
          │           ▲                         │
          ▼           │                         ▼

Our Route / Service layer
┌────────────────────────────────────────────────────────────────────────┐
│                                                                        │
│  connectMcp(sessionId)           /api/mcp/callback?code=XYZ           │
│  ┌────────────────────────┐      ┌──────────────────────────────────┐  │
│  │ new BloomreachAuth     │      │ readSessionId()  ──▶ "uuid"      │  │
│  │   Provider(sessionId)  │      │ completeAuth("uuid", "XYZ")      │  │
│  │                        │      │   └─▶ new BloomreachAuthProvider │  │
│  │ client.connect(trans.) │      │       transport.finishAuth("XYZ")│  │
│  │   ──▶ SDK runs OAuth   │      │   ──▶ tokens saved to store      │  │
│  │   ──▶ throws           │      │ redirect("/")                    │  │
│  │ catch: lastAuthorizeUrl│      └──────────────────────────────────┘  │
│  │ return { ok:false,     │                                            │
│  │   authUrl }            │                                            │
│  └────────────────────────┘                                            │
└────────────────────────────────────────────────────────────────────────┘
          │                                         │
          ▼                                         ▼

MCP SDK + AuthProvider layer
┌────────────────────────────────────────────────────────────────────────┐
│                                                                        │
│  StreamableHTTPClientTransport  +  BloomreachAuthProvider             │
│                                                                        │
│  connect phase:                    finishAuth phase:                  │
│  ┌──────────────────────────┐      ┌──────────────────────────────┐  │
│  │ POST /register  (DCR)    │      │ provider.codeVerifier()      │  │
│  │ saveClientInformation()  │      │ provider.clientInformation() │  │
│  │ saveCodeVerifier()       │      │ POST /token                  │  │
│  │ redirectToAuthorization()│      │ provider.saveTokens()        │  │
│  │ throw UnauthorizedError  │      └──────────────────────────────┘  │
│  └──────────────────────────┘                                        │
│                                                                        │
│  Store (file in dev / encrypted bi_auth cookie in prod / Map test):   │
│  { "uuid": { clientInformation, codeVerifier, tokens, state } }       │
│  prod: seeded + flushed once per request by withAuthCookies (ALS)     │
└────────────────────────────────────────────────────────────────────────┘
          │                                         │
          ▼                                         ▼

Provider / Network layer
┌────────────────────────────────────────────────────────────────────────┐
│  Bloomreach IdP  (register, authorize, token endpoints)                │
│  Bloomreach MCP server  (receives connected transport)                 │
└────────────────────────────────────────────────────────────────────────┘
```

After `saveTokens` completes, the next `connectMcp` call for the same session reads the tokens via `provider.tokens()`, `client.connect` succeeds, and `{ ok: true, mcp }` is returned — the MCP server is reachable.

---

## Implementation in codebase

| File | Function / Export | Lines | Role |
|---|---|---|---|
| `lib/mcp/auth.ts` | `BloomreachAuthProvider` | L160–L218 | Implements `OAuthClientProvider`; all persistence via `patchState`/`readState` |
| `lib/mcp/auth.ts` | `readAll` / `writeAll` | L113–L142 | Picks backend by `NODE_ENV`: ALS cookie store (prod), file (dev), `Map` (test) |
| `lib/mcp/auth.ts` | `aesKey` | L51–L60 | Derives AES-256 key from `AUTH_SECRET` (SHA-256); throws if unset |
| `lib/mcp/auth.ts` | `encryptStore` / `decryptStore` | L62–L79 | AES-256-GCM encode/decode the `Store` to/from the `bi_auth` cookie value |
| `lib/mcp/auth.ts` | `withAuthCookies` | L86–L104 | Seeds an ALS-scoped store from `bi_auth` once, flushes it back once (prod only) |
| `lib/mcp/auth.ts` | `AUTH_COOKIE` / `requestStore` | L47–L48 | `'bi_auth'` cookie name; `AsyncLocalStorage<RequestStore>` |
| `lib/mcp/auth.ts` | `_authCookieCrypto` | L244–L247 | Test seam exposing `encrypt`/`decrypt` without a request context |
| `lib/mcp/auth.ts` | `deleteAuthCookie` | L107–L111 | Clears `bi_auth` (reset route); no-op in dev/test |
| `lib/mcp/auth.ts` | `hasTokens` | L220–L222 | Boolean check used by routes to skip auth |
| `lib/mcp/auth.ts` | `clearAuth` | L237–L241 | Removes session from store (logout) |
| `lib/mcp/auth.ts` | `consumeState` | L230–L235 | One-time CSRF state validator (not wired in callback) |
| `lib/mcp/connect.ts` | `connectMcp` | L59–L64 | Wraps `connectMcpInner` in `withAuthCookies` (async) |
| `lib/mcp/connect.ts` | `connectMcpInner` | L66–L107 | Builds transport + provider, calls `client.connect`, catches `UnauthorizedError` |
| `lib/mcp/connect.ts` | `redirectUri` | L31–L52 | Async, host-based callback origin (`x-forwarded-host` in prod) |
| `lib/mcp/connect.ts` | `completeAuth` | L114–L122 | Reconstructs provider for session, calls `transport.finishAuth` (in `withAuthCookies`) |
| `lib/mcp/connect.ts` | `mcpUrl` | L25–L29 | Strips trailing slash from MCP URL to avoid 307 |
| `app/api/mcp/callback/route.ts` | `GET` | L5–L35 | Reads `code`, resolves session, calls `completeAuth`, redirects to `/` |
| `lib/mcp/session.ts` | `getOrCreateSessionId` | L16–L24 | Creates `bi_session` cookie on first request |
| `lib/mcp/session.ts` | `readSessionId` | L26–L29 | Reads existing `bi_session` (returns null if absent) |
| `lib/mcp/session.ts` | `sessionCookieOpts` | L10–L14 | `SameSite=None; Secure` in prod, `Lax` in dev |

**connect → needsAuth → callback → finishAuth pseudocode:**

```
// Phase 1: connect (connect.ts L59 connectMcp → L63 withAuthCookies)
sessionId = await getOrCreateSessionId()     // lib/mcp/session.ts L16
withAuthCookies(() =>                         // prod: seed/flush bi_auth around this
  connectMcpInner(sessionId):                 // connect.ts L66
    provider  = new BloomreachAuthProvider(sessionId, await redirectUri())  // L67, host-based
    transport = new StreamableHTTPClientTransport(mcpUrl(), { authProvider: provider })
    try:
      await client.connect(transport)         // SDK drives DCR + PKCE
      return { ok: true, mcp: new McpClient(...) }
    catch UnauthorizedError:                   // connect.ts L98
      if provider.lastAuthorizeUrl:
        return { ok: false, authUrl: provider.lastAuthorizeUrl.toString() }
)

// Phase 2: callback (connect.ts L114 completeAuth)
sessionId = await readSessionId()            // lib/mcp/session.ts L26
withAuthCookies(async () =>                    // prod: decrypt bi_auth → verifier + clientInfo
  provider  = new BloomreachAuthProvider(sessionId, await redirectUri())
  transport = new StreamableHTTPClientTransport(mcpUrl(), { authProvider: provider })
  await transport.finishAuth(code)            // reads codeVerifier + clientInfo from store
)
// provider.saveTokens() called by SDK → flushed to bi_auth under sessionId
redirect("/")
```

**GitHub links:**

- `lib/mcp/auth.ts` L160–L218 (`BloomreachAuthProvider`): https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/auth.ts#L160-L218
- `lib/mcp/auth.ts` L51–L104 (`aesKey` → `withAuthCookies`): https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/auth.ts#L51-L104
- `lib/mcp/auth.ts` L113–L142 (`readAll`/`writeAll`): https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/auth.ts#L113-L142
- `lib/mcp/connect.ts` L31–L122 (`redirectUri` → `completeAuth`): https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/connect.ts#L31-L122
- `app/api/mcp/callback/route.ts` L5–L35: https://github.com/rlynjb/blooming_insights/blob/main/app/api/mcp/callback/route.ts#L5-L35
- `lib/mcp/session.ts` L10–L29: https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/session.ts#L10-L29

---

## Elaborate

### Where it comes from

**OAuth 2.0** (RFC 6749, 2012) solved delegated authorization — a user can grant an app access to their resources without giving the app their password. **Authorization Code flow** added a server-side leg: the authorization server issues a one-time `code` that the app exchanges for tokens, keeping tokens off the URL fragment.

**PKCE** (RFC 7636, 2015) was designed for mobile and SPA clients that cannot keep a secret. It replaced `client_secret` with a cryptographic proof tied to the specific request. By 2019, the OAuth 2.0 Security BCP recommended PKCE for *all* Authorization Code flows — including confidential clients.

**Dynamic Client Registration** (RFC 7591, 2015) lets clients self-register with an authorization server at runtime. Rather than an admin pre-creating a `client_id`, the app POSTs its metadata and receives credentials. This is standard in MCP's auth model because MCP servers need to accept connections from arbitrary tools without pre-enrollment.

### The deeper principle

`OAuthClientProvider` is an **inversion of control** interface. The SDK calls into our code at defined extension points. Our code does not call the SDK for protocol steps — it just responds to callbacks. This makes the SDK testable (inject a mock provider), and it makes the provider portable (swap the store backend without touching any OAuth logic).

```
Without inversion of control            With inversion of control
─────────────────────────────           ────────────────────────────────
Our code calls:                         SDK calls our provider:
  buildAuthorizeUrl()                     saveClientInformation()
  sendTokenRequest()                      saveCodeVerifier()
  storeTokens()                           redirectToAuthorization()
  refreshIfExpired()                      saveTokens()
  ...                                     codeVerifier()
                                          tokens()
We own the state machine.               SDK owns the state machine.
```

### Where it breaks down

1. **Serverless / multi-instance**: Each function invocation gets a fresh process, so a module-level `Map` is empty on every cold start — if the connect request lands on instance A and the callback on instance B, `codeVerifier()` throws. Prod solves this WITHOUT a shared external store: the state rides the browser as the encrypted `bi_auth` cookie, seeded/flushed by `withAuthCookies` (`auth.ts` L86–L104). The residual concerns are different: cookie size (the `Store` must fit in ~4KB after base64url) and secret rotation (changing `AUTH_SECRET` makes every existing `bi_auth` decrypt to `{}`, forcing reauth). A KV/Redis store would lift the size cap but adds infra.

2. **CSRF state validation**: The SDK calls `state()` multiple times per flow (each `connect` call generates a new state). A naive "store last, compare on callback" check rejects legitimate callbacks. The `consumeState` function exists but is not wired into the callback route (comment at `app/api/mcp/callback/route.ts` L22–L26). A proper fix requires tracking all issued states, not just the last one.

3. **Token refresh**: If the access token expires between requests, the SDK should use the `refresh_token` via the provider's `tokens()` / `saveTokens()` flow. This is untested against live Bloomreach auth (connect.ts L1–L14 live-verification note).

### What to explore next

- How `StreamableHTTPClientTransport` uses the provider's `tokens()` to attach `Authorization: Bearer` to every MCP request — and when it calls `saveTokens` on refresh.
- The `consumeState` function (`auth.ts` L230–L235): how to make one-time CSRF state validation work when the SDK calls `state()` multiple times.
- RFC 7591 Section 3 (registration endpoint behavior) — what fields Bloomreach's IdP actually validates from `clientMetadata`.

---

## Interview defense

**What they are really asking:** Can you explain an OAuth flow you did not hand-roll? Can you identify the state durability problem in serverless? Can you defend the decision to use an SDK interface rather than own the protocol?

---

**[mid] — Walk me through what happens when a user first hits a page that needs MCP access and there are no tokens yet.**

I start `connectMcp` for their session. I build a `BloomreachAuthProvider` and a `StreamableHTTPClientTransport` and call `client.connect`. The SDK sees no `client_id` in the provider's store, so it POSTs to Bloomreach's registration endpoint with the `clientMetadata` (including `token_endpoint_auth_method: 'none'`). That succeeds — it gets back a `client_id` which the SDK saves via `saveClientInformation`. The SDK then builds the authorize URL with a PKCE `code_challenge` and a `state`, saves the raw `code_verifier` via `saveCodeVerifier`, calls `redirectToAuthorization(url)` — my provider captures the URL in `lastAuthorizeUrl` — then throws `UnauthorizedError`. My catch block reads `provider.lastAuthorizeUrl`, returns `{ ok: false, authUrl }`. The calling route sends the URL to the browser. The browser navigates to it. User logs in. IdP redirects to `/api/mcp/callback?code=XYZ`. The callback reads the session cookie, calls `completeAuth(sid, code)`, reconstructs the provider for the same session, calls `transport.finishAuth(code)`. The SDK reads the `codeVerifier` and `clientInformation` from the store, exchanges the code, gets tokens, calls `saveTokens`. Done.

```
Browser ──GET /page──▶ Route ──connectMcp──▶ SDK: no tokens
                                                │
                              catch { authUrl } │
                              ◀─────────────────┘
Browser ◀── { authUrl } ──────────────────────
Browser ──▶ IdP ──▶ /api/mcp/callback?code=XYZ
                        │
                    finishAuth ──▶ tokens saved
                        │
                    redirect /
```

---

**[senior] — The callback is failing with "no PKCE code_verifier stored for this session." What happened and where do you look?**

That error is thrown at `auth.ts` L215: `if (!v) throw new Error('no PKCE code_verifier stored for this session')`. It means `readState(sessionId).codeVerifier` is undefined when `finishAuth` calls `provider.codeVerifier()`. Three causes:

1. **Wrong session id in the callback.** `readSessionId()` at callback route L19 reads the `bi_session` cookie. If the cookie was not sent (e.g., the IdP redirect lost it — possible if `sameSite` is `strict` and the redirect crosses origins), `readSessionId` returns null, the route returns `{ error: 'no session' }` before `completeAuth` is called. But if the session id resolves to a *different* session than the one that ran `connectMcp`, you get this error.

2. **Module re-evaluated between connect and callback in dev, with file persistence broken.** If `.auth-cache.json` is corrupt or the file write silently failed (the `catch` at L139 swallows write errors), the verifier is not on disk. Reading it returns `undefined`. In prod the analog is a `bi_auth` cookie that decrypted to `{}` (tampered or `AUTH_SECRET` rotated).

3. **`connectMcp` was never called for this session** — the callback arrived for a session that never initiated the flow (e.g., a replayed callback URL, a different device).

I would check: (a) the `bi_session` cookie value in the connect request vs the callback request — they must match; (b) whether `.auth-cache.json` contains a `codeVerifier` for that session id; (c) whether `NODE_ENV` is correctly set to `'development'` so the file path is used.

---

**[arch] — Why use Dynamic Client Registration instead of just hardcoding a `client_id` in an env var? What's the actual cost of DCR?**

If I hardcoded a `client_id`, I would need Bloomreach to pre-register our app and issue credentials out-of-band. That is a manual enrollment step per deployment environment. DCR eliminates it — any instance of the app can register itself at runtime. The cost of DCR is that the `client_id` is ephemeral: if the IdP's registration store is wiped or the registration expires, our stored `client_id` is invalid. The SDK handles this by calling `saveClientInformation` on every successful DCR response, so the provider always has the latest `client_id`. The alternative (hardcoded) would be simpler for a single deployment but breaks multi-tenant or multi-instance scenarios where different sessions might need different registrations.

```
Hardcoded client_id:                      DCR:
ENV: CLIENT_ID=abc123                     no env config needed
      │                                        │
      ▼                                        ▼
connectMcp uses CLIENT_ID directly        SDK POSTs /register, gets client_id
Works until: Bloomreach rotates it        Works until: registration expires / IdP wipe
Fix: update env var, redeploy             Fix: SDK auto-retries registration
```

---

**The dodge — "why not just hand-roll the token exchange?"**

Honest answer: I could. OAuth 2.0 + PKCE + DCR are well-documented protocols. Writing `buildAuthorizeUrl` and `exchangeCodeForToken` is ~200 lines of boilerplate. The SDK gives me PKCE challenge generation, DCR retry logic, token refresh, and state management tested against the MCP spec. The tradeoff I accepted is reduced visibility into the protocol steps. The tradeoff I avoided is writing and maintaining that 200 lines myself, including edge cases like registration failure, refresh race conditions, and state parameter handling. If I ever needed behavior the SDK does not support (e.g., custom token introspection), I would hand-roll those specific pieces — not replace the entire SDK.

---

**One-line anchors:**
- `BloomreachAuthProvider` is a Strategy: the SDK is the algorithm, the provider is the behavior injection point.
- `redirectToAuthorization` does not navigate — it captures. That one word difference is what makes server-side OAuth work.
- The `codeVerifier` must survive from `saveCodeVerifier` to `codeVerifier()` — the dev file and the prod encrypted `bi_auth` cookie both exist to guarantee that.
- `finishAuth` (`connect.ts` L120) is the seam between the callback route and the OAuth token exchange — it is one line in our code because the SDK hides DCR lookup + PKCE + HTTP.
- `NODE_ENV` in `readAll`/`writeAll` (`auth.ts` L113–L142) selects the store: file in dev, encrypted `bi_auth` cookie in prod, `Map` in test — prod's cookie is what makes the serverless connect→callback bridge work.

---

## Validate your understanding

### Level 1 — Reconstruct

Without looking at the code, write the sequence of method calls the MCP SDK makes on `OAuthClientProvider` during a full connect → callback cycle. Start from "provider is constructed" and end at "tokens are available." Then check against `lib/mcp/auth.ts` L160–L218.

Expected sequence: `clientMetadata` (DCR POST) → `saveClientInformation` → `state` → `saveCodeVerifier` → `redirectToAuthorization` → [throw] → [callback] → `codeVerifier` → `clientInformation` → `saveTokens`.

### Level 2 — Explain

What is the purpose of `patchState` vs directly writing to `writeAll`? Why does it do a read-modify-write instead of a direct set?

Checkpoint: `lib/mcp/auth.ts` L148–L152. Answer: multiple fields are written in separate SDK callbacks during the same flow. A direct write would erase previously saved fields (e.g., overwriting `clientInformation` when saving `codeVerifier`). `patchState` merges the new fields with the existing session state.

### Level 3 — Apply

The callback is returning `{ error: 'no PKCE code_verifier stored for this session' }`. The browser's DevTools show the `bi_session` cookie is present and has the same value it had when the connect request was made. What do you check next, and which lines of code do you look at?

- Check `auth.ts` L113–L123 (`readAll`): is `PERSIST` true? Is `.auth-cache.json` present at `process.cwd()`? Does it contain the `sessionId` key with a `codeVerifier` field? (In prod, is the `bi_auth` cookie present and decrypting — or did `AUTH_SECRET` change?)
- Check `auth.ts` L125–L142 (`writeAll`): is the `catch` at L139 silently swallowing a write error? Add a `console.error` temporarily to verify the file write succeeds.
- Check `connect.ts` L114–L122 (`completeAuth`): is the `redirectUri()` the same value used in both the connect and the callback? If it differs (e.g., a per-deploy host vs the alias), the SDK may build a different provider state key.
- If `.auth-cache.json` exists but does not contain the session id, the `connectMcp` call wrote to a different `sessionId` than the callback is reading — the `bi_session` cookie was not sent on the connect request.

### Level 4 — Defend

A teammate proposes storing the `codeVerifier` in a `localStorage` item on the browser side (like some SPAs do) and sending it in the callback request body. What are the security implications, and why does the current server-side approach avoid them?

Answer points: `localStorage` is accessible to any JavaScript on the page — an XSS vulnerability exposes the verifier. The server-side store is never accessible to the browser. The `httpOnly` `bi_session` cookie cannot be read by JavaScript, so it cannot be exfiltrated by XSS. Sending the verifier in the request body requires the callback to be a POST, but OAuth IdPs always issue GET redirects. The server-side store + cookie session is the correct pattern for server-rendered OAuth clients.

### Quick check

- What is the cookie name used for session tracking? → `bi_session` (`lib/mcp/session.ts` L3); the prod auth store is the `bi_auth` cookie (`auth.ts` L48)
- What does `connectMcp` return when no token exists? → `{ ok: false, authUrl: string }` (`connect.ts` L21–L23, `ConnectResult`)
- What line throws if the PKCE verifier is missing? → `auth.ts` L215
- What `NODE_ENV` value activates file-backed storage? → `'development'` (`PERSIST`, `auth.ts` L34); `'production'` uses the encrypted cookie
- What HTTP method does the callback route implement? → `GET` (`app/api/mcp/callback/route.ts` L5)

## See also

→ 01-request-flow.md · → 03-provider-abstraction.md

---
Updated: 2026-05-28 — documented the PRODUCTION auth store: AES-256-GCM encrypted httpOnly `bi_auth` cookie keyed by `bi_session`, seeded/flushed once per request by `withAuthCookies` via an `AsyncLocalStorage` `requestStore` (`aesKey`/`encryptStore`/`decryptStore`/`readAll`/`writeAll`/`_authCookieCrypto`); added a Move-2 sub-section + ASCII diagram, reflected it in the primary diagram/Summary; noted host-based async `redirectUri()`, `SameSite=None; Secure` prod cookies, and the `AUTH_SECRET`-missing 500 failure mode; refreshed all line refs.
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".

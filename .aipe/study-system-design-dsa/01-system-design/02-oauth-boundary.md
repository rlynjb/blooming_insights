# OAuth boundary

**Industry name(s):** OAuth 2.0 Authorization Code + PKCE, Dynamic Client Registration (RFC 7591), provider/strategy interface
**Type:** Industry standard · Language-agnostic

> The app authenticates to the Bloomreach MCP server by implementing the MCP SDK's `OAuthClientProvider` interface — which drives PKCE + Dynamic Client Registration automatically — capturing the authorize URL server-side instead of opening a browser, then completing the token exchange when the IdP redirects back to `/api/mcp/callback`.

**See also:** → 01-request-flow.md · → 03-provider-abstraction.md

---

## Why care

You have a `fetch()` in your frontend that hits a protected API. It gets back a `401`. Your app bounces the user to `/login?return=...`, the IdP redirects back with a `code`, you exchange it for a token, store it in `localStorage`, and every subsequent `fetch` carries `Authorization: Bearer <token>`. You know what crossed the round-trip: the `?code=` in the redirect URL, and whatever you used to verify it wasn't tampered with. The question shifts when a *server* is the OAuth client — a Next.js route handler calling `client.connect(transport)`. It cannot open a browser tab. It has no `localStorage`. And in Dynamic Client Registration it does not even have a pre-issued `client_id` to paste into a config file.

The specific question is: how does a server-side app execute Authorization Code + PKCE when it must capture (not follow) the authorize redirect, has no pre-registered client, and runs in a process that hot-reloads mid-flow?

**The PKCE verifier and the DCR `client_id` MUST survive between the connect request and the callback request.** The SDK saves both to the provider during `client.connect()`. If the provider's store is wiped before `transport.finishAuth(code)` runs — because Next hot-reloaded the module — `finishAuth` throws `"Existing OAuth client information is required"` and the flow is dead. Every design decision in `lib/mcp/auth.ts` exists to solve exactly this durability problem.

Before this approach: every OAuth connection attempt would have required pre-registering a client with Bloomreach, embedding a `client_id` and `client_secret` in env vars, and writing a full authorize/exchange middleware by hand.

After: a 169-line provider class and a 10-line callback route. The SDK drives the protocol; the provider drives the persistence.

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

Dynamic Client Registration (RFC 7591) lets the app POST its own metadata to the IdP's registration endpoint and receive a `client_id` on the fly. The `clientMetadata` getter in `BloomreachAuthProvider` (L87–L96) declares exactly this:

```typescript
// lib/mcp/auth.ts L87–L96
get clientMetadata(): OAuthClientMetadata {
  return {
    client_name: 'blooming insights',
    redirect_uris: [this.redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: 'openid profile email',
    token_endpoint_auth_method: 'none',   // ← public client, no secret
  };
}
```

`token_endpoint_auth_method: 'none'` is the DCR declaration that this is a public client. The IdP accepts the code exchange without a `client_secret`.

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

`BloomreachAuthProvider` is keyed by `sessionId`. Every SDK callback that carries data the app must remember calls `patchState(sessionId, ...)` — a partial-update write into the `SessionAuthState` shape.

The `SessionAuthState` shape:

| Field               | Type                          | Set by                        | Read by                        |
|---------------------|-------------------------------|-------------------------------|-------------------------------|
| `clientInformation` | `OAuthClientInformationMixed` | `saveClientInformation()`     | `clientInformation()`         |
| `tokens`            | `OAuthTokens`                 | `saveTokens()`                | `tokens()`                    |
| `codeVerifier`      | `string`                      | `saveCodeVerifier()`          | `codeVerifier()`              |
| `state`             | `string`                      | `state()` (generates + saves) | `consumeState()` (one-time)   |

The full interface at `lib/mcp/auth.ts L10–L15`:

```typescript
interface SessionAuthState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
}
```

All four fields are optional. `patchState` merges into whatever already exists for that `sessionId` — it never overwrites unrelated fields.

```
sessionId = "uuid-a1b2c3"
                │
                ▼
┌───────────────────────────────────────────────┐
│  Store (file in dev, Map in prod)             │
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

When `client.connect(transport)` runs and no token exists, the SDK calls `redirectToAuthorization(url)` on the provider, then throws `UnauthorizedError`. In a browser OAuth client this method would call `window.location.assign(url)`. In a server context there is no browser to navigate. The provider captures the URL instead:

```typescript
// lib/mcp/auth.ts L120–L122
redirectToAuthorization(url: URL): void {
  this.lastAuthorizeUrl = url;
}
```

Back in `connectMcp`, the `catch` block reads that captured URL and returns it as `{ ok: false, authUrl }`:

```typescript
// lib/mcp/connect.ts L60–L68
} catch (err) {
  if (provider.lastAuthorizeUrl) {
    return { ok: false, authUrl: provider.lastAuthorizeUrl.toString() };
  }
  throw err;
}
```

The route that called `connectMcp` receives `{ ok: false, authUrl }` and sends the URL back to the browser. The browser does the redirect. The server never opens a tab.

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

After the user logs in, the IdP redirects to `/api/mcp/callback?code=XYZ`. The route:

1. Reads the `bi_session` cookie to recover `sessionId` (`readSessionId()`, L19 of callback route).
2. Calls `completeAuth(sid, code)` (L29).

`completeAuth` reconstructs a `BloomreachAuthProvider` for the *same* `sessionId` (L77) and calls `transport.finishAuth(code)` (L81). The SDK's `finishAuth` calls back into the provider:

- `provider.codeVerifier()` — reads the verifier saved during `connectMcp` from the store.
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
  NextResponse.redirect("/debug")
```

---

### Sub-section E — Why dev persists to a file

Next.js's dev server hot-reloads route modules when source files change and compiles routes on demand. When a module is re-evaluated, its module-level state resets. `memStore` is declared at module level:

```typescript
// lib/mcp/auth.ts L34
const memStore = new Map<string, SessionAuthState>();
```

If the route module re-evaluates between the `connectMcp` call (which writes `codeVerifier` and `clientInformation`) and the `finishAuth` call (which reads them), the `Map` is empty. `codeVerifier()` throws `"no PKCE code_verifier stored for this session"`. The flow is dead.

The file-backed store survives module re-evaluation because it writes to `.auth-cache.json` on disk:

```typescript
// lib/mcp/auth.ts L32–L33
const PERSIST = process.env.NODE_ENV === 'development';
const CACHE_FILE = join(process.cwd(), '.auth-cache.json');
```

`readAll()` always reads from disk in dev; `writeAll()` always writes to disk in dev. The file is gitignored. The state survives hot-reloads.

---

### Move 2.5 — Phase A (dev) vs Phase B (serverless/prod)

```
Phase A — dev (single Node process)              Phase B — prod/serverless
                                                 (ephemeral, multi-instance)
┌──────────────────────────────────┐             ┌──────────────────────────────────┐
│  process: next dev               │             │  fn instance A (connect req)     │
│                                  │             │  ┌──────────────────────────┐   │
│  .auth-cache.json (gitignored)   │             │  │  memStore: { verifier }  │   │
│  ┌──────────────────────────┐    │             │  └──────────────────────────┘   │
│  │  "uuid": {               │    │             │           │  cold-start          │
│  │    codeVerifier: "...",  │    │             │           ▼                      │
│  │    clientInformation: {} │    │             │  fn instance B (callback req)   │
│  │  }                       │    │             │  ┌──────────────────────────┐   │
│  └──────────────────────────┘    │             │  │  memStore: {}  ◀── EMPTY │   │
│                                  │             │  └──────────────────────────┘   │
│  hot-reload safe: file on disk   │             │                                  │
│  NODE_ENV === 'development'      │             │  finishAuth throws               │
│                                  │             │  "Existing OAuth client info..."  │
└──────────────────────────────────┘             └──────────────────────────────────┘
                                                 Fix: shared KV store (Redis/Vercel KV)
                                                 NODE_ENV gate in auth.ts L32 is the
                                                 switch point — replace memStore with
                                                 KV reads/writes.
```

The `NODE_ENV` gate at L32 is the only line that separates Phase A from Phase B. In production `PERSIST` is `false`, `memStore` is used, and the comment at L27 (`production still needs a shared store (KV/Redis)`) documents the upgrade path.

---

### Move 3 — The principle

The SDK implements a complex, multi-step protocol (register → authorize → exchange → refresh). Our code implements a **provider interface** — a set of callbacks the SDK invokes at defined points. This is the Strategy pattern: the framework drives the algorithm; the implementor supplies the storage and redirect behavior. The provider interface is the seam between protocol execution and application-specific concerns.

---

## OAuth boundary — diagram

This diagram stands alone. It shows the complete connect → capture → redirect → callback → finishAuth → tokens loop across all four layers.

```
Browser layer
┌──────────────────────────────────────────────────────────────────────────┐
│  User visits /debug or any MCP-gated page                                │
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
│  │   ──▶ throws           │      │ redirect("/debug")               │  │
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
│  Store (file in dev / Map in prod):                                   │
│  { "uuid": { clientInformation, codeVerifier, tokens, state } }       │
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

## In this codebase

| File | Function / Export | Lines | Role |
|---|---|---|---|
| `lib/mcp/auth.ts` | `BloomreachAuthProvider` | L75–L133 | Implements `OAuthClientProvider`; all persistence via `patchState`/`readState` |
| `lib/mcp/auth.ts` | `readAll` / `writeAll` | L36–L57 | File-backed store in dev, `Map` in prod |
| `lib/mcp/auth.ts` | `hasTokens` | L135–L137 | Boolean check used by routes to skip auth |
| `lib/mcp/auth.ts` | `clearAuth` | L152–L156 | Removes session from store (logout) |
| `lib/mcp/auth.ts` | `consumeState` | L145–L150 | One-time CSRF state validator (not wired in callback) |
| `lib/mcp/connect.ts` | `connectMcp` | L40–L69 | Builds transport + provider, calls `client.connect`, catches `UnauthorizedError` |
| `lib/mcp/connect.ts` | `completeAuth` | L76–L82 | Reconstructs provider for session, calls `transport.finishAuth` |
| `lib/mcp/connect.ts` | `mcpUrl` | L25–L29 | Strips trailing slash from MCP URL to avoid 307 |
| `app/api/mcp/callback/route.ts` | `GET` | L5–L34 | Reads `code`, resolves session, calls `completeAuth`, redirects |
| `lib/mcp/session.ts` | `getOrCreateSessionId` | L5–L13 | Creates `bi_session` cookie on first request |
| `lib/mcp/session.ts` | `readSessionId` | L15–L18 | Reads existing `bi_session` (returns null if absent) |

**connect → needsAuth → callback → finishAuth pseudocode:**

```
// Phase 1: connect
sessionId = getOrCreateSessionId()           // lib/mcp/session.ts L5
provider  = new BloomreachAuthProvider(sessionId, redirectUri)
transport = new StreamableHTTPClientTransport(mcpUrl(), { authProvider: provider })
try:
  await client.connect(transport)            // SDK drives DCR + PKCE
  return { ok: true, mcp: new McpClient(...) }
catch UnauthorizedError:
  if provider.lastAuthorizeUrl:
    return { ok: false, authUrl: provider.lastAuthorizeUrl.toString() }

// Phase 2: callback
sessionId = readSessionId()                  // lib/mcp/session.ts L15
provider  = new BloomreachAuthProvider(sessionId, redirectUri)
transport = new StreamableHTTPClientTransport(mcpUrl(), { authProvider: provider })
await transport.finishAuth(code)             // reads codeVerifier + clientInfo from store
// provider.saveTokens() called by SDK → stored under sessionId
redirect("/debug")
```

**GitHub links:**

- `lib/mcp/auth.ts` L75–L133: https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/auth.ts#L75-L133
- `lib/mcp/auth.ts` L36–L57: https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/auth.ts#L36-L57
- `lib/mcp/connect.ts` L40–L69: https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/connect.ts#L40-L69
- `lib/mcp/connect.ts` L76–L82: https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/connect.ts#L76-L82
- `app/api/mcp/callback/route.ts` L5–L34: https://github.com/rlynjb/blooming_insights/blob/main/app/api/mcp/callback/route.ts#L5-L34
- `lib/mcp/session.ts` L1–L18: https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/session.ts#L1-L18

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

1. **Serverless / multi-instance**: Each function invocation gets a fresh process. The `memStore` `Map` is empty on every cold start. If the connect request lands on instance A and the callback lands on instance B, `codeVerifier()` throws. The fix is a shared external store (Vercel KV, Redis, DynamoDB). The `NODE_ENV` gate in `auth.ts` L32 is the exact switch point.

2. **CSRF state validation**: The SDK calls `state()` multiple times per flow (each `connect` call generates a new state). A naive "store last, compare on callback" check rejects legitimate callbacks. The `consumeState` function exists but is not wired into the callback route (comment at `app/api/mcp/callback/route.ts` L22–L26). A proper fix requires tracking all issued states, not just the last one.

3. **Token refresh**: If the access token expires between requests, the SDK should use the `refresh_token` via the provider's `tokens()` / `saveTokens()` flow. This is untested against live Bloomreach auth (connect.ts L1–L14 live-verification note).

### What to explore next

- How `StreamableHTTPClientTransport` uses the provider's `tokens()` to attach `Authorization: Bearer` to every MCP request — and when it calls `saveTokens` on refresh.
- The `consumeState` function (`auth.ts` L145–L150): how to make one-time CSRF state validation work when the SDK calls `state()` multiple times.
- RFC 7591 Section 3 (registration endpoint behavior) — what fields Bloomreach's IdP actually validates from `clientMetadata`.

---

## Tradeoffs

| Dimension | SDK-driven provider + session-keyed file store (current) | Hand-rolled OAuth endpoints |
|---|---|---|
| Protocol correctness | SDK handles PKCE challenge generation, DCR registration, token refresh | Every step written by hand; easy to miss PKCE method or DCR retry |
| Code volume | ~170 lines total across auth.ts + connect.ts | ~300–500 lines: buildAuthorizeUrl, exchangeCode, refreshToken, store rotation |
| Hot-reload safety | File-backed store in dev; state survives module re-eval | Depends entirely on where developer stores the verifier |
| Serverless readiness | `memStore` breaks across instances; needs KV upgrade at one gate | Same problem, but scattered across multiple functions |

**Gave up:**
- Direct control over the authorize URL structure (query params are built by the SDK).
- Ability to customize token refresh timing (SDK decides when to refresh).
- Visibility into registration retries (DCR errors surface as generic SDK throws).

**What the alternative costs — the hand-rolled code we deleted:**
A complete hand-rolled implementation would have required: `buildAuthorizeUrl(clientId, codeChallenge, state, redirectUri)`, `exchangeCodeForToken(code, codeVerifier, clientId, redirectUri)`, a registration helper calling `/register`, and a refresh helper. Each function needs its own error handling, its own tests, and its own opinion about where to store state. The `connect.ts` file would be ~300 lines instead of 83.

**Breakpoint:**
The dev file store is correct for a single developer running `next dev`. It breaks the moment the app runs on Vercel (ephemeral, multi-instance). The upgrade path is: replace the `if (!PERSIST) { memStore }` branches in `readAll`/`writeAll` (L36–L57) with a KV client. No other file changes needed.

---

## Tech reference (industry pairing)

### @modelcontextprotocol/sdk (OAuthClientProvider + StreamableHTTPClientTransport)

- `OAuthClientProvider` is the interface declared in `@modelcontextprotocol/sdk/client/auth.js`. `BloomreachAuthProvider` implements it at `lib/mcp/auth.ts` L75.
- `StreamableHTTPClientTransport` (imported at `connect.ts` L16) wraps the HTTP + SSE transport layer and drives the OAuth state machine when an `authProvider` is passed.
- `transport.finishAuth(code)` is the SDK method that performs the token exchange. It reads `codeVerifier()` and `clientInformation()` from the provider, POSTs to the token endpoint, and calls `saveTokens()` on success.
- The SDK expects `redirectToAuthorization` to be synchronous and to signal to the caller (via the thrown `UnauthorizedError`) that auth is needed. The provider must NOT `await` anything inside this method.
- SDK version targeted: `v1.29.0` (noted in `connect.ts` L2).

### OAuth 2.0 PKCE + DCR

- PKCE (RFC 7636): `code_verifier` is a 43–128 character random string. `code_challenge = BASE64URL(SHA256(code_verifier))`. Method `S256` is mandatory for any implementation that supports it (the SDK uses S256).
- DCR (RFC 7591): the registration endpoint responds with `{ client_id, ... }`. The `client_id` is ephemeral — not guaranteed to persist across IdP restarts. The app must re-register if the IdP rejects the stored `client_id`. The SDK handles this via `saveClientInformation` / `clientInformation`.
- `token_endpoint_auth_method: 'none'` is the RFC 7591 value that declares a public client. The token endpoint does not require a `client_secret` in the request body.
- The `state` parameter (generated by `provider.state()` at `auth.ts` L98–L102) is the CSRF protection token. It is included in the authorize URL and returned by the IdP in the callback; the app should verify it matches before proceeding.
- Authorization Code + PKCE is recommended for all OAuth clients by the OAuth 2.0 Security BCP (RFC 9700, formerly draft-ietf-oauth-security-topics).

### cookie session (bi_session)

- `bi_session` is an `httpOnly`, `sameSite: lax` cookie set by `getOrCreateSessionId()` at `lib/mcp/session.ts` L8.
- `httpOnly: true` means the cookie is not accessible from `document.cookie` in the browser — it cannot be read by JavaScript, only sent automatically with requests.
- `sameSite: lax` prevents the cookie from being sent on cross-site POST requests (CSRF protection) while allowing it on top-level navigations (so the callback redirect from the IdP carries the session).
- The session id is a `crypto.randomUUID()` — 128 bits of entropy, collision-resistant for practical purposes.
- The cookie has no `maxAge`/`expires` — it is a session cookie (cleared when the browser closes). Setting `maxAge` would be the change to make sessions persist across browser restarts.

---

## Summary

The OAuth boundary in this codebase is the point at which a server-side Next.js app authenticates to the Bloomreach MCP server using OAuth 2.0 Authorization Code + PKCE + Dynamic Client Registration, without pre-registered credentials and without opening a browser. The MCP SDK drives the protocol. `BloomreachAuthProvider` implements the `OAuthClientProvider` interface, providing the SDK with persistence (via a session-keyed, file-backed store in dev) and URL capture (via `redirectToAuthorization` storing to `lastAuthorizeUrl` instead of navigating). The connect → capture → return cycle runs on the first request; the callback → `finishAuth` → tokens cycle runs when the IdP redirects back. The file store bridges the two cycles across Next hot-reloads.

- `BloomreachAuthProvider` is the only file that touches storage — swapping the backend (e.g., to Redis) requires changing `readAll`/`writeAll` only.
- The `NODE_ENV === 'development'` gate at `auth.ts` L32 is the single switch between file-backed (hot-reload-safe) and in-memory (serverless-unsafe) storage.
- The capture-don't-open pattern in `redirectToAuthorization` (L120–L122) is what makes server-side OAuth viable without `window.location`.
- `transport.finishAuth(code)` at `connect.ts` L81 is a one-liner that hides DCR client lookup, PKCE verifier retrieval, token POST, and token persistence.
- **Checklist step `4. State ownership`**: every piece of per-session OAuth state is owned exclusively by `BloomreachAuthProvider`, keyed by `sessionId` — no global variables, no module-level state outside the guarded `memStore`.
- **Checklist step `5. Failure handling`**: `connectMcp` catches `UnauthorizedError` and returns `{ ok: false, authUrl }` rather than bubbling it; `codeVerifier()` throws with a specific message when the verifier is absent; the callback route returns structured JSON errors for `?error=`, missing `code`, and missing session.

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
                    redirect /debug
```

---

**[senior] — The callback is failing with "no PKCE code_verifier stored for this session." What happened and where do you look?**

That error is thrown at `auth.ts` L130: `if (!v) throw new Error('no PKCE code_verifier stored for this session')`. It means `readState(sessionId).codeVerifier` is undefined when `finishAuth` calls `provider.codeVerifier()`. Three causes:

1. **Wrong session id in the callback.** `readSessionId()` at callback route L19 reads the `bi_session` cookie. If the cookie was not sent (e.g., the IdP redirect lost it — possible if `sameSite` is `strict` and the redirect crosses origins), `readSessionId` returns null, the route returns `{ error: 'no session' }` before `completeAuth` is called. But if the session id resolves to a *different* session than the one that ran `connectMcp`, you get this error.

2. **Module re-evaluated between connect and callback in dev, with file persistence broken.** If `.auth-cache.json` is corrupt or the file write silently failed (the `catch` at L55 swallows write errors), the verifier is not on disk. Reading it returns `undefined`.

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
- The `codeVerifier` must survive from `saveCodeVerifier` to `codeVerifier()` — everything in the file store exists to guarantee that.
- `finishAuth` is the seam between the callback route and the OAuth token exchange — it is one line in our code because the SDK hides DCR lookup + PKCE + HTTP.
- `NODE_ENV === 'development'` at L32 of `auth.ts` is the only line separating a working dev flow from a broken serverless deployment.

---

## Validate your understanding

### Level 1 — Reconstruct

Without looking at the code, write the sequence of method calls the MCP SDK makes on `OAuthClientProvider` during a full connect → callback cycle. Start from "provider is constructed" and end at "tokens are available." Then check against `lib/mcp/auth.ts` L75–L133.

Expected sequence: `clientMetadata` (DCR POST) → `saveClientInformation` → `state` → `saveCodeVerifier` → `redirectToAuthorization` → [throw] → [callback] → `codeVerifier` → `clientInformation` → `saveTokens`.

### Level 2 — Explain

What is the purpose of `patchState` vs directly writing to `writeAll`? Why does it do a read-modify-write instead of a direct set?

Checkpoint: `lib/mcp/auth.ts` L63–L67. Answer: multiple fields are written in separate SDK callbacks during the same flow. A direct write would erase previously saved fields (e.g., overwriting `clientInformation` when saving `codeVerifier`). `patchState` merges the new fields with the existing session state.

### Level 3 — Apply

The callback is returning `{ error: 'no PKCE code_verifier stored for this session' }`. The browser's DevTools show the `bi_session` cookie is present and has the same value it had when the connect request was made. What do you check next, and which lines of code do you look at?

- Check `auth.ts` L36–L44 (`readAll`): is `PERSIST` true? Is `.auth-cache.json` present at `process.cwd()`? Does it contain the `sessionId` key with a `codeVerifier` field?
- Check `auth.ts` L46–L57 (`writeAll`): is the `catch` at L55 silently swallowing a write error? Add a `console.error` temporarily to verify the file write succeeds.
- Check `connect.ts` L76–L82 (`completeAuth`): is the `redirectUri()` the same value used in both the connect and the callback? If it differs, the SDK may build a different provider state key.
- If `.auth-cache.json` exists but does not contain the session id, the `connectMcp` call wrote to a different `sessionId` than the callback is reading — the `bi_session` cookie was not sent on the connect request.

### Level 4 — Defend

A teammate proposes storing the `codeVerifier` in a `localStorage` item on the browser side (like some SPAs do) and sending it in the callback request body. What are the security implications, and why does the current server-side approach avoid them?

Answer points: `localStorage` is accessible to any JavaScript on the page — an XSS vulnerability exposes the verifier. The server-side store is never accessible to the browser. The `httpOnly` `bi_session` cookie cannot be read by JavaScript, so it cannot be exfiltrated by XSS. Sending the verifier in the request body requires the callback to be a POST, but OAuth IdPs always issue GET redirects. The server-side store + cookie session is the correct pattern for server-rendered OAuth clients.

### Quick check

- What is the cookie name used for session tracking? → `bi_session` (`lib/mcp/session.ts` L3)
- What does `connectMcp` return when no token exists? → `{ ok: false, authUrl: string }` (`connect.ts` L22–L23)
- What line throws if the PKCE verifier is missing? → `auth.ts` L130
- What `NODE_ENV` value activates file-backed storage? → `'development'` (`auth.ts` L32)
- What HTTP method does the callback route implement? → `GET` (`app/api/mcp/callback/route.ts` L5)

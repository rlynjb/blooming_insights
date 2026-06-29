# auth-boundary

## OAuth/PKCE/DCR with split storage backends (industry standard)

The boundary where browser sessions meet the Bloomreach loomi connect server. OAuth 2.0 with PKCE + Dynamic Client Registration; storage split across three backends keyed by environment; a `OAuthClientProvider` (the port that the MCP SDK consumes); a reconnect policy on the browser side to absorb the alpha server's habit of revoking tokens after a few minutes.

## Zoom out — where this pattern lives

The auth boundary sits between the session cookie that identifies the browser and the OAuth tokens that identify the workspace. Two cookies on the same hostname, both `httpOnly`, both 10-day max age.

```
  Zoom out — auth as a boundary between two cookies and a remote IdP

  ┌─ browser ──────────────────────────────────────────────────────┐
  │  bi_session cookie  (random session id, httpOnly)               │
  │  bi_auth cookie     (encrypted OAuth state, httpOnly, prod only)│
  └────────────────────────────┬───────────────────────────────────┘
                               │
  ┌─ Service layer ────────────▼───────────────────────────────────┐
  │  ★ AUTH BOUNDARY ★                                              │
  │    OAuthClientProvider (the port) ◄── BloomreachAuthProvider    │
  │    + withAuthCookies (AsyncLocalStorage scoped store)           │
  │    + useReconnectPolicy (browser-side recovery)                 │
  └────────────────────────────┬───────────────────────────────────┘
                               │  OAuth code/token exchange
  ┌─ Provider ─────────────────▼───────────────────────────────────┐
  │  loomi-mcp-alpha.bloomreach.com — IdP + MCP server              │
  │  (revokes tokens after minutes)                                 │
  └────────────────────────────────────────────────────────────────┘
```

The pattern is *standard OAuth/PKCE/DCR with a non-standard storage shape*. The SDK ships an `OAuthClientProvider` interface; this repo's adapter (`BloomreachAuthProvider`) implements it against three storage backends selected by environment.

## Structure pass

Three layers carry the auth boundary: the **client** layer (the cookie + the reconnect policy), the **service** layer (the route handlers + `withAuthCookies`), the **provider** layer (the adapter on top of the SDK's `OAuthClientProvider` port). One axis worth tracing: **where does the OAuth state actually live?**

```
  Axis: where does the OAuth state live?

  ┌─ client ───────────────────┐    seam: cookie read on request
  │  bi_session in cookie jar  │   ═════╪═════►
  │  bi_auth in cookie jar     │
  └────────────────────────────┘
       ┌─ service ─────────────────┐    seam: provider interface
       │  AsyncLocalStorage store   │   ═════╪═════►
       │  (seeded once per request) │
       └────────────────────────────┘
            ┌─ provider adapter ──────┐
            │  reads from ALS / dev   │
            │  file / test memStore   │
            └─────────────────────────┘
```

The state lives in *one* place at a time depending on the environment — but the adapter's read/write surface is identical across them. That's the load-bearing seam: an interface (`OAuthClientProvider`, from the MCP SDK) with one implementation in this repo that switches backends underneath.

## How it works

### Move 1 — the mental model

You've used a server-side session cookie before — a cookie with an opaque id, where the server keeps the real session data in a Redis or DB keyed by that id. This is the same shape, with two differences. First, the "session data" is OAuth client info + tokens + a PKCE verifier. Second, in production the server has no Redis or DB — it keeps the data encrypted *inside* a second cookie, decrypted on each request into an `AsyncLocalStorage` scoped store, re-encrypted at the end.

```
  The pattern: cookie-as-session-store + ALS for per-request scratch

  ┌─ request arrives ──────────────────────────────────┐
  │  bi_session=abc123      bi_auth=<encrypted blob>    │
  └─────────────────────┬──────────────────────────────┘
                        │  decryptStore() once
                        ▼
                  ┌──────────────────────────┐
                  │  AsyncLocalStorage store │  ← seeded once at request start,
                  │  { abc123: { tokens, …}} │    read/written many times during
                  └──────────┬───────────────┘    the request, flushed at end
                             │  many synchronous reads + writes
                             │  via OAuthClientProvider methods
                             │  (tokens(), saveTokens(), clientInformation(), …)
                             ▼
                  ┌──────────────────────────┐
                  │  encryptStore() once     │
                  │  → set bi_auth response  │
                  └──────────────────────────┘
```

The reason this matters: Next.js separates request cookies from response cookies. A read *after* a write within the same request returns the OLD value. If the provider read the cookie on every call (`tokens()`, `clientInformation()`, etc.), it would see stale data after the first save. The `withAuthCookies` wrapper reads ONCE at request start, flushes ONCE at request end, and keeps everything in between in the request-scoped ALS store.

### Move 2 — the step-by-step walkthrough

#### the three storage backends

The provider does not know which backend it's reading. Three branches in `readAll()` / `writeAll()` switch on environment:

```ts
// lib/mcp/auth.ts:34-36, 113-142
const PERSIST = process.env.NODE_ENV === 'development';
const CACHE_FILE = join(process.cwd(), '.auth-cache.json');
const memStore = new Map<string, SessionAuthState>();
…
function readAll(): Store {
  const ctx = requestStore.getStore();
  if (ctx) return ctx.store;                                  // PRODUCTION: ALS-scoped, cookie-backed
  if (!PERSIST) return Object.fromEntries(memStore);          // TEST: isolated in-memory
  …
  if (existsSync(CACHE_FILE)) return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Store;
  return {};                                                  // DEV: gitignored file
}
```

The discriminator is "is there an ALS context?" — present in production (because `withAuthCookies` set one), absent in dev and test. After that, `PERSIST` (true in dev only) distinguishes file from memory.

```
  Layers-and-hops — three backends, one provider interface

                          ┌─ readAll() ─┐
                          │  switch on  │
                          │  context    │
                          └──────┬──────┘
                                 │
                ┌────────────────┼────────────────┐
                │                │                │
                ▼                ▼                ▼
        ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
        │ production   │ │ test         │ │ development  │
        │ ALS store    │ │ memStore     │ │ .auth-cache  │
        │ (per request)│ │ (per process)│ │ .json (file) │
        └──────┬───────┘ └──────────────┘ └──────────────┘
               │
               ▼ encrypted-cookie-backed on the way in/out
       AES-256-GCM under AUTH_SECRET
       (bi_auth cookie)
```

#### the AsyncLocalStorage wrapper

This is the production-only part. `withAuthCookies(fn)` is the seam:

```ts
// lib/mcp/auth.ts:86-104
export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV !== 'production') return fn();      // dev/test: passthrough
  const { cookies } = await import('next/headers');
  const raw = (await cookies()).get(AUTH_COOKIE)?.value;
  const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };
  const result = await requestStore.run(ctx, fn);              // seed the ALS store
  if (ctx.dirty) {
    (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {
      httpOnly: true, secure: true, sameSite: 'none', path: '/', maxAge: AUTH_COOKIE_MAX_AGE,
    });
  }
  return result;
}
```

Three things to notice. (a) The cookie is read ONCE before `fn` runs; all the provider's synchronous reads/writes inside `fn` hit the ALS store. (b) The `dirty` flag avoids a needless `set` when no provider call mutated state. (c) `sameSite: 'none'` is required so the cookie survives the cross-site OAuth round-trip (browser leaves to the IdP, returns to `/api/mcp/callback` — `Lax` would drop the cookie on the return in some browsers).

`connectMcp` and `completeAuth` both wrap their work in `withAuthCookies` (`lib/mcp/connect.ts:64-69, 119-127`). The provider inside knows nothing about the cookie — it just reads via `readAll()` and writes via `writeAll()`.

#### the OAuthClientProvider adapter

`BloomreachAuthProvider` implements the SDK's `OAuthClientProvider` interface — that's the port. The SDK calls these methods during the OAuth dance; the adapter routes each call to the appropriate per-session field.

```ts
// lib/mcp/auth.ts:160-218
export class BloomreachAuthProvider implements OAuthClientProvider {
  public lastAuthorizeUrl?: URL;
  constructor(private sessionId: string, private redirectUri: string) {}

  get redirectUrl(): string { return this.redirectUri; }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'blooming insights',
      redirect_uris: [this.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'openid profile email',
      token_endpoint_auth_method: 'none',           // public client (no client secret)
    };
  }

  tokens(): OAuthTokens | undefined            { return readState(this.sessionId).tokens; }
  saveTokens(t: OAuthTokens): void             { patchState(this.sessionId, { tokens: t }); }
  clientInformation()                          { return readState(this.sessionId).clientInformation; }
  saveClientInformation(info)                  { patchState(this.sessionId, { clientInformation: info }); }
  saveCodeVerifier(v: string): void            { patchState(this.sessionId, { codeVerifier: v }); }
  codeVerifier(): string                       { /* throws if missing */ }

  redirectToAuthorization(url: URL): void {
    this.lastAuthorizeUrl = url;                 // CAPTURE — don't navigate; the route returns the URL to the browser
  }
}
```

The non-standard piece is `redirectToAuthorization`. On a normal client, that method would call `window.location.assign(url)`; here it just captures the URL. The SDK throws an `UnauthorizedError` immediately after; `connectMcp` catches it and returns `{ ok: false, authUrl }` so the route can hand the URL back to the browser as a 401 JSON body (the route does not own the redirect — the browser does, via `window.location.href = authUrl`).

```
  Layers-and-hops — the OAuth dance, first time

  ┌─ browser ─────────┐
  │  click "live"     │
  └────────┬──────────┘
           │  hop 1: GET /api/briefing?mode=live-bloomreach
           ▼
  ┌─ Next.js route ───────────┐  hop 2: makeDataSource('live-bloomreach', sid)
  │  app/api/briefing/route.ts│ ──────────────────────────────────────────►
  └────────┬──────────────────┘                                            ┌─ factory + connect ──┐
           │  hop 6: 401 + { needsAuth, authUrl }                          │  connectMcp(sid)     │
           │ ◄──────────────────────────────────────────────────────────── │    BloomreachAuth…   │
           │                                                                │    .redirectToAuth   │
           │                                                                │    captures URL      │
           ▼                                                                │  catch → return URL  │
  ┌─ browser ─────────┐                                                    └──────────────────────┘
  │  navigate to     │
  │  authUrl         │
  └────────┬─────────┘
           │  hop 3: OAuth at Bloomreach IdP (browser leaves the app)
           ▼
  ┌─ Bloomreach IdP ──┐
  │  user approves    │
  └────────┬──────────┘
           │  hop 4: 302 to /api/mcp/callback?code=…
           ▼
  ┌─ Next.js route ───────────┐  hop 5: completeAuth(sid, code) → saveTokens
  │  app/api/mcp/callback     │  (PKCE verifier read from this session's store)
  └────────┬──────────────────┘  bi_auth cookie set on response
           │
           ▼  302 to /
  (the next /api/briefing call has valid tokens; the dance does not repeat)
```

The PKCE verifier matters here. `saveCodeVerifier` writes it during `connect`; `codeVerifier()` reads it during `completeAuth`. In production they run on different ephemeral instances, so the verifier lives in the `bi_auth` cookie that travels with the browser. In dev they often run on the same process, so the file or memStore is fine.

#### the browser-side reconnect policy

The alpha Bloomreach server revokes tokens after a few minutes. Without a recovery path, every long-lived session would crash mid-briefing with an opaque "Unauthorized." `useReconnectPolicy` (`lib/hooks/useReconnectPolicy.ts`, 123 LOC) is the recovery:

```ts
// lib/hooks/useReconnectPolicy.ts:33-34
const AUTH_ERROR_RE_AUTO   = /invalid_token|unauthor|forbidden|401|session expired|reconnect/i;
const AUTH_ERROR_RE_BUTTON = /unauthor|forbidden|401|session expired/i;
```

Two regexes on purpose. `AUTO` is wider (`invalid_token` and `reconnect` included) — it's what the NDJSON error handler tests against to decide whether to fire the one-shot reset. `BUTTON` is what the explicit "reconnect" button uses to decide whether to show itself. The two are kept separate because unifying them needs verification against the live Bloomreach server, which isn't always available.

```ts
// lib/hooks/useReconnectPolicy.ts:84-111 (condensed)
const handle = useCallback((msg: string): boolean => {
  if (!isAuthErrorAuto(msg)) return false;
  const alreadyTried = sessionStorage.getItem(FLAG_KEY) === '1';
  if (alreadyTried) { sessionStorage.removeItem(FLAG_KEY); return false; }
  sessionStorage.setItem(FLAG_KEY, '1');           // one-shot guard
  fireReset();
  return true;
}, [fireReset]);
```

The flag is set in `sessionStorage` *before* `fireReset()` triggers a full page reload. After the reload, the next briefing's `done` event clears the flag (`useBriefingStream.ts:271, useReconnectPolicy.ts:113-120`). If the reconnect also fails (still an auth error after reload), the flag is already set → `alreadyTried = true` → the policy bails and surfaces the error instead of looping.

```
  The one-shot guard — sequence diagram

  briefing #1: tool_call → 401 "invalid_token"
       ↓
  NDJSON error event → useBriefingStream → handle(msg)
       ↓
  handle: isAuthErrorAuto = true, FLAG not set
       ↓
  set FLAG=1, fireReset() → POST /api/mcp/reset → window.location.href = '/'
       ↓
  page reloads
       ↓
  briefing #2: bootstrap → schema → … → done event
       ↓
  useBriefingStream calls onStreamComplete → useReconnectPolicy.clearFlag()
       ↓
  FLAG removed — next auth expiry can fire a fresh reconnect

  (failure path)
  briefing #2: tool_call → 401 again
       ↓
  handle: isAuthErrorAuto = true, FLAG SET → bail, return false
       ↓
  caller surfaces the error normally — no infinite reload
```

#### the reset route

`/api/mcp/reset` is what `fireReset()` calls before the page reload. It clears the per-session tokens and (in production) deletes the `bi_auth` cookie. The next `connectMcp` call sees no tokens → triggers a fresh OAuth dance → captures a fresh `authUrl` → the page renders the redirect, and the user re-authorizes.

### Move 3 — the principle

The auth boundary is *one interface, three backends, two cookies*. The interface (`OAuthClientProvider`) is the seam: the MCP SDK consumes it, this repo adapts it. The three backends are an environment-keyed switch under the same read/write surface — production gets a cookie-backed `AsyncLocalStorage` store, dev gets a file, test gets a Map. The two cookies separate identity (`bi_session`, never encrypted) from secrets (`bi_auth`, AES-256-GCM under `AUTH_SECRET`).

The transferable lesson: when serverless deployment forces "no shared store," the request cookie *is* a shared store — just one shared between two instances of the same browser. The trick is to (a) seed the store once at request start, (b) keep it in `AsyncLocalStorage` for the duration, (c) flush it once at request end. That pattern works for any per-session state that has to survive a redirect to an IdP and back to a different process.

## Primary diagram

```
  auth-boundary — full picture

  ┌─ browser ───────────────────────────────────────────────────────────┐
  │  cookies:                                                            │
  │    bi_session  (10d, httpOnly, SameSite=None/Lax)                    │
  │    bi_auth     (10d, httpOnly, SameSite=None, Secure, AES-256-GCM)   │
  │  sessionStorage:                                                     │
  │    bi:reconnecting  (one-shot guard for revoked-token reload)        │
  │                                                                      │
  │  useReconnectPolicy:                                                 │
  │    isAuthErrorAuto(msg)   → /invalid_token|unauthor|…|reconnect/i    │
  │    isAuthErrorButton(msg) → /unauthor|forbidden|401|session expired/ │
  │    handle(msg) → set flag + POST /reset + window.location='/'        │
  └────────────────────────────┬────────────────────────────────────────┘
                               │
  ┌─ Next.js routes ──────────▼────────────────────────────────────────┐
  │  /api/briefing /api/agent  /api/mcp/callback  /api/mcp/reset        │
  │                                                                      │
  │  withAuthCookies(fn):                                                │
  │    NODE_ENV !== production → passthrough                             │
  │    else: read bi_auth → decryptStore → seed ALS                      │
  │          run(fn) → flush ALS → encryptStore → set bi_auth on resp    │
  │                                                                      │
  │  connectMcp(sid):                                                    │
  │    new BloomreachAuthProvider(sid, redirectUri)                      │
  │    new StreamableHTTPClientTransport(mcpUrl, { authProvider, fetch })│
  │    client.connect(transport)                                         │
  │      ├─ has tokens? → BloomreachDataSource ready                     │
  │      └─ no tokens?  → SDK calls redirectToAuthorization → captures URL│
  │                       → throws UnauthorizedError                     │
  │                       → caught → return { ok: false, authUrl }       │
  │                                                                      │
  │  completeAuth(sid, code):                                            │
  │    rebuild provider for same sid → finishAuth(code) → saveTokens     │
  └────────────────────────────┬────────────────────────────────────────┘
                               │
  ┌─ storage backends ────────▼────────────────────────────────────────┐
  │  prod  → ALS store (seeded from bi_auth)                            │
  │  dev   → .auth-cache.json (gitignored)                              │
  │  test  → in-memory Map (reset via _clearAuthStore)                  │
  └────────────────────────────────────────────────────────────────────┘
```

## Elaborate

**OAuth flavors here.** Three RFCs in play. (a) OAuth 2.0 authorization code grant (the dance). (b) RFC 7636 — Proof Key for Code Exchange (PKCE) — the verifier+challenge protects the code from interception on the redirect leg. (c) RFC 7591 — Dynamic Client Registration — this app has no pre-registered `client_id`; the first `connectMcp` POSTs `clientMetadata` to the IdP, which returns a fresh `client_id` saved via `saveClientInformation`. DCR is what makes preview deployments work without provisioning a new client per URL.

**Why two cookies.** Identity vs secret. `bi_session` is just a random UUID; if leaked, the attacker still can't make a tool call. `bi_auth` carries tokens; it's encrypted at rest in the cookie value. Splitting them means the session id can be logged for tracing (which `Vercel`'s function logs do, see the per-request `{ sessionId }` field) without exposing the auth payload.

**Why `SameSite=None` and not `Lax`.** The OAuth flow leaves the app's origin (browser navigates to Bloomreach IdP) and returns to `/api/mcp/callback?code=…`. Under `SameSite=Lax`, the browser sometimes withholds the cookie on the return navigation (the behavior varies — Safari is the strictest). `SameSite=None` requires `Secure`, so it only works on HTTPS — local dev keeps `Lax` because `localhost` is plain HTTP.

**The `consumeState` orphan.** The SDK's OAuth flow calls `state()` multiple times during one dance (the adapter saves a UUID on each call). A naive "validate state on callback" check would fail because the *latest* saved state wouldn't match the one the IdP returns. `consumeState` is kept (and tested) for a future shared-store implementation that can track every issued state properly, but is not wired into the current callback.

**What changes if a shared store (Redis) lands.** The encrypted cookie goes away. `withAuthCookies` becomes a thin wrapper around `redis.get(sid)` / `redis.set(sid, ...)`. `BloomreachAuthProvider` doesn't change — it's already abstracted over the store. The deployment unit changes from "Vercel functions only" to "Vercel functions + Redis" (or KV).

## Interview defense

**Q: Walk me through what happens the first time a user clicks "live."**

> The page calls `GET /api/briefing?mode=live-bloomreach`. The route resolves or creates `bi_session`, then calls `makeDataSource` which calls `connectMcp(sid)`. `connectMcp` constructs a `BloomreachAuthProvider` over the session id and hands it to the MCP SDK's `StreamableHTTPClientTransport`. When the SDK tries `client.connect(transport)` with no tokens, it asks the provider for an authorize URL — the provider builds the URL with PKCE challenge and Dynamic Client Registration metadata, captures it on `lastAuthorizeUrl` instead of navigating, and lets the SDK throw `UnauthorizedError`. `connectMcp` catches the error, sees `lastAuthorizeUrl` is set, returns `{ ok: false, authUrl }`. The route sends 401 + the URL. The page navigates the browser to it. Bloomreach IdP redirects back to `/api/mcp/callback?code=…`, which calls `completeAuth(sid, code)`, which exchanges the code for tokens (reading the PKCE verifier from the per-session store), which saves the tokens via the provider. The browser is redirected to `/`, the next briefing fetch finds valid tokens, and the dance does not repeat for ~10 minutes (until the alpha server revokes).

```
  the first-click sequence — abbreviated

  click → /api/briefing → makeDataSource → connectMcp
                                              ├─ provider captures authorize URL
                                              └─ throws UnauthorizedError
       ← 401 + authUrl
  navigate → Bloomreach IdP → 302 /api/mcp/callback?code=…
  completeAuth → exchange code → saveTokens → 302 /
  retry → /api/briefing → tokens exist → stream insights
```

**Anchor:** `lib/mcp/connect.ts:71-112`, `lib/mcp/auth.ts:160-218`.

**Q: How does the production cookie store work? Why not just read/write the cookie on every provider call?**

> Next.js separates request cookies from response cookies. If you set a cookie value and then read it within the same request, you get the OLD value back — the new one only appears on the next request. The provider calls `saveTokens`, `saveCodeVerifier`, `saveClientInformation` many times during one OAuth dance, and reads them back in between. If each call went through the cookie API, every read after the first save would be stale. So `withAuthCookies` decrypts the cookie ONCE at request start into an `AsyncLocalStorage` store, lets the provider's many calls hit that store in memory, and encrypts + writes the cookie ONCE at the end if anything was dirty.

```
  why ALS — the read-after-write trap

  request start                          request end
       │                                       │
       │  cookies().get()  ──► decryptStore ──►│
       │                                       │  requestStore.run({store, dirty}, fn)
       │                                       │    fn calls many save/read pairs
       │                                       │    all hit ctx.store in memory
       │                                       │
       │  if dirty:                            │
       │    cookies().set(encryptStore(store)) │
       └───────────────────────────────────────┘

  Without ALS: every save → cookies.set → next read still sees OLD value
               (Next's request-vs-response split)
```

**Anchor:** `lib/mcp/auth.ts:38-104`.

**Q: The alpha server revokes tokens after a few minutes. What stops your UI from spiraling?**

> Two things. The first is `useReconnectPolicy`'s one-shot guard. When an auth-shaped error message arrives in the NDJSON stream, the hook checks a `sessionStorage` flag — if it's not set, the hook sets it, calls `/api/mcp/reset` to clear the per-session tokens, and reloads the page. The page reloads, the browser re-authorizes, the next briefing fires. On a successful briefing (the `done` event), the hook clears the flag so the next expiry can fire a fresh reset. The second is the failure branch: if the reload also gets an auth error (still `alreadyTried`), the hook bails and surfaces the error normally. The user sees the error, can click the explicit "reconnect" button (which uses a slightly narrower regex), and the system never enters a reload loop.

```
  the one-shot guard

  auth error #1 → flag NOT set → set flag → reset + reload
                                              │
                                              ▼
                                       briefing succeeds → done → clear flag
                                              OR
                                       briefing auth-errors again
                                              │
                                              ▼
                                       flag already set → bail (no loop)
```

**Anchor:** `lib/hooks/useReconnectPolicy.ts:84-120`, integrated at `lib/hooks/useBriefingStream.ts:274-284`.

## See also

- `01-request-flow.md` — the auth gate sits between `getOrCreateSessionId` and the streaming response
- `03-datasource-seam.md` — `makeDataSource` defers to `connectMcp` for the Bloomreach branch
- `07-in-memory-state-ownership.md` — the session id is the key for the feed map too
- `10-rate-limit-aware-mcp-client.md` — once auth is past, this is what happens on every call

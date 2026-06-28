# OAuth boundary — PKCE + DCR + encrypted-cookie store

**Industry name:** OAuth 2.1 Authorization Code + PKCE + Dynamic Client Registration · Industry standard

## Zoom out, then zoom in

The Bloomreach loomi connect MCP server doesn't ship us a `client_id` /
`client_secret`; we register dynamically on first connect (Dynamic Client
Registration, RFC 7591), then run a public-client PKCE flow. We hold the
OAuth state somewhere — and because Vercel's serverless instances are
ephemeral, "somewhere" can't be in-process memory: a connect on instance A
and a callback on instance B would otherwise lose the PKCE verifier and
the DCR client info. The fix is an encrypted cookie.

You've handled `fetch()` with `Authorization: Bearer ...`. This is the same
shape on the wire, but the boundary problem is: where does the bearer
token live, who holds it, and how does it survive a cross-instance hop?
The answer here is "the browser holds it, AES-256-GCM-encrypted, in an
httpOnly cookie."

```
  Zoom out — where the OAuth boundary lives

  ┌─ Browser ─────────────────────────────────────────────────────────────┐
  │  bi_session cookie (uuid)   bi_auth cookie (AES-256-GCM encrypted)    │
  └────────────┬───────────────────────────────┬──────────────────────────┘
               │ HTTP (Set-Cookie / Cookie)    │ HTTP (Set-Cookie / Cookie)
  ┌─ Service ──▼───────────────────────────────▼──────────────────────────┐
  │  withAuthCookies(req → fn → res)  ★ OAUTH BOUNDARY ★                  │ ← we are here
  │    BloomreachAuthProvider implements OAuthClientProvider              │
  │    AsyncLocalStorage-scoped Store seeded from cookie, flushed once    │
  └────────────────────────────────┬──────────────────────────────────────┘
                                   │ Bearer <token>
  ┌─ Provider ─────────────────────▼──────────────────────────────────────┐
  │  Bloomreach IdP + loomi connect MCP server                            │
  │  Authorization Code + PKCE + DCR (RFC 7591)                           │
  └───────────────────────────────────────────────────────────────────────┘
```

The pattern: the SDK (MCP's `OAuthClientProvider`) drives the OAuth dance
synchronously; we implement the provider with backing storage that lives
EITHER in a dev file OR in an encrypted browser cookie, depending on
environment.

## Structure pass — layers, axis, seams

**Layers:** Browser cookies → `withAuthCookies` (AsyncLocalStorage) →
`BloomreachAuthProvider` (the synchronous SDK-facing surface) →
MCP transport → Bloomreach IdP.

**Axis (held constant): "where does the auth state live?"** This is the
right axis because state-location is what flips at every seam, and
state-location is what makes the cross-instance problem real.

```
  Axis: where does the auth state live?

  ┌─ Browser ──────────────────────────────────────────┐
  │  bi_auth cookie (encrypted, httpOnly)              │   → CLIENT holds it
  └─────────────────────────────┬──────────────────────┘
                                │
  ┌─ withAuthCookies wrapper ───▼──────────────────────┐
  │  decrypt → AsyncLocalStorage Store → encrypt back  │   → REQUEST holds it
  └─────────────────────────────┬──────────────────────┘
                                │
  ┌─ BloomreachAuthProvider ────▼──────────────────────┐
  │  reads/writes Store (synchronously, no I/O)        │   → MEMORY holds it
  └─────────────────────────────┬──────────────────────┘
                                │
  ┌─ MCP SDK / IdP ─────────────▼──────────────────────┐
  │  Authorization: Bearer <access_token>              │   → WIRE carries it
  └────────────────────────────────────────────────────┘
```

**Seams (boundaries where the answer flips):**

- **Browser ↔ cookie wrapper** — the encryption boundary. Tampered or
  rotated-secret cookies decrypt to `{}` and become "no auth" silently
  (`lib/mcp/auth.ts:76-79`); we don't throw.
- **Cookie wrapper ↔ Provider** — the synchronous boundary. The SDK
  calls `provider.tokens()` / `provider.saveTokens(...)` synchronously
  many times per flow; the wrapper makes that possible by hydrating into
  ALS once per request and flushing once at the end.
- **Provider ↔ MCP transport** — the SDK-implementation boundary. We
  implement `OAuthClientProvider` (`lib/mcp/auth.ts:160-218`); the SDK
  drives the flow and tells us when to save what.

## How it works

### Move 1 — the mental model

You know how a `useState` setter doesn't update synchronously inside the
same render — you set, then read, and you get the OLD value? Next.js
cookies have the same gotcha: read a cookie *after* you `set` it in the
same request and you get the OLD value (because the read goes to the
incoming request's cookies, not the outgoing response's). The MCP SDK
calls `provider.tokens()` and `provider.saveTokens(...)` synchronously
many times during one auth flow. If we round-tripped each through
`cookies().set` and `cookies().get` we'd lose half the writes.

The pattern is: **hydrate once, mutate in-memory, flush once.**

```
  Pattern — the hydrate-once / flush-once envelope

  request comes in                                          response goes out
      │                                                            │
      ▼                                                            ▼
  ┌─ withAuthCookies(fn) ───────────────────────────────────────────┐
  │                                                                  │
  │   1. cookies().get('bi_auth') → ciphertext                       │
  │   2. decryptStore(ciphertext)  → Store                           │
  │   3. AsyncLocalStorage.run({store, dirty:false}, fn)             │
  │                                                                  │
  │       fn() body — provider reads & writes Store synchronously    │
  │       │                                                          │
  │       ├─ tokens()      → store[sid].tokens                       │
  │       ├─ saveTokens(t) → store[sid].tokens = t; dirty=true       │
  │       └─ saveClientInformation(c), saveCodeVerifier(v), state()  │
  │                                                                  │
  │   4. if dirty: cookies().set('bi_auth', encryptStore(store))     │
  │                                                                  │
  └─────────────────────────────────────────────────────────────────┘
```

The whole point: the SDK's synchronous calls hit an in-memory object
between (3) and (4); the cookie I/O happens once on each side.

### Move 2 — the step-by-step walkthrough

#### Step 1 — the two cookies do different jobs

There are TWO cookies, and confusing them is the first mistake.

```
  Two cookies, two jobs

  bi_session         bi_auth
  ──────────         ───────
  plain UUID         AES-256-GCM-encrypted Store
  the "user id"       the OAuth state
  set on first req   set/updated whenever auth state changes
  any caller uses    only auth.ts touches this
  SameSite=None      SameSite=None
```

`bi_session` is the join key — `lib/state/insights.ts:14` keys by it,
`BloomreachAuthProvider` keys by it, the demo capture flow keys by it.
`bi_auth` is opaque to everyone except `auth.ts`; it's the encrypted
store.

```typescript
// lib/mcp/session.ts:10-14
function sessionCookieOpts() {
  return process.env.NODE_ENV === 'production'
    ? { httpOnly: true, secure: true, sameSite: 'none' as const, path: '/' }
    : { httpOnly: true, sameSite: 'lax' as const, path: '/' };
}
```

`SameSite=None` matters: the OAuth callback comes from the IdP's origin
back to ours, which is a cross-site response. `Lax` would drop the
cookie on that return in some browsers; `None` + `Secure` keeps it.
Locally we fall back to `Lax` without `Secure` because `http://localhost`
doesn't send `Secure` cookies.

#### Step 2 — the connect call

`connectMcp(sid)` is the entry point. It wraps `connectMcpInner` in
`withAuthCookies` so the synchronous provider calls inside don't trigger
cookie I/O per call.

```typescript
// lib/mcp/connect.ts:64-69
export async function connectMcp(sessionId: string): Promise<ConnectResult> {
  return withAuthCookies(() => connectMcpInner(sessionId));
}

// lib/mcp/connect.ts:71-112 (abridged)
async function connectMcpInner(sessionId: string): Promise<ConnectResult> {
  const provider = new BloomreachAuthProvider(sessionId, await redirectUri());
  const httpErrors: HttpErrorHolder = { last: null };
  const transport = new StreamableHTTPClientTransport(mcpUrl(), {
    authProvider: provider,
    fetch: makeCapturingFetch(httpErrors),
  });
  const client = new Client({ name: 'blooming-insights', version: '0.1.0' }, { capabilities: {} });
  try {
    await client.connect(transport);            // ← the synchronous provider calls happen here
    return { ok: true,
             mcp: new BloomreachDataSource(new SdkTransport(client, httpErrors), {
               minIntervalMs: 1100,  retryDelayMs: 10_000,
               retryCeilingMs: 20_000,  maxRetries: 3,
             }) };
  } catch (err) {
    if (provider.lastAuthorizeUrl) {
      // No valid token → SDK called provider.redirectToAuthorization(url)
      // and then threw. Capture the URL for the browser to redirect to.
      return { ok: false, authUrl: provider.lastAuthorizeUrl.toString() };
    }
    throw err;
  }
}
```

The "thrown after redirectToAuthorization" path is what the audit's R1
risk depends on — it's how the SDK signals "I need the user to log in."

#### Step 3 — the provider's synchronous reads and writes

```typescript
// lib/mcp/auth.ts:160-218 (abridged)
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
      token_endpoint_auth_method: 'none',   // public client — no client_secret
    };
  }

  tokens():       OAuthTokens | undefined          { return readState(this.sessionId).tokens; }
  saveTokens(t):  void                              { patchState(this.sessionId, { tokens: t }); }
  clientInformation():           OAuthClientInformationMixed | undefined
                                                    { return readState(this.sessionId).clientInformation; }
  saveClientInformation(info):   void               { patchState(this.sessionId, { clientInformation: info }); }
  saveCodeVerifier(v):           void               { patchState(this.sessionId, { codeVerifier: v }); }
  codeVerifier():                string {
    const v = readState(this.sessionId).codeVerifier;
    if (!v) throw new Error('no PKCE code_verifier stored for this session');
    return v;
  }
  redirectToAuthorization(url):  void               { this.lastAuthorizeUrl = url; }
}
```

Note `redirectToAuthorization` doesn't actually redirect — it captures.
The route handler reads `provider.lastAuthorizeUrl` after the throw and
returns it in a 401 JSON body; the BROWSER does the redirect
(`useBriefingStream.ts:162-167`). This is the server-context adaptation
of an SDK designed for browser-context flows.

#### Step 4 — the ALS-scoped store

`patchState` and `readState` go through `readAll`/`writeAll`, which choose
the backend based on environment:

```typescript
// lib/mcp/auth.ts:113-142 (abridged)
function readAll(): Store {
  const ctx = requestStore.getStore();
  if (ctx) return ctx.store;                              // production: ALS-scoped, cookie-backed
  if (!PERSIST) return Object.fromEntries(memStore);      // test: isolated in-memory
  try {
    if (existsSync(CACHE_FILE)) return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch { /* corrupt — treat as empty */ }
  return {};                                              // dev: file
}

function writeAll(store: Store): void {
  const ctx = requestStore.getStore();
  if (ctx) { ctx.store = store; ctx.dirty = true; return; }   // production
  if (!PERSIST) { memStore.clear(); for (const [k, v] of Object.entries(store)) memStore.set(k, v); return; }
  try { writeFileSync(CACHE_FILE, JSON.stringify(store)); }   // dev
  catch { /* read-only FS — lose persistence */ }
}
```

```
  Three backends, one Store interface

  ┌─ test ─────────────────┐  ┌─ dev ──────────────────────┐  ┌─ prod ──────────────────────┐
  │  memStore: Map         │  │  .auth-cache.json (plain)  │  │  bi_auth cookie (AES-256-GCM)│
  │  isolated per run      │  │  gitignored                │  │  ALS-scoped Store per request │
  └────────────────────────┘  └────────────────────────────┘  └─────────────────────────────┘
```

Why three? **Test** needs isolation (`_clearAuthStore` resets it).
**Dev** needs to survive Next.js hot-reload (which re-evaluates modules
and would wipe in-memory state mid-OAuth-flow). **Prod** needs to
survive cross-instance hops (the IdP redirects to a *different* Vercel
serverless instance from the one that started the flow).

#### Step 5 — the encryption envelope

```typescript
// lib/mcp/auth.ts:62-79
function encryptStore(store: Store): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(store), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
}

function decryptStore(token: string): Store {
  try {
    const buf = Buffer.from(token, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', aesKey(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    return JSON.parse(plain);
  } catch {
    return {};   // tampered, rotated-secret, or corrupt → treat as no auth
  }
}
```

Cookie layout: `IV (12 bytes) || GCM tag (16 bytes) || ciphertext`,
base64url-encoded. `aesKey()` derives a 32-byte key by SHA-256 over
`AUTH_SECRET` (line 51-60), so secret rotation invalidates every
existing cookie (decryption fails → `{}` → no auth → re-login).

#### Step 6 — the callback round-trip

After the user authorizes at the IdP, the browser hits
`/api/mcp/callback?code=<authcode>`. That handler is tiny:

```typescript
// app/api/mcp/callback/route.ts:23-32
const sid = await readSessionId();
if (!sid) return NextResponse.json({ error: 'no session' }, { status: 400 });

try {
  await completeAuth(sid, code);
  return NextResponse.redirect(new URL('/', req.url));
} catch (e) {
  return NextResponse.json({ error: String(e) }, { status: 401 });
}
```

`completeAuth` re-wraps in `withAuthCookies` and calls
`transport.finishAuth(code)`, which uses the same provider (so the SDK
sees the PKCE verifier saved during connect) and saves the resulting
tokens — all synchronously, all into the ALS Store, all flushed back to
the cookie once at the end. See `lib/mcp/connect.ts:119-127`.

#### Step 7 — the redirect-URI quirk on Vercel

```typescript
// lib/mcp/connect.ts:36-57 (abridged)
async function redirectUri(): Promise<string> {
  if (process.env.NODE_ENV === 'production') {
    const { headers } = await import('next/headers');
    const h = await headers();
    const host = h.get('x-forwarded-host') ?? h.get('host');
    if (host) return `${h.get('x-forwarded-proto') ?? 'https'}://${host}/api/mcp/callback`;
  }
  return `${process.env.APP_ORIGIN ?? 'http://localhost:3000'}/api/mcp/callback`;
}
```

Why this matters: opening a per-deploy URL (preview deployments,
`https://blooming-pr-12-...vercel.app/`) while the callback goes to
`APP_ORIGIN` (`https://blooming-insights.vercel.app/`) drops the
session cookie on the return — different host, different cookie. DCR
re-registers per host on the fly so each deployment's redirect URI is
fresh.

### Move 3 — the principle

The principle: **synchronous state interfaces over asynchronous
storage need a request-scoped buffer.** The MCP SDK's
`OAuthClientProvider` is sync because it predates Node 20's
`AsyncLocalStorage`; cookies are async in Next.js because they're tied
to the HTTP request/response cycle. The mismatch isn't a flaw in
either side — it's a real engineering boundary that needs an envelope
(`withAuthCookies`) and a backing context (ALS) to bridge.

You'll see this same pattern anywhere a synchronous library plugs into
an async-storage world: ORM connection pools (sync `connection.query`,
async pool acquisition), DI containers in serverless (sync resolve,
async init), tracing libraries (sync `span.addEvent`, async exporter).
The envelope is always: hydrate once, mutate in memory, flush once.

## Primary diagram

```
  OAuth boundary — one full connect + callback round-trip

  Browser                       Service                              Bloomreach
  ───────                       ───────                              ──────────
  GET /api/briefing
      │ Cookie: bi_session=..., bi_auth=...
      ▼
                            ┌─ withAuthCookies ────┐
                            │ decrypt bi_auth      │
                            │ ALS.run({store}, ─┐  │
                            │                   │  │
                            │ connectMcp(sid)   │  │
                            │   provider.tokens()  │ → undefined (no auth)
                            │   client.connect()   │ ──── HTTP ───►   /.well-known/oauth-authorization-server
                            │   SDK: DCR if needed │ ──── HTTP ───►   POST /register
                            │   provider.saveClient│
                            │     Information(c)   │
                            │   SDK: build PKCE    │
                            │   provider.saveCode  │
                            │     Verifier(v)      │
                            │   SDK: redirect URL  │
                            │   provider.redirect  │
                            │     ToAuthorization()│
                            │   throws → caught    │
                            │ return { ok:false,   │
                            │   authUrl }          │
                            │                      │
                            │ ALS.run({store, dirty:true})
                            │ encrypt store        │
                            └──────────────────────┘
                            Set-Cookie: bi_auth=<encrypted>
                            Status 401 { needsAuth, authUrl }
      ◄────────────────────
  redirect → IdP login → consent
      │
      ▼
                                                                 GET /authorize?...
                                                            ◄──── redirect to /api/mcp/callback?code=AUTHCODE
  GET /api/mcp/callback?code=AUTHCODE
      │ Cookie: bi_session=..., bi_auth=<encrypted>
      ▼
                            ┌─ withAuthCookies ────┐
                            │ decrypt bi_auth      │
                            │ completeAuth(sid, c) │
                            │   provider.codeVer() │ → v (from previous request's flush)
                            │   SDK: POST /token   │ ──── HTTP ───►   POST /token (PKCE)
                            │   provider.saveTokens│
                            │ encrypt store        │
                            └──────────────────────┘
                            Set-Cookie: bi_auth=<encrypted, with tokens>
                            302 → /
      ◄────────────────────
  GET / (loads the feed)
      │ Cookie: bi_session=..., bi_auth=<with tokens>
      ▼
  GET /api/briefing
      │ same cookies
      ▼
                            connectMcp returns { ok:true, mcp }
                            and the briefing runs
```

## Elaborate

**Where this pattern comes from.** OAuth 2.1 + PKCE + DCR is the
state-of-the-art for public-client API access. PKCE (RFC 7636) closes
the authorization-code interception attack for clients that can't keep
a secret (mobile apps, SPAs, server-side apps where stealing the auth
code would otherwise be enough). DCR (RFC 7591) lets the server
provision the client_id at connect time, so we don't have to
pre-register and ship a config file with a static ID.

**The deeper principle.** A public client has no client_secret, so the
proof-of-possession moves into the protocol itself: PKCE asks the
client to invent a random `code_verifier`, hash it
(`code_challenge = SHA256(verifier)`), include the hash in the
`/authorize` request, and then prove possession by sending the original
verifier in the `/token` exchange. The verifier never travels on the
wire alone; the hash never travels with the verifier. An attacker who
intercepts the auth code can't redeem it without the verifier.

**Where it breaks.**

- **The MCP alpha server revokes tokens after minutes.** Refresh tokens
  exist in the OAuth spec; this codebase doesn't yet plumb them through.
  See audit R1. Today's recovery is a one-shot reset+reload via
  `useReconnectPolicy`.
- **OAuth state validation is currently disabled** (`auth.ts:230-236`,
  `app/api/mcp/callback/route.ts:23-27`). The MCP SDK calls
  `provider.state()` multiple times per flow, which broke a naive
  store-last/compare-on-callback check. The SDK does its own state
  handling; re-validating at our layer was redundant. Documented in the
  callback comment.
- **The `bi_auth` cookie has a 4KB ceiling.** Today's store is a single
  entry under `sessionId`, well under the limit; a refactor that
  multi-keys it could push past it. See audit R4.
- **`AUTH_SECRET` rotation invalidates every active session.** This is
  by design — `decryptStore` returns `{}` on a key mismatch and the user
  re-logs in. Worth knowing if you ever rotate the secret without a
  warning to users.

**What to explore next.**

- `01-request-flow.md` — where this OAuth gate runs in the route pipeline
- `05-caching-and-rate-limiting.md` — what happens AFTER the token lands
- `study-networking` — the HTTP semantics of OAuth on the wire
- `study-security` — token storage, threat model, rotation

## Interview defense

#### Q: "Why an encrypted cookie instead of Redis or KV?"

Two reasons. **One**: Vercel's free/pro tiers don't ship KV by default,
and the project's a demo — adding a KV dependency just for OAuth state
is overhead. **Two**: an encrypted cookie scales perfectly — there's no
shared store to consult, no cold-start hit, no replication concern. The
browser is the source of truth; we just need to encrypt + sign it so a
hostile client can't forge it. AES-256-GCM gives us both
(authenticated encryption — the GCM tag is the integrity check).

```
  Cookie-as-state — pros and cons in one frame

  pros                                cons
  ────                                ────
  no shared infra                     4KB cookie ceiling
  no cold start                        secret rotation = forced re-login
  scales horizontally                  not visible to server admin tools
  client owns its session
```

**Surface:** "encrypted cookie scales without infrastructure."
**Probe:** if pressed, name the 4KB ceiling as the failure mode and
audit R4 as the latent concern.

#### Q: "What's the load-bearing part of this — what breaks if you remove it?"

The `withAuthCookies` envelope (`lib/mcp/auth.ts:86-104`). It's the
hydrate-once/flush-once contract. Strip it out and every `tokens()` /
`saveTokens()` call would either:

  → round-trip the cookie (impossible — Next.js' `cookies()` is async),
    or
  → see a stale read after a write in the same request (the documented
    request-vs-response cookie split).

The PKCE verifier saved during `connect` MUST be readable in
`callback` — that's the load-bearing test. Without the envelope, it
isn't.

Other load-bearing parts:

  → AsyncLocalStorage as the request-scoped backing — concurrent
    requests on one warm Vercel instance must NOT share state
  → the SDK's `provider.lastAuthorizeUrl` capture (vs an actual
    redirect) — because we're in a server context, not a browser
  → the `sessionId` cookie as the join key — without it, the encrypted
    store can't be indexed

Optional hardening:

  → secret derivation via SHA256 (any 32-byte key works; SHA256 is
    convenient)
  → catch-and-return-`{}` on decrypt failure (clean re-login UX vs a
    crash)

#### Q: "What if the user opens two tabs and starts two concurrent flows?"

The two requests serialize on the cookie: each `withAuthCookies` reads
the cookie at the START of the request and writes it at the END. If tab
A and tab B both `saveCodeVerifier(...)` concurrently, the second flush
wins. In practice this means one of the two OAuth flows completes; the
other gets "no PKCE code_verifier stored for this session"
(`auth.ts:215`) when its callback hits. The user sees an error on the
second tab, opens it again, and the flow succeeds because the first
tab's tokens are now in the cookie.

It's not ideal — a real product would key the verifier by `state` (the
OAuth CSRF param) so concurrent flows don't collide. Filed as future
work; not in scope for the alpha.

## See also

- `00-overview.md` — where this sits in the system
- `01-request-flow.md` — the Stage 1 auth-gate calls this
- `05-caching-and-rate-limiting.md` — what runs once auth is in place
- `study-security` — threat model, secret rotation, cookie surface
- `study-networking` — HTTP cookies, SameSite semantics, CORS

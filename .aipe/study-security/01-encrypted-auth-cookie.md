# 01 — encrypted-auth-cookie

**Industry name(s):** Encrypted session cookie (AES-256-GCM authenticated
encryption); request-scoped state pattern (`AsyncLocalStorage`). Type:
Industry standard.

## Zoom out — where this concept lives

Vercel deploys `/api/mcp/callback` and the `/api/agent` first tool call to
different ephemeral instances. Neither has memory of the other. Something has
to carry the OAuth state (PKCE verifier, DCR client info, refresh tokens) from
one instance to the next. In this repo, that thing is a browser cookie.

```
  The encrypted-auth-cookie boundary — one system, three layers

  ┌─ Browser (UI) ─────────────────────────────────────────┐
  │  bi_auth cookie (AES-256-GCM ciphertext, HttpOnly)      │
  └────────────────────────┬───────────────────────────────┘
                           │  every request
  ┌─ Service (Next routes) ▼───────────────────────────────┐
  │  withAuthCookies()  → seeds ALS ctx from cookie         │
  │      ↓                                                   │
  │  ★ OAuth provider read/write ★  ← we are here            │
  │      ↓                                                   │
  │  flushes ALS ctx back to Set-Cookie                     │
  └────────────────────────┬───────────────────────────────┘
                           │  bearer <access_token>
  ┌─ Provider (Bloomreach MCP) ▼───────────────────────────┐
  │  loomi alpha · sees plaintext tokens only in-flight     │
  └────────────────────────────────────────────────────────┘
```

The bi_auth cookie is where the trust lives. Every hop above it uses the
plaintext form; the wire and storage forms are ciphertext.

## Structure pass

**Layers.** browser (cookie storage) → route (cookie decrypt + provider
read/write + flush) → SDK (uses the token to call MCP).

**Axis: trust — who can see or tamper with the OAuth secrets?**

```
  One axis — trust — traced across three layers

  browser: sees ciphertext only (HttpOnly · not JS-readable)
      │
      ▼
  route: sees plaintext, ONLY inside withAuthCookies() scope
      │  (ALS-scoped; concurrent requests never share state)
      ▼
  SDK: sees plaintext in the bearer header, out-of-process
```

**Seams that matter.** Two:

  → `withAuthCookies` wrap (`lib/mcp/auth.ts:86-104`) — the trust seam. Above:
    ciphertext or nothing. Below: plaintext, scoped.
  → `patchState` (`lib/mcp/auth.ts:148-152`) — the per-request read/write
    seam. Every OAuth provider method (`saveTokens`, `codeVerifier`,
    `saveClientInformation`) goes through this so the mutation flags
    `ctx.dirty = true` for the flush.

Skip either seam and the cookie either doesn't decrypt on entry or doesn't
re-encrypt on exit — the flow silently drops state.

## How it works

The problem the pattern solves: Next.js's `cookies()` API has a
request-vs-response split. Read a cookie AFTER you've set it in the same
request, and you get the OLD value. The OAuth flow needs many read/write
round-trips per request (SDK: `state()` twice, `saveCodeVerifier`,
`saveClientInformation`, then eventually `saveTokens`). If each provider call
touched `cookies()` directly, half the reads would return stale data.

The fix: seed once, flush once, keep the mutations in an
`AsyncLocalStorage`-scoped map in between.

### Move 1 — the mental model

Think of `withAuthCookies` as `Object.assign` around your request handler, but
the "object" is the auth store and the initial value comes from the request's
cookie.

```
  The pattern — read cookie once at start, write once at end

  ┌─ withAuthCookies(fn) ────────────────────────────────┐
  │                                                       │
  │   1. read raw cookie                                  │
  │   2. decrypt → store                                  │
  │   3. ctx = { store, dirty: false }                    │
  │   4. requestStore.run(ctx, fn):                       │
  │        ... provider.state()                           │
  │        ... provider.saveCodeVerifier(v)  ← dirty=true │
  │        ... provider.saveTokens(t)        ← dirty=true │
  │   5. if ctx.dirty:                                    │
  │        encrypt(ctx.store) → Set-Cookie                │
  │                                                       │
  └───────────────────────────────────────────────────────┘

  the SDK does dozens of small read/writes;
  the cookie sees exactly one round-trip
```

### Move 2 — the step-by-step walkthrough

**The AES key — derived, not stored raw.** `aesKey()` at
`lib/mcp/auth.ts:51-60` runs `sha256(AUTH_SECRET)` to get exactly 32 bytes.
Storing the raw secret as the key would work; hashing means `AUTH_SECRET` can
be any length and the key is always right-sized for AES-256.

```ts
// lib/mcp/auth.ts:51-60
function aesKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error('AUTH_SECRET is required in production…');
  }
  return createHash('sha256').update(secret).digest(); // 32 bytes → AES-256
}
```

Missing secret → throws. Fails at first cookie touch, not on some later
mysterious "auth doesn't work."

**The encrypt path — GCM binds ciphertext to auth tag.** `encryptStore` at
`lib/mcp/auth.ts:62-67` builds three fields into one base64url string:

```
  Cookie payload layout — 12 bytes IV · 16 bytes tag · N bytes ciphertext

  ┌─── 12 bytes ──┬─── 16 bytes ───┬─── N bytes ─────────────────────┐
  │ random IV      │ GCM auth tag   │ AES-256-GCM ciphertext           │
  └────────────────┴────────────────┴──────────────────────────────────┘
                                    ↑
                                    JSON.stringify(store)
                                    = { sessionId: { tokens, verifier, … } }
```

GCM (Galois/Counter Mode) gives you AEAD — authenticated encryption with
associated data. If someone tampers with the ciphertext, the tag verification
fails on decrypt.

**The decrypt path — tamper-resistant.** `decryptStore` at
`lib/mcp/auth.ts:69-79` returns `{}` on any decryption failure. Rotated
`AUTH_SECRET`, tampered cookie, corrupt base64 — all collapse to "no auth,"
never to an exception. That's the fail-safe: silent re-auth beats a 500 error
for the same failure class.

**The ALS wrap — one seed, one flush.**

```ts
// lib/mcp/auth.ts:86-104
export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV !== 'production') return fn();
  const { cookies } = await import('next/headers');
  const raw = (await cookies()).get(AUTH_COOKIE)?.value;
  const ctx: RequestStore = {
    store: raw ? decryptStore(raw) : {},
    dirty: false,
  };
  const result = await requestStore.run(ctx, fn);
  if (ctx.dirty) {
    (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {
      httpOnly: true,
      secure: true,
      sameSite: 'none',  // survives cross-site OAuth return
      path: '/',
      maxAge: AUTH_COOKIE_MAX_AGE,
    });
  }
  return result;
}
```

  → `requestStore.run(ctx, fn)` — `ctx` is bound to every async operation
    that fires inside `fn`. Each concurrent request gets its own `ctx`.
  → `dirty` bit — writes flip it; a request that only reads never flushes.
    Saves the Set-Cookie round-trip and, more importantly, doesn't collide
    with concurrent readers.
  → `sameSite: 'none'` — the OAuth callback lands from `bloomreach.com`, not
    from `blooming-insights.vercel.app`. `Lax` would drop the cookie on the
    cross-site return.

**Provider methods work through `readState` / `patchState`.** The
`BloomreachAuthProvider` at `lib/mcp/auth.ts:160-218` never touches
`cookies()` directly. It calls `patchState(sessionId, { tokens: t })`, which
mutates `ctx.store` and flips `dirty`. The flush at the end of
`withAuthCookies` picks up the mutations in one write.

### Move 2 variant — the load-bearing skeleton

The kernel: `AsyncLocalStorage` + one seed + one flush + a dirty bit.

  → Drop the `dirty` bit and every request writes a cookie whether it changed
    anything or not. Concurrent readers race the writers.
  → Drop the ALS wrap and provider methods write to a module-level Map. Two
    concurrent OAuth flows on the same instance corrupt each other's PKCE
    verifiers.
  → Drop the seed step and provider `tokens()` returns undefined for
    already-authenticated users — they get bounced back to the OAuth flow
    every request.

Hardening on top: `AUTH_COOKIE_MAX_AGE = 10 days` (matches token lifetime),
`consumeState` (defined but not wired — kept for a future shared-store
implementation), `deleteAuthCookie` for the reset route.

### Move 3 — the principle

**Cookie-backed session state on a serverless runtime demands one round-trip
per request.** Any pattern that hides "many small reads/writes" behind
"one durable read + one durable write" wins over ORM-style per-field
persistence — because the underlying store (cookie, Redis, DynamoDB) charges
per round-trip, not per field.

## Primary diagram

```
  The full picture — request lifecycle with encrypted auth cookie

  ┌─ Browser ─────────────────────────────────────────────┐
  │  fetch /api/agent · Cookie: bi_auth=<ciphertext>       │
  └────────────────────────┬──────────────────────────────┘
                           │
  ┌─ Next route ───────────▼──────────────────────────────┐
  │  withAuthCookies:                                      │
  │    ┌─ 1. read cookie ────────┐                         │
  │    │  raw = cookies().get()  │                         │
  │    └────────────┬────────────┘                         │
  │                 ▼                                       │
  │    ┌─ 2. decrypt → store ─────┐                        │
  │    │  base64url → iv|tag|ct   │                        │
  │    │  AES-GCM decrypt          │                        │
  │    │  JSON.parse               │                        │
  │    └────────────┬─────────────┘                        │
  │                 ▼                                       │
  │    ┌─ 3. ALS ctx = {store, dirty:false} ─────────────┐ │
  │    │                                                  │ │
  │    │  fn()  ← the SDK's OAuth flow runs here          │ │
  │    │    provider.state()     → read ctx.store         │ │
  │    │    provider.saveVerifier → mutate + dirty=true   │ │
  │    │    provider.saveTokens   → mutate + dirty=true   │ │
  │    │    ...                                            │ │
  │    └────────────┬─────────────────────────────────────┘ │
  │                 ▼                                       │
  │    ┌─ 4. flush if dirty ──────┐                        │
  │    │  JSON.stringify(store)   │                        │
  │    │  → GCM encrypt            │                        │
  │    │  → Set-Cookie bi_auth     │                        │
  │    └──────────────────────────┘                        │
  └────────────────────────┬──────────────────────────────┘
                           │
  ┌─ Bloomreach MCP ───────▼──────────────────────────────┐
  │  Authorization: Bearer <access_token>                  │
  └───────────────────────────────────────────────────────┘
```

## Elaborate

Where the pattern comes from: web-signed-cookies as sessions predate this by
20+ years. The AES-GCM part is post-2007 (NIST SP 800-38D). The
`AsyncLocalStorage` part is Node 14+ (2020). What this repo composes is: the
old idea (encrypt state into a cookie) with the new tool (per-request context
without threading a store through every function).

Related patterns:

  → JWT — same idea (signed state travels with the request), but JWTs are
    signed-not-encrypted, so the payload is visible client-side. Here, PKCE
    verifier + tokens must NOT be client-visible; AES-GCM is the right choice.
  → NextAuth.js sessions — same shape (JWE or database sessions). This repo
    implements it directly because the OAuth flow talks to MCP, not to
    NextAuth's own providers.
  → `AsyncLocalStorage` for request context — the same primitive Express-style
    middleware chains reach for. Here it removes the need to thread a store
    parameter through every provider method.

## Interview defense

**Q: Why AES-GCM instead of just signing the cookie?**

A: PKCE verifier and refresh tokens can't be client-visible. Signed cookies
show their payload; encrypted cookies don't. GCM specifically because it's
AEAD — authenticated encryption — so tampering breaks the tag and the decrypt
returns `{}` instead of returning a corrupted `store` we'd act on. The IV is
12 bytes random per encrypt; the tag is 16 bytes; both ride in the cookie
alongside the ciphertext.

```
  Signed cookie:     [ payload ][ signature ]  ← payload readable
  Encrypted cookie:  [ iv ][ tag ][ ciphertext ]  ← payload hidden + tamper-proof
```

Anchor: `lib/mcp/auth.ts:62-79` — `encryptStore` / `decryptStore`.

**Q: What breaks if you remove the `dirty` bit?**

A: Every request writes a Set-Cookie header even when nothing changed. That
races concurrent requests on the same session — request A reads at t=0,
request B reads at t=1, both flush at t=2 with different views. Whoever's
Set-Cookie lands last wins; the other request's mutations are lost. The dirty
bit means reads don't participate in the write race.

Anchor: `lib/mcp/auth.ts:90` and the guard at `:92`.

**Q: Why `AsyncLocalStorage` instead of a request-scoped middleware pattern?**

A: The MCP SDK calls the OAuth provider's methods synchronously from deep
inside its own async flow — I don't own that call site. ALS lets me establish
context at the route boundary and have every call downstream see it, without
threading a `store` parameter through the SDK's internals. If I did control
the SDK, DI would be equally correct.

Anchor: `lib/mcp/auth.ts:47` and `:114` (readAll checks the ALS context).

## See also

- `02-oauth-pkce-dcr-boundary.md` — what fills the store
- `03-user-chosen-mcp-url-boundary.md` — why the cookie is reserved for OAuth
- `06-secret-redaction-in-errors.md` — the other layer that keeps tokens off-log

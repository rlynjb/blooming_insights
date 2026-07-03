# clocks-coordination-and-leadership

*Session across ephemeral instances · Encrypted-cookie state · OAuth PKCE + DCR · Industry standard*

## Zoom out — where this concept lives

The interesting coordination problem in this repo is not "elect a leader"
or "keep clocks in sync." It's: **how does OAuth state survive when the
connect request and the callback request may land on different Vercel
instances?** The answer — encrypted httpOnly cookies as the state
store — is a specific solution to a specific stateless-runtime problem,
and it's one of the more subtle pieces of the codebase.

```
  Zoom out — where "coordination" lives

  ┌─ Client (browser) ───────────────────────────────────┐
  │  bi_session cookie (session id)                      │
  │  bi_auth cookie (AES-256-GCM encrypted store)        │
  │  ★ THE CROSS-INSTANCE COORDINATION HAPPENS HERE ★    │ ← we are here
  └────────────────────────┬─────────────────────────────┘
                           │
  ┌─ Service layer ───────▼──────────────────────────────┐
  │  BloomreachAuthProvider (OAuthClientProvider impl)   │
  │  withAuthCookies → AsyncLocalStorage-scoped Store    │
  │  read once at request start; write once at end       │
  └────────────────────────┬─────────────────────────────┘
                           │  hop B — OAuth authorize / callback / token
                           ▼
  ┌─ Provider ─────────────────────────────────────────────┐
  │  Bloomreach IdP — issues tokens on code exchange      │
  │  Tokens expire in minutes on the alpha                │
  └───────────────────────────────────────────────────────┘
```

Nothing in this repo elects a leader. Nothing has a term. Nothing uses
distributed time. What DOES exist: state that has to survive across
stateless-runtime instances, and the mechanism that makes it possible.

## Structure pass

### Layers of "who holds this state, when?"

```
  "who holds the OAuth state at each moment in the flow?"

  ┌───────────────────────────────────────────────┐
  │ before /connect                                │
  │   client:   session cookie (id only, no auth)  │
  │   server:   nothing                            │
  │   provider: unaware                            │
  └───────────────────────────────────────────────┘
      ┌───────────────────────────────────────────────┐
      │ during /connect                               │
      │   client:   session cookie                    │
      │   server:   PKCE code_verifier + DCR client   │
      │             info in ALS-scoped Store          │
      │   provider: about to receive redirect         │
      └───────────────────────────────────────────────┘
          ┌───────────────────────────────────────────┐
          │ after /connect (response flushed)         │
          │   client:   session + bi_auth cookie      │
          │             (encrypted store, incl PKCE)  │
          │   server:   nothing (instance can die)    │  ← the crucial hop
          │   provider: showing authorize page        │
          └───────────────────────────────────────────┘
              ┌───────────────────────────────────────┐
              │ during /callback (may be DIFFERENT   │
              │                    instance)          │
              │   client:   session + bi_auth cookie │
              │   server:   reads bi_auth → decrypt → │
              │             ALS-scoped Store restored │
              │   provider: sending code back         │
              └───────────────────────────────────────┘
                  ┌───────────────────────────────────┐
                  │ after /callback                    │
                  │   client:   session + bi_auth      │
                  │             (now with tokens)      │
                  │   server:   flushed to bi_auth     │
                  │   provider: authenticated          │
                  └───────────────────────────────────┘
```

The interesting row is the third one: **after `/connect` returns,
the server holds NOTHING**. Everything the SDK needs to complete the
OAuth flow is in the client's cookie. That's what allows the callback
to land on a different instance and still work.

### One axis — "which state survives an instance cycle?"

```
  "does this state survive its instance being evicted?"

  ┌───────────────────────────────────────────────┐
  │ SDK's OAuthClientProvider methods              │
  │   PKCE code_verifier                           │  ✓ via cookie
  │   DCR clientInformation                        │  ✓ via cookie
  │   tokens (access/refresh)                      │  ✓ via cookie
  │   state (CSRF param)                           │  ✓ via cookie
  │                                                │  (all in the store)
  └───────────────────────────────────────────────┘
      ┌───────────────────────────────────────────────┐
      │ our per-request async context                 │
      │   requestStore AsyncLocalStorage              │  ✗ dies with request
      │   BloomreachAuthProvider instance             │  ✗ dies with request
      │   ephemeral in-memory Map (dev/test)          │  ✗ (or lives as
      │                                                │      long as node)
      └───────────────────────────────────────────────┘
```

The SDK's state fields ALL survive because they live in the cookie
after each request flushes. The transient stuff (ALS, provider
instance) doesn't need to survive — the next request rebuilds them
from the cookie.

### Seams

- **`OAuthClientProvider` interface** — implemented by
  `BloomreachAuthProvider` at `lib/mcp/auth.ts:160`. The SDK calls
  `codeVerifier()`, `saveTokens()`, `clientInformation()`, etc.,
  without knowing WHERE the store lives. The seam lets the store be
  a cookie in prod and a file in dev without the SDK caring.

- **`withAuthCookies` wrapper** at `lib/mcp/auth.ts:86-104` — read
  once from the cookie, run the closure, write once at the end. This
  is the seam between "per-call reads/writes on the provider" and
  "one cookie read + one cookie write per request." Critical because
  Next's request/response cookie split means a read AFTER a set in the
  same request returns the OLD value.

- **The `ctx.dirty` flag** at `lib/mcp/auth.ts:127` — only writes the
  cookie back on `withAuthCookies`'s finally IF something changed.
  Prevents overwriting the cookie on every request even when the auth
  state is unchanged.

## How it works

### Move 1 — the mental model: the cookie IS the shared store

You know how session cookies work — the server sets a cookie, the
browser sends it back, the server reads it. Same thing here, but the
"session" is the OAuth state and the "server" might be a different
Vercel instance each request. The cookie IS the shared store between
instances.

```
  The pattern — cookie as cross-instance state

     browser
        │  bi_auth = encrypt({ PKCE verifier, DCR info, tokens, state })
        │
        ▼
     any Vercel instance:
        1. read bi_auth from request
        2. decrypt → ALS-scoped Store
        3. run request logic (provider reads/writes hit the Store)
        4. if Store.dirty: re-encrypt → set bi_auth in response
        │
        ▼
     browser (updated cookie)
        │
        ▼
     next request → any Vercel instance (maybe different one)
        (same procedure)
```

Bridge: this is exactly the shape of JWT-based auth — every request
carries the credential, the server never remembers you between
requests. Difference: here the cookie holds MUTABLE state (tokens
that get refreshed, PKCE verifiers that get consumed), so writes
back to the cookie are required, not optional.

### Move 2 — walk the mechanism

#### Environment-forked storage

`lib/mcp/auth.ts` picks a storage backend by environment:

```typescript
// lib/mcp/auth.ts:30-36
// Storage backend, keyed by our app session id. Three backends, selected by env:
//   • development → a gitignored file (.auth-cache.json).
//   • test → in-memory Map (isolated per run; `_clearAuthStore` resets it).
//   • production (Vercel) → an encrypted httpOnly cookie
```

Three implementations behind one `readAll` / `writeAll` seam
(`auth.ts:113-142`):

```typescript
// lib/mcp/auth.ts:113-124 (excerpt)
function readAll(): Store {
  const ctx = requestStore.getStore();
  if (ctx) return ctx.store; // production: ALS-scoped, cookie-backed
  if (!PERSIST) return Object.fromEntries(memStore); // test: isolated in-memory
  try {
    if (existsSync(CACHE_FILE)) return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Store;
  } catch {
    /* corrupt/unreadable cache — treat as empty */
  }
  return {};
}
```

The provider (`BloomreachAuthProvider`, `auth.ts:160-218`) doesn't know
which backend it's using. The SDK doesn't know one exists. The seam
holds.

**Why the split at all?** Each environment has different constraints:

- **dev** — Next hot-reloads modules; an in-memory Map wouldn't survive
  the module rebuild that happens during a PKCE flow. File persistence
  survives the reload.
- **test** — needs isolation between test runs. In-memory Map with a
  reset helper (`_clearAuthStore` at `auth.ts:250`).
- **prod** — instances are ephemeral. Any single-instance store is
  wrong. The cookie is the only cross-instance option.

#### AES-256-GCM for cookie encryption

Cookies are client-visible if not encrypted. Tokens in a cleartext
cookie would be readable by anyone with dev-tools access. Solution:
encrypt the whole store under a server-side key derived from
`AUTH_SECRET`:

```typescript
// lib/mcp/auth.ts:51-79
function aesKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      'AUTH_SECRET is required in production to encrypt the auth cookie. ' +
        'Set it in your Vercel project environment variables.',
    );
  }
  return createHash('sha256').update(secret).digest(); // 32 bytes → AES-256
}

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
    return JSON.parse(plain) as Store;
  } catch {
    return {}; // tampered, rotated-secret, or corrupt cookie → treat as no auth
  }
}
```

Cross-link: `../study-security/` teaches the auth-cookie crypto in
detail. What matters here is that the decrypt returns `{}` on
tampering — so a corrupted cookie falls back to "no auth" gracefully,
triggering a fresh OAuth flow rather than a hard error.

#### AsyncLocalStorage seals the per-request context

Next's request/response cookie split is a real problem:

```
  // lib/mcp/auth.ts:39-46 (paraphrased from comment)
  To avoid Next's request-vs-response cookie split (a read *after* a set in the
  same request returns the OLD value), we never touch the cookie per
  provider-method call. `withAuthCookies` seeds an ALS-scoped store from the
  cookie ONCE at the start of the request and flushes it back ONCE at the end;
  the provider's many synchronous read/write calls hit that store in between.
```

Without ALS, the provider's `saveTokens()` → `tokens()` sequence would
save to the response cookie, then read from the request cookie, and
read stale data. With ALS, both operations hit the same in-memory
Store for the duration of the request:

```typescript
// lib/mcp/auth.ts:86-104
export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV !== 'production') return fn();
  const { cookies } = await import('next/headers');
  const raw = (await cookies()).get(AUTH_COOKIE)?.value;
  const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };
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

**Load-bearing part: `requestStore.run(ctx, fn)` at `:91`.** ALS
propagates through every awaited promise inside `fn`. So even
if the SDK internally does 5 async hops between `saveTokens` and
`tokens`, they all resolve `requestStore.getStore()` to the same
`ctx`. Without ALS, you'd need to pass the context explicitly through
every layer, which is not possible when the SDK owns the middle.

**Also load-bearing: `sameSite: 'none'`.** The OAuth flow crosses
sites — we redirect to Bloomreach's IdP, and Bloomreach redirects back
to `/api/mcp/callback`. `SameSite=Lax` would drop the cookie on the
cross-site return in some browsers, and the callback would arrive
without the PKCE verifier. `SameSite=None` (with `Secure`) preserves
it across the round trip.

#### Cookie shape survives without a session id in the SDK's mind

The store is keyed by our app's session id (from `bi_session`).
Multiple sessions can coexist in one cookie in principle, but the
current design is one-session-per-user, so one entry per store.

The redirect_uri handling at `lib/mcp/connect.ts:36-57` deserves a
mention: production derives it from `x-forwarded-host`, so preview
deploys and the production alias each get their own registered
redirect URI. This solves a specific coordination problem: if
`APP_ORIGIN` were static, the OAuth callback would try to return to
the wrong origin on preview deploys, dropping the session cookie
(different domain).

#### What's absent: leader election, distributed clocks, term-based coordination

Nothing here. There is no "one process must be the leader at a time"
role. There is no "wait until wall-clock time X" logic. There is no
term counter, no version vector, no vector clock.

When any of this becomes load-bearing:

- **Background job scheduler** — if we ran scheduled reconciliation
  (say, "every day at 3am, refresh all users' briefings"), we'd need
  a leader so multiple Vercel instances don't run the same job.
  Standard fix: Vercel Cron (they elect the leader for you) or
  Postgres SKIP LOCKED / Redis SETNX as poor-man's leader election.

- **Distributed locking** — no shared resource requires coordinated
  access today. The moment we add a shared persistent state (say, a
  shared cache write path), we'd need a lock. Standard fix: Redis
  SETNX with TTL, or Vercel KV atomic operations.

- **Time-based ordering across nodes** — nothing here compares
  timestamps across instances. Timestamps are used ONLY within one
  request (e.g. `Date.now() - this.lastCallAt`), never compared
  across instances.

### The skeleton — what "coordination" reduces to here

Isolate the kernel. The pattern is: "state that must survive
stateless-runtime cycling lives in the client's cookie; the server
holds it only for the duration of one request via ALS."

What breaks without each part:

- **Drop the encrypted cookie backend** — dev/test would still work
  (their backends survive short lifetimes); prod would fail at
  `/callback` because the instance that gets the callback doesn't
  hold the PKCE verifier. The OAuth flow can't complete.
- **Drop ALS** — the provider's `saveTokens()` → `tokens()` reads
  stale data because the response-cookie write is invisible to a
  request-cookie read. Silent staleness.
- **Drop `sameSite: 'none'`** — the cross-site OAuth return drops the
  cookie in some browsers; callback arrives without the PKCE
  verifier. Same failure mode as dropping the cookie backend.
- **Drop the graceful decrypt fallback (`return {};` on error)** — a
  rotated `AUTH_SECRET` or a tampered cookie throws mid-request
  instead of falling back to "no auth." Users see errors instead of
  a re-auth prompt.

### Optional hardening layered on top

- **10-day cookie `maxAge`** (`auth.ts:49`) — bounds cookie durability.
  Tokens expire in minutes on the alpha, but the cookie carrying them
  lives long enough to hold the DCR client-info registration across
  many token refreshes.
- **`SameSite=None` + `Secure`** — required by browsers for cross-site
  cookies. Documented at `auth.ts:97-98`.
- **`consumeState` CSRF check** (`auth.ts:230-235`) — implemented but
  NOT wired in, per the comment. The SDK calls `state()` multiple
  times per flow, which broke a naive re-validation. Kept for a
  future shared-store implementation.

### Move 3 — the principle

**In a stateless-runtime system, "coordination" reduces to "state that
must outlive the process, and where it lives instead."** The
distributed-systems machinery you'd need on your own servers (Redis
for leader election, distributed locks, term counters) is unnecessary
here because the coordination surface is smaller than it looks: one
user's OAuth state across a small handful of ephemeral instances. The
cookie is the correct tool at the correct scale. The lesson: pick
coordination mechanisms by the size of the coordination problem, not
by the size of the distributed-systems textbook.

## Primary diagram — the OAuth-across-instances picture

```
  OAuth PKCE + DCR across Vercel's ephemeral instances

  ┌─ Browser (durable state anchor) ────────────────────────────────────┐
  │                                                                      │
  │   bi_session cookie:  <uuid>                                         │
  │   bi_auth cookie:     AES-256-GCM(iv || tag || ciphertext), sameSite │
  │                       encrypts { clientInfo, codeVerifier, state,    │
  │                                  tokens }                            │
  │                                                                      │
  └──────────────────────────┬──────────────────────────────────────────┘
                             │
                             │  every request carries both cookies
                             ▼
  ┌─ Any Vercel instance ────────────────────────────────────────────────┐
  │                                                                       │
  │   withAuthCookies(async () => {                                       │
  │     1. read bi_auth ←── decrypt ── requestStore ALS ctx               │
  │     2. run provider logic:                                            │
  │        - provider.codeVerifier() → ctx.store[sid].codeVerifier        │
  │        - provider.saveTokens(t)  → ctx.store[sid].tokens = t          │
  │                                    ctx.dirty = true                   │
  │     3. if ctx.dirty:                                                  │
  │        encrypt(ctx.store) → set bi_auth on response                   │
  │   })                                                                  │
  │                                                                       │
  │   NEVER touches the cookie per-provider-call (Next req/resp split)    │
  │                                                                       │
  └───────────────────────────────────────────────────────────────────────┘

  Instance A serves /connect  →  writes bi_auth (with PKCE + DCR info)
  Instance B serves /callback →  reads bi_auth (has PKCE + DCR info)
                              →  writes bi_auth (now with tokens)
  Instance C serves /mcp/call →  reads bi_auth (has tokens; refreshes as needed)

  All three instances share NOTHING but the cookie.
```

## Elaborate

The "encrypted stateful cookie" pattern is the canonical answer to
"how do I do stateful things on a stateless-runtime platform?" Same
shape shows up in:

- **iron-session** (Node) — encrypted-cookie session library, exactly
  this shape
- **Rails' encrypted session cookie** — same idea, browsers hold the
  server's state
- **Vercel's own session helpers** — same primitive

Where this pattern breaks:

- **Cookie size limits (~4KB in practice)** — headers get expensive
  past this. Rich state means moving to a shared store (KV, Redis).
- **State that must be readable by multiple users** — cookies are
  per-user by construction. Shared state needs a shared store.
- **Cryptographic key rotation** — if `AUTH_SECRET` rotates, all
  existing cookies become undecryptable. The graceful fallback
  (`return {};` on decrypt error) means users just re-auth, but
  every session ends simultaneously. Real production would want
  multi-key support with a rotation window.

The Bloomreach alpha's aggressive token expiry (minutes) is
independently interesting: it forces the app to build a re-auth path
as a first-class UI feature (the "reconnect" button on auth errors).
This isn't a coordination problem — it's a resilience-to-expiry
problem — but they compose. The cookie survives long enough to hold
the DCR client info; the tokens inside it churn on refresh.

## Interview defense

### Q: "How does OAuth state survive across Vercel instances?"

Sketch this:

```
  browser                any instance
     │                       │
     │  bi_auth (encrypted) │
     ├───────────────────────►
     │                       ├─ read → decrypt → ALS store
     │                       ├─ run provider methods (in-memory)
     │                       ├─ write → encrypt → set cookie
     │◄──────────────────────┤
     │  bi_auth (updated)    │
```

"An encrypted httpOnly cookie called `bi_auth` holds the full OAuth
state — PKCE code_verifier, DCR client info, tokens. AES-256-GCM
under a secret in `AUTH_SECRET`. `withAuthCookies` at
`lib/mcp/auth.ts:86` reads it once at request start, seeds an
AsyncLocalStorage-scoped Store, runs the request logic (which
includes many synchronous provider method calls), and writes it back
once at the end if anything changed. The ALS is critical because
Next's request/response cookie split makes read-after-write within
one request return stale data — the ALS keeps everything in one
in-memory store for the request's lifetime. `SameSite=None` +
`Secure` because the OAuth flow crosses sites."

Anchors: `lib/mcp/auth.ts:47-104` (withAuthCookies, encryption),
`lib/mcp/auth.ts:160-218` (BloomreachAuthProvider).

### Q: "Do you have leader election?"

"No. Nothing here has a role that must be a singleton. The moment we
grew a scheduled job (nightly reconciliation, say), we'd need leader
election so multiple Vercel instances don't run the same job. Standard
move at that point: Vercel Cron does the leader election for us. Or
Postgres SKIP LOCKED / Redis SETNX if we owned the scheduler."

### Q: "What's the load-bearing part everyone forgets?"

"`AsyncLocalStorage.run`. Without it, Next's request/response cookie
split silently returns stale data on `provider.tokens()` reads that
follow a `provider.saveTokens()` in the same request. The bug wouldn't
throw; it would look like the tokens didn't persist. The ALS is what
turns 'many provider calls per request' into 'one cookie read + one
cookie write per request.'"

## See also

- 04-consistency-models-and-staleness.md — the sessionStorage escape
  hatch is the client-side analog to what the auth cookie does for
  auth state
- `../study-security/audit.md` — the AES-256-GCM crypto in more detail
- 09-distributed-systems-red-flags-audit.md — token revocation on the
  alpha as a ranked risk

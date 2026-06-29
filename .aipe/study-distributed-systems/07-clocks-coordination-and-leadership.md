# Clocks, coordination, and leadership

*Industry standard — time, ordering, leases, distributed locks, leader election, split-brain.*

## Verdict — almost entirely `not yet exercised`, with one trick that earns its own walkthrough

There is no leader election, no distributed lock, no lease, no logical clock, no Lamport timestamps, no consensus. The repo's coordination story is small — but it has *one* real distributed-state mechanism: the AsyncLocalStorage-scoped, encrypted-cookie OAuth store that survives the Vercel cross-instance gap. That mechanism is what this file is actually about.

## Zoom out — coordination state in this codebase

```
  Zoom out — coordination state, drawn against absence

  ┌─ L1: Browser ────────────────────────────────────────────────┐
  │  cookies: bi_session (the session id), bi_auth (encrypted    │
  │  AES-256-GCM blob with OAuth state)                          │
  │  ★ THE BROWSER CARRIES THE DISTRIBUTED COORDINATION STATE ★   │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ L2: Vercel route ──────▼────────────────────────────────────┐
  │  AsyncLocalStorage-scoped requestStore                        │
  │  • seeded from bi_auth ONCE at request entry                  │
  │  • flushed back to bi_auth ONCE at request exit               │
  │  • the OAuthClientProvider's MANY synchronous calls hit       │
  │    this in-memory store, never the cookie API directly        │
  │  ★ THIS IS THE CLEVER PART ★                                   │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ L3: BloomreachDataSource ──────────────────────────────────┐
  │  no coordination state of its own                            │
  │  (the OAuth tokens it uses live above, in the cookie/store)   │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ L4: Bloomreach ────────▼────────────────────────────────────┐
  │  rate-limit window (server-side, per-user)                    │
  │  OAuth token state (issued, revoked) — server-side authority   │
  └────────────────────────────────────────────────────────────────┘
```

The browser is the coordination substrate. The route is a per-request hydration of that state. Bloomreach is the authority on rate-limit and token validity. There's no in-process coordination needed beyond AsyncLocalStorage, because nothing in this codebase needs to claim leadership or hold a lock.

## Zoom in — the question this file answers

> What state must survive across Vercel function instances, and how does it survive without a shared store?

One answer: an encrypted cookie + AsyncLocalStorage. That single mechanism is the entire "coordination" story; everything else is honestly absent.

## Structure pass — the skeleton

### Axes — trace "who has the authoritative clock?"

```
  One axis: "where is the source of truth for time / ordering / state?"

  L1 Browser              cookie value = authoritative for OAuth state
                          (the cookie is the only thing that crosses
                          the cross-instance gap)

  L2 Route                req.signal.aborted — local read of "did the
                          consumer cancel?"; not a clock, a status

  L2 AsyncLocalStorage    a per-request snapshot of the cookie; the
                          source of truth for the lifetime of one
                          request, then flushed back

  L3 DataSource           Date.now() for spacing — local wall clock,
                          per-adapter, no coordination

  L4 Bloomreach           server-side rate-limit window — the
                          authoritative clock for "may I call?"
```

The axis flips at L1: **the browser cookie is the source of truth for cross-instance coordination state.** Nothing on the server side has a longer-lived authoritative view than the cookie does. The AsyncLocalStorage is a clever per-request mirror of that authority.

### Seams — where coordination *would* be needed if it existed

```
  Three potential coordination needs — and what closes each

  potential need                              closed by
  ───────────────                              ─────────
  shared mutable state across instances        ★ encrypted cookie ★
  (e.g. OAuth tokens that must survive a       (the client carries it)
   cross-instance gap)

  exclusive access to a resource              n/a — no resource needs
   (e.g. only one worker may process job X)    locking; every request
                                               is independent

  ordering of writes across producers          n/a — single writer per
                                               session per stream

  leader for scheduled work                    n/a — no scheduled work
                                               (Vercel Cron not used)
```

Only the first row lights up, and it's solved by the cookie, not by a server-side coordination service.

## How it works

### Move 1 — the mental model

The clever trick: **make the BROWSER the cross-instance store**, not Redis or a DB. The browser has a cookie. The cookie carries the state. Vercel instance A reads the cookie at request start, modifies the state in-process, writes the cookie at request end. Vercel instance B does the same on the next request. Across instances, the only thing that needs to be coordinated is the cookie — and HTTPS + browser-side cookie jar do that for free.

> **State on the client is the cheapest distributed state. Trust + size + privacy decide whether the cookie can be the carrier; here all three say yes (AES-256-GCM + httpOnly + ~2KB), so the cookie IS the shared store.**

```
  The kernel — cookie-as-distributed-store

  ┌─ Request lands on instance X ───────────────────────────────┐
  │                                                             │
  │  withAuthCookies(fn):                                        │
  │     1. read bi_auth cookie value                             │
  │     2. decryptStore(value) → Store object                    │
  │     3. AsyncLocalStorage.run(ctx={store, dirty:false}, fn)   │
  │                                                             │
  │     ┌─ fn runs ────────────────────────────────────────┐    │
  │     │  OAuthClientProvider.tokens()  → readState(sid)   │    │
  │     │  OAuthClientProvider.saveTokens(t) → patch+dirty=true │
  │     │  …MANY synchronous reads/writes…                  │    │
  │     │  each one hits ctx.store, NEVER the cookie API     │    │
  │     └────────────────────────────────────────────────────┘    │
  │                                                             │
  │     4. if (ctx.dirty) write encryptStore(ctx.store) cookie   │
  │                                                             │
  └─────────────────────────────────────────────────────────────┘

  next request on instance Y:
     same dance, sees the cookie the previous request wrote
     → tokens / PKCE verifier / DCR client info available
```

Two seams: `cookie ↔ ctx.store` (the per-request hydration/flush) and `ctx.store ↔ provider method calls` (the in-process synchronous access). The first is HTTPS-mediated; the second is AsyncLocalStorage.

### Move 2 — walk it one part at a time

#### Part 1 — why this is hard (the OAuth state survival problem)

OAuth + PKCE + DCR is a three-stage handshake. Three pieces of state are saved during stage 1 and *must* be readable during stage 2:

```
  Three pieces of OAuth state that must survive the cross-instance gap

  saved during          read during           shape
  ────────────          ────────────          ─────
  connect (stage 1)     callback (stage 2)    DCR client_information
                                              (client_id + secret from
                                               Dynamic Client Registration)

  connect (stage 1)     callback (stage 2)    PKCE code_verifier
                                              (random string used to prove
                                               we initiated the flow)

  callback (stage 2)    every later call      OAuth tokens
                                              (access_token, refresh_token,
                                               id_token, lifetime)
```

The trap: in production, Vercel functions are *ephemeral and not sticky*. The `connect` request creates state in memory and returns a redirect URL. The browser bounces to Bloomreach, the user approves, the browser comes back to `/api/mcp/callback` — and that callback request can land on a *different* Vercel instance, with an empty memory. Without a shared store, the DCR client info and PKCE verifier are gone.

**Three solutions exist:**
1. Sticky routing (browser request → same instance). Doesn't exist on Vercel functions in general.
2. Server-side shared store (Redis, KV, DB). Adds infra; adds a network hop.
3. Client-side shared store (cookie). The browser carries the state across the gap.

The codebase picks (3). The cookie is encrypted (so the user can't tamper with it), httpOnly (so JavaScript can't read it), SameSite=None+Secure (so it survives the cross-site OAuth redirect).

#### Part 2 — the encryption (why a cookie is safe to hold tokens)

```
  Cookie crypto — AES-256-GCM under AUTH_SECRET

  raw store (JSON):
    { "<sid>": { tokens: {...}, clientInformation: {...}, codeVerifier: "..." } }

  encryption:
    key   = sha256(AUTH_SECRET)             // 32 bytes for AES-256
    iv    = randomBytes(12)                 // 12 bytes for GCM
    cipher = createCipheriv('aes-256-gcm', key, iv)
    enc   = cipher.update(JSON.stringify(store))
    tag   = cipher.getAuthTag()             // 16 bytes for GCM auth
    cookie_value = base64url(iv || tag || enc)

  decryption:
    iv    = cookie_value[0..12]
    tag   = cookie_value[12..28]
    enc   = cookie_value[28..]
    decipher.setAuthTag(tag)
    plain = decipher.update(enc) + final()
    return JSON.parse(plain)  // OR {} if tampered
```

Three load-bearing properties from `lib/mcp/auth.ts:51-79`:

- **Confidentiality + integrity (GCM).** AES-256-GCM is an AEAD — encrypts AND authenticates. A tampered cookie fails at `setAuthTag` and the catch block returns `{}`, which means the user is silently logged out (which is the correct behavior; we don't want to *process* a tampered cookie).
- **Random IV per encryption.** A fresh IV every flush is required for GCM security. `randomBytes(12)` guarantees it.
- **Rotated-secret safety.** If `AUTH_SECRET` changes, all existing cookies fail decryption and users are silently logged out. This is a safe failure mode for the use case.

The store is keyed by `sessionId` (the `bi_session` cookie), so one user's state is in one slot of the encrypted JSON. The cookie carries `Store = Record<sessionId, SessionAuthState>` because a single cookie could in principle hold multiple sessions for the same browser — though in practice it's one session per cookie.

#### Part 3 — AsyncLocalStorage (the in-request mirror)

The problem AsyncLocalStorage solves is at a different layer: **Next.js's cookies API has a request-vs-response split.** If you `cookies().set(...)` and then `cookies().get(...)` in the same request, you might get the old value back depending on the runtime. The OAuthClientProvider doesn't know about this — it's an SDK contract that calls `provider.tokens()` and `provider.saveTokens(t)` many times during one auth flow.

So the design wraps every route handler that touches OAuth in `withAuthCookies(fn)`:

```ts
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
      sameSite: 'none',
      path: '/',
      maxAge: AUTH_COOKIE_MAX_AGE,
    });
  }
  return result;
}
```

Walk it as an execution trace:

```
  Execution trace — withAuthCookies running connect → finishAuth

  step                                         ctx.store              ctx.dirty
  ─────────────────────────────────────────    ──────────────────     ──────
  enter handler                                {}                     false
  read cookie, decrypt                         { sid: { tokens: T0 } } false
  run fn() under requestStore                  ↑ available to fn
    OAuthClientProvider.tokens(sid)            (reads T0)              false
    OAuthClientProvider.saveCodeVerifier(v)    { sid: { …, cv: v } }   true
    OAuthClientProvider.saveTokens(T1)         { sid: { tokens: T1, cv: v }} true
    …more reads…                                no change              true
  fn returns
  if (ctx.dirty) encrypt + set cookie          (persisted to browser) —
```

The two single-touch invariants (cookie read once at entry, cookie write once at exit) are why this works around Next.js's cookies-API quirk. Inside `fn`, the provider talks to a plain JS object — no cookie API involved, no Next.js semantics in the way.

```
  AsyncLocalStorage — the per-request execution context

  request 1 (instance X)                         request 2 (instance Y)
  ─────────────────────                         ─────────────────────
  withAuthCookies(handler1)                      withAuthCookies(handler2)
    ctx1 = { store: …, dirty: false }            ctx2 = { store: …, dirty: false }
    requestStore.run(ctx1, …) ───►               requestStore.run(ctx2, …) ───►
       handler1's many async calls                   handler2's many async calls
       requestStore.getStore() = ctx1               requestStore.getStore() = ctx2
                                                  (NEVER ctx1 — different ALS context)

  the two requests' contexts are isolated even when handler code is the same
  module's code, because ALS keys context to the async call tree, not the file
```

ALS is the right tool because the OAuthClientProvider's methods can be called from any depth in the async call tree of `client.connect(transport)` — not just at the top level. Threading a `store` arg through every method would require modifying the SDK; ALS gets the same effect without touching it.

#### Part 4 — what happens when the cookie is missing or expired

```
  Failure modes — and how each is handled

  case                              behavior
  ──────                             ──────────
  no bi_auth cookie                  decryptStore returns {} (empty store);
                                     OAuthClientProvider.tokens() returns
                                     undefined; SDK runs the auth flow
                                     and asks for redirect → captured

  tampered bi_auth cookie            decryptStore catch returns {};
                                     same path as missing — user logs in again

  AUTH_SECRET rotated                all cookies fail decryption; everyone
                                     re-authenticates silently

  cookie expired (10-day max-age)    browser stops sending it; treated as
                                     missing; user re-authenticates

  Bloomreach revoked tokens          tokens still in cookie, but every call
                                     fails with 401 invalid_token; the
                                     reconnect-on-401 path (app/page.tsx)
                                     POSTs /api/mcp/reset which clears
                                     the cookie and re-runs auth
```

The reset path (`app/api/mcp/reset/route.ts`):

```ts
export async function POST() {
  const sid = await getOrCreateSessionId();
  clearAuth(sid);            // dev/test: removes the file/memory entry
  await deleteAuthCookie();  // production: drops the encrypted cookie
  return NextResponse.json({ ok: true, cleared: true });
}
```

Two operations, one for each backend. In production only the cookie matters; the in-memory store is empty between requests anyway. In dev only the file matters; there's no cookie path.

#### Part 5 — what's NOT here (the absent coordination machinery)

Everything else in the coordination chapter is absent:

```
  Coordination mechanisms — none present

  leader election (Raft, Bully)         not present — no work that needs
                                         a single leader

  distributed locks (Zookeeper,         not present — no resource that
   etcd, Redlock)                        needs exclusive access

  leases (cache invalidation,           not present — no work scheduling
   work allocation)

  logical clocks (Lamport, vector)      not present — no need for happens-
                                         before ordering across nodes

  fencing tokens                        not present — no risk of stale
                                         leader making writes after revocation

  split-brain detection                 not present — no replicated state
                                         to disagree

  global ordering                        not present — single writer per
                                         stream
```

The "absent because there's only one writer / one owner / no shared mutable state" pattern is consistent with files 03, 05, 06. **The coordination work this codebase does is exactly what's needed to make the OAuth flow survive Vercel's ephemeral functions; everything else is not needed.**

### Move 2.5 — current state vs future state

```
  Today                              Tomorrow (if it shows up)
  ─────────────────────────          ─────────────────────────────────
  cookie carries auth state          if the cookie grows past ~4KB
   (~2KB, well under cookie limit)    (e.g. JWE for richer claims),
                                      move to server-side KV with the
                                      cookie holding a small reference

  no scheduled work                   if cron-style "nightly briefing
                                       summary" lands → Vercel Cron or
                                       external scheduler; if multi-
                                       region, lease-the-leader pattern

  no work that needs locking          if "compute this expensive thing
                                       once" comes up → distributed
                                       lock (Redis SETNX with TTL or
                                       fencing token) — but a content-
                                       addressable cache is usually a
                                       better answer first
```

The realistic forward path is "add KV when the cookie isn't enough" — not "add a coordination service." The complexity floor for distributed locks isn't worth crossing without a use case.

### Move 3 — the principle

> **State on the client is the cheapest distributed state. Encrypt it for confidentiality + integrity (AEAD), key it for tampering safety (rotation = silent logout), and use AsyncLocalStorage to make the per-request hydration transparent to the code that uses it. You get cross-instance coordination without running a coordination service.**

The deeper move: **distinguish coordination state from coordination machinery.** This codebase has coordination state (the OAuth tokens, the PKCE verifier, the DCR client info), but no coordination *machinery* (no leader, no lock, no consensus). The state is small and per-user; the right carrier is the user's browser, not a shared server.

## Primary diagram — the coordination story

```
  Coordination — the full picture, every box labelled

  ┌─ Browser ────────────────────────────────────────────────────┐
  │  bi_session cookie  → identity (sessionId)                    │
  │  bi_auth   cookie   → encrypted Store (AES-256-GCM)           │
  │                       SameSite=None · Secure · httpOnly       │
  │                       10-day max-age                          │
  └─────────────────────────┬────────────────────────────────────┘
                            │  HTTPS · cookie ride-along
                            ▼
  ┌─ Route handler ──────────────────────────────────────────────┐
  │  withAuthCookies(handler):                                    │
  │   • cookies().get(bi_auth) → encrypted blob                   │
  │   • decryptStore() → Store                                    │
  │   • AsyncLocalStorage.run({store, dirty}, handler)            │
  │      ↓                                                        │
  │   ┌─ handler ────────────────────────────────────────────┐    │
  │   │  OAuthClientProvider methods read/write ctx.store     │    │
  │   │  (the SDK does NOT see cookies; it sees in-memory)    │    │
  │   └─────────────────────────────────────────────────────┘    │
  │   • if (ctx.dirty) cookies().set(bi_auth, encryptStore(…))    │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ DataSource ────────────▼────────────────────────────────────┐
  │  BloomreachDataSource.callTool(…)                             │
  │  uses the tokens from ctx.store implicitly (via the SDK's      │
  │   Bearer header) — no token state of its own                  │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ Bloomreach ────────────▼────────────────────────────────────┐
  │  validates Bearer · serves request OR returns 401 invalid_token│
  │  (revokes tokens server-side; we discover via 401)            │
  └────────────────────────────────────────────────────────────────┘

  what's NOT here:
    ✗ Redis / KV / shared cache
    ✗ leader election
    ✗ distributed locks
    ✗ leases
    ✗ logical clocks
```

## Elaborate

The references that ground this material:

- **OAuth 2.0 + PKCE (RFC 7636).** The protocol that requires the cross-request verifier survival. The fundamental insight: PKCE adds a one-time verifier so an intercepted authorization code can't be exchanged without the verifier — but the *client* has to remember the verifier from `connect` to `callback`, which is exactly the cross-instance gap problem.
- **Dynamic Client Registration (RFC 7591).** Why we need to remember `client_information` too — we register a client_id with Bloomreach on the fly, and we have to use the same client_id throughout the flow.
- **AsyncLocalStorage (Node 13+).** The Node primitive for per-async-tree context. The async_hooks-based mechanism is the cleanest way to do per-request state without explicit thread-locals or arg threading.
- **Web Crypto + AES-GCM.** The standard for authenticated encryption. GCM is the right AEAD mode for short-message use (cookies, JWE) because it's parallelizable and has small overhead. ChaCha20-Poly1305 is the alternative; here GCM is fine because Node has hardware AES support.

The interesting comparison: **stateless sessions (JWE) vs. stateful sessions (KV-keyed by cookie ID).** This codebase uses the JWE-style pattern (state on the client, encrypted with a server-held key) but doesn't call it JWE — it's just a JSON store encrypted with AES-GCM and base64url'd into a cookie. The trade-off vs a KV-backed session: no server-side state to invalidate (rotation = silent logout) but no immediate revocation path (the cookie is valid until rotation or expiry). For our use case (auth that re-establishes on 401 anyway), this is correct.

## Interview defense

### "How does OAuth state survive a Vercel function instance change?"

The OAuth state (DCR client info, PKCE code verifier, tokens) is encrypted with AES-256-GCM under `AUTH_SECRET` and stored in an httpOnly `bi_auth` cookie on the browser. The browser carries the cookie on every request, including the cross-site bounce back from Bloomreach to `/api/mcp/callback`. On the server, `withAuthCookies(fn)` reads the cookie once at request entry, decrypts it into a plain Store object, and stashes it in an `AsyncLocalStorage`-scoped context. The `OAuthClientProvider`'s many synchronous read/write calls during the auth flow hit this in-memory context — never the Next.js cookies API directly. At request exit, if anything was written, the modified store is encrypted and set back on the cookie. The browser carries the new state to whatever instance handles the next request.

The pattern is *state on the client + per-request hydration*. The browser is the shared store; AsyncLocalStorage is the in-process mirror; the encryption is what makes the cookie safe to trust.

```
  Anchor:
    cookie I/O:  lib/mcp/auth.ts:86-104 (withAuthCookies)
    crypto:      lib/mcp/auth.ts:51-79  (encryptStore/decryptStore)
    provider:    lib/mcp/auth.ts:160-218 (BloomreachAuthProvider methods)
    cookie set:  lib/mcp/session.ts:10-14 (sessionCookieOpts)
```

### "Why AsyncLocalStorage instead of just reading the cookie on every method call?"

Two reasons. (1) Next.js's cookies API has a request-vs-response split — a `cookies().set(...)` followed by `cookies().get(...)` in the same request can return the old value. The `OAuthClientProvider` SDK contract calls `saveTokens()` and `tokens()` interleaved within one flow, so this would produce incorrect behavior. (2) Even if the API didn't have that quirk, decrypting on every method call would be wasteful — the SDK calls these methods many times per `client.connect(transport)` invocation. AsyncLocalStorage gives a per-request execution context that the synchronous provider methods can read and write at zero crypto cost; one decrypt at entry, one encrypt at exit, dirty-flag-gated.

The shape this generalizes to: **per-request expensive-to-construct state belongs in AsyncLocalStorage when the consumers are deep in the async call tree and modifying it across the request lifecycle.** It's the cleaner alternative to threading the state through every call as an argument.

### "What's your distributed-lock strategy?"

There isn't one, and there shouldn't be. No work in this codebase requires exclusive access — every request is independent and stateless from the perspective of work allocation. The only shared mutable state across instances is OAuth tokens, and those are carried by the client (the browser cookie) rather than coordinated server-side. The case where I'd reach for a distributed lock is something like "compute this expensive briefing once and serve it to everyone" — but that's a *cache* problem, not a *lock* problem; the right answer is content-addressable caching (hash the inputs, key the cache by the hash, single-flight via in-memory or KV). I'd reach for an actual distributed lock (Redis SETNX with TTL + fencing token) only if we had cross-instance writes to a shared resource — which we don't, because we don't own one.

## See also

- `04-consistency-models-and-staleness.md` — the other in-process state (insights Maps) and its cross-instance behavior.
- `05-replication-partitioning-and-quorums.md` — why we don't need a server-side shared store.
- `09-distributed-systems-red-flags-audit.md` — the cookie-size ceiling, rotation behavior risks.
- `.aipe/study-security/` — the cookie encryption / trust model in security terms.
- `.aipe/study-system-design/` — the OAuth flow at architectural altitude.

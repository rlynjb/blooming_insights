# 02 · als-scoped-request-store

**AsyncLocalStorage-scoped request context** · Industry standard
(per-request scoping, Node.js `async_hooks`)

## Zoom out — where this lives

The encrypted-cookie store from `01-encrypted-cookie-oauth-state.md`
solves *persistence across requests*. This file is about the *other*
half: how that store works *within* one request, when the MCP SDK calls
`state()`, `saveCodeVerifier()`, `saveClientInformation()`, and
`saveTokens()` half a dozen times each before the response is sent.

```
  Zoom out — where ALS sits

  ┌─ Service ─────────────────────────────────────────────────────┐
  │ Next.js route handler                                          │
  │                                                                │
  │   withAuthCookies(() => connectMcp(sid))                       │
  │       │                                                        │
  │       │  read cookie once                                      │
  │       ▼                                                        │
  │   ┌───────────────────────────────────────────────────────┐    │
  │   │  ★ ALS context: { store, dirty } ★                    │    │ ← we are here
  │   │  (one per request, visible to all awaits inside)      │    │
  │   └───────────────────────────────────────────────────────┘    │
  │       │                                                        │
  │       │  MCP SDK runs                                          │
  │       │  ├─ provider.state()                                   │
  │       │  ├─ provider.saveClientInformation(…)                  │
  │       │  ├─ provider.saveCodeVerifier(…)                       │
  │       │  └─ provider.saveTokens(…)                             │
  │       ▼                                                        │
  │   write cookie once (if dirty) at the end                      │
  └────────────────────────────────────────────────────────────────┘
```

The pattern: **read once, mutate in memory, flush once.** ALS is the
substrate that makes "in memory" mean "this request's memory, not
another request's, even on the same Node process."

## Structure pass

  → **Layers.** Two: the *request layer* (one cookie read, one cookie
    write, one Node call stack) and the *SDK layer* (synchronous-looking
    provider methods, called many times during the OAuth flow).

  → **Axis to hold constant: "who owns the Store, and when does it
    change?"**

    ```
      altitude            who owns? when does it change?
      ───────────         ─────────────────────────────────────────
      request boundary    cookie owns; changes only on Set-Cookie
      ALS context         this request owns; ctx.store mutates
                          on every patchState
      provider method     the SDK reads/writes named fields
                          (tokens, codeVerifier, state, …)
    ```

    The same axis answer flips at every altitude, which is the
    skeleton of why ALS is here at all.

  → **Seams.** Two load-bearing joints:
    - **request ↔ ALS** (`withAuthCookies` at `lib/mcp/auth.ts:86-104`,
      `requestStore.run(ctx, fn)`). The seam where "the request's
      ephemeral memory" gets named.
    - **ALS ↔ provider** (`readAll` / `writeAll` at
      `lib/mcp/auth.ts:113-142`, `BloomreachAuthProvider` at
      `:160-218`). The seam where the SDK's synchronous getter calls
      see the ALS-scoped Store instead of the cookie directly.

  → **Why this matters.** Without ALS, the only place to put the
    decrypted Store is a module-scoped variable. That's *shared
    across all concurrent requests on the warm instance.* Two users
    OAuth'ing at the same time would race for the same Store and one
    would overwrite the other's PKCE verifier.

## How it works

### Move 1 — the mental model

If you've used React Context to pass a value to deeply nested
components without prop-drilling, ALS is the same shape for async
function calls. You wrap a function in `als.run(value, fn)`; anything
that `fn` calls (sync, async, awaited, scheduled on the microtask
queue, anywhere) can call `als.getStore()` and see that value. Nothing
else outside that wrap sees it.

```
  the pattern — ALS as a per-async-tree context

                     module scope (shared, bad)
                            ▲
                            │  module-level let store: Store
                            │  (every request mutates it — race!)
                            │
   request A ───────────────┴─────────────► response A
   request B ───────────────┴─────────────► response B
              (both see the same `store`)

                     ALS scope (per-request, good)
                            ▲
                            │  AsyncLocalStorage<RequestStore>
                            │
   request A ──[ als.run(ctxA, …) ]────► response A
                  ├─ saveTokens → ctxA.store mutates
                  └─ getStore() → ctxA

   request B ──[ als.run(ctxB, …) ]────► response B
                  ├─ saveTokens → ctxB.store mutates
                  └─ getStore() → ctxB
              (each request sees its own ctx)
```

The ALS API ships in Node 14+. Vercel's Node runtime (the route
handlers here run on the Node runtime, not edge) supports it natively.

### Move 2 — the step-by-step walkthrough

#### a · `withAuthCookies` — the request envelope

The route never decrypts/encrypts the cookie directly. It hands a
callback to `withAuthCookies`, which sets up the ALS context, runs the
callback, and flushes back to the cookie *once* at the end.

```
  the envelope — one read, N writes, one flush

  request in
     │
     ▼
  ┌─ withAuthCookies(fn) ────────────────────────────┐
  │  1. read bi_auth cookie                           │
  │  2. ctx = { store: decrypt(cookie), dirty: false }│
  │  3. await requestStore.run(ctx, fn) ─────────────┐│
  │                                                  ││
  │     ├─ fn calls provider.saveTokens(t) ◄─── reads/writes ctx.store
  │     ├─ fn calls provider.state() ◄────────────  via readAll/writeAll
  │     ├─ fn calls SDK that calls provider.… ◄───  (which check ALS first)
  │     └─ … many more provider calls …             ││
  │                                                  ││
  │  4. ctx.dirty ? cookies().set(encrypt(ctx.store))││
  │  5. return result                                ││
  └──────────────────────────────────────────────────┘│
                                                      │
  response out                                        │
```

Real code (`lib/mcp/auth.ts:86-104`):

```ts
export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV !== 'production') return fn();         // ← passthrough in dev/test
  const { cookies } = await import('next/headers');
  const raw = (await cookies()).get(AUTH_COOKIE)?.value;
  const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };
  const result = await requestStore.run(ctx, fn);                 // ← the ALS scope
  if (ctx.dirty) {
    (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {  // ← single flush
      httpOnly: true, secure: true, sameSite: 'none',
      path: '/', maxAge: AUTH_COOKIE_MAX_AGE,
    });
  }
  return result;
}
```

What breaks if removed: drop the ALS wrap → the only places to put the
Store are module scope (concurrent request race) or function scope
(invisible to the SDK's provider methods, which are called by code we
don't own). Drop the `ctx.dirty` check → write the cookie even when
nothing changed, which costs one Set-Cookie per request and pushes
the `bi_auth` cookie back to the browser unnecessarily.

#### b · `readAll` / `writeAll` — the ALS-first store accessors

These two functions are the *only* place the provider talks to storage.
They check the ALS context first; if present, that's the source of
truth. Outside ALS (dev/test), they fall through to file or in-memory
Map.

```
  the indirection — readAll prefers ALS over the per-environment backend

  readAll() called
        │
        ▼
   als.getStore()? ─── yes ──► return ctx.store        (production)
        │
        no
        │
        ▼
   PERSIST (dev)? ──── yes ──► JSON.parse(file)         (development)
        │
        no
        │
        ▼
   Object.fromEntries(memStore)                          (test)
```

Real code (`lib/mcp/auth.ts:113-142`):

```ts
function readAll(): Store {
  const ctx = requestStore.getStore();
  if (ctx) return ctx.store;                                   // ← production: ALS-scoped
  if (!PERSIST) return Object.fromEntries(memStore);            // ← test: in-memory
  try {
    if (existsSync(CACHE_FILE)) return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Store;
  } catch { /* corrupt/unreadable cache — treat as empty */ }
  return {};
}

function writeAll(store: Store): void {
  const ctx = requestStore.getStore();
  if (ctx) {
    ctx.store = store;
    ctx.dirty = true;                                           // ← mark for flush
    return;
  }
  if (!PERSIST) {
    memStore.clear();
    for (const [k, v] of Object.entries(store)) memStore.set(k, v);
    return;
  }
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(store));
  } catch { /* best-effort */ }
}
```

What breaks if removed: drop the `ctx.dirty = true` in `writeAll` →
the cookie never gets the new tokens, the next request decrypts an
empty Store and the user appears logged out *immediately after* a
successful auth.

#### c · why ALS instead of just passing `ctx` as a parameter

We don't own the SDK's `OAuthClientProvider` interface. It defines
methods like `tokens(): OAuthTokens | undefined` and
`saveTokens(t: OAuthTokens): void` with *no* extra parameters. There's
nowhere to thread a `ctx` argument.

```
  the constraint — provider methods are signatureless

  interface OAuthClientProvider {
    tokens(): OAuthTokens | undefined        ← no params
    saveTokens(t: OAuthTokens): void          ← only the new tokens
    state(): string                           ← no params
    saveCodeVerifier(v: string): void         ← only the verifier
    …
  }

  the SDK calls these MANY times per flow:
    connect() →
      provider.clientInformation() / saveClientInformation()
      provider.state()         (more than once!)
      provider.saveCodeVerifier()
      provider.redirectToAuthorization()
    finishAuth(code) →
      provider.codeVerifier()
      provider.saveTokens()
```

ALS is how a method with no context parameter still reads
"per-request" state. The `BloomreachAuthProvider` constructor takes
`sessionId` (which doesn't change per request), but the *Store* it
reads from has to be per-request — that's the ALS context.

Real provider code (`lib/mcp/auth.ts:197-203`):

```ts
tokens(): OAuthTokens | undefined {
  return readState(this.sessionId).tokens;  // ← reads ALS-scoped Store
}

saveTokens(t: OAuthTokens): void {
  patchState(this.sessionId, { tokens: t });  // ← writes ALS-scoped Store, dirty=true
}
```

What breaks if removed: replace ALS with a module-level Map and two
users authenticating at the same time can race. User A's
`provider.saveCodeVerifier('A_verifier')` runs; user B's
`provider.saveCodeVerifier('B_verifier')` runs; user A's `/callback`
calls `provider.codeVerifier()` and gets B's verifier → token
exchange fails. The whole pattern exists to make that race
impossible.

#### d · the Next.js read-after-write split

There's a second reason ALS is here: Next 16's `cookies()` API
returns a request-scoped jar, but **reads after a `.set()` in the
same request return the OLD value**. The comment at
`lib/mcp/auth.ts:39-44` calls this out:

```
  the Next.js cookie split — without ALS this bites you

  request handler                                cookie jar
  ───────────────                                ──────────
  jar.set('bi_auth', encrypt(stateAfterTokens))   ← writes for the response
  jar.get('bi_auth')                              ← reads the REQUEST's
                                                    incoming cookie (OLD)
```

If the SDK saved tokens via `cookies().set()` and then re-read them
via `cookies().get()` in the same request (which it would, several
times across `connect()` and `finishAuth()`), it would read the *old*
encrypted blob every time. ALS sidesteps this entirely by never
touching the cookie API in the middle — `cookies().get()` is called
once at the start, `cookies().set()` is called once at the end, and
everything in between reads/writes `ctx.store`.

### Move 3 — the principle

When you can't change a third-party interface to accept a context
parameter, but you need per-request state visible to every call that
interface makes, **AsyncLocalStorage is the substrate.** Same shape
as Python's `contextvars`, Java's thread-locals (per-thread), or Go's
`context.Context` (passed explicitly because Go won't give you
implicit per-goroutine storage). The implicit version trades the
verbosity of passing a parameter for the visibility cost of "where
does this value come from?" In this code the trade pays off: the SDK
contract is non-negotiable, and the ALS scope is hard-bounded to one
`withAuthCookies` call.

## Primary diagram

```
  the full envelope — one request, many provider calls, one flush

  ┌─ POST /api/mcp/connect ─────────────────────────────────────┐
  │                                                              │
  │  withAuthCookies(() => connectMcp(sid))                      │
  │  ─────────────────────────────────────                       │
  │   1. ctx = { store: decrypt(bi_auth cookie), dirty:false }   │
  │   2. requestStore.run(ctx, async () => {                     │
  │                                                              │
  │       provider = new BloomreachAuthProvider(sid, redirect)   │
  │       transport = new StreamableHTTPClientTransport(…)       │
  │       client.connect(transport)                              │
  │           │                                                  │
  │           ├─ provider.clientInformation()  → readAll → ctx   │
  │           ├─ provider.saveClientInformation(info)            │
  │           │     → patchState → writeAll → ctx, dirty=true    │
  │           ├─ provider.state()              → patch ctx, …    │
  │           ├─ provider.saveCodeVerifier(v)  → patch ctx, …    │
  │           ├─ provider.redirectToAuthorization(url)           │
  │           └─ throws UnauthorizedError                        │
  │                                                              │
  │   })  ← await resolves                                       │
  │   3. ctx.dirty? yes                                          │
  │   4. cookies().set('bi_auth', encrypt(ctx.store), {…})       │
  │   5. return { ok:false, authUrl: provider.lastAuthorizeUrl } │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

Node's `async_hooks` module (the substrate ALS sits on) tracks the
"async context" — the chain of `await`s, Promise callbacks, timers,
microtasks — that descend from `als.run(ctx, fn)`. Anything in that
descendant chain sees `ctx`. Sibling requests are sibling chains;
they each have their own root.

ALS has a cost: every async hop pays a small overhead to thread the
context. For high-throughput HTTP servers (>10k rps) this shows up in
benchmarks. For an OAuth callback handler that runs once per login,
it's invisible. The cost calculus is "fix the bug or save the
nanoseconds" and this app picks the bug fix.

Adjacent shapes:
  → React Context — same idea, sync tree (component tree) instead of
    async tree.
  → OpenTelemetry's `Context` API — same shape, used for trace
    propagation. Same primitive, same problem (correlate per-request
    state across async hops you don't own).
  → Pino's request logger — uses ALS to attach a per-request
    `requestId` to every log call without threading it through every
    function.

## Interview defense

### Q1. "Why not a module-level Map keyed by sessionId?"

```
  module-level Map vs ALS — the concurrency picture

  module Map                            ALS context
  ───────────                            ───────────
  one process, many requests             one process, many requests
       │                                      │
       ▼                                      ▼
   ┌─────────────────┐                  ┌──────────────┐ ┌──────────────┐
   │ store[sidA] = … │ ← request A      │ ctxA.store=… │ │ ctxB.store=… │
   │ store[sidB] = … │ ← request B      └──────────────┘ └──────────────┘
   └─────────────────┘                  request A         request B
                                         (isolated)        (isolated)
   reads/writes interleave              reads/writes
   across requests                      stay scoped
```

A module-level Map *would* work if every method on the provider
included `sessionId` as a key — which they do. The problem isn't
isolation by key, it's the **Next.js cookie read-after-write split**:
the cookie store is the durable backing, and we can't write to it in
the middle and re-read it in the same request. ALS is the
"intermediate buffer" — we read the cookie once, write once, and ALS
holds the working copy in between.

**One-line anchor:** "ALS isn't for isolation — sessionId already
isolates. It's for the read-after-write buffer between the one cookie
read at request entry and the one cookie write at request exit."

### Q2. "What happens with two concurrent requests for the same session?"

```
  two requests, one session — ALS gives each its own ctx

  request 1                               request 2
  ─────────                               ─────────
  decrypt cookie A                        decrypt cookie A
  ctxA1.store = {…tokens A}               ctxA2.store = {…tokens A}
  saveTokens(B) → ctxA1.store updated     saveTokens(C) → ctxA2.store updated
  encrypt + Set-Cookie B                  encrypt + Set-Cookie C
                                          ── browser keeps the LAST one ──
```

Whichever response sets the cookie last wins from the browser's
perspective. The token-rotation update from the loser is lost. For
this app that's fine: the loser's tokens are still valid (the MCP
server hasn't rotated them yet), and the next request will exchange
them again if needed. For a more sensitive use case you'd want a
shared store (Redis) with an optimistic-lock version field on the
Store.

**One-line anchor:** "Last write wins at the cookie; both requests
succeed. Real concurrent-token-rotation would need a shared store
with versioning — out of scope here."

### Q3. "How do you test code that depends on ALS?"

The test backend (`memStore`, the in-memory Map) is the trick. In test
runs, `process.env.NODE_ENV === 'test'`, `withAuthCookies` is a
passthrough, and `readAll` / `writeAll` skip the ALS check and use
the Map directly. `_clearAuthStore()` is exposed as a test-only
escape hatch (`lib/mcp/auth.ts:250-258`). The provider methods all
work the same way; ALS is invisible to the tests because there's
nothing to scope.

```
  three backends, one provider — tests use the simplest one

  prod  → ALS ctx (per-request)
  dev   → file (.auth-cache.json, survives hot-reload)
  test  → Map (isolated per run, _clearAuthStore between tests)
```

**One-line anchor:** "Test backend is an in-memory Map with a
`_clearAuthStore` escape hatch; ALS is bypassed because there's
nothing to scope when there's one test running at a time."

## See also

  → `01-encrypted-cookie-oauth-state.md` — what's in the Store
    (encrypted) and why the cookie is the durable backing.
  → `audit.md` § lens 2 (authentication-and-authorization) — the
    OAuth state-validation decision (the SDK calls `state()` multiple
    times; naive re-check broke valid flows).
  → `study-runtime-systems/` — the async-hooks substrate; this is one
    application of it.

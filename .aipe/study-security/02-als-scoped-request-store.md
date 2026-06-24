# ALS-scoped request store

**Industry name(s):** AsyncLocalStorage context, per-request store, request-scoped state, async context propagation
**Type:** Industry standard · Language-agnostic (the ThreadLocal-for-async pattern); Project-specific (the `RequestStore` that backs the `bi_auth` cookie)

> The auth pattern that runs the OAuth flow on Vercel needs a place to hold per-request state that's visible to *every function* in the request's call tree — without passing it explicitly. The MCP SDK's `OAuthClientProvider` calls a dozen `state()` / `saveTokens()` / `codeVerifier()` methods during one OAuth round-trip; threading a context object through all of them would force a fork of the SDK. AsyncLocalStorage solves it: `withAuthCookies` runs the handler inside an ALS context that holds the decrypted store, every async hop preserves that context automatically, concurrent requests on the same instance get separate contexts. Strip it out and either the cookie gets touched on every provider-method call (breaks Next's request/response split) or the in-memory state has to be passed by hand through every SDK seam (forks the SDK).

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** This sits inside the bigger encrypted-cookie pattern as the *synchronization primitive*. The cookie is the durable state; ALS is what makes the cookie usable in a server runtime where multiple requests may run concurrently on one V8 isolate (Vercel Edge / Node runtime both have this) and where the OAuth provider's many calls all need to see the same view of the state.

```
  Zoom out — where ALS sits in the auth layer

  ┌─ Browser ────────────────────────────────────┐
  │  bi_auth cookie (encrypted)                   │
  └────────────────────┬──────────────────────────┘
                       │ HTTPS
  ┌─ Route handler ────▼──────────────────────────┐
  │  withAuthCookies(fn)                           │
  │   ┌──────────────────────────────────────────┐ │
  │   │ ★ requestStore.run(ctx, fn) ★            │ │ ← we are here
  │   │   ALS context holds {store, dirty}        │ │
  │   │                                            │ │
  │   │   fn = the route's actual work             │ │
  │   │     calls into MCP SDK                     │ │
  │   │     SDK calls provider many times          │ │
  │   │     each provider call reads ctx.store     │ │
  │   │     or writes ctx.store and sets dirty     │ │
  │   └──────────────────────────────────────────┘ │
  └────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** AsyncLocalStorage is "ThreadLocal for the async-await world." You call `storage.run(value, fn)` once; every async hop inside `fn` — every `await`, every `setTimeout`, every Promise callback — can call `storage.getStore()` and get the same `value` back. Concurrent invocations of `storage.run` produce separate contexts that never mix. The pattern is "context propagation without explicit threading."

---

## Structure pass

**Layers.** Two altitudes that matter. The **runtime primitive** (`AsyncLocalStorage` from `node:async_hooks` — V8's continuation hook tracks the active context across await boundaries). The **wrapper** (`withAuthCookies` — the function that owns the ALS context's lifecycle and reconciles its content to the cookie).

**Axis: state ownership.** Hold one question constant across the layers: *what's the scope of this state, and what guarantees that scope?* The runtime gives you "the active async chain rooted at this `.run()` call." The wrapper turns that into "the lifecycle of this request handler." The seams between async work all preserve the context automatically — that's the load-bearing property.

**Seams.** One load-bearing seam, several invisible. The load-bearing one is `requestStore.run(ctx, fn)` — that's where a context gets minted and bound to the entire async call tree rooted at `fn`. The invisible seams are every `await` inside `fn` — under the hood, V8 tracks the active context per microtask, and every promise continuation re-enters the same context. The user-visible API hides all of that.

```
  Structure pass — ALS architecture

  ┌─ 1. LAYERS ───────────────────────────────────────┐
  │  runtime: AsyncLocalStorage (node:async_hooks)     │
  │  wrapper: withAuthCookies (lifecycle owner)        │
  └────────────────────────┬──────────────────────────┘
                           │  hold the scope question
  ┌─ 2. AXIS ─────────────▼───────────────────────────┐
  │  state ownership: what's the scope, guaranteed by? │
  │  runtime: active async chain rooted at .run()      │
  │  wrapper: one request handler's lifetime           │
  └────────────────────────┬──────────────────────────┘
                           │  trace, find the binding point
  ┌─ 3. SEAMS ────────────▼───────────────────────────┐
  │  requestStore.run(ctx, fn)   LOAD-BEARING          │
  │      binds ctx to entire async tree rooted at fn   │
  │  every `await` inside fn     INVISIBLE             │
  │      V8 preserves context across microtasks        │
  │  concurrent requests          SEPARATED            │
  │      each .run() call gets its own context         │
  └────────────────────────┬──────────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped. Next we walk the mechanics.

---

## How it works

### Move 1 — the mental model

You know how `try`/`catch` works — `throw` inside a function bubbles up to the nearest `catch` on the call stack? ALS is the *async-aware* version of that "find the nearest enclosing context" idea, but for *values you want to read* instead of errors you want to handle. Call `storage.run(value, fn)` once; from anywhere inside `fn` (including inside callbacks, awaited promises, microtasks), `storage.getStore()` returns that `value`. Different `storage.run()` calls produce separate contexts, like separate `try` blocks have separate error handlers.

```
  ALS — the pattern's shape

   outside any .run() context
   ┌──────────────────────────┐
   │  storage.getStore() ───── │ ─▶  undefined
   └──────────────────────────┘

   inside storage.run({a:1}, fn)
   ┌──────────────────────────────────────────────────┐
   │ fn() {                                             │
   │   storage.getStore()  ─────▶ {a:1}                │
   │   await someAsyncThing()                          │
   │   storage.getStore()  ─────▶ {a:1}    ← preserved │
   │   setTimeout(() => {                              │
   │     storage.getStore() ─▶ {a:1}        ← preserved│
   │   }, 100)                                         │
   │ }                                                  │
   └──────────────────────────────────────────────────┘

   concurrently in another request
   ┌──────────────────────────────────────────────────┐
   │ storage.run({a:2}, fn) — same fn, different ctx  │
   │   storage.getStore() ─▶ {a:2}                     │
   └──────────────────────────────────────────────────┘
```

The two `.run()` calls never see each other's values — even though they're calling the same `fn` on the same `storage` instance in the same process. ALS is the synchronization primitive that makes this work.

### Move 2 — the step-by-step walkthrough

#### Step 1 — declare the storage as a module-level singleton

```
  module-level singleton — pseudocode

  // imported from node:async_hooks
  const requestStore = new AsyncLocalStorage<RequestStore>()
```

The storage itself is shared across the whole process — there's one `requestStore` for the entire `lib/mcp/auth.ts` module. What's *not* shared is the value inside it; that's what `.run()` sets up per invocation.

What breaks if you create the storage per-request: you'd have to pass the storage instance into every function that wants to call `getStore()` on it. The module-level singleton is what makes ALS feel like "global variable that's actually request-scoped" — the API surface is the same as a global, but the values are scoped.

#### Step 2 — `.run(value, fn)` binds the value to the async chain rooted at `fn`

```
  requestStore.run — what binds when

  requestStore.run(ctx, fn)
        │
        │  V8 internally: push ctx onto the "active context" stack
        │  for this microtask. Run fn synchronously.
        ▼
   fn() {
        │  every storage.getStore() call inside ─▶ ctx
        │
        await externalThing()         ← microtask boundary
        │  V8 internally: when the awaited promise resolves,
        │  re-enter the SAME context for the continuation
        ▼
        another storage.getStore()    ─▶ still ctx (preserved)
   }
        │
        │  when fn's returned promise resolves: pop ctx from
        │  the active-context stack (cleanup)
        ▼
   .run returns whatever fn resolved to
```

The magic is `await`'s interaction with V8's async-context tracking. Every await schedules a continuation as a microtask; V8's async-hooks subsystem ensures that microtask runs with the same active ALS context as the one that scheduled it. Same for `setTimeout`, `setImmediate`, Promise callbacks, `process.nextTick` — all of them propagate the context.

What breaks if you skip `.run()` and just set a module variable: concurrent requests overwrite each other. Request A sets `currentStore = a`, then awaits. Request B comes in, sets `currentStore = b`, awaits. Request A's continuation reads `currentStore` and gets `b`. Cross-request bleed, very subtle to debug. ALS is what prevents this without forcing you to pass `ctx` through every function call.

#### Step 3 — `.getStore()` reads the active context

```
  getStore — pseudocode

  getStore():
    return V8.asyncContext.active.get(this)
            │
            │  this = the AsyncLocalStorage instance
            │  active = whatever the .run() at the
            │           innermost enclosing scope set
            ▼
    → returns ctx (or undefined if not inside any .run)
```

This is the read path the provider methods use. `readState(sessionId)` calls `requestStore.getStore()`, gets back the `RequestStore`, returns `ctx.store[sessionId] ?? {}`. `patchState(sessionId, patch)` calls `getStore()` similarly, mutates `ctx.store[sessionId]`, sets `ctx.dirty = true`.

#### Step 4 — the wrapper owns the lifecycle

```
  withAuthCookies — the lifecycle

   request enters
        │
        │ raw = cookies.get('bi_auth').value
        │ ctx = { store: decryptStore(raw), dirty: false }
        ▼
   requestStore.run(ctx, async () => {
        │
        │ ★ from now until fn returns, every getStore()
        │   in any awaited code returns ctx ★
        │
        ▼
        // handler does its work
        // provider methods read/write ctx.store
        // each write also sets ctx.dirty = true
        │
        ▼
        return result;
   })
        │
        │ at this point, fn has resolved.
        │ ctx is captured in the closure of the outer
        │ withAuthCookies — we can still read ctx.dirty.
        ▼
   if (ctx.dirty) {
     cookies.set('bi_auth', encryptStore(ctx.store), opts);
   }
   return result;
```

The clever bit: `ctx` is referenced both inside the `.run()` closure (read by `getStore`) and outside it (read by the wrapper to check `dirty`). It's the same object. ALS gives async-tree-wide visibility *during* the run; lexical closure gives the wrapper visibility *after*.

What breaks if you put the dirty-check inside the `.run()` callback: nothing. It works either way. The choice to put it outside is cleaner — the wrapper's job is request-level (decrypt, run, flush), the handler's job is request-internal.

#### Step 5 — concurrent requests get separate contexts

```
  Concurrency — two requests, same instance

   t=0   Request A enters
         requestStore.run({store: storeA, dirty: false}, fnA)
            ↓
            fnA() begins...
                                       t=1   Request B enters
                                             requestStore.run({store: storeB, dirty: false}, fnB)
                                                ↓
                                                fnB() begins...
            await someThing()
            ◀────resumes               
            getStore() ─▶ {store: storeA, ...}   ★
                                                await otherThing()
                                                ◀────resumes
                                                getStore() ─▶ {store: storeB, ...} ★
                                                                                    │
   ★ never confused: V8 tracks which run() each microtask belongs to ★
```

Two requests can interleave their awaits arbitrarily. Each `getStore()` call returns the value bound at the *enclosing* `.run()`. The V8 async-context subsystem is what enforces this — it's not a library-level convention.

### Move 3 — the principle

**Context propagation without explicit threading is what makes "stateful work inside library calls you don't own" feasible.** You can't fork the MCP SDK to thread a context object through every `OAuthClientProvider` method. You can wrap the SDK's call site in `.run()` and have the provider methods read the active context. That's the load-bearing trick: ALS turns "context I need everywhere" from "thread it through every function" into "set it once at the top."

---

## Primary diagram

The full ALS pattern in one frame.

```
  ALS-scoped request store — full mechanics

  ┌─ Module load (once per process) ───────────────────────────────┐
  │                                                                  │
  │   const requestStore = new AsyncLocalStorage<RequestStore>()    │
  │                       (shared across all requests on instance)   │
  │                                                                  │
  └─────────────────────────────────┬──────────────────────────────┘
                                    │
                                    ▼  per request
  ┌─ Request A ───────────────────────────────────────────────────┐
  │                                                                 │
  │  withAuthCookies(fnA):                                          │
  │    raw = cookies.get('bi_auth')                                 │
  │    ctxA = { store: decryptStore(raw), dirty: false }            │
  │                                                                 │
  │    requestStore.run(ctxA, async () => {                          │
  │      // fnA's code runs here                                    │
  │      // any awaited code preserves ctxA as active               │
  │                                                                 │
  │      readState(sid):                                            │
  │        return requestStore.getStore().store[sid]  → ctxA.store  │
  │                                                                 │
  │      patchState(sid, patch):                                    │
  │        ctx = requestStore.getStore()                            │
  │        ctx.store[sid] = { ...ctx.store[sid], ...patch }         │
  │        ctx.dirty = true   ← signals flush needed                │
  │                                                                 │
  │      provider.saveTokens(t)  ← MCP SDK call                     │
  │        → patchState(sid, { tokens: t })  → ctxA.dirty = true    │
  │                                                                 │
  │      ... many more SDK calls ...                                │
  │    })                                                            │
  │                                                                 │
  │    if (ctxA.dirty) {                                             │
  │      cookies.set('bi_auth', encryptStore(ctxA.store), opts)     │
  │    }                                                             │
  │                                                                 │
  └─────────────────────────────────────────────────────────────────┘

  ┌─ Concurrent Request B (same instance, separate ctxB) ──────────┐
  │  requestStore.run(ctxB, fnB) — never sees ctxA                 │
  │  V8 async-context tracking keeps them isolated                 │
  └─────────────────────────────────────────────────────────────────┘
```

The structural property worth memorizing: **one module-level `AsyncLocalStorage` instance, one `.run()` per request, every awaited call inside `.run()` sees the same `ctx`, concurrent `.run()`s are isolated.**

---

## Implementation in codebase

**Use case 1 — MCP SDK calls the provider many times within one request.** Route enters `withAuthCookies(async () => { ... connectMcp(sid) ... })`. Inside, `connectMcp` constructs `new BloomreachAuthProvider(sid, redirectUri)` and hands it to the SDK. The SDK calls `provider.clientInformation()` — that calls `readState(sid)` → `requestStore.getStore()` → returns `ctx.store[sid]`. Empty → SDK triggers DCR. SDK calls `provider.saveClientInformation(info)` → `patchState(sid, {clientInformation: info})` → `ctx.store[sid].clientInformation = info; ctx.dirty = true`. SDK calls `provider.state()` → generates UUID, calls `patchState(sid, {state: v})`. SDK calls `provider.saveCodeVerifier(v)`. SDK calls `provider.redirectToAuthorization(url)` — captured into `provider.lastAuthorizeUrl`. SDK throws `UnauthorizedError`. The route catches, returns `{ needsAuth: true, authUrl: provider.lastAuthorizeUrl }`. **`withAuthCookies` sees `ctx.dirty === true` and flushes the now-populated store to the cookie.** Net result: one decrypt, one encrypt, and inside dozens of synchronous provider-method calls that all saw a consistent in-memory store.

**Use case 2 — two requests arrive on the same warm Vercel instance simultaneously.** Request A enters `withAuthCookies` with `sessionId=alpha`, ctxA gets `store: {alpha: {...}}`. Before A's handler completes, Request B enters `withAuthCookies` with `sessionId=beta`, ctxB gets `store: {beta: {...}}`. Both run their async work — A awaits a network call, B starts its DCR registration. When A's `await` resolves, V8 re-enters ctxA for the continuation; A's `readState('alpha')` returns A's data, not B's. They flush independently. No state bleed despite shared process.

**Use case 3 — dev mode, no cookie.** `withAuthCookies` sees `NODE_ENV !== 'production'` and short-circuits: `return fn()`. No `.run()` call. Inside `fn`, `requestStore.getStore()` returns `undefined`. The `readAll` function handles this: `if (ctx) return ctx.store` — falsey → falls through to the file-backed branch (`.auth-cache.json`). Dev path doesn't use ALS at all; it uses the filesystem because Next's dev server hot-reloads, which would wipe an in-memory Map mid-OAuth-flow.

```
  lib/mcp/auth.ts  (lines 3, 41–47)

  import { AsyncLocalStorage } from 'node:async_hooks';
  // ...
  // To avoid Next's request-vs-response cookie split (a read *after* a set in the
  // same request returns the OLD value), we never touch the cookie per
  // provider-method call. `withAuthCookies` seeds an AsyncLocalStorage-scoped store
  // from the cookie ONCE at the start of the request and flushes it back ONCE at
  // the end; the provider's many synchronous read/write calls hit that store in
  // between. Each request gets its own ALS context, so concurrent requests on one
  // instance never share state.
  interface RequestStore { store: Store; dirty: boolean }
  const requestStore = new AsyncLocalStorage<RequestStore>();
       │
       └─ module-level singleton; one for the entire process. the per-request value
          lives in the .run() closure, never on this object.
```

```
  lib/mcp/auth.ts  (lines 86–104, abridged for the ALS lens)

  export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
    if (process.env.NODE_ENV !== 'production') return fn();      ← dev short-circuit
    const { cookies } = await import('next/headers');
    const raw = (await cookies()).get(AUTH_COOKIE)?.value;
    const ctx: RequestStore = {                                  ← per-request value
      store: raw ? decryptStore(raw) : {},
      dirty: false,
    };
    const result = await requestStore.run(ctx, fn);              ★ THE BINDING POINT
    if (ctx.dirty) {                                             ← lexical capture
      (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {...});
    }
    return result;
  }
       │
       └─ ctx lives in two places: inside the .run() (visible via getStore())
          and in this closure (visible to the dirty check). same object.
```

```
  lib/mcp/auth.ts  (lines 114–142, the read/write helpers)

  function readAll(): Store {
    const ctx = requestStore.getStore();              ← reads active ALS context
    if (ctx) return ctx.store;                        ← production: cookie-backed
    if (!PERSIST) return Object.fromEntries(memStore);← test: in-memory Map
    // ... dev: file backend ...
  }

  function writeAll(store: Store): void {
    const ctx = requestStore.getStore();
    if (ctx) {
      ctx.store = store;                              ← mutates the ALS-scoped object
      ctx.dirty = true;                               ← signals flush in wrapper
      return;
    }
    // ... other backends ...
  }
       │
       └─ the three-backend dispatch is itself elegant: ALS for prod, file for dev,
          Map for test. each is selected by side-conditions, never by config flag.
```

---

## Elaborate

### Where this pattern comes from

**AsyncLocalStorage** was added to Node 13.10 (2020), stabilized in 16. The motivation came from frameworks needing per-request context — distributed tracing (OpenTelemetry), request IDs, scoped database transactions, per-request loggers. Before ALS, the JS world used `cls-hooked` (continuation-local storage) which monkey-patched Node internals; ALS is the official replacement with proper V8 async-hooks support.

The conceptual ancestor is **Java's `ThreadLocal`** — a value stored per thread, invisible to other threads, automatically cleaned up when the thread terminates. In single-threaded async-JavaScript-land, "per thread" doesn't apply; "per async call chain" does. ALS is "per async call chain" implemented as a runtime primitive.

The deeper ancestor is **dynamic scoping** in Lisp dialects — a variable lookup walks up the call stack instead of the lexical scope chain. `(let ((*x* 5)) (foo))` makes `*x*` bound to 5 *for any call reachable from `foo`*, even though those calls weren't lexically inside the `let`. ALS is dynamic scoping for async-await.

### The deeper principle

**Implicit context vs explicit context** is the trade-off ALS makes. Explicit-context APIs require you to thread a `ctx` parameter through every function call (Go's `context.Context` is the canonical example). Implicit-context APIs let you set the context once and read it from anywhere. Explicit is easier to follow when reading code; implicit is the only option when you can't change the intermediate code (the MCP SDK's provider methods).

```
  Explicit context — Go style              Implicit context — ALS style
  ─────                                    ─────
  func handler(ctx context.Context):       function handler():
    doWork(ctx)                              doWork()
                                             // ctx is "ambient"
  func doWork(ctx context.Context):
    callSDK(ctx)                           function doWork():
                                             callSDK()
  func callSDK(ctx context.Context):
    ...                                    function callSDK():
                                             ctx = storage.getStore()
                                             ...

  trade-off: explicit makes the           trade-off: implicit lets you wrap
  dependency visible; you can't            third-party code without forking it,
  forget to pass ctx                       but the dependency is invisible at
                                           the call site
```

We use ALS specifically because we *can't* modify the MCP SDK's `OAuthClientProvider` interface. The SDK calls `provider.tokens()` with no parameters; the only way to give it context is to make context ambient. That's the load-bearing reason.

### Where it could improve in this codebase

1. **No tests around concurrent requests on the same instance.** The current test suite (`test/mcp/auth.test.ts`) tests sequential flows. A focused test would spawn two concurrent `withAuthCookies` calls with different session IDs and assert they don't bleed. The ALS guarantee is structural so the test would always pass, but the test would document the invariant.

2. **The `dirty` flag is binary, not per-session.** If two sessions' state lives in the same `ctx.store` simultaneously and only one was modified, both get re-encrypted. Today the cookie is per-session anyway (each browser has its own `bi_auth` carrying only its `sessionId` key), so this is moot — but a multi-user-per-browser design would need finer dirty-tracking.

3. **No request-id propagation alongside the auth context.** Adding a second ALS context for request-scoped logging (every `console.log` gets the request ID prepended) would be a natural sibling. Not present.

### Connection to adjacent patterns

ALS is the synchronization primitive that makes the encrypted-cookie pattern (`01-encrypted-cookie-oauth-state.md`) work on a stateless serverless host. Without ALS, `withAuthCookies` would have to thread the store through every function call manually — possible for our own code, impossible across the MCP SDK boundary.

The same `requestStore` pattern would generalize to other per-request needs: a request-scoped Anthropic client (so streaming hooks see the right one), a per-request cache, per-request tracing. Today only auth uses it; the pattern is ready to be reached for again.

---

## Interview defense

**What they are really asking:** can you explain why ALS exists, what specifically breaks without it in your auth flow, and how it guarantees isolation under concurrent requests?

---

**[mid] — What is AsyncLocalStorage and why is it in the auth code?**

ALS is "ThreadLocal for async-await." You declare a `new AsyncLocalStorage()` once per module — that's the storage instance. You call `storage.run(value, fn)` and inside `fn` (including across every `await`, callback, microtask) `storage.getStore()` returns that `value`. Concurrent `.run()` calls get isolated values.

In `lib/mcp/auth.ts` it backs the per-request auth store. The MCP SDK's `OAuthClientProvider` interface has a dozen methods — `state()`, `saveTokens()`, `codeVerifier()`, `clientInformation()`, etc. — that get called many times during one OAuth flow. Each one needs to read or write some shared per-request state. We can't thread a context object through them (would mean forking the SDK), so we put the state in ALS: `withAuthCookies` wraps the handler in `requestStore.run(ctx, fn)`, and every provider method reads `requestStore.getStore()` to find the active `ctx`.

```
  storage.run binds ctx           getStore reads it
  ──────────────────             ─────────────────
  requestStore.run(ctx, fn)       requestStore.getStore() → ctx
       │                          (from anywhere inside fn,
       │ fn runs;                  even across awaits)
       │ all awaits inside
       │ preserve ctx
```

---

**[senior] — What specifically breaks if you remove the AsyncLocalStorage and use a module-level variable instead?**

Cross-request state bleed under concurrency. Say two requests come in to the same warm Vercel instance simultaneously. Request A enters `withAuthCookies`, sets `currentStore = storeA`, calls the SDK, awaits Bloomreach's authorize redirect URL. Before that await resolves, Request B enters `withAuthCookies`, sets `currentStore = storeB` (overwriting A's), runs its own SDK calls. Request A's await resolves; its continuation reads `currentStore` — but it now holds Request B's data. Request A's provider sees B's tokens.

This is the classic "shared mutable state under concurrent async" bug. It's not theoretical — Node serverless functions on Vercel routinely serve multiple concurrent requests on a warm instance. Without ALS, the only safe options are: (1) fork the MCP SDK to take an explicit `ctx` parameter on every provider call, or (2) accept that the auth flow only works under single-request-at-a-time, which on serverless is basically luck.

```
  the bug without ALS

  t=0  A: currentStore = storeA; await foo()
  t=1                            B: currentStore = storeB; await bar()
  t=2  A's foo() resolves
       A: currentStore.tokens   ★ reads storeB.tokens ★

  ALS prevents this: each .run() pins the value to its own
  async tree; A's getStore() always returns storeA.
```

---

**[arch] — Why not just use Go's explicit context pattern and thread a ctx parameter everywhere?**

Because the MCP SDK's `OAuthClientProvider` is fixed — it calls `provider.tokens()`, not `provider.tokens(ctx)`. We don't own that interface. Our two options for getting per-request state into a method we don't control are:

1. **Capture state in the closure when constructing the provider.** Works for *immutable* state ("which sessionId is this provider for?") but breaks for *shared mutable* state ("which decrypted store should this provider read/write?") because the provider lives for one request and a closure-captured store would either be created fresh per request (correct, but means a new provider per request) or shared across requests (broken).

2. **Use ALS.** The provider methods do `readState(sid)` which calls `requestStore.getStore()`. The handler wraps everything in `.run(ctx, fn)`. The provider doesn't need to know about ctx; it just needs to know its sessionId, which IS closure-captured.

Option 2 is what we picked because option 1 still requires constructing a new provider per request (fine) AND threading the decrypted store into the construction (fine, but more boilerplate at every call site). ALS lets the construction site be ignorant of the store.

The trade-off ALS makes: the dependency on per-request state is invisible at the call site (`provider.tokens()` doesn't look like it depends on anything). That's a readability cost. For our use case — wrapping an external SDK — it's the only viable choice.

---

**The dodge — "is AsyncLocalStorage performance OK at scale?"**

For Node's `async_hooks`-based implementation, yes — overhead is in the single-digit microseconds per async hop. The V8 async-context tracking is implemented in C++ and is roughly a per-microtask pointer copy. Vercel's Node runtime supports it natively. Edge runtime (V8 isolate–based) historically had spotty support; for this codebase we're on Node serverless so it's fully supported.

The honest perf concern would be: if we used ALS in a hot path that fires thousands of times per request, the overhead would add up. Here it's two reads and a handful of writes per request — invisible compared to the network calls to Bloomreach and Anthropic.

---

**One-line anchors:**
- ALS is ThreadLocal for async — context propagates across every await, callback, microtask.
- `withAuthCookies` wraps the handler in `requestStore.run(ctx, fn)`; the MCP SDK's provider methods read `getStore()` to find the active `ctx`.
- Concurrent requests get isolated contexts — no cross-request state bleed.
- We use ALS because we can't modify the MCP SDK's provider interface to thread context explicitly.

---

---

## See also

→ [audit.md](./audit.md) · [01-encrypted-cookie-oauth-state.md](./01-encrypted-cookie-oauth-state.md) · [03-type-guard-trust-boundary.md](./03-type-guard-trust-boundary.md)

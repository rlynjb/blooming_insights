# Shared state, races, and synchronization

**Industry name:** session-keyed in-memory storage · per-request context isolation · **Type:** Project-specific (built on Node primitives)

## Zoom out, then zoom in

Two stories here, both at the same seam (module-scope vs per-request):

  1. **The session-keyed `Map<sessionId, SessionFeed>`** at `lib/state/insights.ts:14` — module-scope, shared across all concurrent requests on a warm instance, kept race-safe by *never clearing the outer map* and keying every mutation by `sessionId`.
  2. **The `AsyncLocalStorage` per-request context** at `lib/mcp/auth.ts:47` — module-scope `AsyncLocalStorage` instance, but every request gets its own isolated `RequestStore` frame inside it.

```
  Zoom out — where shared state lives

  ┌─ band 1: client (no shared state across users) ───────────┐
  └────────────────────────┬──────────────────────────────────┘
                           │
  ┌─ band 2: Node process ★ THIS FILE ★ ─────────────────────┐
  │                                                           │
  │  module-scope (shared across requests):                   │
  │    const state = new Map<string, SessionFeed>()           │
  │    const mem = new Map<string, AgentEvent[]>()            │
  │    const requestStore = new AsyncLocalStorage<...>()      │
  │    const memStore = new Map<string, SessionAuthState>()   │
  │                                                           │
  │  per-request (NOT shared):                                │
  │    ALS ctx = {store, dirty}                               │
  │    req.signal                                             │
  │    DataSource instance                                    │
  │                                                           │
  └───────────────────────────────────────────────────────────┘
  ┌─ band 3: providers (don't see our state) ────────────────┐
  └───────────────────────────────────────────────────────────┘
```

Zoom in. The hard question is: when two requests run on the same thread interleaved at every `await`, how do we keep them from clobbering each other's state? The answer in this codebase: **partition by `sessionId` in the outer map**, and **isolate per-request context via `ALS.run`**. No locks. The Node event loop's single-threaded model + Map's atomic get/set per microtask = enough.

## Structure pass

**Axis: state ownership — who can mutate what, and when?**

```
  Three altitudes, one question (who owns?)

  ┌─ outer Map<sessionId, SessionFeed> ────────────────────┐
  │  owner: the process                                     │  → never .clear()ed,
  │  only ever .get/.set on individual keys                 │     never iterated mutably
  └────────────────────┬───────────────────────────────────┘
                       │  seam: keyed by sessionId
  ┌─ inner SessionFeed sub-Maps ──────────────────────────┐
  │  owner: this session's requests only                    │  → putInsights().clear()
  │  one session's requests may interleave on this         │     wipes ONLY this session
  └────────────────────┬───────────────────────────────────┘
                       │  seam: ALS frame
  ┌─ AsyncLocalStorage ctx ─────────────────────────────────┐
  │  owner: this REQUEST only                               │  → impossible for another
  │  no other request can read or write this ctx           │     request to even see it
  └────────────────────────────────────────────────────────┘
```

**Two seams. Two different isolation mechanisms.**

  → Outer Map → inner sub-maps: isolation by **key partitioning**. Two requests with different `sessionId`s touch different sub-maps, no collision possible.
  → Inner sub-maps → ALS ctx: isolation by **scope**. ALS frames are invisible to anyone outside `ALS.run`'s callback.

The bugs you can plausibly create here are bugs that violate one of those two invariants — touch the outer Map without partitioning, or read `getStore()` outside an ALS frame.

## How it works

### Move 1 — the mental model

You know how `localStorage` in the browser is one big key-value store but you scope per-user by prefixing keys with the user ID? Same idea, scaled to one warm Node process serving many sessions: one big `Map`, every key prefixed by `sessionId`, the *outer* map is treated as effectively immutable (we never `.clear()` it, never iterate it mutably). Mutations only touch the inner sub-maps belonging to one session.

```
  Pattern — partition by sessionId, isolate per-request via ALS

  module scope (process-wide):

   state ───────► Map {
                     sid_A: { insights: Map{...}, investig: Map{...}, anom: Map{...} }
                     sid_B: { insights: Map{...}, investig: Map{...}, anom: Map{...} }
                     sid_C: { insights: Map{...}, investig: Map{...}, anom: Map{...} }
                   }
   ▲                ▲
   │ never          │ each cell owned by one session
   │ .clear()       │ mutations confined here
   │ never
   │ iterated mutably

  request A (sid_A)         request B (sid_B)
  ─────────────────         ─────────────────
  state.get(sid_A)          state.get(sid_B)
  ↓                         ↓
  s.insights.clear()        s.insights.clear()
  s.insights.set(...)       s.insights.set(...)
  ↓                         ↓
  (no interleaving with B)  (no interleaving with A)
```

### Move 2 — the parts and what breaks if you remove each

#### Move 2 variant — the load-bearing kernel

The kernel is **3 invariants**. Strip any one and the system races.

**Invariant 1: the outer Map is never `.clear()`d, never iterated mutably.**

```ts
// lib/state/insights.ts:14
const state = new Map<string, SessionFeed>();
```

What breaks if you violate it: `putInsights(sidA, ...)` doing `state.clear()` would wipe sidB's feed mid-briefing. The comment at `lib/state/insights.ts:6-11` calls this out explicitly: *"a single warm Vercel instance serves many users concurrently, so module-level Maps would bleed between sessions — and putInsights' clear() would wipe another user's feed mid-briefing."*

**Invariant 2: every mutation is keyed by `sessionId` first, then operates on the inner sub-map.**

```ts
// lib/state/insights.ts:57-71  (annotated)
export function putInsights(sessionId: string, items: Insight[], rawAnomalies?: Anomaly[]): void {
  const s = sessionState(sessionId);   // ← find OR create this session's sub-map
  s.insights.clear();                  // ← clears ONLY this session's insights
  s.anomalies.clear();
  items.forEach((i, idx) => {
    s.insights.set(i.id, i);
    if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx]);
  });
}
```

The whole body is synchronous — no `await` between the `.clear()` and the `.set()`s. That makes the entire mutation atomic with respect to other event-loop tasks: no other request can interleave inside this function. The "lock" is just "no awaits inside the critical section."

What breaks if you add an `await`: another request could observe a half-cleared sub-map and crash on iteration.

**Invariant 3: every read or write of the `requestStore` ALS happens inside `ALS.run`.**

```ts
// lib/mcp/auth.ts:47
const requestStore = new AsyncLocalStorage<RequestStore>();

// lib/mcp/auth.ts:114-115
function readAll(): Store {
  const ctx = requestStore.getStore();
  if (ctx) return ctx.store;                  // ← inside ALS frame → return per-request store
  if (!PERSIST) return Object.fromEntries(memStore);  // ← outside → fall back to module-scope memory
  ...
}
```

What breaks if you call `readAll()` outside an ALS frame in production: `getStore()` returns `undefined`, you fall through to the dev/test branches, and in production that means *no auth state at all* — every OAuth read returns `{}`. The handler thinks the user has no tokens; the OAuth flow restarts every request.

#### Move 2.1 — `sessionState` is the only allocator

`lib/state/insights.ts:16-23` is the only place where a new `SessionFeed` enters the outer Map:

```ts
function sessionState(sessionId: string): SessionFeed {
  let s = state.get(sessionId);
  if (!s) {
    s = { insights: new Map(), investigations: new Map(), anomalies: new Map() };
    state.set(sessionId, s);
  }
  return s;
}
```

Two requests for the same `sessionId` on the same instance, both seeing `undefined`, could each allocate a `SessionFeed` and one of them `.set`s after the other — the winner stays, the loser's allocation is GC'd. **That's fine** in this codebase because no request *depends* on observing a previously-set sub-map (the `.clear()` at the top of `putInsights` resets it anyway). If a future call site read state *first*, then awaited, then wrote, you'd have a check-then-act race.

```
  Execution trace — the "fine" race in sessionState

  state:   Map { }        (empty)
  ──────   ──────────
  t=0      A: sessionState(sidX) — state.get returns undefined
  t=1      A: creates allocA = {insights: Map, ...}
  t=2      A: state.set(sidX, allocA)
  t=3      A: returns allocA
  t=4      (no race: B never ran in parallel because it's one thread)

  Same scenario WITH an await:

  t=0      A: sessionState(sidX) — undefined
  t=1      A: creates allocA
  t=2      A: await ... (yields!)
  t=3      B: sessionState(sidX) — STILL undefined (A never set)
  t=4      B: creates allocB
  t=5      B: state.set(sidX, allocB)
  t=6      B: returns allocB, mutates allocB
  t=7      A: resumes, state.set(sidX, allocA)  ← clobbers B's
  t=8      A: returns allocA — B's mutations are lost!
```

The current code is in the first shape (no await), so it's safe. **Don't add an await inside `sessionState` without thinking through this.**

#### Move 2.2 — the ALS frame is the per-request bubble

Tracing one request through the ALS lifecycle:

```
  Layers-and-hops — ALS frame from cookie to deep tool call

  ┌─ Next.js platform ─────────────────────────────────┐
  │  cookie comes in on req                            │
  └────────────────┬───────────────────────────────────┘
                   │  hop 1: handler reads
  ┌─ withAuthCookies wrapper ──────────────────────────┐
  │  raw = cookies().get(AUTH_COOKIE)                  │
  │  ctx = {store: decrypt(raw), dirty: false}         │
  │  requestStore.run(ctx, fn)                          │
  └────────────────┬───────────────────────────────────┘
                   │  hop 2: deep async calls
  ┌─ MCP SDK provider methods ─────────────────────────┐
  │  provider.tokens()  → readState(sid)               │
  │   → readAll() → requestStore.getStore() → ctx ✓     │
  │  provider.saveTokens(t) → patchState(sid, t)       │
  │   → writeAll(...) → ctx.dirty = true               │
  └────────────────┬───────────────────────────────────┘
                   │  hop 3: handler returns
  ┌─ withAuthCookies flush ────────────────────────────┐
  │  if (ctx.dirty) cookies().set(AUTH_COOKIE,         │
  │                                encrypt(ctx.store)) │
  └────────────────────────────────────────────────────┘
```

The `getStore()` inside a deep callee sees the same `ctx` the wrapper set up. Concurrent requests each have their own ALS frame, so two `getStore()` calls from two requests return two different `ctx` objects — **automatically, no key lookup, no synchronization primitive.**

#### Move 2.3 — what counts as "synchronization" here

The codebase has zero `Mutex`, zero `Semaphore`, zero `Lock`. It does have:

  → **Synchronous critical sections.** `putInsights`, `sessionState`, `saveInvestigation` — all sync top-to-bottom. The event-loop guarantees no other task interleaves.
  → **Key partitioning.** Every shared `Map` is keyed by something request-scoped (`sessionId`, `insightId`).
  → **ALS scoping.** Per-request context isolated by ALS frame.
  → **A "single-flight" guard** in `useInvestigation`: `startedRef.current = true` (`lib/hooks/useInvestigation.ts:48-49`) — but that's a *client-side* React StrictMode pattern, not server-side synchronization.

There is no synchronization primitive in this codebase because none is needed at the current shape. The day someone adds a multi-step async mutation to a shared key, that calculus changes.

### Move 3 — the principle

In a single-threaded async runtime, the cheapest synchronization is **never sharing mutable state across awaits**. Partition by a key, scope by an ALS frame, keep critical sections synchronous, and the runtime does the rest for free. The expensive synchronization (`Mutex`, `Semaphore`) only earns its place when those three tools fail — and at the current shape of this codebase, they haven't.

## Primary diagram

```
  Shared state, races, and synchronization — the whole picture

  ┌─ module scope ────────────────────────────────────────────────────────┐
  │                                                                        │
  │  state ──► Map<sessionId, SessionFeed>                                 │
  │             { insights: Map, investigations: Map, anomalies: Map }    │
  │             ↑ partitioned by sessionId, outer never .clear()'d         │
  │                                                                        │
  │  mem ────► Map<insightId, AgentEvent[]>                                │
  │             ↑ partitioned by insightId                                 │
  │                                                                        │
  │  requestStore ──► AsyncLocalStorage<RequestStore>                      │
  │                    ↑ frames isolated per request                       │
  │                                                                        │
  │  memStore ──► Map<sessionId, SessionAuthState>  (test backend)         │
  │                                                                        │
  └────────────────────────────────────────────────────────────────────────┘

         ▲                                              ▲
         │ reads/writes via                             │ reads/writes via
         │ sessionState(sid)                            │ ALS.run / getStore
         │                                              │
  ┌─ request A ──────────────────┐         ┌─ request B ────────────────┐
  │ sid = sidA (cookie)          │         │ sid = sidB (cookie)        │
  │ withAuthCookies(() => {      │         │ withAuthCookies(() => {    │
  │   ALS.run(ctxA, async () => {│         │   ALS.run(ctxB, async () =>│
  │     ... putInsights(sidA)    │         │     ... putInsights(sidB)  │
  │   })                         │         │   })                       │
  │ })                           │         │ })                         │
  └──────────────────────────────┘         └────────────────────────────┘

  Synchronization "primitives" used: ZERO.
  Tools used: key partitioning, ALS scoping, sync critical sections.
```

## Elaborate

The pattern of "one big map, partitioned by request-scoped key, never iterate mutably" is the same shape PHP-FPM workers used to take in 2005 — except those workers each owned their own process, so partitioning was free. In a long-lived Node process serving many sessions, you have to do the partitioning yourself by being disciplined about the outer-Map invariant.

`AsyncLocalStorage` is the modern Node equivalent of OpenTelemetry's `context` propagation, of Go's `context.Context`, of Java's `ThreadLocal` for thread-per-request servers. It costs roughly nothing (`async_hooks` overhead is low; modern Node has fast paths) and it makes the per-request scope explicit at the API boundary instead of leaking into every function signature.

Worth reading: *Concurrency in Go* ch. 4 (the patterns there map cleanly to async/await once you read "goroutine" as "Promise"); the Node.js `async_hooks` API docs to see what ALS is built on; the Tokio docs on `tracing::Span` (Rust async) for the same pattern in a different language.

## Interview defense

**Q: There's a `Map` at module scope being mutated by every request. Why isn't that a race?**

Three things keep it safe.

  1. The outer Map is *never* `.clear()`d and never iterated mutably. Only `.get(sid)` and `.set(sid, …)`. Different sessions touch different keys.
  2. Inner mutations (`putInsights`, `saveInvestigation`) are entirely synchronous — no `await` between read and write. The single-threaded event loop guarantees no other task interleaves inside a sync function.
  3. The `sessionId` key comes from a per-request cookie (`lib/mcp/session.ts:16-24`), so two requests for two users will partition to two different sub-maps automatically.

The day someone adds an `await` inside `putInsights` or `sessionState`, this calculus changes — and that's the comment in `lib/state/insights.ts:6-11` warning the next maintainer.

```
  the rule:  shared state + sync critical section  =  safe
             shared state + async (with await)     =  race
```

**Q: What's `AsyncLocalStorage` doing in this codebase, and why isn't a plain global enough?**

It scopes a per-request object so any deep callee can find it via `getStore()` without threading it through every function argument — but a *plain* global wouldn't work because two concurrent requests on the same warm instance would clobber each other's value.

`ALS.run(ctx, fn)` creates a frame that's *invisible to other requests*. Inside `fn`, `getStore()` returns `ctx`. Inside *another request's* `fn`, `getStore()` returns *their* `ctx`. Node's `async_hooks` machinery propagates the frame through every `await`, so even after the original stack frame is gone, the ctx is still findable.

If we used a plain global: two OAuth callbacks racing on one instance would see each other's PKCE verifiers, and at best fail one user's flow, at worst leak tokens.

Anchor: "ALS = per-request global, with no shared keyspace."

```
  plain global             ALS frame
  ────────────             ─────────
  let ctx = {}             ALS.run(ctx, fn)
  // any request sees      // only fn's call tree
  // any other's value     // sees this ctx
```

## See also

  → `03-event-loop-and-async-io.md` for the event-loop guarantees that make sync critical sections atomic.
  → `05-memory-stack-heap-gc-and-lifetimes.md` for how long these Maps live.
  → `07-backpressure-bounded-work-and-cancellation.md` for `AbortSignal` as another piece of per-request context.

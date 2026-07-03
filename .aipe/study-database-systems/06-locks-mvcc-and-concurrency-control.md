# Locks, MVCC, and concurrency control

*Concurrency control / Language-agnostic*

## Zoom out, then zoom in

You know how in Postgres two concurrent `UPDATE` statements on the same row block each other with a row lock, and MVCC lets readers see the pre-update snapshot without waiting? That's concurrency control. This repo has none of that machinery — no locks, no MVCC, no CAS, no compare-and-swap. Instead it leans on Node's single-threaded event loop and one clever runtime primitive: `AsyncLocalStorage`. This file walks the standard toolbox, then names which mechanism plays which role here.

```
  Zoom out — where "concurrency control" lives

  ┌─ UI (browser) ────────────────────────────────────────────┐
  │  one tab = one concurrent reader/writer to this session    │
  └────────────────────────┬──────────────────────────────────┘
                           │
  ┌─ Service (Vercel warm instance) ▼─────────────────────────┐
  │                                                            │
  │  ★ Node event loop = mutual exclusion between JS turns     │ ← this file's scope
  │  ★ AsyncLocalStorage = request-scoped isolation            │
  │  ★ sessionId partitioning = no cross-user contention       │
  │                                                            │
  │  no locks · no MVCC · no CAS · no optimistic retry          │
  │                                                            │
  └────────────────────────┬──────────────────────────────────┘
                           │
  ┌─ Provider (Bloomreach) ▼──────────────────────────────────┐
  │  their concurrency controls are opaque; we experience them │
  │  as rate limits (~1 req/s), not locks                      │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in.** The runtime and the data shape together do all the concurrency work. The interesting mechanism isn't locking — it's how the ALS store at `auth.ts:47` gives you request-scoped state without any lock at all.

## Structure pass

**Axis to hold constant: what enforces "one writer at a time" on each piece of state?**

```
  "what makes writes safe?" — traced across the state primitives

  ┌─ per-session inner Map (insights, anomalies) ───────────┐
  │  putInsights runs synchronously; JS event loop cannot    │  → event loop
  │  interleave two turns' writes                            │    (turn atomicity)
  │  insights.ts:57-71                                       │
  └─────────────────────────────────────────────────────────┘
      ┌─ BloomreachDataSource cache (Map) ──────────────────────┐
      │  callTool writes cache.set(key, {result, expiresAt})     │  → event loop
      │  synchronously after `await liveCall`; still turn-atomic │    (turn atomicity)
      │  bloomreach-data-source.ts:185-187                       │
      └─────────────────────────────────────────────────────────┘
          ┌─ auth store (per request) ───────────────────────────┐
          │  ALS ctx.store is scoped to ONE request via              │
          │  requestStore.run(ctx, fn) — concurrent requests get    │  → AsyncLocalStorage
          │  different ctx instances, no shared mutation            │    (request scoping)
          │  auth.ts:47, 86-104                                     │
          └─────────────────────────────────────────────────────────┘
              ┌─ dev-only file cache (.investigation-cache.json) ──────┐
              │  read-modify-write with no lock — not concurrency-safe │  → no protection
              │  investigations.ts:30-41                                │    (accepted: dev)
              └────────────────────────────────────────────────────────┘
```

The seam that flips the axis is **the async boundary within one request** — `await`. Before an `await`, you're a single-turn atomic block. After it, the loop may have run other code. That's the moment `AsyncLocalStorage` earns its keep: it gives you a store that follows the *async control flow* of your request rather than being reset by every yield.

## How it works

### Move 1 — the mental model

The concurrency-control toolbox, briefly:

```
  standard concurrency-control mechanisms

  pessimistic locking    ─── take a lock before touching X, others wait
                              (row locks, table locks, advisory locks)

  optimistic locking     ─── read X + version; write "SET version+1
                              WHERE version = old"; retry on mismatch

  MVCC                    ─── writers create a new version; readers
                              see the version from their snapshot;
                              no reader-writer blocking

  CAS / atomic-op         ─── compare-and-swap primitive at the storage
                              layer (Redis, atomic file rename, etc.)

  serialization by design ─── organize so only one writer per key exists
                              at a time (partition by user, event loop, etc.)
```

This repo picks the last one. All-in on "serialization by design." Then it uses `AsyncLocalStorage` as the mechanism to preserve *request identity* across async yields, which is a subtler form of the same idea — instead of locking a resource, you *scope* the resource to a control-flow context that can't be shared.

The kernel of the ALS trick:

```
  AsyncLocalStorage kernel — request-scoped state without a lock

  1. runtime tracks a "current context" that follows async continuations
  2. requestStore.run(ctx, fn) sets ctx for the duration of fn (and every
     await it produces)
  3. concurrent calls to run(ctx, fn) with DIFFERENT ctx values do NOT
     see each other's ctx — the two async chains have independent stores
  4. inside fn, requestStore.getStore() returns THIS request's ctx —
     even after an `await` that resumed another turn in between

  what breaks if you remove:
    step 2 → the store leaks between requests (module-level Map bleed)
    step 3 → concurrent requests race on shared mutable state
    step 4 → you can't read the store from deeply nested async helpers
```

That's the mechanism. It's not a lock; it's a *namespace* that follows your async chain.

### Move 2 — the primitives walked

**Node event loop = mutex-for-free.**

```ts
// lib/state/insights.ts:57-71   (repeated from previous file)
export function putInsights(sessionId: string, items: Insight[], rawAnomalies?: Anomaly[]): void {
  const s = sessionState(sessionId);
  s.insights.clear();
  s.anomalies.clear();
  items.forEach((i, idx) => {
    s.insights.set(i.id, i);
    if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx]);
  });
}
```

No `async`, no `await`. From the outside, this function is *indivisible*. The event loop cannot pick up another callback in the middle of a synchronous statement. That's your mutex. There is nothing else guarding this Map — no `Promise.all` gate, no semaphore, no advisory lock. The single-threaded runtime is the concurrency control.

**Same for the response cache write path.**

```ts
// lib/data-source/bloomreach-data-source.ts:185-187
const now = Date.now();
this.cache.set(cacheKey, { result, expiresAt: now + ttl });
return { result: result as T, durationMs, fromCache: false };
```

Runs synchronously after `result` is resolved. Two concurrent tool calls on the same instance CAN both reach this line, but they run in separate turns — one finishes its `cache.set` before the other's turn starts. If two racers happened to have the same `cacheKey` (unusual — they'd both be after the same tool+args), the second write clobbers the first. Since both values are the same fresh result, there's no visible harm.

**AsyncLocalStorage as request-scoped isolation.**

```ts
// lib/mcp/auth.ts:44-48
interface RequestStore { store: Store; dirty: boolean }
const requestStore = new AsyncLocalStorage<RequestStore>();
```

`requestStore.run(ctx, fn)` at `auth.ts:91` sets `ctx` as the current context for the duration of `fn`. Every `await` inside `fn` — even nested calls, even into other modules — sees the *same* ctx via `requestStore.getStore()`. But a *sibling* request in flight on the same warm instance is running its own `requestStore.run(otherCtx, otherFn)` and sees only *its* ctx. Two requests, two contexts, zero shared mutation. No lock needed.

```ts
// lib/mcp/auth.ts:113-122
function readAll(): Store {
  const ctx = requestStore.getStore();
  if (ctx) return ctx.store;               // ← inside a request: hit the ALS-scoped store
  if (!PERSIST) return Object.fromEntries(memStore);
  try {
    if (existsSync(CACHE_FILE)) return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Store;
  } catch { /* corrupt/unreadable cache — treat as empty */ }
  return {};
}
```

Every read routes through ALS in production. The OAuth SDK's `saveTokens` → `readState` → `patchState` chain (`auth.ts:189-217`) does dozens of these per handshake, all against `ctx.store`, all consistent within the request.

This is the *real* concurrency-control innovation in the repo. Nothing else here is doing anything you couldn't do in synchronous code.

**Rate limit as external "concurrency control".**

```ts
// lib/data-source/bloomreach-data-source.ts:190-205
private async liveCall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  ...
  this.lastCallAt = Date.now();
  ...
}
```

`this.lastCallAt` is a single number, mutated by every call. Two concurrent tool calls on the same `BloomreachDataSource` instance can both read `elapsed`, both decide "no wait needed," and both call the wire — the intended 1 req/s spacing collapses. This is *by acceptance*: within one process, one user's session tends to make sequential tool calls (the agent loop is serial), and the retry ladder catches any resulting rate-limit response. Between processes / warm instances, there's no shared coordination at all. Bloomreach's server-side global rate limit is the actual enforcer; this local spacing is a courtesy.

**Dev-only file cache — the racy corner.**

```ts
// lib/state/investigations.ts:30-41 (repeated)
export function saveInvestigation(insightId: string, events: AgentEvent[]): void {
  mem.set(insightId, events);
  if (PERSIST) {
    const all = readJson(CACHE_FILE);
    all[insightId] = events;
    try {
      writeFileSync(CACHE_FILE, JSON.stringify(all));
    } catch { /* best effort */ }
  }
}
```

The read-modify-write is not atomic across the read at line 34 and the write at line 37. Two dev routes hitting this simultaneously could both read the old file, both mutate their in-memory copies, both write — one loses. Accepted because it's dev, single-user, single-writer.

### Move 2 variant — the load-bearing skeleton

Kernel of "safe concurrent access" in this repo:

1. **The synchronous JS statement.** Every write happens inside a single turn. Break this (add an `await` between read and write) and you've introduced a race.
2. **`AsyncLocalStorage.run(ctx, fn)`** wrapping every production request that touches auth. Break this and you're back to module-level Map bleed across concurrent requests.
3. **The sessionId partitioning of the outer state Map.** Break this and you're back to cross-user clobbers.

The rest — the 200ms rate-limit spacing, the dev file cache — is best-effort, not skeleton.

### Move 3 — the principle

**When you can guarantee one writer per key per turn, you don't need locks.** Locks are how you defend against concurrent writers to the same resource. Remove concurrent writers *by shape* — session-scope every mutation, keep every write synchronous, wrap async chains in ALS scopes — and the machinery becomes unnecessary. The moment your shape allows two writers to the same key (a shared cache with cross-user reuse, a global counter, a shared file), locks or CAS come back into the picture.

## Primary diagram

```
  Every concurrency-control mechanism (and non-mechanism) here

  ┌─ turn-level: the event loop ────────────────────────────────┐
  │                                                              │
  │     turn N:  putInsights runs to completion (sync)           │
  │                       │                                      │
  │     turn N+1:         ▼                                      │
  │              some other request's callback                   │
  │                                                              │
  │     no interleave possible. event loop = mutex for free.     │
  │     lib/state/insights.ts:57-71                              │
  │     lib/data-source/bloomreach-data-source.ts:185-187        │
  └──────────────────────────────────────────────────────────────┘

  ┌─ request-level: AsyncLocalStorage ─────────────────────────┐
  │                                                              │
  │  request A                        request B                  │
  │    requestStore.run(ctxA, fnA)      requestStore.run(ctxB,fnB)│
  │       │                                │                     │
  │       └── every await inside sees ctxA │                     │
  │       └── readAll/writeAll → ctxA.store└── ctxB.store        │
  │                                                              │
  │  no shared mutation between them. ALS = request scoping.     │
  │  lib/mcp/auth.ts:47, 86-104                                  │
  └──────────────────────────────────────────────────────────────┘

  ┌─ data-level: sessionId partition ──────────────────────────┐
  │                                                              │
  │  state = Map<sessionId, SessionFeed>                         │
  │                                                              │
  │  session A's writes NEVER touch session B's Maps.            │
  │  no lock needed because there is nothing to contend for.     │
  │  lib/state/insights.ts:14                                    │
  └──────────────────────────────────────────────────────────────┘

  ┌─ accepted racy corners ────────────────────────────────────┐
  │                                                              │
  │  dev file cache read-modify-write   (single-writer env)     │
  │    lib/state/investigations.ts:30-41                         │
  │                                                              │
  │  lastCallAt spacing counter         (external limit catches) │
  │    lib/data-source/bloomreach-data-source.ts:190-205        │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

The ALS story deserves one more sentence because it's the interesting bit. `AsyncLocalStorage` is Node's built-in equivalent to a thread-local — except JS doesn't have threads, so it's continuation-local. When you `await` inside `requestStore.run(ctx, ...)`, the runtime remembers `ctx` so the resumed callback sees it. That means every helper called from your request handler — five modules deep, ten `await`s later — can read the same ctx without you passing it explicitly. And two concurrent requests can be doing this simultaneously with independent ctx values.

This is how Next apps get "request-scoped state" without singletons or locks. The code at `auth.ts:113-142` treats the cookie as the durability layer and the ALS store as the *within-request cache* that lets the OAuth SDK's synchronous read-then-set-then-read pattern actually work. Without ALS, every `saveTokens` would need to await a cookie flush, and every `readState` would need to await a cookie read; you'd serialize the OAuth handshake to a crawl and still hit the request-vs-response cookie split problem.

`study-runtime-systems` owns the deeper event-loop mechanics; `study-distributed-systems` owns the request-scoping pattern at coordination scale. Here the point is narrower: **ALS is the concurrency-control primitive in this repo**, and it's the one thing you couldn't remove without breaking OAuth.

### `not yet exercised`

- **Row / table locks.** No engine.
- **MVCC snapshots, undo log.** No engine.
- **Optimistic concurrency (version columns + retry).** No versioned rows.
- **Compare-and-swap primitives, atomic file rename tricks.** No shared mutable state that needs them.
- **Deadlock detection / prevention.** No locks that could deadlock.
- **Advisory locks (`pg_advisory_lock`, Redis SETNX).** No coordination point.
- **Distributed consensus / leader election.** No cluster.

## Interview defense

**Q: "How is concurrent state managed here?"**

Model answer: "Three mechanisms at three scopes. At turn scope, Node's single-threaded event loop makes every synchronous block atomic — `putInsights` at `lib/state/insights.ts:57-71` can't be interleaved by any other handler. At request scope, `AsyncLocalStorage` at `lib/mcp/auth.ts:47, 86-104` gives each in-flight request its own store that follows async continuations, so the OAuth SDK's read-then-write-then-read chain sees consistent state across dozens of `await`s. At data scope, the outer `Map` in `lib/state/insights.ts:14` is keyed by sessionId, so no two users can ever contend for the same inner Map. There are no explicit locks anywhere because the shape guarantees one writer per key per turn."

Diagram to sketch: the "every concurrency-control mechanism" primary diagram, three-band stack.

**Q: "Walk me through the AsyncLocalStorage pattern in `withAuthCookies`."**

Model answer: "The problem it solves is that Next's cookie API has request-vs-response split — reading a cookie *after* setting it in the same request returns the OLD value. The OAuth SDK does dozens of read-then-write cycles per handshake, so we can't route each one through `cookies().get/set` directly. The fix at `lib/mcp/auth.ts:86-104` is: seed an `RequestStore = {store, dirty}` from the cookie once at the top, run the OAuth flow with `requestStore.run(ctx, fn)`, and if anything wrote (`ctx.dirty`), re-encrypt and set the cookie once at the bottom. Every `readState`/`patchState` inside targets `ctx.store` via `requestStore.getStore()` — request-scoped consistency without any lock, because ALS is what follows the async continuation. Two concurrent requests get different ctxs, so they can't race on each other's state either."

Anchor: ALS = per-request namespace that survives every `await`.

**Q: "What's the accepted race in the codebase?"**

Model answer: "One real one, dev-only: `saveInvestigation` at `lib/state/investigations.ts:30-41` does read-modify-write on a JSON file with no lock. Two concurrent dev routes writing to the same file could lose one write. Mitigation is 'dev-only, single user, one process, `PERSIST` gates it off in prod.' In production the whole file branch is dead code. There's also a soft race on `lastCallAt` at `lib/data-source/bloomreach-data-source.ts:190-205` — two concurrent calls could both skip the 200ms spacing — but the retry ladder catches any resulting rate-limit and Bloomreach's server-side limit is the actual enforcer. Both are acceptances, not bugs."

Anchor: dev file R-M-W is single-writer by convention; local rate spacing is a courtesy, not enforcement.

## See also

- `01-database-systems-map.md` — the state topology this file zooms in on.
- `05-transactions-isolation-and-anomalies.md` — the atomicity story that pairs with these locks/non-locks.
- `07-wal-durability-and-recovery.md` — what happens when the "no-lock" state gets wiped on cold-start.
- `study-runtime-systems` — deeper mechanics of the event loop and ALS.

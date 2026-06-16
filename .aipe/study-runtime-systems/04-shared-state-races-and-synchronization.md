# 04 — Shared state, races, and synchronization

**Industry name(s):** shared mutable state · request-scoped context · `AsyncLocalStorage` · the "two-write cookie" problem
**Type:** Industry standard pattern (Node.js) · Project-specific application

> **Verdict (Phase 2): three synchronization primitives now, two of them new.** First (unchanged): `AsyncLocalStorage<RequestStore>` in `lib/mcp/auth.ts:47` — per-request scoping for the cookie store. Second (new in Phase 2): `composeSignals` (`lib/mcp/transport.ts:173-189`, duplicated as a local helper in `lib/data-source/olist-data-source.ts:56-76`) — combines a caller-supplied `AbortSignal` with `AbortSignal.timeout(...)` so the first source to fire cancels the in-flight call. Third (implicit, new in Phase 2): the **single-flight subprocess** — the Olist child processes one JSON-RPC request at a time, which is what makes its synchronous `better-sqlite3` calls safe even though they block the child's event loop. Everything else (`Map<string, Insight>`, `Map<string, AgentEvent[]>`, the module-scope `cached` schema, the `McpClient.cache` Map) is still unsynchronized shared mutable state, and it's correct anyway — because JS run-to-completion gives you cheap safety on read-modify-write *within one event loop*. The `composeSignals` duplication (10 LOC repeated across `lib/mcp/transport.ts` and `lib/data-source/olist-data-source.ts`) is a known cleanup candidate; the pattern is real, the cleanup is shared-module promotion.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** All shared state lives in the **Server runtime**. The browser has its own React state per tab; the providers (Anthropic, Bloomreach) are stateless from our point of view. Inside one Node process on Vercel, the shared state surfaces are these:

```
  Where shared state lives — all in one process

  ┌─ Browser (V8 per tab) ───────────────────────────────────────────┐
  │  React state · sessionStorage · NOT shared with other tabs       │
  └─────────────────────────────│────────────────────────────────────┘
                                │  HTTPS
  ┌─ Vercel function (Node 20, ONE process) ────────────────────────▼┐  ← we are here
  │                                                                  │
  │  Module-scope (shared across ALL concurrent requests on this     │
  │  warm instance, no locking):                                     │
  │    insights         Map<string, Insight>                         │
  │    investigations   Map<string, AgentEvent[]>                    │
  │    cached schema    let cached: WorkspaceSchema | null            │
  │    McpClient.cache  Map<string, {result, expiresAt}>             │
  │                                                                  │
  │  Per-request (ALS-scoped — concurrent requests have separate    │
  │  contexts on the SAME loop):                                     │
  │    ★ requestStore   AsyncLocalStorage<{ store, dirty }> ★         │
  │      → THE only true synchronization primitive in the repo       │
  │                                                                  │
  │  Per-call (function locals, no sharing concern):                 │
  │    runAgentLoop's messages[], toolCalls[]                        │
  └──────────────────────────────────────────────────────────────────┘
```

**Zoom in — the concept.** A *race* is two pieces of code interleaving in a way that produces a wrong final state. In a single-threaded JS runtime, races don't happen *inside* one synchronous block — but they absolutely happen *across* `await` boundaries when two async tasks share the same module-scope variable. The fix is either (a) don't share — keep state in function locals or per-request contexts; or (b) accept the race because the answer is OK either way (the in-process caches are like this — last writer wins, and the worst case is a refresh).

---

## Structure pass

**Layers.** Three nesting depths of "shared":
1. **Function locals** — not shared, no race possible.
2. **Per-request context** — shared inside one request's async work, not across requests. ALS does this.
3. **Module scope** — shared across every concurrent request on the warm instance.

**Axis traced: *who owns the write, and what happens when two writes race?***

```
  "Who owns the write, what happens when two race?" — across layers

  ┌─ function local (e.g. runAgentLoop messages[]) ──┐
  │  one owner: the running task                      │   → no race possible
  └────────────────────────┬─────────────────────────┘
                           │
  ┌─ per-request (ALS ctx for auth store) ──────────▼┐
  │  one owner per request; ALS isolates              │   → no cross-request race;
  │   concurrent requests get separate ctx objects    │     INTRA-request safe because
  │                                                    │   run-to-completion (no await
  │                                                    │   between read and write in
  │                                                    │   any one provider method)
  └────────────────────────┬─────────────────────────┘
                           │
  ┌─ module scope (the Maps, the cached schema) ────▼┐
  │  N owners: every concurrent request can write     │   → last-writer-wins is OK
  │  the loop's run-to-completion still prevents       │     because state is opportunistic
  │  inter-leaved partial updates                      │     cache / "current feed"
  └───────────────────────────────────────────────────┘

  the answer flips at the module-scope boundary — and the repo's whole
  consistency strategy is "make sure last-writer-wins is the RIGHT answer."
```

**Seams.** Two:

1. **Between concurrent requests at module scope.** No lock; last-write-wins. Tolerable for `insights` (next briefing replaces it; that's actually intended — see `putInsights` at `lib/state/insights.ts:30-42`). Tolerable for `cached` (same value either way). Tolerable for `McpClient.cache` (each request has its own `McpClient` anyway — see below).
2. **Between sync read and sync write of the same module-scope var, across an `await`.** This is where Next's cookie API would have broken us. The fix is `AsyncLocalStorage.run(ctx, fn)` — every read/write inside `fn` (and its async descendants) sees `ctx`, not the shared module store.

---

## How it works

### Move 1 — the mental model

You already know that you don't need a mutex around `arr.push(x)` in browser JS because JS is single-threaded. The same is true in Node — *within one synchronous block*. The thing JS does that browser code rarely does is hold mutable state at module scope and let two async tasks both reach in. That's where the race lives: not inside one `push`, but between *this task's read* and *that task's write* on either side of an `await`.

```
  The race kernel — what "concurrent on one loop" actually means

  module scope:  let store = { x: 0 };

  task A:                          task B:
    store.x = 1   ← sync, safe
    await fetch()  ← yield
                                   store.x = 2   ← sync, safe
                                   await ...     ← yield
    read store.x → 2   ← WRONG; we set it to 1!

  the bug isn't `store.x = 2` (that's atomic);
  it's that A's "read its own write" assumed nobody else ran
  between A's write and A's read. across an `await`, somebody can.
```

The skeleton fix: scope `store` to A's task via `AsyncLocalStorage`. Then A's read sees A's `store`, B's read sees B's `store`, and the module-level shared var disappears.

### Move 2 — the moving parts

#### 1) Module-scope `Map`s — shared, unsynchronized, deliberately OK

`lib/state/insights.ts` holds two module-level `Map`s and clears them on every `putInsights`. The clear-then-set pattern is a textbook race risk in a multi-threaded language; in single-threaded Node it isn't, *as long as no one `await`s between the clear and the set*.

```
  putInsights — atomic by virtue of run-to-completion

  export function putInsights(items, rawAnomalies) {
    insights.clear();           ← sync
    anomalies.clear();          ← sync
    items.forEach((i, idx) => { ← sync
      insights.set(i.id, i);
      if (rawAnomalies?.[idx]) anomalies.set(i.id, rawAnomalies[idx]);
    });
  }

  no await anywhere in this function → no other task interleaves.
  the WHOLE clear+repopulate runs as one indivisible unit on the loop.
```

What breaks if you ever add an `await` inside (say, an `await persist(item)` mid-loop): the function loses its atomicity. A second briefing call could see a half-populated map. The fix is to build the new map locally and swap it in atomically at the end — but it's not necessary today because no awaits are present.

#### 2) The `McpClient.cache` Map — per-request by construction

`McpClient` has a `cache = new Map(...)` instance field (`lib/mcp/client.ts:80`). It looks like shared mutable state. It isn't — because every `connectMcp()` call builds a fresh `McpClient` (`lib/mcp/connect.ts:91-96`), and `connectMcp` runs once per request. So the cache is effectively per-request. A real race would only happen if two requests shared a single `McpClient`, which they don't.

```
  McpClient.cache — looks shared, actually per-request

  request A:                         request B:
    connectMcp(sid_A)                 connectMcp(sid_B)
      └─ new McpClient(...)            └─ new McpClient(...)
            cache = Map A                    cache = Map B
            lastCallAt = 0                   lastCallAt = 0
            spacing gate = local             spacing gate = local

  there is NO cross-request cache reuse on the warm instance.
  the 60s cache TTL only ever helps WITHIN one request's run
  (the same tool called twice with the same args).
```

This is worth knowing because the route-level comment about caching ("60s cache absorbs repeats") is true *intra-request* and false *cross-request*. A new connection costs the full bootstrap each time.

#### 3) The cached schema — last-writer-wins, content always identical

`lib/mcp/schema.ts:131-141` holds `let cached: WorkspaceSchema | null = null` at module scope. Two concurrent requests could both find `cached === null` and both run `bootstrapSchema`, both compute the same result, and both assign `cached = ...`. That's a textbook race. It's harmless here because the result is deterministic — both requests compute the same `WorkspaceSchema` from the same project. The duplicated work costs ~4-5s of bootstrap, but the final state is correct.

```
  cached schema — the race that doesn't matter

  request A:                         request B:
    if (cached) return cached         if (cached) return cached
       ← null, fall through              ← null, fall through (interleaved)
    await bootstrapSchema(...)          await bootstrapSchema(...)
       ← duplicated work                  ← duplicated work
    cached = schemaA                    cached = schemaB
       ← both schemas equal              ← both schemas equal
    return cached                       return cached

  cost: ~4-5s of duplicated bootstrap on the FIRST cold request
        when two land at the same time.
  fix-if-needed: a Promise<WorkspaceSchema> cache (memoize the
                 in-flight promise so the second caller awaits the
                 first one's result). Not done; cost is borderline.
```

#### 4) `AsyncLocalStorage<RequestStore>` — the one place a lock-equivalent was needed

The MCP SDK's `OAuthClientProvider` interface has *synchronous* `clientInformation()`, `tokens()`, `saveTokens()`, `saveCodeVerifier()`, etc. The SDK calls these many times during one `client.connect(transport)`. We need:

- Each call to see the per-session state.
- Reads to see writes from earlier in the same request (after a `saveTokens`, the next `tokens()` must return the new tokens).
- Writes to NOT leak across requests on the warm instance.

Next's `cookies()` API can't be the backing store directly — `cookies().set(...)` followed by `cookies().get(...)` returns the OLD value in the same request (the response cookie is separate from the request cookie). And a plain module-scope `Map` would let concurrent requests collide.

The fix is to seed an in-memory store from the cookie ONCE at the start of the request, run all the SDK's reads/writes against THAT store, and flush the store back to the cookie ONCE at the end. To keep that store separate per concurrent request on one loop, use `AsyncLocalStorage`.

```
  AsyncLocalStorage — the per-task scope that makes the auth flow work

  withAuthCookies(async () => {
    // 1) seed ONCE
    const raw = (await cookies()).get(AUTH_COOKIE)?.value;
    const ctx = { store: raw ? decryptStore(raw) : {}, dirty: false };

    // 2) all SDK reads/writes go through readAll/writeAll, which check
    //    requestStore.getStore() FIRST. Inside this run(...), they hit ctx.
    return requestStore.run(ctx, fn);
    //                       │  │
    //                       │  └─ fn is the actual MCP connect, runs many
    //                       │     sync reads/writes on the auth store
    //                       │
    //                       └─ ctx is THIS request's store. Another
    //                          concurrent request's run() has its own ctx.

    // 3) flush ONCE, if anything changed
    if (ctx.dirty) (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), ...);
  });
```

What breaks without ALS: two simultaneous OAuth attempts on the warm instance write their PKCE verifiers to a shared `Map<sessionId, ...>` AND read from it — and the writes/reads happen across `await` boundaries inside `connect`. Request A's reads could see request B's verifier, the code exchange would fail with a PKCE mismatch, and the user sees a generic "invalid_grant."

#### 5) `composeSignals` — AbortSignal OR-combinator (new in Phase 2)

`AbortSignal` is a *coordination* primitive: many sources, one channel for "this work should stop." When the route layer threads its own signal through `runAgentLoop` (not done today — see `07`) and the adapter wants to ALSO enforce a per-call timeout, you need to OR the two signals so whichever fires first cancels the call. That's what `composeSignals` does.

```
  composeSignals — the AbortSignal OR-combinator

  function composeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
    const filtered = signals.filter((s): s is AbortSignal => !!s);
    if (filtered.length === 0) return new AbortController().signal;  ← never aborts
    if (filtered.length === 1) return filtered[0];                    ← passthrough
    if (typeof AbortSignal.any === 'function') {
      return AbortSignal.any(filtered);                               ← Node 20+ preferred
    }
    // fallback: glue an AbortController to forward whichever source fires
    const ac = new AbortController();
    for (const s of filtered) {
      if (s.aborted) { ac.abort(s.reason); return ac.signal; }
      s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
    }
    return ac.signal;
  }

  used at:
    lib/mcp/transport.ts:131       SdkTransport.callTool — composes opts.signal with timeout
    lib/mcp/transport.ts:150       SdkTransport.listTools — same
    lib/data-source/olist-data-source.ts:151  OlistDataSource.callTool — same shape
    lib/data-source/olist-data-source.ts:172  OlistDataSource.listTools — same shape
```

What this is for: making the per-call timeout (`AbortSignal.timeout(30_000)`) *additive* with whatever cancellation source the caller passes in. Today the caller-supplied signal is always `undefined` (no route reads `req.signal`), so `composeSignals` effectively just returns the timeout signal. The plumbing is ready for the day the route is wired up — see `07`.

**The duplication.** The function exists in two places with identical bodies. `lib/mcp/transport.ts` is the original; `lib/data-source/olist-data-source.ts` copied it inline rather than reach across the module boundary. This is documented as a cleanup candidate in the source comment (`// Same shape as composeSignals() in lib/mcp/transport.ts — kept local so this file doesn't reach across module boundaries for one helper.`). The right cleanup move is to promote it to `lib/runtime/signals.ts` (or similar) and import from both sites. Cost: 5 lines moved, 2 imports added. Won't change behavior.

#### 6) Single-flight subprocess — implicit synchronization via the wire protocol

The Olist child is single-flight by virtue of the MCP SDK's request/response model: the parent sends one JSON-RPC request frame, awaits one response frame, repeats. The SDK does NOT pipeline (one outstanding request at a time per client). That property is what makes the child's synchronous `better-sqlite3` calls safe.

```
  single-flight subprocess — synchronization without locks

  parent calls OlistDataSource.callTool(name1, args1)  →
                                                          │ frame 1 over stdin
                                                          ▼
                                              child reads frame 1
                                              runs db.prepare(sql).all(args)  ← BLOCKS child loop
                                                                                (safe — nobody else
                                                                                 is waiting)
                                              writes response frame to stdout
                                                          ▲
                                                          │
  parent awaits frame 1's response  ←──── frame 1 reply
  parent calls OlistDataSource.callTool(name2, args2)  →
                                                          │ frame 2 over stdin
                                                          ... (same again)

  NO scenario where the child runs two queries in parallel from one client.
  NO scenario where two clients share one child (one OlistDataSource = one child).
```

If we ever wanted parallel queries from the same parent against the same child, we'd need to add a request multiplexer in the SDK (which it doesn't ship) AND make the child's tool dispatch async (which `better-sqlite3` cannot). The single-flight property is load-bearing — drop it without changing the SQLite driver and the child's event loop deadlocks on the second concurrent query.

#### 7) What "synchronization" means here — and what it doesn't

There are no mutexes, no semaphores, no `Atomics`, no `SharedArrayBuffer` in the repo. There's no need: every shared write that matters is either (a) one synchronous block that can't be interleaved, (b) scoped via ALS to one request, or (c) sequenced by single-flight stdio (subprocess).

```
  Synchronization primitives — what's used vs what isn't

  ┌─ used ──────────────────────────────────────────────────────────┐
  │  AsyncLocalStorage<RequestStore>   lib/mcp/auth.ts:47           │
  │    (per-request scoping for the cookie store)                   │
  │                                                                 │
  │  composeSignals + AbortSignal.any  lib/mcp/transport.ts:173     │
  │    (Phase 2: OR-combine cancel sources)                         │
  │                                                                 │
  │  single-flight subprocess          lib/data-source/olist…       │
  │    (Phase 2: implicit serialization across the stdio pipe)      │
  │                                                                 │
  │  run-to-completion (implicit in every sync block)               │
  │    putInsights, getCachedInvestigation, parseWorkspaceSchema    │
  └─────────────────────────────────────────────────────────────────┘
  ┌─ NOT used ──────────────────────────────────────────────────────┐
  │  mutex / Lock / Semaphore                                        │
  │  Atomics.add / Atomics.load                                      │
  │  SharedArrayBuffer                                               │
  │  worker postMessage channels                                     │
  │  any explicit Promise.race-based critical section                │
  └─────────────────────────────────────────────────────────────────┘
```

### Move 3 — the principle

**In a single-threaded async runtime, the right question isn't "do I need a lock?" — it's "does my read see a write I didn't make?"** If yes, scope the state per task (ALS) or make the access atomic (no `await` between read and write). If no, the unsynchronized shared `Map` is fine. The repo's design is consistent with this: every place state is shared, the answer is either "last-writer-wins is correct here" (the Maps) or "ALS makes it not shared" (auth). There is no middle ground where unsynchronized state is wrong but tolerated.

---

## Primary diagram

The full shared-state picture for one warm Node instance handling two concurrent requests:

```
  Two concurrent requests, one warm instance — what they share, what they don't

  ┌─ Vercel function (Node 20) ───────────────────────────────────────────┐
  │                                                                       │
  │   request A: GET /api/agent              request B: GET /api/briefing │
  │       │                                       │                        │
  │       └──────── one event loop ───────────────┘                        │
  │                                                                       │
  │   ┌─ SHARED at module scope (no locking) ───────────────────────────┐ │
  │   │   insights Map           (both write, putInsights clears+sets)  │ │
  │   │   investigations Map     (each writes its own insightId key)    │ │
  │   │   cached schema          (both may compute, identical result)   │ │
  │   │   McpClient instances ← each request builds its OWN McpClient,  │ │
  │   │                         so .cache and .lastCallAt are NOT shared │ │
  │   └─────────────────────────────────────────────────────────────────┘ │
  │                                                                       │
  │   ┌─ PER-REQUEST via ALS (lib/mcp/auth.ts) ─────────────────────────┐ │
  │   │   requestStore.run(ctx_A, fnA)   requestStore.run(ctx_B, fnB)   │ │
  │   │   ctx_A.store / ctx_A.dirty     ctx_B.store / ctx_B.dirty       │ │
  │   │      ← isolated; reads from inside fnA see ctx_A only            │ │
  │   └─────────────────────────────────────────────────────────────────┘ │
  │                                                                       │
  │   ┌─ PER-CALL function locals ──────────────────────────────────────┐ │
  │   │   messages[], toolCalls[], collected[] — local to each run      │ │
  │   └─────────────────────────────────────────────────────────────────┘ │
  └───────────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** The places where shared-state reasoning is actually invoked:

- **OAuth round-trip** — Bloomreach's PKCE flow needs a per-session `codeVerifier` that survives between `connect()` and `callback`. ALS makes the per-request layer safe; the cookie (or dev file) makes the cross-request layer survive.
- **The current briefing feed** — every new monitoring run *replaces* the previous one's insights. The clear-then-set pattern relies on run-to-completion.
- **Investigation cache** — `getCachedInvestigation` and `saveInvestigation` both touch the in-memory `Map` and a JSON file. The race is "two simultaneous saves for the same insightId" — last writer wins, contents are identical, so the race is benign.

**Code side by side.**

```
  lib/mcp/auth.ts (lines 41-47 + 86-104) — the only synchronization in the repo

  // ── docstring (the design rationale) ──
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
                                         └─ THE per-request scope.

  // ── the wrapper ──
  export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
    if (process.env.NODE_ENV !== 'production') return fn();   ← dev/test use file/memory, no scoping
    const { cookies } = await import('next/headers');
    const raw = (await cookies()).get(AUTH_COOKIE)?.value;
    const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };
    const result = await requestStore.run(ctx, fn);   ← THE call that scopes everything inside fn
    if (ctx.dirty) {
      (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), { ... });   ← single flush at end
    }
    return result;
  }
                       │
                       └─ EVERY readAll()/writeAll() inside fn (and the SDK calls fn
                          makes) sees ctx.store via requestStore.getStore(). Concurrent
                          requests each have their own ctx; no interleaving danger.
```

```
  lib/state/insights.ts (lines 30-42) — race-safe via run-to-completion

  export function putInsights(items: Insight[], rawAnomalies?: Anomaly[]): void {
    // Replace the previous briefing — each run IS the current feed, not an
    // addition. Without clearing, a warm serverless instance (or a long-running
    // dev server) accumulates stale insights from earlier runs, so the feed shows
    // yesterday's anomalies alongside today's. Investigations are keyed separately
    // and untouched here.
    insights.clear();           ← SYNC
    anomalies.clear();          ← SYNC
    items.forEach((i, idx) => { ← SYNC
      insights.set(i.id, i);
      if (rawAnomalies?.[idx]) anomalies.set(i.id, rawAnomalies[idx]);
    });
  }
       │
       └─ NO await in the whole function → atomic on the loop. Two concurrent
          briefings would have their putInsights calls serialize (one runs entirely,
          then the other) and the LAST one wins — which is exactly what "the current
          feed" means.
```

```
  lib/mcp/schema.ts (lines 131, 173-192) — benign race, identical results

  let cached: WorkspaceSchema | null = null;

  export async function bootstrapSchema(mcp: McpClient): Promise<WorkspaceSchema> {
    if (cached) return cached;     ← read
    const { projectId, projectName } = await resolveProject(mcp);   ← AWAIT (yield point!)
    // ... 4 sequential calls — each spaced by McpClient
    cached = parseWorkspaceSchema({ ... });   ← write
    return cached;
  }
       │
       └─ Race possible (two requests both see cached=null and both bootstrap).
          NOT a bug because both compute the same schema. Cost: ~4-5s of duplicated
          MCP work on the very first concurrent cold-warm transition. If you wanted
          to fix it: cache the Promise<WorkspaceSchema>, not the resolved value, so
          the second caller awaits the first's in-flight bootstrap.
```

---

## Elaborate

The closest thing to a "synchronization primitive" Node hands you for async code is `AsyncLocalStorage`. It is not a lock — it does not block. It's a *context propagator*. The `.run(ctx, fn)` call associates `ctx` with the async work `fn` does, including all promise chains spawned from inside, and `.getStore()` returns it. Two concurrent `.run(...)` calls have two different `ctx`s; neither leaks into the other.

What this is good for: per-request context (the auth store), per-request logging (request IDs), per-request feature flags. What it isn't: a substitute for distributed locks (it only scopes within one process), a way to prevent races on module-scope state (it just gives you a different state to use instead).

Worth reading next: Node's `AsyncLocalStorage` docs (especially the section on tracing/diagnostics), and the V8 design notes on run-to-completion.

---

## Interview defense

**Q: Why doesn't `putInsights` need a mutex even though it does a clear-then-bulk-write that two concurrent requests can both call?**
A: JS run-to-completion. The whole function is synchronous — no `await` inside. The event loop can't interleave two synchronous blocks. So two concurrent `putInsights` calls serialize naturally: one runs entirely (clears + sets), then the other does the same. The result is "the last one wins, completely." That's exactly what the spec wants — each briefing replaces the previous feed. The day someone adds an `await` inside the loop, this guarantee evaporates and we'd need to build the new state locally then swap atomically.

```
  putInsights atomicity

  ┌─ no await ─────────────────────────────────────────┐
  │  insights.clear(); ─┐                              │
  │  anomalies.clear(); ├─ all sync, indivisible       │
  │  items.forEach(set);┘                              │
  └────────────────────────────────────────────────────┘
  ┌─ if there WERE an await ──────────────────────────┐
  │  insights.clear();                                 │
  │  await persist(...);   ← yield point — other task  │
  │  items.forEach(set);     could see an EMPTY map    │
  └────────────────────────────────────────────────────┘
```

**Q: What's the one place in this codebase you actually needed `AsyncLocalStorage`, and why couldn't you have used a plain `Map<sessionId, Store>`?**
A: The OAuth flow in `lib/mcp/auth.ts`. The MCP SDK's `OAuthClientProvider` is synchronous — it calls `tokens()`, `saveTokens()`, `codeVerifier()`, `saveCodeVerifier()` many times during one `client.connect(transport)`. Those calls happen across multiple `await`s the SDK itself makes (HTTP fetches for DCR, the authorize URL, etc.). A plain `Map<sessionId, Store>` would work for cross-request isolation, but the *intra-request* reads need to see the *intra-request* writes — and Next's `cookies()` API splits request and response cookies, so we can't go through the cookie directly per call. ALS gives us an in-memory store scoped to the request's async context, seeded from the cookie once, flushed back once. That's the structural fix; the Map wouldn't have solved the Next cookie split, and going through `cookies()` per call would have returned stale reads.

---

## Validate

1. **Reconstruct.** Draw two simultaneous OAuth `connect` calls on the warm instance. Show the SDK calling `saveCodeVerifier` and then `codeVerifier` across an `await`. With ALS, what do they see? Without ALS, what could go wrong?
2. **Explain.** Why is the `cached` schema race in `lib/mcp/schema.ts:131` *benign* but the auth-store race (without ALS) would be a *bug*? (Schema is deterministic — same inputs, same output; auth state is per-session and writes are not idempotent.)
3. **Apply.** A new module wants to cache embeddings keyed by `(text, model)`. Where do you put the cache? Do you need ALS? (Module scope + plain Map is fine. The race is benign because embeddings are deterministic. No ALS needed; just a Promise<Embedding> if you want to dedupe in-flight requests.)
4. **Defend.** Defend the choice to NOT use a Promise cache in `bootstrapSchema`. Why is the duplicated-bootstrap cost acceptable? (One-time, ~4-5s, only on the very first concurrent requests after cold start. The complexity of memoizing an in-flight promise — handling errors, retries — isn't worth it at this scale.)

---

## See also

- `02-processes-threads-and-tasks.md` — single-flight subprocess as the implicit synchronizer of the child loop.
- `03-event-loop-and-async-io.md` — the `await` boundaries that turn unsynchronized state into a race, on both loops.
- `05-memory-stack-heap-gc-and-lifetimes.md` — what those module-scope `Map`s actually hold and how big they get.
- `07-backpressure-bounded-work-and-cancellation.md` — where `composeSignals` is half-wired and what completing the wiring would look like.
- `.aipe/study-security/00-overview.md` — *not yet generated* — for the auth-cookie crypto + the encrypted-cookie store as a security mechanism.

---
Updated: 2026-06-16 — added composeSignals (sec 5) and single-flight subprocess (sec 6); noted 10-LOC duplication of composeSignals as a cleanup candidate.

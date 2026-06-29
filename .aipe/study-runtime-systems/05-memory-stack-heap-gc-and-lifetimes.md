# Memory, Stack, Heap, GC, and Lifetimes

**Industry name:** memory model, lifetimes, garbage collection · **Type:** Industry standard

## Zoom out — where this concept lives

V8's heap and stack run inside the Node process. The repo doesn't tune either — no `--max-old-space-size`, no `process.memoryUsage()` logging, no heap snapshots. What matters for THIS codebase is which references stay live across requests on a warm Vercel instance, because anything still reachable from a module-level Map is anything the GC will not reclaim.

```
  Zoom out — what lives where

  ┌─ Node 20+ process ───────────────────────────────────────────────────┐
  │                                                                      │
  │  ┌─ V8 stack (per-call, ephemeral) ──────────────────────────────┐   │
  │  │  one call frame per active sync function                      │   │
  │  │  unwinds at every return / throw                              │   │
  │  └───────────────────────────────────────────────────────────────┘   │
  │  ┌─ V8 heap (the only place anything lives across awaits) ──────┐   │
  │  │  ★ THIS CONCEPT LIVES HERE ★                                 │   │
  │  │  - module-level Maps (lib/state/*, lib/mcp/auth.ts memStore) │   │
  │  │  - the schema cache (lib/mcp/schema.ts:138) ← leak           │   │
  │  │  - in-flight Promise objects (one per parked await)          │   │
  │  │  - tool result blobs (truncated to 16K before stringify)     │   │
  │  └───────────────────────────────────────────────────────────────┘   │
  └──────────────────────────────────────────────────────────────────────┘
```

Everything that survives an `await` lives on the heap. That's all of the interesting state. The stack matters only for synchronous functions and recursion depth — neither is a concern in this codebase.

## Structure pass

### Axis: when does this die?

Trace lifetime across the resource classes from `01-runtime-map.md`.

```
  When does this die? — the four answers

  module-level Maps       →  when the warm instance is recycled
  ALS contexts            →  when the await tree completes (request end)
  per-request instances   →  when the route handler returns and refs drop
  in-flight Promises      →  when they settle (resolve/reject) AND callers stop holding refs
```

Each answer corresponds to a different garbage-collection trigger. V8 reclaims an object when nothing references it; the question for each class is "what references it?" and "when does that go away?"

### Seams

The interesting seam is **request return → reference drop**. Inside a request, everything is reachable from the route handler's call stack. The moment `start(controller)` returns, those local references go away — and anything that was ONLY reachable from them becomes eligible for GC on the next pass.

```
  The request-return seam — what becomes garbage when

  during request               request ends                  next request
  ──────────────────           ─────────────────             ──────────────
  controller alive             controller.close()            (new request:
  BloomreachDataSource alive   start() returns                fresh handler,
  schema (cached!)             local refs drop                fresh DS,
                               GC eligible to free            cached survives)
                               EXCEPT cached at module
                               level — survives forever
                               (until instance recycle)
```

The seam clears most of the per-request memory naturally. The schema cache is the one piece that doesn't get cleared — which is exactly what makes it a leak in two senses: a correctness leak (cross-user data) AND a memory retention pattern (it can't be reclaimed without a process restart).

## How it works

### Move 1 — the mental model

You know how a local variable in a JS function dies when the function returns? Same for everything you allocate inside a request handler — it dies when the handler returns and nothing else references it. The exception is anything reachable from module-level (the top of the file). Those stay alive as long as the process does. So the whole game of "managing memory" in this codebase reduces to: what's reachable from module-level, and is that the right scope?

```
  The reachability rule — the only thing V8 cares about

  module-level ─────► stays alive forever (process lifetime)
       │
       └─► references session-keyed Map ─► all sessions stay alive
                                            forever (process lifetime)
                                            ← this is correct: we want
                                              per-user state to persist

  request handler ──► everything inside dies on return, UNLESS
                      something module-level grabs a reference
                      ← the leak shape: handler populates `cached`,
                        handler returns, `cached` survives, never freed
```

### Move 2 — the moving parts

#### The stack: shallow and unmonitored

Every active sync function has a stack frame. Every `await` releases the current frame (the function is parked; the continuation is captured on the heap) and re-pushes a fresh frame when it resumes. Recursion depth in this codebase is bounded — there's no recursive descent that would risk a stack overflow. The deepest stack you'd see is probably:

```
  route handler
    → ReadableStream.start
      → agent.scan / .investigate / .propose
        → runAgentLoop iteration
          → dataSource.callTool
            → transport.callTool
              → client.callTool (MCP SDK)
                → fetch (Node global)
```

That's seven or eight frames. V8's default stack size on 64-bit is around 1MB; you'd need thousands of recursive frames to hit it.

No code in the repo reaches for `process.setUncaughtExceptionCaptureCallback`, `--stack-trace-limit`, or any stack-tuning flag. The default behavior is fine.

#### The heap: where every interesting thing lives

V8's heap holds objects, closures, Promises, Maps, Buffers, strings. Anything that survives an `await` is on the heap because the stack frame around it was already torn down. In serverless, the heap fills up over the warm-instance lifetime and is wiped on cold start.

The repo's heap-residents, in rough order of how much memory they occupy:

```
  Heap occupants on a warm instance — what's actually big

  ┌─ tool result blobs (transient) ───────────────────────────────┐
  │  Each MCP callTool returns a result; ranges from KB to MB.    │
  │  Truncated to 16K chars BEFORE stringify in agent loop        │
  │  (lib/agents/base-legacy.ts:32). After the loop turn, the     │
  │  reference is held by tc.result inside ToolCall, which the    │
  │  route emits via send({type: 'tool_call_end', result: trunc}) │
  │  and discards. So peak is ~16KB × few-tools-per-turn.         │
  └───────────────────────────────────────────────────────────────┘
  ┌─ session feeds (long-lived) ──────────────────────────────────┐
  │  state: Map<sessionId, {insights, investigations, anomalies}> │
  │  Per session: 5-20 Insights × ~2KB each = ~30-40KB; some      │
  │  investigations stored as AgentEvent[] (a few KB each).       │
  │  Total per session: <100KB.                                   │
  │  Sessions are never explicitly evicted — the Map grows as     │
  │  long as the instance is warm.                                │
  └───────────────────────────────────────────────────────────────┘
  ┌─ the schema cache (long-lived, unkeyed) ──────────────────────┐
  │  One WorkspaceSchema ≈ 100-200KB (events × properties).       │
  │  cached: WorkspaceSchema | null holds ONE at a time, so       │
  │  bounded — but unfreed for the instance lifetime.             │
  └───────────────────────────────────────────────────────────────┘
  ┌─ in-flight Promise objects (transient) ───────────────────────┐
  │  Every parked await holds its continuation as a Promise +     │
  │  closure on the heap. With ~10 concurrent requests each       │
  │  parked on 1-2 awaits, that's ~20 Promise+closure pairs —     │
  │  negligible.                                                  │
  └───────────────────────────────────────────────────────────────┘
```

#### Where session memory grows unbounded

```ts
// lib/state/insights.ts:14
const state = new Map<string, SessionFeed>();
```

This Map gains an entry every time a new session hits the server, and never sheds one. On a warm instance that survives for a day, that could be hundreds of sessionIds — each holding their last briefing + investigations. The growth is bounded by the instance lifetime (cold start clears it) but unbounded WITHIN that lifetime.

For the current alpha, traffic is small enough that this never hits any limit. At higher scale, the move would be a TTL eviction: store a timestamp per session, sweep expired entries periodically. The pattern would mirror what `BloomreachDataSource.cache` already does (each entry has `expiresAt`) but at the session level.

#### Where references are CORRECTLY dropped

The per-request `BloomreachDataSource` instance:

```ts
// app/api/agent/route.ts:179, 322-323 — DataSource constructed and disposed per request
const dataSource = dsResult.dataSource;
// ...
} finally {
  try {
    await disposeDataSource();
  } catch (disposeErr) {
    console.error('[agent] dispose error:', redactSecrets(formatError(disposeErr)));
  }
```

When `start(controller)` returns, the local `dataSource` reference drops. `disposeDataSource()` is currently a no-op for the Bloomreach adapter (`lib/data-source/index.ts:98`) — the comment explains why: the OAuth state lives in the cookie store, not on the instance. But the SHAPE is correct: a future adapter that holds real resources (a connection pool, a TCP socket, an open file) would hook into the same `dispose` slot and free them here.

The `cache` Map inside `BloomreachDataSource` dies with the instance. So does `lastCallAt`. So does the `HttpErrorHolder` from `transport.ts`. All of those are bounded to one request.

#### Where the GC actually does work

V8's generational GC keeps short-lived objects in a "young" space and promotes survivors to "old" space. For this codebase:

- Most allocations (tool results, Promise continuations, parsed JSON) are short-lived — they live for one turn of the agent loop, then become eligible. V8's nursery cleans them up cheaply.
- Long-lived heap residents (the session Maps, the schema cache) get promoted to old space and are touched only on full GC cycles, which are rarer.

The repo doesn't expose memory metrics. No `process.memoryUsage()` log lines. The Vercel dashboard shows memory per invocation but the app doesn't surface it. For an alpha, this is acceptable; for production, the move would be a periodic snapshot in the `finally` block of each route, joined with the per-request `console.log` already there.

### Move 3 — the principle

Garbage collection on a long-lived process turns "memory management" into "reachability management." Anything reachable from module-level is functionally a singleton — it's alive for the process. Anything reachable only from request-scoped code dies when the request ends. The skill is keeping these straight: putting per-user state at module level (correct, with a session key) vs. putting global state at module level (correct if truly immutable) vs. putting per-request state at module level (the leak).

## Primary diagram

```
  The reachability map — what's alive when, in this codebase

  ┌─ module-level (alive for instance lifetime) ──────────────────────────┐
  │  const TOOL_TIMEOUT_MS = 30_000        ← immutable; fine              │
  │  const state: Map<sessionId, ...>      ← session-keyed; grows w/users │
  │  const mem: Map<insightId, ...>        ← UUID-keyed; grows w/insights │
  │  let cached: WorkspaceSchema | null    ← UNKEYED; finding #1          │
  └───────────────────────────┬───────────────────────────────────────────┘
                              │ references
                              ▼
  ┌─ request-scoped (alive while route handler runs) ─────────────────────┐
  │  BloomreachDataSource instance      ← dies when start() returns       │
  │    └─ cache: Map (60s TTL entries)  ← dies with instance              │
  │    └─ lastCallAt: number            ← dies with instance              │
  │  ALS ctx (auth.ts RequestStore)     ← dies when run() unwinds         │
  │  ReadableStream controller          ← dies when controller.close()    │
  └───────────────────────────┬───────────────────────────────────────────┘
                              │ references
                              ▼
  ┌─ in-flight (alive while await is parked) ─────────────────────────────┐
  │  Promise + continuation closures    ← settle, then GC'd               │
  │  tool result blobs (truncated)      ← discarded after send()          │
  │  AbortSignal listeners              ← removed on settle / abort       │
  └───────────────────────────────────────────────────────────────────────┘
```

## Elaborate

V8's heap model is well-suited to serverless: short-lived spikes get absorbed by the nursery, long-lived state lives in old space until a cold start wipes it. The app fits the model naturally — there's no need to tune `--max-old-space-size` or trigger manual `gc()` calls.

The schema cache leak is interesting as a memory pattern AS WELL as a correctness bug. Because `cached` holds ONE schema at a time (the latest write overwrites), it's not unbounded memory growth — but the schema it holds is the WRONG ONE for whoever reads it next. Fixing the correctness bug by switching to a `Map<sessionId, WorkspaceSchema>` would change the memory shape: bounded → unbounded-in-instance-lifetime, same as the other session Maps. That's the right tradeoff.

The "not yet exercised" parts of the memory topic:

- **Manual GC.** `global.gc()` would require launching Node with `--expose-gc`. The repo doesn't.
- **Heap snapshots.** No tooling wired in. Production-style monitoring would use the Node `--inspect` flag or a service like Datadog APM.
- **Off-heap buffers.** No `Buffer.allocUnsafe`, no `SharedArrayBuffer`. The only buffer use is in `auth.ts` for AES-256-GCM encryption (`createHash`, `createCipheriv`); those are short-lived and small.
- **WeakMap / WeakRef.** Not used. A reasonable evolution for the session Map would be a `WeakMap<SessionToken, SessionFeed>` if sessions had a token object you could let go of, but session IDs are strings (not eligible as WeakMap keys).

## Interview defense

> Q: "What's the memory shape of this app on a warm Vercel instance?"

Most allocations are transient — tool results, Promise continuations, parsed JSON — all freed within a request. The long-lived heap is three things: session-keyed Maps that grow per user (insights, investigations), an unkeyed schema cache that holds one `WorkspaceSchema` at a time (~100-200KB), and the encrypted auth store in dev. None of these are tuned; V8's default GC handles the volume.

> Q: "Where would memory grow unboundedly?"

The session Maps in `lib/state/insights.ts` and `lib/state/investigations.ts` never evict — they grow as new sessions hit the server until cold start. At alpha traffic this is fine; at scale you'd add TTL eviction (the same `{result, expiresAt}` pattern `BloomreachDataSource.cache` already uses, but at the session level). Cold start is the implicit eviction today.

> Q: "Why doesn't this codebase tune GC or heap size?"

Because the hot path is I/O-bound and the per-request memory budget is tiny — most allocations die within the request. V8's defaults are tuned for this shape. Tuning would matter if we held large in-memory caches across requests (we don't, beyond the schema cache, which is small) or did batch processing (we don't).

## See also

- `04-shared-state-races-and-synchronization.md` — the schema cache leak in its full context.
- `06-filesystem-streams-and-resource-lifecycle.md` — file-descriptor and stream lifetimes (the other resource class besides memory).
- `08-runtime-systems-red-flags-audit.md` — the schema cache ranked as finding #1.

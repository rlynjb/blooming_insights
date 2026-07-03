# Runtime systems — overview

Where work executes in blooming insights, what resources it owns, and what breaks under concurrency or overload — anchored to real files.

## The three bands

```
The whole runtime, in one picture

┌─ Browser ────────────────────────────────────────────────────────┐
│  React 19 components + hooks                                      │
│  useBriefingStream / useInvestigation                             │
│  fetch() → NDJSON reader (Web Streams)                           │
└────────────────────────────┬─────────────────────────────────────┘
                             │ HTTPS, one connection per request
                             │ req.signal on unmount
┌─ Vercel serverless (Node) ─▼─────────────────────────────────────┐
│  app/api/briefing/route.ts  · maxDuration = 300s                 │
│  app/api/agent/route.ts     · maxDuration = 300s                 │
│  ReadableStream<Uint8Array> body                                 │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ ONE Node process per warm instance                          │ │
│  │  · module-scoped: session Maps, mcp Client, prompt strings  │ │
│  │  · request-scoped: AsyncLocalStorage (auth cookie store)    │ │
│  │  · call-scoped: AbortSignal timeout (30s) + client cancel   │ │
│  └─────────────────────────────────────────────────────────────┘ │
└────────────────────────────┬─────────────────────────────────────┘
                             │ HTTPS (per-user rate-limited ~1 req/s)
                             │ AbortSignal.any(client, 30s timeout)
┌─ Provider (external) ──────▼─────────────────────────────────────┐
│  Anthropic API (claude-sonnet-4-6)                               │
│  Bloomreach loomi connect MCP server                             │
└──────────────────────────────────────────────────────────────────┘
```

Three bands, not four. There is no worker, no child process, no OS thread that the app forks or manages. Every task inside the Node band lives on the single event loop; every task inside the Browser band lives on the single event loop. The whole codebase is `grep -r 'worker_threads\|child_process' → 0 hits`.

## The load-bearing verdict

The interesting runtime work in this repo happens **at the boundaries between the bands**, not inside them:

1. **Cancellation is threaded, not implicit.** The client can close a tab at any moment. `req.signal` composes with a per-call `AbortSignal.timeout(30_000)` in the MCP transport (`lib/mcp/transport.ts:131`), and both flow down through every async layer — MCP calls, Anthropic calls, agent loops. Whichever fires first wins.
2. **Shared state is scoped by construction.** Vercel warm instances multiplex many sessions on one Node process. Session-keyed `Map`s (`lib/state/insights.ts:14`), request-scoped `AsyncLocalStorage` (`lib/mcp/auth.ts:47`), and instance-scoped `BudgetTracker` (`lib/agents/budget.ts:41`) each pick the right scope. No shared mutable state is unscoped.
3. **Bounded work is enforced at every gate.** `maxDuration = 300s` on the route. `TOOL_TIMEOUT_MS = 30_000` per MCP call. `maxRetries = 3`, `retryCeilingMs = 20_000` per retry. `BUDGET_PER_INVESTIGATION_USD = 2.0` per investigation. `LOAD_CONCURRENCY = K` workers in the load harness. Every ceiling ends the work; none of them silently fail open.

The rest of this study walks the mechanisms behind those three verdicts.

## Ranked findings — what to read closely

Ordered by consequence. Each ranks the *risk* of an execution-model failure, grounded in `file:line`.

  1. **Runaway agent loops burn cost fastest.** The AptKit agent loop can call the model many times. Without a budget ceiling checked *before* each dispatch, one bad case eats the entire route budget. Fixed at `lib/agents/aptkit-adapters.ts:64-66` — `BudgetTracker.exceeded()` gate, throws `BudgetExceededError` before the API call. Interview-defense-tier detail: the check runs *pre-dispatch*, not post.

  2. **AbortSignal composition or timeouts, not just one.** `lib/mcp/transport.ts:131, :150` composes `opts?.signal` (client cancel) with `AbortSignal.timeout(30_000)` (per-call ceiling). Falls back to `AbortController` glue on older runtimes. First to fire wins. Without this, one hung Bloomreach call would burn the whole 300s.

  3. **AsyncLocalStorage as the seam for per-request state.** `lib/mcp/auth.ts:47` — `RequestStore` seeded from cookie once, read many times by the SDK's OAuth provider methods, flushed to cookie once. Without ALS, Vercel's "read your write in the same request" cookie split returned stale values every call.

  4. **Session-keyed shared state, cleared per session only.** `lib/state/insights.ts:14, :62-71` — outer `Map<sessionId, SessionFeed>` is never cleared by a request; only the caller's own sub-feed is cleared. Without this, `putInsights` would wipe another user's feed mid-briefing on a warm instance.

  5. **Monotonic-clock spacing gate.** `lib/data-source/bloomreach-data-source.ts:123, :190-198` — `lastCallAt` clock check spaces MCP calls at `minIntervalMs = 1100` on the same instance. This is the closest thing to a mutex in the codebase; races don't matter because the miss cost is one extra HTTP call, not corrupt state.

  6. **StrictMode-safe once-per-mount.** `lib/hooks/useInvestigation.ts:44, :48-49` — `useRef` latch prevents React 19 dev double-mount from double-fetching *and* deliberately does NOT cancel the fetch on cleanup. Cancelling on cleanup + started-guard aborted the stream and left logs empty; the current shape is intentional.

  7. **Semaphore-based worker pool.** `eval/load.eval.ts:171-211` — N indices in one shared queue, K async workers `shift()` from it until exhausted, `Promise.all(workers)`. The standard JS-runtime concurrency primitive when you don't have threads: no shared memory to guard, just async workers sharing a queue.

  8. **Retry ladder capped so worst case fits the budget.** `lib/data-source/bloomreach-data-source.ts:163-174, :127-137` — parsed retry-after hint OR exponential backoff, capped at `retryCeilingMs = 20_000`, at most `maxRetries = 3`. A single rate-limited call worst-cases at ~30s, well under the 60s Hobby ceiling that used to run this app.

  9. **Session-scoped cache is instance-local.** `lib/data-source/bloomreach-data-source.ts:122, :144-152` — 60s TTL Map per adapter instance. On Vercel a warm instance serves many sessions from the same cache; on a cold start the cache is empty. No cross-instance cache; the demo snapshot fills that gap for the presentation path.

## Reading order

Start at 01 (the runtime map) to place every mechanism on the picture. Then 02–07 walk the mechanisms in dependency order. 08 ranks the risks, with every verdict anchored to a `file:line`.

  1. `01-runtime-map.md` — the map of processes, tasks, and resources.
  2. `02-processes-threads-and-tasks.md` — where work runs. Threads and child processes are *not yet exercised*.
  3. `03-event-loop-and-async-io.md` — the single loop, and how blocking is avoided.
  4. `04-shared-state-races-and-synchronization.md` — session-keyed state, ALS, and the monotonic-clock spacing gate.
  5. `05-memory-stack-heap-gc-and-lifetimes.md` — allocation, cache lifetime, and the module-load-time reads.
  6. `06-filesystem-streams-and-resource-lifecycle.md` — file reads (dev only), Web Streams, and the NDJSON kernel.
  7. `07-backpressure-bounded-work-and-cancellation.md` — every ceiling, every retry cap, and how the eval harness bounds concurrency.
  8. `08-runtime-systems-red-flags-audit.md` — ranked risks with evidence.

## Not yet exercised

Named honestly so no one goes hunting.

  → **Worker threads (`worker_threads`)** — not used. The heaviest CPU work in the request path (JSON parse of large tool results, cost math) fits well under the tick budget.
  → **Child processes (`child_process`)** — not used. The Olist prototype is documented in prose; there is no `spawn` / `exec` in production code.
  → **OS threads, cluster** — Vercel manages process lifecycle. No app-level `cluster.fork`.
  → **Locks, mutexes, atomics** — single-threaded event loop, no shared memory. The closest thing is the `lastCallAt` monotonic-clock check; that guards a spacing hint, not a correctness invariant.
  → **`node:stream` (Readable / Writable / Transform)** — routes use Web Streams (`ReadableStream<Uint8Array>`), not Node's stream module. The two are different APIs even though the name overlaps.
  → **Queues, brokers (Kafka / Redis Streams / SQS)** — no background job system. Work executes inside the request that started it, bounded by `maxDuration`.
  → **`SIGTERM` / graceful shutdown handlers** — the platform kills the function. There is nothing to flush.
  → **Connection pools** — the MCP client is per-request; there is no long-lived pool. The Anthropic SDK owns its own HTTP agent under the hood.
  → **Manual GC tuning (`--max-old-space-size`, `global.gc`)** — none. Vercel's Node runtime defaults are the runtime memory story.

## Cross-links to adjacent guides

  → `study-networking` — HTTP semantics, retry ladders, the ~1 req/s rate-limit dance, and TLS live there. The retry-ladder timing bounds this guide reads about are for *runtime* budgeting; the semantics of the retries themselves are networking.
  → `study-system-design` — the DataSource seam (`lib/data-source/types.ts`), the three-band architecture, and the Vercel + serverless deployment shape.
  → `study-testing` — how runtime behavior is verified deterministically (Vitest with injected fakes; the fault-injecting DataSource at `lib/data-source/fault-injecting.ts`).
  → `study-debugging-observability` — the per-request `console.log(JSON.stringify({phases…}))` summary in the `finally` block of each route.

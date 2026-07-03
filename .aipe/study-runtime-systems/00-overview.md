# Runtime systems — overview

Where work actually executes in `blooming_insights`, what owns which resources, and what would break under concurrency or overload. Grounded in the current codebase; nothing invented.

## Zoom out — the runtime map at a glance

The repo runs in three distinct execution bands. Not four (no queue/worker tier, no Redis, no background process). Each band has a different resource model, and every design decision below hangs on which band a piece of code lives in.

```
  The three runtime bands — where code executes

  ┌─ Browser ───────────────────────────────────────────────┐
  │  React 19 · single JS thread · localStorage / session   │
  │  useInvestigation, McpConfigModal, ndjson reader        │
  └───────────────────────┬─────────────────────────────────┘
                          │ fetch()  +  NDJSON stream
  ┌─ Vercel serverless ──▼──────────────────────────────────┐
  │  Node 20 runtime · one instance = one warm process      │
  │  ephemeral memory · 300s per-request budget             │
  │  app/api/agent/route.ts  ·  app/api/briefing/route.ts   │
  └───────────────────────┬─────────────────────────────────┘
                          │  HTTPS  (Bearer / OAuth PKCE)
  ┌─ Upstream provider ──▼──────────────────────────────────┐
  │  Bloomreach MCP  +  Anthropic API                       │
  │  we don't own the runtime; we own our rate/retry policy │
  └─────────────────────────────────────────────────────────┘
```

The eval tier (`eval/*.eval.ts`) runs in a fourth *context* — a long-lived Node process under vitest — but it's the same Node runtime as the serverless band with the wall-clock budget lifted. It doesn't count as a separate production tier.

## Ranked findings — read this first

The findings are ordered by consequence: what would break first under concurrency or overload, and what carries the most weight in the current design.

1. **ALS-scoped per-request state is the load-bearing pattern.** `lib/mcp/auth.ts:47` runs OAuth reads/writes inside an `AsyncLocalStorage` context so concurrent requests on the same warm Vercel instance never share tokens. Without this, two users on one instance would swap identities. See `04-shared-state-races-and-synchronization.md`.

2. **The 300s route budget is the only ceiling.** `app/api/agent/route.ts:23` (`export const maxDuration = 300`) is Vercel Pro's max. A live investigation runs 100-115s; retries eat ~10s each. There is no bulkhead — one slow investigation ties up one function invocation, not the fleet. See `07-backpressure-bounded-work-and-cancellation.md`.

3. **AbortSignal composition threads cancellation through every async layer.** `lib/mcp/transport.ts:131` OR's the client's signal with a per-call 30s `AbortSignal.timeout`. Client disconnect propagates all the way to the in-flight MCP call. Whichever fires first wins. See `07-backpressure-bounded-work-and-cancellation.md`.

4. **Session-keyed `Map<sessionId, SessionFeed>` is process-scoped, not shared.** `lib/state/insights.ts:14` gives each session its own sub-feed but only within one Vercel instance. Instance-B doesn't see instance-A's feed. The design compensates by encoding the anomaly into the URL as `?insight=…` — see `04-shared-state-races-and-synchronization.md` and `01-runtime-map.md`.

5. **Semaphore-based worker pool is how the eval harness bounds concurrency.** `eval/load.eval.ts:171-211` runs K workers pulling from a shared index queue. Errors don't stop other workers. This is the only place in the repo with explicit bounded parallelism. See `07-backpressure-bounded-work-and-cancellation.md`.

6. **BudgetTracker is check-before-dispatch, not interrupt.** `lib/agents/budget.ts:71` is checked BEFORE the next model turn; a runaway agent stops on the next boundary, not mid-call. The tracker instance is shared across DiagnosticAgent + RecommendationAgent via `AgentHooks.budget`. See `07-backpressure-bounded-work-and-cancellation.md`.

7. **BloomreachDataSource spacing gate uses a monotonic `lastCallAt` clock.** `lib/data-source/bloomreach-data-source.ts:123, :191-200` enforces ~1 req/s to Bloomreach with a simple elapsed-time check. Safe under single-instance concurrency because JS is single-threaded per event loop. See `04-shared-state-races-and-synchronization.md`.

8. **Client-side runtime detection for `btoa`/`atob` vs Node `Buffer`.** `lib/mcp/config.ts:80, :91` picks the encoding path per environment. Avoids bundling `node:buffer` into the client. See `03-event-loop-and-async-io.md`.

9. **SSR-safe localStorage access guards on every helper.** `lib/mcp/config.ts:107, :122, :143` checks `typeof localStorage === 'undefined'` and returns null / no-ops silently. Pattern: check before use, never assume browser. See `06-filesystem-streams-and-resource-lifecycle.md`.

10. **Page reload as state-reset primitive.** `app/page.tsx:264` calls `window.location.reload()` after saving MCP config. The alternative (a `configVersion` bumper + effect dep) would work but the reload keeps the fetch cache clean too. Simplest state model that works. See `04-shared-state-races-and-synchronization.md`.

## Reading order

Read the files in order — each depends on the map established in the file before it.

```
  1. runtime-map                        the three bands, what runs where
  2. processes-threads-and-tasks        one JS thread per band; ALS for scoping
  3. event-loop-and-async-io            the loop, microtasks, blocking hazards
  4. shared-state-races-and-syncchronization    the state you must worry about
  5. memory-stack-heap-gc-and-lifetimes         Node GC, ephemeral instance memory
  6. filesystem-streams-and-resource-lifecycle  NDJSON streams, dev-only cache file
  7. backpressure-bounded-work-and-cancellation the 300s budget + AbortSignal chain
  8. runtime-systems-red-flags-audit            ranked risks with evidence
```

## Not yet exercised

Naming what the repo doesn't have is as important as naming what it does.

- **No worker threads or child processes.** Everything runs on the main event loop. `worker_threads` and `cluster` are not imported anywhere.
- **No queue or background worker.** No BullMQ, no Redis Streams, no cron/scheduled tasks in production code. The eval harness is a batch, not a queue.
- **No shared cache across instances.** No Redis, no memcached. The Bloomreach in-flight 60s cache lives in one process's `Map`; another instance re-fetches.
- **No process-level synchronization primitives.** No `Atomics`, no `SharedArrayBuffer`, no locks. The ALS pattern is the only concurrency primitive.
- **No streaming ingestion.** Files are read whole (`readFileSync` for the demo snapshot); the NDJSON layer streams *out* to the browser but not *in* from disk.
- **No graceful shutdown handler.** Vercel functions are killed by the platform when their 300s ceiling hits; there is no `SIGTERM` handler because there is no long-running process to shut down.

Each of these is a candidate for the day the workload changes shape. Today the workload is one warm serverless instance per user session, and the design fits.

## See also

- `.aipe/study-system-design/` — where components live and how requests cross boundaries (the WHERE, complementing this file's HOW)
- `.aipe/study-testing/` — how runtime behavior is verified deterministically (test seams, fault injection)
- `.aipe/study-networking/` — HTTP semantics, timeouts, retries at the transport layer

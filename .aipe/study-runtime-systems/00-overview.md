# Runtime Systems — Overview

> the question: where does work execute, what resources does it own, and what breaks under concurrency or overload?

## The runtime, in one picture

Three execution bands. One ONE-process Node serverless function, one Vercel platform layer above it, and one browser tab below.

```
  blooming insights — the three runtime bands

  ┌─ Browser tab (Chromium/Safari/Firefox) ──────────────────────────────┐
  │   React 19 client (useBriefingStream / useInvestigation)             │
  │   one main thread · NDJSON reader (lib/streaming/ndjson.ts)          │
  │   AbortController via fetch's req.signal (cancel on cleanup)         │
  └──────────────────────┬───────────────────────────────────────────────┘
                         │  HTTPS · application/x-ndjson
  ┌─ Vercel platform ────▼───────────────────────────────────────────────┐
  │   Serverless function instances (Node 20+, ephemeral, may be warm    │
  │   reused for >1 request). maxDuration = 300s on /api/briefing and    │
  │   /api/agent. No autoscaler visible to the function.                 │
  └──────────────────────┬───────────────────────────────────────────────┘
                         │  spawns
  ┌─ Node process (ONE) ─▼───────────────────────────────────────────────┐
  │   single-threaded JS event loop                                      │
  │   AsyncLocalStorage-scoped per-request store (lib/mcp/auth.ts:47)    │
  │   module-level Maps (lib/state/insights.ts:14)                       │
  │   no child_process · no worker_threads · no cluster                  │
  └──────────────────────────────────────────────────────────────────────┘
```

A previous build had a fourth band — an Olist SQL subprocess behind the same `DataSource` port — that was retired before this guide was written. The seam survives (`lib/data-source/index.ts` still has a `dispose()` hook on the result envelope), but only two adapters live behind it now: `BloomreachDataSource` (live MCP) and `SyntheticDataSource` (in-process fake), both running inside the same Node process as their caller.

## What's load-bearing

Three primitives carry the runtime weight. The rest hangs off them.

| Primitive | Where it lives | What it bounds |
| --- | --- | --- |
| the per-request store (`AsyncLocalStorage` → `requestStore`) | `lib/mcp/auth.ts:47` | OAuth state isolation between concurrent users on one warm instance |
| the cancel signal composition (`AbortSignal.any(client, timeout)`) | `lib/mcp/transport.ts:131, 173` | per-call 30s ceiling OR'd with the route's `req.signal` |
| the route budget (`maxDuration = 300`) | `app/api/agent/route.ts:22`, `app/api/briefing/route.ts:19` | the absolute wall-clock budget every retry/spacing/turn-count tunable defends |

Pull any one and the system breaks differently. Pull ALS and two concurrent users on one warm instance start sharing OAuth tokens. Pull signal composition and a single hung MCP call burns the entire 300s budget. Pull the 300s ceiling and the Vercel platform kills the request before the agent emits `done`.

## Ranked findings — what the runtime gets right, and where it leaks

Walk these in order; the audit (`08-runtime-systems-red-flags-audit.md`) covers each in depth.

1. **Schema cache leaks across sessions (lib/mcp/schema.ts:138).** A module-level `let cached: WorkspaceSchema | null` survives between requests on the same warm Vercel instance and is keyed on NOTHING. User A's `projectId` / `projectName` returns to user B. Every other piece of session state in the repo is session-keyed (see `state.get(sessionId)` in `lib/state/insights.ts`); this one isn't. The fix is a `Map<sessionId, WorkspaceSchema>` or just deleting the cache (schema bootstrap is 4 sequential MCP calls — slow once per request, but correctness-preserving).
2. **The 60s response cache is shared across users (lib/data-source/bloomreach-data-source.ts:122, 144).** `BloomreachDataSource` instances are constructed PER REQUEST inside `connectMcp`, so this one is actually OK — but the proximity to finding #1 is uncomfortable. Worth a comment noting the per-instance scope.
3. **`disposeDataSource()` is a no-op for the only live adapter.** The seam is wired in `app/api/{agent,briefing}/route.ts` finally blocks, but `lib/data-source/index.ts:98` returns `dispose: async () => {}` for the Bloomreach branch. Comment explains why (cookie-scoped lifetime), but a future adapter with real resources would need this to actually fire.
4. **`useInvestigation` deliberately does NOT cancel on cleanup (lib/hooks/useInvestigation.ts:36-37).** This is a documented choice to survive React StrictMode's mount→cleanup→remount. The cost: a closed-tab investigation keeps running server-side until it hits `maxDuration`. Acceptable for a low-traffic alpha; would matter at scale.
5. **The `lastCallAt` rate-limit gate is not actually atomic (lib/data-source/bloomreach-data-source.ts:191-202).** Two concurrent `callTool` calls on the same `BloomreachDataSource` can both read `lastCallAt`, both compute `elapsed < minIntervalMs` as false, both fire immediately. Since `BloomreachDataSource` is per-request, this only matters if a single request fires parallel tool calls — which the agent loop today does not (tools run sequentially per turn).

## What's NOT exercised

These show up in the spec's concept list but the repo doesn't reach for them. Each gets one honest line in its own file rather than invented behavior.

- **Workers / threads / subprocesses.** `not yet exercised` — single-process Node only.
- **Locks / atomics / channels.** `not yet exercised` — single-threaded JS event loop means no shared-memory races; ALS solves the per-request isolation problem that locks would solve in a threaded runtime.
- **Manual GC tuning / heap snapshots.** `not yet exercised` — Vercel's default V8 settings; no `--max-old-space-size` overrides; no `process.memoryUsage()` logging.
- **File descriptor management / streams beyond `ReadableStream`.** `not yet exercised` for Node streams — the repo uses Web Streams (`ReadableStream` for NDJSON output) and synchronous `readFileSync` for tiny config/cache files. No `createReadStream` / no descriptor pools / no fs watches.
- **Graceful shutdown / signal handlers.** `not yet exercised` — serverless functions are killed by the platform; the app has nothing to flush.

## Reading order

```
  00-overview                  ← you are here
   │
   ▼
  01-runtime-map               processes, resources, lifetimes — the as-built map
   │
   ▼
  02-processes-threads-tasks   one process, no threads — what fills that vacuum
   │
   ▼
  03-event-loop-and-async-io   microtasks, ReadableStream pull, blocking hazards
   │
   ▼
  04-shared-state-races        the four state stores and how they stay isolated
   │
   ▼
  05-memory-stack-heap-gc      what lives across requests, what dies
   │
   ▼
  06-filesystem-streams        ReadableStream lifecycle, fs in dev vs prod
   │
   ▼
  07-backpressure-bounded      AbortSignal composition, retries, route budget
   │
   ▼
  08-runtime-red-flags-audit   ranked risks, evidence per verdict
```

## See also (other guides)

- `study-system-design` — WHERE components live (the bands as architecture, not as runtime). The DataSource seam, the OAuth boundary, the streaming contract.
- `study-testing` — HOW runtime behavior is verified deterministically. The fake-transport pattern that lets agent loops test without a real event loop or real MCP server.

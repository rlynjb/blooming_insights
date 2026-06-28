# Runtime systems — overview

A map of where work executes inside blooming insights, which resources it owns, and what breaks under concurrency or overload. This is the **execution-model** read of the repo — `study-system-design` answers *where components live*, this guide answers *how the code actually runs*.

## The three-band picture

Most "Next.js apps" mental models smuggle in extra runtimes that aren't there. This repo runs on **three** — not four. Read the runtime topology end to end before opening any concept file.

```
  blooming insights — the three runtimes (top to bottom)

  ┌─ band 1: CLIENT RUNTIME ──────────────────────────────────────────┐
  │  React 19 in a browser tab                                        │
  │  ─ fetch() → res.body.getReader() → TextDecoder → split('\n')     │
  │  ─ NDJSON parse loop (lib/streaming/ndjson.ts:17)                 │
  │  ─ useState dispatch on every event                               │
  │  ─ deliberately does NOT cancel on unmount (StrictMode)           │
  └──────────────────────────┬────────────────────────────────────────┘
                             │  HTTPS · NDJSON over chunked transfer
  ┌─ band 2: SERVER RUNTIME ─▼────────────────────────────────────────┐
  │  Node 20 on Vercel (ONE process per cold start, reused warm)      │
  │  ─ Next.js route handler (app/api/agent/route.ts)                 │
  │  ─ AsyncLocalStorage per request (lib/mcp/auth.ts:47)             │
  │  ─ BloomreachDataSource — minIntervalMs=1100 spacing gate         │
  │     + 60s response cache + rate-limit retry ladder                │
  │  ─ SyntheticDataSource — in-process, no I/O                       │
  │  ─ Session-keyed Map<sessionId, SessionFeed>                      │
  │     (lib/state/insights.ts:14)                                    │
  │  ─ maxDuration = 300s per route                                   │
  └────────────┬─────────────────────────────────┬────────────────────┘
               │  HTTPS · streaming HTTP        │  HTTPS · JSON
  ┌─ band 3: PROVIDER RUNTIME ──────────────────▼────────────────────┐
  │  Anthropic Messages API     ◄──┐    Bloomreach loomi-MCP server  │
  │  claude-sonnet-4-6              │    OAuth + PKCE + DCR + MCP    │
  │  + claude-haiku-4-5             │    rate-limited (~1 req/s)     │
  │  (two HTTP endpoints, reached via fetch + StreamableHTTPClient)  │
  └──────────────────────────────────────────────────────────────────┘
```

Important things this diagram is **not** showing, because they do not exist in this repo:

  → No fourth band. There is no subprocess runtime, no `child_process.spawn`, no `StdioClientTransport`. An olist MCP subprocess existed briefly in Phase 2 and was removed in PR #8. Today every tool call is `fetch` against a remote MCP server.
  → No tsx-based offline runtime. The `eval/scripts/run-*.ts` pipeline is gone.
  → No background workers, no queues, no cron, no Redis, no Postgres in the request path. State that survives a single request lives in the per-instance `Map` or in a browser cookie/sessionStorage.

If you have to anchor a finding to a band that is not in the picture above, the finding is wrong.

## Where each concept sits on this map

The eight concept files walk the diagram from the outside in:

| # | file | runs in band | the question it answers |
|---|---|---|---|
| 1 | `01-runtime-map.md` | all three | what processes, tasks, and resources actually exist |
| 2 | `02-processes-threads-and-tasks.md` | band 2 | Node is single-threaded — what does "concurrent" mean here |
| 3 | `03-event-loop-and-async-io.md` | band 2 | how `AsyncLocalStorage` + the spacing gate ride the microtask queue |
| 4 | `04-shared-state-races-and-synchronization.md` | band 2 | the session-keyed Map and ALS per-request context |
| 5 | `05-memory-stack-heap-gc-and-lifetimes.md` | band 2 | response cache, retained closures, warm-instance lifetimes |
| 6 | `06-filesystem-streams-and-resource-lifecycle.md` | bands 1+2 | `ReadableStream` controllers, dev cache files, NDJSON reader lock |
| 7 | `07-backpressure-bounded-work-and-cancellation.md` | bands 1+2 | `AbortSignal` plumbed through `DataSource.callTool`; the 30s per-call ceiling |
| 8 | `08-runtime-systems-red-flags-audit.md` | — | ranked risks that come from the above |

## Verdict-first ranked findings

These are the runtime-shaped risks I'd surface in a code review tomorrow, ranked by what breaks first.

1. **The `useInvestigation` hook deliberately does not cancel its fetch on unmount.** `lib/hooks/useInvestigation.ts:38–199`. The `startedRef` guard makes this safe for React StrictMode's double-mount dance, but it means a user who tabs away from an investigation page keeps a Vercel function running for up to 300s of budget burn. **Honest framing — this is a deliberate tradeoff, not a bug; the comment at line 32-37 spells it out.** The mitigation is server-side: `req.signal` is still threaded through every async boundary (`app/api/agent/route.ts:226`, `:237`, `:248`, `:274`, `:290`), but the client never fires it. → see `07-backpressure-bounded-work-and-cancellation.md`.

2. **The session-keyed Map only survives on a warm instance.** `lib/state/insights.ts:14`. Vercel cold-starts spawn a new Node process with a fresh empty Map; a feed-then-investigate hop that crosses cold boundaries loses state silently. The browser carries the `insight` JSON across via `sessionStorage` precisely because of this (`lib/hooks/useBriefingStream.ts:53`). → see `04-shared-state-races-and-synchronization.md`.

3. **`AsyncLocalStorage` is the only thing keeping concurrent OAuth flows from clobbering each other.** `lib/mcp/auth.ts:47`. Two users authorizing in parallel on the same warm instance would otherwise step on each other's PKCE verifiers. The ALS context isolates per-request reads/writes; one missing `withAuthCookies()` wrapper anywhere would punch a hole. → see `04-shared-state-races-and-synchronization.md`.

4. **The 60s response cache lives on the BloomreachDataSource instance.** `lib/data-source/bloomreach-data-source.ts:122`. Per-warm-instance, per-session. Two warm instances serve the same user's two tabs and they each keep their own cache. Behaviorally fine; observability gotcha when chasing a "why was this called twice" question. → see `05-memory-stack-heap-gc-and-lifetimes.md`.

5. **`SyntheticDataSource.callTool` accepts an `AbortSignal` and ignores it.** `lib/data-source/synthetic-data-source.ts:319–323`. The `_opts` parameter is intentionally unused — the dispatch is synchronous in-process work, so there's nothing to interrupt. Honest naming; the signal is still composed *to* this layer in case a future adapter needs it. → see `07-backpressure-bounded-work-and-cancellation.md`.

6. **The retry ladder can burn 30+ seconds of route budget on one call.** `lib/data-source/bloomreach-data-source.ts:163–174`. Three retries at ~10s each = ~30s, against a 300s per-route ceiling. The comment at line 160–162 names this explicitly. The 30s per-call timeout in `lib/mcp/transport.ts:38` bounds any single hung call but does not bound the retry ladder. → see `07-backpressure-bounded-work-and-cancellation.md`.

## Not yet exercised

These belong to a runtime-systems lens but the repo never hits them — naming them as gaps keeps the picture honest.

  → **Worker threads / `worker_threads`.** No `new Worker(…)` in the codebase. CPU-bound work (JSON encoding, agent loops) all runs on the main event loop. The agent loop is I/O-bound waiting on Anthropic + Bloomreach, so this is the right call today.
  → **Cluster / multi-process.** Vercel handles process management; the app sees one process at a time per instance.
  → **`fs` watchers, file streams.** Files are read with `readFileSync` / written with `writeFileSync` (dev-only auth + investigation caches in `lib/mcp/auth.ts:118`, `lib/state/investigations.ts:36`). No streamed file I/O.
  → **Shared memory / `SharedArrayBuffer`.** None.
  → **Process-level signal handlers (`SIGTERM`, etc.).** Vercel manages instance lifecycle; the app does not subscribe.
  → **GC tuning / `--max-old-space-size`.** Default V8 heap. No deliberate GC pressure.

## Reading order

Open the files in numeric order. `01-runtime-map.md` puts every later mechanism on the picture above; `08-runtime-systems-red-flags-audit.md` ranks risks once the underlying mechanics are on the table.

## Tests

24 files, 221 passing — the runtime mechanics in this guide (NDJSON parsing, cancellation propagation, session-keyed state, the spacing gate, the retry ladder) all have unit tests with injected fakes. None hit the network.

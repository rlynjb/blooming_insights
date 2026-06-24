# Overview — the runtime map

**Industry name(s):** runtime topology · execution model · process/event-loop map
**Type:** Industry standard · Language-agnostic (anchored to Node 20 + Next.js 16 App Router)

> blooming insights runs on **one Node runtime** — the Next.js process holds the route handlers, the active agents (`@aptkit/core`-backed), the `BloomreachDataSource` (HTTPS to the loomi-connect MCP server), and the in-process `SyntheticDataSource` (a Blooming-owned deterministic fake — no subprocess, no SQLite). The whole in-Node execution model still lives in the event loop: route handlers open a `ReadableStream`, the AptKit agent runtime walks one tool call at a time, and progress streams back as NDJSON. The most consequential primitives are **`maxDuration = 300`** on the two long routes (the platform's wall clock), **`McpClient.minIntervalMs = 1100`** (the spacing gate that paces the Bloomreach adapter), **`AsyncLocalStorage`** in `lib/mcp/auth.ts` (per-request context for the encrypted-cookie auth store), and the `signal?` option on `DataSource.callTool` (carried through from the Phase 2 seam — route handlers still don't read `req.signal` yet). The most surprising choice is still the deliberate absence of a wired-up `AbortController` from the *browser* to the agent loop. That cost is real and is named in section 7. The Phase 2 subprocess runtime (`mcp-server-olist/` spawned via `StdioClientTransport`) was deleted in PR #8 — the four-band map below collapses back to three.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Three bands. The **client runtime** is React 19 inside a browser tab — a `fetch().body.getReader()` pulls NDJSON lines off the wire, and `useInvestigation` intentionally does NOT cancel on unmount (see the note at `lib/hooks/useInvestigation.ts:32`). The **server runtime** is Node 20 in a Vercel function — one Node process per cold start, reused for warm invocations, killed by the platform after idle. Inside that process every request is a JS task on the event loop: a route handler returns a `Response(ReadableStream)`, the stream's `start()` callback awaits the agent loop, the agent loop awaits Claude + the data source, every `await setTimeout(...)` in `McpClient.liveCall` (Bloomreach adapter) is a microtask scheduled back onto the loop. The `SyntheticDataSource` lives in this same process (synthesized in-memory; no subprocess). The **provider runtime** is two HTTP endpoints (Anthropic + the Bloomreach MCP server), reached through `fetch` and `StreamableHTTPClientTransport`. The fourth band that briefly existed in Phase 2 — a `mcp-server-olist/` subprocess — was deleted in PR #8 (commit 62c24d7).

```
  blooming insights — the runtime in one frame (Phase 2)

  ┌─ Client runtime (browser tab · React 19) ──────────────────────────────────┐
  │   useInvestigation()                                                       │
  │      └─ fetch('/api/agent?…')                                              │
  │            └─ res.body.getReader()  ← pulls NDJSON line-by-line            │
  │            (no AbortController on unmount — by design)                     │
  └────────────────────────────────────│───────────────────────────────────────┘
                                       │  HTTPS · chunked transfer · NDJSON
  ┌─ Server runtime (Node 20 · Vercel function · ONE process) ─────────────────┐
  │   route handler (export const maxDuration = 300)                           │
  │      └─ new Response(new ReadableStream({ start(controller) {…} }))         │
  │            └─ await runAgentLoop({ … , dataSource })                        │
  │                  └─ await dataSource.callTool(name, args, { signal })      │
  │                        ├─ live-bloomreach: McpClient.liveCall              │
  │                        │     await setTimeout(1100 - elapsed) ← THE GATE   │
  │                        │     transport.callTool(…)            ← HTTPS      │
  │                        └─ live-sql:        OlistDataSource.callTool        │
  │                              client.callTool(…, { signal })   ← STDIO/JSON │
  │                                                                            │
  │   Process-local state (lost on cold start, not shared across instances):   │
  │     • lib/state/insights.ts        Map<string, Insight>                    │
  │     • lib/state/investigations.ts  Map<string, AgentEvent[]>               │
  │     • lib/mcp/schema.ts            module-scoped `cached` schema           │
  │     • lib/mcp/client.ts            per-instance `cache` Map (TTL 60s)      │
  │     • lib/mcp/auth.ts              AsyncLocalStorage<RequestStore>         │
  └─────────────│──────────────────────────────────│───────────────────────────┘
                │ HTTPS · OAuth · ~1 req/s         │ stdio pipe · JSON-RPC 2.0
  ┌─ Provider runtime ─────────────────────────┐   │
  │  Anthropic API  · Bloomreach loomi-connect  │   ▼
  └────────────────────────────────────────────┘   ┌─ Subprocess runtime (Node 20 child) ──┐
                                                   │  mcp-server-olist/dist/src/index.js   │
                                                   │   StdioServerTransport                │
                                                   │   better-sqlite3 (SYNC queries)       │
                                                   │   single-flight (one tool call at a   │
                                                   │   time → sync queries are OK here)    │
                                                   │  Lifecycle: spawned lazy on first     │
                                                   │   callTool, reused, killed on         │
                                                   │   OlistDataSource.dispose()           │
                                                   └────────────────────────────────────────┘

  Plus a third (offline) runtime: eval/scripts/run-*.ts under `tsx` (esbuild loader),
  not on Vercel, spawning their own Anthropic + OlistDataSource (which spawns the
  subprocess) per K-run. Each script is one Node process per `tsx ...` invocation.
```

**Zoom in — the question this guide answers.** *Where does work actually execute, what does it own while it executes, and what breaks when two of these things race or one of them overruns its budget?* You'll see the answer is still mostly "in one Node event loop, on one warm instance, for one user at a time, bounded by 300 seconds" — but Phase 2 added a second event loop running in a child Node process for the SQL adapter, and a third (offline) Node runtime for the eval scripts under `tsx`. The interesting parts are the few places that violate the single-loop story — `AsyncLocalStorage` for per-request context, the spacing gate (Bloomreach only), the in-process `Map`s, the stdio pipe to the Olist subprocess, the `composeSignals` AbortSignal OR-combinator that gates each subprocess call with a 30s timeout, and the `dispose()` discipline that kills the child on tear-down.

---

## Reading order

```
  Start here     →  Then go down the stack         →  End on risks
  ┌──────────┐      ┌──────────────────────────┐     ┌──────────────┐
  │ 01 runtime│ →   │ 02 processes-threads-tasks│ →   │ 08 red-flags │
  │    map    │     │ 03 event-loop-and-async-io│     └──────────────┘
  └──────────┘      │ 04 shared-state-races      │
                    │ 05 memory-stack-heap-gc    │
                    │ 06 filesystem-streams      │
                    │ 07 backpressure-bounded    │
                    └──────────────────────────┘
```

1. **`01-runtime-map.md`** — the topology, file-by-file: what runs in Node, what runs in the browser, what's external.
2. **`02-processes-threads-and-tasks.md`** — one Node process per invocation, no threads, every "concurrent" thing is a JS task.
3. **`03-event-loop-and-async-io.md`** — how the agent loop's `await`s become event-loop turns, and why the `await new Promise(setTimeout)` in `McpClient.liveCall` is the most load-bearing pause in the app.
4. **`04-shared-state-races-and-synchronization.md`** — `AsyncLocalStorage` as the per-request-store fix for Next's cookie read/write split, plus the module-level `Map`s and why they don't race.
5. **`05-memory-stack-heap-gc-and-lifetimes.md`** — the V8 heap, what the in-process caches hold and when they leak, the 16KB truncation guard, the 60s TTL.
6. **`06-filesystem-streams-and-resource-lifecycle.md`** — the demo-snapshot JSON files, the dev-only `.auth-cache.json` and `.investigation-cache.json`, the `ReadableStream` lifecycle, what `controller.close()` actually guarantees.
7. **`07-backpressure-bounded-work-and-cancellation.md`** — `maxDuration = 300`, `maxToolCalls = 6`, `maxRetries = 3`, the forced-synthesis turn, and the missing `AbortController`.
8. **`08-runtime-systems-red-flags-audit.md`** — ranked risks, with the evidence and the move.

---

## Ranked findings — what actually carries the runtime

These are the calls that, if pulled, change how the system behaves under any kind of pressure. Ranked by consequence.

1. **`maxDuration = 300` on `/api/briefing` + `/api/agent`** (`app/api/briefing/route.ts:17`, `app/api/agent/route.ts:20`) — the whole budget the Node runtime gets. A live investigation runs ~100-115s under the 1 req/s MCP limit; Hobby's 60s cannot fit it. This is the hard wall — every other budget (tool calls, retries, spacing) is sized against it.
2. **`McpClient.minIntervalMs = 1100`** (`lib/mcp/connect.ts:91-96`, gate enforced at `lib/mcp/client.ts:148-153`) — proactive spacing between Bloomreach tool calls. Olist has no gate (single-flight subprocess; SQLite query is microseconds). The 60s response cache in `McpClient.callTool` is what makes it survivable.
3. **`StdioClientTransport` + `OlistDataSource.dispose()`** (`lib/data-source/olist-data-source.ts:127-141, 176-196`) — Phase 2's new runtime primitive. One child Node process per `OlistDataSource` instance, spawned lazy on first `callTool`, reused across subsequent calls, killed on `dispose()`. JSON-RPC 2.0 framing over a Unix pipe. The lifecycle ownership is the load-bearing piece — forget `dispose()` and the child outlives the parent.
4. **`AsyncLocalStorage<RequestStore>`** (`lib/mcp/auth.ts:3,47,86-104`) — per-request context for the encrypted-cookie auth store. Without it, Next's request-vs-response cookie split (a read after a set returns the OLD value) would corrupt the OAuth flow.
5. **`composeSignals` + `AbortSignal.timeout(30_000)`** (`lib/mcp/transport.ts:173-189`, duplicated at `lib/data-source/olist-data-source.ts:56-76`) — combines a caller-supplied `signal` with a per-call 30s timeout. Whichever fires first cancels the in-flight MCP call. The DataSource interface (`lib/data-source/types.ts:38-44`) now accepts `signal?: AbortSignal` so the agent loop CAN propagate cancellation through the adapter — the route handlers just don't pass anything yet.
6. **`runAgentLoop` budgets: `maxTurns = 8`, `maxToolCalls = 6`** (`lib/agents/base.ts:73`, `lib/agents/monitoring.ts:101`, `lib/agents/diagnostic.ts:62`) — bounded work on top of bounded time. Hard tool-call budget + forced-synthesis turn (omit `tools` so the model MUST emit JSON) is what guarantees a route doesn't burn its 300s.
7. **The route-level `ReadableStream`** (`app/api/agent/route.ts:131-141, 169-265`, `app/api/briefing/route.ts:178-257`) — progressive streaming turns a 100s agent run into a UI that's visibly working at second 2. `controller.close()` in `finally` is the resource-lifecycle anchor.
8. **The in-process `Map`s** (`lib/state/insights.ts:4-6`, `lib/state/investigations.ts:11`, `lib/mcp/schema.ts:131`, `lib/mcp/client.ts:80`) — all "state" the app holds across requests lives here. Correct for one warm instance; silently wrong across two.

## Honest about what this codebase doesn't exercise

These are the runtime mechanisms the topic spec lists that the repo simply does not contain. The audit (section 8) won't manufacture risks for them.

- **Worker threads, clustering.** Not present. The Next.js process is single-threaded; the Olist subprocess is its own single-threaded Node process — they don't share memory.
- **Child processes for CPU.** Phase 2 introduced a child process (`mcp-server-olist/`), but for *protocol isolation and adapter symmetry with HTTP MCP*, not for CPU offload. The child's actual work (`better-sqlite3` queries) is sub-millisecond.
- **CPU-bound work in the parent.** The Next.js process still does only JSON parse/stringify; everything heavy goes to Anthropic, Bloomreach, or the subprocess (which executes SQLite in *its* event loop). No `Atomics`/`SharedArrayBuffer`.
- **Locks, mutexes, semaphores, channels.** Not used. The subprocess is single-flight (one tool call at a time) so its sync SQLite calls are safe; the parent's run-to-completion + `AsyncLocalStorage` covers everything else.
- **`AbortController` from the browser.** The *server-side* `signal?` option is now wired through `DataSource.callTool` (Phase 2) and `composeSignals` ORs it with `AbortSignal.timeout(30_000)`. What's still missing is the route handler reading `req.signal` and threading it through `runAgentLoop` — see section 7.
- **`SIGTERM` / `SIGKILL` handling.** Vercel kills the parent on `maxDuration` / eviction; we install no handlers. Crucially, **a parent crash does not automatically kill the Olist child** (named in section 8) — the SDK's `client.close()` only runs if `dispose()` is reached.
- **Streaming backpressure on the writer side.** The route enqueues bytes into `ReadableStream` without checking `desiredSize`. NDJSON events are tiny — the lever exists but isn't pulled.
- **File-watching, fs.watch, chokidar.** Not present.
- **Bull/BullMQ, Kafka, Redis Streams, any queue.** Not present.

## Top 3 runtime risks (full ranking in section 8)

1. **Orphan subprocess on parent crash** — `OlistDataSource` spawns a child via `StdioClientTransport` and only kills it in `dispose()`. If the parent crashes mid-request (uncaught throw, `maxDuration` SIGKILL, dev-server HMR), `dispose()` may not run and the child outlives the parent. No `process.on('exit')` cleanup is wired. Combined with the Phase 2 multi-instance eval scripts, this can leak children silently. See section 8.
2. **Process-local state on serverless** — every `Map` in `lib/state/*` and the `cached` schema in `lib/mcp/schema.ts:131` assumes one process. Vercel can warm a second instance and the user sees an empty feed. The route comment at `app/api/agent/route.ts:35` flags this explicitly.
3. **Browser-side cancellation still not propagated to the route** — the server-side `signal?` is now wired through `DataSource.callTool` and ORed with a 30s `AbortSignal.timeout`, but no route handler reads `req.signal` and no client effect-cleanup calls `ac.abort()`. Closing the tab still doesn't stop the run. Documented as a deliberate React-StrictMode workaround at `lib/hooks/useInvestigation.ts:32-36`. The plumbing is half-done now — section 7 names what's left.

---

## See also

- `01-runtime-map.md` — the runtime topology in detail (now four bands).
- `.aipe/study-system-design/00-overview.md` — the system-design map (components and trust boundaries) that this runtime guide sits underneath.
- `.aipe/study-distributed-systems/00-overview.md` — *not yet generated* — the place where multi-instance behavior, network failure between Node and providers, and serverless coordination would live.
- `.aipe/study-performance-engineering/00-overview.md` — *not yet generated* — the place to go for budgets, baselines, and where latency actually goes.
- `.aipe/study-testing/06-eval-flywheel.md` — the K=10 parallel-run anecdote (PIDs 30039/30040, `ps aux` + `kill`) and the `EVAL_RUN_TAG` mitigation. Cross-linked from section 8.

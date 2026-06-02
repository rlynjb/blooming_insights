# Overview — the runtime map

**Industry name(s):** runtime topology · execution model · process/event-loop map
**Type:** Industry standard · Language-agnostic (anchored to Node 20 + Next.js 16 App Router)

> blooming insights runs on **one Node runtime per Vercel function invocation**, with **no worker threads, no clustering, no background jobs, no queues**. The whole execution model lives in the Node event loop: route handlers open a `ReadableStream`, the agent loop (`runAgentLoop`) walks one tool call at a time through `McpClient`'s 1.1-second spacing gate, and progress is streamed back as NDJSON. The most consequential pieces are **`maxDuration = 300`** on the two long routes (the wall clock the runtime gets), **`McpClient.minIntervalMs = 1100`** (the gate that paces the entire system), and **`AsyncLocalStorage`** in `lib/mcp/auth.ts` (the per-request context that makes the encrypted-cookie auth store safe under concurrent requests on one warm instance). The most surprising choice is the deliberate absence of `AbortController` — when the browser disconnects mid-stream, the route keeps running until `maxDuration` or natural completion. That cost is real and is named in section 7.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Three bands. The **client runtime** is React 19 inside a browser tab — a `fetch().body.getReader()` pulls NDJSON lines off the wire, and `useInvestigation` intentionally does NOT cancel on unmount (see the note at `lib/hooks/useInvestigation.ts:32`). The **server runtime** is Node 20 in a Vercel function — one Node process per cold start, reused for warm invocations, killed by the platform after idle. Inside that process every request is a JS task on the event loop: a route handler returns a `Response(ReadableStream)`, the stream's `start()` callback awaits the agent loop, the agent loop awaits Claude + MCP, every `await setTimeout(...)` in `McpClient.liveCall` is a microtask scheduled back onto the loop. The **provider runtime** is two HTTP endpoints (Anthropic + the Bloomreach MCP server), reached through `fetch` and `StreamableHTTPClientTransport`. There is no second tier here — no Postgres, no Redis, no queue worker.

```
  blooming insights — the runtime in one frame

  ┌─ Client runtime (browser tab · React 19) ──────────────────────────────────┐
  │                                                                            │
  │   useInvestigation()                                                       │
  │      └─ fetch('/api/agent?…')                                              │
  │            └─ res.body.getReader()  ← pulls NDJSON line-by-line            │
  │            (no AbortController on unmount — by design)                     │
  └────────────────────────────────────│───────────────────────────────────────┘
                                       │  HTTPS · chunked transfer · NDJSON
  ┌─ Server runtime (Node 20 · Vercel function · ONE process) ─────────────────┐
  │                                                                            │
  │   route handler (export const maxDuration = 300)                           │
  │      └─ new Response(new ReadableStream({ start(controller) {…} }))         │
  │            └─ await runAgentLoop({ … }) ← all work is event-loop tasks      │
  │                  └─ await mcp.callTool(name, args)                          │
  │                        └─ McpClient.liveCall:                               │
  │                              await setTimeout(1100 - elapsed) ← THE GATE   │
  │                              transport.callTool(…) ← HTTP fetch            │
  │                                                                            │
  │   Process-local state (lost on cold start, not shared across instances):   │
  │     • lib/state/insights.ts     Map<string, Insight>                       │
  │     • lib/state/investigations.ts Map<string, AgentEvent[]>                │
  │     • lib/mcp/schema.ts         module-scoped `cached` schema              │
  │     • lib/mcp/client.ts         per-instance `cache` Map (TTL 60s)         │
  │     • lib/mcp/auth.ts           AsyncLocalStorage<RequestStore> ← per-req  │
  └────────────────────────│───────────────────────────────────────────────────┘
                           │  HTTPS · OAuth bearer · ~1 req/s/user limit
  ┌─ Provider runtime (external · we don't own this) ──────────────────────────┐
  │  Anthropic API (claude-sonnet-4-6)   Bloomreach loomi-connect MCP server    │
  └────────────────────────────────────────────────────────────────────────────┘
```

**Zoom in — the question this guide answers.** *Where does work actually execute, what does it own while it executes, and what breaks when two of these things race or one of them overruns its budget?* You'll see the answer is overwhelmingly "in one Node event loop, on one warm instance, for one user at a time, bounded by 300 seconds." The interesting parts are the few places that violate that — `AsyncLocalStorage` for per-request context, the spacing gate that turns a sequential agent loop into a paced one, the in-process `Map`s that fall over when Vercel cold-starts a second instance.

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
2. **`McpClient.minIntervalMs = 1100`** (`lib/mcp/connect.ts:91-96`, gate enforced at `lib/mcp/client.ts:148-153`) — proactive spacing between MCP tool calls because Bloomreach rate-limits at ~1 req/s/user. This is the single biggest contributor to per-investigation latency. The 60s response cache in `McpClient.callTool` is what makes it survivable.
3. **`AsyncLocalStorage<RequestStore>`** (`lib/mcp/auth.ts:3,47,86-104`) — per-request context for the encrypted-cookie auth store. Without it, Next's request-vs-response cookie split (a read after a set returns the OLD value) would corrupt the OAuth flow. This is the only true concurrency-safety primitive in the app.
4. **`runAgentLoop` budgets: `maxTurns = 8`, `maxToolCalls = 6`** (`lib/agents/base.ts:73`, `lib/agents/monitoring.ts:101`, `lib/agents/diagnostic.ts:62`) — bounded work on top of bounded time. The hard tool-call budget plus the forced-synthesis turn (omit `tools` so the model MUST emit JSON) is what guarantees a route doesn't burn its 300s on an unbounded ReAct loop.
5. **The route-level `ReadableStream`** (`app/api/agent/route.ts:131-141`, `app/api/agent/route.ts:169-265`, `app/api/briefing/route.ts:178-257`) — progressive streaming is what turns a 100-second agent run into a UI that's visibly working at second 2. The `controller.close()` in `finally` is the resource-lifecycle anchor.
6. **The in-process `Map`s** (`lib/state/insights.ts:4-6`, `lib/state/investigations.ts:11`, `lib/mcp/schema.ts:131`, `lib/mcp/client.ts:80`) — all "state" the app holds across requests lives here. They are correct for one warm instance; they are silently wrong across two. Vercel may serve two requests on two different instances, and the `Map` won't know.

## Honest about what this codebase doesn't exercise

These are the runtime mechanisms the topic spec lists that the repo simply does not contain. The audit (section 8) won't manufacture risks for them.

- **Worker threads, child processes, clustering.** Not present. Single-threaded by design. Every "concurrent" thing is a JS task on one event loop.
- **CPU-bound work.** The only computation the runtime does itself is JSON parse/stringify; everything heavy is offloaded to Anthropic or the MCP server. So there's no GC-pause story to tell, no thread-pool exhaustion, no `Atomics`/`SharedArrayBuffer`.
- **Locks, mutexes, semaphores, channels.** Not used and not needed for what's here — JS's run-to-completion semantics (see `03-event-loop-and-async-io.md`) handle the read-modify-write on the in-process `Map`s without explicit synchronization, *as long as the work is one warm instance*.
- **`AbortController` / cancellation.** Deliberately absent. The hook comment at `lib/hooks/useInvestigation.ts:32-36` explains why: cancelling on React StrictMode unmount aborted the stream and left the logs empty. The cost is named in section 7.
- **`SIGTERM` / `SIGKILL` handling.** Vercel kills the function on `maxDuration` or on cold-start eviction. The app doesn't install signal handlers — there's no graceful-shutdown story beyond what the platform does for us.
- **Streaming backpressure on the writer side.** The route enqueues bytes into `ReadableStream`; we never check `desiredSize` and we never wait. The amount of data per stream is tiny (NDJSON events, kilobytes total over a 100s run), so this is fine — but it's worth knowing the lever isn't pulled.
- **File-watching, fs.watch, chokidar.** Not present. The fs is read-only on Vercel and we don't try to watch anything.
- **Bull/BullMQ, Kafka, Redis Streams, any queue.** Not present. The "work queue" is the model's tool-call list, walked synchronously inside one route handler.

## Top 3 runtime risks (full ranking in section 8)

1. **Process-local state on serverless** — every `Map` in `lib/state/*` and the `cached` schema in `lib/mcp/schema.ts:131` assumes one process. Vercel can warm a second instance for the next request, and the user sees an empty feed. The route comment at `app/api/agent/route.ts:35` flags this explicitly ("the only source that survives Vercel's per-instance memory").
2. **No request cancellation** — closing the browser tab does not stop the route. The Anthropic + MCP calls keep running and keep billing until `maxDuration` or natural completion. Documented at `lib/hooks/useInvestigation.ts:32-36` as a deliberate React-StrictMode workaround.
3. **The 1.1s spacing gate is a single global serializer per process** — `McpClient.lastCallAt` is one number per `McpClient` instance, and one `McpClient` is built per `connectMcp` call inside a request. Two concurrent requests on the same warm instance each get their own `McpClient`, so the gate doesn't actually serialize across requests. The rate limit is per-user globally on Bloomreach's side, and the parsed-Retry-After path in `client.ts:122-132` is the actual safety net.

---

## See also

- `01-runtime-map.md` — the runtime topology in detail.
- `.aipe/study-system-design/00-overview.md` — the system-design map (components and trust boundaries) that this runtime guide sits underneath.
- `.aipe/study-distributed-systems/00-overview.md` — *not yet generated* — the place where multi-instance behavior, network failure between Node and providers, and serverless coordination would live.
- `.aipe/study-performance-engineering/00-overview.md` — *not yet generated* — the place to go for budgets, baselines, and where latency actually goes.

# Processes, Threads, and Tasks

**Industry name:** process / task model · **Type:** Industry standard

## Zoom out — where this concept lives

The whole repo runs inside one process. There are zero threads of the OS-level "second cook" kind. The "tasks" are JavaScript Promises and microtasks, scheduled by the V8 event loop.

```
  Zoom out — what's actually running

  ┌─ Browser tab ────────────────────────────────────────────────────────┐
  │  one main thread (React 19, fetch, NDJSON reader)                    │
  │  ★ also one process — but the browser owns its own model ★           │
  └────────────────┬─────────────────────────────────────────────────────┘
                   │
  ┌─ Vercel platform ──▼─────────────────────────────────────────────────┐
  │  function instances — opaque pool the app cannot observe             │
  └────────────────┬─────────────────────────────────────────────────────┘
                   │  one process per invocation
  ┌─ Node 20+ process ──▼────────────────────────────────────────────────┐
  │  ★ THIS CONCEPT LIVES HERE ★                                         │
  │  one V8 main thread                                                  │
  │  no child_process · no worker_threads · no cluster                   │
  │  tasks = Promises/microtasks on the event loop                       │
  └──────────────────────────────────────────────────────────────────────┘
```

If you grep the repo for `child_process`, `worker_threads`, `spawn(`, or `cluster`, you get zero hits in `lib/` and `app/`. The runtime is *deliberately* one process: the previous Olist SQL adapter used to run in a subprocess (for SQL-driver isolation, not for parallelism), and it was retired before this guide was written. The seam survives — `lib/data-source/index.ts` still has a `dispose: () => Promise<void>` hook on the factory result — but every live adapter today runs inside the caller's process.

## Structure pass

### Axes (one question, traced across the bands)

**Axis: who runs the JavaScript?**

```
  Browser    →  the browser's main thread (one)
  Vercel     →  doesn't run JS itself; spawns Node processes
  Node       →  V8's main thread (one)
```

The answer is "one thread" in both bands that execute code. The platform band between them is a scheduler, not an executor.

**Axis: how is concurrency expressed?**

```
  Browser    →  Promises + the DOM event loop
  Node       →  Promises + the libuv event loop
```

Same primitive in both bands: a Promise. The schedulers underneath are different (DOM vs libuv), but the surface the app codes against is identical. That's why `lib/streaming/ndjson.ts` is shared between browser callers (`useBriefingStream`, `useInvestigation`, `StreamingResponse`) and Node callers without modification — there's nothing thread-aware in it.

### Seams

The interesting seam is **the request boundary** between Vercel and Node. Above the seam, the platform decides whether to spawn a new process or reuse a warm one. Below the seam, the app sees one process and writes module-level state into it. The axis "is this state visible to the next request?" flips across the seam: above the seam, NO (platform sees each request as independent); below the seam, YES (module Maps survive between requests on the same warm instance).

That flip is what `04-shared-state-races-and-synchronization.md` is entirely about.

## How it works

### Move 1 — the mental model

You know how a `fetch()` returns a Promise that resolves later? That's a task. The event loop sees `await fetch(...)`, suspends the calling function, runs other work (microtasks, timers, more I/O), and when the network response comes in, it resumes your function. There's no second thread executing your code — there's one thread that PARKS your function and PICKS UP another.

```
  The single-thread task model — one execution, many parked functions

  time →
  ─────────────────────────────────────────────────────────────────

  request #1  ───►  await fetch ───parked───────────►  resume
                                  │
  request #2          ───►  await fetch ───parked──────►  resume
                                          │
  microtask                                ►•─ resolve cb
                                                       ▲
                                                  one thread,
                                                  picking up
                                                  whatever's ready
```

The mistake people make: assuming `await` means "wait" in a thread sense. It means "park this function, let the loop work on other things, resume when the awaited Promise settles." The function is paused; the thread isn't.

### Move 2 — the moving parts

#### One process per Vercel function invocation

When a request hits `/api/briefing`, Vercel either spawns a new Node process or hands the request to a warm one. The app doesn't choose. From inside the process, the only signal you have is: did your module-level state survive from a previous request? (Cold = no, warm = yes.)

```ts
// lib/state/insights.ts:14 — survives between requests on a warm instance
const state = new Map<string, SessionFeed>();
```

That `new Map(...)` runs ONCE per process. The `import` that pulls it in is cached. Two requests to a warm instance see the SAME Map object. This is what makes module-level Maps load-bearing for session memory — and what makes them a leak vector when they're not session-keyed (finding #1, `lib/mcp/schema.ts:138`).

The lifetime question becomes: how long is "warm"? Vercel doesn't publish a number. Empirically: minutes to tens of minutes of activity, then cold. Cold start means the process is killed and a new one starts; all module-level state is wiped. This is why the encrypted cookie store exists for production auth (`lib/mcp/auth.ts:86-104`) — `connect` and `callback` may hit different processes, so the only state both can see is the browser's cookie.

#### No threads, no workers, no children

Grepped, verified:

```
  $ grep -rn "child_process\|worker_threads\|spawn(\|fork(\|cluster" lib/ app/
  (zero hits in source code)
```

This isn't oversight. The hot path is I/O-bound: an agent loop spends 95%+ of its time awaiting Anthropic API responses and Bloomreach MCP responses. The event loop already handles that concurrency cleanly. Adding `worker_threads` would let the app run JavaScript in parallel on multiple cores — but there's almost no CPU work to parallelize. The only CPU costs are:

- JSON parse/stringify (small; bounded by truncation to 16K chars in `lib/agents/base-legacy.ts:32`)
- AES-256-GCM encrypt/decrypt of the auth cookie (microseconds; `lib/mcp/auth.ts:62-79`)
- The NDJSON encode/decode (string concatenation; trivial)

None of that justifies the complexity of a worker pool. The previous Olist subprocess was about adapter isolation (keep SQL driver crashes out of the main process), not parallelism — and when the adapter went away, the subprocess went with it.

#### Tasks: what's actually on the event loop

A task in JS-land is a Promise's resolution callback. A microtask is what `.then()` and `await` schedule. The event loop drains microtasks between every task. The app produces lots of both.

```
  One agent loop turn — what runs as what

  ─────────────────────────────────────────────────────────────
  TASK: stream controller's start(controller) function starts
    │
    ├─ MICROTASK: await anthropic.messages.create(...)
    │             ↳ parks the function until network I/O resolves
    │
    │  (event loop free; other requests' microtasks may run)
    │
    ├─ TASK: HTTP response arrives → resolve callback queued
    │
    ├─ MICROTASK: continuation resumes; tool_use blocks extracted
    │
    ├─ MICROTASK: await dataSource.callTool(...)
    │             ↳ parks again until MCP response resolves
    │
    │  (event loop free; sleep(minIntervalMs) may schedule a timer)
    │
    └─ TASK: timer fires → liveCall resumes → tool result returned
  ─────────────────────────────────────────────────────────────
```

The `~1 req/s` proactive spacing in `lib/data-source/bloomreach-data-source.ts:191-194` is a `setTimeout`-backed sleep:

```ts
// lib/data-source/bloomreach-data-source.ts:73-75, 191-194
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

private async liveCall(name: string, args: ...): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  // ...
}
```

That `await` parks the function for ~1.1s (the configured `minIntervalMs`). During those 1.1s, the event loop is FREE to run other requests' work. The function isn't blocking the thread; it's blocking ITSELF. This is the central trick of async I/O on a single thread — the difference between "the function is waiting" (fine) and "the thread is waiting" (catastrophic).

#### One per-request DataSource, not a singleton

```ts
// app/api/agent/route.ts:165-167, 179-182
let dsResult: Awaited<ReturnType<typeof makeDataSource>>;
try {
  dsResult = await makeDataSource(mode, sid);
} catch (e) { /* ... */ }
// ...
const dataSource = dsResult.dataSource;
```

Every request constructs its own `BloomreachDataSource`. The 60s response cache inside it (`bloomreach-data-source.ts:122, 144`) is therefore per-request, not shared across users. The `~1 req/s` spacing (`lastCallAt`) is also per-instance — which means concurrent requests on one warm instance can each fire one MCP call without waiting on each other, and the rate limit is enforced by Bloomreach (with parsed retries) rather than by our spacing.

The cost of per-request construction is small: `BloomreachDataSource` is just three numeric configs and an empty cache; the heavy OAuth/PKCE handshake happens once and the tokens persist via the cookie store.

The would-be alternative — a module-level `BloomreachDataSource` singleton — would share the 60s cache (faster repeats) but also share the per-call rate gate and force every concurrent request through it sequentially. Worse, the cache would leak across users like `cached` in `schema.ts` does. The per-request choice is the safer one.

### Move 3 — the principle

Single-process, single-threaded JavaScript runtimes solve concurrency by parking functions, not by spawning threads. The skill is recognizing what's "parked" (fine) vs what's "blocking the thread" (poisonous). Anything `await`-able is parked. Anything CPU-bound (a tight loop, a synchronous regex on a huge string, a `JSON.parse` of a 50MB blob) is blocking — and blocking on the event loop blocks every other request on the same process.

The repo stays safely parked because the hot path is I/O. The two places where it gets close to blocking are AES encryption of the auth cookie (microseconds, fine) and JSON.stringify of tool results before truncation (`lib/agents/base-legacy.ts:184` — bounded to 16K, fine). Neither is a real risk.

## Primary diagram

```
  The full picture — one process, many parked functions, one schedule

  ┌─ Node process (Vercel function instance) ────────────────────────────┐
  │                                                                      │
  │   ┌─ V8 main thread (the ONLY thread running JS) ───────────────┐   │
  │   │                                                              │   │
  │   │   request #1 ───► await ────parked───────► resume ───► done │   │
  │   │   request #2 ─────► await ───parked────► resume ───► done   │   │
  │   │   request #3 ──────► await ────parked──► resume ───► done   │   │
  │   │                                                              │   │
  │   │   microtask queue: settled Promise callbacks                 │   │
  │   │   macrotask queue: setTimeout fires, network I/O completions │   │
  │   │   (both drained by libuv, scheduled around each other)       │   │
  │   │                                                              │   │
  │   └──────────────────────────────────────────────────────────────┘   │
  │                                                                      │
  │   module-level state survives between requests on this instance      │
  │   instance dies when Vercel recycles it (timer or scale-down)        │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘

  CPU work would block the thread → every request stalls.
  I/O work parks one function → other requests' functions run.
  this app does only I/O work on the hot path. that's why it's fine.
```

## Elaborate

The Node single-thread model came from Ryan Dahl's 2009 idea: most server work is I/O-bound, so let one thread juggle many connections via non-blocking I/O instead of paying a thread-per-connection cost. The model wins when the hot path is I/O and loses when it's CPU. Twenty years later it's the dominant shape for I/O-heavy services, and Vercel built their entire serverless runtime around it.

The parts of "process / thread / task" that DON'T apply to this codebase are nontrivial. There's no work-stealing scheduler to tune. There's no thread pool to size. There's no lock to hold. The bugs you watch for in this kind of system are at a different layer: cross-request state bleed (module-level Maps), async-context loss (ALS not propagated through some library), unhandled promise rejections (which crash the process under Node's default handler). The Olist subprocess that used to live in this repo was the closest the codebase came to multi-process design; with it gone, the runtime is simpler and the failure modes are narrower.

## Interview defense

> Q: "How many threads does this app use?"

One per process. Vercel spawns one Node process per function invocation; the JavaScript runs on V8's single main thread. There are no `worker_threads`, no `child_process`, no `cluster`. The previous build had an Olist SQL adapter in a subprocess for driver isolation; it was retired, so the runtime is one process today.

> Q: "How do you handle concurrent requests then?"

The event loop. Each request's handler is an async function; when it `await`s a network I/O, the function parks and the loop runs other requests' work. `AsyncLocalStorage` (`lib/mcp/auth.ts:47`) gives each request its own scoped context so they don't see each other's auth state. Module-level Maps in `lib/state/insights.ts` are session-keyed so the same instance can serve multiple users.

> Q: "What happens if something blocks the event loop?"

Every request on that process stalls. The repo stays I/O-bound on the hot path on purpose — the only CPU work is JSON parse/stringify (bounded by 16K truncation in `lib/agents/base-legacy.ts:32`) and AES encrypt/decrypt (microseconds in `lib/mcp/auth.ts:62-79`). If we needed real CPU work we'd reach for `worker_threads`, not extra processes — the abstraction is lighter and the message-passing is built in.

## See also

- `03-event-loop-and-async-io.md` — what the event loop actually does between awaits.
- `04-shared-state-races-and-synchronization.md` — how state stays isolated without locks.
- `07-backpressure-bounded-work-and-cancellation.md` — what bounds the parked functions from accumulating forever.

# 03 — Event loop and async I/O

**Industry name(s):** Node.js event loop · libuv reactor · async/await scheduling · microtasks/macrotasks
**Type:** Industry standard (Node.js / V8)

> **Verdict (Phase 2): there are now TWO event loops to reason about — the parent's and the Olist child's.** In the parent, the agent loop's `await` chain is one long sequence of event-loop turns; the most load-bearing pause is still `await new Promise(r => setTimeout(r, 1100 - elapsed))` inside `McpClient.liveCall` (live-bloomreach mode). In the child, the loop processes one JSON-RPC frame at a time off stdin, runs the requested tool (a synchronous `better-sqlite3` call), writes the result frame back on stdout, idles until the next frame. The child's sync SQLite calls would freeze its loop in a multi-tenant server — they're safe here because the child is single-flight. The model still spends most of its wall clock waiting on I/O (Anthropic HTTPS, MCP HTTPS or stdio), and that wait is what lets the route stream progress. There's still no blocking-loop hazard in the parent's hot path *today*, because every parent-side CPU operation is JSON-shape — but it's a contract the next contributor can break with a single accidentally synchronous call.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** The event loop is the heartbeat of any Node process. It's not a "place" — it's the algorithm libuv runs that picks the next task, runs it until it returns or `await`s, then picks the next one. Phase 2 added a SECOND Node process (the Olist child), which means a SECOND event loop running in parallel with the parent's. Everything in `runAgentLoop` is one task on the parent loop. Every `await` inside it is a yield. The route handler's `ReadableStream.start` callback is another task on the parent loop. The browser-side `reader.read()` callback is yet another (in browser V8). The child's task per inbound frame is yet another (in its own loop). They never block each other within a single process; across processes they communicate by the OS scheduling stdio reads/writes.

```
  Where the event loop sits

  ┌─ Browser V8 ────────────────────────────┐
  │  browser event loop (separate)          │
  │  reader.read() awaits → loop yields     │
  └────────────────────│────────────────────┘
                       │  HTTPS
  ┌─ Vercel function (Node 20 · libuv) ─────▼─────┐  ← we are here
  │                                                │
  │  ★ NODE EVENT LOOP ★                          │
  │   - picks next task                            │
  │   - runs until task awaits/returns             │
  │   - drains microtasks before next macrotask    │
  │   - waits on I/O (epoll) when idle             │
  │                                                │
  │  every route handler, every agent run,         │
  │  every setTimeout is a task on THIS loop       │
  └────────────────────│───────────────────────────┘
                       │  HTTPS
  ┌─ Providers ────────▼────────────────────────┐
  │  their own loops; not our problem            │
  └─────────────────────────────────────────────┘
```

**Zoom in — the concept.** The event loop is a scheduler. Its only contract: *one JS task runs at a time, and a running task cannot be interrupted by another task.* A task ends when it `return`s or `await`s. Between tasks, the loop drains the microtask queue (resolved promises), then picks the next macrotask (a timer that fired, an I/O callback that's ready, the next iteration of `setImmediate`, the next request's start callback). Knowing the order is how you reason about latency in this app.

---

## Structure pass

**Layers.** Three nested:
1. **Macrotask queue** — timers, I/O callbacks, the request start callback.
2. **Microtask queue** — promise resumptions, `.then` callbacks, drained between every macrotask.
3. **The currently-running task** — the JS code holding the thread right now.

**Axis traced: *when does control return to the loop?***

```
  "When does control return to the loop?" — across layers

  ┌─ user code, currently executing ──────────┐
  │  NOT until                                 │   → run-to-completion
  │    `return` (task ends) or                 │
  │    `await` (task suspends)                 │
  └────────────────────┬───────────────────────┘
                       │
  ┌─ microtask queue, after task suspends ────▼┐
  │  ALL drained before the next macrotask     │   → starvation hazard:
  │   .then chains, await resumptions          │     a microtask that
  │                                              │   queues another microtask
  │                                              │   delays I/O forever
  └────────────────────┬───────────────────────┘
                       │
  ┌─ macrotask queue, when microtasks empty ──▼┐
  │  ONE picked per loop turn                  │   → request handlers,
  │   timers, I/O callbacks, setImmediate      │     timers, fs callbacks
  └────────────────────────────────────────────┘

  control returns at the boundaries — but ONLY at the boundaries.
  this is what "run-to-completion" actually means.
```

**Seams.** The big one: **the `await` boundary inside any async function.** That's where the running task ends and the loop gets to make a decision. The agent loop has hundreds of these per run; the route handler has dozens; the spacing gate has exactly one per MCP call. Each one is a chance for another request's work to land.

---

## How it works

### Move 1 — the mental model

You've used `await fetch(...)`. You know it doesn't "block the thread" — it suspends your function and lets other code run. The event loop is the bookkeeper that decides what runs next. It works in turns; each turn is a tight cycle: drain microtasks, pick one macrotask, run it until it awaits or returns, repeat. The hot pattern in this repo is exactly that: `await fetch → microtask drains → some I/O callback fires → eventually the fetch's promise resolves → our function resumes.`

```
  One loop turn — the kernel

  ┌────────────────────────────────────────────────────────┐
  │  ┌─ drain microtask queue ─┐                            │
  │  │  resolve all .then's,    │ ← repeats until empty     │
  │  │  await resumptions      │                            │
  │  └────────────┬─────────────┘                            │
  │               │                                          │
  │  ┌─ pick ONE macrotask ────▼┐                            │
  │  │  timer fired?            │ ← run its callback        │
  │  │  I/O callback ready?     │   until it awaits/returns │
  │  │  next request handler?   │                            │
  │  └──────────────────────────┘                            │
  │                                                          │
  │  back to the top                                         │
  └────────────────────────────────────────────────────────┘

  if no macrotask is ready, libuv blocks on epoll/kqueue until I/O lands.
  there is NO busy spin — idle Node is genuinely idle.
```

### Move 2 — the moving parts

#### 1) The agent loop as a long `await` chain

`runAgentLoop` is one async function. Each `for` iteration `await`s the Anthropic call, then `await`s each MCP tool call in turn, then pushes results back into `messages[]`. It doesn't *do* anything between awaits — it's a thin coordinator. Most of the wall clock is the model thinking + the MCP server responding + the spacing gate sleeping.

```
  runAgentLoop — wall clock vs CPU time, one turn

  CPU time:   |█|                                  |█|     |█|     |█|
  wall time:  |█|━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━|█|━━━━|█|━━━━|█|
              ▲ ▲                                  ▲ ▲    ▲ ▲    ▲
              │ │                                  │ │    │ │    │
              │ └─ await anthropic.messages.create │ └─ await mcp.callTool (gate + HTTP)
              │    ~2-15s (mostly remote)          │    ~1.1s gate + ~0.5-3s HTTP
              │                                    │
              └─ build params, push to messages    └─ build tool_result, push to messages

  the `█` are tiny slices of CPU; the `━` are I/O waits the loop fills
  with other tasks (other requests' work).
```

What breaks if `runAgentLoop` ever did real CPU work between awaits: every other in-flight request on the warm instance freezes for that duration. Today the only CPU work is `JSON.stringify(messages)` and `truncate(...)` — both microsecond-scale on the message sizes we hand around.

#### 2) Microtask vs macrotask — what queues where

`await fetch(...)` → fetch sets up an HTTP request and returns a promise. When the response is ready, fetch resolves the promise. The resolution queues a *microtask* (your `.then`, or the continuation after `await`). Microtasks drain before the next macrotask runs.

`await new Promise(r => setTimeout(r, 1100))` → `setTimeout` queues a *macrotask*. When 1100ms elapses, the timer fires; its callback (`r`) runs, resolves the inner promise, which queues a microtask (your continuation after the outer `await`).

```
  Microtask vs macrotask in the spacing gate

  call site (in McpClient.liveCall):
    if (elapsed < this.minIntervalMs) {
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
    }

  what happens, by queue:

  t=0     macrotask: setTimeout enqueued with delay 1100ms
          (current task suspends at the await)
  t=0+    microtask queue: empty
  t=0..1100ms  loop is free to run other macrotasks
          (other requests' work, other timers)
  t=1100  macrotask: timer's callback runs (`r()`)
          → resolves inner promise
          → microtask queued: liveCall's continuation
  t=1100+ microtasks drained: liveCall resumes,
          calls transport.callTool(...) — another fetch — another await
```

What breaks if you replace the `await setTimeout` with a busy-wait `while (Date.now() < target) {}`: that's a synchronous loop with no `await` in it. The event loop never gets a turn until it ends. Every other request's progress freezes for the full spacing interval, multiplied by every spacing call in the run. A 6-call investigation freezes everything for ~7 seconds. That's why the right primitive is `await new Promise(r => setTimeout(r, ...))`.

#### 3) The `ReadableStream.start` callback as a long-running task

When the route returns `new Response(new ReadableStream({ async start(controller) {...} }))`, Node wires it up so `start` runs as a macrotask. Inside `start`, every `controller.enqueue(...)` writes bytes into the response stream's internal buffer; the platform delivers them to the client as chunks. Every `await` inside `start` yields the loop the same as anywhere else.

```
  ReadableStream.start — what one streaming response looks like on the loop

  request lands
      │
      ▼
  GET(req)  ← macrotask
      │
      ▼ returns Response(new ReadableStream({...}))
  Node calls start(controller)  ← macrotask
      │
      ▼ inside start:
      send(event1)            ← controller.enqueue (sync, fast)
      await runAgentLoop(...)  ← yields N times
        → each yield = chance for client to receive what's been enqueued
        → each yield = chance for other requests' tasks to run
      send(eventLast)
      controller.close()      ← signals end-of-stream to the platform
      │
      ▼ Node serializes the final chunks, closes the HTTP body
```

What breaks if `start` never awaited (impossible here, but hypothetical): the runtime would buffer every enqueued byte and only flush after `start` returned. The "progressive streaming" property — the whole point of the design — depends on yielding the loop between events. The 180ms `await setTimeout` between replayed cached events in `app/api/agent/route.ts:135` exists for exactly this reason: it paces the reveal so the UI can show progress.

#### 4) Asynchronous I/O — fetch, HTTPS, and `StreamableHTTPClientTransport`

The MCP transport (`@modelcontextprotocol/sdk/client/streamableHttp.js`) wraps Node's `fetch`. Every `transport.callTool(...)` is an HTTPS POST. `fetch` is non-blocking — it returns immediately with a promise; the actual network I/O is handled by libuv's network stack. When response bytes arrive, the kernel's `epoll`/`kqueue` notifies libuv, libuv resolves the promise, your `await` resumes on the next microtask drain.

```
  An HTTP call's path through the loop

  await fetch(url)              ← your task suspends here
       │
       ▼
  fetch enqueues a network op    ← non-blocking, returns promise
       │
       ▼
  libuv hands off to OS network  ← epoll waits for the FD to become readable
       │
   (the loop runs other tasks while we wait — this is where another request
    gets to do its work)
       │
       ▼ when response bytes arrive
  libuv's I/O callback runs       ← macrotask
       │
       ▼ resolves the promise
  microtask: your continuation     ← your `await` resumes
       │
       ▼
  you now have the Response
```

What breaks: nothing, in practice. The only ways async I/O goes wrong here are at the HTTP layer (timeouts, 429s — handled in `client.ts:122-132`) or at the route-budget layer (a slow Anthropic call eats into the 300s wall — handled by `maxToolCalls`/`maxRetries`/`retryCeilingMs`).

#### 4.5) The stdio pipe to the Olist child — JSON-RPC framing on TWO event loops (Phase 2)

When the parent calls `OlistDataSource.callTool(...)`, the MCP SDK's `Client` serializes a JSON-RPC 2.0 request frame, writes it to the child's stdin via `StdioClientTransport`, and awaits a Promise that resolves when a matching response frame arrives on the child's stdout. The frame format is line-oriented JSON over the pipe (one frame per line, no length-prefix). The parent's event loop yields on the `await client.callTool(...)`; libuv watches the pipe FD for incoming bytes; when the child writes a response, libuv's I/O callback fires, the SDK parses the frame, matches it to the pending request by `id`, and resolves the Promise.

```
  parent ↔ child: one tool call across two event loops

  PARENT event loop:                            CHILD event loop:
    await client.callTool(name, args, opts)
      └─ SDK encodes JSON-RPC request frame
         and writes it to child's stdin pipe
      └─ Promise pending; parent loop yields    ← idle, polling stdin
                                                ← read() returns: frame received!
                                                ← decode frame
                                                ← dispatch to tool handler (3 of them):
                                                    get_metric_timeseries / get_segments /
                                                    get_anomaly_context
                                                ← run better-sqlite3 SELECT (SYNC, <10ms)
                                                ← child loop is FROZEN during the query
                                                  (safe — single-flight; nobody else is
                                                  waiting on it)
                                                ← encode JSON-RPC response frame
                                                ← write to stdout pipe
    libuv I/O callback: stdout has new bytes
      └─ SDK parses response frame
      └─ resolves the awaited Promise
      └─ continuation runs as microtask
    callTool returns { result, durationMs, fromCache: false }

  the seam is the pipe; the contract is "one request → one response,
  matched by JSON-RPC id; ordering preserved by single-flight."
```

What breaks if the child stops responding (frozen, crashed, in a SQLite deadlock): the parent's `await client.callTool(...)` hangs forever — there's no built-in timeout in the SDK. That's exactly what the `composeSignals` + `AbortSignal.timeout(this.toolTimeoutMs)` pattern at `lib/data-source/olist-data-source.ts:151, 172` solves: each call is wrapped in a 30s timeout via `AbortSignal.timeout(30_000)`, ORed with whatever the caller passed. If 30s elapses, the SDK gets an abort, the awaited Promise rejects, the OlistToolError propagates up. The child stays alive (we didn't kill it) — the next `callTool` will try again.

What breaks if the child writes non-JSON bytes to stdout: the SDK's frame parser throws on the bad chunk and the awaited Promise rejects with a parse error. That's why `mcp-server-olist/src/index.ts` writes logs to **stderr** (`process.stderr.write('[mcp-server-olist] ready (stdio)\n')`) — stdout is reserved for protocol frames.

#### 4.6) `better-sqlite3` as a synchronous library — safe in the child, unsafe in the parent

`better-sqlite3` is the bottom layer of the Olist child's stack and it's *synchronous on purpose*: `db.prepare(sql).all(args)` returns rows directly, no Promise. This blocks the child's event loop for the query duration. In the child it's fine because:

1. The child runs one tool call at a time (SDK transport queues frames serially).
2. The queries are point lookups + small aggregates on a seeded ~1MB SQLite file — typically sub-millisecond, never more than ~10ms.
3. No other concurrent work needs the loop while the query runs.

If the same `better-sqlite3` handle were used in the parent (a Next.js route reaching directly into SQLite), it would freeze EVERY concurrent request on the warm instance for the query duration. That's the exact failure mode this concept covers — and it's the structural reason the SQLite store lives in a subprocess, not in the parent. The subprocess boundary turns "sync I/O blocks the loop" from a hazard into a no-op.

#### 5) The two-write protocol on Next's `cookies()` — and why the event loop forced an ALS solution

This is a subtle one worth knowing because it's documented inline at `lib/mcp/auth.ts:41-47`. Next's `cookies()` API returns a request-scoped store, but reads return the *original* request cookie, while writes go to the *response* cookie. Inside one request, if you `set` then `get`, you get the OLD value. The MCP SDK's `OAuthClientProvider` reads and writes synchronously many times during one connect. Without ALS, every read would see stale data; with ALS, all the reads/writes hit an in-memory `Store` that's seeded once at the start of the request and flushed once at the end.

```
  Why the event loop's "concurrent requests on one loop" forced this

  ┌─ request A's handler ─┐    ┌─ request B's handler ─┐
  │  set cookie X = 1     │    │  set cookie X = 2     │
  │  get cookie X → ???   │    │  get cookie X → ???   │
  └───────────┬───────────┘    └───────────┬───────────┘
              │                            │
              └─────── one event loop ─────┘
                      shared module scope

  WITHOUT ALS:
    a module-level `let store: Store` is shared.
    A sets store.X = 1; A awaits; B runs, sets store.X = 2;
    A resumes, reads store.X → sees B's value. WRONG.

  WITH ALS:
    AsyncLocalStorage.run(ctx, fn) makes `requestStore.getStore()`
    return ctx ONLY inside fn's async context. A's store and B's
    store are different objects. No interleaving danger.
```

This is the *only* place in the repo where the event-loop concurrency model would have caused a real bug without an explicit fix. Everywhere else, run-to-completion happens to give the right answer.

### Move 3 — the principle

**Async/await isn't free concurrency — it's cooperative concurrency.** You get a turn of the loop at every `await` and nowhere else. Your code is safe from interleaving inside a synchronous block; it's exposed to interleaving across `await`s. Most of the time the exposure doesn't matter, because the shared state isn't actually shared (each request has its own locals). When it does matter — like the cookie store — you reach for `AsyncLocalStorage` to scope the shared state per task. That's the kernel: the loop runs cooperatively, you fence shared state with ALS when the cooperation needs help.

---

## Primary diagram

The full event-loop picture for one agent run, with the yields and the queues:

```
  One agent run, one event loop — the full picture

  ┌─ event loop ───────────────────────────────────────────────────────────┐
  │                                                                        │
  │   ┌─ macrotask: GET(req) ─────────────────────────────────────────┐    │
  │   │  build response, return ReadableStream                        │    │
  │   └────────────────────────────┬─────────────────────────────────┘    │
  │                                │ (Node calls start later)              │
  │                                ▼                                       │
  │   ┌─ macrotask: ReadableStream.start(controller) ──────────────────┐   │
  │   │                                                                 │   │
  │   │   send({type:'reasoning_step', ...}) ← controller.enqueue (sync)│   │
  │   │   await bootstrapSchema(mcp)                                    │   │
  │   │       │                                                         │   │
  │   │       ▼  yields N times (4 sequential MCP calls × 1.1s gate)    │   │
  │   │   await runAgentLoop({ ... })                                   │   │
  │   │       │                                                         │   │
  │   │       ▼  yields per turn:                                       │   │
  │   │         await anthropic.messages.create()  ← yield ①            │   │
  │   │         for tool of toolUses:                                   │   │
  │   │           await mcp.callTool(...)          ← yield ②            │   │
  │   │             → await setTimeout(1100-el)    ← yield (timer)      │   │
  │   │             → await transport.callTool(...)← yield (HTTP)       │   │
  │   │         (push results, next turn)                               │   │
  │   │                                                                 │   │
  │   │   send({type:'done'})                                            │   │
  │   │   controller.close()  in finally                                 │   │
  │   └─────────────────────────────────────────────────────────────────┘   │
  │                                                                        │
  │   between EVERY yield: microtask drain, then next macrotask.            │
  │   while we wait on I/O: another request's GET can run.                  │
  │                                                                        │
  └────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** Every `await` in the agent stack is a yield point; the highest-leverage ones:

- `McpClient.liveCall` (`lib/mcp/client.ts:148-163`) — the spacing-gate sleep is the single most frequent `await setTimeout` in a run.
- `runAgentLoop` (`lib/agents/base.ts:85-172`) — each turn `await`s Anthropic, then each tool `await`s MCP.
- The replay-pace `setTimeout(180)` (`app/api/agent/route.ts:135`) — explicitly paces NDJSON events to give the UI time to render between them.
- `withAuthCookies` (`lib/mcp/auth.ts:86-104`) — the request-scoped ALS wrapper that keeps cookie state coherent across yields.

**Code side by side.**

```
  lib/mcp/client.ts (lines 148-163)

  private async liveCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    const elapsed = Date.now() - this.lastCallAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
           │                          │
           │                          └─ a MACROTASK (timer). When it fires,
           │                             the inner promise resolves.
           └─ THIS await suspends liveCall. Microtask drain happens
              when the timer's macrotask completes; liveCall resumes
              as a microtask after that. Total: ~1100ms of wall clock,
              ~0ms of CPU on our thread.
    }
    try {
      const result = await this.transport.callTool(name, args);  ← another await; this is the HTTP fetch
      this.lastCallAt = Date.now();
      return result;
    } catch (err) {
      this.lastCallAt = Date.now();   ← updated even on failure so the gate still applies
      throw new McpToolError(name, errorDetail(err), { cause: err });
    }
  }
```

```
  app/api/agent/route.ts (lines 131-141, cached-replay path)

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const e of events) {
        controller.enqueue(encoder.encode(encodeEvent(e)));   ← SYNC; just buffers bytes
        await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));  ← yield 180ms per event
             │
             └─ This is deliberate pacing. Without the await, all
                100+ events enqueue in one synchronous burst and the
                client gets the whole snapshot at once — the demo
                loses its "feels alive" property. The yield lets
                Node flush bytes to the wire AND lets the client
                actually render between events.
      }
      controller.close();
    },
  });
```

```
  lib/mcp/auth.ts (lines 86-104) — the ALS wrapper

  export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
    if (process.env.NODE_ENV !== 'production') return fn();
    const { cookies } = await import('next/headers');
    const raw = (await cookies()).get(AUTH_COOKIE)?.value;
    const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };
    const result = await requestStore.run(ctx, fn);
                              │
                              └─ ALS magic: every `requestStore.getStore()`
                                 inside `fn` (and any async work it spawns)
                                 returns `ctx`. Other concurrent requests
                                 running on the same loop get their OWN ctx.
                                 This is the ONE place the event loop's
                                 concurrent-requests-share-state property
                                 needed an explicit fix.
    if (ctx.dirty) {
      (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), { ... });
    }
    return result;
  }
```

---

## Elaborate

The Node event loop has six phases (timers, pending callbacks, idle/prepare, poll, check, close callbacks), but for almost all application reasoning the binary picture — "macrotask vs microtask, with microtasks drained between" — is enough. The two phases that occasionally bite are:

- **`process.nextTick`** drains BEFORE microtasks. The repo doesn't use it.
- **`setImmediate`** fires AFTER I/O callbacks. The repo doesn't use it. `setTimeout(fn, 0)` is what you'd reach for if you wanted "run after this turn ends," and even that isn't in the repo.

Worth reading next: the Node docs "Event Loop, Timers, and process.nextTick" page, and the `AsyncLocalStorage` performance notes — Node 20 made it ~10x cheaper than Node 14, which is why it's reasonable to use in the auth hot path here.

---

## Interview defense

**Q: Walk me through one agent turn from the loop's perspective.**
A: The agent loop is one async task on the event loop. At the top of a turn, we call `anthropic.messages.create(...)` — that's an HTTP fetch; we `await`, the task suspends, the loop is free to run other tasks. When Anthropic responds, the loop picks up the I/O callback, resolves the promise, our continuation runs as a microtask. We pull tool_use blocks out of the response. For each tool_use, we call `mcp.callTool(...)`, which goes through `liveCall`. `liveCall` first awaits a `setTimeout` to enforce the 1.1s spacing gate, then awaits the HTTP fetch to the MCP server. Each of those is a yield. Total: one Anthropic await, then N (gate + HTTP) awaits per tool call, then we push results back and start the next turn. Most of the wall clock is waiting; almost none is our CPU.

```
  one turn, sketched

  ─── our CPU ──── await anthropic ───── our CPU ─── await mcp (gate+http) ─── our CPU ───
   build params      ~2-15s              extract     ~1.1s + ~0.5-3s            push result
```

**Q: Why is `await new Promise(r => setTimeout(r, 1100))` the right primitive for the spacing gate, and what's the wrong one?**
A: `await setTimeout(...)` schedules a macrotask and yields the loop — other tasks get to run during the 1.1s. The wrong primitive is a busy-wait (`while (Date.now() < target) {}`) — that's a synchronous loop with no `await` in it. Run-to-completion means no other task gets the loop until it ends. So a busy-wait freezes every other concurrent request for the full interval, multiplied by every gate sleep in the run. The `setTimeout` keeps the gate pacing-effective (1.1s before the next HTTP call) without freezing the process.

---

---

## See also

- `02-processes-threads-and-tasks.md` — what "task" means at this level (every async function call).
- `04-shared-state-races-and-synchronization.md` — why the `Map`s are safe without locks (run-to-completion) and why `AsyncLocalStorage` was needed where they weren't.
- `07-backpressure-bounded-work-and-cancellation.md` — `maxDuration = 300` is the parent's hard wall; `AbortSignal.timeout(30_000)` is the subprocess per-call wall.

---

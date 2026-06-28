# Processes, threads, and tasks

**Industry name:** Node.js single-threaded execution model · **Type:** Language-agnostic primitive (Node implementation)

## Zoom out, then zoom in

The honest answer first: **this server has one process, one main thread, and a fan of async tasks scheduled by the event loop.** No subprocesses. No worker threads. No cluster. That's the whole story.

```
  Zoom out — what "concurrent" actually means here

  ┌─ UI (browser) ───────────────────────────────────────┐
  │  React 19 main thread + NDJSON reader microtasks     │
  └────────────────────────┬─────────────────────────────┘
                           │  HTTPS
  ┌─ Server runtime ★ THIS FILE ★ ──────────────────────┐
  │  ONE Node 20 process                                 │
  │  ONE main thread (the V8 + libuv event loop)         │
  │  N async tasks (Promises, timers, I/O callbacks)     │
  │  ZERO child_process / worker_threads / cluster       │
  └────────────────────────┬─────────────────────────────┘
                           │  HTTPS
  ┌─ Providers ─────────────▼────────────────────────────┐
  │  Anthropic / Bloomreach — their own processes        │
  │  (not ours; we wait on them via fetch)               │
  └──────────────────────────────────────────────────────┘
```

Now zoom in. "Concurrency" inside band 2 is the event loop interleaving I/O-bound tasks on one thread. There is no parallelism on this server. When two requests appear to run "at the same time," they're sharing the same thread by yielding at every `await`.

## Structure pass

**Axis: control — who decides what runs next?**

```
  Three altitudes, one question (who decides?)

  ┌─ OS / Vercel ──────────────────────────────────────┐
  │  the kernel + Vercel scheduler decide               │  → PLATFORM decides
  │  when a new instance spins up                       │     (we have no say)
  └────────────────────┬───────────────────────────────┘
                       │
  ┌─ Node event loop ─▼────────────────────────────────┐
  │  libuv decides which I/O callback runs next         │  → RUNTIME decides
  │  V8 decides which microtask drains next             │     (we await; it picks)
  └────────────────────┬───────────────────────────────┘
                       │
  ┌─ Application ─────▼────────────────────────────────┐
  │  our `await`s decide WHERE we yield                 │  → CODE decides where
  │  (every await is a permission slip to swap tasks)   │     to yield, runtime
  │                                                     │     decides who runs next
  └────────────────────────────────────────────────────┘
```

**Seam where control flips:** every `await`. Before the await, application code owns the thread; at the await, control returns to the event loop, which can pick a different pending task — including another request's continuation.

**That's the whole skeleton.** Two requests racing on a Map are two suspended continuations the event loop interleaves at `await` boundaries. Everything in `04-shared-state-races-and-synchronization.md` hangs off this seam.

## How it works

### Move 1 — the mental model

You know how `fetch()` returns a Promise and your code continues only after `await`? Same shape, scaled up: every async operation in this server is a Promise the event loop holds; when its underlying I/O resolves, the event loop puts the continuation in a microtask queue to run next. There is no second thread to "also" run things. There's one thread that runs whichever continuation is at the front of the queue.

```
  Pattern — the single-threaded interleaving

  thread (one)
   ├─ tick 1: request A enters handler
   │           runs sync code, hits `await fetch(...)`
   │           yields
   ├─ tick 2: request B enters handler         ← could run NOW
   │           runs sync code, hits `await ds.callTool(...)`
   │           yields
   ├─ tick 3: A's fetch resolves
   │           microtask: A's continuation drains
   │           runs sync code, hits next await, yields
   ├─ tick 4: B's callTool resolves
   │           microtask: B's continuation drains
   │           ...
   ▼
```

Every horizontal line is the same thread. The interleaving is cooperative — A and B agreed to yield at their awaits, and the runtime picked the order they resume in.

### Move 2 — the moving parts

#### Move 2.1 — what's a "process" here

The server's process is the Node binary Vercel spawns on cold start. It has:

  → a heap (V8-managed) — for module state, the `Map`s, every Promise, every closure.
  → a stack (per active synchronous call frame) — small; async work lives on the heap.
  → file descriptors (for incoming HTTP, outgoing `fetch` sockets).
  → an event loop (libuv).

```
  ┌─ Node process (Vercel instance) ────────────────────────┐
  │                                                          │
  │  heap                                                    │
  │  ├─ const state = new Map()    [lib/state/insights.ts]   │
  │  ├─ const mem = new Map()      [lib/state/investig.ts]   │
  │  ├─ pending Promises                                     │
  │  └─ closures captured by setTimeout, AbortSignal, etc.   │
  │                                                          │
  │  stack (whichever sync frame is running right now)       │
  │  └─ at most one continuation at a time                   │
  │                                                          │
  │  libuv event loop                                        │
  │  ├─ timer queue (setTimeout)                             │
  │  ├─ I/O callback queue (fetch resolved, etc.)            │
  │  └─ microtask queue (Promise.then continuations)         │
  └──────────────────────────────────────────────────────────┘
```

There is no `process.fork`, `child_process.spawn`, or `new Worker(…)` in `lib/` or `app/`. Verified by grep: zero hits. (An olist subprocess existed briefly in Phase 2 and was removed in PR #8.)

#### Move 2.2 — what's a "thread" here

There is one. V8's main thread runs all your JavaScript. libuv has a small internal thread pool for some I/O (DNS resolution, file I/O), but your application code never sees those threads — by the time a callback fires, you're back on the main thread.

If you wanted parallelism (true multi-core), you'd reach for `worker_threads`. The codebase does not — the agent loop is I/O-bound waiting on Anthropic and Bloomreach, so a worker thread would just be another thing waiting. CPU on the server is not the bottleneck; round-trip latency is.

#### Move 2.3 — what's a "task" here

Every Promise continuation is a task. Concrete examples from the codebase:

  → `await this.transport.callTool(name, args, { signal })` at `lib/data-source/bloomreach-data-source.ts:196` — yields the thread until the MCP server responds (or the 30s timeout fires).
  → `await reader.read()` at `lib/streaming/ndjson.ts:37` — yields until the next chunk arrives on the response body.
  → `await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed))` at `lib/data-source/bloomreach-data-source.ts:193` — the spacing gate yields for up to 1.1s.
  → `await sleep(waitMs)` at `lib/data-source/bloomreach-data-source.ts:172` — the retry ladder yields up to 20s.

Every one of these is a permission slip. While we're awaiting Bloomreach, the event loop runs other things — another request's handler, another timer callback, another NDJSON chunk arriving on a different request's response.

#### Move 2.4 — what "concurrent" actually means on this server

Vercel can route two requests to the same warm instance at the same time. Both handlers start, both hit their first `await`, both yield. Then the event loop interleaves their continuations as I/O lands. The illusion is "they ran in parallel"; the reality is "they took turns on one thread, each yielding at every await."

```
  Two concurrent requests, one thread — execution trace

  time   thread runs:                          state
  ────   ────────────────────────────────      ──────────────────────────────
  t=0    A handler starts                       state Map = { ... }
  t=1    A: bootstrap() awaits                  (A yields)
  t=2    B handler starts                       state Map = { ... }
  t=3    B: bootstrap() awaits                  (B yields)
  t=4    libuv fires A's bootstrap response
         A: putInsights(sidA, ...) — sync       state.get(sidA).insights.clear()
                                                state.get(sidA).insights.set(...)
  t=5    A: send({type:'insight'}) — sync       (controller.enqueue)
  t=6    A: await next ... yields
  t=7    libuv fires B's bootstrap response
         B: putInsights(sidB, ...) — sync       state.get(sidB).insights.clear()
         ...
```

A and B never collide on the *same* `sessionId` (different cookies → different sub-maps). They do share the outer `Map` reference; the outer map is never `.clear()`ed, only individual sub-maps are (`lib/state/insights.ts:67-71`). That's the load-bearing safety — see the next file for the race analysis.

#### Move 2.5 — what BREAKS if you treat this as multi-threaded

If you assume two threads, you reach for locks. There are no locks in this codebase — and there don't need to be, because between any two lines of synchronous code in one request, no other request can execute. The atomic unit on this server is "the code between two `await`s."

What breaks if you forget this:

  → You read a value, await, write a derived value back — and between read and write, another request mutated the same key. (The check-then-act race, classic.)
  → You assume `Map.set` followed by `Map.get` is paired — and it is, sync — but if anything `await`s between them, another request can interleave.

The repo avoids this by keeping `putInsights` (`lib/state/insights.ts:57-71`) entirely synchronous: `clear()` then `set()` in a tight loop, no await. The whole function runs as one event-loop tick.

### Move 3 — the principle

A single-threaded async runtime is **not** "slower than multi-threaded" — for I/O-bound work it's the same throughput with simpler reasoning. The tradeoff you accept is that long sync work blocks *everything*. The tradeoff you escape is locks. Pick the right side of that line: every `await` is your scheduling point, every sync block is your latency floor for the whole instance.

## Primary diagram

```
  Processes / threads / tasks in blooming insights

  ┌─ ONE Node process (per warm Vercel instance) ─────────────────┐
  │                                                                │
  │  ┌─ ONE main thread ────────────────────────────────────────┐  │
  │  │                                                          │  │
  │  │  request A continuations ──┐                             │  │
  │  │  request B continuations ──┼──► event loop picks one      │  │
  │  │  request C continuations ──┘    at each tick              │  │
  │  │  timer callbacks         ──┘                             │  │
  │  │  I/O callbacks           ──┘                             │  │
  │  │                                                          │  │
  │  │  yield points (every await):                             │  │
  │  │   ─ fetch() to Anthropic                                  │  │
  │  │   ─ transport.callTool() to Bloomreach                    │  │
  │  │   ─ reader.read() on incoming response                    │  │
  │  │   ─ setTimeout for spacing gate / retry sleep             │  │
  │  └──────────────────────────────────────────────────────────┘  │
  │                                                                │
  │  ZERO worker threads. ZERO child processes. ZERO cluster.      │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The Node single-threaded model came from the Node.js authors' bet that I/O is the bottleneck for server work — given that, the locking complexity of multi-threaded servers buys you nothing, and you can serve more concurrent connections per machine with cooperative multitasking. It's the same bet Nginx made vs Apache.

The serverless deployment doubles down: Vercel doesn't even expose threads or process control. You write the handler; the platform handles the rest. The cost of that abstraction is exactly what's in this guide — every long-lived resource has to live in the cookie or sessionStorage or be content with dying on instance teardown.

Worth reading: the original Ryan Dahl JSConf 2009 talk on Node's design (still the clearest articulation); Node's `worker_threads` docs to see what we're *not* using and why.

## Interview defense

**Q: Walk me through what happens when two users hit `/api/briefing` at the same time.**

Both requests land on the same Vercel instance, both invoke the route handler. The handler is async, so each goes through:

```
  request A                    request B
  ─────────                    ─────────
  await getOrCreateSessionId   await getOrCreateSessionId
            ↓                            ↓
  (yields)                     (yields)
            ↓                            ↓
  await makeDataSource         await makeDataSource
            ↓                            ↓
  await bootstrap(req.signal)  await bootstrap(req.signal)
            ↓                            ↓
   ... interleaving on one thread ...
```

One thread. The interleaving happens at every `await`. They never collide because each `getOrCreateSessionId` returns a different cookie value, so all the per-session state in `lib/state/insights.ts` is keyed apart. The only thing they share is the outer `Map` reference — and we never `.clear()` the outer Map, only per-session sub-maps.

Anchor: "one thread, two suspended continuations, interleaved at every await."

**Q: Why no worker threads?**

The hot path is waiting on Anthropic and Bloomreach. A worker would just be another thread waiting. CPU is not the bottleneck — round-trip latency is. Adding workers would buy us nothing except more memory pressure per instance.

If we added CPU-bound work later — say, a heavy JSON transform or a local LLM inference — that's when worker_threads earns its place. For now, the codebase has zero `worker_threads`, zero `child_process`, zero `cluster` imports. Verified by grep.

```
  the question:  is CPU saturated or is I/O blocking us?
       │
       ▼
  I/O blocking → workers don't help → single thread is correct
  CPU saturated → workers help → not our situation today
```

## See also

  → `03-event-loop-and-async-io.md` for what the runtime is doing while we await.
  → `04-shared-state-races-and-synchronization.md` for the races this seam creates.
  → `01-runtime-map.md` for where this single thread fits in the three-band picture.

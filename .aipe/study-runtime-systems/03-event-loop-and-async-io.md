# Event Loop and Async I/O

**Industry name:** event loop, microtask queue, async I/O · **Type:** Industry standard

## Zoom out — where this concept lives

The event loop is the engine the previous file (`02-processes-threads-and-tasks.md`) named. This file walks what's actually on it: which queues, which scheduling rules, where the repo reaches each scheduling primitive.

```
  Zoom out — the event loop sits under everything in the Node band

  ┌─ Browser tab ────────────────────────────────────────────────────────┐
  │  React 19 · async fetch · ReadableStreamDefaultReader.read()         │
  └──────────────────────────────────────────────────────────────────────┘
                            │
  ┌─ Node 20+ process ─────────────────────────────────────────────────┐
  │                                                                    │
  │   route handlers · agent loops · MCP transport · NDJSON emission   │
  │                            │                                       │
  │                            ▼                                       │
  │   ┌─ ★ THE EVENT LOOP ★ ──────────────────────────────────────┐   │
  │   │   microtask queue (Promise callbacks, queueMicrotask)     │   │
  │   │   macrotask queue (setTimeout, setImmediate, I/O callbacks)│   │
  │   │   libuv phases (timers, poll, check, close)               │   │
  │   └────────────────────────────────────────────────────────────┘   │
  └────────────────────────────────────────────────────────────────────┘
```

Nothing in the repo touches `process.nextTick`, `queueMicrotask`, or `setImmediate` directly — grep confirms zero hits across `lib/` and `app/`. The only scheduling primitives the app code reaches for are `setTimeout` (for sleeps and replay delays) and the implicit microtask queue (every `await`). That's a deliberately small surface. The rest is handled by what the SDKs do underneath: `fetch` schedules I/O completions, `AbortSignal.timeout` schedules a timer, the React reconciler schedules its own work.

## Structure pass

### Axis: who schedules this work?

```
  Plain function call          → caller runs it on the spot, no queue
  await foo()                  → microtask queue when foo's Promise settles
  setTimeout(cb, ms)           → macrotask queue after ms milliseconds
  network I/O completion       → macrotask queue when libuv polls and finds it
  AbortSignal.timeout(ms)      → setTimeout under the hood; macrotask
```

The repo only chooses between "plain await" and "setTimeout". Everything else (network completions, abort firings) is scheduled by primitives the app calls but doesn't manage directly.

### Seams

The seam that matters is **microtask ↔ macrotask** drain order:

```
  Where the seam flips — microtasks drain to empty before any macrotask

  current macrotask runs
        │
        ▼
  drain ALL queued microtasks (Promise resolutions, await continuations)
        │
        ▼
  drain ALL again if microtasks queued more microtasks
        │
        ▼
  pick ONE macrotask (next setTimeout fire, next I/O callback)
        │
        ▼
  loop
```

This matters in exactly one place in the repo: the `setTimeout` sleeps in `lib/data-source/bloomreach-data-source.ts` and the replay loops in the route handlers. Each `setTimeout(r, ms)` queues a macrotask after `ms` milliseconds; before that macrotask runs, every currently-pending await continuation gets a turn. In practice this means a 1.1s `sleep(minIntervalMs)` is at least 1.1s but never noticeably more — there's no microtask starvation risk because the repo doesn't generate huge chains of microtasks per turn.

## How it works

### Move 1 — the mental model

You know how `await fetch(url)` doesn't actually pause the thread — it pauses YOUR FUNCTION while the thread keeps running other work? The event loop is the engine that decides what to run next. It has two queues: microtasks (Promise callbacks, the things `.then()` and `await` resume) and macrotasks (timer fires, network I/O completions). The rule is brutal and simple: drain ALL microtasks before picking even ONE macrotask. That's why `await` continuations feel "immediate" after the awaited Promise settles — they're at the front of the queue, ahead of any timer.

```
  The microtask-first rule — what runs in what order

  ──────────────────────────────────────────────────────────────────
  TASK START: someFn() runs from the top
  │
  │   await foo()              ← parks someFn; queues continuation
  │                              for when foo's Promise settles
  │
  │   meanwhile other stuff runs on the loop...
  │
  │   foo's Promise settles    ← someFn's continuation queued
  │                              as MICROTASK
  │
  │   (microtask queue drains BEFORE next macrotask)
  │
  │   someFn continues from the await    ← microtask runs
  │
  TASK END
  ──────────────────────────────────────────────────────────────────
```

If you only remember one thing about the event loop, remember this: `await` resumes via a microtask, and microtasks always run before timers. That's why `Promise.resolve().then(...)` is "faster" than `setTimeout(..., 0)`.

### Move 2 — the moving parts

#### Every `await` in this codebase is a microtask park

The agent loop in `lib/agents/base-legacy.ts:114-206` is a tight `for (let turn = 0; turn < maxTurns; turn++)` loop with TWO awaits per turn: one for the model call, one (or more) for tool execution. Each await parks the loop function and schedules its continuation as a microtask.

```ts
// lib/agents/base-legacy.ts:114-206 (the inner shape, abridged)
for (let turn = 0; turn < maxTurns; turn++) {
  signal?.throwIfAborted();
  // ...
  const res = await anthropic.messages.create(params, signal ? { signal } : undefined);
  //          ↑ parks the loop until Anthropic responds (typically 1-5s)

  for (const tu of toolUses) {
    // ...
    const { result, durationMs } = await dataSource.callTool(
      tu.name,
      tu.input as Record<string, unknown>,
      signal ? { signal } : undefined,
    );
    //          ↑ parks the loop until MCP responds (1-10s with rate-limit retries)
  }
}
```

While the loop is parked at either `await`, the Node process is free to handle other requests. This is the entire reason the app can serve concurrent users on one warm Vercel instance — each request's agent loop spends most of its wall-clock time parked, and the event loop multiplexes between them.

#### `setTimeout` is the only macrotask the repo schedules

Three places use `setTimeout`, all for sleeps:

```ts
// lib/data-source/bloomreach-data-source.ts:73-75 — the rate-limit-retry sleep
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// lib/data-source/bloomreach-data-source.ts:191-194 — the ~1 req/s spacing
const elapsed = Date.now() - this.lastCallAt;
if (elapsed < this.minIntervalMs) {
  await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
}

// app/api/agent/route.ts:136 and app/api/briefing/route.ts:103, 119 — replay pacing
await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));
```

The pattern `new Promise((r) => setTimeout(r, ms))` is the standard "Promise-ify a timer" idiom. The Promise resolves when the timer fires (a macrotask); the awaiter's continuation then runs as a microtask. So the actual sequence for `await sleep(10_000)` is:

```
  T = 0ms:   await suspends caller
  T = ~10000ms: timer fires (macrotask)
  T = ~10000ms: setTimeout's callback (r) runs → resolves the Promise
  T = ~10000ms: microtask queue drains; awaiter's continuation runs
```

The replay-pacing sleeps (`REPLAY_DELAY_MS = 180` in agent, `140` in briefing) are deliberately small — they exist to make the demo snapshot reveal at a human-readable pace, not to throttle.

#### Network I/O completes via libuv, surfaces as a Promise

When `anthropic.messages.create(...)` fires, the SDK eventually calls `fetch()`, which hands the request to Node's libuv-backed HTTP client. libuv polls the OS for the response without blocking the JS thread; when bytes arrive, libuv queues a callback that resolves the fetch's Promise. The awaiter's continuation then runs as a microtask.

The app never sees libuv directly — it just sees Promises settling. But the lifecycle is: a `fetch()` call uses libuv I/O under the hood, and the rest of the event loop is free during the wait.

#### `AbortSignal.timeout(ms)` is `setTimeout` wearing a signal hat

```ts
// lib/mcp/transport.ts:38, 131
const TOOL_TIMEOUT_MS = 30_000;
// ...
const signal = composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS));
```

`AbortSignal.timeout(30_000)` schedules an internal `setTimeout` for 30 seconds; when it fires, the returned signal's `.aborted` flag flips and its `.onabort` listeners fire. The MCP SDK is listening, so an in-flight `client.callTool` aborts. From the event loop's perspective it's just another macrotask: at T+30s, the timer fires, microtasks drain, the SDK's abort handler runs, the await chain rejects with `AbortError`.

The composition with `req.signal` (`AbortSignal.any([opts?.signal, AbortSignal.timeout(30_000)])`) is the "first to fire wins" trick — `07-backpressure-bounded-work-and-cancellation.md` walks why both are needed.

#### `ReadableStream` is pull-based, not push-based

The route handlers create a `ReadableStream` (`app/api/agent/route.ts:184`, `app/api/briefing/route.ts:191`) with an `async start(controller)` function. The `start` function is called ONCE, when the stream is being read. It owns the entire lifetime of the work and emits chunks via `controller.enqueue(...)`.

```ts
// app/api/briefing/route.ts:191-329 (the shape)
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    // ...
    try {
      // ... await schema bootstrap ...
      // ... await coverage gate ...
      // ... await agent.scan(...) which awaits many tool calls ...
      send({ type: 'done' });
    } catch (e) {
      // ...
    } finally {
      controller.close();   // ← MUST fire to release the browser's reader
    }
  },
});
```

The stream is pull-based: the platform's HTTP layer reads from it as the client pulls. Backpressure is implicit — if the client pulls slowly, `controller.enqueue` doesn't apply pressure here because the route emits messages bounded by agent turns (small, infrequent). For high-volume streams you'd reach for `pull(controller)` and `enqueue`'s `desiredSize`; this app doesn't need to.

The READER side is in `lib/streaming/ndjson.ts:28-64`:

```ts
// lib/streaming/ndjson.ts:28-64 — the pull-loop
const reader = body.getReader();
const decoder = new TextDecoder();
let buf = '';
try {
  while (true) {
    if (opts?.cancelOn?.()) {
      await reader.cancel();   // ← propagates cancel back to the producer
      return;
    }
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // ... split on '\n', parse, dispatch ...
  }
}
```

Each `await reader.read()` parks until the next chunk arrives over the network or the stream closes. Between reads, the loop checks `cancelOn()` — that's the integration point with React's effect cleanup (the `cancelledRef` in `useBriefingStream.ts:130, 152`).

### Move 3 — the principle

A single-threaded event loop turns "concurrent execution" into "concurrent parking." The skill is knowing what parks (any `await` on I/O) and what doesn't (any synchronous computation between awaits). The repo's hot path is almost pure await — model call, tool call, model call, tool call — so the thread stays available. The risk is anywhere code does meaningful CPU work between awaits without yielding, which is why the truncation in `lib/agents/base-legacy.ts:32-37` matters: a 100MB tool result that we tried to `JSON.stringify` in full would block the loop for hundreds of milliseconds.

## Primary diagram

```
  One agent loop turn on the event loop — the parking schedule

  ┌─ Node event loop ────────────────────────────────────────────────────┐
  │                                                                      │
  │   T=0       runAgentLoop turn starts (TASK)                          │
  │             │                                                        │
  │             ▼                                                        │
  │             await anthropic.messages.create(...)                     │
  │             │                                                        │
  │   T=0+      parked → loop free for other requests                    │
  │             │                                                        │
  │             ▼ (T = ~2s)                                              │
  │             Anthropic HTTP response arrives (MACROTASK via libuv)    │
  │             │                                                        │
  │             ▼ (microtasks drain)                                     │
  │             continuation runs; tool_use extracted                    │
  │             │                                                        │
  │             ▼                                                        │
  │             for tu of toolUses:                                      │
  │               await dataSource.callTool(...)                         │
  │               │                                                      │
  │               ├─ liveCall: elapsed < minIntervalMs                   │
  │               │     await sleep(...)  (~1.1s, MACROTASK timer)       │
  │               │                                                      │
  │               ├─ transport.callTool with composed AbortSignal        │
  │               │     (network I/O via libuv; up to 30s timeout)       │
  │               │                                                      │
  │               └─ result returned                                     │
  │             │                                                        │
  │             ▼                                                        │
  │             tool result sent to controller.enqueue (NDJSON byte)     │
  │             │                                                        │
  │             ▼                                                        │
  │             next turn or break                                       │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘

  the thread is busy maybe 5% of this turn's wall-clock; the rest is parked.
  that's why the route handles concurrent requests without queueing.
```

## Elaborate

The event loop is the most-misunderstood part of Node. People assume "single-threaded" means "no concurrency." It means the OPPOSITE: it concurrently HANDLES many things by parking each and resuming whichever is ready next. The thread isn't a worker; it's a dispatcher.

Where this model breaks: CPU-bound work between awaits. The repo gets close to this with `JSON.stringify` of tool results — the truncation at 16K chars (`lib/agents/base-legacy.ts:32`) is the guard. A worst-case tool result without truncation could stringify a multi-megabyte object and block the loop for tens of milliseconds, which would stall every other request on the process.

The microtask vs macrotask distinction matters more for understanding than for daily code. The one place it would surface is if the repo started using `process.nextTick` (Node-only, runs BEFORE Promise microtasks, can starve I/O if abused) — but the repo doesn't, so this stays academic.

## Interview defense

> Q: "Walk me through what happens when a request hits /api/briefing on a warm instance."

The route handler runs, returns a `ReadableStream` with an `async start(controller)`. The platform begins reading the stream; that triggers `start`. Inside `start`, `await bootstrap()` parks the function while four MCP calls happen sequentially. Each MCP call awaits the rate-limit sleep, then awaits the network response. Between awaits, the event loop is free to handle other requests. When events come back, microtasks drain, the function resumes, emits via `controller.enqueue`, and continues. The whole thing is bounded by `maxDuration = 300`.

> Q: "What's the load-bearing part most people forget about the event loop?"

The microtask-first rule: every `await` continuation runs as a microtask, and microtasks all drain before any macrotask. That's why a `setTimeout(..., 0)` after a chain of `Promise.resolve().then()` always loses — the Promise chain finishes first. People who think of `await` as "wait" rather than "park-and-microtask" get tripped up by ordering bugs.

> Q: "What would block the event loop in this codebase, hypothetically?"

A huge synchronous `JSON.parse` or `JSON.stringify`. The truncation at `lib/agents/base-legacy.ts:32` (16K cap on tool result strings) is the guard. Also: a runaway regex on a huge string, or any tight CPU loop. The repo doesn't have those, but if you added one without a `setImmediate` yield, you'd stall the entire process.

## See also

- `02-processes-threads-and-tasks.md` — the one-thread context this loop runs in.
- `07-backpressure-bounded-work-and-cancellation.md` — how `AbortSignal.timeout` and `req.signal` use the same scheduling primitive to bound work.
- `06-filesystem-streams-and-resource-lifecycle.md` — `ReadableStream` lifecycle and the pull-based read loop.

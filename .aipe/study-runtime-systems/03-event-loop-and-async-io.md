# Event loop and async I/O

*Event loop, microtasks, non-blocking I/O · Language-agnostic*

## Zoom out — where this concept lives

The event loop is the heartbeat of both server and client. Every async operation in this codebase either enqueues a task on the loop or awaits one that's already there. Understanding what's queued *where* is how you predict when work will actually run.

```
Zoom out — the loop, on both sides

┌─ Browser event loop (per tab) ────────────────────────────┐
│  ★ React renders (macrotask via scheduler)                 │
│  ★ fetch reader (microtask on .read() resolve)             │
│  ★ setState → render commit (batched microtask)           │
└─────────────────────────────────────────────────────────────┘

┌─ Node event loop (per Vercel instance) ────────────────────┐
│  ★ each route handler = one big Promise chain              │
│  ★ every await ─►  hand control back to the loop           │
│  ★ setTimeout(fn, ms) ─►  macrotask, ms later               │
│  ★ Promise.resolve().then() ─►  microtask, this tick        │
└─────────────────────────────────────────────────────────────┘
```

## Structure pass — one axis, two altitudes

Trace the axis *"is the loop making progress?"* down the abstraction levels.

```
"Is the loop making progress?" — trace it down

┌─ higher: awaited async operation ────────────────────┐
│  await fetch(url) — the loop moves on to other work   │
│    → YES, the loop makes progress                     │
└──────────────────┬───────────────────────────────────┘
                   │
                   ▼
┌─ lower: sync work between awaits ─────────────────────┐
│  JSON.stringify(largeObject) — blocks the loop        │
│    → NO, everything else waits                        │
└────────────────────────────────────────────────────────┘
```

The seam that carries a load: **sync ↔ async transition points.** Every `await` is a seam. Between two awaits, the loop is stuck on whatever synchronous code sits there. Blooming avoids blocking by keeping sync sections small (parse a truncated tool result, format a status line) — no CPU-heavy loops, no synchronous file reads inside request handling (except at module load, which happens once per instance and doesn't affect requests).

## How it works

### Move 1 — the mental model

You know how `Array.forEach` runs its callback synchronously and blocks the current stack frame? The event loop is what schedules code *between* stack frames. When your stack empties (the current sync work finishes), the loop picks the next thing to run: first microtasks (Promise callbacks), then one macrotask (a `setTimeout` callback, an I/O completion), and back to microtasks.

```
The tick — what happens between two lines of your code

  sync code runs        ───┐
    ─►  awaited value       │  current stack
        resolves             ▼
  ┌──────────────────────────────────────┐
  │  stack empties                        │
  └─────────────────┬────────────────────┘
                    ▼
  ┌──────────────────────────────────────┐
  │  drain the microtask queue           │  ← all of it, before anything else
  │  (Promise .then, queueMicrotask)     │
  └─────────────────┬────────────────────┘
                    ▼
  ┌──────────────────────────────────────┐
  │  pick ONE macrotask                  │  ← one at a time
  │  (setTimeout, I/O completion, etc.)  │
  └─────────────────┬────────────────────┘
                    ▼
  ┌──────────────────────────────────────┐
  │  drain the microtask queue AGAIN     │  ← the loop is microtask-first
  └──────────────────────────────────────┘
```

Practical consequence: a Promise chain runs to completion before any `setTimeout` fires. If you write `Promise.resolve().then(a).then(b)` and also `setTimeout(c, 0)`, order is `a → b → c`, not `a → c → b`.

### Move 2 — how the codebase actually uses this

#### Non-blocking I/O everywhere in the request path

Every server-side I/O in this codebase is async. Grep for `fs.readFileSync` in request-time code and you find only two categories:

  → **Module-load reads** — `lib/agents/monitoring-legacy.ts:13`, `lib/agents/diagnostic-legacy.ts:14`, `lib/agents/recommendation-legacy.ts:14`, `lib/agents/query-legacy.ts:13`. These run once when the module is first imported, on the cold-start path. After that, the strings live in module scope.

  → **Request-time reads of small JSON files** — `lib/state/investigations.ts:15`, `lib/mcp/auth.ts:118` (dev only), `app/api/briefing/route.ts:89`, `app/api/agent/route.ts:52`. These read small files (demo snapshots, dev-only auth cache, dev-only investigation cache) synchronously. They block the loop for a millisecond or two — fine for their scale, but the pattern is worth calling out: in production the auth cache is a cookie (no blocking read) and the investigation cache is in-memory.

Everything else is `await`ed:

```
The server-side I/O ledger — everything the loop waits on

request path (per HTTP request):
  await bootstrap(schema)             ← MCP list_cloud_organizations + list_projects
  await dataSource.listTools(signal)  ← MCP list_tools
  await agent.investigate(...)        ← Anthropic + N × MCP tool calls
  await controller.enqueue(...)       ← Web Stream backpressure (implicit)

background of every await:
  the loop is FREE — other requests' awaits can resolve,
  their handlers get a turn to run
```

#### The one place where "microtask vs macrotask" order matters

In practice, the codebase doesn't lean on that distinction. Every `await` and every `.then()` runs as a microtask; every `setTimeout(r, ms)` runs as a macrotask. The two never race against each other because there's no case where the order matters:

  → **`sleep(ms)`** at `lib/data-source/bloomreach-data-source.ts:73-75` — used for backoff, order doesn't matter, just the delay.
  → **`REPLAY_DELAY_MS`** at `app/api/briefing/route.ts:25` and `app/api/agent/route.ts:103` — used to pace the demo replay so it *feels* animated. Order doesn't matter.

If a future feature needed to coordinate "run this thing after the current promise chain but before the next timer," the microtask/macrotask distinction would matter. It doesn't today.

#### The Web Streams reader loop — where the loop gets its steadiest tick

```
readNdjson — the client's tightest await loop

// lib/streaming/ndjson.ts:32-51
while (true) {
  if (opts?.cancelOn?.()) {           ← polled synchronously between reads
    await reader.cancel();
    return;
  }
  const { value, done } = await reader.read();   ← the await that dominates the loop time
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    try {
      onEvent(JSON.parse(line) as E);   ← sync work per line: parse + dispatch
    } catch (err) {
      opts?.onMalformed?.(line, err);
    }
  }
}
```

Every `await reader.read()` yields to the browser's event loop. Between reads, React can render, other timers can fire, other handlers can run. This is why streaming NDJSON *feels* animated on the client even though the browser is single-threaded — the reader loop pauses at `await`, lets the render commit, and picks up when the next chunk arrives.

The sync work per chunk (decode → split → forEach parse) is bounded: a chunk is typically a few KB, split into 1–20 lines, each line ≤ 4KB after route-side truncation. No line-parse loop blocks the browser meaningfully.

#### The server-side ReadableStream writer — implicit backpressure

Web Streams have a backpressure signal: if the consumer is slow, `controller.enqueue` returns eventually but the internal buffer bloats. In practice, blooming insights writes at the pace agents produce events (~one per second), and consumers (the browser) read as fast as they arrive, so backpressure never triggers. The codebase doesn't handle backpressure explicitly — if a browser tab throttled reads to zero, the route would happily fill an unbounded buffer until `maxDuration` kicked in.

### Move 3 — the principle

**The event loop is fair *between* awaits, brutal *inside* them.** Async in JavaScript is cooperative: every `await` is a yield point, and the loop redistributes CPU accordingly. The moment your code stops yielding — a sync loop, a big JSON.stringify, a synchronous file read — every other request on the instance stops making progress until you finish. Non-blocking I/O isn't a nice-to-have; it's the load-bearing property that keeps a single-loop runtime honest.

The corollary: to reason about throughput and latency, count `await`s. Every `await` is a scheduling boundary. Every sync section between them is a potential stall.

## Primary diagram — the full async surface

```
Event loop + async I/O across both bands

BROWSER LOOP
┌───────────────────────────────────────────────────────────────┐
│  readNdjson: await reader.read()  ─►  yields to loop           │
│    │                                                           │
│    ├─►  React render commits (microtask)                       │
│    ├─►  other fetch handlers (their own microtasks)            │
│    └─►  next reader.read() resolves, sync parse loop runs      │
│                                                                 │
│  every setState → microtask → re-render                        │
└───────────────────────────────────────────────────────────────┘
                             │  HTTPS
                             ▼
NODE LOOP (Vercel instance)
┌───────────────────────────────────────────────────────────────┐
│  ROUTE HANDLER = one big async function                       │
│    ├── module-load reads (once per instance)                  │
│    ├── await bootstrap(signal)             ─►  yields         │
│    ├── await listTools(signal)             ─►  yields         │
│    ├── await agent.investigate({signal})   ─►  yields many    │
│    │      │                                    times inside   │
│    │      └── await dataSource.callTool()      the agent loop │
│    │            └── await sleep(minInterval)  ─►  yields      │
│    │            └── await transport.callTool ─►  yields       │
│    ├── send(event) ─► controller.enqueue                      │
│    │      (sync write into a bounded stream buffer)           │
│    └── send({type:'done'}) ─► controller.close()               │
│                                                                 │
│  What's not here: no sync CPU loops, no fs.readFileSync of     │
│  request-scoped data, no blocking work between awaits.        │
└───────────────────────────────────────────────────────────────┘
```

## Elaborate — why non-blocking I/O is load-bearing on Vercel

Vercel's serverless model gives you one Node process per warm instance. That instance may serve dozens of requests concurrently (Vercel routes based on capacity). If any one handler blocks the loop for even a second, every other in-flight handler stalls for that second. Because the platform can spin up new instances under load, a blocked-loop bug doesn't kill availability — but it wrecks p95/p99 latency invisibly.

The codebase's discipline of `await`-everything-that-can-await is what keeps p95 bounded. The `finally` block log at `app/api/briefing/route.ts:317-324` records per-phase timings so a regression on this discipline would show up in Vercel logs immediately.

## Interview defense

**Q: Explain the microtask vs macrotask distinction using a concrete function in this codebase.**

```
readNdjson at lib/streaming/ndjson.ts:17

  await reader.read()      ← the promise this returns resolves as a MICROTASK
                              when the next chunk arrives

  setTimeout(r, REPLAY_DELAY_MS)  ← the callback here fires as a MACROTASK
                                     140ms later (briefing demo replay)
```

The reader's next-chunk callback runs in the same tick that the read completes; the demo replay's pacing runs in a later tick. Microtasks drain fully between macrotasks, so if the reader had pending Promises resolving faster than 140ms, they'd all run before the replay's next `setTimeout` fired.

**Q: Where in this codebase could you accidentally block the event loop?**

Two spots:

  → **Module load**, the `readFileSync` calls in `lib/agents/*-legacy.ts` (only the legacy adapters; the current AptKit-backed agents don't). These run once per instance during cold start; they block cold-start latency but not request latency after that.

  → **`JSON.parse` / `JSON.stringify` of large tool results.** `app/api/briefing/route.ts:71-75` truncates results to 4KB before parsing (`trunc`), which caps the sync work. Without that truncation, a multi-MB EQL response would freeze the loop for the parse duration.

Anchor: `TRUNC = 4000` at `lib/state/insights.ts`-adjacent route code; the truncation function is the load-bearing part.

**Q: What happens if the browser stops reading the NDJSON stream mid-briefing?**

Web Streams' backpressure kicks in on the *client* — `reader.read()` blocks until the internal buffer drains. On the *server*, `controller.enqueue` would keep filling the buffer up to whatever bound Node's stream layer chose. In practice: nothing does this in the app. If it did, the route would hit `maxDuration = 300` and Vercel would kill the function; the browser would see the connection close.

## See also

  → `02-processes-threads-and-tasks.md` — the single-loop assumption that makes this whole model work.
  → `06-filesystem-streams-and-resource-lifecycle.md` — the `ReadableStream` mechanics and the NDJSON reader kernel in detail.
  → `07-backpressure-bounded-work-and-cancellation.md` — how the loop's timers combine with AbortSignal to bound work.

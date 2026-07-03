# Processes, threads, and tasks

*Execution model · Language-agnostic (JavaScript runtime specifics)*

## Zoom out — where this concept lives

Before the mechanism, the question: *where does work actually run in this codebase?* The answer is compact — every server task runs on one Node event loop, every client task runs on one browser event loop, and nothing else exists.

```
Zoom out — the runtime's execution surface

┌─ Browser event loop ──────────────────────────────────────────┐
│  React reconciler, fetch handlers, ★ NDJSON reader ★           │
│  ← we are here for the client work                             │
└─────────────────────────────────────────────────────────────────┘
                    ▲
                    │ HTTPS (async, non-blocking)
                    │
┌─ Node event loop (Vercel serverless instance) ───────────────┐
│  ★ every route handler, every agent loop, every MCP call ★    │
│  ← we are here for all server work                             │
│                                                                │
│  What is NOT here:                                            │
│  · worker_threads    — not used                                │
│  · child_process     — not used                                │
│  · cluster           — not used                                │
│  · OS threads        — not used (Node doesn't expose them)     │
└────────────────────────────────────────────────────────────────┘
```

Two loops, both single-threaded. The whole `study-runtime-systems` topic reduces to: how do you get useful work done on one loop without blocking it?

## Structure pass — one axis, three altitudes

Trace *control flow* down the stack. The answer changes at every altitude.

```
Who decides what runs next?  — one question, three answers

┌─ Node's libuv scheduler ──────────────────────────┐
│  picks the next task from the microtask / macro    │
│  task / I/O queues                                 │
│    → the RUNTIME decides                           │
└──────────────────┬─────────────────────────────────┘
                   │
                   ▼
┌─ Async/await in your code ───────────────────────┐
│  every `await` yields control back to the loop     │
│    → the AWAITED value's readiness decides         │
└──────────────────┬─────────────────────────────────┘
                   │
                   ▼
┌─ The eval load harness ──────────────────────────┐
│  N indices in a queue, K workers .shift() until    │
│  the queue is empty                                │
│    → the QUEUE decides (fair, first-come)          │
└────────────────────────────────────────────────────┘
```

The self-similar pattern here is powerful: the load harness's worker pool is a *tiny hand-rolled scheduler* built on top of the language's async primitives. Same shape as the underlying loop, one level up.

The seams:

  → **Sync ↔ async** — any function that returns a Promise gives control back to the loop on `await`. This is where CPU work "hides"; work between `await`s blocks the loop.
  → **Loop-owned ↔ code-owned scheduling** — the load harness's queue is the one place in the codebase where user code owns "what runs next." Everywhere else, the runtime picks.

## How it works

### Move 1 — the mental model

You know how `setTimeout(fn, 0)` doesn't run `fn` immediately, but queues it? That's the loop. Every async operation in JS gets queued somewhere — microtasks (Promise resolutions), macrotasks (`setTimeout`, I/O completions) — and the loop picks the next one when the current stack empties.

```
The event loop, in one picture

  ┌──────────────────────────────────────────┐
  │  call stack (synchronous work runs here) │
  └────────────────────┬─────────────────────┘
                       │  stack empty?
                       ▼
       ┌───────────────────────────────────┐
       │  microtask queue                  │
       │  (Promise .then, queueMicrotask)  │  ← drained fully before next macrotask
       └────────────────────┬──────────────┘
                            │  empty?
                            ▼
       ┌───────────────────────────────────┐
       │  macrotask queue                  │
       │  (setTimeout, I/O completions)    │  ← one at a time
       └───────────────────────────────────┘
```

Every `await` in your code yields to the loop between the "before" and "after" of the awaited expression. Multiple concurrent requests on one Vercel instance interleave freely — one request's `await dataSource.callTool(…)` gives another request's handler a chance to run.

### Move 2 — the mechanisms in this codebase

#### Server-side: every handler is one async function

```
Where server work runs — one Node process, many concurrent requests

request A ─► handler A (async)
                │
                ├── await bootstrap(schema)      ┐
                │                                │ each await
                ├── await dataSource.listTools() │ yields to
                │                                │ the loop —
                ├── await agent.investigate(…)   │ other requests
                │                                │ run in the gaps
                └── send({type:'done'})           ┘
                    controller.close()

request B ─► handler B (async)                    ← runs concurrently
                │                                    with A on the same
                └── await agent.propose(…)           event loop
```

Every route handler in `app/api/*/route.ts` is an `async` function returning a `Response`. The handler body typically follows the pattern:

  → set up per-request state (`getOrCreateSessionId`, `makeDataSource`)
  → return a `new Response(new ReadableStream({ start(controller) { … } }))`
  → inside `start`, the async work runs (agents, MCP calls, Anthropic calls)
  → `send(event)` calls enqueue into the stream; every `await` yields to the loop

No handler in this codebase spawns a worker, forks a process, or does CPU-heavy synchronous work that would block the loop. The heaviest sync work is `JSON.stringify` / `JSON.parse` on ~4KB truncated tool results (`app/api/briefing/route.ts:71-75`) — nothing to worry about.

#### Client-side: React renders + the NDJSON reader loop

```
Where client work runs — one browser event loop

┌─ React tree render ─┐   ┌─ readNdjson async loop ────────────────┐
│  useState updates    │◄──│  while(true) {                          │
│  useEffect fires     │   │    const {value, done} = await reader   │
│  useRef reads        │   │    if (done) break;                     │
└─────────────────────┘   │    buf += decoder.decode(value)         │
                          │    for (line of lines) handle(line)      │  ← each handle
                          │  }                                       │    calls setState
                          └─────────────────────────────────────────┘    which schedules
                                                                          a React render
```

The kernel of client-side work is the NDJSON reader in `lib/streaming/ndjson.ts:17-64`. It's one async function looping on `reader.read()`, calling `handle(event)` for each parsed line. Every `handle` call typically calls a React `setState`, which enqueues a React render on the microtask/task queue. The browser interleaves reader progress with React renders naturally.

The optional `cancelOn` callback is polled *between reads*:

```ts
// lib/streaming/ndjson.ts:32-36
while (true) {
  if (opts?.cancelOn?.()) {
    await reader.cancel();
    return;
  }
  const { value, done } = await reader.read();
```

`useBriefingStream` uses this to break out cleanly when the effect cleanup fires:

```ts
// lib/hooks/useBriefingStream.ts:130-153, :288
const cancelledRef = useRef(false);
// … inside useEffect:
cancelledRef.current = false;
// … in the async body:
await readNdjson<BriefingEvent>(res.body, handle, { cancelOn: () => cancelledRef.current });
// … in cleanup:
return () => { cancelledRef.current = true; };
```

Note the deliberate asymmetry: `useBriefingStream` uses `cancelOn` to break out on unmount, but `useInvestigation` does *not* cancel on cleanup — see `lib/hooks/useInvestigation.ts:33-37` for the comment explaining why (StrictMode double-mount + started-guard was aborting the stream and leaving logs empty).

#### The one place user code owns scheduling: the load harness

```
Semaphore-based worker pool — the standard JS-runtime concurrency primitive

  ┌─ shared queue ─┐
  │ [0,1,2,…,N-1]  │  ← all N task indices, dropped in at start
  └────────┬───────┘
           │  workers pull one at a time via .shift()
           │
  ┌────────┼────────┬────────┬────────┐
  │        │        │        │        │
  ▼        ▼        ▼        ▼        ▼
worker 0  worker 1  worker 2  worker 3  worker K-1

each worker:
  while (queue.length > 0) {
    const index = queue.shift()          // atomic on single loop
    if (index == null) return
    await runOneInvestigation(index)     // yields to the loop
  }

Promise.all(workers) → wait for all to drain the queue
```

The load harness at `eval/load.eval.ts:171-211` is the one place in the codebase where user code owns "what runs next":

```ts
// eval/load.eval.ts:171-211 — annotated

const indices = Array.from({ length: LOAD_N }, (_, i) => i);
const queue = [...indices];                          // shared work queue

async function worker(workerId: number): Promise<void> {
  while (queue.length > 0) {                         // one worker pulls one task
    const index = queue.shift();                     // .shift() is atomic on
    if (index == null) return;                       //   the single loop —
    //                                                  no lock needed
    const golden = goldens[index % goldens.length];
    try {
      const inv = await runOneInvestigation(index, …);  // heavy async work
      results.push(inv);                             //   yields many times
    } catch (err) {                                  // errors don't stop
      results.push({ …, error: msg });               //   other workers
    }
  }
}

const workers = Array.from({ length: LOAD_CONCURRENCY }, (_, i) => worker(i));
await Promise.all(workers);                          // wait for queue drain
```

Why this shape (skeleton test — what breaks if you remove each part):

  → Drop **the shared queue** and you have N tasks per worker with no way to balance load; a slow worker holds up the whole run.
  → Drop **the `while (queue.length > 0)` loop** and each worker does one task; you're not pooling anything.
  → Drop **the try/catch** and one failing investigation stops its worker; the concurrency drops.
  → Drop **`Promise.all(workers)`** and the test returns before workers finish; the receipt is empty.

The result: N investigations complete in `wall-clock ≈ N × per-investigation / K`, capped by `Math.max(600_000, ((LOAD_N * 300_000) / LOAD_CONCURRENCY) * 1.5)` (line 228). Real number from the codebase state: `LOAD_N=2, K=1 → 208s wall clock (≈104s per investigation)`.

#### The one micro-primitive worth naming: `sleep`

```ts
// lib/data-source/bloomreach-data-source.ts:73-75
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

This is the codebase's whole toolkit for "wait a bit." Used by the rate-limit retry ladder at `bloomreach-data-source.ts:172` and by the spacing gate at `:193`. The demo replay uses the same shape inline at `app/api/briefing/route.ts:103, :119`.

Note what's NOT here: no `worker_threads.Worker`, no `child_process.spawn`, no `AbortController.abort()` on a background timer (the `AbortSignal.timeout` factory does that internally). Every `sleep` yields to the loop, other work runs while it waits.

### Move 3 — the principle

**Concurrency is not parallelism, and this codebase never confuses them.** All server work is *concurrent* — many requests interleave on one event loop — but never *parallel* — nothing runs on two cores at once. The load harness's K workers are K concurrent async loops on the same event loop, sharing a queue; they don't run on K cores.

For an IO-bound workload like this (network calls to Anthropic and Bloomreach dominate), concurrency alone is enough — the CPU sits idle waiting for network responses anyway. If the workload were CPU-bound (heavy JSON parsing on multi-MB tool results, ML inference), the K-workers pattern would top out at one loop's worth of CPU, and you'd need `worker_threads`. It isn't, so you don't.

## Primary diagram — the full execution surface

```
Everywhere work runs in blooming insights

BROWSER (one event loop per tab)
┌──────────────────────────────────────────────────────────────┐
│                                                               │
│  React reconciler (owns render scheduling)                    │
│                                                               │
│  useEffect → fetch() → readNdjson loop                        │
│                          │                                    │
│                          ├─► handle(event) → setState → render│
│                          └─► cancelOn poll → reader.cancel()  │
│                                                                │
└──────────────────────────────────────────────────────────────┘
                            │  HTTPS
                            ▼
NODE PROCESS (one event loop per warm serverless instance)
┌──────────────────────────────────────────────────────────────┐
│                                                               │
│  request A: route handler (async)                             │
│    │                                                          │
│    ├─ await bootstrap(signal)          ┐                      │
│    ├─ await listTools(signal)          │  every await         │
│    ├─ await agent.investigate({signal})│  yields to the loop  │
│    ├─ send(event) → controller.enqueue │  other requests run  │
│    └─ controller.close()               ┘                      │
│                                                                │
│  request B: route handler (async)  ← runs interleaved with A   │
│                                                                │
│  eval load harness (test env only):                           │
│    K workers, one shared queue                                │
│    Promise.all(workers)                                       │
│                                                                │
│  What's absent: worker_threads, child_process, cluster,       │
│  OS threads. All work is single-loop concurrent.              │
│                                                                │
└──────────────────────────────────────────────────────────────┘
```

## Elaborate — why single-loop is enough here

Node's event loop is what Ryan Dahl built the whole runtime around: assume every I/O is async, run one loop, and you get high concurrency without threads. For a workload where every request is dominated by "wait for a network response" — which is exactly what an agent app is — this model gets full CPU utilization on tiny CPU because the CPU sits idle 90% of the time anyway, waiting for Anthropic or Bloomreach to respond.

The Achilles heel is CPU-bound work. If a request had to (say) run a large ML model locally, the event loop would freeze during the model call; other requests would stack up. That's when you reach for `worker_threads`. This codebase doesn't have that shape — inference is all remote (Claude), MCP tool calls are all remote (Bloomreach). So one loop suffices.

## Interview defense

**Q: You said "concurrent, not parallel" — draw the difference.**

```
Concurrent (this codebase)          Parallel (not used here)

one event loop:                      two cores:
  req A ─╮                             req A ──────►
         ├─ interleaved                              (core 1)
  req B ─╯                             req B ──────►
                                                     (core 2)
```

Concurrent means many tasks are *in progress* on one loop; each `await` gives another task a turn. Parallel means many tasks are *executing simultaneously* on multiple cores. Blooming insights is fully concurrent, never parallel — worker threads and child processes are absent from `lib/` and `app/`.

Why it's enough: every heavy operation in the request path is IO (network calls to Claude and Bloomreach). The CPU is idle during the wait; other requests fill the idle time.

**Q: Walk me through the load harness's worker pool. What breaks if I drop the shared queue?**

Six workers, one shared array of indices, each worker `.shift()`s and processes until the queue empties. `Promise.all(workers)` waits for the drain. Drop the shared queue → static assignment → a slow investigation blocks its worker; other workers finish early and idle instead of picking up the slack. The point of the shared queue is *work stealing without locks* — `.shift()` is atomic on the single event loop, so no synchronization primitive is needed.

Anchor: `eval/load.eval.ts:171-211`.

**Q: If Anthropic ever added a local model, would this design still work?**

No — local inference would be CPU-bound, and one heavy inference call would freeze the event loop for its duration, stalling every other request on the instance. The fix would be `worker_threads`: run inference in a worker, `postMessage` the result back. That's not on the roadmap; it's the shape of change that would break the "one loop is enough" property.

## See also

  → `03-event-loop-and-async-io.md` — the queue mechanics and non-blocking I/O.
  → `07-backpressure-bounded-work-and-cancellation.md` — the concurrency ceiling in the load harness, and how it composes with the route budget.
  → `study-testing` — how the fault-injecting DataSource proves the concurrency behavior under load.

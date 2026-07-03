# Processes, threads, and tasks

**Industry:** processes, threads, and cooperative tasks · Language-agnostic

## Zoom out — where this concept lives

Every band on the runtime map has *one* JavaScript thread. That single-threaded rule is the assumption underneath every other concurrency choice in the repo — the ALS pattern, the module-level Maps, the spacing gate, all of them work because there is no preemption inside a JS event loop.

```
  Zoom out — one JS thread per band

  ┌─ Browser ───────────────────────────────────┐
  │  V8 · main thread · React runs here         │
  │  ★ THIS CONCEPT ★                            │
  └──────────────────────┬──────────────────────┘
                         │  fetch (browser scheduler)
  ┌─ Vercel serverless ─▼───────────────────────┐
  │  Node 20 · one event loop per instance      │
  │  ★ THIS CONCEPT ★                            │
  └──────────────────────┬──────────────────────┘
                         │  HTTPS
  ┌─ Upstream ──────────▼───────────────────────┐
  │  their process model, not ours              │
  └─────────────────────────────────────────────┘
```

The concept: **cooperative tasks scheduled on one thread**, not threads pinned to cores. Async functions yield at every `await`; the event loop picks the next one; nothing preempts you. The consequence: race conditions in the classical sense (two threads, one variable) don't exist. But *interleaving* still does — an `await` is a yield point where any other pending task can run before you resume.

## Structure pass — layers, axis, seams

Pick one axis — **who decides which task runs next** — and trace it across the layers.

```
  One axis (who schedules?) traced down the layers

  ┌─ your code ─────────────────────────────┐
  │  await points          → YOU yield        │
  └─────────────────────────────────────────┘
      ↓ every await is a hand-off
  ┌─ V8 event loop ────────────────────────┐
  │  microtask + macrotask queues → the LOOP │
  │                                          picks next task
  └─────────────────────────────────────────┘
      ↓
  ┌─ OS scheduler ─────────────────────────┐
  │  the process runs when the OS says so   │
  │  (Vercel abstracts this away)           │
  └─────────────────────────────────────────┘

  seam that matters: the await. Below it, you have no control.
```

**The seams:**

- **Every `await` is a scheduling seam.** Between the `await` and its resolution, ANY other pending task can run. If your invariant depends on "no one else touched X between step 1 and step 2," you have to enforce it — the event loop doesn't.
- **The process boundary is opaque.** You cannot spawn a worker thread and expect it to share memory with the main thread. In Node you could reach for `worker_threads` (structured-clone messaging, no shared memory except SharedArrayBuffer). The repo does not.

## How it works

### Move 1 — the mental model

You know how a React component sees `setTimeout(fn, 0)` and thinks "run after everything else in this tick"? That's the event loop's macrotask queue. `Promise.resolve().then(fn)` schedules on the microtask queue, which drains between every macrotask. Every `async` function you write is just sugar over promises: each `await` is a `.then` — the function *stops*, the current task ends, and the loop picks up whatever's next.

```
  Pattern — the event loop's task queues

  ┌── one tick ──────────────────────────────────────┐
  │                                                  │
  │  1. run macrotask (e.g. incoming HTTP request)   │
  │     │                                            │
  │     │  hits await                                │
  │     ▼                                            │
  │  2. drain microtask queue completely             │
  │     (resolved promises, .then callbacks)         │
  │     │                                            │
  │     ▼                                            │
  │  3. render / I/O poll                            │
  │     │                                            │
  │     ▼                                            │
  │  4. pick next macrotask ── back to step 1        │
  │                                                  │
  └──────────────────────────────────────────────────┘

  key rule: between any two lines of your code separated
  by an await, the loop may have run other tasks
```

That's the model. Everything else — cooperative scheduling, no preemption, single-threaded execution — falls out of it.

### Move 2 — walking the pieces

#### The Node runtime (the serverless band)

**What it is:** V8 embedded in Node 20. One main thread runs your JavaScript. Under the hood, `libuv` runs a thread pool for FS and DNS I/O (default 4 threads), but you never touch it directly — the results flow back to the main thread through the event loop.

**What runs there:** everything under `app/api/*/route.ts`. Also everything under `lib/*` when imported by a route. The Anthropic SDK, the MCP SDK, `node:fs`, `node:crypto` — all of it on the same thread.

**Where the boundary is:** `worker_threads` isn't imported anywhere in the repo. There's no CPU-heavy work that would justify it. The heaviest single operation is `JSON.parse` on a truncated (`TRUNC = 4000` bytes, `app/api/agent/route.ts:98`) MCP tool result, which is trivial.

**How you'd know it's single-threaded from the code:** the ALS pattern in `lib/mcp/auth.ts:47` only makes sense in a single-threaded context. If Node were multi-threaded, `AsyncLocalStorage` wouldn't give you per-request isolation — you'd need thread-local storage AND some cross-thread coordination.

```
  Node 20 in the serverless band

  ┌─ main thread (your JavaScript) ─────────────────┐
  │                                                 │
  │  route handler          async fn.await          │
  │    │                       │                    │
  │    │                       │  yields            │
  │    ▼                       ▼                    │
  │  event loop  ─────────►  next task              │
  │                                                 │
  └──────┬────────────────────────────┬─────────────┘
         │  I/O request               │  crypto op
         ▼                            ▼
  ┌─ libuv thread pool ─────┐    ┌─ inline (main) ──┐
  │  (4 default)            │    │  createHash /     │
  │  disk I/O · DNS         │    │  AES-256-GCM run  │
  │  results marshalled     │    │  synchronously    │
  │  back to main thread    │    │  on main thread   │
  └─────────────────────────┘    └───────────────────┘
```

Node's threading is real but hidden. You cannot use it to escape a CPU-bound loop on the main thread — it exists only for I/O.

#### The browser runtime

**What it is:** the same V8 (or Firefox's SpiderMonkey, or Safari's JavaScriptCore) embedded in a browser tab. One main thread per tab.

**What runs there:** everything in `components/*`, `lib/hooks/*` (client hooks), and any `'use client'` module. React 19 rendering, event handlers, `useEffect` bodies, the NDJSON reader loop.

**Where the boundary is:** `Worker` isn't used in the repo. React 19's compiler emits main-thread code by default; server components (`app/page.tsx` when it doesn't have `'use client'`) run on the server, not on a worker.

**The specific single-threaded pattern that matters here:** the `startedRef` latch in `lib/hooks/useInvestigation.ts:45-50`:

```
  // lib/hooks/useInvestigation.ts:45-50 — the mount latch
  const startedRef = useRef(false);
  useEffect(() => {
    if (!id) return;
    if (startedRef.current) return;  // ← run once per mount
    startedRef.current = true;
    // ...
  });
```

Under React StrictMode (dev), the effect fires twice — mount, cleanup, remount. Without the latch, the fetch would start twice. The `useRef` is safe as a latch *because* JavaScript is single-threaded: no other task can read `startedRef.current` between the `if` check and the `startedRef.current = true` assignment. In a multi-threaded runtime you'd need a proper compare-and-swap.

#### Cooperative tasks — the shape of an async agent loop

The DiagnosticAgent + RecommendationAgent live entirely on the main thread. Their concurrency shape is a chain of awaits, not a thread pool. `app/api/agent/route.ts:283-289` runs them in sequence: diagnostic finishes, then recommendation starts. Nothing parallel. The BudgetTracker (`lib/agents/budget.ts:41`) is safe as a shared object because the two agents never run at the same time — no race, just handoff.

```
  Sequential agent chain — single thread, sequenced awaits

  route handler
    │
    ▼
  await bootstrap(signal)          ← MCP orchestrator, yields at each call
    │
    ▼
  await dataSource.listTools()     ← yields
    │
    ▼
  await diagnostic.investigate()   ← agent loop, many yields inside
    │
    ▼
  await recommendationAgent.propose()  ← runs after diagnostic finishes
    │
    ▼
  send('done')

  the whole chain is one macrotask thread — no fork/join
```

Contrast this with `eval/load.eval.ts:210` — `await Promise.all(workers)`. That's still one thread, but now K worker tasks are *interleaved* on the same event loop. Each worker awaits its next investigation; while it's waiting, another worker gets to run. The single-thread rule holds; the concurrency is *cooperative*.

### Move 3 — the principle

Single-threaded execution is the underrated superpower of JavaScript runtimes. You lose parallelism (a CPU-bound task blocks *everything*), but you get a memory model that fits in your head: **no two lines of your code can execute simultaneously**. If line 1 reads a Map and line 2 writes it, no one interleaved between them — unless there's an `await` in between. That's the entire mental model. Every synchronization primitive in the repo (the ALS pattern, the `startedRef` latch, the shared BudgetTracker) works because of this rule.

## Primary diagram

```
  Processes, threads, and tasks — the full picture

  ┌─ Browser tab ────────────────────────────────────────────────┐
  │  ONE main JS thread                                          │
  │                                                              │
  │  React render ── useEffect ── fetch() ── NDJSON reader loop  │
  │       │              │           │              │            │
  │       └── all interleaved on ONE event loop ────┘            │
  │                                                              │
  │  no workers used; the `startedRef` latch is safe             │
  │  because nothing else can run between check and set          │
  └──────────────────────────────────────────────────────────────┘

  ┌─ Vercel instance (Node 20) ──────────────────────────────────┐
  │  ONE main JS thread                                          │
  │                                                              │
  │  route handler         async agent loop                      │
  │    │                        │                                │
  │    │  ALS.run(ctx,          │  every await = yield           │
  │    │           () => …)     │                                │
  │    │  scopes the store      │  BudgetTracker checked         │
  │    │  to this task chain    │  before each turn              │
  │    │                        │                                │
  │    └── all interleaved on ONE event loop ─┘                  │
  │                                                              │
  │  hidden: libuv 4-thread I/O pool (FS + DNS)                  │
  │  no worker_threads; no cluster; no child_process             │
  └──────────────────────────────────────────────────────────────┘

  ┌─ vitest process (eval only) ─────────────────────────────────┐
  │  ONE main JS thread                                          │
  │                                                              │
  │  worker pool pattern:                                        │
  │  Array.from({length: K}, worker(i))                          │
  │      │                                                       │
  │      └── K "workers" are just K interleaved async tasks      │
  │          on ONE thread — cooperative concurrency             │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

The "one thread per event loop" model comes from Netscape's original JavaScript — it was designed as a scripting language for a browser, and browsers didn't want to expose threading to scripts. Node.js inherited that model because it wanted to reuse V8. Deno and Bun kept it for the same reason.

The tradeoff is well-understood: you cannot escape a CPU-bound loop by throwing more cores at it. If you have work that genuinely needs parallel CPUs, you either move it to a worker (`worker_threads` in Node, `Worker` in the browser) or move it out of the JavaScript runtime entirely (a native addon, a separate service, a queue → worker fleet in a different language). None of these apply to `blooming_insights` today; the workload is I/O-bound (waiting on Bloomreach and Anthropic), and I/O is exactly what the event loop is good at.

Read `03-event-loop-and-async-io.md` next — it walks how the queues actually drain and what "microtask starvation" looks like when it goes wrong. Then `04-shared-state-races-and-synchronization.md` shows how the single-threaded rule turns into a design pattern (ALS scoping).

## Interview defense

**Q: The repo runs on Vercel. How many threads does one request touch?**

One. Vercel serverless functions are Node 20 processes — one main JavaScript thread. Under the hood libuv runs a 4-thread pool for disk and DNS I/O but you never see it — the results marshal back to the main thread through the event loop. The repo doesn't use `worker_threads` or child processes. Every route handler, every agent loop, every crypto op runs on the same thread. That's why the ALS pattern in `lib/mcp/auth.ts` is safe — one request = one async task chain = one ALS context.

*Diagram to sketch: a horizontal band labeled "main JS thread" with the route handler + agent + crypto stacked inside it, and a small "libuv thread pool" box below feeding I/O results in.*

**Q: If everything is single-threaded, how does the load harness run K workers concurrently?**

Cooperative interleaving. In `eval/load.eval.ts` we spawn K "worker" async functions with `Promise.all` — they all live on the same event loop, but each one awaits its next investigation, and while it's waiting, another worker gets to run. There's no true parallelism. K=3 gives us ~3× throughput because the work is I/O-bound (waiting on Anthropic + MCP), and the event loop keeps three requests in flight at once. If the work were CPU-bound, K=3 wouldn't help — one busy loop would block everyone.

*Diagram to sketch: three horizontal timelines labeled worker-0, worker-1, worker-2, each with alternating "waiting on network" and "processing" bars interleaved on a single thread bar underneath.*

**Q: What's the load-bearing part everyone forgets about the JS event loop?**

That every `await` is a scheduling seam. People remember "JavaScript is single-threaded" and conclude "no races" — and that's *almost* right. The trap: between the `await` and its resolution, ANY other pending task can run. So if you read a shared Map on line 1, do an `await` on line 2, and write the Map on line 3, someone else may have touched it in between. That's not a thread race, but it's the same class of bug. The fix in the repo is either ALS (per-request store, no shared write) or the shared `BudgetTracker` (sequential-only writers). Both dodge the interleaving problem, they don't solve it in general.

*Diagram to sketch: a single thread timeline with a red gap labeled "await" between two of your lines, and an arrow from a second task threading through that gap.*

## See also

- `03-event-loop-and-async-io.md` — the queues, the microtask/macrotask split, blocking hazards
- `04-shared-state-races-and-synchronization.md` — the ALS pattern and why it works on one thread
- `07-backpressure-bounded-work-and-cancellation.md` — the eval worker pool + cooperative concurrency

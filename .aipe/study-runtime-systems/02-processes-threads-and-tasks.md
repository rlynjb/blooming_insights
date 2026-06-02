# 02 — Processes, threads, and tasks

**Industry name(s):** process model · concurrency model · single-threaded event-loop runtime
**Type:** Industry standard (Node.js / V8) · Language-agnostic concept

> **Verdict: one process, one thread, many tasks — no exceptions.** No `worker_threads`, no `cluster`, no `child_process`, no `Atomics`, no `SharedArrayBuffer` anywhere in the repo. Every "concurrent" thing in this app — four agents, multiple route handlers, the `ReadableStream` controller, the spacing-gate `setTimeout` — is a JS task on the single Node event loop. The repo earns its simplicity because all the heavy work is I/O-bound (Anthropic + MCP HTTPS calls). The day someone tries to add CPU work — a local embedding, a JSON-parse over a megabyte payload, a regex over the full Bloomreach response — the event loop blocks and every other in-flight request stops. That's the failure mode this concept covers.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Concurrency in this repo lives entirely in the **Server runtime** band. The browser has its own single-threaded JS environment (we don't use Web Workers, Service Workers, or any of that). Anthropic and Bloomreach are their own processes on their own machines; we don't see them. The interesting question — "what owns CPU, and what shares it?" — is answered inside one Node 20 process per Vercel invocation.

```
  Concurrency lives here — one band, one process

  ┌─ Browser (V8) ───────────────────────────────┐
  │  one thread; no Workers used                 │
  └──────────────────────│───────────────────────┘
                         │
  ┌─ Vercel function ────▼───────────────────────┐ ← we are here
  │                                              │
  │  ┌────────────────────────────────────────┐  │
  │  │ ONE Node process                       │  │
  │  │   one V8 isolate                       │  │
  │  │   one event loop (libuv)               │  │
  │  │   ★ THIS CONCEPT ★ — process · thread ·│  │
  │  │     task                                │  │
  │  └────────────────────────────────────────┘  │
  │                                              │
  └──────────────────────│───────────────────────┘
                         │
  ┌─ Providers (their own runtimes) ─────────────┐
  │  Anthropic · Bloomreach MCP                  │
  └──────────────────────────────────────────────┘
```

**Zoom in — the concept.** *Processes* are OS-level isolation boundaries (memory, file descriptors, signals). *Threads* are execution contexts inside a process that share that memory. *Tasks* are units of work the runtime schedules onto a thread. Node has one main thread per process, runs JS on it via libuv's event loop, and offloads I/O to a separate thread pool you never touch directly. In this repo, every named thing — `MonitoringAgent.scan`, `DiagnosticAgent.investigate`, the `ReadableStream` start callback, the `await setTimeout` in `liveCall` — is a task scheduled onto that one main thread.

---

## Structure pass

**Layers.** Two for our purposes:
1. **Process layer** — Vercel manages it; we don't.
2. **Task layer** — every async function, every promise continuation, every `setTimeout` callback.

**Axis traced: *who can preempt what?***

```
  "Who can preempt what?" — traced through the stack

  ┌─ OS / Vercel platform ─────────────────────┐
  │  CAN preempt our Node process (eviction,    │   → we have no say
  │   maxDuration kill at 300s)                 │
  └─────────────────────────┬──────────────────┘
                            │
  ┌─ V8 event loop ─────────▼──────────────────┐
  │  CANNOT preempt a running JS function       │   → run-to-completion
  │   it can only pick the next task once       │     is the only contract
  │   the current one returns or awaits         │
  └─────────────────────────┬──────────────────┘
                            │
  ┌─ Our async functions ───▼──────────────────┐
  │  CANNOT be preempted by other JS;           │   → safe to read-modify-
  │   yield only at `await` points              │     write a Map without
  │                                              │     locks (within one process)
  └────────────────────────────────────────────┘

  the answer FLIPS at the V8 boundary — the OS can stop us,
  but JS code cannot stop other JS code.
```

**Seams.** Two:

1. **Between Vercel and Node** — Vercel can preempt (eviction, maxDuration kill). The Node process gets no shutdown notification we listen to. Anything we needed to persist had to be persisted before this point.
2. **Between async tasks on the event loop** — JS code is cooperatively scheduled. A task that doesn't `await` blocks every other task on the loop until it returns. This is the seam that makes a long synchronous parse a runtime bug.

---

## How it works

### Move 1 — the mental model

You already know how a single `await` works: the rest of the function is queued as a continuation, and control returns to whoever called you. Now picture a hundred of those happening in one process, all queued on one event loop. Each is a "task." None can run while another is running. None can be interrupted while it's running. The only way work makes progress in parallel is if it's *waiting* (on a `fetch`, on a `setTimeout`, on a stream chunk) — while it waits, another task gets the loop.

```
  The single-thread, many-tasks kernel

       ┌─────────────────────────────────────────────┐
       │              one main thread                 │
       │                                              │
       │   ┌────────────────────────────────────┐     │
       │   │    event loop  (libuv on Node)      │    │
       │   │                                      │   │
       │   │   ┌──────┐  ┌──────┐  ┌──────┐      │   │
       │   │   │ task │  │ task │  │ task │      │   │
       │   │   │  A   │  │  B   │  │  C   │      │   │
       │   │   └──┬───┘  └──┬───┘  └──┬───┘      │   │
       │   │      │ runs    │ awaits  │ resumes  │   │
       │   │      ▼ until   ▼ on I/O  ▼ when     │   │
       │   │      it awaits   yields    I/O      │   │
       │   │      or returns  the loop  completes │   │
       │   └────────────────────────────────────┘     │
       │                                              │
       └─────────────────────────────────────────────┘

  any task that DOESN'T await blocks every other task
  until it returns — this is the failure mode
```

### Move 2 — the moving parts

#### 1) One Node process per Vercel function invocation

What you'd call a "request handler" lives inside a Node process the platform owns. The process is reused for many requests while warm; on cold start, a fresh process spins up with a fresh V8 heap and fresh module-init state. There is no parent-supervisor in user code — Vercel's runtime is the supervisor.

```
  Process layer — what we own vs what the platform owns

  ┌─ Vercel platform (we don't touch this) ────────────────┐
  │   - spins up Node                                       │
  │   - reuses while warm, evicts on idle                   │
  │   - kills on maxDuration                                │
  │   - no SIGTERM hook we install                          │
  └────────────────────────────────┬───────────────────────┘
                                   │
  ┌─ Node process (everything in lib/* + app/*) ───────────┐
  │   - module-scope let/const → lives for warm lifetime    │
  │   - in-process Map<>'s → same                            │
  │   - process.env, process.cwd() → read freely             │
  │   - process.on('SIGTERM', …) → not installed             │
  └────────────────────────────────────────────────────────┘
```

What breaks without the platform doing this work for us: graceful shutdown. We have no flush-state-before-exit logic. If `maxDuration` fires mid-investigation, the work is just gone — no save, no notify-client, nothing.

#### 2) The main thread + the libuv thread pool you never see

Node has one main thread that runs your JS. It also has a libuv thread pool (default 4 threads) for *some* blocking syscalls — `fs.readFileSync` doesn't use it (it really does block), but `fs.promises.readFile`, `crypto.pbkdf2`, DNS resolution, and a few others do. Nothing in this repo deliberately reaches for the thread pool. The `node:fs` calls we use (`readFileSync` in route handlers, `writeFileSync` in `lib/state/investigations.ts:36`) are the *synchronous* ones — they block the main thread while the disk read happens.

```
  Threads in Node — the ones that exist, the ones we use

  ┌─ Main thread ─────────────────────────────────────────┐ ← we use this
  │   runs JS, runs the event loop, blocks on sync fs     │
  └────────────────────┬──────────────────────────────────┘
                       │ delegates SOME work
                       ▼
  ┌─ libuv thread pool (default 4) ───────────────────────┐ ← exists, we don't use it
  │   fs.promises, DNS, crypto.pbkdf2, zlib               │
  │   the repo uses sync fs + sync crypto cipher only     │
  └───────────────────────────────────────────────────────┘
  ┌─ Worker threads / child_process / cluster ────────────┐ ← not in the repo
  │   not used anywhere                                   │
  └───────────────────────────────────────────────────────┘
```

What breaks if we ever add a `fs.readFileSync` over a megabyte file at request time: every other request on the warm instance pauses while the read completes. The two `readFileSync` calls in `app/api/agent/route.ts:53` and `app/api/briefing/route.ts:87` read kilobyte JSON snapshots — fine in practice, worth knowing in principle.

#### 3) Tasks: every async function call, every promise continuation, every timer

A "task" in this world is anything the event loop will pick up and run. Three sources matter for this repo:

- **Async function calls** — `runAgentLoop` is one. Each `await` inside it queues a continuation that runs when the awaited promise resolves.
- **Promise continuations** (microtasks) — `.then` callbacks, `await` resumptions. Drained between every macrotask.
- **Timers** (macrotasks) — `setTimeout`, including the spacing-gate sleep in `McpClient.liveCall` (`lib/mcp/client.ts:151`) and the replay-pace `setTimeout(180)` in `app/api/agent/route.ts:135`.

```
  Where tasks come from in this repo

  ┌─ async fn call ──────────────┐    ┌─ microtask queue ────┐
  │  GET(req)                    │ →  │  await resumptions    │
  │  runAgentLoop(...)           │ →  │  .then/.catch         │
  │  MonitoringAgent.scan(...)    │ →  │                      │
  └──────────────────────────────┘    └──────────────────────┘
  ┌─ timer ─────────────────────┐    ┌─ macrotask queue ────┐
  │  setTimeout(180) (replay)    │ →  │  drained one per     │
  │  setTimeout(1100 - elapsed)  │ →  │  loop turn, after    │
  │   (spacing gate)              │ →  │  microtasks empty    │
  └──────────────────────────────┘    └──────────────────────┘
  ┌─ I/O completion ────────────┐    ┌─ I/O callbacks ──────┐
  │  fetch resolves              │ →  │  resumes whichever   │
  │  res.body chunk arrives      │ →  │  promise awaited it  │
  └──────────────────────────────┘    └──────────────────────┘
```

This matters for `03` (the event loop walkthrough). For now, the key is: **every "concurrent" thing in the agent loop is just promise continuations queued back to the loop. There's no thread doing it for you.**

#### 4) "Concurrent" requests on one warm instance

When two users hit the warm instance at once, Node doesn't fork. Both requests run as two top-level async tasks on the same event loop. They share the heap. They share every module-scope variable. They share the `McpClient.cache` Map. They each get their own `AsyncLocalStorage` context (that's how `lib/mcp/auth.ts` keeps them apart for the auth cookie), but everything not wrapped in ALS is shared.

```
  Two requests, one warm instance — what's shared

  request A's GET(req)        request B's GET(req)
        │                            │
        └─────────┬──────────────────┘
                  │  both run on the SAME event loop
                  ▼
   ┌──────────────────────────────────┐
   │ shared (no ALS, no locking)       │
   │   insights Map (lib/state/...)   │
   │   schema cached (lib/mcp/schema) │
   │   McpClient.cache (if shared)    │
   └──────────────────────────────────┘
   ┌──────────────────────────────────┐
   │ per-request                       │
   │   ALS context for auth store      │
   │   the GET function's local vars   │
   │   the `messages[]` in agent loop │
   └──────────────────────────────────┘
```

Important nuance: the repo builds a *new* `McpClient` per `connectMcp` call (`lib/mcp/connect.ts:91`), so the per-instance cache and spacing gate are actually per-request, not per-warm-instance. That's a real cost (no cross-request cache reuse) the route comments don't call out.

What breaks without the ALS scoping on auth: request B reads the cookie, sees request A's mid-flight decrypted store, the OAuth round-trip corrupts. This is exactly the failure the comment at `lib/mcp/auth.ts:41-47` describes — and is why `04` exists.

### Move 3 — the principle

**Single-threaded run-to-completion gives you cheap safety on read-modify-write, but it's a contract that breaks the moment you block the loop.** A `Map.set` followed by a `Map.get` is safe across requests because no other JS can interleave. The same `Map.set` followed by a 200ms synchronous loop is a 200ms freeze for every other request on the instance. The repo gets this right today because all its work is I/O-bound — but the contract is fragile to one carelessly synchronous function.

---

## Primary diagram

The full concurrency picture for one warm Node instance handling N concurrent requests:

```
  One warm Vercel instance · N concurrent requests · ONE event loop

  ┌─ Vercel function (Node 20) ───────────────────────────────────────────┐
  │                                                                       │
  │   ┌─ Main thread ──────────────────────────────────────────────────┐  │
  │   │                                                                 │ │
  │   │   ┌─ event loop ────────────────────────────────────────────┐   │ │
  │   │   │                                                          │   │ │
  │   │   │   request A: GET → ReadableStream.start → runAgentLoop  │   │ │
  │   │   │   request B: GET → ReadableStream.start → runAgentLoop  │   │ │
  │   │   │   request C: ... (queued)                                │   │ │
  │   │   │                                                          │   │ │
  │   │   │   they interleave at every `await`:                      │   │ │
  │   │   │     A awaits fetch → B runs until ITS next await → ...    │   │ │
  │   │   │                                                          │   │ │
  │   │   └──────────────────────────────────────────────────────────┘   │ │
  │   │                                                                 │ │
  │   │   ALS contexts (one per request) keep auth-store separate;     │ │
  │   │   everything else (the Maps) is shared without locks.          │ │
  │   └────────────────────────────────────────────────────────────────┘ │
  │                                                                       │
  │   libuv thread pool: exists, NOT exercised by this repo               │
  │   worker_threads / cluster / child_process: NOT used anywhere         │
  └───────────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** Every async function in `lib/agents/*` and `lib/mcp/*` is a task scheduled onto the one event loop. The places where the pattern matters most:

- `runAgentLoop` (`lib/agents/base.ts:48-176`) — one long async task with N `await`s; each `await` is a yield point.
- The route-handler `start(controller)` callbacks (`app/api/agent/route.ts:170-264`, `app/api/briefing/route.ts:179-256`) — each is one top-level task per request.
- `McpClient.liveCall` (`lib/mcp/client.ts:148-163`) — the `await setTimeout` is a deliberate yield-the-loop primitive (the spacing gate).

**Code side by side.**

```
  lib/agents/base.ts (lines 85-102)

  for (let turn = 0; turn < maxTurns; turn++) {
    // ...
    const res = await anthropic.messages.create(params);   ← yield ① (HTTP call to Anthropic)
                                                              the loop is free to handle
                                                              another request's tasks while
                                                              we wait
    // ...
    for (const tu of toolUses) {
      const { result, durationMs } = await mcp.callTool(   ← yield ② (HTTP call to MCP,
        tu.name,                                              going through the 1.1s gate)
        tu.input as Record<string, unknown>,
      );
      // ...
    }
  }
       │
       └─ EVERY `await` in here is a point where other requests'
          tasks get the event loop. Remove the awaits (impossible
          here, but illustrative) and the loop blocks until the
          synchronous work ends.
```

```
  lib/mcp/client.ts (lines 148-153)

  private async liveCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    const elapsed = Date.now() - this.lastCallAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
              │
              └─ the spacing gate. A `setTimeout` is a macrotask;
                 awaiting it yields the loop. While THIS request
                 sleeps, another request (and its agent loop) gets
                 to run. The gate paces calls to ONE server (Bloomreach)
                 without freezing OUR process.
    }
    try {
      const result = await this.transport.callTool(name, args);   ← yield (HTTPS out)
      // ...
```

```
  app/api/briefing/route.ts (lines 87, 53 in agent route)

  // demo replay path:
  snapshot = JSON.parse(readFileSync(DEMO_FILE, 'utf8')) as DemoSnapshot;
                       ▲
                       └─ SYNCHRONOUS fs read. Blocks the main thread
                          for the duration of the file read. Today the
                          file is small (~50KB) and dev-only / demo-only.
                          If this grew to a megabyte or moved into a
                          per-request hot path, it would freeze every
                          other request on the warm instance until it
                          finished. Documented honestly — the cost is
                          tiny today but the contract is fragile.
```

---

## Elaborate

This is the "JS is single-threaded but async" story you've heard, with one caveat that matters for this repo: **Node's `worker_threads` exists and is good for CPU work, and the repo could legitimately reach for it later.** A future feature that, say, runs a local embedding model on each insight would be a textbook use case for a Worker. The reason it isn't here is that the heavy work is all remote — Anthropic does the reasoning, Bloomreach does the EQL — and our process really is just orchestrating I/O.

Useful background reading: the Node docs on `worker_threads` (for the case we don't exercise) and the Vercel docs on function lifecycle (for what "warm vs cold" really means in cost and behavior).

---

## Interview defense

**Q: Two users hit the briefing endpoint simultaneously on a warm instance. Are they running in parallel?**
A: No. They're running *concurrently* on the same event loop. Both `GET` handlers start as separate async tasks. They interleave at every `await` — when A awaits the Anthropic call, B gets the loop. There's no parallelism here because there's no second thread. The only true parallelism is at the HTTPS level (Anthropic and Bloomreach can serve both requests' outbound calls in parallel on their side).

```
  Concurrent ≠ parallel — what actually happens

  time →
  request A:  ▓▓░░░░▓▓░░░░░░░▓▓░░▓▓
  request B:  ░░▓▓░░░░▓▓▓▓▓▓░░░░▓▓░░
              │  │   │   │
              │  │   │   └─ B's tool result arrives, B resumes
              │  │   └─ A awaits anthropic, B runs
              │  └─ A's anthropic resolves, A resumes
              └─ A starts, runs until first await
```

**Q: Why doesn't the repo use `worker_threads`?**
A: There's no CPU-bound work in the hot path. Every heavy computation — agent reasoning, EQL — is offloaded to Anthropic or Bloomreach over HTTPS. Our process is an I/O orchestrator. Adding workers would buy nothing and add lifecycle complexity (worker pools, message-passing, the `transferList` mental model). The day we add local embedding or local re-ranking, the answer changes — and that's the correct trigger to reach for them.

---

## Validate

1. **Reconstruct.** Draw two requests landing on the same warm instance. Mark the `await` points. Show which one runs when.
2. **Explain.** Why is `await new Promise((r) => setTimeout(r, ...))` in `lib/mcp/client.ts:151` *better* than a `while (Date.now() < target) {}` busy-wait? (Spinning blocks the loop and freezes every other request; awaiting `setTimeout` yields the loop so other tasks can run.)
3. **Apply.** A new feature needs to compute a 200ms CRC32 over every insight before storing it. Where does that work go, and why? (A `worker_threads.Worker` — putting it in the main thread freezes every concurrent request for 200ms.)
4. **Defend.** The `readFileSync` calls at `app/api/agent/route.ts:53` and `app/api/briefing/route.ts:87` block the main thread. Why is that acceptable here, and what would change that? (Files are ≤50KB and are demo-snapshot paths, not the live hot path. Acceptable today; would become a real problem if the snapshot grew or moved into the live path, where the fix would be `await readFile(...)` from `fs/promises`.)

---

## See also

- `03-event-loop-and-async-io.md` — what happens between the `await`s.
- `04-shared-state-races-and-synchronization.md` — why the in-process `Map`s don't race despite no locks (run-to-completion) and where that breaks (`AsyncLocalStorage`).
- `05-memory-stack-heap-gc-and-lifetimes.md` — what a "module-scope cache" actually holds.
- `07-backpressure-bounded-work-and-cancellation.md` — `maxToolCalls` is task-budget, not thread-budget.

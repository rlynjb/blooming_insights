# 02 — Processes, threads, and tasks

**Industry name(s):** process model · concurrency model · single-threaded event-loop runtime
**Type:** Industry standard (Node.js / V8) · Language-agnostic concept

> **Verdict (Phase 2): two processes (parent + Olist child), one thread per process, many tasks per thread.** Still no `worker_threads`, no `cluster`, no `Atomics`, no `SharedArrayBuffer`. The child process IS new — `StdioClientTransport` in `lib/data-source/olist-data-source.ts:127-141` spawns `mcp-server-olist/dist/src/index.js` via `process.execPath` and the MCP SDK manages the pipe. Inside the parent, every "concurrent" thing is still a JS task on one event loop. Inside the child, every tool call is one JS task on ITS event loop. The two processes share nothing except the stdio pipe — separate heaps, separate `Date.now()`s, separate everything. The repo still earns its simplicity because all heavy work is either I/O-bound (Anthropic + Bloomreach HTTPS) or microsecond-scale (SQLite SELECTs in the child). The day someone adds CPU work to the parent's event loop, parent-side concurrency breaks; the day someone parallelizes tool calls in the child, child-side single-flight breaks. Those are the two failure modes now.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Concurrency in this repo lives in TWO process bands now. The parent (Vercel function or local `npm run dev` or a `tsx` eval script) is one Node 20 process; the Olist child is another Node 20 process the parent spawns. The browser has its own single-threaded JS environment (no Web Workers, no Service Workers). Anthropic and Bloomreach are their own processes on their own machines; we don't see them. The interesting question — "what owns CPU, and what shares it?" — is answered TWICE now: once for the parent's event loop, once for the child's.

```
  Concurrency lives in TWO bands now (Phase 2)

  ┌─ Browser (V8) ───────────────────────────────┐
  │  one thread; no Workers used                 │
  └──────────────────────│───────────────────────┘
                         │
  ┌─ Vercel function — Node parent ──────────────▼┐ ← parent process
  │                                                │
  │  ┌────────────────────────────────────────┐    │
  │  │ ONE Node process (the parent)          │    │
  │  │   one V8 isolate · one event loop      │    │
  │  │   spawns the Olist child via          │    │
  │  │   StdioClientTransport (lib/data-     │    │
  │  │   source/olist-data-source.ts:127)    │    │
  │  └────────────┬───────────────────────────┘    │
  │               │ stdio pipe (JSON-RPC 2.0)      │
  └───────────────│────────────────────────────────┘
                  ▼
  ┌─ Olist child — Node 20 ────────────────────────┐ ← second process
  │  ONE Node process (the child)                  │
  │   one V8 isolate · one event loop              │
  │   StdioServerTransport reads stdin, writes stdout
  │   ★ THIS CONCEPT applies HERE TOO ★            │
  │   single-flight: one tool call at a time       │
  │   better-sqlite3 SYNC queries are safe         │
  └────────────────────────────────────────────────┘
  ┌─ Providers (their own runtimes) ────────────────┐
  │  Anthropic · Bloomreach MCP                     │
  └─────────────────────────────────────────────────┘
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
  ┌─ child_process (Phase 2 — via @modelcontextprotocol/sdk) ──┐ ← used in lib/data-source/
  │   StdioClientTransport spawns mcp-server-olist child       │
  │   one stdio pipe, JSON-RPC 2.0, single-flight              │
  │   killed on OlistDataSource.dispose()                      │
  └────────────────────────────────────────────────────────────┘
  ┌─ Worker threads / cluster ────────────────────────────┐ ← still not in the repo
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

#### 3.5) The Olist subprocess — a second Node process the parent owns (Phase 2)

When `bi:mode === 'live-sql'`, `makeDataSource` constructs an `OlistDataSource` whose first `callTool` call lazily spawns the child via `StdioClientTransport`. The SDK sets `command: process.execPath, args: [serverEntry], stderr: 'inherit'` — the OS forks Node, exec's the compiled `mcp-server-olist/dist/src/index.js`, and the parent gets two pipes (stdin/stdout). The MCP Client multiplexes JSON-RPC requests over the stdout-read / stdin-write halves.

```
  Subprocess lifecycle — spawn, reuse, dispose

  1. construction: new OlistDataSource()   ← cheap; no child yet
  2. first callTool / listTools:
       connect() → doConnect():
         StdioClientTransport({ command, args, stderr: 'inherit' })
         new Client(...)
         await client.connect(transport)   ← fork + exec + handshake
       client + transport stored on the instance
  3. subsequent calls: reuse the same client (one child for the instance's life)
  4. dispose():
       client.close()  ← polite "I'm done"
       transport.close() ← closes pipes → child gets EOF on stdin → exits

  the child's lifetime is the OlistDataSource instance's lifetime.
  one parent ↔ one child for as long as the parent holds the reference.
```

What breaks if `dispose()` doesn't run: the child outlives the parent. The parent process exits (function returns, dev-server HMR, `tsx` script ends), the child's stdin gets closed by the OS (because the parent half of the pipe is gone), and the child *should* exit on EOF — but if the parent crashed mid-call or the OS holds the pipe open briefly, the child can linger. This is the orphan-subprocess risk that's named in `08`. The K=10 parallel-run anecdote in `.aipe/study-testing/06-eval-flywheel.md` is the most documented example of this class of bug: two `tsx` eval scripts (PIDs 30039/30040) each spawning their own Olist child, neither cleaning up before the other clobbered shared `eval/results/<date>/` files. Detected via `ps aux | grep eval` and `kill` before damage.

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

Important nuance: the repo builds a *new* `McpClient` per `connectMcp` call (`lib/mcp/connect.ts:91`), so the per-instance cache and spacing gate are actually per-request, not per-warm-instance. That's a real cost (no cross-request cache reuse) the route comments don't call out. Same for `OlistDataSource` — each `makeDataSource('live-sql', sid)` builds a fresh one, which means each request that uses live-sql mode *spawns its own subprocess*. At low traffic that's fine; at concurrent load the parent ends up supervising N children at once, all reading from the same SQLite file. The single-flight property is per-child, not per-parent.

What breaks without the ALS scoping on auth: request B reads the cookie, sees request A's mid-flight decrypted store, the OAuth round-trip corrupts. This is exactly the failure the comment at `lib/mcp/auth.ts:41-47` describes — and is why `04` exists.

### Move 3 — the principle

**Single-threaded run-to-completion gives you cheap safety on read-modify-write, but it's a contract that breaks the moment you block the loop.** A `Map.set` followed by a `Map.get` is safe across requests because no other JS can interleave. The same `Map.set` followed by a 200ms synchronous loop is a 200ms freeze for every other request on the instance. The repo gets this right in the parent today because all its work is I/O-bound — and gets it right in the Olist child by making the child *single-flight*, which is the load-bearing reason the synchronous `better-sqlite3` calls don't poison its event loop. The same `better-sqlite3` running in the parent's hot path would be a textbook anti-pattern; in a single-flight subprocess it's the right call.

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

This is the "JS is single-threaded but async" story you've heard, with two caveats that matter for this repo:

1. **Node's `worker_threads` is still not in the repo.** A future feature that runs a local embedding on each insight would be a textbook use case for a Worker. Today, heavy work is either remote (Anthropic/Bloomreach) or in a separate Node process (Olist child) — so the parent's event loop genuinely is just orchestration.
2. **Node's `child_process` IS in the repo — via the MCP SDK abstraction.** `StdioClientTransport` calls into `node:child_process.spawn` under the hood (the SDK's `client/stdio.js`). The trade vs raw `child_process.spawn`: the SDK gives us JSON-RPC framing, request/response multiplexing, and a `Client.close()` lifecycle. Cost: we don't get the raw PID surface (no `kill -9 <pid>` from app code without lifting a layer). For the orphan-subprocess risk in `08`, that's the gap.

Useful background reading: the Node docs on `worker_threads` (for the case we don't exercise), `child_process` (for what the SDK abstracts), and the Vercel docs on function lifecycle.

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
A: There's no CPU-bound work in the parent's hot path. Heavy work is either remote (Anthropic, Bloomreach) or in another process (the Olist child via stdio). Workers would buy nothing and add lifecycle complexity (pool size, message-passing, `transferList`). The day we add local embedding or local re-ranking, the answer changes.

**Q: Why a subprocess instead of `worker_threads` for the Olist data source?**
A: The boundary we needed was *protocol* (MCP) and *isolation* (separate event loop, separate filesystem handle, separate failure domain), not raw CPU offload. A subprocess speaking JSON-RPC over stdio is what the MCP spec already covers, and gives us symmetry with the HTTP MCP path (BloomreachDataSource talks HTTPS to a remote MCP server; OlistDataSource talks stdio to a local one — both go through the same `Client.callTool` API). A `worker_thread` would have required us to invent a thread-local MCP transport. The cost we pay for the subprocess choice: lifecycle ownership (the dispose() discipline named in `06`), no shared memory (everything crosses the pipe as JSON).

---

---

## See also

- `03-event-loop-and-async-io.md` — what happens between the `await`s, in BOTH event loops.
- `04-shared-state-races-and-synchronization.md` — why parent `Map`s don't race (run-to-completion); why single-flight makes child sync-SQLite safe.
- `05-memory-stack-heap-gc-and-lifetimes.md` — two heaps now (parent + child).
- `06-filesystem-streams-and-resource-lifecycle.md` — `dispose()` is the new resource cleanup.
- `07-backpressure-bounded-work-and-cancellation.md` — `maxToolCalls` is task-budget; `AbortSignal.timeout(30_000)` is now the per-call subprocess cap.

---

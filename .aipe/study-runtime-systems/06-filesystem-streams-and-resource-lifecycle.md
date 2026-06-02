# 06 — Filesystem, streams, and resource lifecycle

**Industry name(s):** resource lifecycle · stream controllers · file handles · NDJSON over HTTP chunked transfer · `try/finally` cleanup
**Type:** Industry standard · Project-specific application

> **Verdict: the one resource that matters here is the `ReadableStream` controller — and the repo handles it correctly with `try/finally controller.close()`.** Filesystem use is deliberately tiny: a handful of sync reads of committed demo JSON, dev-only writes to `.auth-cache.json` and `.investigation-cache.json`, and a capture-fixture script. There are no file watchers, no streams to disk, no temp directories, no descriptor leaks possible — because almost nothing opens a long-lived handle. The interesting lifecycle isn't files; it's the HTTP response stream the route opens and the agent loop drives. The `finally { controller.close(); }` in both long routes is the load-bearing cleanup; without it, a thrown error mid-loop would leave the stream open and the client tab hanging.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Resources in this app live in two bands. The **Server runtime** opens a `ReadableStream` per request (the NDJSON channel to the client) and occasionally reads/writes a JSON file (the dev cache, the demo snapshot). The **Client runtime** opens a `fetch().body.getReader()` per investigation page — its lifecycle is mostly the browser's problem, with one explicit decision (don't `cancel()` on unmount). Providers (Anthropic, Bloomreach) own their own connections; from our side they're per-call HTTP fetches that auto-cleanup.

```
  Resource lifecycles — where the handles live

  ┌─ Browser (V8 per tab) ──────────────────────────────────────────────┐
  │  fetch().body.getReader()                                            │
  │     - opened in useInvestigation effect                              │
  │     - explicitly NOT cancel()'d on unmount (deliberate)              │
  │     - closes naturally when server sends done OR closes stream       │
  └──────────────────────────────│──────────────────────────────────────┘
                                 │  HTTPS chunked transfer
  ┌─ Vercel function (Node 20) ──▼──────────────────────────────────────┐  ← we are here
  │                                                                     │
  │  new ReadableStream({ start(controller) { ... } })                  │
  │     - one per route invocation                                      │
  │     - start() runs the agent loop                                   │
  │     - finally { controller.close(); } — THE cleanup point           │
  │                                                                     │
  │  readFileSync / writeFileSync (small JSON files)                    │
  │     - dev caches, demo snapshots, capture fixtures                  │
  │     - sync calls; no descriptor handle held across awaits           │
  │                                                                     │
  │  fetch() to providers                                               │
  │     - opened by the Anthropic SDK / MCP SDK transport               │
  │     - closed by Node's network stack on response complete           │
  │     - we don't see the descriptors                                  │
  └─────────────────────────────────────────────────────────────────────┘
```

**Zoom in — the concept.** A resource is anything you have to release when you're done with it: file descriptors, sockets, stream controllers, timers. The pattern is the same everywhere — acquire in a `try`, release in a `finally`. In modern JS, the runtime handles most of it for you (V8 GC + libuv close on FD unref), but stream controllers and timers are the cases where you have to be explicit.

---

## Structure pass

**Layers.** Three nested scopes for resource ownership:
1. **Per-call** — `fetch` responses, file reads. Released on return or on natural completion.
2. **Per-request** — the `ReadableStream` controller. Must be explicitly closed.
3. **Per-warm-instance** — none. Nothing in this repo holds a resource handle across requests (no DB pool, no persistent connection).

**Axis traced: *how is this resource released?***

```
  "How is this resource released?" — across layers

  ┌─ fetch response / file read ────────────────────┐
  │  auto-released by GC + libuv when handle unrefs │   → no app code
  │  no try/finally needed                          │
  └────────────────────┬───────────────────────────┘
                       │
  ┌─ ReadableStream controller ────────────────────▼┐
  │  explicit controller.close() in finally         │   → THE app's
  │  signals end-of-stream to platform              │     responsibility
  └────────────────────┬───────────────────────────┘
                       │
  ┌─ persistent handles (DB, queue) ───────────────▼┐
  │  none in this repo                              │   → not exercised
  └────────────────────────────────────────────────┘

  the answer flips at the stream layer — that's where app code has to
  do the work itself.
```

**Seams.** Two:

1. **The stream-controller boundary** — between "I've enqueued my last byte" and "the platform knows the response is complete." `controller.close()` is the contract. Forget it and the HTTP response never finishes (the client sees a hanging connection until its own timeout).
2. **The fs boundary** — between dev (writes are fine, the dev server's filesystem is writable) and production (Vercel's filesystem is read-only outside `/tmp`). The repo guards every write with `process.env.NODE_ENV === 'development'` checks.

---

## How it works

### Move 1 — the mental model

You already know `try { fetch(...) } finally { ... }` is overkill — there's no FD to close, the response object is GC'd when you stop using it. What you DO need `finally` for is anything you opened that the runtime won't auto-close. In Node, the two that matter are file handles you took with `fs.open()` (not used here) and stream controllers you got from `new ReadableStream({ start(controller) {...} })`. The latter is what every long route in this repo opens.

```
  The resource-lifecycle kernel — acquire, use, release

       ┌─ acquire ──────────────────┐
       │  new ReadableStream({       │
       │    async start(controller) { │
       │      try {                   │   ← happy path
       │        ... do work ...       │
       │        send(event)           │
       │      } catch (e) {           │
       │        send({type:'error'})  │   ← unhappy path
       │      } finally {              │   ← ALWAYS runs
       │        controller.close();   │
       │      }                       │
       │    }                         │
       │  })                          │
       └─────────────────────────────┘

  without the finally:
    - happy path: works fine (close called explicitly at end)
    - thrown error: close NEVER called, response never completes,
      client tab spins until its own fetch timeout fires
```

### Move 2 — the moving parts

#### 1) `ReadableStream` controller — the resource the app owns

When the route returns `new Response(new ReadableStream({...}))`, the runtime gives the `start(controller)` callback a `controller` object. The controller has three methods that matter: `enqueue(bytes)` (write to the stream's buffer), `close()` (signal end-of-stream), and `error(reason)` (signal abnormal termination). The platform translates these to chunks on the HTTP body. You MUST eventually call `close()` (or `error()`) — otherwise the response body never finishes.

```
  ReadableStream contract — what the controller methods mean

  enqueue(bytes)
     - push bytes into the internal buffer
     - the platform pulls from the buffer and writes to the HTTP body
     - sync; no await needed

  close()
     - signal "no more bytes coming"
     - platform finishes the HTTP body (sends the terminating chunk)
     - client's reader gets `{ done: true }` on the next read()

  error(reason)
     - signal "stream failed abnormally"
     - client's reader's read() throws

  forgetting close():
     - the platform never finishes the body
     - client hangs until its own timeout (could be minutes)
```

What breaks without `close()`: the HTTP response never completes. The client hangs. The route's serverless function eventually hits `maxDuration` and the platform kills it — but only after 300 seconds, and only by killing the whole instance.

#### 2) `try/catch/finally` — the cleanup discipline

Both `/api/agent` and `/api/briefing` wrap their stream body in `try/catch/finally`. The `catch` block does the user-visible work (send a typed `error` event so the UI can render the message). The `finally` block does the runtime-correctness work (call `controller.close()` no matter what).

```
  The route's stream lifecycle — the pattern, in pseudocode

  new ReadableStream({
    async start(controller) {
      try {
        // happy path
        await runAgentLoop({ ... })
        send({ type: 'done' })
        if (step == null) saveInvestigation(insightId, collected)
      } catch (e) {
        // sad path: client gets the real message, not a bare 500
        console.error('[agent] error:', e)
        send({ type: 'error', message: `…${e.message}` })
      } finally {
        // ALWAYS runs — even if `send` itself throws after error()
        controller.close()
      }
    }
  })

  the close in finally is the load-bearing line. without it, every
  unhandled error leaves the stream open and the user's tab spinning.
```

What breaks without the catch: an unhandled throw would propagate up to the platform; the response would still complete (the platform handles unhandled rejections in stream callbacks) but the client would see a generic stream-aborted error instead of a structured `{ type: 'error', message: '...' }`. The catch turns "something went wrong" into "this specific thing went wrong with this specific message."

#### 3) Synchronous file reads — small files, no handle held

The route handlers use `existsSync` and `readFileSync` (`node:fs` exports) on small JSON files: the demo insights snapshot (~50KB), the demo investigations snapshot, the agent prompts loaded once at module load. Sync calls don't take a file handle that lingers — they open, read, close, return a string.

```
  sync fs in routes — bounded, brief, no handle leak

  if (existsSync(DEMO_FILE)) {
    let snapshot: DemoSnapshot | null = null;
    try {
      snapshot = JSON.parse(readFileSync(DEMO_FILE, 'utf8')) as DemoSnapshot;
                            │
                            └─ opens FD, reads to string, closes FD
                               all in one call. no async, no leak path.
    } catch {
      snapshot = null;
    }
  }
```

The cost of sync is event-loop blocking for the read duration — `02` and `03` cover why that's tolerable here (sub-millisecond on KB-sized files, dev-only paths or one-time module-load).

#### 4) Dev-only file writes — gated by `NODE_ENV`

Two files get written: `.auth-cache.json` (`lib/mcp/auth.ts:34-35, 137-141`) and `.investigation-cache.json` (`lib/state/investigations.ts:7-8, 30-41`). Both are gated by `process.env.NODE_ENV === 'development'`. In production, the in-memory store is the only backing — there's no fallback file (the platform's filesystem is read-only outside `/tmp` anyway).

```
  dev cache writes — guarded by env, best-effort

  const PERSIST = process.env.NODE_ENV === 'development';

  export function saveInvestigation(insightId, events): void {
    mem.set(insightId, events);
    if (PERSIST) {           ← only in dev; production just keeps mem
      const all = readJson(CACHE_FILE);
      all[insightId] = events;
      try {
        writeFileSync(CACHE_FILE, JSON.stringify(all));
      } catch {
        /* best effort */    ← swallow; we tolerate write failures
      }
    }
  }
```

What breaks without the env guard: production would attempt a sync write into a read-only filesystem and the `catch` would swallow the EROFS — so technically nothing user-visible breaks, but you'd be wasting cycles every save. The guard is a "don't even try" optimization.

#### 5) The HTTP body on the client side — `getReader()` + `read()` loop

On the client, `useInvestigation` does the symmetrical thing:

```
  client reader loop — pull until the server says done

  const res = await fetch(url);
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;       ← server called controller.close()
    decoder.decode(value, { stream: true })
       .split('\n')
       .forEach(parseAndDispatch)
  }
```

The reader is GC'd when it goes out of scope. The fetch's underlying socket is released when the body completes or errors. The deliberate non-`abort` decision lives one layer up — the hook does NOT abort the fetch on effect cleanup, because React StrictMode would otherwise kill the stream before the first byte (see `01` and the comment at `lib/hooks/useInvestigation.ts:32-36`).

#### 6) Timers as resources — `setTimeout` and the absence of `clearTimeout`

The two `setTimeout` patterns in the repo (the spacing-gate sleep and the replay-pace pause) are both awaited inline. They're not "set, store the handle, clear it later" timers; they're one-shot pauses inside an `await new Promise(...)`. There's nothing to clear, because the function is currently sitting on the await — the timer fires, the promise resolves, the function continues. No leak path.

```
  one-shot await-setTimeout — no handle leak

  await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
                            ▲
                            └─ timer fires → r() resolves → await completes
                               nothing to clear, nothing held

  contrast with the leak-prone pattern (NOT in the repo):
    const handle = setInterval(...)
    // ... if you don't clearInterval, it runs forever
```

#### 7) The MCP transport — sockets we don't see

`StreamableHTTPClientTransport` (in `@modelcontextprotocol/sdk`) wraps `fetch`. Each `transport.callTool(...)` does one HTTP POST and reads one HTTP response. There's no persistent connection we manage — every call is fire-and-forget at the transport layer. The auth provider keeps its own state (tokens, code verifier), but that's data, not a resource handle.

```
  MCP transport — per-call HTTP, no persistent socket from our side

  every callTool:
    fetch(mcpUrl, { method: POST, body, headers: { Authorization } })
       ← Node's fetch reuses HTTP keep-alive sockets per host transparently,
         but WE never see a socket object. no close() to call. no leak path.
```

### Move 3 — the principle

**The discipline isn't "always close everything" — it's "know which resources need a `finally`, and make sure they have one."** In modern JS most resources are GC'd implicitly. The exceptions are stream controllers (you have to call `close()`) and persistent handles like DB pools (you have to call `release()`). The repo is small enough that the only exception that matters is the stream controller, and both long routes handle it correctly.

---

## Primary diagram

The full resource-lifecycle picture for one investigation request:

```
  One investigation request — every resource opened, every cleanup

  ┌─ Browser ───────────────────────────────────────────────────────────┐
  │  useInvestigation effect:                                            │
  │     fetch(url)                            ← opens response           │
  │       └─ res.body.getReader()             ← opens reader              │
  │            └─ while(true) await read()    ← drains until done=true   │
  │                                                                      │
  │  cleanup: NONE (deliberate; see 01 and useInvestigation:32-36)       │
  │  reader/socket released when the body completes (server close())     │
  └─────────────────────────────────│───────────────────────────────────┘
                                    │  HTTPS chunked
  ┌─ Server (Vercel function) ──────▼───────────────────────────────────┐
  │                                                                     │
  │   GET(req):                                                          │
  │     return new Response(                                             │
  │       new ReadableStream({                                           │
  │         async start(controller) {              ← acquire             │
  │           try {                                                      │
  │             …controller.enqueue(...)…           ← drives the stream  │
  │             await runAgentLoop({ ... })                              │
  │             send({ type: 'done' })                                   │
  │             if (step == null) saveInvestigation(insightId, collected)│
  │           } catch (e) {                                              │
  │             send({ type:'error', message: … })  ← user-visible error │
  │           } finally {                                                │
  │             controller.close();                 ← release (always!)  │
  │           }                                                          │
  │         },                                                           │
  │       }),                                                            │
  │       { headers: NDJSON_HEADERS }                                    │
  │     );                                                               │
  │                                                                      │
  │   inside runAgentLoop:                                               │
  │     await anthropic.messages.create(...)  ← fetch; auto-release       │
  │     await mcp.callTool(...)               ← fetch; auto-release       │
  │       └─ inside liveCall:                                            │
  │            await new Promise(r => setTimeout(r, gap))  ← one-shot    │
  │            await transport.callTool(...)               ← fetch        │
  └─────────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.**

- **Every long route** — `/api/briefing` and `/api/agent` both open one `ReadableStream` per invocation, drive it with the agent loop, close it in `finally`.
- **Demo replay** — the cached-path `start` callback awaits `setTimeout` between events to pace the stream, then `controller.close()` at the end.
- **Dev caching** — `saveInvestigation` writes the in-memory `Map` AND the JSON file (dev only). The file write is best-effort; a failed write doesn't break the in-memory store.

**Code side by side.**

```
  app/api/agent/route.ts (lines 169-264) — the long route's lifecycle

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {            ← acquire: controller is the resource
      const collected: AgentEvent[] = [];
      const send = (e: AgentEvent) => {
        collected.push(e);
        controller.enqueue(encoder.encode(encodeEvent(e)));   ← use: write bytes
      };
      // ... helpers ...
      try {
        // ── full agent work, many awaits, can throw at any one of them ──
        stepFor(leadAgent, 'thought', 'reading the workspace schema…');
        const schema = await bootstrapSchema(conn.mcp);
        // ... call agents, send events ...
        send({ type: 'done' });
        if (step == null) saveInvestigation(insightId!, collected);
      } catch (e) {
        console.error('[agent] error:', e);
        send({ type: 'error', message: `/api/agent · ${...}` });   ← sad path
      } finally {
        controller.close();          ← release: ALWAYS runs, ALWAYS closes
      }
    },
  });
  return new Response(stream, { headers: NDJSON_HEADERS });
       │
       └─ THE lifecycle pattern. The finally is what guarantees the response
          body terminates — whether the agent ran to completion, threw mid-loop,
          or hit some surprise like a connection refused on the MCP server.
```

```
  app/api/briefing/route.ts (lines 178-256) — symmetrical pattern

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: BriefingEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
      // ...
      try {
        // ── monitoring scan, many awaits ──
        send({ type: 'done' });
      } catch (e) {
        console.error('[briefing] error:', e);
        send({ type: 'error', message: `/api/briefing · ${...}` });
      } finally {
        controller.close();   ← same discipline, same guarantee
      }
    },
  });
```

```
  lib/state/investigations.ts (lines 30-41) — dev-only file write, best-effort

  export function saveInvestigation(insightId: string, events: AgentEvent[]): void {
    mem.set(insightId, events);          ← always: in-memory write (the truth)
    if (PERSIST) {                        ← dev only
      const all = readJson(CACHE_FILE);
      all[insightId] = events;
      try {
        writeFileSync(CACHE_FILE, JSON.stringify(all));
      } catch {
        /* best effort */                  ← swallow; the in-memory write already happened
      }
    }
  }
       │
       └─ The pattern: persistence is opportunistic. If the disk write fails
          (EROFS in a misconfigured prod env, ENOSPC in dev), the function
          still succeeds because the in-memory write is the source of truth.
```

---

## Elaborate

The `ReadableStream` API is the Web Streams spec, implemented by Node 20 natively (also by browsers). The `start(controller)` callback is one of three "underlying source" methods you can implement; the repo only uses `start`. Two others exist (`pull(controller)` for pull-based sources, `cancel(reason)` to handle client-cancellation) — neither is used because the repo doesn't need pull semantics and doesn't react to client cancel (see the missing-AbortController discussion in `07`).

Worth knowing for future expansion: if the repo ever wanted to react to a client closing the stream early (browser tab closes), the `cancel` callback is where that logic would go. Today, the route handler is oblivious to client disconnect — it keeps running until `maxDuration` or natural completion.

Worth reading next: the WHATWG Streams Standard, especially the controller methods, and the Node 20 fs/promises docs (for the async pattern that would replace `readFileSync` if any of these reads ever moved to a per-request hot path).

---

## Interview defense

**Q: Walk me through what `controller.close()` actually does, and what happens if you forget it.**
A: `controller.close()` signals to the underlying `ReadableStream` that no more bytes are coming. The platform then finishes the HTTP response body (sends the terminating chunked-transfer chunk) and the client's `reader.read()` resolves to `{ done: true }`. Forgetting it means the body never terminates — the response stays "in progress" from the client's perspective, and the client hangs until its own fetch timeout fires (could be minutes). In a serverless context, the function would also hold its slot until `maxDuration` (300s here). The fix is universal: put the close in a `finally` block so it runs whether the happy path succeeded, a caught error sent a sad-path message, or even an uncaught throw escaped the try.

```
  controller lifecycle

  ┌─ open ────┐     ┌─ work ────────┐     ┌─ close ────┐
  │  start(   │ ──► │  enqueue(...) │ ──► │  close()    │ ──► response
  │   ctrl)   │     │  enqueue(...) │     │  in finally │     body terminates
  └───────────┘     └───────────────┘     └─────────────┘     client unblocks
```

**Q: Why are the file reads in the routes synchronous? Isn't that a runtime anti-pattern?**
A: It's a textbook anti-pattern in the general case — sync I/O blocks the event loop. Here it's acceptable because (a) the files are tiny (<100KB) so the block is sub-millisecond, (b) the reads happen on rarely-trafficked paths (demo replay, dev-only persistence, prompt loading at module init), and (c) the alternative (`await readFile`) would queue another microtask we don't need. The lever to pull: if the demo snapshot ever grew to MB-scale or moved into the live hot path, swap to `fs/promises.readFile`. Today, the cost-of-change exceeds the cost-of-leave.

---

## Validate

1. **Reconstruct.** Draw the route's stream lifecycle from `start(controller)` through `try`/`catch`/`finally` to `controller.close()`. Add an arrow showing what the client sees at each step.
2. **Explain.** Why doesn't `useInvestigation` call `reader.cancel()` on effect cleanup? What would that break? (React StrictMode double-mounts in dev — the started-ref guard blocks the second mount's fetch, but a cleanup-time cancel on the first mount's stream would abort it before any bytes arrived. See `lib/hooks/useInvestigation.ts:32-36`.)
3. **Apply.** A new route streams a multi-megabyte CSV from a tool result. Should it use the same `ReadableStream` pattern? What changes? (Yes for the controller pattern. What changes: be careful about `controller.desiredSize` / backpressure if the producer outpaces the client — not exercised today, but the lever exists.)
4. **Defend.** Defend the absence of a `cancel(reason)` callback on the route's `ReadableStream`. Why doesn't the route react to a client closing the tab? (Documented at `useInvestigation.ts` — we deliberately let the stream complete; the server keeps running. The cost is named in `07`: a client disconnect doesn't stop billing on Anthropic/MCP. The right fix when this matters is to add `cancel` + propagate to an `AbortController` threaded through the agent loop.)

---

## See also

- `03-event-loop-and-async-io.md` — what the `await controller.enqueue` yields back to the loop.
- `05-memory-stack-heap-gc-and-lifetimes.md` — what the stream's internal buffer holds and when it's freed.
- `07-backpressure-bounded-work-and-cancellation.md` — the missing `AbortController` story, the streaming-backpressure lever that isn't pulled.
